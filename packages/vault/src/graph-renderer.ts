import type { GraphNode, GraphEdge, GraphData, EdgeType, NodeType } from './types.js';

// ── Layout node with position & velocity ─────────────────────

interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  depth: number;
  w: number;
  h: number;
  color: string;
  dimmed: boolean;
  pinned: boolean;
  scale: number;
  targetScale: number;
  opacity: number;       // entrance fade-in
  targetOpacity: number;
}

// ── Theme tokens ─────────────────────────────────────────────

interface Theme {
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  accent: string;
  border: string;
  edgeLink: string;
  edgeTag: string;
  edgeParent: string;
  edgeSibling: string;
  edgeFolder: string;
  edgeUnresolved: string;
  edgeAsset: string;
  nodeTag: string;
  nodeFolder: string;
  nodeUnresolved: string;
  nodeAsset: string;
}

function readTheme(): Theme {
  if (typeof window === 'undefined') return defaultTheme();
  const cs = getComputedStyle(document.documentElement);
  const v = (prop: string, fallback: string) => cs.getPropertyValue(prop)?.trim() || fallback;
  return {
    bg: v('--bg', '#1e1e1e'),
    surface: v('--bg-surface', '#252526'),
    text: v('--text', '#d4d4d4'),
    textMuted: v('--text-muted', '#858585'),
    accent: v('--accent', '#4fc1ff'),
    border: v('--border', '#3c3c3c'),
    edgeLink: v('--accent', '#4fc1ff'),
    edgeTag: '#4ec9b0',
    edgeParent: '#a8b4c8',
    edgeSibling: '#c586c0',
    edgeFolder: '#dcdcaa',
    edgeUnresolved: '#d16969',
    edgeAsset: '#ce9178',
    nodeTag: '#4ec9b0',
    nodeFolder: '#dcdcaa',
    nodeUnresolved: '#d16969',
    nodeAsset: '#ce9178',
  };
}

function defaultTheme(): Theme {
  return {
    bg: '#1e1e1e', surface: '#252526', text: '#d4d4d4', textMuted: '#858585',
    accent: '#4fc1ff', border: '#3c3c3c',
    edgeLink: '#4fc1ff', edgeTag: '#4ec9b0', edgeParent: '#a8b4c8', edgeSibling: '#c586c0',
    edgeFolder: '#dcdcaa', edgeUnresolved: '#d16969', edgeAsset: '#ce9178',
    nodeTag: '#4ec9b0', nodeFolder: '#dcdcaa', nodeUnresolved: '#d16969', nodeAsset: '#ce9178',
  };
}

// ── Constants ────────────────────────────────────────────────

const DPR = typeof window !== 'undefined' ? (window.devicePixelRatio || 2) : 2;
const NODE_H = 30;
const NODE_PAD_X = 14;
const NODE_RADIUS = 6;
const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif';
const FONT_BOLD = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif';
const FONT_SMALL = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif';
const TAG_PALETTE = [
  '#4fc1ff', '#4ec9b0', '#ce9178', '#dcdcaa',
  '#c586c0', '#9cdcfe', '#6a9955', '#d16969',
];

const EDGE_STYLES: Record<string, { dash: number[]; width: number; alpha: number }> = {
  link:            { dash: [],     width: 1,   alpha: 0.45 },
  backlink:        { dash: [],     width: 1,   alpha: 0.4 },
  parent:          { dash: [],     width: 1.2, alpha: 0.5 },
  'shared-tag':    { dash: [4, 3], width: 0.8, alpha: 0.3 },
  sibling:         { dash: [3, 3], width: 0.6, alpha: 0.25 },
  'shared-folder': { dash: [4, 3], width: 0.6, alpha: 0.2 },
  'tag-link':      { dash: [2, 3], width: 0.8, alpha: 0.35 },
  'folder-link':   { dash: [2, 3], width: 0.7, alpha: 0.25 },
  'unresolved':    { dash: [3, 4], width: 1,   alpha: 0.5 },
  'asset-ref':     { dash: [3, 3], width: 0.7, alpha: 0.3 },
};

const NODE_TYPE_SHAPES: Record<NodeType, 'rect' | 'pill' | 'diamond' | 'dashed'> = {
  note: 'rect',
  tag: 'pill',
  folder: 'rect',
  unresolved: 'dashed',
  asset: 'rect',
};

// Smooth lerp for animations
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── Spatial grid for fast hit-testing & culling ─────────────

class SpatialGrid {
  private cells = new Map<string, LayoutNode[]>();
  private cellSize: number;

  constructor(cellSize = 200) {
    this.cellSize = cellSize;
  }

  rebuild(nodes: LayoutNode[]): void {
    this.cells.clear();
    for (const n of nodes) {
      const key = this.key(n.x, n.y);
      const arr = this.cells.get(key);
      if (arr) arr.push(n);
      else this.cells.set(key, [n]);
    }
  }

  query(x: number, y: number, radius: number): LayoutNode[] {
    const result: LayoutNode[] = [];
    const minCX = Math.floor((x - radius) / this.cellSize);
    const maxCX = Math.floor((x + radius) / this.cellSize);
    const minCY = Math.floor((y - radius) / this.cellSize);
    const maxCY = Math.floor((y + radius) / this.cellSize);
    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const arr = this.cells.get(`${cx},${cy}`);
        if (arr) result.push(...arr);
      }
    }
    return result;
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }
}

// ── Render options ───────────────────────────────────────────

export interface GraphRendererOptions {
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onEscape?: () => void;
}

// ── Main class ───────────────────────────────────────────────

export class GraphRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nodes: LayoutNode[] = [];
  private edges: GraphEdge[] = [];
  private renderEdges: Array<GraphEdge & { curvature: number; bidir: boolean }> = [];
  private theme: Theme;
  private options: GraphRendererOptions;

  private focusNodeId: string | null = null;
  private animFrame: number | null = null;
  private width = 0;
  private height = 0;

  // Transform — animated
  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private targetPanX = 0;
  private targetPanY = 0;
  private targetZoom = 1;

  // Interaction state (node dragging disabled for clean layouts)
  private isPanning = false;
  private panAnchorX = 0;
  private panAnchorY = 0;
  private panAnchorPanX = 0;
  private panAnchorPanY = 0;
  private hovered: LayoutNode | null = null;
  private selected: LayoutNode | null = null;

  // Performance & state
  private spatialGrid = new SpatialGrid(200);
  private nodeMap = new Map<string, LayoutNode>();
  private needsRender = false;
  private isAnimating = false;
  private simFrame: number | null = null;
  private abortCtrl = new AbortController();
  private settled = false;
  private entranceProgress = 0;

  private edgeFilters: Set<EdgeType> = new Set([
    'link', 'backlink',
  ]);

  // Tag colors
  _tagColors = new Map<string, string>();

  // Tooltip
  private tooltip: HTMLDivElement;
  private container: HTMLElement;
  private tooltipNode: LayoutNode | null = null;
  private tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
  private isHoveringTooltip = false;

  // Persistent detail panel for clicked node
  private detailPanel: HTMLDivElement | null = null;

  constructor(container: HTMLElement, opts: GraphRendererOptions = {}) {
    this.options = opts;
    this.theme = readTheme();
    this.container = container;

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;cursor:grab;display:block;';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'kivi-graph-tooltip';
    this.hideTooltip();
    container.style.position = 'relative';
    container.appendChild(this.tooltip);

    this.tooltip.addEventListener('mouseenter', () => {
      this.isHoveringTooltip = true;
      if (this.tooltipHideTimer) {
        clearTimeout(this.tooltipHideTimer);
        this.tooltipHideTimer = null;
      }
    });
    this.tooltip.addEventListener('mouseleave', () => {
      this.isHoveringTooltip = false;
      this.scheduleTooltipHide();
    });

    this.setupEvents();
    this.setupKeyboard();
    this.startAnimationLoop();
  }

  // ── Public API ───────────────────────────────────────────

  setData(data: GraphData, focusNodeId?: string): void {
    this.cancelSimulation();
    this.settled = false;
    this.entranceProgress = 0;
    this.theme = readTheme();
    this.focusNodeId = focusNodeId ?? null;
    this._tagColors.clear();
    this.buildTagColors(data.nodes);
    this.edges = data.edges;
    this.buildRenderEdges();
    this.layoutNodes(data.nodes);
    this.spatialGrid.rebuild(this.nodes);
    this.simulate();
  }

  refreshTheme(): void {
    this.theme = readTheme();
    this.scheduleRender();
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.canvas.width = w * DPR;
    this.canvas.height = h * DPR;
    this.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    this.scheduleRender();
  }

  destroy(): void {
    this.isAnimating = false;
    this.cancelSimulation();
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    if (this.tooltipHideTimer) clearTimeout(this.tooltipHideTimer);
    this.abortCtrl.abort();
    this.tooltip.remove();
    this.detailPanel?.remove();
    this.canvas.remove();
  }

  setEdgeFilter(type: EdgeType, visible: boolean): void {
    if (visible) this.edgeFilters.add(type);
    else this.edgeFilters.delete(type);
    this.scheduleRender();
  }

  getEdgeFilters(): Set<EdgeType> { return new Set(this.edgeFilters); }

  // ── Animation loop ─────────────────────────────────────────

  private startAnimationLoop(): void {
    this.isAnimating = true;
    const tick = () => {
      if (!this.isAnimating) return;

      let animating = false;

      // Smooth zoom & pan
      const zDiff = Math.abs(this.zoom - this.targetZoom);
      const pxDiff = Math.abs(this.panX - this.targetPanX) + Math.abs(this.panY - this.targetPanY);
      if (zDiff > 0.001 || pxDiff > 0.5) {
        this.zoom = lerp(this.zoom, this.targetZoom, 0.18);
        this.panX = lerp(this.panX, this.targetPanX, 0.18);
        this.panY = lerp(this.panY, this.targetPanY, 0.18);
        animating = true;
      } else {
        this.zoom = this.targetZoom;
        this.panX = this.targetPanX;
        this.panY = this.targetPanY;
      }

      // Entrance animation: nodes fly from center to final positions
      if (this.settled && this.entranceProgress < 1) {
        this.entranceProgress = Math.min(1, this.entranceProgress + 0.08);
        const t = this.easeOutCubic(this.entranceProgress);
        for (const n of this.nodes) {
          const fx = (n as any)._finalX as number | undefined;
          const fy = (n as any)._finalY as number | undefined;
          if (fx !== undefined && fy !== undefined) {
            const speed = 0.14 + t * 0.12;
            n.x = lerp(n.x, fx, speed);
            n.y = lerp(n.y, fy, speed);
            if (this.entranceProgress >= 1) {
              n.x = fx; n.y = fy;
              delete (n as any)._finalX;
              delete (n as any)._finalY;
            }
          }
        }
        if (this.entranceProgress >= 1) {
          this.spatialGrid.rebuild(this.nodes);
        }
        animating = true;
      }

      // Animate node scales and opacity
      for (const n of this.nodes) {
        if (Math.abs(n.scale - n.targetScale) > 0.01) {
          n.scale = lerp(n.scale, n.targetScale, 0.15);
          animating = true;
        } else {
          n.scale = n.targetScale;
        }
        if (Math.abs(n.opacity - n.targetOpacity) > 0.01) {
          n.opacity = lerp(n.opacity, n.targetOpacity, 0.15);
          animating = true;
        } else {
          n.opacity = n.targetOpacity;
        }
      }

      if (animating || this.needsRender) {
        this.needsRender = false;
        this.render();
      }

      this.animFrame = requestAnimationFrame(tick);
    };
    this.animFrame = requestAnimationFrame(tick);
  }

  private scheduleRender(): void {
    this.needsRender = true;
  }

  // ── Tag colors ───────────────────────────────────────────

  private buildRenderEdges(): void {
    const CURVE_SPREAD = 0.25;
    const typeKey = (e: GraphEdge) => [e.source, e.target].sort().join('\0') + '\0' + e.type;
    const pairKey = (e: GraphEdge) => [e.source, e.target].sort().join('\0');

    const merged = new Map<string, GraphEdge & { bidir: boolean }>();
    for (const e of this.edges) {
      const tk = typeKey(e);
      if (merged.has(tk)) {
        merged.get(tk)!.bidir = true;
        continue;
      }
      merged.set(tk, { ...e, bidir: false });
    }

    const edgeList = [...merged.values()];

    // Count edges per node pair, assign curvature so multi-edges fan out
    const pairCount = new Map<string, number>();
    for (const e of edgeList) {
      const pk = pairKey(e);
      pairCount.set(pk, (pairCount.get(pk) || 0) + 1);
    }
    const pairIdx = new Map<string, number>();
    this.renderEdges = edgeList.map(e => {
      const pk = pairKey(e);
      const total = pairCount.get(pk)!;
      const idx = pairIdx.get(pk) || 0;
      pairIdx.set(pk, idx + 1);
      // Single edge: straight (curvature 0). Multi-edges: spread symmetrically
      const curvature = total <= 1 ? 0 : (idx - (total - 1) / 2) * CURVE_SPREAD;
      return { ...e, curvature };
    });
  }

  private buildTagColors(nodes: GraphNode[]): void {
    const freq = new Map<string, number>();
    for (const n of nodes) {
      for (const t of n.tags) {
        const root = t.split('/')[0];
        freq.set(root, (freq.get(root) || 0) + 1);
      }
    }
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    let ci = 0;
    for (const [tag] of sorted) {
      if (!this._tagColors.has(tag)) {
        this._tagColors.set(tag, TAG_PALETTE[ci % TAG_PALETTE.length]);
        ci++;
      }
    }
  }

  private nodeColor(n: GraphNode): string {
    switch (n.nodeType) {
      case 'tag': return this.theme.nodeTag;
      case 'folder': return this.theme.nodeFolder;
      case 'unresolved': return this.theme.nodeUnresolved;
      case 'asset': return this.theme.nodeAsset;
      default:
        if (n.tags.length > 0) {
          const root = n.tags[0].split('/')[0];
          return this._tagColors.get(root) || this.theme.accent;
        }
        return this.theme.accent;
    }
  }

  // ── Layout ───────────────────────────────────────────────

  private nodeSizeFactor(node: GraphNode): number {
    const len = node.contentLength ?? 0;
    const bl = node.backlinkCount ?? 0;

    let sizeFactor = 1;

    if (len < 200) sizeFactor = 0.7;
    else if (len < 500) sizeFactor = 0.82;
    else if (len < 1500) sizeFactor = 0.95;
    else if (len < 4000) sizeFactor = 1.1;
    else if (len < 10000) sizeFactor = 1.3;
    else sizeFactor = 1.55;

    if (bl >= 15) sizeFactor += 0.45;
    else if (bl >= 8) sizeFactor += 0.3;
    else if (bl >= 4) sizeFactor += 0.18;
    else if (bl >= 2) sizeFactor += 0.08;

    return sizeFactor;
  }

  private layoutNodes(raw: GraphNode[]): void {
    const cx = (this.width || 800) / 2;
    const cy = (this.height || 600) / 2;

    const adj = new Map<string, Set<string>>();
    for (const n of raw) adj.set(n.id, new Set());
    for (const e of this.edges) {
      adj.get(e.source)?.add(e.target);
      adj.get(e.target)?.add(e.source);
    }

    let center = this.focusNodeId;
    if (!center || !adj.has(center)) {
      let maxDeg = -1;
      for (const [id, neighbors] of adj) {
        if (neighbors.size > maxDeg) { maxDeg = neighbors.size; center = id; }
      }
    }
    if (!center) center = raw[0]?.id ?? '';

    const depthMap = new Map<string, number>();
    const queue: string[] = [center];
    depthMap.set(center, 0);
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const d = depthMap.get(cur)!;
      for (const nb of adj.get(cur) || []) {
        if (!depthMap.has(nb)) { depthMap.set(nb, d + 1); queue.push(nb); }
      }
    }
    for (const n of raw) {
      if (!depthMap.has(n.id)) depthMap.set(n.id, 999);
    }

    const maxDepth = Math.max(1, ...[...depthMap.values()].filter(d => d < 999));
    const ringGap = Math.min(cx, cy) * 0.7 / Math.max(maxDepth, 1);
    const byDepth = new Map<number, string[]>();
    for (const [id, d] of depthMap) {
      const arr = byDepth.get(d) || [];
      arr.push(id);
      byDepth.set(d, arr);
    }

    this.ctx.font = FONT;
    this.nodes = raw.map((n) => {
      const depth = depthMap.get(n.id) ?? 999;
      const ring = byDepth.get(depth) || [n.id];
      const idx = ring.indexOf(n.id);
      const count = ring.length;
      const angle = (2 * Math.PI * idx) / count - Math.PI / 2;
      const radius = depth === 0 ? 0 : ringGap * Math.min(depth, maxDepth + 1);

      const isFocusNode = n.id === this.focusNodeId;
      const sf = this.nodeSizeFactor(n) * (isFocusNode ? 1.15 : 1);
      const label = n.label.length > 24 ? n.label.slice(0, 22) + '…' : n.label;
      const textW = this.ctx.measureText(label).width;
      const w = (textW + NODE_PAD_X * 2 + (n.backlinkCount > 0 ? 20 : 0)) * sf;
      const h = NODE_H * sf;

      return {
        ...n,
        label,
        x: cx + Math.cos(angle) * radius + (depth === 999 ? (Math.random() - 0.5) * 200 : 0),
        y: cy + Math.sin(angle) * radius + (depth === 999 ? (Math.random() - 0.5) * 200 : 0),
        vx: 0, vy: 0,
        depth,
        w, h,
        color: isFocusNode ? this.theme.accent : this.nodeColor(n),
        dimmed: false,
        pinned: false,
        scale: 1,
        targetScale: 1,
        opacity: 0,
        targetOpacity: 1,
      };
    });
  }

  fitToView(animate = false): void {
    if (this.nodes.length === 0) return;
    const w = this.width || 800;
    const h = this.height || 600;
    const padding = 60;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.dimmed) continue;
      minX = Math.min(minX, n.x - n.w / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2);
      maxY = Math.max(maxY, n.y + n.h / 2);
    }
    if (!isFinite(minX)) {
      for (const n of this.nodes) {
        minX = Math.min(minX, n.x - n.w / 2);
        maxX = Math.max(maxX, n.x + n.w / 2);
        minY = Math.min(minY, n.y - n.h / 2);
        maxY = Math.max(maxY, n.y + n.h / 2);
      }
    }
    if (!isFinite(minX)) return;

    const rangeX = maxX - minX + padding * 2;
    const rangeY = maxY - minY + padding * 2;
    const zoom = Math.min(1.8, Math.max(0.2, Math.min(w / rangeX, h / rangeY)));

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    this.targetZoom = zoom;
    this.targetPanX = w / 2 - cx * zoom;
    this.targetPanY = h / 2 - cy * zoom;

    if (!animate) {
      this.zoom = this.targetZoom;
      this.panX = this.targetPanX;
      this.panY = this.targetPanY;
    }
  }

  // ── Simulation (short, just for overlap resolution) ──────

  private cancelSimulation(): void {
    if (this.simFrame !== null) {
      cancelAnimationFrame(this.simFrame);
      this.simFrame = null;
    }
  }

  private rebuildNodeMap(): void {
    this.nodeMap.clear();
    for (const n of this.nodes) this.nodeMap.set(n.id, n);
  }

  private simulate(): void {
    this.cancelSimulation();
    this.rebuildNodeMap();
    let iter = 0;
    const n = this.nodes.length;
    const maxIter = n > 200 ? 25 : n > 50 ? 35 : Math.min(50, 15 + n);

    const tick = () => {
      if (!this.isAnimating || iter >= maxIter) {
        this.simFrame = null;
        this.spatialGrid.rebuild(this.nodes);

        // Set viewport: for large graphs, start zoomed to a neighborhood
        const nodeCount = this.nodes.length;
        if (this.focusNodeId) {
          const focus = this.nodes.find(n => n.id === this.focusNodeId);
          if (focus) {
            const w = this.width || 800, h = this.height || 600;
            const z = nodeCount > 80 ? 1.2 : nodeCount > 30 ? 1 : 0.9;
            this.zoom = this.targetZoom = z;
            this.panX = this.targetPanX = w / 2 - focus.x * z;
            this.panY = this.targetPanY = h / 2 - focus.y * z;
          } else {
            this.fitToView();
          }
        } else if (nodeCount > 60) {
          const center = this.nodes.reduce(
            (acc, n) => { acc.x += n.x; acc.y += n.y; return acc; },
            { x: 0, y: 0 },
          );
          center.x /= nodeCount;
          center.y /= nodeCount;
          const w = this.width || 800, h = this.height || 600;
          const z = 0.9;
          this.zoom = this.targetZoom = z;
          this.panX = this.targetPanX = w / 2 - center.x * z;
          this.panY = this.targetPanY = h / 2 - center.y * z;
        } else {
          this.fitToView();
        }

        // Store final positions & start entrance from center
        const w = this.width || 800, h = this.height || 600;
        const cx = (w / 2 - this.panX) / this.zoom;
        const cy = (h / 2 - this.panY) / this.zoom;
        for (const n of this.nodes) {
          (n as any)._finalX = n.x;
          (n as any)._finalY = n.y;
          n.x = cx;
          n.y = cy;
          n.opacity = 0;
          n.targetOpacity = 1;
        }

        this.settled = true;
        this.entranceProgress = 0;
        this.scheduleRender();
        return;
      }

      const nodeCount = this.nodes.length;
      const repulsionRadius = nodeCount > 200 ? 200 : 300;
      if (nodeCount > 100) {
        for (const a of this.nodes) {
          if (a.pinned) continue;
          const nearby = this.spatialGrid.query(a.x, a.y, repulsionRadius);
          for (const b of nearby) {
            if (a === b) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const minDist = (a.w + b.w) / 2 + 60;
            if (dist < minDist) {
              const force = (minDist - dist) * 0.12;
              const fx = (dx / dist) * force, fy = (dy / dist) * force;
              a.vx -= fx; a.vy -= fy;
              if (!b.pinned) { b.vx += fx; b.vy += fy; }
            }
          }
        }
      } else {
        for (let i = 0; i < nodeCount; i++) {
          for (let j = i + 1; j < nodeCount; j++) {
            const a = this.nodes[i], b = this.nodes[j];
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dist > 300) continue;
            const minDist = (a.w + b.w) / 2 + 60;
            if (dist < minDist) {
              const force = (minDist - dist) * 0.12;
              const fx = (dx / dist) * force, fy = (dy / dist) * force;
              if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
              if (!b.pinned) { b.vx += fx; b.vy += fy; }
            }
          }
        }
      }

      for (const edge of this.edges) {
        const s = this.nodeMap.get(edge.source), t = this.nodeMap.get(edge.target);
        if (!s || !t) continue;
        const dx = t.x - s.x, dy = t.y - s.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const ideal = 180 + Math.abs(s.depth - t.depth) * 50;
        const force = (dist - ideal) * 0.006;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        if (!s.pinned) { s.vx += fx; s.vy += fy; }
        if (!t.pinned) { t.vx -= fx; t.vy -= fy; }
      }

      for (const node of this.nodes) {
        if (node.pinned) continue;
        node.vx *= 0.7;
        node.vy *= 0.7;
        node.x += node.vx;
        node.y += node.vy;
      }

      if (iter % 5 === 0) this.spatialGrid.rebuild(this.nodes);
      iter++;
      this.scheduleRender();
      this.simFrame = requestAnimationFrame(tick);
    };

    this.simFrame = requestAnimationFrame(tick);
  }

  // ── Rendering ────────────────────────────────────────────

  private render(): void {
    const ctx = this.ctx;
    const { bg, text, textMuted, border } = this.theme;

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.width, this.height);

    if (!this.settled) return;

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    // Viewport culling bounds (in world coords)
    const vpLeft = -this.panX / this.zoom - 200;
    const vpRight = (this.width - this.panX) / this.zoom + 200;
    const vpTop = -this.panY / this.zoom - 200;
    const vpBottom = (this.height - this.panY) / this.zoom + 200;

    const isVisible = (x: number, y: number, w: number, h = NODE_H) =>
      x + w / 2 > vpLeft && x - w / 2 < vpRight && y + h > vpTop && y - h < vpBottom;

    const nodeMap = this.nodeMap;

    // ── Edges ──────────────────────────────────────────
    ctx.lineCap = 'round';

    for (const edge of this.renderEdges) {
      if (!this.edgeFilters.has(edge.type)) continue;
      const s = nodeMap.get(edge.source), t = nodeMap.get(edge.target);
      if (!s || !t || s.dimmed || t.dimmed) continue;
      if (!isVisible(s.x, s.y, s.w) && !isVisible(t.x, t.y, t.w)) continue;

      const style = EDGE_STYLES[edge.type] || EDGE_STYLES.link;
      const isHovered = s === this.hovered || t === this.hovered ||
                        s === this.selected || t === this.selected;

      const edgeAlpha = Math.min(s.opacity, t.opacity);
      if (edgeAlpha < 0.01) continue;

      const dx = t.x - s.x, dy = t.y - s.y;
      const edgeCol = this.edgeColor(edge.type);
      const alpha = (isHovered ? Math.min(style.alpha + 0.25, 0.9) : style.alpha) * edgeAlpha;

      // Compute bezier control point for curved multi-edges
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
      const edgeLen = Math.sqrt(dx * dx + dy * dy) || 1;
      const perpX = -dy / edgeLen;
      const perpY = dx / edgeLen;
      const cpx = mx + perpX * edge.curvature * edgeLen;
      const cpy = my + perpY * edge.curvature * edgeLen;

      // Border points: aim toward the control point for curved edges
      const sdx = cpx - s.x, sdy = cpy - s.y;
      const tdx = cpx - t.x, tdy = cpy - t.y;
      const [x0, y0] = edge.curvature === 0
        ? this.rectBorderPoint(s, dx, dy)
        : this.rectBorderPoint(s, sdx, sdy);
      const [x1, y1] = edge.curvature === 0
        ? this.rectBorderPoint(t, -dx, -dy)
        : this.rectBorderPoint(t, tdx, tdy);

      ctx.beginPath();
      ctx.setLineDash(style.dash);
      ctx.lineWidth = isHovered ? style.width + 0.6 : style.width;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = edgeCol;
      ctx.moveTo(x0, y0);
      if (edge.curvature === 0) {
        ctx.lineTo(x1, y1);
      } else {
        ctx.quadraticCurveTo(cpx, cpy, x1, y1);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const isDirectional = edge.type === 'link' || edge.type === 'backlink' || edge.type === 'parent'
        || edge.type === 'tag-link' || edge.type === 'folder-link'
        || edge.type === 'unresolved' || edge.type === 'asset-ref';
      if (isDirectional || edge.bidir) {
        const sz = isHovered ? 7 : 5;
        const halfAngle = 0.35;
        ctx.fillStyle = edgeCol;
        ctx.globalAlpha = alpha * 0.85;

        // Tangent at target (derivative of quadratic bezier at t=1)
        const tgtTanX = edge.curvature === 0 ? (x1 - x0) : (x1 - cpx);
        const tgtTanY = edge.curvature === 0 ? (y1 - y0) : (y1 - cpy);
        const tgtAngle = Math.atan2(tgtTanY, tgtTanX);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - Math.cos(tgtAngle - halfAngle) * sz, y1 - Math.sin(tgtAngle - halfAngle) * sz);
        ctx.lineTo(x1 - Math.cos(tgtAngle + halfAngle) * sz, y1 - Math.sin(tgtAngle + halfAngle) * sz);
        ctx.closePath();
        ctx.fill();

        if (edge.bidir) {
          // Tangent at source (derivative at t=0)
          const srcTanX = edge.curvature === 0 ? (x0 - x1) : (x0 - cpx);
          const srcTanY = edge.curvature === 0 ? (y0 - y1) : (y0 - cpy);
          const srcAngle = Math.atan2(srcTanY, srcTanX);

          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x0 - Math.cos(srcAngle - halfAngle) * sz, y0 - Math.sin(srcAngle - halfAngle) * sz);
          ctx.lineTo(x0 - Math.cos(srcAngle + halfAngle) * sz, y0 - Math.sin(srcAngle + halfAngle) * sz);
          ctx.closePath();
          ctx.fill();
        }
      }

      ctx.globalAlpha = 1;

      // Edge labels removed for cleaner visual
    }
    ctx.lineCap = 'butt';

    // ── Nodes ──────────────────────────────────────────
    for (const node of this.nodes) {
      if (!isVisible(node.x, node.y, node.w, node.h)) continue;
      if (node.opacity < 0.01) continue;

      const isFocus = node.id === this.focusNodeId;
      const isHov = node === this.hovered;
      const isSel = node === this.selected;
      const isDimmed = node.dimmed;
      const sc = node.scale;
      const active = (isHov || isSel) && !isDimmed;
      const shape = NODE_TYPE_SHAPES[node.nodeType] || 'rect';
      const nColor = node.color;

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.18 * node.opacity : node.opacity;

      if (sc !== 1) {
        ctx.translate(node.x, node.y);
        ctx.scale(sc, sc);
        ctx.translate(-node.x, -node.y);
      }

      const x = node.x - node.w / 2;
      const y = node.y - node.h / 2;

      // Focus node: strong glow to make it unmistakable
      if (isFocus && !isDimmed) {
        ctx.shadowColor = `${this.theme.accent}88`;
        ctx.shadowBlur = 20;
      }

      // Background shape
      const radius = shape === 'pill' ? node.h / 2 : NODE_RADIUS;
      if (shape === 'diamond') {
        ctx.beginPath();
        ctx.moveTo(node.x, y);
        ctx.lineTo(node.x + node.w / 2, node.y);
        ctx.lineTo(node.x, y + node.h);
        ctx.lineTo(node.x - node.w / 2, node.y);
        ctx.closePath();
      } else {
        this.roundRect(ctx, x, y, node.w, node.h, radius);
      }

      // Fill with node type-specific tint
      if (node.nodeType !== 'note') {
        ctx.fillStyle = active ? `${nColor}30` : `${nColor}15`;
      } else if (isFocus) {
        ctx.fillStyle = `${this.theme.accent}28`;
      } else {
        ctx.fillStyle = active ? this.theme.surface : `${this.theme.surface}ee`;
      }
      ctx.fill();

      // Draw second glow pass for focus node (double glow for prominence)
      if (isFocus && !isDimmed) {
        ctx.shadowColor = `${this.theme.accent}55`;
        ctx.shadowBlur = 30;
        ctx.fill();
      }

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // Border
      if (shape === 'dashed') {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = `${nColor}88`;
        ctx.lineWidth = 1;
      } else if (isFocus) {
        ctx.strokeStyle = `${this.theme.accent}99`;
        ctx.lineWidth = 2;
      } else if (node.nodeType !== 'note') {
        ctx.strokeStyle = `${nColor}55`;
        ctx.lineWidth = 0.8;
      } else if (active) {
        ctx.strokeStyle = `${border}aa`;
        ctx.lineWidth = 0.8;
      } else {
        ctx.strokeStyle = `${border}44`;
        ctx.lineWidth = 0.5;
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Node type icon prefix
      let labelPrefix = '';
      if (node.nodeType === 'tag') labelPrefix = '';
      else if (node.nodeType === 'folder') labelPrefix = '📁 ';
      else if (node.nodeType === 'unresolved') labelPrefix = '⚠ ';
      else if (node.nodeType === 'asset') labelPrefix = '📎 ';

      // Label
      ctx.font = (active || isFocus) ? FONT_BOLD : FONT;
      ctx.fillStyle = node.nodeType !== 'note' ? nColor : isFocus ? '#ffffff' : active ? text : `${text}dd`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const displayLabel = labelPrefix + node.label;
      const labelX = node.backlinkCount > 0 && !isDimmed && node.nodeType === 'note' ? node.x - 6 : node.x;
      ctx.fillText(displayLabel, labelX, node.y + 0.5);

      // Count badge for note nodes
      if (!isDimmed && node.backlinkCount > 0 && node.nodeType === 'note' && this.zoom > 0.4) {
        const labelFont = (active || isFocus) ? FONT_BOLD : FONT;
        ctx.font = labelFont;
        const labelW = ctx.measureText(displayLabel).width;
        ctx.font = FONT_SMALL;
        ctx.fillStyle = `${textMuted}99`;
        ctx.textAlign = 'left';
        ctx.fillText(String(node.backlinkCount), labelX + labelW / 2 + 5, node.y + 1);
      }

      ctx.restore();
    }

    ctx.restore();
  }

  private edgeColor(type: EdgeType): string {
    switch (type) {
      case 'link': return this.theme.edgeLink;
      case 'backlink': return this.theme.edgeLink;
      case 'parent': return this.theme.edgeParent;
      case 'shared-tag': return this.theme.edgeTag;
      case 'sibling': return this.theme.edgeSibling;
      case 'shared-folder': return this.theme.edgeFolder;
      case 'tag-link': return this.theme.edgeTag;
      case 'folder-link': return this.theme.edgeFolder;
      case 'unresolved': return this.theme.edgeUnresolved;
      case 'asset-ref': return this.theme.edgeAsset;
      default: return this.theme.border;
    }
  }

  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  private rectBorderPoint(node: LayoutNode, dx: number, dy: number): [number, number] {
    const hw = node.w / 2 + 2;
    const hh = node.h / 2 + 2;
    if (dx === 0 && dy === 0) return [node.x, node.y - hh];
    const adx = Math.abs(dx), ady = Math.abs(dy);
    const scaleX = adx > 0 ? hw / adx : Infinity;
    const scaleY = ady > 0 ? hh / ady : Infinity;
    const s = Math.min(scaleX, scaleY);
    return [node.x + dx * s, node.y + dy * s];
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ── Hit testing ──────────────────────────────────────────

  private toWorld(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    return [(cx - this.panX) / this.zoom, (cy - this.panY) / this.zoom];
  }

  private hitTest(wx: number, wy: number): LayoutNode | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (n.dimmed) continue;
      const left = n.x - n.w / 2, top = n.y - n.h / 2;
      if (wx >= left && wx <= left + n.w && wy >= top && wy <= top + n.h) {
        return n;
      }
    }
    return null;
  }

  // ── Events ───────────────────────────────────────────────

  private setupEvents(): void {
    const sig = { signal: this.abortCtrl.signal };
    let mouseDownNode: LayoutNode | null = null;
    let didPan = false;

    this.canvas.addEventListener('mousedown', (e) => {
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      mouseDownNode = this.hitTest(wx, wy);
      didPan = false;

      this.isPanning = true;
      this.panAnchorX = e.clientX;
      this.panAnchorY = e.clientY;
      this.panAnchorPanX = this.targetPanX;
      this.panAnchorPanY = this.targetPanY;
      this.canvas.style.cursor = mouseDownNode ? 'pointer' : 'grabbing';
      if (!this.isHoveringTooltip) this.hideTooltip();
    }, sig);

    this.canvas.addEventListener('mousemove', (e) => {
      if (this.isPanning) {
        const dx = Math.abs(e.clientX - this.panAnchorX);
        const dy = Math.abs(e.clientY - this.panAnchorY);
        if (dx + dy > 4) didPan = true;
        this.targetPanX = this.panAnchorPanX + (e.clientX - this.panAnchorX);
        this.targetPanY = this.panAnchorPanY + (e.clientY - this.panAnchorY);
        this.panX = this.targetPanX;
        this.panY = this.targetPanY;
        this.scheduleRender();
        return;
      }

      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      const hit = this.hitTest(wx, wy);
      if (hit !== this.hovered) {
        if (this.hovered) this.hovered.targetScale = 1;
        this.hovered = hit;
        if (hit) hit.targetScale = 1.04;
        this.canvas.style.cursor = hit ? 'pointer' : 'grab';
        if (!this.selected) this.updateDimming();
        this.updateTooltip(e, hit);
        this.scheduleRender();
        this.options.onNodeHover?.(hit?.id ?? null);
      } else if (hit) {
        this.updateTooltip(e, hit);
      }
    }, sig);

    this.canvas.addEventListener('mouseup', (e) => {
      this.isPanning = false;
      this.canvas.style.cursor = this.hovered ? 'pointer' : 'grab';

      if (!didPan && mouseDownNode) {
        // Click on node: select it and show detail
        this.selected = mouseDownNode;
        this.updateDimming();
        this.showDetailPanel(mouseDownNode, e);
        this.scheduleRender();
      } else if (!didPan && !mouseDownNode) {
        // Click on empty space: deselect
        if (this.selected) {
          this.selected = null;
          this.hideDetailPanel();
          for (const n of this.nodes) n.dimmed = false;
          this.scheduleRender();
        }
      }
      mouseDownNode = null;
    }, sig);

    this.canvas.addEventListener('mouseleave', () => {
      this.isPanning = false;
      if (this.hovered) {
        this.hovered.targetScale = 1;
        this.hovered = null;
        if (!this.selected) this.updateDimming();
        this.scheduleRender();
      }
      if (this.tooltipNode) {
        this.scheduleTooltipHide();
      }
    }, sig);

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const oldZoom = this.targetZoom;
      const factor = e.deltaY > 0 ? 0.92 : 1.09;
      this.targetZoom = Math.max(0.1, Math.min(5, this.targetZoom * factor));
      this.targetPanX = mx - (mx - this.targetPanX) * (this.targetZoom / oldZoom);
      this.targetPanY = my - (my - this.targetPanY) * (this.targetZoom / oldZoom);
    }, { passive: false, signal: this.abortCtrl.signal });

    this.canvas.addEventListener('dblclick', (e) => {
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      const hit = this.hitTest(wx, wy);
      if (hit && hit.nodeType === 'note') this.options.onNodeClick?.(hit.id);
    }, sig);
  }

  // ── Keyboard ──────────────────────────────────────────────

  private setupKeyboard(): void {
    this.canvas.addEventListener('keydown', (e: KeyboardEvent) => {
      // Cmd/Ctrl+F to focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        const overlay = this.container.closest('#graph-overlay') || this.container.closest('body');
        const filterInput = overlay?.querySelector('#graph-filter') as HTMLInputElement;
        if (filterInput) { filterInput.focus(); filterInput.select(); }
        return;
      }

      const visibleNodes = this.nodes.filter(n => !n.dimmed);
      if (visibleNodes.length === 0) return;

      switch (e.key) {
        case 'Tab': {
          e.preventDefault();
          const idx = this.selected ? visibleNodes.indexOf(this.selected) : -1;
          const next = e.shiftKey
            ? (idx <= 0 ? visibleNodes.length - 1 : idx - 1)
            : (idx + 1) % visibleNodes.length;
          this.selected = visibleNodes[next];
          this.panToNode(this.selected);
          break;
        }
        case 'ArrowRight': case 'ArrowLeft': case 'ArrowUp': case 'ArrowDown': {
          e.preventDefault();
          if (!this.selected) { this.selected = visibleNodes[0]; this.panToNode(this.selected); break; }
          const nearest = this.findNearest(this.selected, visibleNodes, e.key);
          if (nearest) { this.selected = nearest; this.panToNode(this.selected); }
          break;
        }
        case 'Enter': {
          if (this.selected) this.options.onNodeClick?.(this.selected.id);
          break;
        }
        case 'Escape': {
          if (this.selected) {
            this.selected = null;
            this.hideDetailPanel();
            for (const n of this.nodes) n.dimmed = false;
            this.scheduleRender();
          } else {
            this.options.onEscape?.();
          }
          break;
        }
        case '/': {
          e.preventDefault();
          const searchBar = this.container.closest('#graph-overlay')?.querySelector('#graph-search-bar') as HTMLElement;
          if (searchBar) searchBar.style.display = 'flex';
          const filterInput = this.container.closest('#graph-overlay')?.querySelector('#graph-filter') as HTMLInputElement;
          if (filterInput) { filterInput.focus(); filterInput.select(); }
          break;
        }
        case '+': case '=': {
          this.targetZoom = Math.min(5, this.targetZoom * 1.15);
          break;
        }
        case '-': {
          this.targetZoom = Math.max(0.1, this.targetZoom * 0.85);
          break;
        }
        case '0': {
          this.fitToView(true);
          break;
        }
        case 'c': case 'C': {
          if (this.focusNodeId) {
            const focus = this.nodes.find(n => n.id === this.focusNodeId);
            if (focus) {
              this.targetPanX = (this.width || 800) / 2 - focus.x * this.targetZoom;
              this.targetPanY = (this.height || 600) / 2 - focus.y * this.targetZoom;
              break;
            }
          }
          this.fitToView(true);
          break;
        }
        case 'f': case 'F': {
          this.fitToView(true);
          break;
        }
      }
    }, { signal: this.abortCtrl.signal });
  }

  private findNearest(from: LayoutNode, candidates: LayoutNode[], dir: string): LayoutNode | null {
    let best: LayoutNode | null = null;
    let bestDist = Infinity;
    for (const c of candidates) {
      if (c === from) continue;
      const dx = c.x - from.x, dy = c.y - from.y;
      const ok = dir === 'ArrowRight' ? dx > 10 :
                 dir === 'ArrowLeft' ? dx < -10 :
                 dir === 'ArrowDown' ? dy > 10 :
                 dy < -10;
      if (!ok) continue;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) { bestDist = dist; best = c; }
    }
    return best;
  }

  private panToNode(node: LayoutNode): void {
    const cx = (this.width || 800) / 2;
    const cy = (this.height || 600) / 2;
    this.targetPanX = cx - node.x * this.targetZoom;
    this.targetPanY = cy - node.y * this.targetZoom;
  }

  // ── Dimming (fade unconnected nodes on hover) ────────────

  private updateDimming(): void {
    const target = this.hovered || this.selected;
    if (!target) {
      for (const n of this.nodes) n.dimmed = false;
      return;
    }
    const connected = new Set<string>([target.id]);
    for (const e of this.edges) {
      if (e.source === target.id) connected.add(e.target);
      if (e.target === target.id) connected.add(e.source);
    }
    for (const n of this.nodes) {
      n.dimmed = !connected.has(n.id);
    }
  }

  // ── Tooltip ──────────────────────────────────────────────

  private hideTooltip(): void {
    if (this.tooltipHideTimer) {
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }
    this.tooltip.style.display = 'none';
    this.tooltip.style.pointerEvents = 'none';
    this.tooltip.classList.remove('visible');
    this.tooltipNode = null;
    this.isHoveringTooltip = false;
  }

  private scheduleTooltipHide(): void {
    if (this.tooltipHideTimer) clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = setTimeout(() => {
      this.tooltipHideTimer = null;
      if (!this.isHoveringTooltip && this.hovered !== this.tooltipNode) {
        this.hideTooltip();
      }
    }, 300);
  }

  private updateTooltip(e: MouseEvent, node: LayoutNode | null): void {
    if (!node) {
      // Mouse left the node — schedule a delayed hide so user can reach the tooltip
      if (this.tooltipNode) {
        this.scheduleTooltipHide();
      }
      return;
    }

    const rect = this.canvas.getBoundingClientRect();

    // Build structured HTML
    const typeLabel = node.nodeType !== 'note' ? `<span class="gtt-type gtt-type-${node.nodeType}">${node.nodeType}</span>` : '';
    let html = `<div class="gtt-title">${this.esc(node.label)}${typeLabel}</div>`;

    if (node.nodeType === 'note' && node.tags.length > 0) {
      html += `<div class="gtt-tags">${node.tags.map(t => `<span class="gtt-tag">#${this.esc(t)}</span>`).join('')}</div>`;
    }

    if (node.folder) {
      html += `<div class="gtt-stats" style="opacity:0.5">${this.esc(node.folder)}/</div>`;
    }

    const stats: string[] = [];
    if (node.backlinkCount > 0) stats.push(`${node.backlinkCount} in`);
    if (node.outgoingCount > 0) stats.push(`${node.outgoingCount} out`);
    if (node.childCount > 0) stats.push(`${node.childCount} children`);
    if (node.isOrphan) stats.push('orphan');
    if (stats.length > 0) {
      html += `<div class="gtt-stats">${stats.join(' · ')}</div>`;
    }

    if (this.focusNodeId && node.id !== this.focusNodeId) {
      for (const edge of this.edges) {
        if ((edge.source === this.focusNodeId && edge.target === node.id) ||
            (edge.target === this.focusNodeId && edge.source === node.id)) {
          const reason = edge.reason || (edge.type === 'link' ? 'linked' : edge.type === 'parent' ? 'parent' : edge.type);
          html += `<div class="gtt-relation">↳ ${this.esc(reason)}</div>`;
          break;
        }
      }
    }

    const headings = node.headings;
    if (headings && headings.length > 0) {
      html += '<div class="gtt-outline-wrap"><div class="gtt-outline">';
      for (const h of headings) {
        const indent = Math.max(0, h.level - 1);
        html += `<div class="gtt-heading" style="padding-left:${indent * 10}px">`
          + `<span class="gtt-h-marker">${'#'.repeat(h.level)}</span> ${this.esc(h.text)}</div>`;
      }
      html += '</div></div>';
    }

    // Cancel any pending hide since we're showing for a new/same node
    if (this.tooltipHideTimer) {
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }
    this.tooltipNode = node;

    this.tooltip.innerHTML = html;
    this.tooltip.style.display = 'block';
    this.tooltip.style.pointerEvents = 'auto';
    // Force reflow before adding class for transition
    void this.tooltip.offsetHeight;
    this.tooltip.classList.add('visible');

    // Position — prefer right of cursor, flip if near edge
    const ttW = this.tooltip.offsetWidth;
    const ttH = this.tooltip.offsetHeight;
    let left = e.clientX - rect.left + 16;
    let top = e.clientY - rect.top - 10;
    if (left + ttW > rect.width - 8) left = e.clientX - rect.left - ttW - 12;
    if (top + ttH > rect.height - 8) top = rect.height - ttH - 8;
    if (top < 8) top = 8;
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Detail panel (persistent, on click) ──────────────────

  private showDetailPanel(node: LayoutNode, _e: MouseEvent): void {
    if (!this.detailPanel) {
      this.detailPanel = document.createElement('div');
      this.detailPanel.className = 'kivi-graph-detail';
      this.container.appendChild(this.detailPanel);
    }

    const detailTypeLabel = node.nodeType !== 'note' ? `<span class="gtt-type gtt-type-${node.nodeType}">${node.nodeType}</span>` : '';
    let html = `<div class="gtt-title">${this.esc(node.label)}${detailTypeLabel}</div>`;
    html += `<div class="gtt-stats" style="opacity:0.5;font-size:9px">${this.esc(node.id)}</div>`;

    if (node.nodeType === 'note' && node.tags.length > 0) {
      html += `<div class="gtt-tags">${node.tags.map(t => `<span class="gtt-tag">#${this.esc(t)}</span>`).join('')}</div>`;
    }

    if (node.folder) {
      html += `<div class="gtt-stats" style="opacity:0.5">${this.esc(node.folder)}/</div>`;
    }

    const stats: string[] = [];
    if (node.backlinkCount > 0) stats.push(`${node.backlinkCount} backlinks`);
    if (node.outgoingCount > 0) stats.push(`${node.outgoingCount} outgoing`);
    if (node.childCount > 0) stats.push(`${node.childCount} children`);
    if (node.contentLength) stats.push(`${(node.contentLength / 1024).toFixed(1)}kb`);
    if (node.isOrphan) stats.push('orphan');
    if (stats.length > 0) {
      html += `<div class="gtt-stats">${stats.join(' · ')}</div>`;
    }

    // Connections summary
    const connections = this.edges.filter(e => e.source === node.id || e.target === node.id);
    if (connections.length > 0) {
      const byType = new Map<string, number>();
      for (const e of connections) byType.set(e.type, (byType.get(e.type) || 0) + 1);
      const connStr = [...byType.entries()].map(([t, c]) => `${c} ${t}`).join(', ');
      html += `<div class="gtt-stats" style="opacity:0.6">Edges: ${connStr}</div>`;
    }

    const headings = node.headings;
    if (headings && headings.length > 0) {
      html += '<div class="gtt-outline-wrap" style="max-height:180px"><div class="gtt-outline">';
      for (const h of headings) {
        const indent = Math.max(0, h.level - 1);
        html += `<div class="gtt-heading" style="padding-left:${indent * 10}px">`
          + `<span class="gtt-h-marker">${'#'.repeat(h.level)}</span> ${this.esc(h.text)}</div>`;
      }
      html += '</div></div>';
    }

    const canOpen = node.nodeType === 'note';
    html += `<div class="gtt-actions">${canOpen ? '<button class="gtt-open-btn">Open File</button>' : ''}</div>`;

    this.detailPanel.innerHTML = html;
    this.detailPanel.style.display = 'block';
    void this.detailPanel.offsetHeight;
    this.detailPanel.classList.add('visible');

    if (node.nodeType === 'note') {
      const openBtn = this.detailPanel.querySelector('.gtt-open-btn');
      openBtn?.addEventListener('click', () => {
        this.options.onNodeClick?.(node.id);
      });
    }
  }

  private hideDetailPanel(): void {
    if (this.detailPanel) {
      this.detailPanel.style.display = 'none';
      this.detailPanel.classList.remove('visible');
    }
  }
}
