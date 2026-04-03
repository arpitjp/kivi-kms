import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    excalidrawBlock: {
      insertExcalidraw: (attrs?: { data?: string; src?: string }) => ReturnType;
    };
  }
}

// Lightweight SVG renderer for Excalidraw elements — avoids importing the
// heavy @excalidraw/utils package.  Handles rectangle, ellipse, diamond,
// line, arrow, freedraw, and text.  Anything else is shown as a placeholder rect.
function renderExcalidrawSvg(json: string, maxWidth: number, darkMode: boolean): SVGSVGElement {
  let data: { elements?: unknown[]; appState?: Record<string, unknown> } = {};
  try { data = JSON.parse(json); } catch { /* empty */ }

  const elements = Array.isArray(data.elements) ? data.elements as Record<string, unknown>[] : [];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

  if (elements.length === 0) {
    svg.setAttribute('viewBox', '0 0 200 80');
    svg.setAttribute('width', '200');
    svg.setAttribute('height', '80');
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', '100');
    t.setAttribute('y', '45');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', darkMode ? '#888' : '#999');
    t.setAttribute('font-size', '13');
    t.setAttribute('font-family', 'system-ui, sans-serif');
    t.textContent = 'Empty Excalidraw diagram';
    svg.appendChild(t);
    return svg;
  }

  // Compute bounding box
  const PAD = 20;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    if (el.isDeleted) continue;
    const x = (el.x as number) || 0;
    const y = (el.y as number) || 0;
    const w = (el.width as number) || 0;
    const h = (el.height as number) || 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
    // For lines/arrows, also check points
    const pts = el.points as number[][] | undefined;
    if (pts) {
      for (const [px, py] of pts) {
        minX = Math.min(minX, x + px);
        minY = Math.min(minY, y + py);
        maxX = Math.max(maxX, x + px);
        maxY = Math.max(maxY, y + py);
      }
    }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 200; maxY = 100; }
  const vw = maxX - minX + PAD * 2;
  const vh = maxY - minY + PAD * 2;
  const aspectRatio = vw / vh;
  const displayW = Math.min(maxWidth, vw);
  const displayH = displayW / aspectRatio;

  svg.setAttribute('viewBox', `${minX - PAD} ${minY - PAD} ${vw} ${vh}`);
  svg.setAttribute('width', String(Math.round(displayW)));
  svg.setAttribute('height', String(Math.round(displayH)));

  const strokeColor = darkMode ? '#e0e0e0' : '#1e1e1e';
  const fillNone = 'none';

  for (const el of elements) {
    if (el.isDeleted) continue;
    const x = (el.x as number) || 0;
    const y = (el.y as number) || 0;
    const w = (el.width as number) || 0;
    const h = (el.height as number) || 0;
    const sc = (el.strokeColor as string) || strokeColor;
    const bg = (el.backgroundColor as string) || fillNone;
    const sw = (el.strokeWidth as number) || 1;
    const opacity = (el.opacity as number) ?? 100;
    const style = `opacity:${opacity / 100}`;

    switch (el.type) {
      case 'rectangle': {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(w));
        rect.setAttribute('height', String(h));
        rect.setAttribute('stroke', sc === 'transparent' ? strokeColor : sc);
        rect.setAttribute('fill', bg === 'transparent' ? fillNone : bg);
        rect.setAttribute('stroke-width', String(sw));
        rect.setAttribute('rx', '3');
        rect.setAttribute('style', style);
        svg.appendChild(rect);
        break;
      }
      case 'ellipse': {
        const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        ellipse.setAttribute('cx', String(x + w / 2));
        ellipse.setAttribute('cy', String(y + h / 2));
        ellipse.setAttribute('rx', String(w / 2));
        ellipse.setAttribute('ry', String(h / 2));
        ellipse.setAttribute('stroke', sc === 'transparent' ? strokeColor : sc);
        ellipse.setAttribute('fill', bg === 'transparent' ? fillNone : bg);
        ellipse.setAttribute('stroke-width', String(sw));
        ellipse.setAttribute('style', style);
        svg.appendChild(ellipse);
        break;
      }
      case 'diamond': {
        const cx = x + w / 2, cy = y + h / 2;
        const d = `M${cx},${y} L${x + w},${cy} L${cx},${y + h} L${x},${cy} Z`;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('stroke', sc === 'transparent' ? strokeColor : sc);
        path.setAttribute('fill', bg === 'transparent' ? fillNone : bg);
        path.setAttribute('stroke-width', String(sw));
        path.setAttribute('style', style);
        svg.appendChild(path);
        break;
      }
      case 'line':
      case 'arrow': {
        const pts = el.points as number[][] | undefined;
        if (pts && pts.length >= 2) {
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x + p[0]},${y + p[1]}`).join(' ');
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          path.setAttribute('stroke', sc === 'transparent' ? strokeColor : sc);
          path.setAttribute('fill', fillNone);
          path.setAttribute('stroke-width', String(sw));
          path.setAttribute('style', style);
          svg.appendChild(path);
          if (el.type === 'arrow' && pts.length >= 2) {
            const last = pts[pts.length - 1];
            const prev = pts[pts.length - 2];
            const angle = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
            const alen = 10;
            const ax1 = x + last[0] - alen * Math.cos(angle - 0.4);
            const ay1 = y + last[1] - alen * Math.sin(angle - 0.4);
            const ax2 = x + last[0] - alen * Math.cos(angle + 0.4);
            const ay2 = y + last[1] - alen * Math.sin(angle + 0.4);
            const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            arrow.setAttribute('d', `M${ax1},${ay1} L${x + last[0]},${y + last[1]} L${ax2},${ay2}`);
            arrow.setAttribute('stroke', sc === 'transparent' ? strokeColor : sc);
            arrow.setAttribute('fill', fillNone);
            arrow.setAttribute('stroke-width', String(sw));
            svg.appendChild(arrow);
          }
        }
        break;
      }
      case 'freedraw': {
        const pts = el.points as number[][] | undefined;
        if (pts && pts.length >= 2) {
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x + p[0]},${y + p[1]}`).join(' ');
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          path.setAttribute('stroke', sc === 'transparent' ? strokeColor : sc);
          path.setAttribute('fill', fillNone);
          path.setAttribute('stroke-width', String(sw));
          path.setAttribute('stroke-linecap', 'round');
          path.setAttribute('stroke-linejoin', 'round');
          path.setAttribute('style', style);
          svg.appendChild(path);
        }
        break;
      }
      case 'text': {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', String(x));
        text.setAttribute('y', String(y + (el.fontSize as number || 16)));
        text.setAttribute('fill', sc === 'transparent' ? strokeColor : sc);
        text.setAttribute('font-size', String(el.fontSize || 16));
        text.setAttribute('font-family', (el.fontFamily as number) === 3 ? 'monospace' : 'system-ui, sans-serif');
        text.setAttribute('style', style);
        const rawText = (el.text as string) || (el.originalText as string) || '';
        const lines = rawText.split('\n');
        if (lines.length <= 1) {
          text.textContent = rawText;
        } else {
          for (let i = 0; i < lines.length; i++) {
            const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
            tspan.setAttribute('x', String(x));
            tspan.setAttribute('dy', i === 0 ? '0' : '1.2em');
            tspan.textContent = lines[i];
            text.appendChild(tspan);
          }
        }
        svg.appendChild(text);
        break;
      }
      default: {
        // Unknown element type — show as a faded rect placeholder
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(w || 20));
        rect.setAttribute('height', String(h || 20));
        rect.setAttribute('stroke', darkMode ? '#555' : '#ccc');
        rect.setAttribute('fill', fillNone);
        rect.setAttribute('stroke-width', '1');
        rect.setAttribute('stroke-dasharray', '4 2');
        rect.setAttribute('style', style);
        svg.appendChild(rect);
      }
    }
  }

  return svg;
}

interface ExcalidrawCallbacks {
  readFile?: (src: string) => Promise<string>;
  openInEditor?: (src: string) => void;
  hasExcalidrawExtension?: () => boolean;
}

let _excalidrawCallbacks: ExcalidrawCallbacks = {};
export function setExcalidrawCallbacks(cb: ExcalidrawCallbacks) {
  _excalidrawCallbacks = cb;
}

function showExcalidrawJsonEditor(container: HTMLElement, currentData: string, onSave: (data: string) => void) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.7);z-index:10;display:flex;flex-direction:column;padding:8px;gap:6px;';
  const textarea = document.createElement('textarea');
  textarea.value = currentData;
  textarea.style.cssText = 'flex:1;font-family:monospace;font-size:11px;background:var(--vscode-input-background,#1e1e1e);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#444);border-radius:4px;padding:6px;resize:none;';
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:4px 12px;cursor:pointer;';
  cancelBtn.addEventListener('click', () => overlay.remove());
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.style.cssText = 'padding:4px 12px;cursor:pointer;';
  saveBtn.addEventListener('click', () => { onSave(textarea.value); overlay.remove(); });
  btnRow.append(cancelBtn, saveBtn);
  overlay.append(textarea, btnRow);
  container.style.position = 'relative';
  container.appendChild(overlay);
  textarea.focus();
}

function detectDarkMode(): boolean {
  if (typeof document === 'undefined') return true;
  const body = document.body;
  const bg = getComputedStyle(body).backgroundColor;
  if (!bg) return true;
  const m = bg.match(/\d+/g);
  if (!m || m.length < 3) return true;
  const luminance = (parseInt(m[0]) * 299 + parseInt(m[1]) * 587 + parseInt(m[2]) * 114) / 1000;
  return luminance < 128;
}

export const ExcalidrawBlock = Node.create({
  name: 'excalidrawBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      data: {
        default: '{}',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-excalidraw') || '{}',
        renderHTML: (attrs) => ({ 'data-excalidraw': attrs.data }),
      },
      src: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-src') || null,
        renderHTML: (attrs) => attrs.src ? { 'data-src': attrs.src } : {},
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const w = el.getAttribute('width');
          return w ? parseInt(w, 10) : null;
        },
        renderHTML: (attrs) => {
          if (!attrs.width) return {};
          return { width: String(attrs.width), style: `width:${attrs.width}px;max-width:100%` };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="excalidraw"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'excalidraw',
        class: 'kivi-excalidraw-block',
      }),
      'Excalidraw Diagram',
    ];
  },

  addCommands() {
    return {
      insertExcalidraw:
        (attrs?: { data?: string; src?: string }) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              data: attrs?.data || '{}',
              src: attrs?.src || null,
            },
          });
        },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const container = document.createElement('div');
      container.className = 'kivi-excalidraw-block';
      container.contentEditable = 'false';

      const header = document.createElement('div');
      header.className = 'kivi-excalidraw-header';

      const icon = document.createElement('span');
      icon.className = 'kivi-excalidraw-icon';
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 1.5l-13 13M1.5 1.5l13 13M8 1v14M1 8h14"/></svg>';

      const titleSpan = document.createElement('span');
      titleSpan.textContent = node.attrs.src
        ? node.attrs.src.split('/').pop() || 'Excalidraw'
        : 'Excalidraw Diagram';
      header.append(icon, titleSpan);
      container.appendChild(header);

      const canvas = document.createElement('div');
      canvas.className = 'kivi-excalidraw-canvas';
      container.appendChild(canvas);

      const btnRow = document.createElement('div');
      btnRow.className = 'kivi-excalidraw-actions';

      function renderPreview(jsonStr: string) {
        canvas.innerHTML = '';
        const darkMode = detectDarkMode();
        const maxW = container.clientWidth > 0 ? container.clientWidth - 32 : 500;
        const svg = renderExcalidrawSvg(jsonStr, maxW, darkMode);
        svg.classList.add('kivi-excalidraw-svg');
        canvas.appendChild(svg);
      }

      async function loadAndRender() {
        if (node.attrs.src && _excalidrawCallbacks.readFile) {
          try {
            const content = await _excalidrawCallbacks.readFile(node.attrs.src);
            renderPreview(content);
          } catch {
            canvas.innerHTML = '<div class="kivi-excalidraw-error">Could not load file</div>';
          }
        } else {
          renderPreview(node.attrs.data || '{}');
        }
      }

      // "Open in Excalidraw" button (if extension available and src-based)
      if (node.attrs.src) {
        const hasExt = _excalidrawCallbacks.hasExcalidrawExtension?.() ?? false;
        if (hasExt && _excalidrawCallbacks.openInEditor) {
          const openBtn = document.createElement('button');
          openBtn.className = 'kivi-excalidraw-btn';
          openBtn.textContent = 'Open in Excalidraw';
          openBtn.addEventListener('click', () => {
            _excalidrawCallbacks.openInEditor!(node.attrs.src);
          });
          btnRow.appendChild(openBtn);
        }
      }

      // "Edit JSON" button (always available for inline data)
      const editBtn = document.createElement('button');
      editBtn.className = 'kivi-excalidraw-btn kivi-excalidraw-btn-secondary';
      editBtn.textContent = node.attrs.src ? 'View JSON' : 'Edit JSON';
      editBtn.addEventListener('click', () => {
        const currentData = node.attrs.data || '{}';
        showExcalidrawJsonEditor(container, currentData, (newData) => {
          if (newData !== null && typeof getPos === 'function') {
            const pos = getPos();
            if (pos !== undefined) {
              editor.view.dispatch(
                editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, data: newData }),
              );
            }
          }
        });
      });
      btnRow.appendChild(editBtn);
      container.appendChild(btnRow);

      // Click on canvas opens in excalidraw editor if available
      canvas.addEventListener('click', () => {
        if (node.attrs.src && _excalidrawCallbacks.openInEditor) {
          const hasExt = _excalidrawCallbacks.hasExcalidrawExtension?.() ?? false;
          if (hasExt) {
            _excalidrawCallbacks.openInEditor(node.attrs.src);
            return;
          }
        }
      });

      loadAndRender();

      return {
        dom: container,
        update(updatedNode) {
          if (updatedNode.type !== node.type) return false;
          const changed = updatedNode.attrs.data !== node.attrs.data
            || updatedNode.attrs.src !== node.attrs.src
            || updatedNode.attrs.width !== node.attrs.width;
          node = updatedNode;
          if (changed) {
            titleSpan.textContent = node.attrs.src
              ? node.attrs.src.split('/').pop() || 'Excalidraw'
              : 'Excalidraw Diagram';
            if (node.attrs.width) {
              container.style.width = `${node.attrs.width}px`;
              container.style.maxWidth = '100%';
            } else {
              container.style.width = '';
              container.style.maxWidth = '';
            }
            loadAndRender();
          }
          return true;
        },
      };
    };
  },
});
