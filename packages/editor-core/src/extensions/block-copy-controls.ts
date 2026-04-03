import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { addDelayedTooltip } from '../tooltip.js';

const blockCopyKey = new PluginKey('kiviBlockCopyControls');

const svgI = (d: string) =>
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const SVG_COPY = svgI('<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5V3.5A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5"/>');
const SVG_CHECK = svgI('<polyline points="3,8 6.5,11.5 13,4.5" stroke-width="2"/>');
const SVG_TRASH = svgI('<polyline points="3,4 13,4"/><path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><path d="M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4"/>');

type BlockKind = 'blockquote' | 'mathBlock';

interface BlockHit {
  kind: BlockKind;
  dom: HTMLElement;
  nodePos: number;
  nodeSize: number;
}

function resolveBlockHit(view: EditorView): BlockHit | null {
  const { $from } = view.state.selection;

  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    const name = node.type.name;

    if (name === 'blockquote') {
      const domNode = view.domAtPos($from.start(d));
      const el = (domNode.node as HTMLElement).closest?.('blockquote')
        ?? (domNode.node.parentElement as HTMLElement)?.closest?.('blockquote');
      if (el) {
        return { kind: 'blockquote', dom: el, nodePos: $from.before(d), nodeSize: node.nodeSize };
      }
    }

    if (name === 'mathBlock') {
      const domNode = view.domAtPos($from.start(d));
      const el = (domNode.node as HTMLElement).closest?.('.kivi-math-block')
        ?? (domNode.node.parentElement as HTMLElement)?.closest?.('.kivi-math-block');
      if (el) {
        return { kind: 'mathBlock', dom: el as HTMLElement, nodePos: $from.before(d), nodeSize: node.nodeSize };
      }
    }
  }
  return null;
}

function blockquoteToMarkdown(el: HTMLElement): string {
  const lines: string[] = [];
  for (const child of el.children) {
    const text = (child as HTMLElement).textContent || '';
    for (const line of text.split('\n')) {
      lines.push('> ' + line);
    }
  }
  return lines.join('\n');
}

function mathBlockToLatex(el: HTMLElement): string {
  const source = el.querySelector('.kivi-math-source code, .kivi-math-source');
  return source?.textContent?.trim() || el.textContent?.trim() || '';
}

function isVisible(el: HTMLElement, view: EditorView): boolean {
  const ir = el.getBoundingClientRect();
  const container = view.dom.parentElement;
  if (!container) return ir.bottom > 0 && ir.top < window.innerHeight;
  const cr = container.getBoundingClientRect();
  return ir.bottom > cr.top && ir.top < cr.bottom;
}

export const BlockCopyControls = Extension.create({
  name: 'kiviBlockCopyControls',

  addProseMirrorPlugins() {

    return [
      new Plugin({
        key: blockCopyKey,
        view() {
          let panel: HTMLElement | null = null;
          let currentDom: HTMLElement | null = null;
          let currentKind: BlockKind | null = null;
          let viewRef: EditorView | null = null;
          let scrollParent: HTMLElement | null = null;
          let scrollHandler: (() => void) | null = null;
          let scrollRaf: number | null = null;

          function removePanel() {
            if (scrollParent && scrollHandler) {
              scrollParent.removeEventListener('scroll', scrollHandler);
            }
            scrollParent = null;
            scrollHandler = null;
            if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
            panel?.remove();
            panel = null;
            currentDom = null;
            currentKind = null;
            viewRef = null;
          }

          function position(view: EditorView, dom: HTMLElement) {
            if (!panel) return;
            if (!isVisible(dom, view)) {
              panel.style.visibility = 'hidden';
              return;
            }
            panel.style.visibility = 'visible';
            const rect = dom.getBoundingClientRect();
            const container = view.dom.parentElement;
            const containerRect = container?.getBoundingClientRect()
              ?? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
            const pw = panel.offsetWidth || 80;
            const ph = panel.offsetHeight || 28;
            const gap = 4;

            const visibleTop = Math.max(rect.top, containerRect.top);
            const visibleBottom = Math.min(rect.bottom, containerRect.bottom);

            let top = visibleTop - ph - gap;

            if (top < containerRect.top) {
              top = visibleTop + gap;
            }

            if (top + ph > visibleBottom - gap) {
              top = visibleBottom - ph - gap;
            }

            top = Math.max(gap, Math.min(top, window.innerHeight - ph - gap));

            let left = rect.right - pw - gap;
            if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
            if (left < 8) left = 8;

            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
          }

          function show(view: EditorView, hit: BlockHit) {
            if (panel && currentDom === hit.dom) {
              viewRef = view;
              position(view, hit.dom);
              return;
            }
            removePanel();
            currentDom = hit.dom;
            currentKind = hit.kind;
            viewRef = view;

            panel = document.createElement('div');
            panel.className = 'kivi-block-copy-controls';
            panel.setAttribute('role', 'toolbar');
            panel.style.pointerEvents = 'none';

            const makeBtn = (svg: string, title: string, action: () => void, danger = false) => {
              const b = document.createElement('button');
              b.className = 'kivi-block-copy-btn' + (danger ? ' kivi-block-copy-danger' : '');
              b.innerHTML = svg;
              b.title = title;
              b.style.pointerEvents = 'auto';
              b.addEventListener('mousedown', (e) => e.preventDefault());
              b.addEventListener('click', action);
              addDelayedTooltip(b);
              return b;
            };

            const copyBtn = makeBtn(SVG_COPY, 'Copy', () => {
              if (!currentDom || !currentKind) return;
              const text = currentKind === 'blockquote'
                ? blockquoteToMarkdown(currentDom)
                : mathBlockToLatex(currentDom);
              navigator.clipboard.writeText(text).then(() => {
                copyBtn.innerHTML = SVG_CHECK;
                setTimeout(() => { copyBtn.innerHTML = SVG_COPY; }, 1500);
              });
            });
            panel.appendChild(copyBtn);

            panel.appendChild(makeBtn(SVG_TRASH, 'Delete', () => {
              view.dispatch(view.state.tr.delete(hit.nodePos, hit.nodePos + hit.nodeSize));
              removePanel();
            }, true));

            document.body.appendChild(panel);

            scrollParent = view.dom.parentElement;
            if (scrollParent) {
              scrollHandler = () => {
                if (!currentDom || !viewRef) return;
                if (scrollRaf) return;
                scrollRaf = requestAnimationFrame(() => {
                  scrollRaf = null;
                  if (currentDom && viewRef) position(viewRef, currentDom);
                });
              };
              scrollParent.addEventListener('scroll', scrollHandler, { passive: true });
            }

            position(view, hit.dom);
          }

          return {
            update(view) {
              const hit = resolveBlockHit(view);
              if (!hit) {
                removePanel();
                return;
              }
              show(view, hit);
            },
            destroy() {
              removePanel();
            },
          };
        },
      }),
    ];
  },
});
