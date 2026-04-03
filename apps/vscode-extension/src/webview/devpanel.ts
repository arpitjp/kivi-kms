declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();

interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug' | 'perf';
  source: string;
  message: string;
  data?: unknown;
}

let logs: LogEntry[] = [];
let settings: Record<string, unknown> = {};
let editorState: Record<string, unknown> = {};
let runtime: Record<string, unknown> = {};
let extensionInfo: Record<string, unknown> = {};
let activeTab = 'logs';
let logFilter: LogEntry['level'] | 'all' = 'all';
let logSearch = '';

function $(sel: string) { return document.querySelector(sel); }

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function levelBadge(level: string): string {
  const colors: Record<string, string> = {
    info: '#4fc1ff', warn: '#cca700', error: '#f14c4c',
    debug: '#888', perf: '#4ec9b0',
  };
  const color = colors[level] || '#888';
  return `<span class="badge" style="color:${color};border-color:${color}40">${level}</span>`;
}

function filteredLogs(): LogEntry[] {
  return logs.filter(l => {
    if (logFilter !== 'all' && l.level !== logFilter) return false;
    if (logSearch && !l.message.toLowerCase().includes(logSearch.toLowerCase())
        && !l.source.toLowerCase().includes(logSearch.toLowerCase())) return false;
    return true;
  });
}

function renderLogs() {
  const container = $('#tab-content')!;
  const entries = filteredLogs();
  const html = `
    <div class="toolbar">
      <div class="filter-group">
        ${['all', 'info', 'warn', 'error', 'debug', 'perf'].map(f =>
          `<button class="filter-btn ${logFilter === f ? 'active' : ''}" data-filter="${f}">${f}</button>`
        ).join('')}
      </div>
      <input type="text" class="search-input" id="log-search" placeholder="Filter logs..." value="${escapeHtml(logSearch)}" />
      <button class="action-btn" id="clear-logs">Clear</button>
    </div>
    <div class="log-list" id="log-list">
      ${entries.length === 0 ? '<div class="empty-state">No log entries yet</div>' :
        entries.map(l => `
          <div class="log-entry log-${l.level}">
            <span class="log-time">${formatTime(l.timestamp)}</span>
            ${levelBadge(l.level)}
            <span class="log-source">${escapeHtml(l.source)}</span>
            <span class="log-msg">${escapeHtml(l.message)}</span>
            ${l.data ? `<span class="log-data" title="${escapeHtml(JSON.stringify(l.data, null, 2))}">+data</span>` : ''}
          </div>
        `).join('')}
    </div>`;
  container.innerHTML = html;

  // Scroll to bottom
  const list = document.getElementById('log-list');
  if (list) list.scrollTop = list.scrollHeight;

  // Bind events
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      logFilter = (btn as HTMLElement).dataset.filter as typeof logFilter;
      renderLogs();
    });
  });
  document.getElementById('clear-logs')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearLogs' });
  });
  document.getElementById('log-search')?.addEventListener('input', e => {
    logSearch = (e.target as HTMLInputElement).value;
    renderLogs();
  });
}

function renderRuntime() {
  const container = $('#tab-content')!;
  const heapPct = runtime.heapTotalMB ? ((Number(runtime.heapUsedMB) / Number(runtime.heapTotalMB)) * 100).toFixed(0) : '0';

  container.innerHTML = `
    <div class="section">
      <h3>Memory</h3>
      <div class="metric-grid">
        <div class="metric-card">
          <div class="metric-value">${runtime.heapUsedMB ?? '—'} MB</div>
          <div class="metric-label">Heap Used</div>
          <div class="metric-bar"><div class="metric-bar-fill" style="width:${heapPct}%"></div></div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${runtime.heapTotalMB ?? '—'} MB</div>
          <div class="metric-label">Heap Total</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${runtime.rssMB ?? '—'} MB</div>
          <div class="metric-label">RSS</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${runtime.externalMB ?? '—'} MB</div>
          <div class="metric-label">External</div>
        </div>
      </div>
    </div>
    <div class="section">
      <h3>Uptime</h3>
      <div class="metric-value uptime">${formatUptime(Number(runtime.uptimeMs ?? 0))}</div>
    </div>
    <div class="section">
      <h3>Performance Log</h3>
      <div class="log-list perf-list">
        ${logs.filter(l => l.level === 'perf').slice(-20).map(l => `
          <div class="log-entry log-perf">
            <span class="log-time">${formatTime(l.timestamp)}</span>
            <span class="log-msg">${escapeHtml(l.message)}</span>
          </div>
        `).join('') || '<div class="empty-state">No perf entries yet</div>'}
      </div>
    </div>`;
}

function renderState() {
  const container = $('#tab-content')!;
  container.innerHTML = `
    <div class="section">
      <h3>Editor State</h3>
      <div class="kv-table">
        ${Object.entries(editorState).map(([k, v]) => `
          <div class="kv-row">
            <span class="kv-key">${escapeHtml(k)}</span>
            <span class="kv-val">${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v))}</span>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="section">
      <h3>Extension Info</h3>
      <div class="kv-table">
        ${Object.entries(extensionInfo).map(([k, v]) => `
          <div class="kv-row">
            <span class="kv-key">${escapeHtml(k)}</span>
            <span class="kv-val">${escapeHtml(String(v))}</span>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="section">
      <button class="action-btn" id="run-diag">Run Diagnostics</button>
      <button class="action-btn" id="refresh-state">Refresh</button>
    </div>`;

  document.getElementById('run-diag')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'runDiag' });
  });
  document.getElementById('refresh-state')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'refreshState' });
  });
}

function renderSettings() {
  const container = $('#tab-content')!;
  const entries = Object.entries(settings);
  container.innerHTML = `
    <div class="section">
      <h3>Active Configuration</h3>
      <div class="kv-table">
        ${entries.map(([k, v]) => {
          const valStr = v === '' ? '<em class="empty-val">(empty)</em>' :
                         v === true ? '<span class="bool-true">true</span>' :
                         v === false ? '<span class="bool-false">false</span>' :
                         escapeHtml(String(v));
          return `
            <div class="kv-row">
              <span class="kv-key">${escapeHtml(k)}</span>
              <span class="kv-val">${valStr}</span>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function render() {
  const tabs = ['logs', 'perf', 'state', 'settings'];
  const tabLabels: Record<string, string> = { logs: 'Logs', perf: 'Performance', state: 'State', settings: 'Settings' };

  // Render tab bar (only once if needed, but simpler to re-render)
  const tabBar = $('#tab-bar')!;
  tabBar.innerHTML = tabs.map(t =>
    `<button class="tab ${activeTab === t ? 'active' : ''}" data-tab="${t}">${tabLabels[t]}</button>`
  ).join('') + `<span class="tab-spacer"></span><span class="tab-indicator">${errorCount()} errors</span>`;

  // Bind tab clicks
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = (btn as HTMLElement).dataset.tab!;
      render();
    });
  });

  switch (activeTab) {
    case 'logs': renderLogs(); break;
    case 'perf': renderRuntime(); break;
    case 'state': renderState(); break;
    case 'settings': renderSettings(); break;
  }
}

function errorCount(): number {
  return logs.filter(l => l.level === 'error').length;
}

// Build the app shell
document.getElementById('app')!.innerHTML = `
  <div class="dev-panel">
    <div class="header">
      <span class="header-title">Kivi Dev Tools</span>
      <span class="header-mode">DEV</span>
    </div>
    <div id="tab-bar" class="tab-bar"></div>
    <div id="tab-content" class="tab-content"></div>
  </div>`;

// Insert styles
const style = document.createElement('style');
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: 12px;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    height: 100vh; overflow: hidden;
  }
  .dev-panel { display: flex; flex-direction: column; height: 100vh; }
  .header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 14px;
    background: var(--vscode-titleBar-activeBackground, #1e1e1e);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    flex-shrink: 0;
  }
  .header-title { font-weight: 600; font-size: 13px; }
  .header-mode {
    font-size: 9px; font-weight: 700; letter-spacing: .06em;
    padding: 2px 6px; border-radius: 3px;
    background: #4ec9b030; color: #4ec9b0;
  }
  .tab-bar {
    display: flex; align-items: center; gap: 0;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
    flex-shrink: 0; padding: 0 8px;
  }
  .tab {
    padding: 7px 14px; font-size: 11px; cursor: pointer;
    background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground, #888); font-family: inherit;
    transition: color .15s, border-color .15s;
  }
  .tab:hover { color: var(--vscode-foreground, #ccc); }
  .tab.active { color: var(--vscode-foreground, #d4d4d4); border-bottom-color: var(--vscode-textLink-foreground, #4fc1ff); }
  .tab-spacer { flex: 1; }
  .tab-indicator { font-size: 10px; color: var(--vscode-descriptionForeground, #666); padding-right: 4px; }
  .tab-content { flex: 1; overflow-y: auto; padding: 0; }
  .tab-content::-webkit-scrollbar { width: 6px; }
  .tab-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 3px; }

  /* Toolbar */
  .toolbar {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a);
    flex-shrink: 0; position: sticky; top: 0; z-index: 5;
    background: var(--vscode-editor-background, #1e1e1e);
  }
  .filter-group { display: flex; gap: 2px; }
  .filter-btn {
    padding: 3px 8px; font-size: 10px; border-radius: 3px;
    background: none; border: 1px solid transparent;
    color: var(--vscode-descriptionForeground, #777); cursor: pointer; font-family: inherit;
  }
  .filter-btn:hover { color: var(--vscode-foreground, #ccc); }
  .filter-btn.active { border-color: var(--vscode-textLink-foreground, #4fc1ff); color: var(--vscode-textLink-foreground, #4fc1ff); }
  .search-input {
    flex: 1; min-width: 100px; padding: 3px 8px; font-size: 11px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 3px; outline: none; font-family: inherit;
  }
  .search-input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .action-btn {
    padding: 4px 12px; font-size: 11px; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: none; font-family: inherit;
  }
  .action-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }

  /* Log list */
  .log-list { font-family: var(--vscode-editor-font-family, 'SF Mono', Menlo, monospace); font-size: 11px; }
  .log-entry {
    display: flex; align-items: baseline; gap: 8px;
    padding: 3px 12px; border-bottom: 1px solid rgba(255,255,255,.03);
    line-height: 1.6;
  }
  .log-entry:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.03)); }
  .log-time { color: var(--vscode-descriptionForeground, #555); font-size: 10px; flex-shrink: 0; }
  .badge {
    font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 3px;
    border: 1px solid; flex-shrink: 0; text-transform: uppercase; letter-spacing: .03em;
  }
  .log-source { color: var(--vscode-descriptionForeground, #777); font-size: 10px; flex-shrink: 0; min-width: 50px; }
  .log-msg { flex: 1; word-break: break-word; }
  .log-data {
    font-size: 9px; color: var(--vscode-textLink-foreground, #4fc1ff);
    cursor: help; flex-shrink: 0; opacity: .6;
  }
  .log-error .log-msg { color: #f14c4c; }
  .log-warn .log-msg { color: #cca700; }
  .log-perf .log-msg { color: #4ec9b0; }
  .perf-list { max-height: 200px; overflow-y: auto; }

  /* Metrics */
  .section { padding: 16px; border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a); }
  .section h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground, #888); margin-bottom: 10px; font-weight: 600; }
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
  .metric-card {
    padding: 12px; border-radius: 6px;
    background: var(--vscode-input-background, #2a2a2e);
    border: 1px solid var(--vscode-panel-border, #333);
  }
  .metric-value { font-size: 20px; font-weight: 600; color: var(--vscode-foreground, #d4d4d4); }
  .metric-value.uptime { font-size: 24px; }
  .metric-label { font-size: 10px; color: var(--vscode-descriptionForeground, #777); margin-top: 2px; }
  .metric-bar { height: 4px; border-radius: 2px; background: rgba(255,255,255,.08); margin-top: 8px; overflow: hidden; }
  .metric-bar-fill { height: 100%; border-radius: 2px; background: var(--vscode-textLink-foreground, #4fc1ff); transition: width .3s; }

  /* KV table */
  .kv-table { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .kv-row {
    display: flex; gap: 12px; padding: 4px 0;
    border-bottom: 1px solid rgba(255,255,255,.03);
  }
  .kv-key { color: var(--vscode-textLink-foreground, #4fc1ff); min-width: 200px; flex-shrink: 0; }
  .kv-val { color: var(--vscode-foreground, #ccc); word-break: break-all; }
  .empty-val { color: var(--vscode-descriptionForeground, #555); }
  .bool-true { color: #4ec9b0; }
  .bool-false { color: #d16969; }

  .empty-state {
    padding: 40px; text-align: center;
    color: var(--vscode-descriptionForeground, #555); font-size: 12px;
  }
`;
document.head.appendChild(style);

render();

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'logs':
      logs = msg.logs;
      if (activeTab === 'logs') renderLogs();
      break;
    case 'newLog':
      logs.push(msg.entry);
      if (logs.length > 500) logs = logs.slice(-400);
      if (activeTab === 'logs') {
        // Append instead of re-render for perf
        const list = document.getElementById('log-list');
        if (list && (logFilter === 'all' || msg.entry.level === logFilter)) {
          const match = !logSearch || msg.entry.message.toLowerCase().includes(logSearch.toLowerCase())
            || msg.entry.source.toLowerCase().includes(logSearch.toLowerCase());
          if (match) {
            const div = document.createElement('div');
            div.className = `log-entry log-${msg.entry.level}`;
            div.innerHTML = `
              <span class="log-time">${formatTime(msg.entry.timestamp)}</span>
              ${levelBadge(msg.entry.level)}
              <span class="log-source">${escapeHtml(msg.entry.source)}</span>
              <span class="log-msg">${escapeHtml(msg.entry.message)}</span>
              ${msg.entry.data ? `<span class="log-data" title="${escapeHtml(JSON.stringify(msg.entry.data, null, 2))}">+data</span>` : ''}`;
            list.appendChild(div);
            list.scrollTop = list.scrollHeight;
          }
        }
      }
      // Update error count in tab bar
      const indicator = document.querySelector('.tab-indicator');
      if (indicator) indicator.textContent = `${errorCount()} errors`;
      break;
    case 'settings':
      settings = msg.settings;
      if (activeTab === 'settings') renderSettings();
      break;
    case 'editorState':
      editorState = msg.state;
      if (activeTab === 'state') renderState();
      break;
    case 'runtime':
      runtime = msg.metrics;
      if (activeTab === 'perf') renderRuntime();
      break;
    case 'extensionInfo':
      extensionInfo = msg.info;
      if (activeTab === 'state') renderState();
      break;
  }
});

vscode.postMessage({ type: 'ready' });
