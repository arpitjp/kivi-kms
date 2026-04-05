import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { KiviDocument } from '@kivi/shared-types';

const dirtyTrackerKey = new PluginKey('kiviDirtyTracker');
const RESET_META_KEY = 'kiviDirtyTrackerReset';

export interface DirtyTrackerState {
  dirtyBlockIndices: Set<number>;
}

/**
 * Tracks which top-level document blocks have been modified
 * since the last loadMarkdown() call. When a transaction changes
 * the document, we determine which top-level block indices were
 * affected and mark them dirty in the KiviDocument's source map.
 *
 * Send a transaction with meta `kiviDirtyTrackerReset: true` to clear.
 */
export const DirtyTracker = Extension.create({
  name: 'kiviDirtyTracker',

  addProseMirrorPlugins() {
    return [
      new Plugin<DirtyTrackerState>({
        key: dirtyTrackerKey,
        state: {
          init(): DirtyTrackerState {
            return { dirtyBlockIndices: new Set() };
          },
          apply(tr, state, _oldEditorState, newEditorState): DirtyTrackerState {
            if (tr.getMeta(RESET_META_KEY)) {
              return { dirtyBlockIndices: new Set() };
            }

            if (!tr.docChanged) return state;

            const newDirty = new Set(state.dirtyBlockIndices);
            const doc = newEditorState.doc;
            const childCount = doc.childCount;

            // Pre-compute block start positions once for all steps
            let blockStarts: number[] | null = null;
            const getBlockStarts = (): number[] => {
              if (blockStarts) return blockStarts;
              blockStarts = new Array(childCount);
              let pos = 0;
              for (let i = 0; i < childCount; i++) {
                blockStarts[i] = pos;
                pos += doc.child(i).nodeSize;
              }
              return blockStarts;
            };

            tr.steps.forEach((step) => {
              const ranges: [number, number][] = [];

              const stepMap = step.getMap();
              stepMap.forEach((_oldStart: number, _oldEnd: number, newStart: number, newEnd: number) => {
                ranges.push([newStart, newEnd]);
              });

              if (ranges.length === 0) {
                const anyStep = step as unknown as { from?: number; to?: number };
                if (typeof anyStep.from === 'number' && typeof anyStep.to === 'number') {
                  ranges.push([anyStep.from, anyStep.to]);
                }
              }

              if (ranges.length === 0) return;

              const starts = getBlockStarts();
              const docSize = doc.content.size;

              for (const [rangeStart, rangeEnd] of ranges) {
                // Binary search for first block that could overlap
                let lo = 0, hi = childCount - 1;
                while (lo < hi) {
                  const mid = (lo + hi) >>> 1;
                  const blockEnd = mid + 1 < childCount ? starts[mid + 1] : docSize;
                  if (blockEnd <= rangeStart) lo = mid + 1;
                  else hi = mid;
                }

                for (let i = lo; i < childCount; i++) {
                  if (newDirty.has(i)) continue;
                  if (starts[i] >= rangeEnd) break;
                  newDirty.add(i);
                }
              }
            });

            return { dirtyBlockIndices: newDirty };
          },
        },
      }),
    ];
  },
});

/**
 * Get the set of dirty block indices from the editor's state.
 */
export function getDirtyBlockIndices(editorState: import('@tiptap/pm/state').EditorState): Set<number> {
  const pluginState = dirtyTrackerKey.getState(editorState) as DirtyTrackerState | undefined;
  return pluginState?.dirtyBlockIndices ?? new Set();
}

/**
 * Reset dirty tracking state. Call this after loadMarkdown()
 * so the initial setContent doesn't count as a change.
 */
export function resetDirtyTracking(editor: import('@tiptap/core').Editor): void {
  const { tr } = editor.state;
  tr.setMeta(RESET_META_KEY, true);
  editor.view.dispatch(tr);
}

/**
 * Apply dirty tracking info from the editor state onto a KiviDocument's
 * source map. This should be called before serialization.
 */
export function applyDirtyFlags(
  kiviDoc: KiviDocument,
  dirtyIndices: Set<number>,
): void {
  for (let i = 0; i < kiviDoc.blockOrder.length; i++) {
    const blockId = kiviDoc.blockOrder[i];
    const block = kiviDoc.sourceMap.blocks.get(blockId);
    if (block) {
      block.dirty = dirtyIndices.has(i);
    }
  }
}
