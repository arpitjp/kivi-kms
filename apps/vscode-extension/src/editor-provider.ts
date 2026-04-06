import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import * as https from 'https';
import * as http from 'http';
import { scanMarkdown } from '@kivi/vault';
import { computeMinimalDiff } from '@kivi/shared-types';
import { getNonce, resolveDocRelativeFolder, computeRelativePathFromDoc } from './utils.js';
import { DevPanel } from './dev-panel.js';

// ── Open Graph metadata fetcher ──

interface OgMetadata {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  type?: string;
  favicon?: string;
}

const ogCache = new Map<string, { data: OgMetadata; ts: number }>();
const OG_CACHE_MAX = 128;
const OG_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const ogInFlight = new Map<string, Promise<OgMetadata>>();

function pruneOgCache() {
  if (ogCache.size <= OG_CACHE_MAX) return;
  const entries = [...ogCache.entries()];
  entries.sort((a, b) => a[1].ts - b[1].ts);
  const toRemove = entries.slice(0, entries.length - OG_CACHE_MAX);
  for (const [key] of toRemove) ogCache.delete(key);
}

function fetchOgMetadata(url: string): Promise<OgMetadata> {
  const cached = ogCache.get(url);
  if (cached && Date.now() - cached.ts < OG_CACHE_TTL) return Promise.resolve(cached.data);

  const existing = ogInFlight.get(url);
  if (existing) return existing;

  const promise = doFetchOg(url).then(data => {
    ogCache.set(url, { data, ts: Date.now() });
    pruneOgCache();
    ogInFlight.delete(url);
    return data;
  }).catch(() => {
    ogInFlight.delete(url);
    return {} as OgMetadata;
  });

  ogInFlight.set(url, promise);
  return promise;
}

function doFetchOg(url: string, redirects = 0): Promise<OgMetadata> {
  if (redirects > 3) return Promise.resolve({});
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      timeout: 4000,
      headers: {
        'User-Agent': 'Kivi-Link-Preview/1.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en',
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next = res.headers.location;
        if (next.startsWith('/')) {
          try { next = new URL(next, url).href; } catch { resolve({}); return; }
        }
        res.resume();
        doFetchOg(next, redirects + 1).then(resolve).catch(() => resolve({}));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) { res.resume(); resolve({}); return; }

      let body = '';
      const maxBytes = 64 * 1024; // only read first 64KB for perf
      let bytesRead = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        bytesRead += Buffer.byteLength(chunk);
        body += chunk;
        if (bytesRead > maxBytes) res.destroy();
      });
      res.on('end', () => resolve(parseOgFromHtml(body, url)));
      res.on('error', () => resolve({}));
    });
    req.on('timeout', () => { req.destroy(); resolve({}); });
    req.on('error', () => resolve({}));
  });
}

function parseOgFromHtml(html: string, pageUrl: string): OgMetadata {
  const meta = (property: string): string | undefined => {
    // Match <meta property="og:..." content="..."> or <meta name="..." content="...">
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i');
    const m = re.exec(html);
    if (m) return m[1];
    // Also try reversed attribute order: content before property
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`, 'i');
    const m2 = re2.exec(html);
    return m2?.[1] || undefined;
  };

  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const ogTitle = meta('og:title') || meta('twitter:title');
  const ogDesc = meta('og:description') || meta('twitter:description') || meta('description');
  let ogImage = meta('og:image') || meta('twitter:image');
  const ogSite = meta('og:site_name');
  const ogType = meta('og:type');

  // Resolve relative og:image URLs
  if (ogImage && !ogImage.startsWith('http')) {
    try { ogImage = new URL(ogImage, pageUrl).href; } catch { /* leave as-is */ }
  }

  // Favicon: look for <link rel="icon" href="...">
  let favicon: string | undefined;
  const faviconMatch = /<link[^>]+rel=["'](?:icon|shortcut icon)["'][^>]+href=["']([^"']*)["']/i.exec(html);
  if (faviconMatch) {
    favicon = faviconMatch[1];
    if (favicon && !favicon.startsWith('http')) {
      try { favicon = new URL(favicon, pageUrl).href; } catch { /* skip */ }
    }
  }
  if (!favicon) {
    try { favicon = new URL('/favicon.ico', pageUrl).href; } catch { /* skip */ }
  }

  return {
    title: ogTitle || titleTag?.[1]?.trim() || undefined,
    description: ogDesc?.slice(0, 300) || undefined,
    image: ogImage || undefined,
    siteName: ogSite || undefined,
    type: ogType || undefined,
    favicon,
  };
}

export interface KiviSettings {
  editorBackground: string;
  codeBlockBackground: string;
  accentColor: string;
  textColor: string;
  headingColor: string;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  customCSS: string;
  showToolbar: boolean;
  editorZoom: number;
  wordWrap: boolean;
  stickyScrollEnabled: boolean;
  stickyScrollMaxDepth: number;
  // VS Code native editor settings (forwarded so webview can match)
  vscodeEditorFontSize: number;
  vscodeEditorFontFamily: string;
  vscodeEditorLineHeight: number;
  vscodeEditorWordWrap: string;
  vscodeZoomLevel: number;
}

function resolveWordWrap(kiviWrap: string, vscodeWrap: string): boolean {
  if (kiviWrap === 'on') return true;
  if (kiviWrap === 'off') return false;
  return vscodeWrap !== 'off';
}

function readKiviSettings(): KiviSettings {
  const cfg = vscode.workspace.getConfiguration('kivi');
  const editorCfg = vscode.workspace.getConfiguration('editor');
  const windowCfg = vscode.workspace.getConfiguration('window');
  return {
    editorBackground: cfg.get<string>('appearance.editorBackground', ''),
    codeBlockBackground: cfg.get<string>('appearance.codeBlockBackground', ''),
    accentColor: cfg.get<string>('appearance.accentColor', ''),
    textColor: cfg.get<string>('appearance.textColor', ''),
    headingColor: cfg.get<string>('appearance.headingColor', ''),
    fontSize: cfg.get<number>('appearance.fontSize', 0),
    fontFamily: cfg.get<string>('appearance.fontFamily', ''),
    lineHeight: cfg.get<number>('appearance.lineHeight', 0),
    customCSS: cfg.get<string>('appearance.customCSS', ''),
    showToolbar: cfg.get<boolean>('ui.showToolbar', true),
    editorZoom: cfg.get<number>('appearance.editorZoom', 100),
    wordWrap: resolveWordWrap(cfg.get<string>('appearance.wordWrap', 'inherit'), editorCfg.get<string>('wordWrap', 'on')),
    stickyScrollEnabled: cfg.get<boolean>('stickyScroll.enabled', true),
    stickyScrollMaxDepth: cfg.get<number>('stickyScroll.maxDepth', 5),
    vscodeEditorFontSize: editorCfg.get<number>('fontSize', 14),
    vscodeEditorFontFamily: editorCfg.get<string>('fontFamily', ''),
    vscodeEditorLineHeight: editorCfg.get<number>('lineHeight', 0),
    vscodeEditorWordWrap: editorCfg.get<string>('wordWrap', 'on'),
    vscodeZoomLevel: windowCfg.get<number>('zoomLevel', 0),
  };
}

/**
 * Search the workspace for a file matching any of the given basenames.
 * Returns the relative path from the document's directory, or null.
 */
async function findInWorkspace(
  wsFolder: vscode.WorkspaceFolder,
  docUri: vscode.Uri,
  names: (string | undefined)[],
): Promise<string | null> {
  for (const name of names) {
    if (!name) continue;
    const hits = await vscode.workspace.findFiles(
      new vscode.RelativePattern(wsFolder, `**/${name}`), '**/node_modules/**', 1,
    );
    if (hits.length > 0) {
      return computeRelativePathFromDoc(docUri, hits[0]);
    }
  }
  return null;
}

export class KiviEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'kivi.markdownEditor';

  /** Tracks all active webview panels keyed by document URI, for commands/focus. */
  private static activePanels = new Map<string, vscode.WebviewPanel>();

  /** Pending heading scrolls: URI string → heading slug. Set by navigateToLink
   *  when the target has a #fragment; consumed when the target panel sends 'ready'. */
  private static pendingHeadingScroll = new Map<string, string>();


  /** Workspace-wide tag set, populated by indexWorkspace in extension.ts */
  static workspaceTags = new Set<string>();


  /** In-memory note index: lowercase basename (no ext) → URI.
   *  Populated by indexWorkspace, kept current by the file watcher.
   *  Enables instant, case-insensitive Obsidian-style wiki-link resolution. */
  static noteIndex = new Map<string, vscode.Uri>();

  static updateNoteIndex(uri: vscode.Uri) {
    const base = uri.path.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() ?? '';
    if (base) KiviEditorProvider.noteIndex.set(base, uri);
  }

  static removeFromNoteIndex(uri: vscode.Uri) {
    const base = uri.path.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() ?? '';
    const existing = KiviEditorProvider.noteIndex.get(base);
    if (existing && existing.toString() === uri.toString()) {
      KiviEditorProvider.noteIndex.delete(base);
    }
  }

  /** Fires when the webview reports the user scrolled to a new heading */
  static readonly _onActiveHeading = new vscode.EventEmitter<string>();
  static readonly onActiveHeading = KiviEditorProvider._onActiveHeading.event;

  /** Send updated tag list to all active webview panels */
  static broadcastTagIndex() {
    const tags = Array.from(KiviEditorProvider.workspaceTags).sort();
    for (const panel of KiviEditorProvider.activePanels.values()) {
      if (panel.visible) {
        panel.webview.postMessage({ type: 'tagIndex', tags });
      }
    }
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      KiviEditorProvider.viewType,
      new KiviEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      },
    );
  }

  /** Get the panel for a document URI (if any). Used by commands. */
  static getPanelForUri(uri: string): vscode.WebviewPanel | undefined {
    return KiviEditorProvider.activePanels.get(uri);
  }

  /** Get the currently active Kivi editor panel (if any). */
  static getActivePanel(): vscode.WebviewPanel | undefined {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = activeTab?.input as { uri?: vscode.Uri; viewType?: string } | undefined;
    if (input?.viewType === KiviEditorProvider.viewType && input.uri) {
      return KiviEditorProvider.activePanels.get(input.uri.toString());
    }
    return undefined;
  }

  /** Get the document URI associated with a panel. */
  static getDocumentUriForPanel(panel: vscode.WebviewPanel): vscode.Uri | undefined {
    for (const [uriStr, p] of KiviEditorProvider.activePanels) {
      if (p === panel) return vscode.Uri.parse(uriStr);
    }
    return undefined;
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const docUriStr = document.uri.toString();
    const docName = document.uri.fsPath.split('/').pop() ?? docUriStr;
    DevPanel.log('info', 'editor', `Opening: ${docName}`);
    DevPanel.perf(`editor-open:${docName}`, 'start');

    // Track this panel
    KiviEditorProvider.activePanels.set(docUriStr, webviewPanel);

    // Webview options — include workspace folder and document directory for image/asset previews
    const roots: vscode.Uri[] = [
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      vscode.Uri.joinPath(this.context.extensionUri, 'images'),
      vscode.Uri.joinPath(document.uri, '..'),
    ];
    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri)
      ?? vscode.workspace.workspaceFolders?.[0];
    // Include all workspace folders so cross-workspace asset refs resolve
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      roots.push(f.uri);
    }
    roots.push(vscode.Uri.file(os.homedir()));

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: roots,
    };

    const initialText = document.getText();
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, initialText);

    // ── State tracking ──
    // Content is embedded in the webview HTML via <script id="kivi-initial-md">,
    // so the webview can parse it immediately without waiting for a 'load' message.
    // pendingContent starts null; external changes before 'ready' will populate it.

    let isWebviewReady = false;
    let pendingContent: string | null = null;
    let lastKnownContent = initialText;
    // Counter-based own-edit tracking (handles rapid edits better than a boolean)
    let pendingOwnEdits = 0;

    const disposables: vscode.Disposable[] = [];

    // ── Message sending helpers ──

    const postMessage = (msg: Record<string, unknown>) => {
      if (isWebviewReady) {
        webviewPanel.webview.postMessage(msg);
      }
    };

    const sendContent = (content: string) => {
      if (isWebviewReady) {
        postMessage({ type: 'load', content });
      } else {
        pendingContent = content;
      }
    };

    const sendSettings = () => {
      postMessage({ type: 'settings', settings: readKiviSettings() });
    };

    // ── Document change tracking ──

    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== docUriStr) return;
        if (e.contentChanges.length === 0) return;

        const currentText = document.getText();

        // Skip own edits via counter
        if (pendingOwnEdits > 0) {
          pendingOwnEdits--;
          lastKnownContent = currentText;
          return;
        }

        // External change
        if (currentText !== lastKnownContent) {
          DevPanel.log('debug', 'editor', `External change detected: ${docName}`);
          lastKnownContent = currentText;
          sendContent(lastKnownContent);
        }
      }),
    );

    // ── Configuration changes ──

    disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kivi') || e.affectsConfiguration('editor.fontSize') ||
            e.affectsConfiguration('editor.fontFamily') || e.affectsConfiguration('editor.wordWrap') ||
            e.affectsConfiguration('window.zoomLevel')) {
          sendSettings();
        }
      }),
    );

    // ── File save: tell webview to flush pending edits ──

    disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.toString() === docUriStr) {
          postMessage({ type: 'flushEdits' });
          this.sendGitDiff(document, postMessage);
        }
      }),
    );

    // ── File delete: notify webview ──

    disposables.push(
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          if (uri.toString() === docUriStr) {
            postMessage({ type: 'fileDeleted' });
          }
        }
      }),
    );

    // ── File rename: notify webview of new name ──

    disposables.push(
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          if (oldUri.toString() === docUriStr) {
            const newRelPath = vscode.workspace.asRelativePath(newUri, false);
            postMessage({ type: 'fileRenamed', newPath: newRelPath });
          }
        }
      }),
    );

    // ── Panel visibility / focus ──

    disposables.push(
      webviewPanel.onDidChangeViewState(() => {
        if (webviewPanel.active) {
          vscode.commands.executeCommand('setContext', 'kivi.editorFocused', true);
          postMessage({ type: 'focus' });
        } else {
          vscode.commands.executeCommand('setContext', 'kivi.editorFocused', false);
        }
      }),
    );

    // ── Cleanup ──

    webviewPanel.onDidDispose(() => {
      DevPanel.log('info', 'editor', `Closed: ${docName} (${KiviEditorProvider.activePanels.size - 1} remaining)`);
      KiviEditorProvider.activePanels.delete(docUriStr);
      vscode.commands.executeCommand('setContext', 'kivi.editorFocused', false);
      for (const d of disposables) d.dispose();
    });

    // ── Message handler ──

    disposables.push(webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          isWebviewReady = true;
          DevPanel.perf(`editor-open:${docName}`, 'end');
          DevPanel.log('debug', 'editor', `Webview ready: ${docName}`);

          // Send document metadata
          const relPath = vscode.workspace.asRelativePath(document.uri, false);
          const docDirUri = vscode.Uri.joinPath(document.uri, '..');
          const docBaseUrl = webviewPanel.webview.asWebviewUri(docDirUri).toString();
          let wsBaseUrl = '';
          if (wsFolder) {
            const wbu = webviewPanel.webview.asWebviewUri(wsFolder.uri).toString();
            wsBaseUrl = wbu.endsWith('/') ? wbu : wbu + '/';
          }
          const homeUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(os.homedir())).toString();
          postMessage({
            type: 'init',
            filePath: relPath,
            fileName: relPath.split('/').pop()?.replace(/\.md$/, '') || '',
            isReadonly: document.isUntitled,
            docBaseUrl: docBaseUrl.endsWith('/') ? docBaseUrl : docBaseUrl + '/',
            workspaceBaseUrl: wsBaseUrl,
            homeBaseUrl: homeUri.endsWith('/') ? homeUri : homeUri + '/',
          });

          sendSettings();

          // Send persisted global preferences (view mode, toolbar visibility, etc.)
          const globalPrefs = this.context.globalState.get<Record<string, unknown>>('kiviPrefs', {});
          postMessage({ type: 'globalPrefs', prefs: globalPrefs });

          if (pendingContent !== null) {
            postMessage({ type: 'load', content: pendingContent });
            lastKnownContent = pendingContent;
            pendingContent = null;
          }

          // Defer non-critical post-ready work to avoid blocking the first paint
          setTimeout(() => {
            this.sendGitBase(document, postMessage);
            this.sendGitDiff(document, postMessage);
            if (KiviEditorProvider.workspaceTags.size > 0) {
              postMessage({ type: 'tagIndex', tags: Array.from(KiviEditorProvider.workspaceTags).sort() });
            }
            // Cross-file heading navigation: scroll to #fragment if pending
            const docKey = document.uri.toString();
            const pendingHeading = KiviEditorProvider.pendingHeadingScroll.get(docKey);
            if (pendingHeading) {
              KiviEditorProvider.pendingHeadingScroll.delete(docKey);
              const headingSlug = pendingHeading.toLowerCase();
              const docContent = document.getText();
              const lines = docContent.split('\n');
              for (let i = 0; i < lines.length; i++) {
                const hm = /^#{1,6}\s+(.+)/.exec(lines[i]);
                if (hm) {
                  const rawText = hm[1].trim();
                  const slug = rawText.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
                  const plainSlug = rawText.replace(/`([^`]*)`/g, '$1').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
                  if (slug === headingSlug || plainSlug === headingSlug || rawText.toLowerCase() === headingSlug) {
                    postMessage({ type: 'scrollToHeading', heading: rawText, line: i });
                    break;
                  }
                }
              }
            }

          }, 100);
          break;
        }

        case 'updateKiviSetting': {
          const settingKey = msg.key as string | undefined;
          const settingValue = msg.value;
          if (settingKey) {
            await vscode.workspace.getConfiguration('kivi').update(
              settingKey, settingValue, vscode.ConfigurationTarget.Global,
            );
          }
          break;
        }

        case 'persistSetting': {
          const key = msg.key as string | undefined;
          const value = msg.value;
          if (!key) break;

          const prefs = this.context.globalState.get<Record<string, unknown>>('kiviPrefs', {});
          prefs[key] = value;
          await this.context.globalState.update('kiviPrefs', prefs);

          // Broadcast to all other active panels
          for (const [uri, panel] of KiviEditorProvider.activePanels) {
            if (uri !== docUriStr && panel.visible) {
              panel.webview.postMessage({ type: 'globalPrefChanged', key, value });
            }
          }
          break;
        }

        case 'openGraph': {
          vscode.commands.executeCommand('kivi.openGraph');
          break;
        }

        case 'requestBlame': {
          const lineStart = msg.lineStart as number | undefined;
          const lineEnd = msg.lineEnd as number | undefined;
          if (lineStart != null && lineEnd != null) {
            this.getBlameInfo(document, lineStart, lineEnd, postMessage);
          }
          break;
        }

        case 'stageChange': {
          try {
            const gitExt = vscode.extensions.getExtension('vscode.git');
            if (!gitExt) break;
            const git = gitExt.isActive ? gitExt.exports : await gitExt.activate();
            const api = git.getAPI(1);
            const repo = api.repositories.find((r: any) =>
              document.uri.fsPath.startsWith(r.rootUri.fsPath),
            );
            if (repo) {
              await repo.add([document.uri.fsPath]);
            }
          } catch {
            vscode.window.showWarningMessage('Failed to stage change. Make sure the file is saved.');
          }
          break;
        }

        case 'requestFullBlame': {
          this.getFullBlameInfo(document, postMessage);
          break;
        }

        case 'openExternal': {
          const url = msg.url as string | undefined;
          if (url) vscode.env.openExternal(vscode.Uri.parse(url));
          break;
        }

        case 'openCommit': {
          const hash = msg.hash as string | undefined;
          if (hash) {
            const dir = path.dirname(document.uri.fsPath);
            cp.exec(`git remote get-url origin`, { cwd: dir, timeout: 3000 }, (err, stdout) => {
              if (!err && stdout.trim()) {
                const remote = stdout.trim()
                  .replace(/\.git$/, '')
                  .replace(/^git@([^:]+):/, 'https://$1/');
                const isGerrit = /gerrit|review/i.test(remote);
                const commitUrl = isGerrit
                  ? `${remote}/+/${hash}`
                  : `${remote}/commit/${hash}`;
                vscode.env.openExternal(vscode.Uri.parse(commitUrl));
              } else {
                vscode.commands.executeCommand(
                  'git.viewCommit', hash,
                );
              }
            });
          }
          break;
        }

        case 'readExcalidrawFile': {
          const excSrc = msg.src as string | undefined;
          const reqId = msg.reqId as string | undefined;
          if (excSrc && reqId) {
            try {
              const fileUri = this.resolveUnifiedPath(excSrc, document);
              if (!fileUri) throw new Error(`Cannot resolve path: ${excSrc}`);
              const data = await vscode.workspace.fs.readFile(fileUri);
              const content = new TextDecoder().decode(data);
              postMessage({ type: 'excalidrawFileContent', reqId, content });
            } catch (e) {
              postMessage({ type: 'excalidrawFileContent', reqId, error: String(e) });
            }
          }
          break;
        }

        case 'createExcalidrawFile': {
          const excName = msg.name as string | undefined;
          const excReqId = msg.reqId as string | undefined;
          if (excName && excReqId) {
            try {
              const cfg = vscode.workspace.getConfiguration('kivi');
              const assetsFolder = cfg.get<string>('folders.assets', 'assets');
              const fileName = excName.endsWith('.excalidraw') ? excName : `${excName}.excalidraw`;
              const assetsDir = resolveDocRelativeFolder(document.uri, assetsFolder);
              try { await vscode.workspace.fs.createDirectory(assetsDir); } catch { /* exists */ }
              const fileUri = vscode.Uri.joinPath(assetsDir, fileName);
              const emptyScene = JSON.stringify({
                type: 'excalidraw', version: 2, source: 'kivi',
                elements: [],
                appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
                files: {},
              }, null, 2);
              await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(emptyScene));
              const relPath = computeRelativePathFromDoc(document.uri, fileUri);
              postMessage({ type: 'excalidrawFileCreated', reqId: excReqId, relPath });
            } catch (e) {
              console.error('[kivi] createExcalidrawFile failed:', e);
              postMessage({ type: 'excalidrawFileCreated', reqId: excReqId, relPath: null });
            }
          }
          break;
        }

        case 'openExcalidraw': {
          const excSrc = msg.src as string | undefined;
          if (excSrc) {
            const fileUri = this.resolveUnifiedPath(excSrc, document);
            if (fileUri) {
              try {
                await vscode.commands.executeCommand(
                  'vscode.openWith', fileUri, 'editor.excalidraw',
                );
              } catch {
                await vscode.commands.executeCommand('vscode.open', fileUri);
              }
            }
          }
          break;
        }

        case 'openAsset': {
          const assetSrc = msg.src as string | undefined;
          if (!assetSrc) break;
          if (assetSrc.startsWith('http://') || assetSrc.startsWith('https://')) {
            vscode.env.openExternal(vscode.Uri.parse(assetSrc));
            break;
          }
          const assetFileUri = this.resolveUnifiedPath(assetSrc, document);
          if (assetFileUri) {
            if (/\.excalidraw$/i.test(assetSrc)) {
              try {
                await vscode.commands.executeCommand('vscode.openWith', assetFileUri, 'editor.excalidraw');
              } catch {
                await vscode.commands.executeCommand('vscode.open', assetFileUri);
              }
            } else {
              await vscode.commands.executeCommand('vscode.open', assetFileUri);
            }
          }
          break;
        }

        case 'checkExcalidrawExtension': {
          const ext = vscode.extensions.getExtension('pomdtr.excalidraw-editor')
            || vscode.extensions.getExtension('nicolo-ribaudo.excalidraw-editor');
          postMessage({ type: 'excalidrawExtensionStatus', installed: !!ext });
          break;
        }


        case 'command': {
          const cmd = msg.command as string | undefined;
          const args = msg.args as unknown[] | undefined;
          if (cmd) vscode.commands.executeCommand(cmd, ...(args || []));
          break;
        }

        case 'edit': {
          if (typeof msg.content !== 'string') break;
          const newContent = msg.content as string;
          if (newContent === lastKnownContent) break;

          const edit = new vscode.WorkspaceEdit();
          const { start, oldEnd, replacement } = computeMinimalDiff(lastKnownContent, newContent);

          const range = new vscode.Range(
            document.positionAt(start),
            document.positionAt(oldEnd),
          );

          edit.replace(document.uri, range, replacement);
          pendingOwnEdits++;
          lastKnownContent = newContent;
          const applied = await vscode.workspace.applyEdit(edit);
          if (!applied) {
            pendingOwnEdits--;
            DevPanel.log('warn', 'editor', `Edit rejected by VS Code: ${docName}`);
          }
          break;
        }

        case 'resolveLink': {
          const linkData = msg.link as { kind: string; target: string; alias?: string } | undefined;
          const resolveId = msg.id as number | undefined;
          if (!linkData || resolveId === undefined) break;

          DevPanel.perf(`resolveLink:${linkData.target}`, 'start');
          const result = await this.resolveLink(linkData, document, webviewPanel.webview);
          DevPanel.perf(`resolveLink:${linkData.target}`, 'end');
          postMessage({ type: 'linkResolved', id: resolveId, data: result });
          break;
        }

        case 'navigateLink': {
          const navLink = msg.link as { kind: string; target: string; alias?: string } | undefined;
          if (!navLink) break;
          DevPanel.log('debug', 'editor', `Navigate: [${navLink.kind}] ${navLink.target}`);
          await this.navigateToLink(navLink, document);
          break;
        }

        case 'navigateLinkBeside': {
          const navLink2 = msg.link as { kind: string; target: string; alias?: string } | undefined;
          if (!navLink2) break;
          DevPanel.log('debug', 'editor', `Navigate (beside): [${navLink2.kind}] ${navLink2.target}`);
          await this.navigateToLink(navLink2, document, true);
          break;
        }

        case 'promptInput': {
          const promptId = msg.id as number | undefined;
          const promptMsg = msg.message as string | undefined;
          const promptPlaceholder = msg.placeholder as string | undefined;
          if (promptId === undefined) break;
          const value = await vscode.window.showInputBox({
            prompt: promptMsg || 'Enter a value',
            placeHolder: promptPlaceholder,
          });
          postMessage({ type: 'inputPromptResult', id: promptId, value: value ?? null });
          break;
        }

        case 'revealInExplorer': {
          vscode.commands.executeCommand('revealInExplorer', document.uri);
          break;
        }

        case 'scrollToLine': {
          const line = msg.line as number | undefined;
          if (typeof line === 'number') {
            postMessage({ type: 'scrollToLine', line });
          }
          break;
        }

        case 'activeHeading': {
          const heading = msg.heading as string | undefined;
          if (heading) {
            KiviEditorProvider._onActiveHeading.fire(heading);
          }
          break;
        }

        case 'getOutline': {
          const text = document.getText();
          const headings: { level: number; text: string; line: number }[] = [];
          const lines = text.split('\n');
          let inCodeBlock = false;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trimStart().startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
            if (inCodeBlock) continue;
            const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
            if (m) {
              headings.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
            }
          }
          postMessage({ type: 'outline', headings });
          break;
        }

        case 'getFileHeadings': {
          const targetRel = msg.relPath as string | undefined;
          const reqId = msg.reqId as string | undefined;
          if (!targetRel || !reqId) break;
          try {
            const fileUri = this.resolveUnifiedPath(targetRel, document);
            if (!fileUri) { postMessage({ type: 'fileHeadings', reqId, headings: [] }); break; }
            const data = await vscode.workspace.fs.readFile(fileUri);
            const content = new TextDecoder().decode(data);
            const fLines = content.split('\n');
            const slugify = (t: string) => t.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
            const fHeadings: { name: string; slug: string; level: number }[] = [];
            let inCB = false;
            for (const l of fLines) {
              if (l.trimStart().startsWith('```')) { inCB = !inCB; continue; }
              if (inCB) continue;
              const hm = /^(#{1,6})\s+(.+)$/.exec(l);
              if (hm) {
                const hText = hm[2].trim();
                fHeadings.push({ name: hText, slug: slugify(hText), level: hm[1].length });
              }
            }
            postMessage({ type: 'fileHeadings', reqId, headings: fHeadings });
          } catch {
            postMessage({ type: 'fileHeadings', reqId, headings: [] });
          }
          break;
        }

        case 'listWorkspaceFiles': {
          if (!wsFolder) break;
          const IMAGE_EXTS_WS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
          const VIDEO_EXTS_WS = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
          const AUDIO_EXTS_WS = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'];
          const USEFUL_EXTS = ['.md', '.excalidraw', ...IMAGE_EXTS_WS, ...VIDEO_EXTS_WS, ...AUDIO_EXTS_WS,
            '.pdf', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.html', '.css', '.js', '.ts',
            '.py', '.go', '.rs', '.c', '.cpp', '.h', '.java', '.sh', '.bash', '.zsh'];
          const allUris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(wsFolder, `**/*{${USEFUL_EXTS.join(',')}}`),
            '{**/node_modules/**,**/.git/**}', 1000,
          );
          const docDir = path.dirname(document.uri.fsPath);
          const wsRoot = wsFolder.uri.fsPath;
          const currentRel = path.relative(wsRoot, document.uri.fsPath).replace(/\\/g, '/');
          const files = allUris.map(u => {
            const rel = path.relative(wsRoot, u.fsPath).replace(/\\/g, '/');
            const ext = path.extname(u.fsPath).toLowerCase();
            const baseName = path.basename(u.fsPath);
            const name = ext === '.md' ? path.basename(u.fsPath, '.md') : baseName;
            const relToDoc = path.relative(docDir, u.fsPath).replace(/\\/g, '/');
            let fileType = 'file';
            if (ext === '.md') fileType = 'note';
            else if (IMAGE_EXTS_WS.includes(ext)) fileType = 'image';
            else if (VIDEO_EXTS_WS.includes(ext)) fileType = 'video';
            else if (AUDIO_EXTS_WS.includes(ext)) fileType = 'audio';
            else if (ext === '.excalidraw') fileType = 'excalidraw';
            else if (ext === '.pdf') fileType = 'pdf';
            return { rel, name, relToDoc, fileType, ext };
          }).filter(f => f.rel !== currentRel);
          files.sort((a, b) => {
            if (a.fileType === 'note' && b.fileType !== 'note') return -1;
            if (a.fileType !== 'note' && b.fileType === 'note') return 1;
            return a.name.localeCompare(b.name);
          });
          postMessage({ type: 'workspaceFiles', files });
          break;
        }

        case 'promptCreateChildPage': {
          const inputName = await vscode.window.showInputBox({
            prompt: 'New page name',
            placeHolder: 'e.g. My New Page',
            validateInput: (v) => v.trim() ? null : 'Name cannot be empty',
          });
          if (!inputName) break;
          // Fall through to createChildPage logic
          msg.name = inputName;
        }
        // falls through
        case 'createChildPage': {
          const pageName = msg.name as string | undefined;
          if (!pageName) break;

          const cfg = vscode.workspace.getConfiguration('kivi');
          const pagesFolder = cfg.get<string>('folders.pages', 'pages');
          const folderUri = resolveDocRelativeFolder(document.uri, pagesFolder);

          try { await vscode.workspace.fs.stat(folderUri); } catch {
            await vscode.workspace.fs.createDirectory(folderUri);
          }

          const safeName = pageName.replace(/[<>:"/\\|?*]/g, '').trim();
          const fileName = safeName.endsWith('.md') ? safeName : `${safeName}.md`;
          const fileUri = vscode.Uri.joinPath(folderUri, fileName);

          try {
            await vscode.workspace.fs.stat(fileUri);
            vscode.window.showInformationMessage(`Page "${fileName}" already exists.`);
          } catch {
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(`# ${safeName.replace(/\.md$/, '')}\n\n`));
          }

          DevPanel.log('info', 'editor', `Child page created: ${safeName}`);
          vscode.commands.executeCommand('vscode.openWith', fileUri, KiviEditorProvider.viewType);
          const relPath = computeRelativePathFromDoc(document.uri, fileUri);
          postMessage({ type: 'childPageCreated', path: relPath, name: safeName.replace(/\.md$/, '') });
          break;
        }

        case 'pickAsset': {
          const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
          const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.ogg']);
          const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.weba']);
          const MD_EXTS = new Set(['.md', '.markdown']);

          const picks = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Insert',
            title: 'Insert file as asset',
            filters: {
              'All Supported': ['md', 'markdown', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'excalidraw', 'pdf', '*'],
              'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'],
              'Video': ['mp4', 'webm', 'mov', 'avi', 'mkv'],
              'Audio': ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'],
            },
          });
          if (!picks?.length) break;

          const cfg = vscode.workspace.getConfiguration('kivi');
          const assetsFolder = cfg.get<string>('folders.assets', 'assets');
          const pagesFolder = cfg.get<string>('folders.pages', 'pages');
          const parts: string[] = [];

          for (const uri of picks) {
            const ext = path.extname(uri.fsPath).toLowerCase();
            let fileType = 'file';
            if (IMAGE_EXTS.has(ext)) fileType = 'image';
            else if (VIDEO_EXTS.has(ext)) fileType = 'video';
            else if (AUDIO_EXTS.has(ext)) fileType = 'audio';
            else if (/\.excalidraw$/i.test(uri.fsPath)) fileType = 'excalidraw';
            else if (MD_EXTS.has(ext)) fileType = 'markdown';

            let targetUri = uri;
            const inWorkspace = !!vscode.workspace.getWorkspaceFolder(uri);

            if (!inWorkspace) {
              const destDirName = (fileType === 'markdown' || fileType === 'file' && MD_EXTS.has(ext))
                ? pagesFolder : assetsFolder;
              const folderUri = resolveDocRelativeFolder(document.uri, destDirName);
              try { await vscode.workspace.fs.createDirectory(folderUri); } catch { /* exists */ }
              targetUri = vscode.Uri.joinPath(folderUri, path.basename(uri.fsPath));
              try {
                await vscode.workspace.fs.copy(uri, targetUri, { overwrite: false });
                DevPanel.log('info', 'asset', `Copied external file: ${path.basename(uri.fsPath)}`);
              } catch {
                DevPanel.log('warn', 'asset', `File already exists: ${path.basename(uri.fsPath)}`);
              }
            }

            const relPath = computeRelativePathFromDoc(document.uri, targetUri);
            const name = path.basename(relPath).replace(/\.[^.]+$/, '');

            switch (fileType) {
              case 'image':
                parts.push(`![${name}](${relPath})`);
                break;
              case 'excalidraw':
                parts.push(`![${name}](${relPath})`);
                break;
              case 'video':
                parts.push(`<video src="${relPath}" controls style="max-width:100%"></video>`);
                break;
              case 'audio':
                parts.push(`<audio src="${relPath}" controls></audio>`);
                break;
              case 'markdown':
                parts.push(`[${name}](${relPath})`);
                break;
              default:
                parts.push(`[${name}](${relPath})`);
                break;
            }
          }

          if (parts.length > 0) {
            postMessage({ type: 'assetInserted', content: parts.join('\n\n') });
          }
          break;
        }

        case 'storeImage': {
          const imageData = msg.data as string | undefined;
          const imageName = msg.name as string | undefined;
          const imageOriginalName = msg.originalName as string | undefined;
          if (!imageData || !imageName) break;

          const safeName = imageName.replace(/[<>:"/\\|?*]/g, '').trim();
          const safeOriginal = imageOriginalName?.replace(/[<>:"/\\|?*]/g, '').trim();

          // Try the original filename first (before timestamp was added) so
          // workspace assets copied via Cmd+C/Cmd+V are reused without duplication.
          const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
          const existingImage = wsFolder ? await findInWorkspace(wsFolder, document.uri, [safeOriginal, safeName]) : null;
          if (existingImage) {
            DevPanel.log('info', 'editor', `Image exists in workspace, using: ${existingImage}`);
            postMessage({ type: 'imageStored', path: existingImage, name: safeName });
            break;
          }

          const cfg = vscode.workspace.getConfiguration('kivi');
          const assetsFolder = cfg.get<string>('folders.assets', 'assets');
          const folderUri = resolveDocRelativeFolder(document.uri, assetsFolder);

          try { await vscode.workspace.fs.stat(folderUri); } catch {
            await vscode.workspace.fs.createDirectory(folderUri);
          }

          const fileUri = vscode.Uri.joinPath(folderUri, safeName);
          const base64 = imageData.replace(/^data:[^;]+;base64,/, '');
          const bytes = Buffer.from(base64, 'base64');
          await vscode.workspace.fs.writeFile(fileUri, bytes);

          DevPanel.log('info', 'editor', `Image stored: ${safeName} (${bytes.length} bytes)`);
          const relPath = computeRelativePathFromDoc(document.uri, fileUri);
          postMessage({ type: 'imageStored', path: relPath, name: safeName });
          break;
        }

        case 'storeFile': {
          const fileData = msg.data as string | undefined;
          const fileName = msg.name as string | undefined;
          const fileOriginalName = msg.originalName as string | undefined;
          const storeId = msg.storeId as string | undefined;
          if (!fileData || !fileName || !storeId) break;

          const safeName = fileName.replace(/[<>:"/\\|?*]/g, '').trim();
          const safeOriginal = fileOriginalName?.replace(/[<>:"/\\|?*]/g, '').trim();

          const wsFolderF = vscode.workspace.getWorkspaceFolder(document.uri);
          const existingFile = wsFolderF ? await findInWorkspace(wsFolderF, document.uri, [safeOriginal, safeName]) : null;
          if (existingFile) {
            DevPanel.log('info', 'editor', `File exists in workspace, using: ${existingFile}`);
            postMessage({ type: 'fileStored', path: existingFile, name: safeName, storeId });
            break;
          }

          const cfg = vscode.workspace.getConfiguration('kivi');
          const assetsFolder = cfg.get<string>('folders.assets', 'assets');
          const folderUri = resolveDocRelativeFolder(document.uri, assetsFolder);

          try { await vscode.workspace.fs.stat(folderUri); } catch {
            await vscode.workspace.fs.createDirectory(folderUri);
          }

          const fileUri = vscode.Uri.joinPath(folderUri, safeName);
          const base64 = fileData.replace(/^data:[^;]+;base64,/, '');
          const bytes = Buffer.from(base64, 'base64');
          await vscode.workspace.fs.writeFile(fileUri, bytes);

          DevPanel.log('info', 'editor', `File stored: ${safeName} (${bytes.length} bytes)`);
          const relPath = computeRelativePathFromDoc(document.uri, fileUri);
          postMessage({ type: 'fileStored', path: relPath, name: safeName, storeId });
          break;
        }

        case 'checkOrphanAsset': {
          const assetSrc = msg.src as string | undefined;
          if (!assetSrc) break;

          // Skip data URLs and external URLs
          if (assetSrc.startsWith('data:') || assetSrc.startsWith('http://') || assetSrc.startsWith('https://')) break;

          // Resolve the asset to an absolute file URI
          const docDir = vscode.Uri.joinPath(document.uri, '..');
          const assetUri = vscode.Uri.joinPath(docDir, assetSrc);

          // Verify the file exists
          try { await vscode.workspace.fs.stat(assetUri); } catch { break; }

          // Extract just the filename for searching
          const assetBasename = path.basename(assetUri.fsPath);

          // Search all markdown files for references to this asset
          const mdFiles = await vscode.workspace.findFiles('**/*.{md,markdown}', '**/node_modules/**', 500);
          let refCount = 0;
          for (const file of mdFiles) {
            // Skip the current document (we just removed the ref from it)
            if (file.fsPath === document.uri.fsPath) continue;
            try {
              const bytes = await vscode.workspace.fs.readFile(file);
              const content = new TextDecoder().decode(bytes);
              if (content.includes(assetBasename)) {
                refCount++;
                break;
              }
            } catch { /* skip unreadable files */ }
          }

          if (refCount === 0) {
            const choice = await vscode.window.showInformationMessage(
              `"${assetBasename}" is no longer referenced in any file. Delete it permanently?`,
              { modal: false },
              'Delete',
              'Keep',
            );
            if (choice === 'Delete') {
              try {
                await vscode.workspace.fs.delete(assetUri);
                DevPanel.log('info', 'editor', `Orphan asset deleted: ${assetBasename}`);
              } catch (err) {
                vscode.window.showErrorMessage(`Failed to delete "${assetBasename}": ${err}`);
              }
            }
          }
          break;
        }



        case 'copyAssetPath': {
          const src = msg.src as string | undefined;
          if (!src) break;
          if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
            vscode.env.clipboard.writeText(src);
            break;
          }
          const resolved = this.resolveUnifiedPath(src, document);
          if (resolved) vscode.env.clipboard.writeText(resolved.fsPath);
          break;
        }
      }
    }));
  }

  // ── Link resolution ──

  private async resolveLink(
    link: { kind: string; target: string; alias?: string },
    currentDoc: vscode.TextDocument,
    webview: vscode.Webview,
  ): Promise<Record<string, unknown> | null> {
    try {
      const folder = vscode.workspace.getWorkspaceFolder(currentDoc.uri)
        ?? vscode.workspace.workspaceFolders?.[0];
      if (!folder) return null;

      const kind = link.kind;
      const target = link.target;

      if (kind === 'tag') {
        const tagFiles = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 100);
        const decoder = new TextDecoder();
        const matchingNotes: string[] = [];
        // Process in small batches, stop as soon as we have enough
        const TAG_BATCH = 8;
        for (let i = 0; i < tagFiles.length && matchingNotes.length < 10; i += TAG_BATCH) {
          const batch = tagFiles.slice(i, i + TAG_BATCH);
          await Promise.all(batch.map(async (uri) => {
            if (matchingNotes.length >= 10) return;
            try {
              const bytes = await vscode.workspace.fs.readFile(uri);
              const content = decoder.decode(bytes);
              if (content.includes(`#${target}`) || content.includes(`- ${target}`)) {
                const scan = scanMarkdown(content);
                if (scan.tags.some(t => t === target || t.startsWith(`${target}/`))) {
                  matchingNotes.push(scan.title || vscode.workspace.asRelativePath(uri, false));
                }
              }
            } catch { /* skip */ }
          }));
        }
        return {
          kind: 'tag',
          target,
          title: `#${target}`,
          noteCount: matchingNotes.length,
          exampleNotes: matchingNotes.slice(0, 5),
          exists: true,
        };
      }

      if (kind === 'external-url') {
        let domain = '';
        try { domain = new URL(target).hostname; } catch { /* malformed URL */ }

        // Fetch Open Graph metadata (cached, non-blocking)
        let og: OgMetadata = {};
        try { og = await fetchOgMetadata(target); } catch { /* skip on error */ }

        return {
          kind: 'external-url',
          target,
          title: og.title || link.alias || target,
          snippet: og.description || undefined,
          thumbnailUrl: og.image || undefined,
          domain: og.siteName || domain,
          exists: true,
          favicon: og.favicon,
          ogType: og.type,
        } as Record<string, unknown>;
      }

      if (kind === 'heading-ref') {
        const headingId = target.replace(/^#/, '').toLowerCase();
        const docContent = currentDoc.getText();
        const lines = docContent.split('\n');
        let headingText = '';
        let snippetLines: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const match = /^#{1,6}\s+(.+)/.exec(line);
          if (match) {
            const rawText = match[1].trim();
            const slug = rawText.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
            const plainSlug = rawText.replace(/`([^`]*)`/g, '$1').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
            if (slug === headingId || plainSlug === headingId || rawText.toLowerCase() === headingId) {
              headingText = rawText;
              snippetLines = lines.slice(i + 1, i + 5).filter(l => l.trim());
              break;
            }
          }
        }
        if (headingText) {
          return {
            kind: 'heading-ref', target, title: headingText,
            snippet: snippetLines.join('\n').slice(0, 200), exists: true,
          };
        }
        return { kind: 'heading-ref', target, title: target, exists: false };
      }

      if (['image', 'video', 'audio', 'pdf', 'code-file'].includes(kind)) {
        const resolved = this.resolveRelativePath(target, currentDoc);
        if (!resolved) return { kind, target, title: target.split('/').pop() || target, exists: false };

        try {
          const stat = await vscode.workspace.fs.stat(resolved);
          const result: Record<string, unknown> = {
            kind, target,
            title: target.split('/').pop() || target,
            exists: true, fileSize: stat.size,
          };

          if (kind === 'image') {
            result.thumbnailUrl = webview.asWebviewUri(resolved).toString();
          }
          if (kind === 'code-file') {
            const ext = target.split('.').pop()?.toLowerCase() || '';
            const langMap: Record<string, string> = {
              ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
              py: 'Python', rb: 'Ruby', rs: 'Rust', go: 'Go', java: 'Java',
              c: 'C', cpp: 'C++', cs: 'C#', swift: 'Swift', kt: 'Kotlin',
              sh: 'Shell', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
              html: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL', md: 'Markdown',
            };
            result.language = langMap[ext] || ext;
            if (stat.size < 50000) {
              try {
                const bytes = await vscode.workspace.fs.readFile(resolved);
                result.snippet = new TextDecoder().decode(bytes).split('\n').slice(0, 6).join('\n');
              } catch { /* snippet is optional; file may be unreadable */ }
            }
          }
          return result;
        } catch {
          return { kind, target, title: target.split('/').pop() || target, exists: false };
        }
      }

      if (kind === 'footnote') {
        const docContent = currentDoc.getText();
        const fnRe = new RegExp(`^\\[\\^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]:\\s*(.+)`, 'm');
        const match = fnRe.exec(docContent);
        if (match) {
          return { kind: 'footnote', target, title: `Footnote: ${target}`, snippet: match[1].trim(), exists: true };
        }
        return { kind: 'footnote', target, title: `[^${target}]`, exists: false };
      }

      // Wiki-link or markdown-link
      const resolvedUri = await this.resolveNoteLink(target, currentDoc, folder);
      if (!resolvedUri) {
        return { kind: kind || 'unresolved', target, title: link.alias || target, exists: false };
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(resolvedUri);
        const content = new TextDecoder().decode(bytes);
        const scan = scanMarkdown(content);
        const stat = await vscode.workspace.fs.stat(resolvedUri);

        const snippetLines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
        const snippet = snippetLines.slice(0, 4).join('\n').slice(0, 250);

        return {
          kind: kind || 'wiki-link', target,
          title: scan.title || target, snippet,
          tags: scan.tags.slice(0, 6),
          headings: scan.headings.slice(0, 10).map(h => ({ level: h.level, text: h.text })),
          modified: new Date(stat.mtime).toLocaleDateString(),
          exists: true, fileSize: stat.size,
        };
      } catch {
        return { kind: kind || 'unresolved', target, title: link.alias || target, exists: false };
      }
    } catch {
      return null;
    }
  }

  // ── Navigation ──

  private async navigateToLink(
    link: { kind: string; target: string; alias?: string },
    currentDoc: vscode.TextDocument,
    beside = false,
  ): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(currentDoc.uri)
      ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    if (link.kind === 'external-url') {
      vscode.env.openExternal(vscode.Uri.parse(link.target));
      return;
    }

    if (link.kind === 'tag') {
      vscode.commands.executeCommand('workbench.action.findInFiles', {
        query: `#${link.target}`, triggerSearch: true, isRegex: false,
      });
      return;
    }

    if (link.kind === 'heading-ref') {
      const headingId = link.target.replace(/^#/, '').toLowerCase();
      const docContent = currentDoc.getText();
      const lines = docContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = /^#{1,6}\s+(.+)/.exec(lines[i]);
        if (match) {
          const rawText = match[1].trim();
          const slug = rawText.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
          const plainSlug = rawText.replace(/`([^`]*)`/g, '$1').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
          if (slug === headingId || plainSlug === headingId || rawText.toLowerCase() === headingId) {
            const panel = KiviEditorProvider.activePanels.get(currentDoc.uri.toString());
            panel?.webview.postMessage({ type: 'scrollToHeading', heading: rawText, line: i });
            return;
          }
        }
      }
      return;
    }

    // Extract #fragment for cross-file heading navigation
    const fragmentMatch = link.target.match(/#(.+)$/);
    const headingFragment = fragmentMatch ? fragmentMatch[1] : null;

    // Resolve to file
    const resolvedUri = await this.resolveNoteLink(link.target, currentDoc, folder);
    const openCol = beside ? vscode.ViewColumn.Beside : undefined;
    if (resolvedUri) {
      try {
        await vscode.workspace.fs.stat(resolvedUri);
        if (headingFragment) {
          KiviEditorProvider.pendingHeadingScroll.set(resolvedUri.toString(), headingFragment);
        }
        vscode.commands.executeCommand('vscode.openWith', resolvedUri, KiviEditorProvider.viewType, openCol);
      } catch {
        const answer = await vscode.window.showInformationMessage(
          `"${link.target}" does not exist. Create it?`,
          'Create', 'Cancel',
        );
        if (answer === 'Create') {
          await vscode.workspace.fs.writeFile(resolvedUri, new TextEncoder().encode(`# ${link.target}\n\n`));
          vscode.commands.executeCommand('vscode.openWith', resolvedUri, KiviEditorProvider.viewType, openCol);
        }
      }
    } else {
      const assetUri = this.resolveRelativePath(link.target, currentDoc);
      if (assetUri) {
        if (/\.excalidraw$/i.test(link.target)) {
          try {
            await vscode.commands.executeCommand('vscode.openWith', assetUri, 'editor.excalidraw', openCol);
          } catch {
            vscode.commands.executeCommand('vscode.open', assetUri, openCol);
          }
        } else {
          vscode.commands.executeCommand('vscode.open', assetUri, openCol);
        }
      } else {
        vscode.window.showInformationMessage(`Could not resolve: ${link.target}`);
      }
    }
  }

  // ── Path resolution ──

  /** Resolve a wiki-link or markdown-link target to a .md file URI.
   *  Resolution order (mirrors Obsidian):
   *    1. Relative to current document directory
   *    2. Workspace root
   *    3. In-memory note index (case-insensitive basename)
   *    4. findFiles fallback (for files not yet indexed)
   *  Returns { uri, exists } — callers use `exists` to decide between
   *  opening vs. offering to create the note.
   */
  private async resolveNoteLink(
    target: string,
    currentDoc: vscode.TextDocument,
    folder: vscode.WorkspaceFolder,
  ): Promise<vscode.Uri | null> {
    const cleaned = target.replace(/#.*$/, '').replace(/\?.*$/, '').trim();
    if (!cleaned) return null;

    const name = cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`;

    // Explicit /workspace-root or ~/home paths — resolve directly
    if (cleaned.startsWith('/') || cleaned.startsWith('~/')) {
      const resolved = this.resolveUnifiedPath(name, currentDoc);
      if (resolved) {
        try {
          await vscode.workspace.fs.stat(resolved);
          return resolved;
        } catch { /* continue to fallbacks */ }
      }
    }

    // 1. Relative to current file (Obsidian's "shortest path first" heuristic)
    const currentDir = vscode.Uri.joinPath(currentDoc.uri, '..');
    const relUri = vscode.Uri.joinPath(currentDir, name);
    try {
      await vscode.workspace.fs.stat(relUri);
      return relUri;
    } catch { /* continue */ }

    // 2. Workspace root
    const rootUri = vscode.Uri.joinPath(folder.uri, name);
    try {
      await vscode.workspace.fs.stat(rootUri);
      return rootUri;
    } catch { /* continue */ }

    // 3. In-memory note index — case-insensitive, O(1) lookup
    const lookupKey = cleaned.split('/').pop()?.toLowerCase().replace(/\.md$/i, '') ?? '';
    const indexed = KiviEditorProvider.noteIndex.get(lookupKey);
    if (indexed) {
      try {
        await vscode.workspace.fs.stat(indexed);
        return indexed;
      } catch { /* stale entry — continue */ }
    }

    // 4. Glob fallback (covers files created after index was built)
    const baseName = name.split('/').pop() || name;
    const results = await vscode.workspace.findFiles(`**/${baseName}`, '**/node_modules/**', 1);
    if (results.length > 0) return results[0];

    // Nothing found — return a creation URI relative to the current doc
    return relUri;
  }

  /**
   * Resolve a path target to a URI using the unified path scheme:
   *  - `/path`  → workspace root
   *  - `~/path` → user home directory
   *  - otherwise → relative to current document directory
   */
  private resolveUnifiedPath(target: string, currentDoc: vscode.TextDocument): vscode.Uri | null {
    if (!target) return null;
    const cleaned = target.replace(/#.*$/, '');
    if (!cleaned) return null;

    if (cleaned.startsWith('/')) {
      const rootFolder = vscode.workspace.getWorkspaceFolder(currentDoc.uri)
        ?? vscode.workspace.workspaceFolders?.[0];
      if (!rootFolder) return null;
      return vscode.Uri.joinPath(rootFolder.uri, cleaned.slice(1));
    }

    if (cleaned.startsWith('~/')) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      if (!home) return null;
      return vscode.Uri.file(path.join(home, cleaned.slice(2)));
    }

    const currentDir = vscode.Uri.joinPath(currentDoc.uri, '..');
    return vscode.Uri.joinPath(currentDir, cleaned);
  }

  private resolveRelativePath(target: string, currentDoc: vscode.TextDocument): vscode.Uri | null {
    return this.resolveUnifiedPath(target, currentDoc);
  }

  // ── Git base content for gutter indicators ──

  private async sendGitBase(
    document: vscode.TextDocument,
    postMessage: (msg: Record<string, unknown>) => void,
  ): Promise<void> {
    try {
      const gitUri = document.uri.with({ scheme: 'git', query: JSON.stringify({ path: document.uri.fsPath, ref: 'HEAD' }) });
      const gitDoc = await vscode.workspace.openTextDocument(gitUri);
      postMessage({ type: 'gitBase', content: gitDoc.getText() });
    } catch {
      // No git info available (new file, not in repo, etc.)
    }
  }

  // ── Accurate git diff hunks (matches VS Code SCM gutters) ──

  private sendGitDiff(
    document: vscode.TextDocument,
    postMessage: (msg: Record<string, unknown>) => void,
  ): void {
    const fsPath = document.uri.fsPath;
    const dir = path.dirname(fsPath);
    const file = path.basename(fsPath);

    const cmd = `git diff HEAD --unified=0 -- "${file}"`;
    cp.exec(cmd, { cwd: dir, timeout: 5000 }, (err, stdout) => {
      if (err && !stdout) {
        // If git diff fails entirely (not in repo, etc.), try detecting
        // if the file is untracked (all lines are "added")
        cp.exec(`git ls-files -- "${file}"`, { cwd: dir, timeout: 3000 }, (lsErr, lsOut) => {
          if (!lsErr && lsOut.trim() === '') {
            // Untracked file: count lines and mark all as added
            const lines = document.getText().split('\n');
            if (lines.length > 0) {
              postMessage({
                type: 'gitDiffHunks',
                hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length }],
              });
            }
          }
        });
        return;
      }

      const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }> = [];
      const hunkRe = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g;
      let match: RegExpExecArray | null;
      while ((match = hunkRe.exec(stdout)) !== null) {
        const oldStart = parseInt(match[1], 10);
        const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        const newStart = parseInt(match[3], 10);
        const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;
        hunks.push({ oldStart, oldCount, newStart, newCount });
      }

      postMessage({ type: 'gitDiffHunks', hunks });
    });
  }

  // ── Git blame for author info ──

  private getBlameInfo(
    document: vscode.TextDocument,
    lineStart: number,
    lineEnd: number,
    postMessage: (msg: Record<string, unknown>) => void,
  ): void {
    const fsPath = document.uri.fsPath;
    const dir = path.dirname(fsPath);
    const file = path.basename(fsPath);

    // git blame with porcelain output for structured parsing
    const cmd = `git blame -L ${lineStart + 1},${lineEnd + 1} --porcelain -- "${file}"`;
    cp.exec(cmd, { cwd: dir, timeout: 5000 }, (err, stdout) => {
      if (err) {
        postMessage({ type: 'blameResult', lineStart, lineEnd, entries: [] });
        return;
      }

      const entries: Array<{ line: number; author: string; date: string; summary: string; hash: string }> = [];
      const lines = stdout.split('\n');
      let currentHash = '';
      let currentAuthor = '';
      let currentDate = '';
      let currentSummary = '';
      let currentLine = lineStart;

      for (const raw of lines) {
        const hashMatch = raw.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
        if (hashMatch) {
          currentHash = hashMatch[1];
          currentLine = parseInt(hashMatch[2], 10) - 1;
          continue;
        }
        if (raw.startsWith('author ')) {
          currentAuthor = raw.slice(7);
        } else if (raw.startsWith('author-time ')) {
          const ts = parseInt(raw.slice(12), 10);
          const d = new Date(ts * 1000);
          currentDate = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        } else if (raw.startsWith('summary ')) {
          currentSummary = raw.slice(8);
        } else if (raw.startsWith('\t')) {
          entries.push({
            line: currentLine,
            author: currentAuthor,
            date: currentDate,
            summary: currentSummary,
            hash: currentHash.slice(0, 8),
          });
        }
      }

      postMessage({ type: 'blameResult', lineStart, lineEnd, entries });
    });
  }

  // ── Full-file git blame (for inline annotations) ──

  private getFullBlameInfo(
    document: vscode.TextDocument,
    postMessage: (msg: Record<string, unknown>) => void,
  ): void {
    const fsPath = document.uri.fsPath;
    const dir = path.dirname(fsPath);
    const file = path.basename(fsPath);

    const cmd = `git blame --porcelain -- "${file}"`;
    cp.exec(cmd, { cwd: dir, timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        postMessage({ type: 'fullBlameResult', entries: [] });
        return;
      }

      const entries: Array<{
        line: number; author: string; authorMail: string;
        authorTime: number; summary: string; hash: string;
      }> = [];
      const lines = stdout.split('\n');
      let currentHash = '';
      let currentAuthor = '';
      let currentAuthorMail = '';
      let currentAuthorTime = 0;
      let currentSummary = '';
      let currentLine = 0;

      for (const raw of lines) {
        const hashMatch = raw.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
        if (hashMatch) {
          currentHash = hashMatch[1];
          currentLine = parseInt(hashMatch[2], 10) - 1;
          continue;
        }
        if (raw.startsWith('author ')) {
          currentAuthor = raw.slice(7);
        } else if (raw.startsWith('author-mail ')) {
          currentAuthorMail = raw.slice(12).replace(/^<|>$/g, '');
        } else if (raw.startsWith('author-time ')) {
          currentAuthorTime = parseInt(raw.slice(12), 10);
        } else if (raw.startsWith('summary ')) {
          currentSummary = raw.slice(8);
        } else if (raw.startsWith('\t')) {
          entries.push({
            line: currentLine,
            author: currentAuthor,
            authorMail: currentAuthorMail,
            authorTime: currentAuthorTime,
            summary: currentSummary,
            hash: currentHash,
          });
        }
      }

      postMessage({ type: 'fullBlameResult', entries });
    });
  }

  // ── HTML ──

  private getHtml(webview: vscode.Webview, embeddedContent?: string): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.js'),
    );
    const excalidrawScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'excalidraw-renderer.js'),
    );
    const monacoWorkerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'editor.worker.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.css'),
    );
    const nonce = getNonce();

    const dataTag = embeddedContent != null
      ? `<script nonce="${nonce}" type="application/json" id="kivi-initial-md">${JSON.stringify(embeddedContent).replace(/<\//g, '<\\/')}</script>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} data: https:; media-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource}; worker-src ${webview.cspSource} blob:;" />
  <title>Kivi</title>
  <style nonce="${nonce}">
    body { margin:0; padding:0; overflow:hidden; height:100vh; display:flex; flex-direction:column; background:var(--vscode-editor-background,#1e1e1e); color:var(--vscode-editor-foreground,#d4d4d4); }
    #editor { position:relative; flex:1; overflow:hidden; }
    .kivi-skeleton { padding: 40px 60px; opacity: 0.35; animation: kivi-pulse 1.2s ease-in-out infinite; position: absolute; inset: 0; z-index: 50; background: var(--vscode-editor-background, #1e1e1e); }
    .kivi-skeleton-line { height: 14px; margin-bottom: 12px; border-radius: 4px; background: var(--vscode-editor-foreground, #888); }
    .kivi-skeleton-line.h1 { height: 26px; width: 45%; margin-bottom: 20px; }
    .kivi-skeleton-line.h2 { height: 20px; width: 35%; margin-top: 24px; margin-bottom: 16px; }
    .kivi-skeleton-line.short { width: 60%; }
    .kivi-skeleton-line.med { width: 85%; }
    .kivi-skeleton-line.full { width: 95%; }
    @keyframes kivi-pulse { 0%,100% { opacity: 0.15; } 50% { opacity: 0.35; } }
  </style>
</head>
<body class="kivi-loading">
  <div id="editor">
    <div class="kivi-skeleton" id="kivi-skeleton">
      <div class="kivi-skeleton-line h1"></div>
      <div class="kivi-skeleton-line full"></div>
      <div class="kivi-skeleton-line med"></div>
      <div class="kivi-skeleton-line short"></div>
      <div class="kivi-skeleton-line full"></div>
      <div class="kivi-skeleton-line h2"></div>
      <div class="kivi-skeleton-line med"></div>
      <div class="kivi-skeleton-line full"></div>
      <div class="kivi-skeleton-line short"></div>
    </div>
  </div>
  ${dataTag}
  <link href="${styleUri}" rel="stylesheet" />
  <script nonce="${nonce}">
    self.MonacoEnvironment = {
      getWorkerUrl: function() { return '${monacoWorkerUri}'; }
    };
  </script>
  <script nonce="${nonce}" src="${excalidrawScriptUri}" async></script>
  <script nonce="${nonce}" src="${scriptUri}" defer></script>
</body>
</html>`;
  }
}

