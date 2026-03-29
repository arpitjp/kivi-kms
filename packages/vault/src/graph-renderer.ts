import type { GraphNode, GraphEdge } from './types.js';

interface ForceNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  depth: number;
  tagColor: string;
  filteredOut: boolean;
}

interface RenderOptions {
  width: number;
  height: number;
  onNodeClick?: (nodeId: string) => void;
  accentColor?: string;
  accentHover?: string;
  textColor?: string;
  bgColor?: string;
  borderColor?: string;
  edgeColor?: string;
}

const DRAG_THRESHOLD = 5;
const DPR = typeof window !== 'undefined' ? (window.devicePixelRatio || 2) : 2;

const TAG_PALETTE = [
  '#4fc1ff', '#4ec9b0', '#ce9178', '#dcdcaa',
  '#c586c0', '#9cdcfe', '#6a9955', '#d16969',
];

/**
 * Canvas-based graph renderer with radial mind-map layout.
 * Nodes are colored by their primary tag and sized by connectivity.
 * Supports filtering, depth limiting, zoom/pan, drag, and click-to-navigate.
 */
export class GraphRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nodes: ForceNode[] = [];
  private edges: GraphEdge[] = [];
  private animationFrame: number | null = null;
  private options: RenderOptions;
  private dragging: ForceNode | null = null;
  private dragMoved = false;
  private hoveredNode: ForceNode | null = null;
  private offsetX = 0;
  private offsetY = 0;
  private scale = 1;
  private tooltip: HTMLDivElement | null = null;
  _tagColors: Map<string, string> = new Map();

  constructor(container: HTMLElement, options: Partial<RenderOptions> = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.cursor = 'grab';
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d')!;
    const cs = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null;
    this.options = {
      width: container.clientWidth || 400,
      height: container.clientHeight || 300,
      accentColor: cs?.getPropertyValue('--accent')?.trim() || '#4fc1ff',
      accentHover: cs?.getPropertyValue('--accent-hover')?.trim() || '#3aafe8',
      textColor: cs?.getPropertyValue('--text')?.trim() || '#d4d4d4',
      bgColor: cs?.getPropertyValue('--bg')?.trim() || '#1e1e1e',
      borderColor: cs?.getPropertyValue('--border')?.trim() || '#3c3c3c',
      edgeColor: options.edgeColor || cs?.getPropertyValue('--text-muted')?.trim() || '#858585',
      onNodeClick: options.onNodeClick,
      ...options,
    };

    this.applyDpr();
    this.setupInteraction();
    this.createTooltip(container);
  }

  private applyDpr(): void {
    this.canvas.width = this.options.width * DPR;
    this.canvas.height = this.options.height * DPR;
    this.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  private createTooltip(container: HTMLElement): void {
    this.tooltip = document.createElement('div');
    this.tooltip.style.cssText =
      'position:absolute;display:none;padding:6px 10px;background:var(--bg-surface, rgba(0,0,0,0.9));color:var(--text, #d4d4d4);' +
      'font-size:11px;border-radius:6px;pointer-events:none;white-space:pre-line;z-index:10;border:1px solid var(--border, #3c3c3c);' +
      'max-width:240px;line-height:1.4;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
    container.style.position = 'relative';
    container.appendChild(this.tooltip);
  }

  private refreshTheme(): void {
    if (typeof window === 'undefined') return;
    const cs = getComputedStyle(document.documentElement);
    this.options.accentColor = cs.getPropertyValue('--accent')?.trim() || this.options.accentColor;
    this.options.accentHover = cs.getPropertyValue('--accent-hover')?.trim() || this.options.accentHover;
    this.options.textColor = cs.getPropertyValue('--text')?.trim() || this.options.textColor;
    this.options.bgColor = cs.getPropertyValue('--bg')?.trim() || this.options.bgColor;
    this.options.borderColor = cs.getPropertyValue('--border')?.trim() || this.options.borderColor;
    this.options.edgeColor = cs.getPropertyValue('--text-muted')?.trim() || this.options.edgeColor;
  }

  private getNodeColor(node: ForceNode): string {
    if (node.tagColor) return node.tagColor;
    if (node.tags.length > 0) {
      const primary = node.tags[0].split('/')[0];
      if (this._tagColors.has(primary)) return this._tagColors.get(primary)!;
    }
    return this.options.accentColor!;
  }

  setData(nodes: GraphNode[], edges: GraphEdge[]): void {
    this.refreshTheme();

    // Assign tag colors
    const tagSet = new Map<string, number>();
    for (const n of nodes) {
      for (const t of n.tags) {
        const root = t.split('/')[0];
        tagSet.set(root, (tagSet.get(root) || 0) + 1);
      }
    }
    const sortedTags = [...tagSet.entries()].sort((a, b) => b[1] - a[1]);
    let ci = 0;
    for (const [tag] of sortedTags) {
      if (!this._tagColors.has(tag)) {
        this._tagColors.set(tag, TAG_PALETTE[ci % TAG_PALETTE.length]);
        ci++;
      }
    }

    const cx = this.options.width / 2;
    const cy = this.options.height / 2;

    // Build adjacency for BFS depth
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const e of edges) {
      adj.get(e.source)?.add(e.target);
      adj.get(e.target)?.add(e.source);
    }

    // Find most connected node as center
    let centerNode = nodes[0]?.id;
    let maxDegree = 0;
    for (const [id, neighbors] of adj) {
      if (neighbors.size > maxDegree) {
        maxDegree = neighbors.size;
        centerNode = id;
      }
    }

    // BFS from center
    const depthMap = new Map<string, number>();
    const queue: string[] = [centerNode];
    depthMap.set(centerNode, 0);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const d = depthMap.get(cur)!;
      for (const neighbor of adj.get(cur) || []) {
        if (!depthMap.has(neighbor)) {
          depthMap.set(neighbor, d + 1);
          queue.push(neighbor);
        }
      }
    }

    // Position in concentric rings (radial layout)
    const maxDepth = Math.max(1, ...[...depthMap.values()]);
    const ringGap = Math.min(cx, cy) * 0.7 / maxDepth;
    const byDepth = new Map<number, string[]>();
    for (const [id, d] of depthMap) {
      const arr = byDepth.get(d) || [];
      arr.push(id);
      byDepth.set(d, arr);
    }

    this.nodes = nodes.map((n) => {
      const depth = depthMap.get(n.id) ?? maxDepth;
      const ring = byDepth.get(depth) || [n.id];
      const idx = ring.indexOf(n.id);
      const count = ring.length;
      const angle = (2 * Math.PI * idx) / count - Math.PI / 2;
      const radius = depth === 0 ? 0 : ringGap * depth;
      const primaryTag = n.tags.length > 0 ? n.tags[0].split('/')[0] : '';
      return {
        ...n,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        depth,
        tagColor: this._tagColors.get(primaryTag) || '',
        filteredOut: false,
      };
    });

    // Add disconnected nodes not reached by BFS
    for (const node of this.nodes) {
      if (!depthMap.has(node.id)) {
        node.depth = maxDepth + 1;
        node.x = cx + (Math.random() - 0.5) * cx;
        node.y = cy + (Math.random() - 0.5) * cy;
      }
    }

    this.edges = edges;
    this.simulate();
  }

  private simulate(): void {
    let iterations = 0;
    const maxIterations = Math.min(150, 40 + this.nodes.length * 2);

    const tick = () => {
      if (iterations >= maxIterations) {
        this.render();
        return;
      }

      const n = this.nodes.length;
      const cutoffDist = n > 80 ? 250 : Infinity;

      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = this.nodes[i];
          const b = this.nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist > cutoffDist) continue;
          const force = 600 / (dist * dist);
          dx = (dx / dist) * force;
          dy = (dy / dist) * force;
          a.vx -= dx;
          a.vy -= dy;
          b.vx += dx;
          b.vy += dy;
        }
      }

      const nodeMap = new Map(this.nodes.map((nd) => [nd.id, nd]));
      for (const edge of this.edges) {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);
        if (!source || !target) continue;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const idealDist = 80 + Math.abs(source.depth - target.depth) * 40;
        const force = (dist - idealDist) * 0.008;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      }

      const cx = this.options.width / 2;
      const cy = this.options.height / 2;
      for (const node of this.nodes) {
        node.vx += (cx - node.x) * 0.003;
        node.vy += (cy - node.y) * 0.003;
      }

      for (const node of this.nodes) {
        if (node === this.dragging) continue;
        node.vx *= 0.78;
        node.vy *= 0.78;
        node.x += node.vx;
        node.y += node.vy;
      }

      iterations++;
      this.render();
      this.animationFrame = requestAnimationFrame(tick);
    };

    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = requestAnimationFrame(tick);
  }

  private nodeRadius(node: ForceNode): number {
    const base = node.depth === 0 ? 10 : 5;
    return base + Math.min(node.backlinkCount * 1.5, 10);
  }

  private render(): void {
    const ctx = this.ctx;
    const { width, height, bgColor, textColor } = this.options;

    ctx.fillStyle = bgColor!;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    // Draw edges as subtle curves
    const nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
    for (const edge of this.edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;
      if (source.filteredOut || target.filteredOut) continue;

      ctx.beginPath();
      ctx.moveTo(source.x, source.y);

      // Slight curve for visual distinction
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const off = Math.min(Math.sqrt(dx * dx + dy * dy) * 0.1, 20);
      ctx.quadraticCurveTo(midX - dy * 0.05 + off * 0.2, midY + dx * 0.05, target.x, target.y);

      const isHovered = source === this.hoveredNode || target === this.hoveredNode;
      ctx.strokeStyle = isHovered
        ? this.options.edgeColor!
        : `${this.options.borderColor}88`;
      ctx.lineWidth = isHovered ? 1.5 : 0.8;
      ctx.stroke();

      // Direction arrow for hovered edges
      if (isHovered) {
        const angle = Math.atan2(target.y - source.y, target.x - source.x);
        const tr = this.nodeRadius(target) + 2;
        const ax = target.x - Math.cos(angle) * tr;
        const ay = target.y - Math.sin(angle) * tr;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(angle - 0.3) * 6, ay - Math.sin(angle - 0.3) * 6);
        ctx.lineTo(ax - Math.cos(angle + 0.3) * 6, ay - Math.sin(angle + 0.3) * 6);
        ctx.closePath();
        ctx.fillStyle = this.options.edgeColor!;
        ctx.fill();
      }
    }

    // Draw nodes
    for (const node of this.nodes) {
      if (node.filteredOut) continue;
      const radius = this.nodeRadius(node);
      const isHovered = node === this.hoveredNode;
      const color = this.getNodeColor(node);

      // Glow for center node
      if (node.depth === 0) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 6, 0, Math.PI * 2);
        ctx.fillStyle = `${color}15`;
        ctx.fill();
      }

      // Node body
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      if (isHovered) {
        ctx.fillStyle = this.options.accentHover!;
        ctx.fill();
        ctx.strokeStyle = textColor!;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha = node.depth === 0 ? 1 : Math.max(0.5, 1 - node.depth * 0.15);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Label
      const fontSize = node.depth === 0 ? 11 : (isHovered ? 10 : 9);
      ctx.fillStyle = isHovered ? textColor! : `${textColor}cc`;
      ctx.font = `${isHovered || node.depth === 0 ? '600 ' : ''}${fontSize}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = node.label.length > 18 ? node.label.slice(0, 16) + '…' : node.label;
      ctx.fillText(label, node.x, node.y + radius + 4);
    }

    ctx.restore();
  }

  private hitTest(mx: number, my: number): ForceNode | null {
    for (const node of this.nodes) {
      if (node.filteredOut) continue;
      const dx = mx - node.x;
      const dy = my - node.y;
      const r = this.nodeRadius(node) + 4;
      if (dx * dx + dy * dy < r * r) return node;
    }
    return null;
  }

  private setupInteraction(): void {
    let mouseDownX = 0;
    let mouseDownY = 0;
    let startX = 0;
    let startY = 0;
    let isPanning = false;
    let panStartOffX = 0;
    let panStartOffY = 0;

    this.canvas.addEventListener('mousedown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left - this.offsetX) / this.scale;
      const my = (e.clientY - rect.top - this.offsetY) / this.scale;
      mouseDownX = e.clientX;
      mouseDownY = e.clientY;
      this.dragMoved = false;

      const hit = this.hitTest(mx, my);
      if (hit) {
        this.dragging = hit;
        startX = mx - hit.x;
        startY = my - hit.y;
        this.canvas.style.cursor = 'grabbing';
      } else {
        isPanning = true;
        panStartOffX = this.offsetX;
        panStartOffY = this.offsetY;
        this.canvas.style.cursor = 'grabbing';
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left - this.offsetX) / this.scale;
      const my = (e.clientY - rect.top - this.offsetY) / this.scale;

      if (isPanning) {
        this.offsetX = panStartOffX + (e.clientX - mouseDownX);
        this.offsetY = panStartOffY + (e.clientY - mouseDownY);
        this.render();
        return;
      }

      if (this.dragging) {
        const totalDx = e.clientX - mouseDownX;
        const totalDy = e.clientY - mouseDownY;
        if (Math.abs(totalDx) + Math.abs(totalDy) > DRAG_THRESHOLD) {
          this.dragMoved = true;
        }
        this.dragging.x = mx - startX;
        this.dragging.y = my - startY;
        this.render();
        return;
      }

      const hit = this.hitTest(mx, my);
      if (hit !== this.hoveredNode) {
        this.hoveredNode = hit;
        this.canvas.style.cursor = hit ? 'pointer' : 'grab';
        if (this.tooltip) {
          if (hit) {
            const tags = hit.tags.length ? `Tags: ${hit.tags.map(t => '#' + t).join(' ')}` : '';
            const depth = `Depth: ${hit.depth}`;
            const bl = `${hit.backlinkCount} backlink${hit.backlinkCount !== 1 ? 's' : ''}`;
            this.tooltip.textContent = `${hit.label}\n${bl} · ${depth}${tags ? '\n' + tags : ''}`;
            this.tooltip.style.display = 'block';
            this.tooltip.style.left = `${e.clientX - rect.left + 14}px`;
            this.tooltip.style.top = `${e.clientY - rect.top - 10}px`;
          } else {
            this.tooltip.style.display = 'none';
          }
        }
        this.render();
      } else if (hit && this.tooltip) {
        this.tooltip.style.left = `${e.clientX - rect.left + 14}px`;
        this.tooltip.style.top = `${e.clientY - rect.top - 10}px`;
      }
    });

    this.canvas.addEventListener('mouseup', () => {
      if (this.dragging && !this.dragMoved && this.options.onNodeClick) {
        this.options.onNodeClick(this.dragging.id);
      }
      this.dragging = null;
      this.dragMoved = false;
      isPanning = false;
      this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
    });

    this.canvas.addEventListener('mouseleave', () => {
      if (this.tooltip) this.tooltip.style.display = 'none';
      isPanning = false;
      if (this.hoveredNode) {
        this.hoveredNode = null;
        this.render();
      }
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const oldScale = this.scale;
      this.scale *= e.deltaY > 0 ? 0.93 : 1.07;
      this.scale = Math.max(0.15, Math.min(4, this.scale));
      // Zoom toward cursor
      this.offsetX = mouseX - (mouseX - this.offsetX) * (this.scale / oldScale);
      this.offsetY = mouseY - (mouseY - this.offsetY) * (this.scale / oldScale);
      this.render();
    }, { passive: false });
  }

  resize(width: number, height: number): void {
    this.options.width = width;
    this.options.height = height;
    this.applyDpr();
    this.render();
  }

  destroy(): void {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.tooltip?.remove();
    this.canvas.remove();
  }
}
