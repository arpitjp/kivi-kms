import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { addDelayedTooltip } from '../tooltip.js';

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
    map.forEach((_oldFrom: number, _oldTo: number, newFrom: number, newTo: number) => {
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
const SVG_TRASH = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,4 13,4"/><path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><path d="M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4"/></svg>';
const SVG_WRAP = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12"/><path d="M2 7h9a2 2 0 0 1 0 4H9"/><polyline points="10,12 9,11 10,10"/><path d="M2 13h5"/></svg>';
const SVG_EXPAND = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,6 8,10 12,6"/></svg>';
const SVG_COLLAPSE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,10 8,6 12,10"/></svg>';

const COMMON_LANGUAGES = [
  'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp',
  'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala',
  'html', 'css', 'scss', 'json', 'yaml', 'toml', 'xml',
  'sql', 'graphql', 'bash', 'shell', 'powershell',
  'markdown', 'latex', 'dockerfile', 'makefile',
  'lua', 'perl', 'r', 'matlab', 'julia',
  'dart', 'elixir', 'erlang', 'haskell', 'ocaml',
  'vim', 'diff', 'ini', 'nginx', 'plaintext',
];

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
        const panel = document.createElement('div');
        panel.className = 'kivi-codeblock-controls';
        panel.style.display = 'none';

        // --- Language selector with autocomplete ---
        const langBtn = document.createElement('button');
        langBtn.className = 'kivi-codeblock-btn kivi-cb-lang-btn';
        langBtn.type = 'button';
        langBtn.title = 'Change language';
        panel.appendChild(langBtn);

        const langDropdown = document.createElement('div');
        langDropdown.className = 'kivi-cb-lang-dropdown';
        langDropdown.style.display = 'none';

        const langInput = document.createElement('input');
        langInput.type = 'text';
        langInput.className = 'kivi-cb-lang-input';
        langInput.placeholder = 'Filter language…';
        langDropdown.appendChild(langInput);

        const langList = document.createElement('div');
        langList.className = 'kivi-cb-lang-list';
        langDropdown.appendChild(langList);

        // --- Separator ---
        const sep1 = document.createElement('span');
        sep1.className = 'kivi-codeblock-sep';
        panel.appendChild(sep1);

        // --- Word wrap toggle ---
        const wrapBtn = document.createElement('button');
        wrapBtn.className = 'kivi-codeblock-btn';
        wrapBtn.type = 'button';
        wrapBtn.title = 'Toggle word wrap';
        wrapBtn.innerHTML = SVG_WRAP;
        addDelayedTooltip(wrapBtn);
        panel.appendChild(wrapBtn);

        // --- Copy button ---
        const copyBtn = document.createElement('button');
        copyBtn.className = 'kivi-codeblock-btn';
        copyBtn.type = 'button';
        copyBtn.title = 'Copy code';
        copyBtn.innerHTML = SVG_COPY;
        addDelayedTooltip(copyBtn);
        panel.appendChild(copyBtn);

        // --- Separator ---
        const sep2 = document.createElement('span');
        sep2.className = 'kivi-codeblock-sep';
        panel.appendChild(sep2);

        // --- Delete button ---
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'kivi-codeblock-btn kivi-cb-danger';
        deleteBtn.type = 'button';
        deleteBtn.title = 'Delete code block';
        deleteBtn.innerHTML = SVG_TRASH;
        addDelayedTooltip(deleteBtn);
        panel.appendChild(deleteBtn);

        const scrollParent = editorView.dom.parentElement || editorView.dom;
        if (getComputedStyle(scrollParent).position === 'static') {
          scrollParent.style.position = 'relative';
        }
        scrollParent.appendChild(panel);
        document.body.appendChild(langDropdown);

        let hoveredPre: HTMLElement | null = null;
        let cursorPre: HTMLElement | null = null;
        let activePre: HTMLElement | null = null;
        let hoveringPanel = false;
        let langDropdownOpen = false;
        let langSelectedIdx = -1;
        const collapsedBlocks = new WeakSet<HTMLElement>();
        const wrappedBlocks = new WeakSet<HTMLElement>();

        function preventPM(e: MouseEvent) { e.preventDefault(); e.stopPropagation(); }
        for (const btn of [langBtn, copyBtn, wrapBtn, deleteBtn]) {
          btn.addEventListener('mousedown', preventPM);
        }

        // --- Language dropdown logic ---
        function getCodeBlockPos(preEl: HTMLElement): { nodePos: number; node: any } | null {
          const pos = editorView.posAtDOM(preEl, 0);
          if (pos < 0) return null;
          const resolved = editorView.state.doc.resolve(pos);
          for (let d = resolved.depth; d >= 0; d--) {
            const node = resolved.node(d);
            if (node.type.name === 'codeBlock') {
              return { nodePos: resolved.before(d), node };
            }
          }
          return null;
        }

        function setLanguage(newLang: string) {
          if (!activePre) return;
          const info = getCodeBlockPos(activePre);
          if (!info) return;
          editorView.dispatch(
            editorView.state.tr.setNodeMarkup(info.nodePos, undefined, {
              ...info.node.attrs,
              language: newLang,
            }),
          );
          langBtn.textContent = newLang || 'plain text';
          closeLangDropdown();
        }

        function renderLangList(filter: string) {
          langList.innerHTML = '';
          const q = filter.toLowerCase();
          const filtered = q ? COMMON_LANGUAGES.filter(l => l.includes(q)) : COMMON_LANGUAGES;
          langSelectedIdx = -1;
          for (const lang of filtered) {
            const item = document.createElement('div');
            item.className = 'kivi-cb-lang-item';
            item.textContent = lang;
            item.addEventListener('mousedown', (e) => {
              e.preventDefault();
              e.stopPropagation();
              setLanguage(lang);
            });
            langList.appendChild(item);
          }
        }

        function positionLangDropdown() {
          const btnRect = langBtn.getBoundingClientRect();
          langDropdown.style.left = `${btnRect.left}px`;
          langDropdown.style.top = `${btnRect.bottom + 4}px`;
        }

        function openLangDropdown() {
          if (langDropdownOpen) return;
          langDropdownOpen = true;
          const currentLang = langBtn.textContent === 'plain text' ? '' : langBtn.textContent || '';
          langInput.value = currentLang;
          renderLangList(currentLang);
          langDropdown.style.display = 'block';
          positionLangDropdown();
          langInput.focus();
          langInput.select();
        }

        function closeLangDropdown() {
          langDropdownOpen = false;
          langDropdown.style.display = 'none';
          langSelectedIdx = -1;
        }

        langBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (langDropdownOpen) closeLangDropdown();
          else openLangDropdown();
        });

        langInput.addEventListener('input', () => {
          renderLangList(langInput.value);
        });

        langInput.addEventListener('keydown', (ev) => {
          const items = langList.querySelectorAll<HTMLElement>('.kivi-cb-lang-item');
          if (ev.key === 'ArrowDown') {
            ev.preventDefault();
            langSelectedIdx = Math.min(langSelectedIdx + 1, items.length - 1);
            items.forEach((el, i) => el.classList.toggle('selected', i === langSelectedIdx));
            items[langSelectedIdx]?.scrollIntoView({ block: 'nearest' });
          } else if (ev.key === 'ArrowUp') {
            ev.preventDefault();
            langSelectedIdx = Math.max(langSelectedIdx - 1, 0);
            items.forEach((el, i) => el.classList.toggle('selected', i === langSelectedIdx));
            items[langSelectedIdx]?.scrollIntoView({ block: 'nearest' });
          } else if (ev.key === 'Enter') {
            ev.preventDefault();
            if (langSelectedIdx >= 0 && items[langSelectedIdx]) {
              setLanguage(items[langSelectedIdx].textContent || '');
            } else {
              setLanguage(langInput.value.trim().toLowerCase());
            }
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            closeLangDropdown();
          }
        });

        langInput.addEventListener('blur', () => {
          setTimeout(() => { if (langDropdownOpen) closeLangDropdown(); }, 150);
        });

        // --- Copy ---
        copyBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!activePre) return;
          const code = activePre.querySelector('code')?.textContent || activePre.textContent || '';
          navigator.clipboard.writeText(code).then(() => {
            copyBtn.innerHTML = SVG_CHECK;
            setTimeout(() => { copyBtn.innerHTML = SVG_COPY; }, 1500);
          });
        });

        // --- Word wrap toggle ---
        wrapBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!activePre) return;
          const codeEl = activePre.querySelector('code') as HTMLElement | null;
          if (!codeEl) return;
          if (wrappedBlocks.has(activePre)) {
            wrappedBlocks.delete(activePre);
            codeEl.style.whiteSpace = 'pre';
            codeEl.style.wordBreak = '';
            wrapBtn.classList.remove('active');
          } else {
            wrappedBlocks.add(activePre);
            codeEl.style.whiteSpace = 'pre-wrap';
            codeEl.style.wordBreak = 'break-all';
            wrapBtn.classList.add('active');
          }
        });

        // --- Delete ---
        deleteBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!activePre) return;
          const info = getCodeBlockPos(activePre);
          if (!info) return;
          const { nodePos, node } = info;
          editorView.dispatch(editorView.state.tr.delete(nodePos, nodePos + node.nodeSize));
          hideControls();
        });

        // --- Panel hover tracking ---
        panel.addEventListener('mouseenter', () => { hoveringPanel = true; });
        panel.addEventListener('mouseleave', (e) => {
          const related = e.relatedTarget as Node | null;
          if (related && (panel.contains(related) || langDropdown.contains(related))) return;
          hoveringPanel = false;
          if (!langDropdownOpen) reconcile();
        });

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
          const containerRect = scrollParent.getBoundingClientRect();
          const pos = toContentCoords(preRect);

          panel.style.display = 'flex';
          const panelW = panel.offsetWidth || 260;
          const centerX = pos.left + (preRect.width - panelW) / 2;
          panel.style.left = `${Math.max(pos.left + 4, centerX)}px`;

          const aboveTop = pos.top - 36;
          const visiblePreTop = Math.max(preRect.top, containerRect.top);
          const insideTop = toContentCoords({ top: visiblePreTop + 4 } as DOMRect).top;

          if (aboveTop > scrollParent.scrollTop) {
            panel.style.top = `${aboveTop}px`;
          } else {
            panel.style.top = `${insideTop}px`;
          }

          if (langDropdownOpen) positionLangDropdown();
        }

        function showControls(preEl: HTMLElement) {
          activePre = preEl;

          let lang = '';
          const info = getCodeBlockPos(preEl);
          if (info) lang = info.node.attrs.language || '';
          if (!lang) {
            lang =
              preEl.getAttribute('data-language') ||
              preEl.querySelector('code')?.className?.match(/language-(\S+)/)?.[1] ||
              '';
          }
          langBtn.textContent = lang || 'plain text';

          wrapBtn.classList.toggle('active', wrappedBlocks.has(preEl));
          repositionControls();
        }

        function hideControls() {
          panel.style.display = 'none';
          activePre = null;
          closeLangDropdown();
        }

        function reconcile() {
          if (langDropdownOpen) return;
          const target = hoveredPre || cursorPre;
          if (target) {
            showControls(target);
          } else if (!hoveringPanel) {
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
          if (!related || (!related.closest?.('pre') && !panel.contains(related))) {
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
            panel.remove();
            langDropdown.remove();
            collapseContainer.remove();
          },
        };
      },
    });

    return [highlightPlugin, controlsPlugin];
  },
});
