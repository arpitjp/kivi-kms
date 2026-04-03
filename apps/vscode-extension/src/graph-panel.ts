import * as vscode from 'vscode';
import { Vault } from '@kivi/vault';
import { getNonce } from './utils.js';

export class GraphPanel {
  private static instance: GraphPanel | undefined;
  private panel: vscode.WebviewPanel;
  private vault: Vault;
  private context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];

  static async open(context: vscode.ExtensionContext, focusNode?: string) {
    if (GraphPanel.instance) {
      GraphPanel.instance.panel.reveal(vscode.ViewColumn.Active);
      if (focusNode) {
        GraphPanel.instance.panel.webview.postMessage({ type: 'setFocus', focusNode });
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'kivi.graphView',
      'Kivi Graph',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
        ],
      },
    );

    new GraphPanel(panel, context, focusNode);
  }

  private initialFocusNode?: string;

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, focusNode?: string) {
    this.panel = panel;
    this.context = context;
    this.vault = new Vault();
    this.initialFocusNode = focusNode;
    GraphPanel.instance = this;

    panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
    panel.webview.html = this.getHtml(panel.webview);

    panel.onDidDispose(() => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      GraphPanel.instance = undefined;
      this.disposables.forEach((d) => d.dispose());
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        await this.indexWorkspace();
        this.sendGraphData();
      } else if (msg.type === 'openFile') {
        const uri = this.resolvePathToUri(msg.path);
        if (uri) {
          vscode.commands.executeCommand('vscode.openWith', uri, 'kivi.markdownEditor');
        }
      } else if (msg.type === 'closeGraph') {
        panel.dispose();
      }
    });

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');
    this.disposables.push(
      watcher.onDidChange(() => this.debouncedRefresh()),
      watcher.onDidCreate(() => this.debouncedRefresh()),
      watcher.onDidDelete(() => this.debouncedRefresh()),
      watcher,
    );
  }

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private debouncedRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      await this.indexWorkspace();
      this.sendGraphData();
    }, 500);
  }

  private async indexWorkspace() {
    const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 2000);
    const vault = new Vault();
    const decoder = new TextDecoder();
    const CONCURRENCY = 16;
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (uri) => {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const relativePath = vscode.workspace.asRelativePath(uri, false);
          vault.addFile(relativePath, decoder.decode(bytes));
        } catch { /* skip unreadable files */ }
      }));
    }
    this.vault = vault;
  }

  private sendGraphData() {
    const data = this.vault.getGraph();

    let focusNode: string | undefined = this.initialFocusNode;
    this.initialFocusNode = undefined;

    if (!focusNode) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.fileName.endsWith('.md')) {
        focusNode = vscode.workspace.asRelativePath(editor.document.uri, false);
      } else {
        const tabUri = (vscode.window.tabGroups.activeTabGroup.activeTab?.input as any)?.uri as vscode.Uri | undefined;
        if (tabUri && tabUri.fsPath.endsWith('.md')) {
          focusNode = vscode.workspace.asRelativePath(tabUri, false);
        }
      }
    }

    const tagIndex = this.vault.getTagIndex();
    const allTags: { tag: string; count: number }[] = [];
    for (const [tag, paths] of tagIndex) {
      if (!tag.includes('/')) allTags.push({ tag, count: paths.length });
    }
    allTags.sort((a, b) => b.count - a.count);

    const folderSet = new Map<string, number>();
    for (const [path] of this.vault.files) {
      const parts = path.split('/');
      if (parts.length > 1) {
        const folder = parts.slice(0, -1).join('/');
        folderSet.set(folder, (folderSet.get(folder) || 0) + 1);
      }
    }
    const allFolders = [...folderSet.entries()].map(([f, c]) => ({ folder: f, count: c }));
    allFolders.sort((a, b) => b.count - a.count);

    this.panel.webview.postMessage({
      type: 'graphData',
      data,
      focusNode,
      meta: {
        tags: allTags.slice(0, 50),
        folders: allFolders.slice(0, 50),
      },
    });
  }

  private resolvePathToUri(relativePath: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    return vscode.Uri.joinPath(folder.uri, relativePath);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'graph.js'),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Kivi Graph</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Main layout ── */
    .graph-body {
      display: flex;
      flex: 1;
      overflow: hidden;
      position: relative;
    }

    /* ── Floating toggle button (top-left) ── */
    .graph-sidebar-toggle {
      position: absolute;
      top: 8px;
      left: 8px;
      z-index: 30;
      background: var(--vscode-editorWidget-background, rgba(30,30,34,0.9));
      border: 1px solid var(--vscode-panel-border, #3c3c3c);
      border-radius: 5px;
      color: var(--vscode-descriptionForeground, #858585);
      cursor: pointer;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      backdrop-filter: blur(8px);
      transition: color 0.15s, background 0.15s;
    }
    .graph-sidebar-toggle:hover {
      color: var(--vscode-editor-foreground, #d4d4d4);
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }
    .graph-sidebar-toggle.active {
      color: var(--vscode-textLink-foreground, #4fc1ff);
    }

    /* ── Floating shortcut button (top-right) ── */
    .graph-shortcut-toggle {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 30;
      background: var(--vscode-editorWidget-background, rgba(30,30,34,0.9));
      border: 1px solid var(--vscode-panel-border, #3c3c3c);
      border-radius: 5px;
      color: var(--vscode-descriptionForeground, #858585);
      cursor: pointer;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      backdrop-filter: blur(8px);
      transition: color 0.15s, background 0.15s;
    }
    .graph-shortcut-toggle:hover {
      color: var(--vscode-editor-foreground, #d4d4d4);
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }

    /* ── Filter Sidebar ── */
    .graph-sidebar {
      width: 220px;
      min-width: 180px;
      max-width: 280px;
      border-right: 1px solid var(--vscode-panel-border, #333);
      background: var(--vscode-sideBar-background, #252526);
      overflow-y: auto;
      overflow-x: hidden;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      font-size: 11px;
    }
    .graph-sidebar.hidden { display: none; }
    .graph-sidebar::-webkit-scrollbar { width: 4px; }
    .graph-sidebar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

    /* Search in sidebar */
    .gs-search {
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    .gs-search-input {
      width: 100%;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #555);
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-family: inherit;
      outline: none;
    }
    .gs-search-input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
    .gs-search-results { max-height: 140px; overflow-y: auto; margin-top: 4px; }
    .gs-search-results:empty { display: none; }
    .gs-search-result {
      padding: 3px 6px; cursor: pointer; border-radius: 3px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 10px;
    }
    .gs-search-result:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }
    .gs-search-result b { color: var(--vscode-textLink-foreground, #4fc1ff); font-weight: 600; }

    /* Filter groups */
    .gs-group { border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a); }
    .gs-group-header {
      display: flex; align-items: center; padding: 6px 10px; cursor: pointer;
      user-select: none; font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--vscode-descriptionForeground, #888);
    }
    .gs-group-header:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.03)); }
    .gs-group-chevron { margin-right: 6px; font-size: 9px; transition: transform 0.15s; }
    .gs-group.collapsed .gs-group-chevron { transform: rotate(-90deg); }
    .gs-group-body { padding: 0 10px 6px; }
    .gs-group.collapsed .gs-group-body { display: none; }

    .gs-toggle {
      display: flex; align-items: center; gap: 6px; padding: 2px 0;
      cursor: pointer; font-size: 10px; color: var(--vscode-foreground, #ccc);
    }
    .gs-toggle:hover { color: var(--vscode-textLink-foreground, #4fc1ff); }
    .gs-toggle input[type="checkbox"] { accent-color: var(--vscode-textLink-foreground, #4fc1ff); margin: 0; }
    .gs-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .gs-line { width: 10px; height: 3px; border-radius: 1px; flex-shrink: 0; }
    .gs-count { margin-left: auto; font-size: 9px; color: var(--vscode-descriptionForeground, #666); }

    .gs-slider-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; }
    .gs-slider-row input[type="range"] { flex: 1; accent-color: var(--vscode-textLink-foreground, #4fc1ff); height: 4px; }
    .gs-slider-label { font-size: 10px; color: var(--vscode-descriptionForeground, #888); min-width: 16px; text-align: right; }

    .gs-reset {
      display: block; margin: 8px 10px; padding: 4px 10px;
      background: none; border: 1px solid var(--vscode-panel-border, #555);
      border-radius: 3px; font-size: 10px; color: var(--vscode-descriptionForeground, #888);
      cursor: pointer; font-family: inherit; text-align: center;
    }
    .gs-reset:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.05)); color: var(--vscode-foreground, #ccc); }

    /* ── Graph Container ── */
    #graph-container { flex: 1; position: relative; overflow: hidden; }
    #graph-container canvas { display: block; width: 100%; height: 100%; }

    /* ── Shortcuts overlay ── */
    .graph-shortcuts-overlay {
      display: none; position: fixed; bottom: 12px; right: 12px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-panel-border, #3c3c3c);
      border-radius: 6px; padding: 10px 14px; font-size: 11px;
      z-index: 50; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      color: var(--vscode-editor-foreground, #d4d4d4); line-height: 1.8;
    }
    .graph-shortcuts-overlay.visible { display: block; }
    .graph-shortcuts-overlay kbd {
      display: inline-block; background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff); border-radius: 3px;
      padding: 1px 5px; font-size: 10px; font-family: inherit; margin-right: 6px;
      min-width: 18px; text-align: center;
    }

    /* ── Graph Tooltip ── */
    .kivi-graph-tooltip {
      position: absolute; display: none; padding: 0;
      background: var(--vscode-editorWidget-background, rgba(24, 24, 28, 0.92));
      color: var(--vscode-editor-foreground, #d4d4d4);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      font-size: 11px; border-radius: 8px; pointer-events: none; cursor: default;
      z-index: 10; border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.07));
      box-shadow: 0 8px 24px rgba(0,0,0,0.4); max-width: 260px; min-width: 160px;
      overflow: hidden; opacity: 0; transform: translateY(4px) scale(0.97);
      transition: opacity 0.15s ease, transform 0.15s ease;
    }
    .kivi-graph-tooltip.visible { opacity: 1; transform: translateY(0) scale(1); }
    .gtt-title { padding: 10px 12px 0; font-size: 12px; font-weight: 600; line-height: 1.3; }
    .gtt-type { display: inline-block; font-size: 9px; font-weight: 500; border-radius: 3px; padding: 1px 5px; margin-left: 6px; vertical-align: middle; }
    .gtt-type-tag { background: rgba(78,201,176,0.2); color: #4ec9b0; }
    .gtt-type-folder { background: rgba(220,220,170,0.2); color: #dcdcaa; }
    .gtt-type-unresolved { background: rgba(209,105,105,0.2); color: #d16969; }
    .gtt-type-asset { background: rgba(206,145,120,0.2); color: #ce9178; }
    .gtt-tags { padding: 4px 12px 0; display: flex; flex-wrap: wrap; gap: 4px; }
    .gtt-tag { font-size: 10px; color: var(--vscode-textLink-foreground, #4fc1ff); opacity: 0.7; }
    .gtt-stats { padding: 6px 12px 0; font-size: 10px; color: var(--vscode-descriptionForeground, #888); }
    .gtt-relation { padding: 4px 12px 0; font-size: 10px; color: var(--vscode-descriptionForeground, #888); opacity: 0.7; font-style: italic; }
    .gtt-outline-wrap { margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); max-height: 200px; overflow-y: auto; padding: 6px 0; }
    .gtt-outline-wrap::-webkit-scrollbar { width: 3px; }
    .gtt-outline-wrap::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
    .gtt-outline { padding: 0 8px; }
    .gtt-heading { font-size: 10px; line-height: 1.7; color: var(--vscode-descriptionForeground, #999); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; border-radius: 3px; padding: 1px 4px; transition: background 0.1s, color 0.1s; }
    .gtt-heading:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); color: var(--vscode-foreground, #ccc); }
    .gtt-h-marker { color: var(--vscode-descriptionForeground, #666); opacity: 0.4; font-size: 9px; margin-right: 3px; }
    .gtt-stats:last-child, .gtt-relation:last-child, .gtt-tags:last-child, .gtt-title:last-child { padding-bottom: 10px; }

    /* ── Detail panel ── */
    .kivi-graph-detail {
      display: none; position: absolute; bottom: 12px; left: 12px;
      width: 280px; max-height: 360px; overflow-y: auto;
      background: var(--vscode-editorWidget-background, rgba(30, 30, 34, 0.95));
      color: var(--vscode-editor-foreground, #d4d4d4); backdrop-filter: blur(16px);
      font-size: 11px; border-radius: 8px;
      border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
      box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 20; pointer-events: auto;
      opacity: 0; transform: translateY(4px); transition: opacity 0.15s ease, transform 0.15s ease;
    }
    .kivi-graph-detail.visible { opacity: 1; transform: translateY(0); }
    .gtt-actions { padding: 8px 12px 10px; border-top: 1px solid rgba(255,255,255,0.06); }
    .gtt-open-btn {
      background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 4px; padding: 4px 12px; font-size: 11px; cursor: pointer; font-family: inherit;
    }
    .gtt-open-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }

    /* ── Status bar ── */
    .graph-statusbar {
      display: flex; align-items: center; padding: 2px 10px; gap: 12px;
      font-size: 10px; color: var(--vscode-descriptionForeground, #888);
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      border-top: 1px solid var(--vscode-panel-border, #333); flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="graph-body">
    <!-- Floating sidebar toggle (top-left) -->
    <button class="graph-sidebar-toggle" id="graph-sidebar-toggle" title="Toggle filters (⌘F)">☰</button>
    <button class="graph-shortcut-toggle" id="graph-shortcut-toggle" title="Keyboard shortcuts">⌨</button>

    <!-- Filter Sidebar (hidden by default) -->
    <div class="graph-sidebar hidden" id="graph-sidebar">
      <div class="gs-search">
        <input type="text" class="gs-search-input" id="graph-filter" placeholder="Search nodes... (⌘F)" autocomplete="off" />
        <div class="gs-search-results" id="gs-search-results"></div>
      </div>

      <div class="gs-group" id="gs-node-types">
        <div class="gs-group-header"><span class="gs-group-chevron">▾</span> Node Types</div>
        <div class="gs-group-body">
          <label class="gs-toggle"><input type="checkbox" checked data-ntype="note" /><span class="gs-dot" style="background:#4fc1ff"></span> Notes <span class="gs-count" id="gs-count-note">0</span></label>
          <label class="gs-toggle"><input type="checkbox" data-ntype="tag" /><span class="gs-dot" style="background:#4ec9b0"></span> Tags <span class="gs-count" id="gs-count-tag">0</span></label>
          <label class="gs-toggle"><input type="checkbox" data-ntype="folder" /><span class="gs-dot" style="background:#dcdcaa"></span> Folders <span class="gs-count" id="gs-count-folder">0</span></label>
          <label class="gs-toggle"><input type="checkbox" data-ntype="unresolved" /><span class="gs-dot" style="background:#d16969"></span> Unresolved <span class="gs-count" id="gs-count-unresolved">0</span></label>
          <label class="gs-toggle"><input type="checkbox" data-ntype="asset" /><span class="gs-dot" style="background:#ce9178"></span> Assets <span class="gs-count" id="gs-count-asset">0</span></label>
        </div>
      </div>

      <div class="gs-group" id="gs-edge-types">
        <div class="gs-group-header"><span class="gs-group-chevron">▾</span> Edge Types</div>
        <div class="gs-group-body">
          <label class="gs-toggle"><input type="checkbox" checked data-etype="link" /><span class="gs-line" style="background:#4fc1ff"></span> Links</label>
          <label class="gs-toggle"><input type="checkbox" checked data-etype="backlink" /><span class="gs-line" style="background:#4fc1ff"></span> Backlinks</label>
          <label class="gs-toggle"><input type="checkbox" data-etype="parent" /><span class="gs-line" style="background:#a8b4c8"></span> Parent</label>
          <label class="gs-toggle"><input type="checkbox" data-etype="shared-tag" /><span class="gs-line" style="background:#4ec9b0"></span> Shared Tag</label>
          <label class="gs-toggle"><input type="checkbox" data-etype="sibling" /><span class="gs-line" style="background:#c586c0"></span> Sibling</label>
          <label class="gs-toggle"><input type="checkbox" data-etype="shared-folder" /><span class="gs-line" style="background:#dcdcaa"></span> Shared Folder</label>
          <label class="gs-toggle"><input type="checkbox" data-etype="tag-link" /><span class="gs-line" style="background:#4ec9b0"></span> Tag Link</label>
          <label class="gs-toggle"><input type="checkbox" data-etype="unresolved" /><span class="gs-line" style="background:#d16969"></span> Unresolved</label>
          <label class="gs-toggle"><input type="checkbox" data-etype="asset-ref" /><span class="gs-line" style="background:#ce9178"></span> Asset Ref</label>
        </div>
      </div>

      <div class="gs-group" id="gs-depth">
        <div class="gs-group-header"><span class="gs-group-chevron">▾</span> Depth (Local)</div>
        <div class="gs-group-body">
          <div class="gs-slider-row">
            <input type="range" min="1" max="5" value="2" id="gs-depth-slider" />
            <span class="gs-slider-label" id="gs-depth-label">2</span>
          </div>
        </div>
      </div>

      <div class="gs-group" id="gs-quick-filters">
        <div class="gs-group-header"><span class="gs-group-chevron">▾</span> Quick Filters</div>
        <div class="gs-group-body">
          <label class="gs-toggle"><input type="checkbox" id="gs-orphans-only" /> Orphans only</label>
          <div class="gs-slider-row">
            <span style="font-size:10px;color:var(--vscode-descriptionForeground);">Min backlinks</span>
            <input type="range" min="0" max="20" value="0" id="gs-min-backlinks" />
            <span class="gs-slider-label" id="gs-min-backlinks-label">0</span>
          </div>
        </div>
      </div>

      <div class="gs-group collapsed" id="gs-tags-filter">
        <div class="gs-group-header"><span class="gs-group-chevron">▾</span> Tags</div>
        <div class="gs-group-body" id="gs-tags-list"></div>
      </div>

      <div class="gs-group collapsed" id="gs-folders-filter">
        <div class="gs-group-header"><span class="gs-group-chevron">▾</span> Folders</div>
        <div class="gs-group-body" id="gs-folders-list"></div>
      </div>

      <button class="gs-reset" id="gs-reset">Reset All Filters</button>
    </div>

    <div id="graph-container"></div>
  </div>

  <div class="graph-statusbar" id="graph-statusbar">
    <span id="gs-status-nodes">0 nodes</span>
    <span id="gs-status-edges">0 edges</span>
  </div>

  <div class="graph-shortcuts-overlay" id="graph-shortcuts">
    <div><kbd>⌘F</kbd> Search nodes</div>
    <div><kbd>F</kbd> Fit to view</div>
    <div><kbd>C</kbd> Center on focus</div>
    <div><kbd>0</kbd> Reset zoom</div>
    <div><kbd>+</kbd><kbd>-</kbd> Zoom in / out</div>
    <div><kbd>Tab</kbd> Cycle nodes</div>
    <div><kbd>Enter</kbd> Open node</div>
    <div><kbd>Esc</kbd> Clear selection</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

