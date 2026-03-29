import type { GraphNode, GraphEdge } from './types.js';

interface ForceNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface RenderOptions {
  width: number;
  height: number;
  onNodeClick?: (nodeId: string) => void;
  accentColor?: string;
  textColor?: string;
  bgColor?: string;
  borderColor?: string;
}

/**
 * Lightweight canvas-based force-directed graph renderer.
 * Avoids external dependencies (no d3 required).
 */
export class GraphRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nodes: ForceNode[] = [];
  private edges: GraphEdge[] = [];
  private animationFrame: number | null = null;
  private options: RenderOptions;
  private dragging: ForceNode | null = null;
  private offsetX = 0;
  private offsetY = 0;
  private scale = 1;

  constructor(container: HTMLElement, options: Partial<RenderOptions> = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d')!;
    this.options = {
      width: container.clientWidth || 400,
      height: container.clientHeight || 300,
      accentColor: options.accentColor || '#818cf8',
      textColor: options.textColor || '#e2e8f0',
      bgColor: options.bgColor || '#0f172a',
      borderColor: options.borderColor || '#334155',
      onNodeClick: options.onNodeClick,
      ...options,
    };

    this.canvas.width = this.options.width * 2;
    this.canvas.height = this.options.height * 2;
    this.ctx.scale(2, 2);

    this.setupInteraction();
  }

  setData(nodes: GraphNode[], edges: GraphEdge[]): void {
    const cx = this.options.width / 2;
    const cy = this.options.height / 2;

    this.nodes = nodes.map((n, i) => ({
      ...n,
      x: cx + (Math.cos((2 * Math.PI * i) / nodes.length) * Math.min(cx, cy) * 0.6),
      y: cy + (Math.sin((2 * Math.PI * i) / nodes.length) * Math.min(cx, cy) * 0.6),
      vx: 0,
      vy: 0,
    }));
    this.edges = edges;

    this.simulate();
  }

  private simulate(): void {
    let iterations = 0;
    const maxIterations = 200;

    const tick = () => {
      if (iterations >= maxIterations) {
        this.render();
        return;
      }

      // Repulsion between all nodes
      for (let i = 0; i < this.nodes.length; i++) {
        for (let j = i + 1; j < this.nodes.length; j++) {
          const a = this.nodes[i];
          const b = this.nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 800 / (dist * dist);
          dx = (dx / dist) * force;
          dy = (dy / dist) * force;
          a.vx -= dx;
          a.vy -= dy;
          b.vx += dx;
          b.vy += dy;
        }
      }

      // Attraction along edges
      const nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
      for (const edge of this.edges) {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);
        if (!source || !target) continue;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - 100) * 0.01;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      }

      // Center gravity
      const cx = this.options.width / 2;
      const cy = this.options.height / 2;
      for (const node of this.nodes) {
        node.vx += (cx - node.x) * 0.005;
        node.vy += (cy - node.y) * 0.005;
      }

      // Apply velocities with damping
      for (const node of this.nodes) {
        if (node === this.dragging) continue;
        node.vx *= 0.8;
        node.vy *= 0.8;
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

  private render(): void {
    const ctx = this.ctx;
    const { width, height, bgColor, borderColor, accentColor, textColor } = this.options;

    ctx.fillStyle = bgColor!;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    // Edges
    ctx.strokeStyle = borderColor!;
    ctx.lineWidth = 1;
    const nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
    for (const edge of this.edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
    }

    // Nodes
    for (const node of this.nodes) {
      const radius = 4 + Math.min(node.backlinkCount * 2, 12);

      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = accentColor!;
      ctx.fill();

      ctx.fillStyle = textColor!;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(node.label, node.x, node.y + radius + 12);
    }

    ctx.restore();
  }

  private setupInteraction(): void {
    let startX = 0;
    let startY = 0;

    this.canvas.addEventListener('mousedown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left - this.offsetX) / this.scale;
      const my = (e.clientY - rect.top - this.offsetY) / this.scale;

      for (const node of this.nodes) {
        const dx = mx - node.x;
        const dy = my - node.y;
        if (dx * dx + dy * dy < 400) {
          this.dragging = node;
          startX = mx - node.x;
          startY = my - node.y;
          return;
        }
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left - this.offsetX) / this.scale;
      const my = (e.clientY - rect.top - this.offsetY) / this.scale;
      this.dragging.x = mx - startX;
      this.dragging.y = my - startY;
      this.render();
    });

    this.canvas.addEventListener('mouseup', () => {
      if (this.dragging && this.options.onNodeClick) {
        this.options.onNodeClick(this.dragging.id);
      }
      this.dragging = null;
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.scale *= e.deltaY > 0 ? 0.95 : 1.05;
      this.scale = Math.max(0.2, Math.min(3, this.scale));
      this.render();
    });
  }

  resize(width: number, height: number): void {
    this.options.width = width;
    this.options.height = height;
    this.canvas.width = width * 2;
    this.canvas.height = height * 2;
    this.ctx.scale(2, 2);
    this.render();
  }

  destroy(): void {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.canvas.remove();
  }
}
