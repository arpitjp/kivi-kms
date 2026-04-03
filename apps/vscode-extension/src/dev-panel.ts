import * as vscode from 'vscode';
import { KiviEditorProvider } from './editor-provider.js';
import { getNonce } from './utils.js';

interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug' | 'perf';
  source: string;
  message: string;
  data?: unknown;
}

const MAX_BUFFERED_LOGS = 500;
const TRIM_TO = 400;

export class DevPanel {
  private static instance: DevPanel | undefined;

  /** Master switch — set once at activation, controls whether log/perf do anything. */
  private static _enabled = false;

  /** Ring buffer: logs accumulate even when the panel isn't open. */
  private static logs: LogEntry[] = [];
  private static perfMarks = new Map<string, number>();
  private static startTime = Date.now();

  private panel: vscode.WebviewPanel;
  private context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];

  // ── Public API ──

  static get enabled() { return DevPanel._enabled; }

  static enable() {
    DevPanel._enabled = true;
    DevPanel.startTime = Date.now();
  }

  /**
   * True when running inside Extension Development Host
   * OR when the user has flipped kivi.dev.enabled in settings JSON.
   */
  static shouldEnable(context: vscode.ExtensionContext): boolean {
    if (context.extensionMode === vscode.ExtensionMode.Development) return true;
    return vscode.workspace.getConfiguration('kivi').get<boolean>('dev.enabled', false);
  }

  static open(context: vscode.ExtensionContext) {
    if (DevPanel.instance) {
      DevPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'kivi.devPanel',
      'Kivi Dev Tools',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
        ],
      },
    );
    new DevPanel(panel, context);
  }

  static log(level: LogEntry['level'], source: string, message: string, data?: unknown) {
    if (!DevPanel._enabled) return;
    const entry: LogEntry = { timestamp: Date.now(), level, source, message, data };
    DevPanel.logs.push(entry);
    if (DevPanel.logs.length > MAX_BUFFERED_LOGS) {
      DevPanel.logs = DevPanel.logs.slice(-TRIM_TO);
    }
    DevPanel.instance?.sendToPanel({ type: 'newLog', entry });
  }

  static perf(label: string, phase: 'start' | 'end') {
    if (!DevPanel._enabled) return;
    if (phase === 'start') {
      DevPanel.perfMarks.set(label, performance.now());
    } else {
      const start = DevPanel.perfMarks.get(label);
      if (start !== undefined) {
        const duration = performance.now() - start;
        DevPanel.perfMarks.delete(label);
        DevPanel.log('perf', 'perf', `${label}: ${duration.toFixed(1)}ms`, { label, durationMs: duration });
      }
    }
  }

  // ── Panel lifecycle ──

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    DevPanel.instance = this;

    panel.iconPath = new vscode.ThemeIcon('debug-console');
    panel.webview.html = this.getHtml(panel.webview);

    panel.onDidDispose(() => {
      DevPanel.instance = undefined;
      this.disposables.forEach(d => d.dispose());
    });

    panel.webview.onDidReceiveMessage(msg => {
      switch (msg.type) {
        case 'ready':
          this.sendFullState();
          break;
        case 'clearLogs':
          DevPanel.logs = [];
          this.sendToPanel({ type: 'logs', logs: [] });
          break;
        case 'refreshState':
          this.sendFullState();
          break;
        case 'runDiag':
          this.runDiagnostics();
          break;
      }
    });

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(() => this.sendSettings()),
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.sendEditorState()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.sendEditorState()),
    );

    const interval = setInterval(() => {
      if (DevPanel.instance) this.sendRuntimeMetrics();
    }, 3000);
    this.disposables.push({ dispose: () => clearInterval(interval) });
  }

  private sendToPanel(msg: Record<string, unknown>) {
    if (this.panel.visible) {
      this.panel.webview.postMessage(msg);
    }
  }

  private sendFullState() {
    this.sendToPanel({ type: 'logs', logs: DevPanel.logs });
    this.sendSettings();
    this.sendEditorState();
    this.sendRuntimeMetrics();
    this.sendExtensionInfo();
  }

  private sendSettings() {
    const kiviCfg = vscode.workspace.getConfiguration('kivi');
    const editorCfg = vscode.workspace.getConfiguration('editor');
    const settings: Record<string, unknown> = {};

    for (const key of [
      'defaultEditor', 'dev.enabled',
      'appearance.editorBackground', 'appearance.codeBlockBackground',
      'appearance.accentColor', 'appearance.textColor', 'appearance.headingColor',
      'appearance.fontSize', 'appearance.fontFamily', 'appearance.lineHeight',
      'appearance.zoom', 'appearance.customCSS', 'ui.showToolbar',
      'folders.pages', 'folders.assets',
    ]) {
      settings[`kivi.${key}`] = kiviCfg.get(key);
    }
    settings['editor.fontSize'] = editorCfg.get('fontSize');
    settings['editor.fontFamily'] = editorCfg.get('fontFamily');
    settings['editor.lineHeight'] = editorCfg.get('lineHeight');
    settings['editor.wordWrap'] = editorCfg.get('wordWrap');

    this.sendToPanel({ type: 'settings', settings });
  }

  private sendEditorState() {
    const activePanels = (KiviEditorProvider as any).activePanels as Map<string, vscode.WebviewPanel> | undefined;
    const panelCount = activePanels?.size ?? 0;
    const panelUris = activePanels ? Array.from(activePanels.keys()).map(u => {
      try { return vscode.Uri.parse(u).fsPath.split('/').pop(); } catch { return u; }
    }) : [];

    const workspaceTags = KiviEditorProvider.workspaceTags;
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const isKivi = activeTab && (activeTab.input as any)?.viewType === KiviEditorProvider.viewType;

    this.sendToPanel({
      type: 'editorState',
      state: {
        activePanelCount: panelCount,
        activePanelFiles: panelUris,
        workspaceTagCount: workspaceTags.size,
        isKiviEditorFocused: !!isKivi,
        workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
        openTabCount: vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0),
      },
    });
  }

  private sendRuntimeMetrics() {
    const mem = process.memoryUsage();
    this.sendToPanel({
      type: 'runtime',
      metrics: {
        uptimeMs: Date.now() - DevPanel.startTime,
        heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
        rssMB: (mem.rss / 1024 / 1024).toFixed(1),
        externalMB: (mem.external / 1024 / 1024).toFixed(1),
        logBufferSize: DevPanel.logs.length,
      },
    });
  }

  private sendExtensionInfo() {
    const ext = vscode.extensions.getExtension('kivi.kivi');
    this.sendToPanel({
      type: 'extensionInfo',
      info: {
        version: ext?.packageJSON?.version ?? 'dev',
        extensionMode: this.context.extensionMode === vscode.ExtensionMode.Development ? 'Development' :
          this.context.extensionMode === vscode.ExtensionMode.Test ? 'Test' : 'Production',
        devEnabledVia: this.context.extensionMode === vscode.ExtensionMode.Development
          ? 'Extension Development Host'
          : 'kivi.dev.enabled setting',
        extensionPath: this.context.extensionPath,
        globalStoragePath: this.context.globalStorageUri.fsPath,
        vscodeVersion: vscode.version,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    });
  }

  private async runDiagnostics() {
    DevPanel.log('info', 'diag', 'Running diagnostics...');

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      DevPanel.log('warn', 'diag', 'No workspace folder open');
    } else {
      const mdFiles = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 5000);
      DevPanel.log('info', 'diag', `Workspace: ${folders[0].uri.fsPath} — ${mdFiles.length} markdown files`);
    }

    const activePanels = (KiviEditorProvider as any).activePanels as Map<string, vscode.WebviewPanel> | undefined;
    DevPanel.log('info', 'diag', `Active Kivi editors: ${activePanels?.size ?? 0}`);
    DevPanel.log('info', 'diag', `Workspace tags indexed: ${KiviEditorProvider.workspaceTags.size}`);

    const mem = process.memoryUsage();
    DevPanel.log('info', 'diag', `Memory: heap ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB / ${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB, RSS ${(mem.rss / 1024 / 1024).toFixed(1)}MB`);
    DevPanel.log('info', 'diag', 'Diagnostics complete.');
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'devpanel.js'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Kivi Dev Tools</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
