import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { EditorState } from '@tiptap/pm/state';

const smartTypoKey = new PluginKey('kiviSmartTypography');

/**
 * Smart typography extension for the Kivi editor.
 *
 * Inline mark conversion (Slack / Markdown):
 *   `text`    → inline code
 *   **text**  → bold
 *   *text*    → italic
 *   _text_    → italic
 *   ~~text~~  → strikethrough
 *   ==text==  → highlight
 *
 *   Works when:
 *   a) The closing delimiter is typed (e.g. type `hello then `)
 *   b) Content is typed between pre-placed delimiters → converts on first char
 *   c) ArrowRight past closing delimiter
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

// ── Delimiter definitions (longest first for precedence) ──

interface MarkDelimiter {
  chars: string;
  mark: string;
}

const MARK_DELIMITERS: MarkDelimiter[] = [
  { chars: '**', mark: 'bold' },
  { chars: '~~', mark: 'strike' },
  { chars: '==', mark: 'highlight' },
  { chars: '`',  mark: 'code' },
  { chars: '*',  mark: 'italic' },
  { chars: '_',  mark: 'italic' },
];

// ── Pair / wrap definitions ──

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

const SMART_TYPO_META = 'kiviSmartTypoHandled';
const CONTINUE_META = 'smartTypoContinue';

// ── Plugin state: tracks mark-continuation sessions ──

interface ContinueSession {
  markName: string;
  endPos: number;
}

interface SmartTypoState {
  session: ContinueSession | null;
}

// ── Utility helpers ──

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
  tr.setMeta(SMART_TYPO_META, true);
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
  tr.setMeta(SMART_TYPO_META, true);
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

function isInsideCodeBlockView(view: EditorView): boolean {
  const { state } = view;
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d);
    if (node.type.name === 'codeBlock') return true;
  }
  return false;
}

function isInsideCodeBlockState(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'codeBlock') return true;
  }
  return false;
}

function cursorHasMark(state: EditorState, markName: string): boolean {
  const markType = state.schema.marks[markName];
  if (!markType) return false;
  const { $from } = state.selection;
  return markType.isInSet($from.marks()) !== undefined;
}

function hasLongerDelim(dlen: number, firstChar: string): boolean {
  return MARK_DELIMITERS.some(dd => dd.chars.length > dlen && dd.chars[0] === firstChar);
}

// ── Closing-delimiter-typed detection (handleTextInput path) ──

function tryClosingDelimiter(view: EditorView, from: number, typedChar: string): boolean {
  const { state } = view;
  const $pos = state.doc.resolve(from);
  const parentText = $pos.parent.textContent;
  const offset = $pos.parentOffset;
  const parentStart = from - offset;

  for (const d of MARK_DELIMITERS) {
    const dlen = d.chars.length;
    if (typedChar !== d.chars[dlen - 1]) continue;

    const alreadyInText = dlen - 1;
    if (offset < alreadyInText) continue;

    if (alreadyInText > 0) {
      const prev = parentText.slice(offset - alreadyInText, offset);
      if (prev !== d.chars.slice(0, alreadyInText)) continue;
    }

    if (dlen === 1 && alreadyInText === 0 && offset > 0 && parentText[offset - 1] === typedChar) {
      if (MARK_DELIMITERS.some(dd => dd.chars === typedChar + typedChar)) continue;
    }

    if (cursorHasMark(state, d.mark)) continue;

    const closeStart = offset - alreadyInText;

    for (let i = closeStart - 1; i >= dlen - 1; i--) {
      const oStart = i - dlen + 1;
      if (oStart < 0) break;
      if (parentText.slice(oStart, oStart + dlen) !== d.chars) continue;

      if (oStart > 0 && parentText[oStart - 1] === d.chars[0] && hasLongerDelim(dlen, d.chars[0])) continue;

      const content = parentText.slice(oStart + dlen, closeStart);
      if (!content || !content.trim()) continue;

      if (d.mark === 'code' && content.includes('`')) continue;
      if (d.mark !== 'code' && content.includes(d.chars)) continue;

      const markType = state.schema.marks[d.mark];
      if (!markType) continue;

      const absOpenStart = parentStart + oStart;
      const absCloseStart = parentStart + closeStart;

      const tr = state.tr;
      if (alreadyInText > 0) {
        tr.delete(absCloseStart, absCloseStart + alreadyInText);
      }
      tr.delete(absOpenStart, absOpenStart + dlen);

      const markFrom = absOpenStart;
      const markTo = absOpenStart + content.length;
      tr.addMark(markFrom, markTo, markType.create());
      tr.removeStoredMark(markType);
      tr.setSelection(TextSelection.create(tr.doc, markTo));
      tr.setMeta(SMART_TYPO_META, true);
      tr.setMeta(CONTINUE_META, null);
      view.dispatch(tr.scrollIntoView());
      return true;
    }
  }

  return false;
}

// ── Between-delimiters detection ──
//
// Check if the cursor sits between a matching opening/closing delimiter
// pair.  Strip both delimiters, apply the mark, and start a continuation
// session so subsequent typed chars inherit the mark.

function tryBetweenDelimiters(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const pos = selection.from;
  const $pos = state.doc.resolve(pos);
  const parentText = $pos.parent.textContent;
  const offset = $pos.parentOffset;
  const parentStart = pos - offset;

  for (const d of MARK_DELIMITERS) {
    const dlen = d.chars.length;

    if (offset + dlen > parentText.length) continue;
    if (parentText.slice(offset, offset + dlen) !== d.chars) continue;

    if (offset + dlen < parentText.length && parentText[offset + dlen] === d.chars[0]) {
      if (MARK_DELIMITERS.some(dd => dd.chars.length > dlen && dd.chars.startsWith(d.chars))) continue;
    }

    if (offset < dlen + 1) continue;

    for (let i = offset - 1; i >= dlen - 1; i--) {
      const oStart = i - dlen + 1;
      if (oStart < 0) break;
      if (parentText.slice(oStart, oStart + dlen) !== d.chars) continue;

      if (oStart > 0 && parentText[oStart - 1] === d.chars[0]) {
        if (MARK_DELIMITERS.some(dd => dd.chars.length > dlen && dd.chars.startsWith(d.chars))) continue;
      }

      const content = parentText.slice(oStart + dlen, offset);
      if (!content.trim()) continue;

      if (d.mark === 'code' && content.includes('`')) continue;
      if (d.mark !== 'code' && content.includes(d.chars)) continue;

      if (cursorHasMark(state, d.mark)) return null;

      const markType = state.schema.marks[d.mark];
      if (!markType) continue;

      const absOpenStart = parentStart + oStart;
      const absCloseStart = parentStart + offset;

      const tr = state.tr;
      tr.delete(absCloseStart, absCloseStart + dlen);
      tr.delete(absOpenStart, absOpenStart + dlen);

      const markFrom = absOpenStart;
      const markTo = absOpenStart + content.length;
      tr.addMark(markFrom, markTo, markType.create());
      tr.setStoredMarks([markType.create()]);
      tr.setSelection(TextSelection.create(tr.doc, markTo));
      tr.setMeta(CONTINUE_META, { markName: d.mark, endPos: markTo } as ContinueSession);
      return tr;
    }
  }

  return null;
}

// ── Mark continuation ──
//
// When a between-delimiter conversion just happened, extend the mark
// to cover each subsequently typed character.

function tryContinueMark(
  session: ContinueSession,
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  const sizeDiff = newState.doc.content.size - oldState.doc.content.size;
  if (sizeDiff !== 1) return null;

  const newPos = newState.selection.from;
  if (!newState.selection.empty) return null;

  if (newPos !== session.endPos + 1) return null;

  // If the typed character is a delimiter char for the active mark,
  // end the session and strip the mark from the delimiter so it stays
  // as plain text (avoids backtick-inside-code and similar artifacts).
  const $pos = newState.doc.resolve(newPos);
  const typedChar = $pos.parent.textContent.charAt($pos.parentOffset - 1);
  const delim = MARK_DELIMITERS.find(d => d.mark === session.markName);
  if (delim && delim.chars.includes(typedChar)) {
    const markType = newState.schema.marks[session.markName];
    if (markType) {
      const tr = newState.tr;
      tr.removeMark(newPos - 1, newPos, markType);
      tr.removeStoredMark(markType);
      tr.setMeta(CONTINUE_META, null);
      return tr;
    }
    return null;
  }

  const markType = newState.schema.marks[session.markName];
  if (!markType) return null;

  const tr = newState.tr;
  tr.addMark(session.endPos, newPos, markType.create());
  tr.setStoredMarks([markType.create()]);
  tr.setMeta(CONTINUE_META, { markName: session.markName, endPos: newPos } as ContinueSession);
  return tr;
}

// ── ArrowRight exit detection (handleKeyDown path) ──

function tryExitRightDelimiter(view: EditorView): boolean {
  const { state } = view;
  const { selection } = state;
  if (!selection.empty) return false;

  const pos = selection.from;
  const $pos = state.doc.resolve(pos);
  const parentText = $pos.parent.textContent;
  const offset = $pos.parentOffset;
  const parentStart = pos - offset;

  for (const d of MARK_DELIMITERS) {
    const dlen = d.chars.length;

    if (offset + dlen > parentText.length) continue;
    if (parentText.slice(offset, offset + dlen) !== d.chars) continue;

    if (offset + dlen < parentText.length && parentText[offset + dlen] === d.chars[0]) {
      if (MARK_DELIMITERS.some(dd => dd.chars.length > dlen && dd.chars.startsWith(d.chars))) continue;
    }

    if (offset < dlen + 1) continue;

    for (let i = offset - 1; i >= dlen - 1; i--) {
      const oStart = i - dlen + 1;
      if (oStart < 0) break;
      if (parentText.slice(oStart, oStart + dlen) !== d.chars) continue;

      if (oStart > 0 && parentText[oStart - 1] === d.chars[0]) {
        if (MARK_DELIMITERS.some(dd => dd.chars.length > dlen && dd.chars.startsWith(d.chars))) continue;
      }

      const content = parentText.slice(oStart + dlen, offset);
      if (!content.trim()) continue;

      if (d.mark === 'code' && content.includes('`')) continue;
      if (d.mark !== 'code' && content.includes(d.chars)) continue;

      if (cursorHasMark(state, d.mark)) continue;

      const markType = state.schema.marks[d.mark];
      if (!markType) continue;

      const absOpenStart = parentStart + oStart;
      const absCloseStart = parentStart + offset;

      const tr = state.tr;
      tr.delete(absCloseStart, absCloseStart + dlen);
      tr.delete(absOpenStart, absOpenStart + dlen);

      const markFrom = absOpenStart;
      const markTo = absOpenStart + content.length;
      tr.addMark(markFrom, markTo, markType.create());
      tr.removeStoredMark(markType);
      tr.setSelection(TextSelection.create(tr.doc, markTo));
      tr.setMeta(SMART_TYPO_META, true);
      tr.setMeta(CONTINUE_META, null);
      view.dispatch(tr.scrollIntoView());
      return true;
    }
  }

  return false;
}

// ── Closing-delimiter on-state fallback (appendTransaction) ──

function tryClosingDelimiterOnState(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const pos = selection.from;
  const $pos = state.doc.resolve(pos);
  const parentText = $pos.parent.textContent;
  const offset = $pos.parentOffset;
  const parentStart = pos - offset;

  for (const d of MARK_DELIMITERS) {
    const dlen = d.chars.length;

    if (offset < dlen) continue;
    if (parentText.slice(offset - dlen, offset) !== d.chars) continue;

    if (offset < parentText.length && parentText[offset] === d.chars[d.chars.length - 1]) continue;

    if (dlen === 1 && offset >= 2 && parentText[offset - 2] === d.chars[0]) {
      if (MARK_DELIMITERS.some(dd => dd.chars === d.chars + d.chars)) continue;
    }

    const closeStart = offset - dlen;

    for (let i = closeStart - 1; i >= dlen - 1; i--) {
      const oStart = i - dlen + 1;
      if (oStart < 0) break;
      if (parentText.slice(oStart, oStart + dlen) !== d.chars) continue;

      if (oStart > 0 && parentText[oStart - 1] === d.chars[0] && hasLongerDelim(dlen, d.chars[0])) continue;

      const content = parentText.slice(oStart + dlen, closeStart);
      if (!content || !content.trim()) continue;

      if (d.mark === 'code' && content.includes('`')) continue;
      if (d.mark !== 'code' && content.includes(d.chars)) continue;

      const markType = state.schema.marks[d.mark];
      if (!markType) continue;

      const absOpenStart = parentStart + oStart;
      const absCloseStart = parentStart + closeStart;

      const tr = state.tr;
      tr.delete(absCloseStart, absCloseStart + dlen);
      tr.delete(absOpenStart, absOpenStart + dlen);

      const markFrom = absOpenStart;
      const markTo = absOpenStart + content.length;
      tr.addMark(markFrom, markTo, markType.create());
      tr.removeStoredMark(markType);
      tr.setSelection(TextSelection.create(tr.doc, markTo));
      tr.setMeta(CONTINUE_META, null);
      return tr;
    }
  }

  return null;
}

// ── Markdown link [text](url) detection (handleTextInput) ──
//
// When `)` is typed (or skip-closed), check if the text forms
// [linkText](url) and convert to a link mark.

function tryMarkdownLink(view: EditorView): boolean {
  const { state } = view;
  const { selection } = state;
  if (!selection.empty) return false;

  const pos = selection.from;
  const $pos = state.doc.resolve(pos);
  const parentText = $pos.parent.textContent;
  const offset = $pos.parentOffset;
  const parentStart = pos - offset;

  // The `)` is at `offset` (char right after cursor, about to skip past)
  if (offset >= parentText.length || parentText[offset] !== ')') return false;

  const closeParenIdx = offset;

  let openParenIdx = -1;
  for (let i = closeParenIdx - 1; i >= 0; i--) {
    if (parentText[i] === '(') { openParenIdx = i; break; }
    if (parentText[i] === '\n') return false;
  }
  if (openParenIdx < 0) return false;

  if (openParenIdx < 2 || parentText[openParenIdx - 1] !== ']') return false;

  const closeBracketIdx = openParenIdx - 1;

  let openBracketIdx = -1;
  for (let i = closeBracketIdx - 1; i >= 0; i--) {
    if (parentText[i] === '[') {
      if (i > 0 && parentText[i - 1] === '[') return false; // wiki link
      openBracketIdx = i;
      break;
    }
    if (parentText[i] === ']' || parentText[i] === '\n') return false;
  }
  if (openBracketIdx < 0) return false;

  const linkText = parentText.slice(openBracketIdx + 1, closeBracketIdx);
  const url = parentText.slice(openParenIdx + 1, closeParenIdx);
  if (!linkText) return false;

  const linkMark = state.schema.marks.link;
  if (!linkMark) return false;

  const absStart = parentStart + openBracketIdx;
  const absEnd = parentStart + closeParenIdx + 1;

  const tr = state.tr;
  tr.delete(absStart, absEnd);
  tr.insertText(linkText, absStart);
  tr.addMark(absStart, absStart + linkText.length, linkMark.create({ href: url, target: '_blank' }));
  tr.setSelection(TextSelection.create(tr.doc, absStart + linkText.length));
  tr.setMeta(SMART_TYPO_META, true);
  tr.setMeta(CONTINUE_META, null);
  view.dispatch(tr.scrollIntoView());
  return true;
}

// State-based variant for appendTransaction fallback (cursor right after `)`)
function tryMarkdownLinkOnState(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const pos = selection.from;
  const $pos = state.doc.resolve(pos);
  const parentText = $pos.parent.textContent;
  const offset = $pos.parentOffset;
  const parentStart = pos - offset;

  if (offset < 1 || parentText[offset - 1] !== ')') return null;

  const closeParenIdx = offset - 1;

  let openParenIdx = -1;
  for (let i = closeParenIdx - 1; i >= 0; i--) {
    if (parentText[i] === '(') { openParenIdx = i; break; }
    if (parentText[i] === '\n') return null;
  }
  if (openParenIdx < 0) return null;

  if (openParenIdx < 2 || parentText[openParenIdx - 1] !== ']') return null;

  const closeBracketIdx = openParenIdx - 1;

  let openBracketIdx = -1;
  for (let i = closeBracketIdx - 1; i >= 0; i--) {
    if (parentText[i] === '[') {
      if (i > 0 && parentText[i - 1] === '[') return null;
      openBracketIdx = i;
      break;
    }
    if (parentText[i] === ']' || parentText[i] === '\n') return null;
  }
  if (openBracketIdx < 0) return null;

  const linkText = parentText.slice(openBracketIdx + 1, closeBracketIdx);
  const url = parentText.slice(openParenIdx + 1, closeParenIdx);
  if (!linkText) return null;

  const linkMark = state.schema.marks.link;
  if (!linkMark) return null;

  const absStart = parentStart + openBracketIdx;
  const absEnd = parentStart + closeParenIdx + 1;

  const tr = state.tr;
  tr.delete(absStart, absEnd);
  tr.insertText(linkText, absStart);
  tr.addMark(absStart, absStart + linkText.length, linkMark.create({ href: url, target: '_blank' }));
  tr.setSelection(TextSelection.create(tr.doc, absStart + linkText.length));
  tr.setMeta(CONTINUE_META, null);
  return tr;
}

// ── Bullet/Paragraph → Task conversion ──
// Detects `[ ] ` or `[x] ` typed at the start of a bullet list item
// or a plain paragraph and converts to a task list checkbox.

function tryBulletToTaskOnInput(view: EditorView, from: number): boolean {
  const { state } = view;
  const { schema } = state;
  const $pos = state.doc.resolve(from);
  const paragraph = $pos.parent;
  if (paragraph.type.name !== 'paragraph') return false;

  const textBefore = paragraph.textContent.slice(0, $pos.parentOffset);
  // Match `[ ]` or `[x]` at start of paragraph (inside bullet list)
  // or `- [ ]` / `- [x]` at start of plain paragraph (will wrap in task list)
  const match = /^(?:-\s)?\[([xX ])\]$/.exec(textBefore);
  if (!match) return false;

  const checked = match[1].toLowerCase() === 'x';

  const taskListType = schema.nodes.taskList;
  const taskItemType = schema.nodes.taskItem;
  if (!taskListType || !taskItemType) return false;

  // Case 1: Inside a bullet list item → convert bullet to task
  let listItemDepth = -1;
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === 'listItem') {
      listItemDepth = d;
      break;
    }
  }

  if (listItemDepth >= 1) {
    const bulletList = $pos.node(listItemDepth - 1);
    if (bulletList.type.name !== 'bulletList') return false;

    // Convert just this list item to a task item (works for any childCount)
    const listItemNode = $pos.node(listItemDepth);
    const listItemPos = $pos.before(listItemDepth);
    const listItemEnd = listItemPos + listItemNode.nodeSize;

    // If this is the only item, replace the whole bullet list
    if (bulletList.childCount === 1) {
      const listPos = $pos.before(listItemDepth - 1);
      const listEnd = listPos + bulletList.nodeSize;
      const emptyParagraph = schema.nodes.paragraph.create();
      const taskItem = taskItemType.create({ checked }, emptyParagraph);
      const taskList = taskListType.create(null, taskItem);
      const tr = state.tr;
      tr.replaceWith(listPos, listEnd, taskList);
      tr.setSelection(TextSelection.create(tr.doc, listPos + 3));
      view.dispatch(tr.scrollIntoView());
      return true;
    }

    // Multiple items: split this item out, convert it, insert task list after
    const emptyParagraph = schema.nodes.paragraph.create();
    const taskItem = taskItemType.create({ checked }, emptyParagraph);
    const taskList = taskListType.create(null, taskItem);
    const tr = state.tr;
    tr.replaceWith(listItemPos, listItemEnd, taskList);
    const newCursorPos = listItemPos + 3;
    tr.setSelection(TextSelection.create(tr.doc, newCursorPos));
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  // Case 2: Plain paragraph (not inside a list) → wrap in task list
  const paragraphPos = $pos.before($pos.depth);
  const paragraphEnd = paragraphPos + paragraph.nodeSize;
  const emptyParagraph = schema.nodes.paragraph.create();
  const taskItem = taskItemType.create({ checked }, emptyParagraph);
  const taskList = taskListType.create(null, taskItem);
  const tr = state.tr;
  tr.replaceWith(paragraphPos, paragraphEnd, taskList);
  tr.setSelection(TextSelection.create(tr.doc, paragraphPos + 3));
  view.dispatch(tr.scrollIntoView());
  return true;
}

// ── Input handler ──

function handleTextInput(view: EditorView, from: number, to: number, text: string): boolean {
  if (isInsideCodeBlockView(view)) return false;

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

  // ── Empty selection: try closing delimiter for any mark ──
  const isDelimChar = MARK_DELIMITERS.some(d => d.chars.includes(text));
  if (isDelimChar) {
    if (tryClosingDelimiter(view, from, text)) return true;
  }

  // ── Skip-close: if typing a closing bracket and it's right after cursor, skip ──
  if (CLOSE_TO_OPEN[text]) {
    // Use `from` (the actual insert position) rather than selection.from
    // to avoid stale-state issues when keystrokes arrive in rapid succession
    const $from = state.doc.resolve(from);
    const charAtFrom = $from.parent.textContent.charAt($from.parentOffset) || '';
    if (charAtFrom === text) {
      if (text === ')' && tryMarkdownLink(view)) return true;

      const tr = state.tr.setSelection(TextSelection.create(state.doc, from + 1));
      view.dispatch(tr.scrollIntoView());
      return true;
    }
  }

  // ── Bullet → task conversion on space after [ ] or [x] ──
  if (text === ' ') {
    const result = tryBulletToTaskOnInput(view, from);
    if (result) return true;
  }

  // ── Auto-close brackets ──
  if (AUTO_CLOSE[text]) {
    // Don't auto-close `[` when it's the first non-whitespace character
    // in the paragraph — allows TipTap's TaskItem input rule to convert
    // `[ ] ` into a checkbox, both in list items and plain paragraphs.
    if (text === '[') {
      const $pos = state.doc.resolve(from);
      const parentNode = $pos.parent;
      const textBefore = parentNode.textBetween(0, $pos.parentOffset, undefined, '\ufffc');
      if (/^\s*$/.test(textBefore)) return false;
    }

    const closing = AUTO_CLOSE[text];
    const tr = state.tr.insertText(text + closing, from, to);
    tr.setSelection(TextSelection.create(tr.doc, from + 1));
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  return false;
}

// ── KeyDown handler ──

function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if (isInsideCodeBlockView(view)) return false;

  if (event.key === 'ArrowRight' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
    if (tryExitRightDelimiter(view)) return true;
  }

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

// ── Extension ──

export const SmartTypography = Extension.create({
  name: 'kiviSmartTypography',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: smartTypoKey,

        state: {
          init(): SmartTypoState {
            return { session: null };
          },
          apply(tr, value): SmartTypoState {
            const cont = tr.getMeta(CONTINUE_META);
            if (cont !== undefined) {
              return { session: cont };
            }
            // Keep session alive across normal typing transactions
            if (tr.docChanged && value.session) {
              return value;
            }
            // Clear on anything else (selection-only, undo, etc.)
            return { session: null };
          },
        },

        props: {
          handleTextInput,
          handleKeyDown,
        },

        appendTransaction(transactions, oldState, newState) {
          for (const tr of transactions) {
            if (tr.getMeta(SMART_TYPO_META)) return null;
            if (tr.getMeta('paste')) return null;
            if (tr.getMeta('addToHistory') === false) return null;
          }

          if (isInsideCodeBlockState(newState)) return null;

          const docChanged = transactions.some(tr => tr.docChanged);
          const pluginState = smartTypoKey.getState(newState) as SmartTypoState | undefined;

          if (docChanged) {
            const sizeDiff = newState.doc.content.size - oldState.doc.content.size;
            if (sizeDiff < 0 || sizeDiff > 2) return null;

            try {
              // 1. Continue an active mark session (subsequent chars)
              if (pluginState?.session) {
                const cont = tryContinueMark(pluginState.session, oldState, newState);
                if (cont) {
                  cont.setMeta(SMART_TYPO_META, true);
                  return cont;
                }
                // Continuation didn't match — clear session
                const clearTr = newState.tr;
                clearTr.setMeta(CONTINUE_META, null);
                clearTr.setMeta(SMART_TYPO_META, true);
                return clearTr;
              }

              // 2. Check between-delimiters (first char typed between delimiters)
              if (sizeDiff === 1) {
                const between = tryBetweenDelimiters(newState);
                if (between) {
                  between.setMeta(SMART_TYPO_META, true);
                  return between;
                }
              }

              // 3. Check closing delimiter pattern (DOM-mutation fallback)
              const closing = tryClosingDelimiterOnState(newState);
              if (closing) {
                closing.setMeta(SMART_TYPO_META, true);
                return closing;
              }

              // 4. Check markdown link [text](url) (when `)` was inserted)
              const mdLink = tryMarkdownLinkOnState(newState);
              if (mdLink) {
                mdLink.setMeta(SMART_TYPO_META, true);
                return mdLink;
              }
            } catch {
              // Safety: never crash the editor
            }
          } else {
            // Selection-only change (ArrowRight fallback, skip-close)
            const oldPos = oldState.selection.from;
            const newPos = newState.selection.from;
            if (!oldState.selection.empty || !newState.selection.empty) return null;
            if (newPos !== oldPos + 1) return null;

            try {
              const between = tryBetweenDelimiters(newState);
              if (between) {
                between.setMeta(SMART_TYPO_META, true);
                return between;
              }

              // Check markdown link after cursor moves past `)`
              const mdLink = tryMarkdownLinkOnState(newState);
              if (mdLink) {
                mdLink.setMeta(SMART_TYPO_META, true);
                return mdLink;
              }
            } catch {
              // Safety
            }
          }

          return null;
        },
      }),
    ];
  },
});
