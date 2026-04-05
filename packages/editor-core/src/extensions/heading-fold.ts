import { Extension } from '@tiptap/core';
import type { CommandProps } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export const headingFoldKey = new PluginKey<FoldPluginState>('kiviHeadingFold');

const SVG_CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M7.976 10.072l4.357-4.357.62.618L7.976 11.31 2.93 6.333l.62-.618z"/></svg>`;
const SVG_CHEVRON_RIGHT = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5.7 13.7L5 13l4.6-4.6L5 3.7 5.7 3l5.3 5.4z"/></svg>`;

interface HeadingInfo { level: number; nodeSize: number }

interface FoldPluginState {
  foldedPositions: Set<number>;
  headingIndex: Map<number, HeadingInfo>;
}

function buildHeadingIndex(doc: any): Map<number, HeadingInfo> {
  const index = new Map<number, HeadingInfo>();
  doc.forEach((node: any, offset: number) => {
    if (node.type.name === 'heading') {
      index.set(offset, { level: node.attrs?.level ?? 1, nodeSize: node.nodeSize });
    }
  });
  return index;
}

function getSectionRange(
  doc: any,
  headingPos: number,
  headingLevel: number,
  headingIndex: Map<number, HeadingInfo>,
): { start: number; end: number } {
  const heading = headingIndex.get(headingPos);
  if (!heading) return { start: headingPos, end: doc.content.size };

  const startPos = headingPos + heading.nodeSize;
  let endPos = doc.content.size;

  for (const [pos, info] of headingIndex) {
    if (pos <= headingPos) continue;
    if (info.level <= headingLevel) {
      endPos = pos;
      break;
    }
  }

  return { start: startPos, end: endPos };
}

function buildFoldRanges(
  doc: any,
  foldedPositions: Set<number>,
  headingIndex: Map<number, HeadingInfo>,
): Array<{ fpos: number; start: number; end: number }> {
  const ranges: Array<{ fpos: number; start: number; end: number }> = [];
  for (const fpos of foldedPositions) {
    const heading = headingIndex.get(fpos);
    if (!heading) continue;
    ranges.push({
      fpos,
      ...getSectionRange(doc, fpos, heading.level, headingIndex),
    });
  }
  return ranges;
}

function isInsideFoldedRegion(
  doc: any,
  cursorPos: number,
  foldedPositions: Set<number>,
  headingIndex: Map<number, HeadingInfo>,
): number | null {
  const ranges = buildFoldRanges(doc, foldedPositions, headingIndex);
  for (const r of ranges) {
    if (cursorPos >= r.start && cursorPos < r.end) return r.fpos;
  }
  return null;
}

export const HeadingFold = Extension.create({
  name: 'headingFold',

  addCommands() {
    return {
      toggleFoldAtPos:
        (pos: number) =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(headingFoldKey, { action: 'toggle', pos });
            dispatch(tr);
          }
          return true;
        },
      foldAtCursor:
        () =>
        ({ tr, state, dispatch }: CommandProps) => {
          const { $from } = state.selection;
          const pluginState = headingFoldKey.getState(state);
          if (!pluginState) return false;

          let targetPos = -1;
          for (const [pos] of pluginState.headingIndex) {
            if (pos <= $from.pos) targetPos = pos;
            else break;
          }
          if (targetPos < 0) return false;
          if (pluginState.foldedPositions.has(targetPos)) return false;
          if (dispatch) {
            tr.setMeta(headingFoldKey, { action: 'fold', pos: targetPos });
            dispatch(tr);
          }
          return true;
        },
      unfoldAtCursor:
        () =>
        ({ tr, state, dispatch }: CommandProps) => {
          const { $from } = state.selection;
          const pluginState = headingFoldKey.getState(state);
          if (!pluginState) return false;

          let targetPos = -1;
          for (const [pos] of pluginState.headingIndex) {
            if (pos <= $from.pos) targetPos = pos;
            else break;
          }
          if (targetPos < 0) return false;
          if (!pluginState.foldedPositions.has(targetPos)) return false;
          if (dispatch) {
            tr.setMeta(headingFoldKey, { action: 'unfold', pos: targetPos });
            dispatch(tr);
          }
          return true;
        },
      foldAll:
        () =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(headingFoldKey, { action: 'foldAll' });
            dispatch(tr);
          }
          return true;
        },
      unfoldAll:
        () =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(headingFoldKey, { action: 'unfoldAll' });
            dispatch(tr);
          }
          return true;
        },
    } as any;
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-[': () => (this.editor as any).commands.foldAtCursor(),
      'Mod-Shift-]': () => (this.editor as any).commands.unfoldAtCursor(),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<FoldPluginState>({
        key: headingFoldKey,

        state: {
          init(_config, state): FoldPluginState {
            return {
              foldedPositions: new Set(),
              headingIndex: buildHeadingIndex(state.doc),
            };
          },

          apply(tr: Transaction, prev: FoldPluginState): FoldPluginState {
            const meta = tr.getMeta(headingFoldKey);

            // Rebuild heading index only when the number of top-level nodes
            // changes (insert/delete/split/join). For simple text edits inside
            // a node, just remap positions — the heading set hasn't changed.
            let headingIndex: Map<number, HeadingInfo>;
            if (!tr.docChanged) {
              headingIndex = prev.headingIndex;
            } else if (tr.doc.childCount !== tr.before.childCount) {
              headingIndex = buildHeadingIndex(tr.doc);
            } else {
              headingIndex = new Map();
              for (const [pos, info] of prev.headingIndex) {
                const mapped = tr.mapping.map(pos, 1);
                headingIndex.set(mapped, info);
              }
            }

            if (meta) {
              const next = new Set(prev.foldedPositions);

              if (meta.action === 'toggle') {
                const mapped = tr.mapping.map(meta.pos);
                if (next.has(mapped)) next.delete(mapped);
                else next.add(mapped);
              } else if (meta.action === 'fold') {
                next.add(tr.mapping.map(meta.pos));
              } else if (meta.action === 'unfold') {
                next.delete(tr.mapping.map(meta.pos));
              } else if (meta.action === 'foldAll') {
                for (const pos of headingIndex.keys()) next.add(pos);
              } else if (meta.action === 'unfoldAll') {
                next.clear();
              }

              return { foldedPositions: next, headingIndex };
            }

            if (!tr.docChanged) return prev;

            const remapped = new Set<number>();
            for (const pos of prev.foldedPositions) {
              const newPos = tr.mapping.map(pos, 1);
              if (headingIndex.has(newPos)) {
                remapped.add(newPos);
              }
            }
            return { foldedPositions: remapped, headingIndex };
          },
        },

        appendTransaction(_transactions, _oldState, newState) {
          const pluginState = headingFoldKey.getState(newState);
          if (!pluginState || pluginState.foldedPositions.size === 0) return null;

          const { $from } = newState.selection;
          const foldedParent = isInsideFoldedRegion(
            newState.doc,
            $from.pos,
            pluginState.foldedPositions,
            pluginState.headingIndex,
          );

          if (foldedParent !== null) {
            const heading = pluginState.headingIndex.get(foldedParent);
            if (heading) {
              const endOfHeading = foldedParent + heading.nodeSize - 1;
              const resolved = newState.doc.resolve(
                Math.min(endOfHeading, newState.doc.content.size),
              );
              return newState.tr.setSelection(TextSelection.near(resolved));
            }
          }

          return null;
        },

        view() {
          let arrowsByPos = new Map<number, HTMLElement>();
          let lastFoldedSnapshot = '';
          let lastHeadingCount = -1;

          function foldSnapshot(state: FoldPluginState): string {
            if (state.foldedPositions.size === 0) return '';
            return Array.from(state.foldedPositions).sort().join(',');
          }

          function arrowsAttached(): boolean {
            for (const arrow of arrowsByPos.values()) {
              if (!arrow.isConnected) return false;
            }
            return arrowsByPos.size > 0;
          }

          function createArrow(): HTMLElement {
            const arrow = document.createElement('span');
            arrow.className = 'kivi-fold-arrow';
            arrow.setAttribute('role', 'button');
            arrow.setAttribute('aria-label', 'Toggle fold');
            arrow.addEventListener('mousedown', (e) => {
              e.preventDefault();
              e.stopPropagation();
            });
            return arrow;
          }

          function syncDOM(view: EditorView) {
            const pluginState = headingFoldKey.getState(view.state);
            if (!pluginState) return;

            const snap = foldSnapshot(pluginState);
            const hCount = pluginState.headingIndex.size;

            const structureChanged = snap !== lastFoldedSnapshot || hCount !== lastHeadingCount;
            const domStale = !arrowsAttached();

            if (!structureChanged && !domStale) return;
            lastFoldedSnapshot = snap;
            lastHeadingCount = hCount;

            const { doc } = view.state;
            const { foldedPositions, headingIndex } = pluginState;

            const newArrows = new Map<number, HTMLElement>();

            const hiddenRanges: Array<{ start: number; end: number }> = [];
            for (const fpos of foldedPositions) {
              const heading = headingIndex.get(fpos);
              if (!heading) continue;
              hiddenRanges.push(getSectionRange(doc, fpos, heading.level, headingIndex));
            }

            doc.forEach((node: any, pos: number) => {
              const dom = view.nodeDOM(pos) as HTMLElement | null;
              if (!dom) return;

              if (node.type.name === 'heading') {
                const isFolded = foldedPositions.has(pos);

                let arrow = arrowsByPos.get(pos);

                if (arrow && !arrow.isConnected) arrow = undefined;
                if (arrow && arrow.parentElement !== dom) arrow = undefined;

                if (!arrow) {
                  const existing = dom.querySelector('.kivi-fold-arrow') as HTMLElement | null;
                  arrow = existing || createArrow();
                  if (!arrow.isConnected || arrow.parentElement !== dom) {
                    dom.insertBefore(arrow, dom.firstChild);
                  }
                }

                const capturedPos = pos;
                arrow.onclick = (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  view.dispatch(
                    view.state.tr.setMeta(headingFoldKey, { action: 'toggle', pos: capturedPos }),
                  );
                };

                arrow.innerHTML = isFolded ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN;
                arrow.classList.toggle('kivi-fold-folded', isFolded);
                dom.classList.toggle('kivi-heading-folded', isFolded);

                newArrows.set(pos, arrow);
              }

              const isInHidden = hiddenRanges.some(
                (r) => pos >= r.start && pos < r.end,
              );
              const isThisFolded = node.type.name === 'heading' && foldedPositions.has(pos);
              if (!isThisFolded) {
                if (isInHidden) {
                  dom.style.display = 'none';
                  dom.classList.add('kivi-folded-node');
                } else if (dom.classList.contains('kivi-folded-node')) {
                  dom.style.display = '';
                  dom.classList.remove('kivi-folded-node');
                }
              }
            });

            for (const [oldPos, oldArrow] of arrowsByPos) {
              if (!newArrows.has(oldPos) && !Array.from(newArrows.values()).includes(oldArrow)) {
                oldArrow.remove();
              }
            }

            arrowsByPos = newArrows;
          }

          return {
            update(view: EditorView) {
              requestAnimationFrame(() => {
                try { syncDOM(view); } catch (_) { /* stale view guard */ }
              });
            },
            destroy() {
              for (const arrow of arrowsByPos.values()) {
                arrow.remove();
              }
              arrowsByPos.clear();
            },
          };
        },
      }),
    ];
  },
});
