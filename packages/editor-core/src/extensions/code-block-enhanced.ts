import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const codeBlockEnhancedKey = new PluginKey('kiviCodeBlockEnhanced');

type Lowlight = ReturnType<typeof import('lowlight').createLowlight>;
let lowlight: Lowlight | null = null;
let lowlightLoading: Promise<void> | null = null;
const lowlightReadyCallbacks: (() => void)[] = [];

function ensureLowlight(): Promise<void> {
  if (lowlight) return Promise.resolve();
  if (!lowlightLoading) {
    lowlightLoading = import('lowlight').then(({ common, createLowlight }) => {
      lowlight = createLowlight(common);
      for (const cb of lowlightReadyCallbacks.splice(0)) cb();
    });
  }
  return lowlightLoading;
}

function onLowlightReady(cb: () => void) {
  if (lowlight) { cb(); return; }
  lowlightReadyCallbacks.push(cb);
  ensureLowlight();
}

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

function highlightCodeBlock(node: any, pos: number): Decoration[] {
  const decorations: Decoration[] = [];
  if (!lowlight) return decorations;
  const language = node.attrs.language || '';
  const text = node.textContent;
  if (!text) return decorations;

  let hast;
  try {
    if (language && lowlight.registered(language)) {
      hast = lowlight.highlight(language, text);
    } else {
      hast = lowlight.highlightAuto(text);
    }
  } catch {
    return decorations;
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
  return decorations;
}

function getHighlightDecorations(doc: any): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    if (node.type.name !== 'codeBlock') return;
    decorations.push(...highlightCodeBlock(node, pos));
  });

  return DecorationSet.create(doc, decorations);
}

function updateHighlightDecorations(tr: any, oldDecorations: DecorationSet): DecorationSet {
  // Map existing decorations through the transaction steps
  const mapped = oldDecorations.map(tr.mapping, tr.doc);

  // Find code blocks that overlap with changed ranges and rehighlight only those
  const changedRanges: { from: number; to: number }[] = [];
  for (let i = 0; i < tr.steps.length; i++) {
    const map = tr.mapping.maps[i];
    map.forEach((oldFrom: number, oldTo: number, newFrom: number, newTo: number) => {
      changedRanges.push({ from: newFrom, to: newTo });
    });
  }

  if (changedRanges.length === 0) return mapped;

  // Collect code blocks that intersect changed ranges
  const affectedBlocks: { node: any; pos: number }[] = [];
  tr.doc.descendants((node: any, pos: number) => {
    if (node.type.name !== 'codeBlock') return;
    const end = pos + node.nodeSize;
    for (const range of changedRanges) {
      if (range.from <= end && range.to >= pos) {
        affectedBlocks.push({ node, pos });
        break;
      }
    }
  });

  if (affectedBlocks.length === 0) return mapped;

  // Remove old decorations in affected block ranges and add fresh ones
  let result = mapped;
  for (const { node, pos } of affectedBlocks) {
    const end = pos + node.nodeSize;
    result = result.remove(result.find(pos, end));
  }

  const newDecorations: Decoration[] = [];
  for (const { node, pos } of affectedBlocks) {
    newDecorations.push(...highlightCodeBlock(node, pos));
  }

  return result.add(tr.doc, newDecorations);
}

const COLLAPSED_MAX_LINES = 15;
// Visual collapse is handled purely outside ProseMirror's DOM now.
// The CSS rules for .kivi-codeblock-collapsed are no longer used.

const SVG_COPY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5V3.5A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5"/></svg>';
const SVG_CHECK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,8 6.5,11.5 13,4.5"/></svg>';
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
          if (!lowlight) return DecorationSet.empty;
          return getHighlightDecorations(doc);
        },
        apply(tr, oldDecorations) {
          if (!lowlight) return DecorationSet.empty;
          if (tr.getMeta('lowlightReady')) return getHighlightDecorations(tr.doc);
          if (!tr.docChanged) return oldDecorations;
          return updateHighlightDecorations(tr, oldDecorations);
        },
      },
      props: {
        decorations(state) {
          return codeBlockEnhancedKey.getState(state) as DecorationSet;
        },
      },
    });

    onLowlightReady(() => {
      const view = editor.view;
      if (view && !view.isDestroyed) {
        const tr = view.state.tr.setMeta('lowlightReady', true);
        view.dispatch(tr);
      }
    });

    const controlsPlugin = new Plugin({
      view(editorView) {
        const controls = document.createElement('div');
        controls.className = 'kivi-codeblock-controls';
        controls.style.display = 'none';
        controls.style.pointerEvents = 'none';

        const langLabel = document.createElement('span');
        langLabel.className = 'kivi-codeblock-lang';
        controls.appendChild(langLabel);

        const spacer = document.createElement('span');
        spacer.style.flex = '1';
        controls.appendChild(spacer);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'kivi-codeblock-btn';
        copyBtn.type = 'button';
        copyBtn.title = 'Copy code';
        copyBtn.innerHTML = SVG_COPY;
        copyBtn.setAttribute('aria-label', 'Copy code');
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
        let editingLang = false;
        const collapsedBlocks = new WeakSet<HTMLElement>();

        copyBtn.addEventListener('mousedown', (e) => {
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

        function startLangEdit() {
          if (editingLang || !activePre) return;
          editingLang = true;
          const currentLang = langLabel.textContent === 'plain text' ? '' : langLabel.textContent || '';
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'kivi-codeblock-lang-input';
          input.value = currentLang;
          input.placeholder = 'language';
          langLabel.style.display = 'none';
          controls.insertBefore(input, langLabel.nextSibling);
          input.focus();
          input.select();

          let committed = false;
          function commit() {
            if (committed) return;
            committed = true;
            const newLang = input.value.trim().toLowerCase();
            input.remove();
            langLabel.style.display = '';
            editingLang = false;

            if (!activePre) return;
            const pos = editorView.posAtDOM(activePre, 0);
            if (pos >= 0) {
              const resolved = editorView.state.doc.resolve(pos);
              for (let d = resolved.depth; d >= 0; d--) {
                const node = resolved.node(d);
                if (node.type.name === 'codeBlock') {
                  const nodePos = resolved.before(d);
                  editorView.dispatch(
                    editorView.state.tr.setNodeMarkup(nodePos, undefined, {
                      ...node.attrs,
                      language: newLang,
                    }),
                  );
                  langLabel.textContent = newLang || 'plain text';
                  break;
                }
              }
            }
          }

          function cancel() {
            if (committed) return;
            committed = true;
            input.remove();
            langLabel.style.display = '';
            editingLang = false;
          }

          input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
            if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
          });
          input.addEventListener('blur', commit);
        }

        langLabel.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          startLangEdit();
        });

        function onControlsPointerEnter() {
          hoveringControls = true;
        }
        function onControlsPointerLeave(e: MouseEvent) {
          const related = e.relatedTarget as Node | null;
          if (related && controls.contains(related)) return;
          hoveringControls = false;
          if (!editingLang) reconcile();
        }
        for (const el of [langLabel, copyBtn]) {
          el.addEventListener('mouseenter', onControlsPointerEnter);
          el.addEventListener('mouseleave', onControlsPointerLeave);
        }

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
          if (editingLang) return;
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
            for (const el of [langLabel, copyBtn]) {
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
