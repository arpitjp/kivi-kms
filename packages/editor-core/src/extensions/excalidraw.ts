import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    excalidrawBlock: {
      insertExcalidraw: (attrs?: { data?: string; src?: string; alt?: string }) => ReturnType;
    };
  }
}

interface ExcalidrawExportArgs {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown> | null;
  exportPadding?: number;
}

type ExportToSvgFn = (args: ExcalidrawExportArgs) => Promise<SVGSVGElement>;

function getExportToSvg(): ExportToSvgFn | null {
  const w = typeof window !== 'undefined' ? window as unknown as Record<string, unknown> : null;
  return (w?.__kiviExcalidrawExportToSvg as ExportToSvgFn) ?? null;
}

function waitForRenderer(timeoutMs = 10_000): Promise<ExportToSvgFn | null> {
  const fn = getExportToSvg();
  if (fn) return Promise.resolve(fn);
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const fn = getExportToSvg();
      if (fn) { clearInterval(interval); resolve(fn); }
      else if (Date.now() - start > timeoutMs) { clearInterval(interval); resolve(null); }
    }, 100);
  });
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
      alt: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-alt') || null,
        renderHTML: (attrs) => attrs.alt ? { 'data-alt': attrs.alt } : {},
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
      'data-align': {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-align') || null,
        renderHTML: (attrs) => {
          if (!attrs['data-align']) return {};
          return { 'data-align': attrs['data-align'] };
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
        (attrs?: { data?: string; src?: string; alt?: string }) =>
        ({ commands }) => {
          const src = attrs?.src || null;
          const alt = attrs?.alt || (src ? src.split('/').pop()?.replace(/\.excalidraw$/i, '') || 'excalidraw' : null);
          return commands.insertContent({
            type: this.name,
            attrs: {
              data: attrs?.data || '{}',
              src,
              alt,
            },
          });
        },
    };
  },

  addNodeView() {
    return ({ node }) => {
      const container = document.createElement('div');
      container.className = 'kivi-excalidraw-block';
      container.contentEditable = 'false';

      const align = node.attrs['data-align'] as string | null;
      if (align) container.setAttribute('data-align', align);

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

      async function renderWithExcalidrawUtils(jsonStr: string) {
        canvas.innerHTML = '';
        let data: Record<string, unknown>;
        try { data = JSON.parse(jsonStr); } catch { data = {}; }

        const elements = Array.isArray(data.elements) ? data.elements : [];
        if (elements.length === 0) {
          canvas.innerHTML = '<div class="kivi-excalidraw-empty">Empty Excalidraw diagram</div>';
          return;
        }

        canvas.innerHTML = '<div class="kivi-excalidraw-loading">Loading renderer\u2026</div>';
        const exportFn = await waitForRenderer();
        if (!exportFn) {
          canvas.innerHTML = '<div class="kivi-excalidraw-error">Excalidraw renderer not loaded</div>';
          return;
        }
        canvas.innerHTML = '';

        const darkMode = detectDarkMode();
        const appState = (data.appState as Record<string, unknown>) || {};
        const files = (data.files as Record<string, unknown>) || null;
        const svgEl = await exportFn({
          elements,
          appState: {
            ...appState,
            exportWithDarkMode: darkMode,
            viewBackgroundColor: 'transparent',
          },
          files,
          exportPadding: 16,
        });
        svgEl.classList.add('kivi-excalidraw-svg');
        svgEl.style.maxWidth = '100%';
        svgEl.style.height = 'auto';
        svgEl.removeAttribute('width');
        svgEl.removeAttribute('height');
        canvas.appendChild(svgEl);
      }

      async function loadAndRender() {
        const jsonStr = node.attrs.src ? null : (node.attrs.data || '{}');
        if (jsonStr) {
          await renderWithExcalidrawUtils(jsonStr);
          return;
        }
        if (!_excalidrawCallbacks.readFile) {
          canvas.innerHTML = `<div class="kivi-excalidraw-error">File reader not available</div>
            <div class="kivi-excalidraw-error-detail">${node.attrs.src}</div>`;
          return;
        }
        try {
          const content = await _excalidrawCallbacks.readFile(node.attrs.src);
          await renderWithExcalidrawUtils(content);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          canvas.innerHTML = `<div class="kivi-excalidraw-error">Could not load file: ${node.attrs.src}</div>
            <div class="kivi-excalidraw-error-detail">${msg}</div>`;
        }
      }

      // Cmd/Ctrl+click opens the .excalidraw source in the editor
      canvas.style.cursor = node.attrs.src ? 'pointer' : 'default';
      canvas.title = node.attrs.src ? 'Cmd+Click or double-click to open in editor' : '';
      canvas.addEventListener('click', (e) => {
        if (node.attrs.src && _excalidrawCallbacks.openInEditor && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          _excalidrawCallbacks.openInEditor(node.attrs.src);
        }
      });
      canvas.addEventListener('dblclick', () => {
        if (node.attrs.src && _excalidrawCallbacks.openInEditor) {
          _excalidrawCallbacks.openInEditor(node.attrs.src);
        }
      });

      loadAndRender();

      return {
        dom: container,
        update(updatedNode) {
          if (updatedNode.type !== node.type) return false;
          const changed = updatedNode.attrs.data !== node.attrs.data
            || updatedNode.attrs.src !== node.attrs.src
            || updatedNode.attrs.width !== node.attrs.width
            || updatedNode.attrs['data-align'] !== node.attrs['data-align'];
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
            const a = node.attrs['data-align'] as string | null;
            if (a) container.setAttribute('data-align', a);
            else container.removeAttribute('data-align');
            loadAndRender();
          }
          return true;
        },
      };
    };
  },
});
