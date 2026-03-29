import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { SearchOptions, SearchResult } from '@kivi/shared-types';

type CommandProps = { tr: Transaction; dispatch: ((tr: Transaction) => void) | undefined };

export interface KiviSearchOptions {
  highlightClass: string;
  activeHighlightClass: string;
}

interface SearchState {
  query: string;
  results: SearchResult[];
  activeIndex: number;
  options: SearchOptions;
  decorations: DecorationSet;
}

export const searchPluginKey = new PluginKey('kiviSearch');

export const KiviSearch = Extension.create<KiviSearchOptions>({
  name: 'kiviSearch',

  addOptions() {
    return {
      highlightClass: 'kivi-search-highlight',
      activeHighlightClass: 'kivi-search-highlight-active',
    };
  },

  addCommands() {
    return {
      setSearchQuery:
        (searchOptions: SearchOptions) =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(searchPluginKey, { type: 'search', options: searchOptions });
            dispatch(tr);
          }
          return true;
        },
      clearSearch:
        () =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(searchPluginKey, { type: 'clear' });
            dispatch(tr);
          }
          return true;
        },
      nextSearchResult:
        () =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(searchPluginKey, { type: 'next' });
            dispatch(tr);
          }
          return true;
        },
      previousSearchResult:
        () =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(searchPluginKey, { type: 'previous' });
            dispatch(tr);
          }
          return true;
        },
      replaceCurrentResult:
        (replacement: string) =>
        ({ tr, dispatch, state }: CommandProps & { state: import('@tiptap/pm/state').EditorState }) => {
          const searchState = searchPluginKey.getState(state) as SearchState | undefined;
          if (!searchState || searchState.activeIndex < 0 || searchState.activeIndex >= searchState.results.length) {
            return false;
          }
          const match = searchState.results[searchState.activeIndex];
          if (dispatch) {
            if (replacement) {
              tr.insertText(replacement, match.from, match.to);
            } else {
              tr.delete(match.from, match.to);
            }
            tr.setMeta(searchPluginKey, { type: 'rerun' });
            dispatch(tr);
          }
          return true;
        },
      replaceAllResults:
        (replacement: string) =>
        ({ tr, dispatch, state }: CommandProps & { state: import('@tiptap/pm/state').EditorState }) => {
          const searchState = searchPluginKey.getState(state) as SearchState | undefined;
          if (!searchState || searchState.results.length === 0) {
            return false;
          }
          if (dispatch) {
            const sorted = [...searchState.results].sort((a, b) => b.from - a.from);
            for (const match of sorted) {
              if (replacement) {
                tr.insertText(replacement, match.from, match.to);
              } else {
                tr.delete(match.from, match.to);
              }
            }
            tr.setMeta(searchPluginKey, { type: 'rerun' });
            dispatch(tr);
          }
          return true;
        },
    } as Record<string, (...args: unknown[]) => unknown>;
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      new Plugin({
        key: searchPluginKey,
        state: {
          init(): SearchState {
            return {
              query: '',
              results: [],
              activeIndex: -1,
              options: { query: '' },
              decorations: DecorationSet.empty,
            };
          },
          apply(tr, state): SearchState {
            const meta = tr.getMeta(searchPluginKey);
            if (!meta) {
              if (tr.docChanged && state.query) {
                const results = findMatches(tr.doc, state.options);
                const activeIndex = results.length > 0
                  ? Math.min(state.activeIndex, results.length - 1)
                  : -1;
                const decorations = buildDecorations(tr.doc, results, activeIndex, options);
                return { ...state, results, activeIndex, decorations };
              }
              return state;
            }

            switch (meta.type) {
              case 'search': {
                const searchOpts: SearchOptions = meta.options;
                const results = findMatches(tr.doc, searchOpts);
                const decorations = buildDecorations(tr.doc, results, 0, options);
                return {
                  query: searchOpts.query,
                  results,
                  activeIndex: results.length > 0 ? 0 : -1,
                  options: searchOpts,
                  decorations,
                };
              }
              case 'clear':
                return {
                  query: '',
                  results: [],
                  activeIndex: -1,
                  options: { query: '' },
                  decorations: DecorationSet.empty,
                };
              case 'next': {
                if (state.results.length === 0) return state;
                const nextIndex = (state.activeIndex + 1) % state.results.length;
                const decorations = buildDecorations(tr.doc, state.results, nextIndex, options);
                return { ...state, activeIndex: nextIndex, decorations };
              }
              case 'previous': {
                if (state.results.length === 0) return state;
                const prevIndex =
                  (state.activeIndex - 1 + state.results.length) % state.results.length;
                const decorations = buildDecorations(tr.doc, state.results, prevIndex, options);
                return { ...state, activeIndex: prevIndex, decorations };
              }
              case 'rerun': {
                if (!state.query) return state;
                const results = findMatches(tr.doc, state.options);
                const activeIndex = results.length > 0
                  ? Math.min(state.activeIndex, results.length - 1)
                  : -1;
                const decorations = buildDecorations(tr.doc, results, activeIndex, options);
                return { ...state, results, activeIndex, decorations };
              }
              default:
                return state;
            }
          },
        },
        props: {
          decorations(state) {
            return this.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Escape: () => {
        // @ts-expect-error — custom command
        return this.editor.commands.clearSearch();
      },
    };
  },
});

function findMatches(
  doc: import('@tiptap/pm/model').Node,
  options: SearchOptions,
): SearchResult[] {
  const results: SearchResult[] = [];
  const query = options.query;

  if (!query) return results;

  let pattern: RegExp;
  try {
    if (options.regex) {
      const wb = options.wholeWord ? '\\b' : '';
      pattern = new RegExp(`${wb}${query}${wb}`, options.caseSensitive ? 'g' : 'gi');
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wordBoundary = options.wholeWord ? '\\b' : '';
      pattern = new RegExp(
        `${wordBoundary}${escaped}${wordBoundary}`,
        options.caseSensitive ? 'g' : 'gi',
      );
    }
  } catch {
    return results;
  }

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    let match;
    while ((match = pattern.exec(node.text)) !== null) {
      results.push({
        from: pos + match.index,
        to: pos + match.index + match[0].length,
        matchText: match[0],
      });
    }
  });

  return results;
}

function buildDecorations(
  doc: import('@tiptap/pm/model').Node,
  results: SearchResult[],
  activeIndex: number,
  options: KiviSearchOptions,
): DecorationSet {
  const decorations = results.map((result, i) =>
    Decoration.inline(result.from, result.to, {
      class: i === activeIndex ? options.activeHighlightClass : options.highlightClass,
    }),
  );

  return DecorationSet.create(doc, decorations);
}
