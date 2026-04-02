import * as vscode from 'vscode';
import { KiviEditorProvider } from './editor-provider.js';
import { BacklinksProvider } from './backlinks-provider.js';
import { FileExplorerProvider } from './file-explorer-provider.js';
import { OutlineProvider } from './outline-provider.js';
import { TagTreeProvider } from './tag-tree-provider.js';
import { GraphPanel } from './graph-panel.js';
import { getActiveMarkdownUri } from './utils.js';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(KiviEditorProvider.register(context));

  vscode.commands.executeCommand('setContext', 'hasCustomMarkdownPreview', true);
  vscode.commands.executeCommand('setContext', 'kivi.isActive', true);

  // ── Default editor setting ──

  const applyDefaultEditorSetting = () => {
    const cfg = vscode.workspace.getConfiguration('kivi');
    const isDefault = cfg.get<boolean>('defaultEditor', true);
    const wbCfg = vscode.workspace.getConfiguration('workbench');
    const assoc = wbCfg.get<Record<string, string>>('editorAssociations') ?? {};

    if (isDefault) {
      if (assoc['*.md'] !== KiviEditorProvider.viewType) {
        wbCfg.update('editorAssociations', { ...assoc, '*.md': KiviEditorProvider.viewType }, vscode.ConfigurationTarget.Global);
      }
    } else {
      if (assoc['*.md'] === KiviEditorProvider.viewType) {
        const updated = { ...assoc };
        delete updated['*.md'];
        wbCfg.update('editorAssociations', updated, vscode.ConfigurationTarget.Global);
      }
    }
  };
  applyDefaultEditorSetting();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('kivi.defaultEditor')) applyDefaultEditorSetting();
    }),
  );

  const getActiveUri = (): vscode.Uri | undefined =>
    vscode.window.activeTextEditor?.document.uri
    ?? (vscode.window.tabGroups.activeTabGroup.activeTab?.input as any)?.uri;

  // ── Core commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('kivi.openInKivi', (uri?: vscode.Uri) => {
      const target = uri ?? getActiveUri();
      if (target) vscode.commands.executeCommand('vscode.openWith', target, KiviEditorProvider.viewType);
    }),

    vscode.commands.registerCommand('kivi.openWithTextEditor', (uri?: vscode.Uri) => {
      const target = uri ?? getActiveUri();
      if (target) vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),

    vscode.commands.registerCommand('kivi.openToSide', (uri?: vscode.Uri) => {
      const target = uri ?? getActiveUri();
      if (target) {
        vscode.commands.executeCommand('vscode.openWith', target, KiviEditorProvider.viewType, vscode.ViewColumn.Beside);
      }
    }),

    vscode.commands.registerCommand('kivi.revealInExplorer', () => {
      const uri = getActiveUri();
      if (uri) vscode.commands.executeCommand('revealInExplorer', uri);
    }),

    vscode.commands.registerCommand('kivi.openGraph', () => GraphPanel.open(context)),
    vscode.commands.registerCommand('kivi.openGraphGlobal', () => GraphPanel.open(context)),

    vscode.commands.registerCommand('kivi.setDefaultEditor', () => {
      vscode.workspace.getConfiguration('kivi').update('defaultEditor', true, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Kivi is now the default Markdown editor.');
    }),

    vscode.commands.registerCommand('kivi.removeDefaultEditor', () => {
      vscode.workspace.getConfiguration('kivi').update('defaultEditor', false, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Kivi is no longer the default Markdown editor.');
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
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kivi.files', fileExplorerProvider),
  );

  // ── Outline view ──

  const outlineProvider = new OutlineProvider();
  const outlineView = vscode.window.createTreeView('kivi.outline', {
    treeDataProvider: outlineProvider,
  });
  context.subscriptions.push(outlineView);

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
    KiviEditorProvider.broadcastTagIndex();
  };

  // Defer indexing generously on startup — the first file open should be instant.
  setTimeout(() => indexWorkspace(), 3000);

  // ── Auto-fix wiki-links on rename (concurrency-limited) ──

  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (e) => {
      for (const { oldUri, newUri } of e.files) {
        if (!oldUri.fsPath.endsWith('.md') && !newUri.fsPath.endsWith('.md')) continue;
        const oldRel = vscode.workspace.asRelativePath(oldUri, false);
        const newRel = vscode.workspace.asRelativePath(newUri, false);
        const oldName = oldRel.replace(/\.md$/, '').split('/').pop() || '';
        const newName = newRel.replace(/\.md$/, '').split('/').pop() || '';
        if (oldName === newName) continue;

        const mdFiles = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 2000);
        const dec = new TextDecoder();
        for (let i = 0; i < mdFiles.length; i += CONCURRENCY) {
          const batch = mdFiles.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (file) => {
            try {
              const bytes = await vscode.workspace.fs.readFile(file);
              const content = dec.decode(bytes);
              const wikiPattern = new RegExp(`\\[\\[${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`, 'g');
              if (wikiPattern.test(content)) {
                wikiPattern.lastIndex = 0;
                const updated = content.replace(wikiPattern, `[[${newName}$1]]`);
                await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(updated));
              }
            } catch { /* skip */ }
          }));
        }
      }
    }),
  );

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
      KiviEditorProvider.broadcastTagIndex();
      if (watcherNeedsBacklinks) { backlinksProvider.refresh(); watcherNeedsBacklinks = false; }
      if (watcherNeedsFileExplorer) { fileExplorerProvider.refresh(); watcherNeedsFileExplorer = false; }
    }, 400);
  };

  // Per-file debounce for onDidChange — only the last change matters
  const changeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  context.subscriptions.push(
    watcher.onDidCreate(async (uri) => {
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
      // Cancel any pending change timer for this file
      const key = uri.toString();
      const pending = changeTimers.get(key);
      if (pending) { clearTimeout(pending); changeTimers.delete(key); }
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

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => debouncedRefreshSidebars()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => debouncedRefreshSidebars()),
    vscode.window.tabGroups.onDidChangeTabs(() => debouncedRefreshSidebars()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        debouncedRefreshOutline();
      }
    }),
  );

  // ── Set context when webview is active ──

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const isKivi = activeTab && (activeTab.input as any)?.viewType === KiviEditorProvider.viewType;
      vscode.commands.executeCommand('setContext', 'kivi.editorFocused', !!isKivi);
    }),
  );
}

export function deactivate() {}
