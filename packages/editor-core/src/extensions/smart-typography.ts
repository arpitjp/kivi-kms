import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const smartTypoKey = new PluginKey('kiviSmartTypography');

/**
 * Smart typography extension for the Kivi editor.
 *
 * Inline code (Slack-like):
 *   Type `text` → text becomes inline code (backticks removed)
 *   Works regardless of surrounding characters (even adjacent backticks)
 *   Does NOT fire when ``` would form a code block trigger
 *
 * Selection wrapping:
 *   Select text, then type ` → toggles inline code mark
 *   Select text, then type " ' ( [ { → wraps selection with pair
 *   Select text, then type * → toggles bold
 *   Select text, then type _ → toggles italic
 *   Select text, then type ~ → toggles strikethrough
 *
 * Auto-close (empty selection):
 *   Type ( [ { → inserts pair, cursor between
 *
 * Skip-close:
 *   When cursor is right before a matching closing char, typing it skips over.
 *
 * Smart delete:
 *   Backspace between matching empty pair (e.g. cursor between () ) deletes both.
 */

interface PairDef {
  open: string;
  close: string;
  mark?: string;
}

const WRAP_PAIRS: Record<string, PairDef> = {
  '`':  { open: '`', close: '`', mark: 'code' },
  '"':  { open: '"', close: '"' },
  "'":  { open: "'", close: "'" },
  '(':  { open: '(', close: ')' },
  '[':  { open: '[', close: ']' },
  '{':  { open: '{', close: '}' },
  '*':  { open: '*', close: '*', mark: 'bold' },
  '_':  { open: '_', close: '_', mark: 'italic' },
  '~':  { open: '~', close: '~', mark: 'strike' },
};

const AUTO_CLOSE: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
};

const CLOSE_TO_OPEN: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
};

function toggleMark(view: EditorView, markName: string): boolean {
  const { state } = view;
  const { selection } = state;
  const markType = state.schema.marks[markName];
  if (!markType) return false;

  const tr = state.tr;
  if (state.doc.rangeHasMark(selection.from, selection.to, markType)) {
    tr.removeMark(selection.from, selection.to, markType);
  } else {
    tr.addMark(selection.from, selection.to, markType.create());
  }
  view.dispatch(tr);
  return true;
}

function wrapSelection(view: EditorView, open: string, close: string): boolean {
  const { state } = view;
  const { from, to } = state.selection;
  const selectedText = state.doc.textBetween(from, to);

  const tr = state.tr;
  tr.insertText(open + selectedText + close, from, to);
  tr.setSelection(TextSelection.create(tr.doc, from + open.length, from + open.length + selectedText.length));
  view.dispatch(tr);
  return true;
}

function charAfterCursor(view: EditorView): string {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  return $pos.parent.textContent.charAt($pos.parentOffset) || '';
}

function charBeforeCursor(view: EditorView): string {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const offset = $pos.parentOffset;
  if (offset === 0) return '';
  return $pos.parent.textContent.charAt(offset - 1) || '';
}

function isInsideCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d);
    if (node.type.name === 'codeBlock') return true;
  }
  return false;
}

/**
 * Slack-like inline code: when user types a closing backtick, look back
 * for a matching opening backtick. If found with content between them,
 * delete both backticks and apply the code mark to the content.
 *
 * Skips if the opening backtick is preceded by another backtick (to avoid
 * interfering with ``` code block triggers typed manually).
 */
function tryInlineCode(view: EditorView, from: number): boolean {
  const { state } = view;
  const $pos = state.doc.resolve(from);
  const parentText = $pos.parent.textContent;
  const cursorInParent = $pos.parentOffset;

  // Search backwards from cursor for an unescaped opening backtick
  let openIdx = -1;
  for (let i = cursorInParent - 1; i >= 0; i--) {
    if (parentText[i] === '`') {
      openIdx = i;
      break;
    }
  }

  if (openIdx < 0) return false;

  const content = parentText.slice(openIdx + 1, cursorInParent);
  // Must have at least one non-whitespace character, and no backticks inside
  if (!content || !content.trim() || content.includes('`')) return false;

  const codeMark = state.schema.marks.code;
  if (!codeMark) return false;

  // Calculate absolute positions: parent start + offset within parent
  const parentStart = from - cursorInParent;
  const absOpen = parentStart + openIdx;
  const absClose = from; // cursor is where the closing backtick would go

  const tr = state.tr;
  // Delete the opening backtick, apply code mark to content
  // First delete opening backtick (shifts everything left by 1)
  tr.delete(absOpen, absOpen + 1);
  // Now the content runs from absOpen to absClose-1
  const markFrom = absOpen;
  const markTo = absClose - 1;
  tr.addMark(markFrom, markTo, codeMark.create());
  // Place cursor after the marked text
  tr.setSelection(TextSelection.create(tr.doc, markTo));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function handleTextInput(view: EditorView, from: number, to: number, text: string): boolean {
  if (isInsideCodeBlock(view)) return false;

  const { state } = view;
  const { selection } = state;

  // ── Selection wrapping (non-empty selection) ──
  if (!selection.empty) {
    const pair = WRAP_PAIRS[text];
    if (!pair) return false;

    if (pair.mark) {
      return toggleMark(view, pair.mark);
    }

    return wrapSelection(view, pair.open, pair.close);
  }

  // ── Empty selection behaviors ──

  // Backtick: try Slack-like inline code (closing backtick completing `text`)
  if (text === '`') {
    if (tryInlineCode(view, from)) return true;
    // Otherwise let through for Tiptap's code block input rule (```)
    return false;
  }

  // Skip-close: if typing a closing bracket and it's right after cursor, skip
  if (CLOSE_TO_OPEN[text]) {
    if (charAfterCursor(view) === text) {
      const tr = state.tr.setSelection(TextSelection.create(state.doc, selection.from + 1));
      view.dispatch(tr.scrollIntoView());
      return true;
    }
  }

  // Auto-close brackets
  if (AUTO_CLOSE[text]) {
    const closing = AUTO_CLOSE[text];
    const tr = state.tr.insertText(text + closing, from, to);
    tr.setSelection(TextSelection.create(tr.doc, from + 1));
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  return false;
}

function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if (isInsideCodeBlock(view)) return false;

  // Smart delete: Backspace between matching empty pair deletes both
  if (event.key === 'Backspace') {
    const { state } = view;
    const { selection } = state;
    if (!selection.empty) return false;

    const before = charBeforeCursor(view);
    const after = charAfterCursor(view);

    const matchingPairs: Record<string, string> = {
      '(': ')', '[': ']', '{': '}',
      '"': '"', "'": "'",
    };

    if (before && matchingPairs[before] === after) {
      const tr = state.tr.delete(selection.from - 1, selection.from + 1);
      view.dispatch(tr.scrollIntoView());
      return true;
    }
  }

  return false;
}

export const SmartTypography = Extension.create({
  name: 'kiviSmartTypography',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: smartTypoKey,
        props: {
          handleTextInput,
          handleKeyDown,
        },
      }),
    ];
  },
});
