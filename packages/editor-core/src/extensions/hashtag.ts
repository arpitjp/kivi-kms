import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { InputRule } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
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
  const match = textBefore.match(/(?:^|\s)#([a-zA-Z0-9_/\-]*)$/);
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
        find: /(?:^|\s)#([a-zA-Z0-9_/][a-zA-Z0-9_/-]*)\s$/,
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
          apply(_tr, _old, _oldState, newState) {
            const trigger = detectHashTrigger(newState);
            if (!trigger) return DecorationSet.empty;
            // Don't decorate if the range already has a hashTag mark
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
  let activeRange: { from: number; to: number } | null = null;
  let fetchTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFetchedQuery: string | null = null;
  let active = false;
  let editorView: EditorView | null = null;

  function destroy() {
    if (popupEl) { popupEl.remove(); popupEl = null; }
    if (fetchTimer) { clearTimeout(fetchTimer); fetchTimer = null; }
    items = [];
    selectedIndex = 0;
    activeRange = null;
    active = false;
    lastFetchedQuery = null;
  }

  function confirmTypedTag(view: EditorView) {
    if (!activeRange) return;
    const trigger = detectHashTrigger(view.state);
    if (!trigger || !trigger.query) { destroy(); return; }

    const { from } = trigger;
    const to = trigger.to;
    const tag = trigger.query;

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

  function selectItem(view: EditorView, index: number) {
    const tag = items[index];
    if (!tag || !activeRange) return;

    const { from, to } = activeRange;
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

  function renderPopup(view: EditorView) {
    if (!active || items.length === 0 || !activeRange) {
      if (popupEl) { popupEl.remove(); popupEl = null; }
      return;
    }

    if (!popupEl) {
      popupEl = document.createElement('div');
      popupEl.className = 'kivi-tag-suggest';
      document.body.appendChild(popupEl);
    }

    const coords = view.coordsAtPos(activeRange.from);
    const container = view.dom.parentElement;
    const cr = container?.getBoundingClientRect()
      ?? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    popupEl.style.position = 'fixed';
    popupEl.style.zIndex = '10000';

    const query = activeRange ? detectHashTrigger(view.state)?.query ?? '' : '';
    popupEl.innerHTML = items.map((item, i) => {
      const cls = i === selectedIndex ? ' kivi-tag-suggest-active' : '';
      const highlighted = highlightTagMatch(item, query);
      return `<div class="kivi-tag-suggest-item${cls}" data-idx="${i}">#${highlighted}</div>`;
    }).join('');

    popupEl.querySelectorAll('.kivi-tag-suggest-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectItem(view, parseInt((el as HTMLElement).dataset.idx ?? '0', 10));
      });
      el.addEventListener('mouseenter', () => {
        const idx = parseInt((el as HTMLElement).dataset.idx ?? '0', 10);
        selectedIndex = idx;
        renderPopup(view);
      });
    });

    const gap = 4;
    const pad = 8;
    const ph = popupEl.offsetHeight || 120;
    const pw = popupEl.offsetWidth || 160;
    const viewBottom = Math.min(cr.bottom, window.innerHeight);
    const viewTop = Math.max(cr.top, 0);
    const spaceBelow = viewBottom - coords.bottom;
    const spaceAbove = coords.top - viewTop;

    // Prefer above so the dropdown doesn't cover the text being typed below
    let top: number;
    if (spaceAbove >= ph + gap) {
      top = coords.top - ph - gap;
    } else if (spaceBelow >= ph + gap) {
      top = coords.bottom + gap;
    } else {
      top = spaceAbove >= spaceBelow
        ? coords.top - ph - gap
        : coords.bottom + gap;
    }
    top = Math.max(viewTop + pad, Math.min(top, viewBottom - ph - pad));

    let left = coords.left;
    const maxLeft = Math.min(cr.right, window.innerWidth) - pw - pad;
    if (left > maxLeft) left = maxLeft;
    if (left < Math.max(cr.left, 0) + pad) left = Math.max(cr.left, 0) + pad;

    popupEl.style.left = `${left}px`;
    popupEl.style.top = `${top}px`;
  }

  async function fetchItems(query: string, view: EditorView) {
    if (query === lastFetchedQuery) return;
    lastFetchedQuery = query;

    try {
      const result = await suggestion.items(query);
      // Verify trigger is still valid
      if (!active || editorView !== view) return;
      const trigger = detectHashTrigger(view.state);
      if (!trigger || trigger.query !== query) return;

      items = result.slice(0, 12);
      selectedIndex = 0;
      renderPopup(view);
    } catch { /* ignore */ }
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

          if (fetchTimer) clearTimeout(fetchTimer);
          fetchTimer = setTimeout(() => fetchItems(trigger.query, view), 50);
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

        // Auto-confirm typed tag on Enter/Space even when no suggestions
        if (items.length === 0) {
          if (event.key === 'Enter' || event.key === ' ') {
            if (activeRange) {
              event.preventDefault();
              confirmTypedTag(view);
            }
            return true;
          }
          return false;
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          selectedIndex = (selectedIndex + 1) % items.length;
          renderPopup(view);
          return true;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          renderPopup(view);
          return true;
        }
        if (event.key === 'Tab') {
          event.preventDefault();
          selectItem(view, selectedIndex);
          return true;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          selectItem(view, selectedIndex);
          return true;
        }
        if (event.key === ' ') {
          event.preventDefault();
          confirmTypedTag(view);
          return true;
        }
        return false;
      },
    },
  });
}
