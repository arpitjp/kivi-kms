import { GraphRenderer } from '@kivi/vault';
import type { GraphData, GraphNode, EdgeType, NodeType } from '@kivi/vault';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

let renderer: GraphRenderer | null = null;
let currentData: GraphData | null = null;
let currentFocusNode: string | undefined;
let currentMeta: { tags: { tag: string; count: number }[]; folders: { folder: string; count: number }[] } | null = null;

interface FilterState {
  nodeTypes: Set<NodeType>;
  edgeTypes: Set<EdgeType>;
  depth: number;
  query: string;
  orphansOnly: boolean;
  minBacklinks: number;
  selectedTags: Set<string>;
  selectedFolders: Set<string>;
  sidebarVisible: boolean;
}

const filters: FilterState = {
  nodeTypes: new Set(['note'] as NodeType[]),
  edgeTypes: new Set(['link', 'backlink'] as EdgeType[]),
  depth: 2,
  query: '',
  orphansOnly: false,
  minBacklinks: 0,
  selectedTags: new Set(),
  selectedFolders: new Set(),
  sidebarVisible: false,
};

const savedState = vscode.getState() as Partial<FilterState> & { _nodeTypes?: string[]; _edgeTypes?: string[]; _tags?: string[]; _folders?: string[] } | null;
if (savedState) {
  if (savedState._nodeTypes) filters.nodeTypes = new Set(savedState._nodeTypes as NodeType[]);
  if (savedState._edgeTypes) filters.edgeTypes = new Set(savedState._edgeTypes as EdgeType[]);
  if (savedState.depth !== undefined) filters.depth = savedState.depth;
  if (savedState.orphansOnly !== undefined) filters.orphansOnly = savedState.orphansOnly;
  if (savedState.minBacklinks !== undefined) filters.minBacklinks = savedState.minBacklinks;
  if (savedState._tags) filters.selectedTags = new Set(savedState._tags);
  if (savedState._folders) filters.selectedFolders = new Set(savedState._folders);
  if (savedState.sidebarVisible !== undefined) filters.sidebarVisible = savedState.sidebarVisible;
}

function persistState() {
  vscode.setState({
    _nodeTypes: [...filters.nodeTypes],
    _edgeTypes: [...filters.edgeTypes],
    depth: filters.depth,
    orphansOnly: filters.orphansOnly,
    minBacklinks: filters.minBacklinks,
    _tags: [...filters.selectedTags],
    _folders: [...filters.selectedFolders],
    sidebarVisible: filters.sidebarVisible,
  });
}

// ── Fuzzy match ──
function fuzzyMatch(text: string, query: string): { match: boolean; score: number; ranges: [number, number][] } {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const ranges: [number, number][] = [];
  const idx = lower.indexOf(q);
  if (idx >= 0) return { match: true, score: 100 - idx, ranges: [[idx, idx + q.length]] };
  let qi = 0, score = 0, lastMatchIdx = -2;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      if (i === lastMatchIdx + 1) score += 2; else score += 1;
      if (ranges.length > 0 && ranges[ranges.length - 1][1] === i) ranges[ranges.length - 1][1] = i + 1;
      else ranges.push([i, i + 1]);
      lastMatchIdx = i; qi++;
    }
  }
  return { match: qi === q.length, score, ranges };
}

function highlightMatch(text: string, ranges: [number, number][]): string {
  if (ranges.length === 0) return esc(text);
  let result = '', last = 0;
  for (const [start, end] of ranges) {
    result += esc(text.slice(last, start));
    result += `<b>${esc(text.slice(start, end))}</b>`;
    last = end;
  }
  return result + esc(text.slice(last));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Init ──
function init() {
  const container = document.getElementById('graph-container')!;
  const root = document.documentElement;
  const cs = getComputedStyle(document.body);
  const themeVars: [string, string, string][] = [
    ['--bg', '--vscode-editor-background', '#1e1e1e'],
    ['--bg-surface', '--vscode-editorGroupHeader-tabsBackground', '#252526'],
    ['--text', '--vscode-editor-foreground', '#d4d4d4'],
    ['--text-muted', '--vscode-descriptionForeground', '#858585'],
    ['--accent', '--vscode-textLink-foreground', '#4fc1ff'],
    ['--border', '--vscode-panel-border', '#3c3c3c'],
  ];
  for (const [target, source, fallback] of themeVars) {
    root.style.setProperty(target, cs.getPropertyValue(source)?.trim() || fallback);
  }

  renderer = new GraphRenderer(container, {
    onNodeClick: (nodeId) => { vscode.postMessage({ type: 'openFile', path: nodeId }); },
    onEscape: () => { vscode.postMessage({ type: 'closeGraph' }); },
  });

  setupSidebar();
  setupShortcuts();
  setupResize(container);
  setupMessages();

  const sidebar = document.getElementById('graph-sidebar');
  const sidebarBtn = document.getElementById('graph-sidebar-toggle');
  if (filters.sidebarVisible) {
    sidebar?.classList.remove('hidden');
    sidebarBtn?.classList.add('active');
  }

  vscode.postMessage({ type: 'ready' });
}

// ── Sidebar ──
function setupSidebar() {
  const sidebar = document.getElementById('graph-sidebar');
  const sidebarBtn = document.getElementById('graph-sidebar-toggle');
  sidebarBtn?.addEventListener('click', () => {
    const visible = !sidebar?.classList.contains('hidden');
    sidebar?.classList.toggle('hidden', visible);
    sidebarBtn?.classList.toggle('active', !visible);
    filters.sidebarVisible = !visible;
    persistState();
    setTimeout(() => {
      const container = document.getElementById('graph-container')!;
      renderer?.resize(container.clientWidth, container.clientHeight);
    }, 10);
  });

  document.querySelectorAll('.gs-group-header').forEach(header => {
    header.addEventListener('click', () => header.parentElement?.classList.toggle('collapsed'));
  });

  const searchInput = document.getElementById('graph-filter') as HTMLInputElement;
  const searchResults = document.getElementById('gs-search-results')!;
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;

  searchInput?.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      filters.query = searchInput.value.trim();
      updateSearchResults();
      refreshGraph();
      persistState();
    }, 150);
  });

  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = ''; filters.query = ''; searchResults.innerHTML = '';
      document.getElementById('graph-container')?.querySelector('canvas')?.focus();
      refreshGraph();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      (searchResults.querySelector('.gs-search-result') as HTMLElement)?.focus();
    }
  });

  document.querySelectorAll<HTMLInputElement>('[data-ntype]').forEach(cb => {
    const nt = cb.dataset.ntype as NodeType;
    cb.checked = filters.nodeTypes.has(nt);
    cb.addEventListener('change', () => {
      if (cb.checked) filters.nodeTypes.add(nt); else filters.nodeTypes.delete(nt);
      syncEdgeFiltersToNodeTypes();
      persistState(); refreshGraph();
    });
  });

  document.querySelectorAll<HTMLInputElement>('[data-etype]').forEach(cb => {
    const et = cb.dataset.etype as EdgeType;
    cb.checked = filters.edgeTypes.has(et);
    cb.addEventListener('change', () => {
      if (cb.checked) filters.edgeTypes.add(et); else filters.edgeTypes.delete(et);
      renderer?.setEdgeFilter(et, cb.checked);
      persistState(); refreshGraph();
    });
  });

  const depthSlider = document.getElementById('gs-depth-slider') as HTMLInputElement;
  const depthLabel = document.getElementById('gs-depth-label')!;
  if (depthSlider) {
    depthSlider.value = String(filters.depth);
    depthLabel.textContent = String(filters.depth);
    depthSlider.addEventListener('input', () => {
      filters.depth = Number(depthSlider.value);
      depthLabel.textContent = String(filters.depth);
      persistState(); refreshGraph();
    });
  }

  const orphansCb = document.getElementById('gs-orphans-only') as HTMLInputElement;
  if (orphansCb) {
    orphansCb.checked = filters.orphansOnly;
    orphansCb.addEventListener('change', () => {
      filters.orphansOnly = orphansCb.checked;
      persistState(); refreshGraph();
    });
  }

  const minBacklinks = document.getElementById('gs-min-backlinks') as HTMLInputElement;
  const minBacklinksLabel = document.getElementById('gs-min-backlinks-label')!;
  if (minBacklinks) {
    minBacklinks.value = String(filters.minBacklinks);
    minBacklinksLabel.textContent = String(filters.minBacklinks);
    minBacklinks.addEventListener('input', () => {
      filters.minBacklinks = Number(minBacklinks.value);
      minBacklinksLabel.textContent = String(filters.minBacklinks);
      persistState(); refreshGraph();
    });
  }

  document.getElementById('gs-reset')?.addEventListener('click', resetFilters);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      if (sidebar?.classList.contains('hidden')) {
        sidebar.classList.remove('hidden');
        sidebarBtn?.classList.add('active');
        filters.sidebarVisible = true;
      }
      searchInput?.focus(); searchInput?.select();
    }
  });
}

function syncEdgeFiltersToNodeTypes() {
  const hasTag = filters.nodeTypes.has('tag');
  const hasUnresolved = filters.nodeTypes.has('unresolved');
  const hasAsset = filters.nodeTypes.has('asset');
  setEdgeFilterUI('tag-link', hasTag);
  setEdgeFilterUI('unresolved', hasUnresolved);
  setEdgeFilterUI('asset-ref', hasAsset);
}

function setEdgeFilterUI(etype: EdgeType, checked: boolean) {
  const cb = document.querySelector<HTMLInputElement>(`[data-etype="${etype}"]`);
  if (cb) {
    cb.checked = checked;
    if (checked) filters.edgeTypes.add(etype); else filters.edgeTypes.delete(etype);
    renderer?.setEdgeFilter(etype, checked);
  }
}

function resetFilters() {
  filters.nodeTypes = new Set(['note'] as NodeType[]);
  filters.edgeTypes = new Set(['link', 'backlink'] as EdgeType[]);
  filters.depth = 2; filters.query = '';
  filters.orphansOnly = false; filters.minBacklinks = 0;
  filters.selectedTags.clear(); filters.selectedFolders.clear();
  document.querySelectorAll<HTMLInputElement>('[data-ntype]').forEach(cb => cb.checked = filters.nodeTypes.has(cb.dataset.ntype as NodeType));
  document.querySelectorAll<HTMLInputElement>('[data-etype]').forEach(cb => {
    const et = cb.dataset.etype as EdgeType; cb.checked = filters.edgeTypes.has(et);
    renderer?.setEdgeFilter(et, cb.checked);
  });
  const depthSlider = document.getElementById('gs-depth-slider') as HTMLInputElement;
  if (depthSlider) { depthSlider.value = '2'; document.getElementById('gs-depth-label')!.textContent = '2'; }
  const searchInput = document.getElementById('graph-filter') as HTMLInputElement;
  if (searchInput) searchInput.value = '';
  const orphansCb = document.getElementById('gs-orphans-only') as HTMLInputElement;
  if (orphansCb) orphansCb.checked = false;
  const minBl = document.getElementById('gs-min-backlinks') as HTMLInputElement;
  if (minBl) { minBl.value = '0'; document.getElementById('gs-min-backlinks-label')!.textContent = '0'; }
  document.getElementById('gs-search-results')!.innerHTML = '';
  document.querySelectorAll<HTMLInputElement>('[data-tag-filter]').forEach(cb => cb.checked = false);
  document.querySelectorAll<HTMLInputElement>('[data-folder-filter]').forEach(cb => cb.checked = false);
  persistState(); refreshGraph();
}

function updateSearchResults() {
  const resultsEl = document.getElementById('gs-search-results')!;
  const q = filters.query;
  if (!q || !currentData) { resultsEl.innerHTML = ''; return; }
  const matches: { node: GraphNode; score: number; ranges: [number, number][] }[] = [];
  for (const node of currentData.nodes) {
    const r = fuzzyMatch(node.label, q);
    if (r.match) { matches.push({ node, score: r.score, ranges: r.ranges }); continue; }
    for (const t of node.tags) {
      const tr = fuzzyMatch(t, q);
      if (tr.match) { matches.push({ node, score: tr.score * 0.8, ranges: [] }); break; }
    }
  }
  matches.sort((a, b) => b.score - a.score);
  resultsEl.innerHTML = matches.slice(0, 12).map(m => {
    const label = m.ranges.length > 0 ? highlightMatch(m.node.label, m.ranges) : esc(m.node.label);
    const typeTag = m.node.nodeType !== 'note' ? ` <span style="opacity:0.5;font-size:9px">${m.node.nodeType}</span>` : '';
    return `<div class="gs-search-result" tabindex="0" data-node-id="${esc(m.node.id)}">${label}${typeTag}</div>`;
  }).join('');
  resultsEl.querySelectorAll('.gs-search-result').forEach(el => {
    const handler = () => {
      const canvas = document.getElementById('graph-container')?.querySelector('canvas');
      canvas?.focus();
    };
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') handler();
      if ((e as KeyboardEvent).key === 'ArrowDown') (el.nextElementSibling as HTMLElement)?.focus();
      if ((e as KeyboardEvent).key === 'ArrowUp') {
        const prev = el.previousElementSibling as HTMLElement;
        if (prev) prev.focus();
        else (document.getElementById('graph-filter') as HTMLInputElement)?.focus();
      }
    });
  });
}

function populateTagsAndFolders() {
  if (!currentMeta) return;
  const tagsList = document.getElementById('gs-tags-list')!;
  tagsList.innerHTML = currentMeta.tags.map(t =>
    `<label class="gs-toggle"><input type="checkbox" data-tag-filter="${esc(t.tag)}" ${filters.selectedTags.has(t.tag) ? 'checked' : ''} />#${esc(t.tag)} <span class="gs-count">${t.count}</span></label>`
  ).join('');
  tagsList.querySelectorAll<HTMLInputElement>('[data-tag-filter]').forEach(cb => {
    cb.addEventListener('change', () => {
      const tag = cb.dataset.tagFilter!;
      if (cb.checked) filters.selectedTags.add(tag); else filters.selectedTags.delete(tag);
      persistState(); refreshGraph();
    });
  });
  const foldersList = document.getElementById('gs-folders-list')!;
  foldersList.innerHTML = currentMeta.folders.map(f =>
    `<label class="gs-toggle"><input type="checkbox" data-folder-filter="${esc(f.folder)}" ${filters.selectedFolders.has(f.folder) ? 'checked' : ''} />📁 ${esc(f.folder)} <span class="gs-count">${f.count}</span></label>`
  ).join('');
  foldersList.querySelectorAll<HTMLInputElement>('[data-folder-filter]').forEach(cb => {
    cb.addEventListener('change', () => {
      const folder = cb.dataset.folderFilter!;
      if (cb.checked) filters.selectedFolders.add(folder); else filters.selectedFolders.delete(folder);
      persistState(); refreshGraph();
    });
  });
}

function updateNodeCounts() {
  if (!currentData) return;
  const counts: Record<string, number> = { note: 0, tag: 0, folder: 0, unresolved: 0, asset: 0 };
  for (const n of currentData.nodes) counts[n.nodeType] = (counts[n.nodeType] || 0) + 1;
  for (const [type, count] of Object.entries(counts)) {
    const el = document.getElementById(`gs-count-${type}`);
    if (el) el.textContent = String(count);
  }
}

function setupShortcuts() {
  const shortcutToggle = document.getElementById('graph-shortcut-toggle');
  const shortcutsOverlay = document.getElementById('graph-shortcuts');
  shortcutToggle?.addEventListener('click', () => shortcutsOverlay?.classList.toggle('visible'));
  document.addEventListener('click', (e) => {
    if (shortcutsOverlay?.classList.contains('visible') &&
        !shortcutsOverlay.contains(e.target as Node) && e.target !== shortcutToggle) {
      shortcutsOverlay.classList.remove('visible');
    }
  });
}

function setupResize(container: HTMLElement) {
  const ro = new ResizeObserver(() => { if (renderer) renderer.resize(container.clientWidth, container.clientHeight); });
  ro.observe(container);
}

function setupMessages() {
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'graphData') {
      currentData = msg.data;
      currentFocusNode = msg.focusNode;
      currentMeta = msg.meta ?? null;
      populateTagsAndFolders();
      updateNodeCounts();
      refreshGraph();
    } else if (msg.type === 'setFocus') {
      if (msg.focusNode) currentFocusNode = msg.focusNode;
      refreshGraph();
    }
  });
}

function refreshGraph() {
  if (!renderer || !currentData) return;
  const container = document.getElementById('graph-container')!;

  let nodes = currentData.nodes;
  let edges = currentData.edges;

  if (filters.nodeTypes.size > 0) nodes = nodes.filter(n => filters.nodeTypes.has(n.nodeType));
  if (filters.edgeTypes.size > 0) edges = edges.filter(e => filters.edgeTypes.has(e.type));

  if (filters.query) {
    const q = filters.query.toLowerCase();
    const matchIds = new Set<string>();
    for (const n of nodes) {
      if (fuzzyMatch(n.label, q).match) { matchIds.add(n.id); continue; }
      if (n.id.toLowerCase().includes(q)) { matchIds.add(n.id); continue; }
      for (const t of n.tags) { if (t.toLowerCase().includes(q)) { matchIds.add(n.id); break; } }
    }
    nodes = nodes.filter(n => matchIds.has(n.id));
  }

  if (filters.orphansOnly) nodes = nodes.filter(n => n.nodeType !== 'note' || n.isOrphan);
  if (filters.minBacklinks > 0) nodes = nodes.filter(n => n.nodeType !== 'note' || n.backlinkCount >= filters.minBacklinks);

  if (filters.selectedTags.size > 0) {
    nodes = nodes.filter(n => n.nodeType !== 'note' || n.tags.some(t => filters.selectedTags.has(t.split('/')[0])));
  }
  if (filters.selectedFolders.size > 0) {
    nodes = nodes.filter(n => n.nodeType !== 'note' || (n.folder && filters.selectedFolders.has(n.folder)));
  }

  const visibleIds = new Set(nodes.map(n => n.id));
  edges = edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));

  // If there's a focus node, do BFS depth-limited local view
  const focusNode = currentFocusNode;
  if (focusNode && visibleIds.has(focusNode)) {
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const e of edges) { adj.get(e.source)?.add(e.target); adj.get(e.target)?.add(e.source); }
    const reachable = new Set<string>();
    const queue: [string, number][] = [[focusNode, 0]];
    reachable.add(focusNode);
    let qi = 0;
    while (qi < queue.length) {
      const [cur, d] = queue[qi++];
      if (d >= filters.depth) continue;
      for (const nb of adj.get(cur) || []) {
        if (!reachable.has(nb)) { reachable.add(nb); queue.push([nb, d + 1]); }
      }
    }
    nodes = nodes.filter(n => reachable.has(n.id));
    const localIds = new Set(nodes.map(n => n.id));
    edges = edges.filter(e => localIds.has(e.source) && localIds.has(e.target));
  }

  renderer.setData({ nodes, edges }, focusNode);
  renderer.resize(container.clientWidth, container.clientHeight);

  const statusNodes = document.getElementById('gs-status-nodes');
  const statusEdges = document.getElementById('gs-status-edges');
  if (statusNodes) statusNodes.textContent = `${nodes.length} nodes`;
  if (statusEdges) statusEdges.textContent = `${edges.length} edges`;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
