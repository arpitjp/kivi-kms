import * as vscode from 'vscode';
import * as path from 'path';
import { KiviEditorProvider } from './editor-provider.js';
import { BacklinksProvider } from './backlinks-provider.js';
import { FileExplorerProvider } from './file-explorer-provider.js';
import { OutlineProvider, makeHeadingSlug } from './outline-provider.js';
import type { OutlineItem } from './outline-provider.js';
import { TagTreeProvider } from './tag-tree-provider.js';
import { IssuesProvider } from './issues-provider.js';
import { AssetsProvider } from './assets-provider.js';
import { GraphPanel } from './graph-panel.js';
import { DevPanel } from './dev-panel.js';
import { getActiveMarkdownUri, computeRelativePathFromDoc } from './utils.js';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(KiviEditorProvider.register(context));

  vscode.commands.executeCommand('setContext', 'hasCustomMarkdownPreview', true);
  vscode.commands.executeCommand('setContext', 'kivi.isActive', true);

  // ── Dev mode ──
  // On in Extension Development Host, or when kivi.dev.enabled is true in settings JSON.
  // The command is always registered (so toggling the setting doesn't require reload)
  // but only visible in the palette when devMode is active.

  context.subscriptions.push(
    vscode.commands.registerCommand('kivi.openDevTools', () => {
      if (!DevPanel.enabled) {
        vscode.window.showInformationMessage('Dev tools are not enabled. Set "kivi.dev.enabled": true in settings JSON.');
        return;
      }
      DevPanel.open(context);
    }),
  );

  const applyDevMode = () => {
    const shouldEnable = DevPanel.shouldEnable(context);
    if (shouldEnable && !DevPanel.enabled) {
      DevPanel.enable();
      DevPanel.log('info', 'extension', `Dev mode activated (${context.extensionMode === vscode.ExtensionMode.Development ? 'Extension Development Host' : 'kivi.dev.enabled setting'})`);
    }
    vscode.commands.executeCommand('setContext', 'kivi.devMode', shouldEnable);
  };
  applyDevMode();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('kivi.dev.enabled')) applyDevMode();
    }),
  );

  // ── Default editor setting ──

  const applyDefaultEditorSetting = () => {
    const cfg = vscode.workspace.getConfiguration('kivi');
    const isDefault = cfg.get<boolean>('defaultEditor', true);
    const wbCfg = vscode.workspace.getConfiguration('workbench');
    const assoc = wbCfg.get<Record<string, string>>('editorAssociations') ?? {};
    const patterns = ['*.md', '*.markdown'];

    if (isDefault) {
      let needsUpdate = false;
      const updated = { ...assoc };
      for (const pat of patterns) {
        if (updated[pat] !== KiviEditorProvider.viewType) {
          updated[pat] = KiviEditorProvider.viewType;
          needsUpdate = true;
        }
      }
      if (needsUpdate) {
        wbCfg.update('editorAssociations', updated, vscode.ConfigurationTarget.Global);
      }
    } else {
      let needsUpdate = false;
      const updated = { ...assoc };
      for (const pat of patterns) {
        if (updated[pat] === KiviEditorProvider.viewType) {
          delete updated[pat];
          needsUpdate = true;
        }
      }
      if (needsUpdate) {
        wbCfg.update('editorAssociations', updated, vscode.ConfigurationTarget.Global);
      }
    }
  };
  applyDefaultEditorSetting();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('kivi.defaultEditor')) {
        DevPanel.log('info', 'config', `kivi.defaultEditor changed to ${vscode.workspace.getConfiguration('kivi').get('defaultEditor')}`);
        applyDefaultEditorSetting();
      }
    }),
  );

  const getActiveUri = (): vscode.Uri | undefined =>
    vscode.window.activeTextEditor?.document.uri
    ?? (vscode.window.tabGroups.activeTabGroup.activeTab?.input as any)?.uri;

  // ── Core commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('kivi.openInKivi', (uri?: vscode.Uri) => {
      const target = uri ?? getActiveUri();
      if (target) {
        DevPanel.log('debug', 'cmd', `openInKivi: ${target.fsPath.split('/').pop()}`);
        vscode.commands.executeCommand('vscode.openWith', target, KiviEditorProvider.viewType);
      }
    }),

    vscode.commands.registerCommand('kivi.openWithTextEditor', (uri?: vscode.Uri) => {
      const target = uri ?? getActiveUri();
      if (target) {
        DevPanel.log('debug', 'cmd', `openWithTextEditor: ${target.fsPath.split('/').pop()}`);
        vscode.commands.executeCommand('vscode.openWith', target, 'default');
      }
    }),

    vscode.commands.registerCommand('kivi.openToSide', (uri?: vscode.Uri) => {
      const target = uri ?? getActiveUri();
      if (target) {
        DevPanel.log('debug', 'cmd', `openToSide: ${target.fsPath.split('/').pop()}`);
        vscode.commands.executeCommand('vscode.openWith', target, KiviEditorProvider.viewType, vscode.ViewColumn.Beside);
      }
    }),

    vscode.commands.registerCommand('kivi.revealInExplorer', () => {
      const uri = getActiveUri();
      if (uri) vscode.commands.executeCommand('revealInExplorer', uri);
    }),

    vscode.commands.registerCommand('kivi.copyAsReference', async (contextUri: vscode.Uri, allUris: vscode.Uri[]) => {
      const uris = allUris?.length ? allUris : contextUri ? [contextUri] : [];
      if (uris.length === 0) return;

      // Resolve relative paths from the active Kivi editor's document.
      // Falls back to workspace-relative if no editor is open.
      const panel = KiviEditorProvider.getActivePanel();
      const docUri = panel ? KiviEditorProvider.getDocumentUriForPanel(panel) : undefined;

      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
      const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.ogg']);
      const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.weba']);

      const parts: string[] = [];
      for (const uri of uris) {
        try { await vscode.workspace.fs.stat(uri); } catch { continue; }

        const ext = path.extname(uri.fsPath).toLowerCase();
        let fileType = 'file';
        if (IMAGE_EXTS.has(ext)) fileType = 'image';
        else if (VIDEO_EXTS.has(ext)) fileType = 'video';
        else if (AUDIO_EXTS.has(ext)) fileType = 'audio';
        else if (/\.excalidraw$/i.test(uri.fsPath)) fileType = 'excalidraw';

        // Workspace file → ref only. External → copy into workspace first.
        let targetUri = uri;
        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!wsFolder) {
          const rootFolder = vscode.workspace.workspaceFolders?.[0];
          if (rootFolder) {
            const destDir = (fileType === 'file' && /\.md$/i.test(ext)) ? 'pages' : 'assets';
            const destFolder = vscode.Uri.joinPath(rootFolder.uri, destDir);
            try { await vscode.workspace.fs.createDirectory(destFolder); } catch { /* exists */ }
            targetUri = vscode.Uri.joinPath(destFolder, path.basename(uri.fsPath));
            await vscode.workspace.fs.copy(uri, targetUri, { overwrite: false });
          }
        }

        const relPath = docUri
          ? computeRelativePathFromDoc(docUri, targetUri)
          : vscode.workspace.asRelativePath(targetUri, false);
        const name = relPath.split('/').pop()?.replace(/\.[^.]+$/, '') || relPath;

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
          default:
            parts.push(`[${name}](${relPath})`);
            break;
        }
      }

      if (parts.length > 0) {
        await vscode.env.clipboard.writeText(parts.join('\n\n'));
        vscode.window.showInformationMessage(`Copied ${parts.length} reference(s) — paste with ⌘V`);
      }
    }),

    vscode.commands.registerCommand('kivi.openGraph', () => {
      DevPanel.log('debug', 'cmd', 'openGraph');
      GraphPanel.open(context);
    }),
    vscode.commands.registerCommand('kivi.openGraphGlobal', () => {
      DevPanel.log('debug', 'cmd', 'openGraphGlobal');
      GraphPanel.open(context);
    }),

    vscode.commands.registerCommand('kivi.setDefaultEditor', () => {
      vscode.workspace.getConfiguration('kivi').update('defaultEditor', true, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Kivi is now the default Markdown editor.');
    }),

    vscode.commands.registerCommand('kivi.removeDefaultEditor', () => {
      vscode.workspace.getConfiguration('kivi').update('defaultEditor', false, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Kivi is no longer the default Markdown editor.');
    }),

    vscode.commands.registerCommand('kivi.createExcalidraw', async () => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Excalidraw file name',
        value: 'diagram',
        validateInput: (v) => v.trim() ? null : 'Name is required',
      });
      if (!name) return;
      const fileName = name.endsWith('.excalidraw') ? name : `${name}.excalidraw`;
      const assetsDir = vscode.Uri.joinPath(wsFolder.uri, 'assets');
      try { await vscode.workspace.fs.createDirectory(assetsDir); } catch { /* exists */ }
      const fileUri = vscode.Uri.joinPath(assetsDir, fileName);
      const emptyScene = JSON.stringify({
        type: 'excalidraw', version: 2, source: 'kivi',
        elements: [],
        appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
        files: {},
      }, null, 2);
      try {
        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(emptyScene));
      } catch {
        vscode.window.showErrorMessage(`Failed to create ${fileName}`);
        return;
      }
      try {
        await vscode.commands.executeCommand('vscode.openWith', fileUri, 'editor.excalidraw');
      } catch {
        await vscode.commands.executeCommand('vscode.open', fileUri);
      }
      const mdUri = getActiveMarkdownUri();
      if (mdUri) {
        const panel = KiviEditorProvider.getPanelForUri(mdUri.toString());
        if (panel) {
          const relPath = computeRelativePathFromDoc(mdUri, fileUri);
          panel.webview.postMessage({ type: 'insertExcalidraw', src: relPath });
        }
      }
    }),

    vscode.commands.registerCommand('kivi.showGraphInTab', () => {
      const mdUri = getActiveMarkdownUri();
      const focusNode = mdUri ? vscode.workspace.asRelativePath(mdUri, false) : undefined;
      GraphPanel.open(context, focusNode);
    }),

    vscode.commands.registerCommand('kivi.scrollToHeading', (heading: string, line: number) => {
      const uri = getActiveUri();
      if (uri) {
        const panel = KiviEditorProvider.getPanelForUri(uri.toString());
        if (panel) {
          panel.webview.postMessage({ type: 'scrollToHeading', heading, line });
          return;
        }
      }
      const textEditor = vscode.window.activeTextEditor;
      if (textEditor) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        textEditor.selection = new vscode.Selection(pos, pos);
        textEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
  );

  // ── File explorer sidebar ──

  const fileExplorerProvider = new FileExplorerProvider();
  const filesView = vscode.window.createTreeView('kivi.files', {
    treeDataProvider: fileExplorerProvider,
  });
  context.subscriptions.push(filesView);

  let filesRevealTimer: ReturnType<typeof setTimeout> | undefined;
  const revealActiveFileInTree = () => {
    if (filesRevealTimer) clearTimeout(filesRevealTimer);
    filesRevealTimer = setTimeout(async () => {
      if (!filesView.visible) return;
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = activeTab?.input as { uri?: vscode.Uri; viewType?: string } | undefined;
      if (input?.viewType !== KiviEditorProvider.viewType || !input.uri) return;

      const node = fileExplorerProvider.findNodeByUri(input.uri)
        ?? await fileExplorerProvider.resolveNodeByPath(input.uri);
      if (node) {
        filesView.reveal(node, { select: true, focus: false, expand: true });
      }
    }, 150);
  };

  // ── Outline view ──

  const outlineProvider = new OutlineProvider(context);
  const outlineView = vscode.window.createTreeView('kivi.outline', {
    treeDataProvider: outlineProvider,
  });
  context.subscriptions.push(outlineView);

  // Auto-reveal the active heading in the outline as user scrolls
  let _revealTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    KiviEditorProvider.onActiveHeading((heading) => {
      if (_revealTimer) clearTimeout(_revealTimer);
      _revealTimer = setTimeout(() => {
        if (!outlineView.visible) return;
        const item = outlineProvider.findByLabel(heading);
        if (item) {
          outlineView.reveal(item, { select: true, focus: false, expand: true });
        }
      }, 100);
    }),
  );

  // ── Backlinks ──

  const backlinksProvider = new BacklinksProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kivi.backlinks', backlinksProvider),
  );

  // ── Tags tree ──

  const tagTreeProvider = new TagTreeProvider();
  const tagsView = vscode.window.createTreeView('kivi.tags', {
    treeDataProvider: tagTreeProvider,
  });
  context.subscriptions.push(
    tagsView,
    vscode.commands.registerCommand('kivi.refreshTags', () => tagTreeProvider.refresh()),
    vscode.commands.registerCommand('kivi.searchTag', (tag: string) => {
      if (tag) {
        vscode.commands.executeCommand('workbench.action.findInFiles', {
          query: `#${tag}`,
          triggerSearch: true,
          isRegex: false,
          filesToInclude: '**/*.md',
        });
      }
    }),
  );

  // ── Issues view ──

  const issuesProvider = new IssuesProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kivi.issues', issuesProvider),
    vscode.commands.registerCommand('kivi.refreshIssues', () => issuesProvider.refresh()),
    vscode.commands.registerCommand('kivi.issueNavigate', async (filePath: string, line?: number) => {
      const uri = vscode.Uri.file(filePath);
      if (filePath.endsWith('.md') || filePath.endsWith('.markdown')) {
        await vscode.commands.executeCommand('vscode.openWith', uri, 'kivi.markdownEditor');
        if (line) {
          const panel = KiviEditorProvider.getPanelForUri(uri.toString());
          if (panel) {
            panel.webview.postMessage({ type: 'scrollToLine', line });
          }
        }
      } else {
        await vscode.commands.executeCommand('vscode.open', uri);
      }
    }),
  );

  // ── Assets view ──

  const assetsProvider = new AssetsProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kivi.assets', assetsProvider),
    vscode.commands.registerCommand('kivi.refreshAssets', () => assetsProvider.refresh()),
    vscode.commands.registerCommand('kivi.assetNavigate', async (assetPath: string, refFile?: string, refLine?: number) => {
      if (refFile && refLine) {
        const uri = vscode.Uri.file(refFile);
        if (refFile.endsWith('.md') || refFile.endsWith('.markdown')) {
          await vscode.commands.executeCommand('vscode.openWith', uri, 'kivi.markdownEditor');
          const panel = KiviEditorProvider.getPanelForUri(uri.toString());
          if (panel) {
            panel.webview.postMessage({ type: 'scrollToLine', line: refLine });
          }
        } else {
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc);
          const pos = new vscode.Position(Math.max(0, refLine - 1), 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      } else {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(assetPath));
      }
    }),
  );

  // ── Index workspace (concurrency-limited, silent during batch) ──

  const CONCURRENCY = 16;
  const TAG_RE = /(?:^|\s)#([a-zA-Z0-9_/][a-zA-Z0-9_/-]*)/g;

  function extractTags(content: string): string[] {
    const tags: string[] = [];
    let inFence = false;
    for (const line of content.split('\n')) {
      if (/^```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      TAG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TAG_RE.exec(line)) !== null) {
        tags.push(m[1]);
      }
    }
    return tags;
  }

  const indexWorkspace = async () => {
    const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 2000);
    const decoder = new TextDecoder();

    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (uri) => {
        try {
          KiviEditorProvider.updateNoteIndex(uri);
          const bytes = await vscode.workspace.fs.readFile(uri);
          const content = decoder.decode(bytes);
          backlinksProvider.updateIndex(uri.fsPath, content, true);
          const fileTags = extractTags(content);
          for (const tag of fileTags) {
            KiviEditorProvider.workspaceTags.add(tag);
          }
          tagTreeProvider.updateIndex(uri.fsPath, fileTags);
        } catch { /* skip unreadable */ }
      }));
      // Yield between batches to avoid blocking the extension host event loop
      if (i + CONCURRENCY < files.length) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    backlinksProvider.refresh();
    tagTreeProvider.refresh();
    issuesProvider.refresh();
    assetsProvider.refresh();
    KiviEditorProvider.broadcastTagIndex();
    DevPanel.log('info', 'indexer', `Indexed ${files.length} files, ${KiviEditorProvider.workspaceTags.size} tags`);
  };

  DevPanel.perf('workspace-index', 'start');
  // Defer indexing generously on startup — the first file open should be instant.
  setTimeout(() => indexWorkspace().then(() => DevPanel.perf('workspace-index', 'end')), 3000);

  // ── Auto-fix references on rename/move (wiki-links, markdown links, image refs) ──

  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (e) => {
      const dec = new TextDecoder();
      const enc = new TextEncoder();
      const mdFiles = await vscode.workspace.findFiles('**/*.{md,markdown}', '**/node_modules/**', 5000);

      for (const { oldUri, newUri } of e.files) {
        const oldRel = vscode.workspace.asRelativePath(oldUri, false);
        const newRel = vscode.workspace.asRelativePath(newUri, false);
        const isMd = oldUri.fsPath.endsWith('.md') || oldUri.fsPath.endsWith('.markdown');

        const oldName = oldRel.replace(/\.md$/, '').split('/').pop() || '';
        const newName = newRel.replace(/\.md$/, '').split('/').pop() || '';
        const oldBasename = oldRel.split('/').pop() || '';
        const newBasename = newRel.split('/').pop() || '';

        if (oldRel === newRel) continue;

        DevPanel.log('info', 'rename', `Reference update: ${oldRel} → ${newRel}`);

        for (let i = 0; i < mdFiles.length; i += CONCURRENCY) {
          const batch = mdFiles.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (file) => {
            try {
              const bytes = await vscode.workspace.fs.readFile(file);
              let content = dec.decode(bytes);
              let changed = false;

              // 1. Wiki-links: [[oldName]] or [[oldName|alias]]
              if (isMd && oldName !== newName) {
                const wikiPattern = new RegExp(
                  `\\[\\[${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`, 'g',
                );
                if (wikiPattern.test(content)) {
                  wikiPattern.lastIndex = 0;
                  content = content.replace(wikiPattern, `[[${newName}$1]]`);
                  changed = true;
                }
              }

              // 2. Markdown links and images: [text](path) and ![alt](path)
              // Compute old path relative to this file's directory
              const fileRel = vscode.workspace.asRelativePath(file, false);
              const fileDir = fileRel.includes('/') ? fileRel.slice(0, fileRel.lastIndexOf('/')) : '';
              const oldRelFromFile = computeRelPath(fileDir, oldRel);
              const newRelFromFile = computeRelPath(fileDir, newRel);

              if (oldRelFromFile !== newRelFromFile) {
                const escaped = oldRelFromFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Match: [any text](oldRelFromFile) or ![any text](oldRelFromFile)
                const linkPattern = new RegExp(
                  `(!?\\[[^\\]]*\\])\\(${escaped}\\)`, 'g',
                );
                if (linkPattern.test(content)) {
                  linkPattern.lastIndex = 0;
                  content = content.replace(linkPattern, `$1(${newRelFromFile})`);
                  changed = true;
                }

                // Also match bare path references (HTML src=, etc.)
                const bareOld = oldBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const bareNew = newBasename;
                if (oldBasename !== newBasename) {
                  const srcPattern = new RegExp(
                    `(src=["'])([^"']*?)${bareOld}(["'])`, 'g',
                  );
                  if (srcPattern.test(content)) {
                    srcPattern.lastIndex = 0;
                    content = content.replace(srcPattern, (_match, pre, pathPre, post) => {
                      return `${pre}${pathPre}${bareNew}${post}`;
                    });
                    changed = true;
                  }
                }
              }

              if (changed) {
                await vscode.workspace.fs.writeFile(file, enc.encode(content));
              }
            } catch { /* skip unreadable files */ }
          }));
        }
      }
    }),
  );

  // ── Warn when deleting assets that are still referenced in markdown ──

  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles(async (e) => {
      const dec = new TextDecoder();
      const assetExts = new Set([
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
        '.mp4', '.webm', '.mov', '.avi', '.mkv',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip',
      ]);

      for (const uri of e.files) {
        const ext = uri.fsPath.slice(uri.fsPath.lastIndexOf('.')).toLowerCase();
        if (!assetExts.has(ext)) continue;

        const basename = uri.fsPath.split('/').pop() || '';
        if (!basename) continue;

        // Check if any markdown file references this asset
        const mdFiles = await vscode.workspace.findFiles('**/*.{md,markdown}', '**/node_modules/**', 2000);
        const referencingFiles: string[] = [];

        for (let i = 0; i < mdFiles.length; i += CONCURRENCY) {
          const batch = mdFiles.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (file) => {
            try {
              const bytes = await vscode.workspace.fs.readFile(file);
              const content = dec.decode(bytes);
              if (content.includes(basename)) {
                referencingFiles.push(vscode.workspace.asRelativePath(file, false));
              }
            } catch { /* skip */ }
          }));
        }

        if (referencingFiles.length > 0) {
          const fileList = referencingFiles.length <= 3
            ? referencingFiles.join(', ')
            : `${referencingFiles.slice(0, 3).join(', ')} and ${referencingFiles.length - 3} more`;
          vscode.window.showWarningMessage(
            `Deleted asset "${basename}" is still referenced in: ${fileList}. These references are now broken.`,
            'OK',
          );
        }
      }
    }),
  );

  function computeRelPath(fromDir: string, toPath: string): string {
    const fromParts = fromDir ? fromDir.split('/') : [];
    const toParts = toPath.split('/');
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
      common++;
    }
    const ups = fromParts.length - common;
    const remaining = toParts.slice(common);
    const parts: string[] = [];
    for (let i = 0; i < ups; i++) parts.push('..');
    parts.push(...remaining);
    return parts.length === 0 ? toParts[toParts.length - 1] : parts.join('/');
  }

  // ── File watcher (debounced to batch rapid changes) ──

  const decoder = new TextDecoder();
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');

  // Global debounce for tree/sidebar refreshes triggered by watcher events.
  // Index updates happen immediately; only the UI refreshes are batched.
  let watcherRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let watcherNeedsFileExplorer = false;
  let watcherNeedsBacklinks = false;
  const scheduleWatcherRefresh = (opts: { fileExplorer?: boolean; backlinks?: boolean } = {}) => {
    if (opts.fileExplorer) watcherNeedsFileExplorer = true;
    if (opts.backlinks) watcherNeedsBacklinks = true;
    if (watcherRefreshTimer) clearTimeout(watcherRefreshTimer);
    watcherRefreshTimer = setTimeout(() => {
      tagTreeProvider.refresh();
      issuesProvider.refresh();
      assetsProvider.refresh();
      KiviEditorProvider.broadcastTagIndex();
      if (watcherNeedsBacklinks) { backlinksProvider.refresh(); watcherNeedsBacklinks = false; }
      if (watcherNeedsFileExplorer) { fileExplorerProvider.refresh(); watcherNeedsFileExplorer = false; }
    }, 400);
  };

  // Per-file debounce for onDidChange — only the last change matters
  const changeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  context.subscriptions.push(
    watcher.onDidCreate(async (uri) => {
      const name = uri.fsPath.split('/').pop();
      DevPanel.log('debug', 'watcher', `File created: ${name}`);
      KiviEditorProvider.updateNoteIndex(uri);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = decoder.decode(bytes);
        backlinksProvider.updateIndex(uri.fsPath, content);
        const fileTags = extractTags(content);
        for (const tag of fileTags) KiviEditorProvider.workspaceTags.add(tag);
        tagTreeProvider.updateIndex(uri.fsPath, fileTags);
      } catch { /* skip */ }
      scheduleWatcherRefresh({ fileExplorer: true });
    }),
    watcher.onDidChange((uri) => {
      const key = uri.toString();
      const existing = changeTimers.get(key);
      if (existing) clearTimeout(existing);
      changeTimers.set(key, setTimeout(async () => {
        changeTimers.delete(key);
        DevPanel.log('debug', 'watcher', `File changed: ${uri.fsPath.split('/').pop()}`);
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const content = decoder.decode(bytes);
          backlinksProvider.updateIndex(uri.fsPath, content);
          const fileTags = extractTags(content);
          for (const tag of fileTags) KiviEditorProvider.workspaceTags.add(tag);
          tagTreeProvider.updateIndex(uri.fsPath, fileTags);
        } catch { /* skip */ }
        scheduleWatcherRefresh();
      }, 300));
    }),
    watcher.onDidDelete((uri) => {
      const key = uri.toString();
      const pending = changeTimers.get(key);
      if (pending) { clearTimeout(pending); changeTimers.delete(key); }
      DevPanel.log('debug', 'watcher', `File deleted: ${uri.fsPath.split('/').pop()}`);
      KiviEditorProvider.removeFromNoteIndex(uri);
      backlinksProvider.removeFromIndex(uri.fsPath);
      tagTreeProvider.removeFile(uri.fsPath);
      scheduleWatcherRefresh({ fileExplorer: true, backlinks: true });
    }),
    watcher,
  );

  // ── Sidebar refresh commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('kivi.refreshFiles', () => fileExplorerProvider.refresh()),
    vscode.commands.registerCommand('kivi.collapseFiles', () => {
      vscode.commands.executeCommand('workbench.actions.treeView.kivi.files.collapseAll');
    }),
    vscode.commands.registerCommand('kivi.refreshOutline', () => outlineProvider.refresh()),
    vscode.commands.registerCommand('kivi.collapseOutline', () => outlineProvider.collapseAll()),
    vscode.commands.registerCommand('kivi.expandOutline', () => outlineProvider.expandAll()),
    vscode.commands.registerCommand('kivi.copyOutlineLink', (item: OutlineItem) => {
      if (!item) return;
      const slug = makeHeadingSlug(item.label);
      const link = `[${item.label}](#${slug})`;
      vscode.env.clipboard.writeText(link);
      vscode.window.showInformationMessage(`Copied: ${link}`);
    }),
    vscode.commands.registerCommand('kivi.collapseTags', () => {
      vscode.commands.executeCommand('workbench.actions.treeView.kivi.tags.collapseAll');
    }),
    vscode.commands.registerCommand('kivi.refreshBacklinks', () => backlinksProvider.refresh()),
  );

  // ── Track active editor for sidebar refresh (debounced) ──

  let sidebarRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefreshSidebars = () => {
    if (sidebarRefreshTimer) clearTimeout(sidebarRefreshTimer);
    sidebarRefreshTimer = setTimeout(() => {
      backlinksProvider.refresh();
      outlineProvider.refresh();
    }, 150);
  };

  let outlineRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefreshOutline = () => {
    if (outlineRefreshTimer) clearTimeout(outlineRefreshTimer);
    outlineRefreshTimer = setTimeout(() => {
      outlineProvider.refresh();
    }, 500);
  };

  // Consolidate tab/editor change listeners to avoid duplicate event handling
  let lastKiviFocused: boolean | undefined;
  const handleTabOrEditorChange = () => {
    debouncedRefreshSidebars();
    revealActiveFileInTree();
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const isKivi = !!activeTab && (activeTab.input as any)?.viewType === KiviEditorProvider.viewType;
    if (isKivi !== lastKiviFocused) {
      lastKiviFocused = isKivi;
      vscode.commands.executeCommand('setContext', 'kivi.editorFocused', isKivi);
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => handleTabOrEditorChange()),
    vscode.window.tabGroups.onDidChangeTabs(() => handleTabOrEditorChange()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        debouncedRefreshOutline();
      }
    }),
  );
}

export function deactivate() {}
