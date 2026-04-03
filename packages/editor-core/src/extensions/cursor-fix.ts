import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { GapCursor } from '@tiptap/pm/gapcursor';

const trailingNodeKey = new PluginKey('kiviTrailingNode');

/**
 * Ensures idiomatic cursor placement throughout the editor:
 *
 * - TrailingNode: keeps an empty paragraph at the end of the document whenever
 *   the last child is a non-text block (HR, image, video, table, etc.) so the
 *   user always has a place to click and type.
 *
 * - ClickBelowContent: clicking the empty area below the last block focuses
 *   the editor and places the cursor at the very end.
 *
 * - EnterOnNodeSelection: pressing Enter while a non-text block is selected
 *   inserts a paragraph below and places the cursor there.
 *
 * - ArrowDown at the end of the last text block before a non-text leaf node:
 *   selects the node or moves to the gap cursor.
 */
export const CursorFix = Extension.create({
  name: 'cursorFix',

  addProseMirrorPlugins() {
    const schema = this.editor.schema;
    const paragraphType = schema.nodes.paragraph;

    const plugins: Plugin[] = [];

    // ── Trailing-node: keep an empty paragraph at the end ────────
    if (paragraphType) {
      plugins.push(
        new Plugin({
          key: trailingNodeKey,
          appendTransaction(_transactions, _oldState, newState) {
            const { doc } = newState;
            const lastChild = doc.lastChild;
            if (!lastChild) return null;

            if (lastChild.isTextblock) return null;

            return newState.tr.insert(doc.content.size, paragraphType.create());
          },
        }),
      );
    }

    // ── Click below content → place cursor at end ───────────────
    plugins.push(
      new Plugin({
        props: {
          handleClick(view: EditorView, _pos: number, event: MouseEvent): boolean {
            const editorRect = view.dom.getBoundingClientRect();
            const clickY = event.clientY;

            // Find the lowest content element (skip decorations like gapcursor)
            let lowest = 0;
            for (let i = view.dom.children.length - 1; i >= 0; i--) {
              const child = view.dom.children[i] as HTMLElement;
              if (!child.classList?.contains('ProseMirror-gapcursor')) {
                lowest = child.getBoundingClientRect().bottom;
                break;
              }
            }

            if (clickY > lowest && clickY <= editorRect.bottom + 50) {
              const end = TextSelection.atEnd(view.state.doc);
              view.dispatch(view.state.tr.setSelection(end).scrollIntoView());
              view.focus();
              return true;
            }

            return false;
          },
        },
      }),
    );

    // ── Typing on atom node selection → redirect to paragraph after ──
    // Prevents accidental deletion of excalidraw, image, video blocks.
    plugins.push(
      new Plugin({
        props: {
          handleTextInput(view: EditorView, _from: number, _to: number, text: string): boolean {
            const { state } = view;

            if (state.selection instanceof GapCursor && paragraphType) {
              const pos = state.selection.from;
              const tr = state.tr.insert(pos, paragraphType.create(null, state.schema.text(text)));
              tr.setSelection(TextSelection.create(tr.doc, pos + 1 + text.length));
              tr.scrollIntoView();
              view.dispatch(tr);
              return true;
            }

            if (!(state.selection instanceof NodeSelection)) return false;
            const selectedNode = state.selection.node;
            if (!selectedNode.type.isAtom) return false;

            const endPos = state.selection.to;
            const $end = state.doc.resolve(endPos);
            const after = $end.nodeAfter;

            const tr = state.tr;
            if (after && after.isTextblock) {
              tr.setSelection(TextSelection.create(state.doc, endPos + 1));
              tr.insertText(text);
            } else if (paragraphType) {
              tr.insert(endPos, paragraphType.create(null, state.schema.text(text)));
              tr.setSelection(TextSelection.create(tr.doc, endPos + 1 + text.length));
            } else {
              return false;
            }
            tr.scrollIntoView();
            view.dispatch(tr);
            return true;
          },

          handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
            const { state } = view;
            const { selection } = state;

            // Enter on gap cursor: insert paragraph at the gap position
            if (event.key === 'Enter' && !event.isComposing
                && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
              if (selection instanceof GapCursor) {
                const insertPos = selection.from;
                const tr = state.tr.insert(insertPos, paragraphType!.create());
                tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
                tr.scrollIntoView();
                view.dispatch(tr);
                return true;
              }

              // Enter on atom node selection: insert paragraph after
              if (selection instanceof NodeSelection && selection.node.type.isAtom) {
                const endPos = selection.to;
                const $end = state.doc.resolve(endPos);
                const after = $end.nodeAfter;
                const tr = state.tr;
                if (after && after.isTextblock) {
                  tr.setSelection(TextSelection.create(state.doc, endPos + 1));
                } else if (paragraphType) {
                  tr.insert(endPos, paragraphType.create());
                  tr.setSelection(TextSelection.create(tr.doc, endPos + 1));
                }
                tr.scrollIntoView();
                view.dispatch(tr);
                return true;
              }
            }

            return false;
          },
        },
      }),
    );

    return plugins;
  },
});
