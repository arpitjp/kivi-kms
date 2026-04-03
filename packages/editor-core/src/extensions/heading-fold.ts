import { Extension } from '@tiptap/core';
import type { CommandProps } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export const headingFoldKey = new PluginKey<FoldPluginState>('kiviHeadingFold');

const SVG_CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M7.976 10.072l4.357-4.357.62.618L7.976 11.31 2.93 6.333l.62-.618z"/></svg>`;
const SVG_CHEVRON_RIGHT = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5.7 13.7L5 13l4.6-4.6L5 3.7 5.7 3l5.3 5.4z"/></svg>`;

interface FoldPluginState {
  foldedPositions: Set<number>;
}

function getSectionRange(
  doc: any,
  headingPos: number,
  headingLevel: number,
): { start: number; end: number } {
  let endPos = doc.content.size;
  let pastHeading = false;
  let startPos = headingPos;

  doc.forEach((node: any, offset: number) => {
    if (offset === headingPos) {
      pastHeading = true;
      startPos = offset + node.nodeSize;
      return;
    }
    if (!pastHeading) return;
    if (endPos < doc.content.size) return;

    if (node.type.name === 'heading') {
      const level = node.attrs?.level ?? 1;
      if (level <= headingLevel) {
        endPos = offset;
      }
    }
  });

  return { start: startPos, end: endPos };
}

function findHeadingAtPos(doc: any, pos: number): { level: number; nodeSize: number } | null {
  let result: { level: number; nodeSize: number } | null = null;
  doc.forEach((node: any, offset: number) => {
    if (result) return;
    if (offset === pos && node.type.name === 'heading') {
      result = { level: node.attrs?.level ?? 1, nodeSize: node.nodeSize };
    }
  });
  return result;
}

function collectHeadingPositions(doc: any): Array<{ pos: number; level: number }> {
  const headings: Array<{ pos: number; level: number }> = [];
  doc.forEach((node: any, offset: number) => {
    if (node.type.name === 'heading') {
      headings.push({ pos: offset, level: node.attrs?.level ?? 1 });
    }
  });
  return headings;
}

function isInsideFoldedRegion(
  doc: any,
  cursorPos: number,
  foldedPositions: Set<number>,
): number | null {
  for (const fpos of foldedPositions) {
    const heading = findHeadingAtPos(doc, fpos);
    if (!heading) continue;
    const range = getSectionRange(doc, fpos, heading.level);
    if (cursorPos >= range.start && cursorPos < range.end) {
      return fpos;
    }
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
          const headings = collectHeadingPositions(state.doc);
          let targetPos = -1;
          for (let i = headings.length - 1; i >= 0; i--) {
            if (headings[i].pos <= $from.pos) {
              targetPos = headings[i].pos;
              break;
            }
          }
          if (targetPos < 0) return false;
          const pluginState = headingFoldKey.getState(state);
          if (pluginState?.foldedPositions.has(targetPos)) return false;
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
          const headings = collectHeadingPositions(state.doc);
          let targetPos = -1;
          for (let i = headings.length - 1; i >= 0; i--) {
            if (headings[i].pos <= $from.pos) {
              targetPos = headings[i].pos;
              break;
            }
          }
          if (targetPos < 0) return false;
          const pluginState = headingFoldKey.getState(state);
          if (!pluginState?.foldedPositions.has(targetPos)) return false;
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
          init(): FoldPluginState {
            return { foldedPositions: new Set() };
          },

          apply(tr: Transaction, prev: FoldPluginState): FoldPluginState {
            const meta = tr.getMeta(headingFoldKey);

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
                const headings = collectHeadingPositions(tr.doc);
                for (const h of headings) next.add(h.pos);
              } else if (meta.action === 'unfoldAll') {
                next.clear();
              }

              return { foldedPositions: next };
            }

            if (!tr.docChanged) return prev;

            const remapped = new Set<number>();
            for (const pos of prev.foldedPositions) {
              const newPos = tr.mapping.map(pos, 1);
              if (findHeadingAtPos(tr.doc, newPos)) {
                remapped.add(newPos);
              }
            }
            return { foldedPositions: remapped };
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
          );

          if (foldedParent !== null) {
            const heading = findHeadingAtPos(newState.doc, foldedParent);
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

          function syncDOM(view: EditorView) {
            const pluginState = headingFoldKey.getState(view.state);
            if (!pluginState) return;

            const { doc } = view.state;
            const { foldedPositions } = pluginState;

            const newArrows = new Map<number, HTMLElement>();

            const hiddenRanges: Array<{ start: number; end: number }> = [];
            for (const fpos of foldedPositions) {
              const heading = findHeadingAtPos(doc, fpos);
              if (!heading) continue;
              hiddenRanges.push(getSectionRange(doc, fpos, heading.level));
            }

            doc.forEach((node: any, pos: number) => {
              const dom = view.nodeDOM(pos) as HTMLElement | null;
              if (!dom) return;

              if (node.type.name === 'heading') {
                const isFolded = foldedPositions.has(pos);

                let arrow = arrowsByPos.get(pos);
                if (!arrow) {
                  for (const [oldPos, oldArrow] of arrowsByPos) {
                    if (!newArrows.has(oldPos) && oldArrow.parentElement === dom) {
                      arrow = oldArrow;
                      break;
                    }
                  }
                }

                if (!arrow) {
                  arrow = document.createElement('span');
                  arrow.className = 'kivi-fold-arrow';
                  arrow.setAttribute('role', 'button');
                  arrow.setAttribute('aria-label', 'Toggle fold');
                  arrow.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  });
                  dom.insertBefore(arrow, dom.firstChild);
                } else if (arrow.parentElement !== dom) {
                  dom.insertBefore(arrow, dom.firstChild);
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
