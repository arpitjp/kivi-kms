import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

const inlineCodeInputKey = new PluginKey('kiviInlineCodeInput');

/**
 * Enhances inline code input:
 * - When user types two backticks in succession (``), creates a zero-width
 *   code span and places cursor inside it so the user can type code content.
 * - Handles exiting code mark when pressing right arrow or space at the end.
 */
export const InlineCodeInput = Extension.create({
  name: 'kiviInlineCodeInput',

  addProseMirrorPlugins() {
    const editor = this.editor;
    let lastBacktickPos: number | null = null;
    let lastBacktickTime = 0;

    return [
      new Plugin({
        key: inlineCodeInputKey,
        props: {
          handleTextInput(view, from, to, text) {
            if (text !== '`') {
              lastBacktickPos = null;
              return false;
            }

            const now = Date.now();
            const { state } = view;
            const { $from } = state.selection;

            // Don't interfere inside code blocks
            if ($from.parent.type.name === 'codeBlock') return false;

            // If we already have a code mark active, the closing backtick should exit
            const codeMark = state.schema.marks.code;
            if (!codeMark) return false;

            const hasCodeMark = codeMark.isInSet($from.marks());

            if (hasCodeMark) {
              // User typed closing backtick while in code mark — exit the code mark
              const tr = state.tr;
              tr.removeStoredMark(codeMark);
              // Don't insert the backtick character
              view.dispatch(tr);
              lastBacktickPos = null;
              return true;
            }

            // Check if previous char was a backtick typed within 1.5s
            if (lastBacktickPos !== null && from === lastBacktickPos + 1 && now - lastBacktickTime < 1500) {
              // User typed two consecutive backticks — delete the first one and enable code mark
              const tr = state.tr;
              tr.delete(from - 1, from); // remove the first backtick
              tr.addStoredMark(codeMark.create());
              // Don't insert the second backtick either
              view.dispatch(tr);
              lastBacktickPos = null;
              return true;
            }

            // First backtick — let it insert normally, remember position
            lastBacktickPos = from;
            lastBacktickTime = now;
            return false;
          },

          handleKeyDown(view, event) {
            // If typing in a code mark and pressing right arrow at end, exit mark
            if (event.key === 'ArrowRight' || event.key === 'Escape') {
              const { state } = view;
              const { $from, from, to } = state.selection;
              if (from !== to) return false;

              const codeMark = state.schema.marks.code;
              if (!codeMark) return false;

              if (!codeMark.isInSet($from.marks())) return false;

              // Check if cursor is at the end of the code mark range
              const parent = $from.parent;
              const indexInParent = $from.index();
              if (indexInParent < parent.childCount) {
                const nodeAfter = parent.child(indexInParent);
                const hasCodeAfter = codeMark.isInSet(nodeAfter.marks);
                if (hasCodeAfter) return false;
              }

              // At the end of code mark — remove stored mark
              if (event.key === 'ArrowRight') {
                const tr = state.tr.removeStoredMark(codeMark);
                view.dispatch(tr);
                return false;
              }
            }
            return false;
          },
        },
      }),
    ];
  },
});
