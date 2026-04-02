import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
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

    const suggestion = this.options.suggestion;
    if (suggestion) {
      plugins.push(createSuggestionPlugin(suggestion));
    }

    return plugins;
  },
});

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
    popupEl.style.position = 'fixed';
    popupEl.style.left = `${coords.left}px`;
    popupEl.style.top = `${coords.bottom + 4}px`;
    popupEl.style.zIndex = '10000';

    popupEl.innerHTML = items.map((item, i) => {
      const cls = i === selectedIndex ? ' kivi-tag-suggest-active' : '';
      const escaped = item.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `<div class="kivi-tag-suggest-item${cls}" data-idx="${i}">#${escaped}</div>`;
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

    requestAnimationFrame(() => {
      if (!popupEl) return;
      const rect = popupEl.getBoundingClientRect();
      if (rect.bottom > window.innerHeight) {
        popupEl.style.top = `${coords.top - rect.height - 4}px`;
      }
      if (rect.right > window.innerWidth) {
        popupEl.style.left = `${window.innerWidth - rect.width - 8}px`;
      }
    });
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
        if (!active || items.length === 0) return false;

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
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          selectItem(view, selectedIndex);
          return true;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          destroy();
          return true;
        }
        return false;
      },
    },
  });
}
