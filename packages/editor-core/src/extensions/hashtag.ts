import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { InputRule } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { positionFixedPopup } from '../zoom.js';
import type { EditorState } from '@tiptap/pm/state';

export interface HashTagOptions {
  HTMLAttributes: Record<string, string>;
  suggestion?: {
    items: (query: string) => string[] | Promise<string[]>;
  };
  onHashTagClick?: (tag: string) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    hashTag: {
      insertHashTag: (tag: string) => ReturnType;
    };
  }
}

const hashTagPluginKey = new PluginKey('hashTagClick');
const suggestionPluginKey = new PluginKey('hashTagSuggestion');

function detectHashTrigger(state: EditorState): { from: number; to: number; query: string } | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const $pos = state.doc.resolve(selection.from);

  for (let d = $pos.depth; d >= 0; d--) {
    if ($pos.node(d).type.name === 'codeBlock') return null;
  }

  // Don't trigger if cursor is inside or at the boundary of an existing hashTag mark
  const marksAtCursor = $pos.marks();
  if (marksAtCursor.some(m => m.type.name === 'hashTag')) return null;

  // Also check the character just before — cursor at end of mark won't have the mark
  // in $pos.marks(), but the preceding position will
  if ($pos.parentOffset > 0) {
    const $before = state.doc.resolve(selection.from - 1);
    if ($before.marks().some(m => m.type.name === 'hashTag')) return null;
  }

  const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '\ufffc');
  const match = textBefore.match(/(?:^|\s)#([^\s#][^\s]*)$/);
  if (!match) return null;

  const query = match[1];
  const hashOffset = $pos.parentOffset - query.length - 1;
  const parentStart = selection.from - $pos.parentOffset;

  return { from: parentStart + hashOffset, to: selection.from, query };
}

export const HashTag = Mark.create<HashTagOptions>({
  name: 'hashTag',
  inclusive: false,
  excludes: 'code',

  addOptions() {
    return {
      HTMLAttributes: {},
      suggestion: undefined,
      onHashTagClick: undefined,
    };
  },

  addAttributes() {
    return {
      tag: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-tag'),
        renderHTML: (attrs) => ({ 'data-tag': attrs.tag }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-tag]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'kivi-hashtag',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      insertHashTag:
        (tag: string) =>
        ({ chain }) => {
          return chain()
            .insertContent({
              type: 'text',
              text: `#${tag}`,
              marks: [{ type: 'hashTag', attrs: { tag } }],
            })
            .run();
        },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /(?:^|\s)#([^\s#][^\s]*)\s$/,
        handler: ({ range, match, chain }) => {
          const tag = match[1];
          const hashStart = range.from + (match[0].startsWith(' ') ? 1 : 0);
          const tagEnd = range.to - 1;
          chain()
            .command(({ tr }) => {
              const markType = tr.doc.type.schema.marks.hashTag;
              if (!markType) return false;
              tr.addMark(hashStart, tagEnd, markType.create({ tag }));
              return true;
            })
            .run();
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const plugins: Plugin[] = [];
    const markType = this.type;

    const onClick = this.options.onHashTagClick;
    if (onClick) {
      plugins.push(
        new Plugin({
          key: hashTagPluginKey,
          props: {
            handleClick(view, pos) {
              const resolved = view.state.doc.resolve(pos);
              const marks = resolved.marks();
              const hashMark = marks.find((m) => m.type === markType);
              if (hashMark) {
                onClick(hashMark.attrs.tag);
                return true;
              }
              return false;
            },
          },
        }),
      );
    }

    // Decoration for the hashtag currently being typed (before space confirms it)
    plugins.push(
      new Plugin({
        key: new PluginKey('hashTagTypingDecoration'),
        state: {
          init() { return DecorationSet.empty; },
          apply(tr, old, _oldState, newState) {
            if (!tr.docChanged && !tr.selectionSet) return old;
            const trigger = detectHashTrigger(newState);
            if (!trigger) return DecorationSet.empty;
            const $from = newState.doc.resolve(trigger.from + 1);
            if ($from.marks().some(m => m.type.name === 'hashTag')) {
              return DecorationSet.empty;
            }
            const deco = Decoration.inline(trigger.from, trigger.to, {
              class: 'kivi-tag-typing',
            });
            return DecorationSet.create(newState.doc, [deco]);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    );

    const suggestion = this.options.suggestion;
    if (suggestion) {
      plugins.push(createSuggestionPlugin(suggestion));
    }

    return plugins;
  },
});

// ── Highlight helpers ──

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function highlightTagMatch(tag: string, query: string): string {
  if (!query) return escHtml(tag);

  const tLower = tag.toLowerCase();
  const qLower = query.toLowerCase();

  const subIdx = tLower.indexOf(qLower);
  if (subIdx >= 0) {
    return (
      escHtml(tag.substring(0, subIdx)) +
      '<b>' + escHtml(tag.substring(subIdx, subIdx + query.length)) + '</b>' +
      escHtml(tag.substring(subIdx + query.length))
    );
  }

  let result = '';
  let qi = 0;
  for (let ti = 0; ti < tag.length; ti++) {
    if (qi < qLower.length && tLower[ti] === qLower[qi]) {
      result += '<b>' + escHtml(tag[ti]) + '</b>';
      qi++;
    } else {
      result += escHtml(tag[ti]);
    }
  }
  return result;
}

// ── Suggestion plugin (self-contained) ──

function createSuggestionPlugin(
  suggestion: NonNullable<HashTagOptions['suggestion']>,
): Plugin {
  let popupEl: HTMLElement | null = null;
  let items: string[] = [];
  let selectedIndex = 0;
  let activeRange: { from: number; to: number; query: string } | null = null;
  let lastFetchedQuery: string | null = null;
  let active = false;
  let editorView: EditorView | null = null;
  let lastRenderedItems: string[] | null = null;
  let lastRenderedSelected = -1;
  let lastRenderedQuery = '';
  let scrollListenerEl: HTMLElement | null = null;
  let scrollHandler: (() => void) | null = null;

  function attachScroll(view: EditorView) {
    detachScroll();
    const parent = view.dom.parentElement;
    if (!parent) return;
    scrollListenerEl = parent;
    scrollHandler = () => { if (popupEl && activeRange) positionPopupEl(view); };
    parent.addEventListener('scroll', scrollHandler, { passive: true });
  }

  function detachScroll() {
    if (scrollListenerEl && scrollHandler) {
      scrollListenerEl.removeEventListener('scroll', scrollHandler);
    }
    scrollListenerEl = null;
    scrollHandler = null;
  }

  function positionPopupEl(view: EditorView) {
    if (!popupEl || !activeRange) return;
    try {
      const coords = view.coordsAtPos(activeRange.from);
      const container = view.dom.parentElement;
      const cr = container?.getBoundingClientRect() ?? null;
      positionFixedPopup({
        anchorRect: { top: coords.top, bottom: coords.bottom, left: coords.left, right: coords.left },
        popup: popupEl,
        containerRect: cr,
        gap: 4,
        pad: 8,
        preferY: 'below',
        anchorEl: view.dom as HTMLElement,
      });
    } catch { /* view may be destroyed */ }
  }

  function destroy() {
    detachScroll();
    if (popupEl) { popupEl.remove(); popupEl = null; }
    items = [];
    selectedIndex = 0;
    activeRange = null;
    active = false;
    lastFetchedQuery = null;
    lastRenderedItems = null;
    lastRenderedSelected = -1;
    lastRenderedQuery = '';
  }

  function applyTag(view: EditorView, tag: string) {
    const trigger = detectHashTrigger(view.state);
    if (!trigger) { destroy(); return; }

    const { from, to } = trigger;
    const text = `#${tag} `;
    const tr = view.state.tr;
    tr.delete(from, to);
    tr.insertText(text, from);
    const tagMark = view.state.schema.marks.hashTag;
    if (tagMark) {
      tr.addMark(from, from + text.length - 1, tagMark.create({ tag }));
    }
    tr.setSelection(TextSelection.create(tr.doc, from + text.length));
    view.dispatch(tr.scrollIntoView());
    destroy();
    view.focus();
  }

  function updateSelectedHighlight() {
    if (!popupEl) return;
    const children = popupEl.children;
    for (let i = 0; i < children.length; i++) {
      children[i].classList.toggle('kivi-tag-suggest-active', i === selectedIndex);
    }
    const active = children[selectedIndex] as HTMLElement | undefined;
    if (active) active.scrollIntoView({ block: 'nearest' });
    lastRenderedSelected = selectedIndex;
  }

  function renderPopup(view: EditorView) {
    if (!active || items.length === 0 || !activeRange) {
      if (popupEl) { detachScroll(); popupEl.remove(); popupEl = null; }
      lastRenderedItems = null;
      return;
    }

    const query = activeRange.query;
    const itemsChanged = !lastRenderedItems
      || items.length !== lastRenderedItems.length
      || items.some((t, i) => t !== lastRenderedItems![i])
      || query !== lastRenderedQuery;

    if (!popupEl) {
      popupEl = document.createElement('div');
      popupEl.className = 'kivi-tag-suggest';
      popupEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = (e.target as HTMLElement).closest('.kivi-tag-suggest-item') as HTMLElement | null;
        if (target) {
          const idx = parseInt(target.dataset.idx ?? '0', 10);
          applyTag(view, items[idx]);
        }
      });
      popupEl.addEventListener('mouseover', (e) => {
        const target = (e.target as HTMLElement).closest('.kivi-tag-suggest-item') as HTMLElement | null;
        if (target) {
          const idx = parseInt(target.dataset.idx ?? '0', 10);
          if (idx !== selectedIndex) {
            selectedIndex = idx;
            updateSelectedHighlight();
          }
        }
      });
      document.body.appendChild(popupEl);
      attachScroll(view);
    }

    if (itemsChanged) {
      popupEl.innerHTML = items.map((item, i) => {
        const cls = i === selectedIndex ? ' kivi-tag-suggest-active' : '';
        return `<div class="kivi-tag-suggest-item${cls}" data-idx="${i}">#${highlightTagMatch(item, query)}</div>`;
      }).join('');
      lastRenderedItems = items.slice();
      lastRenderedSelected = selectedIndex;
      lastRenderedQuery = query;
    } else if (selectedIndex !== lastRenderedSelected) {
      updateSelectedHighlight();
    }

    positionPopupEl(view);
  }

  function fetchItems(query: string, view: EditorView) {
    if (query === lastFetchedQuery) return;
    lastFetchedQuery = query;

    const result = suggestion.items(query);
    if (result instanceof Promise) {
      result.then((res) => {
        if (!active || editorView !== view) return;
        if (lastFetchedQuery !== query) return;
        items = res.slice(0, 12);
        selectedIndex = 0;
        renderPopup(view);
      }).catch(() => {});
    } else {
      items = result.slice(0, 12);
      selectedIndex = 0;
      renderPopup(view);
    }
  }

  return new Plugin({
    key: suggestionPluginKey,

    view() {
      return {
        update(view) {
          editorView = view;
          const trigger = detectHashTrigger(view.state);

          if (!trigger) {
            if (active) destroy();
            return;
          }

          active = true;
          activeRange = trigger;
          fetchItems(trigger.query, view);
        },
        destroy() {
          destroy();
          editorView = null;
        },
      };
    },

    props: {
      handleKeyDown(view, event) {
        if (!active) return false;

        if (event.key === 'Escape') {
          event.preventDefault();
          destroy();
          return true;
        }

        if (items.length === 0) {
          if (event.key === 'Enter' || event.key === ' ') {
            if (activeRange) {
              const trigger = detectHashTrigger(view.state);
              if (trigger?.query) {
                event.preventDefault();
                applyTag(view, trigger.query);
                return true;
              }
            }
            destroy();
            return false;
          }
          return false;
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          selectedIndex = (selectedIndex + 1) % items.length;
          updateSelectedHighlight();
          return true;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          updateSelectedHighlight();
          return true;
        }
        if (event.key === 'Tab' || event.key === 'Enter') {
          event.preventDefault();
          applyTag(view, items[selectedIndex]);
          return true;
        }
        if (event.key === ' ') {
          const trigger = detectHashTrigger(view.state);
          if (!trigger?.query) {
            destroy();
            return false;
          }
          event.preventDefault();
          applyTag(view, trigger.query || items[selectedIndex]);
          return true;
        }
        return false;
      },
    },
  });
}
