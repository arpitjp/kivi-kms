import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { scanMarkdown } from '@kivi/vault';
import { getNonce, resolveDocRelativeFolder, computeRelativePathFromDoc } from './utils.js';
import { DevPanel } from './dev-panel.js';

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
    vscodeEditorFontSize: editorCfg.get<number>('fontSize', 14),
    vscodeEditorFontFamily: editorCfg.get<string>('fontFamily', ''),
    vscodeEditorLineHeight: editorCfg.get<number>('lineHeight', 0),
    vscodeEditorWordWrap: editorCfg.get<string>('wordWrap', 'on'),
    vscodeZoomLevel: windowCfg.get<number>('zoomLevel', 0),
  };
}

export class KiviEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'kivi.markdownEditor';

  /** Tracks all active webview panels keyed by document URI, for commands/focus. */
  private static activePanels = new Map<string, vscode.WebviewPanel>();

  /** Workspace-wide tag set, populated by indexWorkspace in extension.ts */
  static workspaceTags = new Set<string>();

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
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (wsFolder) roots.push(wsFolder.uri);

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
          // Re-send file info for sidebars that track active editor
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

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          isWebviewReady = true;
          DevPanel.perf(`editor-open:${docName}`, 'end');
          DevPanel.log('debug', 'editor', `Webview ready: ${docName}`);

          // Send document metadata
          const relPath = vscode.workspace.asRelativePath(document.uri, false);
          const docDirUri = vscode.Uri.joinPath(document.uri, '..');
          const docBaseUrl = webviewPanel.webview.asWebviewUri(docDirUri).toString();
          postMessage({
            type: 'init',
            filePath: relPath,
            fileName: relPath.split('/').pop()?.replace(/\.md$/, '') || '',
            isReadonly: document.isUntitled,
            docBaseUrl: docBaseUrl.endsWith('/') ? docBaseUrl : docBaseUrl + '/',
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
            if (KiviEditorProvider.workspaceTags.size > 0) {
              postMessage({ type: 'tagIndex', tags: Array.from(KiviEditorProvider.workspaceTags).sort() });
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

        case 'openExternal': {
          const url = msg.url as string | undefined;
          if (url) vscode.env.openExternal(vscode.Uri.parse(url));
          break;
        }

        case 'readExcalidrawFile': {
          const excSrc = msg.src as string | undefined;
          const reqId = msg.reqId as string | undefined;
          if (excSrc && reqId) {
            try {
              const docDir = vscode.Uri.joinPath(document.uri, '..');
              const fileUri = vscode.Uri.joinPath(docDir, excSrc);
              const data = await vscode.workspace.fs.readFile(fileUri);
              const content = new TextDecoder().decode(data);
              postMessage({ type: 'excalidrawFileContent', reqId, content });
            } catch (e) {
              postMessage({ type: 'excalidrawFileContent', reqId, error: String(e) });
            }
          }
          break;
        }

        case 'openExcalidraw': {
          const excSrc = msg.src as string | undefined;
          if (excSrc) {
            const docDir = vscode.Uri.joinPath(document.uri, '..');
            const fileUri = vscode.Uri.joinPath(docDir, excSrc);
            // Try to open with excalidraw extension, fall back to default editor
            try {
              await vscode.commands.executeCommand('vscode.openWith', fileUri, 'excalidraw-editor.editor');
            } catch {
              await vscode.commands.executeCommand('vscode.open', fileUri);
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
          const oldText = lastKnownContent;
          const newText = newContent;

          // Find minimal diff range
          let start = 0;
          while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
            start++;
          }
          let oldEnd = oldText.length;
          let newEnd = newText.length;
          while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
            oldEnd--;
            newEnd--;
          }

          const range = new vscode.Range(
            document.positionAt(start),
            document.positionAt(oldEnd),
          );
          const replacement = newText.slice(start, newEnd);

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

        case 'listWorkspaceFiles': {
          if (!wsFolder) break;
          const mdUris = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 500);
          const docDir = path.dirname(document.uri.fsPath);
          const wsRoot = wsFolder.uri.fsPath;
          const files = mdUris.map(u => {
            const rel = path.relative(wsRoot, u.fsPath).replace(/\\/g, '/');
            const name = path.basename(u.fsPath, '.md');
            const relToDoc = path.relative(docDir, u.fsPath).replace(/\\/g, '/');
            return { rel, name, relToDoc };
          }).filter(f => f.rel !== path.relative(wsRoot, document.uri.fsPath).replace(/\\/g, '/'));
          files.sort((a, b) => a.name.localeCompare(b.name));
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

        case 'storeImage': {
          const imageData = msg.data as string | undefined;
          const imageName = msg.name as string | undefined;
          if (!imageData || !imageName) break;

          const cfg = vscode.workspace.getConfiguration('kivi');
          const assetsFolder = cfg.get<string>('folders.assets', 'assets');
          const folderUri = resolveDocRelativeFolder(document.uri, assetsFolder);

          try { await vscode.workspace.fs.stat(folderUri); } catch {
            await vscode.workspace.fs.createDirectory(folderUri);
          }

          const safeName = imageName.replace(/[<>:"/\\|?*]/g, '').trim();
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
          const storeId = msg.storeId as string | undefined;
          if (!fileData || !fileName || !storeId) break;

          const cfg = vscode.workspace.getConfiguration('kivi');
          const assetsFolder = cfg.get<string>('folders.assets', 'assets');
          const folderUri = resolveDocRelativeFolder(document.uri, assetsFolder);

          try { await vscode.workspace.fs.stat(folderUri); } catch {
            await vscode.workspace.fs.createDirectory(folderUri);
          }

          const safeName = fileName.replace(/[<>:"/\\|?*]/g, '').trim();
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
      }
    });
  }

  // ── Link resolution ──

  private async resolveLink(
    link: { kind: string; target: string; alias?: string },
    currentDoc: vscode.TextDocument,
    webview: vscode.Webview,
  ): Promise<Record<string, unknown> | null> {
    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
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
        try { domain = new URL(target).hostname; } catch { /* */ }
        return {
          kind: 'external-url',
          target,
          title: link.alias || target,
          domain,
          exists: true,
        };
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
              } catch { /* */ }
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
    const folder = vscode.workspace.workspaceFolders?.[0];
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

    // Resolve to file
    const resolvedUri = await this.resolveNoteLink(link.target, currentDoc, folder);
    const openCol = beside ? vscode.ViewColumn.Beside : undefined;
    if (resolvedUri) {
      try {
        await vscode.workspace.fs.stat(resolvedUri);
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
        vscode.commands.executeCommand('vscode.open', assetUri, openCol);
      } else {
        vscode.window.showInformationMessage(`Could not resolve: ${link.target}`);
      }
    }
  }

  // ── Path resolution ──

  /** Resolve a wiki-link or markdown-link target to a .md file URI.
   *  Tries: workspace-root exact, case-insensitive search, relative path.
   */
  private async resolveNoteLink(
    target: string,
    currentDoc: vscode.TextDocument,
    folder: vscode.WorkspaceFolder,
  ): Promise<vscode.Uri | null> {
    const cleaned = target.replace(/#.*$/, '').replace(/\?.*$/, '').trim();
    if (!cleaned) return null;

    const name = cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`;

    // Try workspace root
    const rootUri = vscode.Uri.joinPath(folder.uri, name);
    try {
      await vscode.workspace.fs.stat(rootUri);
      return rootUri;
    } catch { /* continue */ }

    // Try relative to current file
    const currentDir = vscode.Uri.joinPath(currentDoc.uri, '..');
    const relUri = vscode.Uri.joinPath(currentDir, name);
    try {
      await vscode.workspace.fs.stat(relUri);
      return relUri;
    } catch { /* continue */ }

    // Case-insensitive: search for matching file name
    const baseName = name.split('/').pop() || name;
    const results = await vscode.workspace.findFiles(`**/${baseName}`, '**/node_modules/**', 1);
    if (results.length > 0) return results[0];

    // Fall back to workspace root (for creating new files)
    return rootUri;
  }

  private resolveRelativePath(target: string, currentDoc: vscode.TextDocument): vscode.Uri | null {
    if (!target) return null;
    const currentDir = vscode.Uri.joinPath(currentDoc.uri, '..');
    return vscode.Uri.joinPath(currentDir, target);
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

  // ── HTML ──

  private getHtml(webview: vscode.Webview, embeddedContent?: string): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.js'),
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
    content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource};" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Kivi</title>
  <style nonce="${nonce}">
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
<body>
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
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

