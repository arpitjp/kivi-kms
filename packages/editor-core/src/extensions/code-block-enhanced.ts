import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { common, createLowlight } from 'lowlight';

const codeBlockEnhancedKey = new PluginKey('kiviCodeBlockEnhanced');

const lowlight = createLowlight(common);

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

function flattenHast(node: HastNode, className?: string): { text: string; classes: string[] }[] {
  const results: { text: string; classes: string[] }[] = [];

  if (node.type === 'text') {
    results.push({ text: node.value || '', classes: className ? [className] : [] });
    return results;
  }

  if (node.type === 'element' && node.children) {
    const cls = (node.properties?.className as string[])?.join(' ') || className || '';
    for (const child of node.children) {
      results.push(...flattenHast(child, cls));
    }
  }

  if (node.type === 'root' && node.children) {
    for (const child of node.children) {
      results.push(...flattenHast(child, className));
    }
  }

  return results;
}

function getHighlightDecorations(doc: any): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    if (node.type.name !== 'codeBlock') return;

    const language = node.attrs.language || '';
    const text = node.textContent;
    if (!text) return;

    let hast;
    try {
      if (language && lowlight.registered(language)) {
        hast = lowlight.highlight(language, text);
      } else {
        hast = lowlight.highlightAuto(text);
      }
    } catch {
      return;
    }

    const tokens = flattenHast(hast as unknown as HastNode);
    let offset = pos + 1;
    for (const token of tokens) {
      const from = offset;
      const to = from + token.text.length;
      offset = to;
      if (token.classes.length > 0 && from < to) {
        decorations.push(
          Decoration.inline(from, to, {
            class: token.classes.join(' '),
          })
        );
      }
    }
  });

  return DecorationSet.create(doc, decorations);
}

const COLLAPSED_MAX_LINES = 15;
// Visual collapse is handled purely outside ProseMirror's DOM now.
// The CSS rules for .kivi-codeblock-collapsed are no longer used.

const SVG_COPY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5V3.5A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5"/></svg>';
const SVG_CHECK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,8 6.5,11.5 13,4.5"/></svg>';
const SVG_WRAP = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10"/><path d="M3 8h7a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2H8"/><polyline points="9.5,10.5 8,12 9.5,13.5"/></svg>';
const SVG_EXPAND = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,6 8,10 12,6"/></svg>';
const SVG_COLLAPSE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,10 8,6 12,10"/></svg>';

/**
 * Adds syntax highlighting (lowlight), floating copy/wrap controls,
 * and collapse/expand for long code blocks.
 */
export const CodeBlockEnhanced = Extension.create({
  name: 'kiviCodeBlockEnhanced',

  addProseMirrorPlugins() {
    const editor = this.editor;

    const highlightPlugin = new Plugin({
      key: codeBlockEnhancedKey,
      state: {
        init(_, { doc }) {
          return getHighlightDecorations(doc);
        },
        apply(tr, oldDecorations) {
          if (!tr.docChanged) return oldDecorations;
          return getHighlightDecorations(tr.doc);
        },
      },
      props: {
        decorations(state) {
          return codeBlockEnhancedKey.getState(state) as DecorationSet;
        },
      },
    });

    const controlsPlugin = new Plugin({
      view(editorView) {
        const controls = document.createElement('div');
        controls.className = 'kivi-codeblock-controls';
        controls.style.display = 'none';
        controls.style.pointerEvents = 'none';

        const langLabel = document.createElement('span');
        langLabel.className = 'kivi-codeblock-lang';
        langLabel.style.pointerEvents = 'auto';
        controls.appendChild(langLabel);

        const spacer = document.createElement('span');
        spacer.style.flex = '1';
        spacer.style.pointerEvents = 'none';
        controls.appendChild(spacer);

        const wrapBtn = document.createElement('button');
        wrapBtn.className = 'kivi-codeblock-btn';
        wrapBtn.type = 'button';
        wrapBtn.title = 'Toggle word wrap';
        wrapBtn.innerHTML = SVG_WRAP;
        wrapBtn.setAttribute('aria-label', 'Toggle word wrap');
        wrapBtn.style.pointerEvents = 'auto';
        controls.appendChild(wrapBtn);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'kivi-codeblock-btn';
        copyBtn.type = 'button';
        copyBtn.title = 'Copy code';
        copyBtn.innerHTML = SVG_COPY;
        copyBtn.setAttribute('aria-label', 'Copy code');
        copyBtn.style.pointerEvents = 'auto';
        controls.appendChild(copyBtn);

        const scrollParent = editorView.dom.parentElement || editorView.dom;
        if (getComputedStyle(scrollParent).position === 'static') {
          scrollParent.style.position = 'relative';
        }
        scrollParent.appendChild(controls);

        let hoveredPre: HTMLElement | null = null;
        let cursorPre: HTMLElement | null = null;
        let activePre: HTMLElement | null = null;
        let hoveringControls = false;
        const collapsedBlocks = new WeakSet<HTMLElement>();
        const wrapByPre = new WeakMap<HTMLElement, boolean>();

        function applyWrapStylesToPre(pre: HTMLElement, wrapped: boolean) {
          // User-initiated one-shot mutation on PM `<pre>`. Guard against no-op
          // sets to avoid triggering ProseMirror's MutationObserver unnecessarily.
          const ws = wrapped ? 'pre-wrap' : '';
          const wb = wrapped ? 'break-all' : '';
          if (pre.style.whiteSpace !== ws) pre.style.whiteSpace = ws;
          if (pre.style.wordBreak !== wb) pre.style.wordBreak = wb;
        }

        copyBtn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        wrapBtn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });

        copyBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!activePre) return;
          const code = activePre.querySelector('code')?.textContent || activePre.textContent || '';
          navigator.clipboard.writeText(code).then(() => {
            copyBtn.innerHTML = SVG_CHECK;
            setTimeout(() => {
              copyBtn.innerHTML = SVG_COPY;
            }, 1500);
          });
        });

        wrapBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!activePre) return;
          const next = !wrapByPre.get(activePre);
          wrapByPre.set(activePre, next);
          applyWrapStylesToPre(activePre, next);
          wrapBtn.classList.toggle('active', next);
        });

        function onControlsPointerEnter() {
          hoveringControls = true;
        }
        function onControlsPointerLeave(e: MouseEvent) {
          const related = e.relatedTarget as Node | null;
          if (related && controls.contains(related)) return;
          hoveringControls = false;
          reconcile();
        }
        for (const el of [langLabel, wrapBtn, copyBtn]) {
          el.addEventListener('mouseenter', onControlsPointerEnter);
          el.addEventListener('mouseleave', onControlsPointerLeave);
        }

        /** Convert viewport rect to scroll-parent content coordinates. */
        function toContentCoords(viewportRect: DOMRect) {
          const pr = scrollParent.getBoundingClientRect();
          return {
            top: viewportRect.top - pr.top + scrollParent.scrollTop,
            left: viewportRect.left - pr.left + scrollParent.scrollLeft,
          };
        }

        function repositionControls() {
          if (!activePre) return;
          const preRect = activePre.getBoundingClientRect();
          const pos = toContentCoords(preRect);
          controls.style.display = 'flex';
          controls.style.left = `${pos.left}px`;
          controls.style.top = `${pos.top}px`;
          controls.style.width = `${preRect.width}px`;
        }

        function showControls(preEl: HTMLElement) {
          activePre = preEl;
          const wrapped = wrapByPre.get(preEl) ?? false;
          // Do NOT call applyWrapStylesToPre here — this function runs on every
          // ProseMirror transaction via update() → reconcile(). Setting inline
          // styles on PM-managed <pre> triggers MutationObserver → new
          // transaction → infinite loop. Only the wrap button click handler
          // should mutate the <pre> style.
          wrapBtn.classList.toggle('active', wrapped);

          let lang = '';
          const pos = editorView.posAtDOM(preEl, 0);
          if (pos >= 0) {
            const resolved = editorView.state.doc.resolve(pos);
            for (let d = resolved.depth; d >= 0; d--) {
              const node = resolved.node(d);
              if (node.type.name === 'codeBlock') {
                lang = node.attrs.language || '';
                break;
              }
            }
          }
          if (!lang) {
            lang =
              preEl.getAttribute('data-language') ||
              preEl.querySelector('code')?.className?.match(/language-(\S+)/)?.[1] ||
              '';
          }
          langLabel.textContent = lang || 'plain text';

          repositionControls();
        }

        function hideControls() {
          controls.style.display = 'none';
          activePre = null;
        }

        function reconcile() {
          const target = hoveredPre || cursorPre;
          if (target) {
            showControls(target);
          } else if (!hoveringControls) {
            hideControls();
          }
        }

        function onMouseOver(e: MouseEvent) {
          const target = (e.target as HTMLElement).closest?.('pre');
          if (target instanceof HTMLElement && editorView.dom.contains(target)) {
            hoveredPre = target;
            reconcile();
          }
        }
        function onMouseOut(e: MouseEvent) {
          const related = e.relatedTarget as HTMLElement | null;
          if (!related || (!related.closest?.('pre') && !controls.contains(related))) {
            hoveredPre = null;
            reconcile();
          }
        }

        editorView.dom.addEventListener('mouseover', onMouseOver);
        editorView.dom.addEventListener('mouseout', onMouseOut);

        function countLines(el: HTMLElement): number {
          const code = el.querySelector('code');
          const text = code?.textContent || el.textContent || '';
          return text.split('\n').length;
        }

        const collapseContainer = document.createElement('div');
        collapseContainer.className = 'kivi-collapse-container';
        collapseContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;pointer-events:none;z-index:40;';
        scrollParent.appendChild(collapseContainer);

        const expandBars = new WeakMap<HTMLElement, HTMLElement>();

        function repositionCollapseBars() {
          editorView.dom.querySelectorAll<HTMLElement>('pre').forEach((preEl) => {
            const bar = expandBars.get(preEl);
            if (!bar) return;
            const preRect = preEl.getBoundingClientRect();
            const pos = toContentCoords(preRect);
            bar.style.display = '';
            bar.style.position = 'absolute';
            bar.style.left = `${pos.left}px`;
            bar.style.top = `${pos.top + preRect.height - 30}px`;
            bar.style.width = `${preRect.width}px`;
          });
        }

        function syncCollapse() {
          const allPre = editor.view.dom.querySelectorAll<HTMLElement>('pre');

          allPre.forEach((preEl) => {
            const lineCount = countLines(preEl);

            if (lineCount <= COLLAPSED_MAX_LINES) {
              collapsedBlocks.delete(preEl);
              const bar = expandBars.get(preEl);
              if (bar) {
                bar.remove();
                expandBars.delete(preEl);
              }
              return;
            }

            let bar = expandBars.get(preEl);
            if (!bar) {
              bar = document.createElement('div');
              bar.className = 'kivi-codeblock-expand';
              bar.style.pointerEvents = 'auto';
              bar.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
              });
              bar.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (collapsedBlocks.has(preEl)) {
                  collapsedBlocks.delete(preEl);
                } else {
                  collapsedBlocks.add(preEl);
                }
                syncCollapse();
              });
              collapseContainer.appendChild(bar);
              expandBars.set(preEl, bar);
              collapsedBlocks.add(preEl);
            }

            const collapsed = collapsedBlocks.has(preEl);
            const newHtml = collapsed
              ? `${SVG_EXPAND}<span>Show ${lineCount - COLLAPSED_MAX_LINES} more lines</span>`
              : `${SVG_COLLAPSE}<span>Show less</span>`;
            if (bar.innerHTML !== newHtml) bar.innerHTML = newHtml;
          });

          collapseContainer.querySelectorAll<HTMLElement>('.kivi-codeblock-expand').forEach((bar) => {
            let found = false;
            allPre.forEach((pre) => {
              if (expandBars.get(pre) === bar) found = true;
            });
            if (!found) bar.remove();
          });

          repositionCollapseBars();
        }

        function update() {
          const { state } = editor;
          const { $from } = state.selection;
          let depth = $from.depth;
          cursorPre = null;

          while (depth > 0) {
            const node = $from.node(depth);
            if (node.type.name === 'codeBlock') {
              const domNode = editor.view.nodeDOM($from.before(depth));
              if (domNode instanceof HTMLElement) {
                cursorPre = domNode;
              }
              break;
            }
            depth--;
          }

          reconcile();
          syncCollapse();
        }

        return {
          update,
          destroy() {
            editorView.dom.removeEventListener('mouseover', onMouseOver);
            editorView.dom.removeEventListener('mouseout', onMouseOut);
            for (const el of [langLabel, wrapBtn, copyBtn]) {
              el.removeEventListener('mouseenter', onControlsPointerEnter);
              el.removeEventListener('mouseleave', onControlsPointerLeave);
            }
            controls.remove();
            collapseContainer.remove();
          },
        };
      },
    });

    return [highlightPlugin, controlsPlugin];
  },
});
