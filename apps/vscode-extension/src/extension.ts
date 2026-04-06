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
import { getActiveMarkdownUri, getTabUri, getTabViewType, computeRelativePathFromDoc, resolveDocRelativeFolder } from './utils.js';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(KiviEditorProvider.register(context));

  vscode.commands.executeCommand('setContext', 'kivi.isActive', true);
  vscode.commands.executeCommand('setContext', 'kivi.hasCustomMarkdownPreview', true);

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
  // Writes editorAssociations at the same scope the user configured kivi.defaultEditor.
  // If the workspace already has its own association for *.md, we respect that and only
  // touch the global setting — the workspace value wins in VS Code's merge order anyway.

  const applyDefaultEditorSetting = () => {
    const cfg = vscode.workspace.getConfiguration('kivi');
    const isDefault = cfg.get<boolean>('defaultEditor', true);
    const wbCfg = vscode.workspace.getConfiguration('workbench');
    const inspection = cfg.inspect<boolean>('defaultEditor');
    const assoc = wbCfg.get<Record<string, string>>('editorAssociations') ?? {};
    const assocInspection = wbCfg.inspect<Record<string, string>>('editorAssociations');
    const patterns = ['*.md', '*.markdown'];

    // Determine which scope to write to: match whatever scope kivi.defaultEditor lives at.
    const hasWorkspaceValue = inspection?.workspaceValue !== undefined;
    const target = hasWorkspaceValue
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    if (isDefault) {
      // If there's a workspace-level editorAssociations pointing to a *different* custom
      // editor (not the built-in text editor), and kivi.defaultEditor is only global,
      // don't overwrite — the user chose that editor for this workspace on purpose.
      if (!hasWorkspaceValue && assocInspection?.workspaceValue) {
        const wsAssoc = assocInspection.workspaceValue;
        for (const pat of patterns) {
          const wsVal = wsAssoc[pat];
          if (wsVal && wsVal !== KiviEditorProvider.viewType && wsVal !== 'default') {
            DevPanel.log('info', 'config',
              `Workspace editorAssociations[${pat}]=${wsVal} — not overwriting from global kivi.defaultEditor`);
            return;
          }
        }
      }

      let needsUpdate = false;
      const updated = { ...assoc };
      for (const pat of patterns) {
        if (updated[pat] !== KiviEditorProvider.viewType) {
          updated[pat] = KiviEditorProvider.viewType;
          needsUpdate = true;
        }
      }
      if (needsUpdate) {
        wbCfg.update('editorAssociations', updated, target);
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
        wbCfg.update('editorAssociations', updated, target);
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
    ?? getTabUri(vscode.window.tabGroups.activeTabGroup.activeTab);

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
        const uriWsFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!uriWsFolder) {
          const rootFolder = (docUri ? vscode.workspace.getWorkspaceFolder(docUri) : undefined)
            ?? vscode.workspace.workspaceFolders?.[0];
          if (rootFolder) {
            const cfg = vscode.workspace.getConfiguration('kivi');
            const destDirName = (fileType === 'file' && /\.md$/i.test(ext))
              ? cfg.get<string>('folders.pages', 'pages')
              : cfg.get<string>('folders.assets', 'assets');
            const destFolder = docUri
              ? resolveDocRelativeFolder(docUri, destDirName)
              : vscode.Uri.joinPath(rootFolder.uri, destDirName);
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
      const activeUri = getActiveUri();
      const wsFolder = (activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined)
        ?? vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }
      const defaultName = `diagram-${Date.now()}`;
      const rawName = await vscode.window.showInputBox({
        prompt: 'Excalidraw file name (leave blank for auto)',
        value: 'diagram',
        placeHolder: defaultName,
      });
      if (rawName === undefined) return;
      const baseName = rawName.trim() || defaultName;
      const fileName = baseName.endsWith('.excalidraw') ? baseName : `${baseName}.excalidraw`;

      const cfg = vscode.workspace.getConfiguration('kivi');
      const assetsFolder = cfg.get<string>('folders.assets', 'assets');
      const mdUri = getActiveMarkdownUri();
      const assetsDir = mdUri
        ? resolveDocRelativeFolder(mdUri, assetsFolder)
        : vscode.Uri.joinPath(wsFolder.uri, assetsFolder);
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

  // ── Find / Blame commands (keybinding → webview message) ──

  const postToActivePanel = (msg: Record<string, unknown>) => {
    const panel = KiviEditorProvider.getActivePanel();
    if (panel) panel.webview.postMessage(msg);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('kivi.find', () => postToActivePanel({ type: 'find' })),
    vscode.commands.registerCommand('kivi.findReplace', () => postToActivePanel({ type: 'findReplace' })),
    vscode.commands.registerCommand('kivi.toggleBlame', () => postToActivePanel({ type: 'toggleBlame' })),
  );

  // ── Create page (palette + slash) ──

  context.subscriptions.push(
    vscode.commands.registerCommand('kivi.createPage', async () => {
      const mdUri = getActiveMarkdownUri();
      const wsFolder = (mdUri ? vscode.workspace.getWorkspaceFolder(mdUri) : undefined)
        ?? vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Page name',
        placeHolder: 'my-page',
        validateInput: (v) => v.trim() ? null : 'Name is required',
      });
      if (!name) return;
      const safeName = name.trim().replace(/[<>:"/\\|?*]/g, '');
      const fileName = safeName.endsWith('.md') ? safeName : `${safeName}.md`;

      const cfg = vscode.workspace.getConfiguration('kivi');
      const pagesFolder = cfg.get<string>('folders.pages', 'pages');
      const folderUri = mdUri
        ? resolveDocRelativeFolder(mdUri, pagesFolder)
        : vscode.Uri.joinPath(wsFolder.uri, pagesFolder);
      try { await vscode.workspace.fs.createDirectory(folderUri); } catch { /* exists */ }

      const fileUri = vscode.Uri.joinPath(folderUri, fileName);
      try {
        await vscode.workspace.fs.stat(fileUri);
        vscode.window.showInformationMessage(`Page "${fileName}" already exists.`);
      } catch {
        const heading = safeName.replace(/\.md$/, '');
        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(`# ${heading}\n\n`));
      }
      await vscode.commands.executeCommand('vscode.openWith', fileUri, 'kivi.markdownEditor');

      if (mdUri) {
        const panel = KiviEditorProvider.getPanelForUri(mdUri.toString());
        if (panel) {
          const relPath = computeRelativePathFromDoc(mdUri, fileUri);
          const label = safeName.replace(/\.md$/, '');
          panel.webview.postMessage({ type: 'insertLink', path: relPath, label });
        }
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

      // Resolve the active file URI from any source:
      // 1. Custom editor tab (Kivi, Excalidraw, etc.)
      // 2. Regular text editor
      let activeUri: vscode.Uri | undefined;
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = activeTab?.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri) {
        activeUri = input.uri;
      } else if (vscode.window.activeTextEditor) {
        activeUri = vscode.window.activeTextEditor.document.uri;
      }

      if (!activeUri) return;
      const fsPath = activeUri.fsPath;
      if (!fsPath.endsWith('.md') && !fsPath.endsWith('.markdown')) return;

      const node = fileExplorerProvider.findNodeByUri(activeUri)
        ?? await fileExplorerProvider.resolveNodeByPath(activeUri);
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
        });
      }
    }),
  );

  // ── Tag completion in native VS Code editors ──
  // Scoped to markdown and plaintext to avoid polluting unrelated languages
  // (e.g. CSS where # is an ID selector, or TypeScript where # is a private field).
  const tagCompletionSelector: vscode.DocumentSelector = [
    { language: 'markdown', scheme: 'file' },
    { language: 'plaintext', scheme: 'file' },
    { language: 'yaml', scheme: 'file' },
    { language: 'python', scheme: 'file' },
  ];
  const tagCompletionProvider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position) {
      const lineText = document.lineAt(position).text;
      const textBefore = lineText.substring(0, position.character);
      const match = textBefore.match(/(?:^|\s)#([a-zA-Z0-9_/\-]*)$/);
      if (!match) return undefined;

      const query = match[1].toLowerCase();
      const replaceStart = position.character - match[1].length;
      const range = new vscode.Range(position.line, replaceStart, position.line, position.character);
      const tags = Array.from(KiviEditorProvider.workspaceTags);

      const results: vscode.CompletionItem[] = [];
      for (const tag of tags) {
        const tLower = tag.toLowerCase();
        if (query && !tLower.includes(query)) {
          let qi = 0;
          for (let ti = 0; ti < tLower.length && qi < query.length; ti++) {
            if (tLower[ti] === query[qi]) qi++;
          }
          if (qi < query.length) continue;
        }
        const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Reference);
        item.insertText = tag;
        item.range = range;
        item.detail = 'Kivi tag';
        item.filterText = tag;
        item.sortText = `0_${tag}`;
        results.push(item);
        if (results.length >= 20) break;
      }
      return results;
    },
  };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(tagCompletionSelector, tagCompletionProvider, '#'),
  );

  // ── Issues view ──

  const issuesProvider = new IssuesProvider();
  const issuesView = vscode.window.createTreeView('kivi.issues', {
    treeDataProvider: issuesProvider,
  });
  context.subscriptions.push(
    issuesView,
    vscode.commands.registerCommand('kivi.refreshIssues', () => issuesProvider.refresh()),
    vscode.commands.registerCommand('kivi.scanIssues', async () => {
      issuesProvider.refresh();
      await vscode.commands.executeCommand('kivi.issues.focus');
      vscode.window.showInformationMessage('Kivi: Scanning for broken links and orphan assets…');
    }),
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
  const C_PREPROC = new Set([
    'include', 'define', 'undef', 'ifdef', 'ifndef', 'if', 'else',
    'elif', 'endif', 'error', 'warning', 'pragma', 'line',
  ]);
  const TAG_GLOB = '**/*.{md,markdown,txt,py,js,ts,jsx,tsx,go,rs,rb,java,c,cpp,h,hpp,cs,swift,kt,sh,bash,zsh,yaml,yml,toml,sql,lua,r,pl,ex,exs,hs,ml}';

  function extractTags(content: string, isMd = false): string[] {
    const tags: string[] = [];
    let inFence = false;
    for (const line of content.split('\n')) {
      if (isMd && /^```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      TAG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TAG_RE.exec(line)) !== null) {
        const tag = m[1];
        if (C_PREPROC.has(tag)) continue;
        if (tag.length < 2) continue;
        tags.push(tag);
      }
    }
    return tags;
  }

  const indexWorkspace = async () => {
    const files = await vscode.workspace.findFiles(TAG_GLOB, '**/node_modules/**', 3000);
    const decoder = new TextDecoder();

    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (uri) => {
        try {
          const ext = uri.fsPath.split('.').pop()?.toLowerCase() ?? '';
          const isMd = ext === 'md' || ext === 'markdown';
          if (isMd) KiviEditorProvider.updateNoteIndex(uri);
          const bytes = await vscode.workspace.fs.readFile(uri);
          const content = decoder.decode(bytes);
          if (isMd) backlinksProvider.updateIndex(uri.fsPath, content, true);
          const fileTags = extractTags(content, isMd);
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
  setTimeout(() => indexWorkspace()
    .then(() => DevPanel.perf('workspace-index', 'end'))
    .catch(err => console.error('[kivi] indexWorkspace failed:', err)), 3000);

  // ── Auto-fix references on rename/move (wiki-links, markdown links, image refs) ──

  // Use WorkspaceEdit for cross-file reference updates so VS Code serializes them
  // with edits from other extensions (Foam, Dendron, etc.) and supports undo.
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (e) => {
      const dec = new TextDecoder();
      const mdFiles = await vscode.workspace.findFiles('**/*.{md,markdown}', '**/node_modules/**', 5000);

      const wsEdit = new vscode.WorkspaceEdit();
      let editCount = 0;

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
              const originalContent = content;

              // 1. Wiki-links: [[oldName]] or [[oldName|alias]]
              if (isMd && oldName !== newName) {
                const wikiPattern = new RegExp(
                  `\\[\\[${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`, 'g',
                );
                if (wikiPattern.test(content)) {
                  wikiPattern.lastIndex = 0;
                  content = content.replace(wikiPattern, `[[${newName}$1]]`);
                }
              }

              // 2. Markdown links and images: [text](path) and ![alt](path)
              const fileRel = vscode.workspace.asRelativePath(file, false);
              const fileDir = fileRel.includes('/') ? fileRel.slice(0, fileRel.lastIndexOf('/')) : '';
              const oldRelFromFile = computeRelPath(fileDir, oldRel);
              const newRelFromFile = computeRelPath(fileDir, newRel);

              if (oldRelFromFile !== newRelFromFile) {
                const escaped = oldRelFromFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const linkPattern = new RegExp(
                  `(!?\\[[^\\]]*\\])\\(${escaped}\\)`, 'g',
                );
                if (linkPattern.test(content)) {
                  linkPattern.lastIndex = 0;
                  content = content.replace(linkPattern, `$1(${newRelFromFile})`);
                }

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
                  }
                }
              }

              if (content !== originalContent) {
                const doc = await vscode.workspace.openTextDocument(file);
                const fullRange = new vscode.Range(
                  doc.positionAt(0),
                  doc.positionAt(doc.getText().length),
                );
                wsEdit.replace(file, fullRange, content);
                editCount++;
              }
            } catch { /* skip unreadable files */ }
          }));
        }
      }

      if (editCount > 0) {
        await vscode.workspace.applyEdit(wsEdit);
        DevPanel.log('info', 'rename', `Updated references in ${editCount} file(s)`);
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
  const mdWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');
  const tagWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{txt,py,js,ts,jsx,tsx,go,rs,rb,java,c,cpp,h,hpp,cs,swift,kt,sh,bash,zsh,yaml,yml,toml,sql,lua,r,pl,ex,exs,hs,ml}',
  );

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
      // Rebuild workspaceTags from the authoritative tag index so stale tags are pruned
      const freshTags = tagTreeProvider.getAllTags();
      KiviEditorProvider.workspaceTags.clear();
      for (const t of freshTags) KiviEditorProvider.workspaceTags.add(t);

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

  function handleFileCreateOrChange(uri: vscode.Uri, isCreate: boolean) {
    const ext = uri.fsPath.split('.').pop()?.toLowerCase() ?? '';
    const isMd = ext === 'md' || ext === 'markdown';

    const doWork = async () => {
      DevPanel.log('debug', 'watcher', `File ${isCreate ? 'created' : 'changed'}: ${uri.fsPath.split('/').pop()}`);
      if (isMd) KiviEditorProvider.updateNoteIndex(uri);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = decoder.decode(bytes);
        if (isMd) backlinksProvider.updateIndex(uri.fsPath, content, !isCreate);
        const fileTags = extractTags(content, isMd);
        for (const tag of fileTags) KiviEditorProvider.workspaceTags.add(tag);
        tagTreeProvider.updateIndex(uri.fsPath, fileTags);
      } catch { /* skip */ }
      scheduleWatcherRefresh(isCreate ? { fileExplorer: isMd } : {});
    };

    if (isCreate) {
      doWork();
    } else {
      const key = uri.toString();
      const existing = changeTimers.get(key);
      if (existing) clearTimeout(existing);
      changeTimers.set(key, setTimeout(() => { changeTimers.delete(key); doWork(); }, 300));
    }
  }

  function handleFileDelete(uri: vscode.Uri) {
    const key = uri.toString();
    const pending = changeTimers.get(key);
    if (pending) { clearTimeout(pending); changeTimers.delete(key); }
    const ext = uri.fsPath.split('.').pop()?.toLowerCase() ?? '';
    const isMd = ext === 'md' || ext === 'markdown';
    DevPanel.log('debug', 'watcher', `File deleted: ${uri.fsPath.split('/').pop()}`);
    if (isMd) {
      KiviEditorProvider.removeFromNoteIndex(uri);
      backlinksProvider.removeFromIndex(uri.fsPath);
    }
    tagTreeProvider.removeFile(uri.fsPath);
    scheduleWatcherRefresh(isMd ? { fileExplorer: true, backlinks: true } : {});
  }

  context.subscriptions.push(
    mdWatcher.onDidCreate((uri) => handleFileCreateOrChange(uri, true)),
    mdWatcher.onDidChange((uri) => handleFileCreateOrChange(uri, false)),
    mdWatcher.onDidDelete((uri) => handleFileDelete(uri)),
    mdWatcher,
    tagWatcher.onDidCreate((uri) => handleFileCreateOrChange(uri, true)),
    tagWatcher.onDidChange((uri) => handleFileCreateOrChange(uri, false)),
    tagWatcher.onDidDelete((uri) => handleFileDelete(uri)),
    tagWatcher,
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
    const isKivi = !!activeTab && getTabViewType(activeTab) === KiviEditorProvider.viewType;
    if (isKivi !== lastKiviFocused) {
      lastKiviFocused = isKivi;
      vscode.commands.executeCommand('setContext', 'kivi.editorFocused', isKivi);
    }
  };

  // Reveal when the files tree becomes visible (e.g. user clicks the sidebar)
  context.subscriptions.push(
    filesView.onDidChangeVisibility((e) => {
      if (e.visible) revealActiveFileInTree();
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => handleTabOrEditorChange()),
    vscode.window.tabGroups.onDidChangeTabs(() => handleTabOrEditorChange()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        debouncedRefreshOutline();
      }
    }),
  );

  // ── Untitled markdown file support ──
  // VS Code custom editors match by filename pattern, so untitled files (no .md extension)
  // won't get the Kivi editor. When the user sets language mode to markdown on an untitled
  // file, offer to save it as .md so Kivi can open it.
  const promptedUntitled = new Set<string>();
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === 'untitled' && doc.languageId === 'markdown' && !promptedUntitled.has(doc.uri.toString())) {
        promptedUntitled.add(doc.uri.toString());
        promptSaveAsMarkdown(doc);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed) return;
      const doc = ed.document;
      if (doc.uri.scheme === 'untitled' && doc.languageId === 'markdown' && !promptedUntitled.has(doc.uri.toString())) {
        promptedUntitled.add(doc.uri.toString());
        promptSaveAsMarkdown(doc);
      }
    }),
  );

  async function promptSaveAsMarkdown(doc: vscode.TextDocument) {
    const cfg = vscode.workspace.getConfiguration('kivi');
    if (!cfg.get<boolean>('defaultEditor', true)) return;

    const action = await vscode.window.showInformationMessage(
      'Save this file as .md to open it in Kivi.',
      'Save as .md',
      'Dismiss',
    );
    if (action !== 'Save as .md') return;

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const defaultUri = wsFolder
      ? vscode.Uri.joinPath(wsFolder.uri, 'untitled.md')
      : undefined;

    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'Markdown': ['md', 'markdown'] },
    });
    if (!target) return;

    const content = doc.getText();
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('vscode.openWith', target, KiviEditorProvider.viewType);
  }
}

export function deactivate() {
  vscode.commands.executeCommand('setContext', 'kivi.isActive', false);
  vscode.commands.executeCommand('setContext', 'kivi.hasCustomMarkdownPreview', false);
  vscode.commands.executeCommand('setContext', 'kivi.editorFocused', false);
  vscode.commands.executeCommand('setContext', 'kivi.devMode', false);
}
