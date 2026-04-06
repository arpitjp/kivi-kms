import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { NodeType, Node as PmNode } from '@tiptap/pm/model';
import { ReplaceAroundStep } from '@tiptap/pm/transform';

const smartTypoKey = new PluginKey('kiviSmartTypography');

/**
 * Smart typography extension for the Kivi editor.
 *
 * Features:
 *   - Auto-close brackets: ( [ { → inserts matching pair, cursor between
 *   - Skip-close: typing a closing bracket skips over an existing one
 *   - Smart delete: backspace between empty matching pair deletes both
 *   - Selection wrapping: select text then type " ' ( [ { → wraps
 *   - Markdown link: [text](url) → link mark
 *   - Tab / Shift+Tab: indent / outdent list items
 */

const SMART_TYPO_META = 'kiviSmartTypoHandled';
const CONTINUE_META = 'smartTypoContinue';

// ── Plugin state: tracks mark-continuation sessions ──

interface ContinueSession {
  markName: string;
  delimiter: string;
  startPos: number;
  endPos: number;
}

interface SmartTypoState {
  session: ContinueSession | null;
}

// ── Inline mark delimiters ──
// Each entry maps a delimiter string to its ProseMirror mark name.
// "trigger" is the single character typed; "full" is the delimiter that must
// precede the cursor for a double-tap to activate mark mode.

interface InlineMarkDef {
  delimiter: string;
  markName: string;
}

const INLINE_MARKS: InlineMarkDef[] = [
  { delimiter: '`',  markName: 'code' },
  { delimiter: '**', markName: 'bold' },
  { delimiter: '*',  markName: 'italic' },
  { delimiter: '~~', markName: 'strike' },
  { delimiter: '==', markName: 'highlight' },
];

// ── Pair / wrap definitions ──

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

interface WrapPairDef {
  open: string;
  close: string;
  mark?: string;
}

const WRAP_PAIRS: Record<string, WrapPairDef> = {
  '`':  { open: '`', close: '`', mark: 'code' },
  '*':  { open: '*', close: '*', mark: 'italic' },
  '"':  { open: '"', close: '"' },
  "'":  { open: "'", close: "'" },
  '(':  { open: '(', close: ')' },
  '[':  { open: '[', close: ']' },
  '{':  { open: '{', close: '}' },
};

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

function cursorHasMark(state: EditorState, markName: string): boolean {
  const markType = state.schema.marks[markName];
  if (!markType) return false;
  const { $from } = state.selection;
  return markType.isInSet($from.marks()) !== undefined;
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
    if ($from.node(d).type.name === 'codeBlock') return true;
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

// ── Markdown link [text](url) detection (handleTextInput) ──

function tryMarkdownLink(view: EditorView): boolean {
  const { state } = view;
  const { selection } = state;
  if (!selection.empty) return false;

  const pos = selection.from;
  const $pos = state.doc.resolve(pos);
  const parentText = $pos.parent.textContent;
  const offset = $pos.parentOffset;
  const parentStart = pos - offset;

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
      if (i > 0 && parentText[i - 1] === '[') return false;
      openBracketIdx = i;
      break;
    }
    if (parentText[i] === ']' || parentText[i] === '\n') return false;
  }
  if (openBracketIdx < 0) return false;

  const altText = parentText.slice(openBracketIdx + 1, closeBracketIdx);
  const rawUrl = parentText.slice(openParenIdx + 1, closeParenIdx);
  if (!altText) return false;

  const isImage = openBracketIdx > 0 && parentText[openBracketIdx - 1] === '!';
  const absStart = parentStart + (isImage ? openBracketIdx - 1 : openBracketIdx);
  const absEnd = parentStart + closeParenIdx + 1;

  const tr = state.tr;

  if (isImage) {
    const imageType = state.schema.nodes.image;
    if (!imageType) return false;
    const dimMatch = rawUrl.match(/^(.+?)\s+=(\d*)x(\d*)$/);
    const url = dimMatch ? dimMatch[1] : rawUrl;
    const imgAttrs: Record<string, unknown> = { src: url, alt: altText };
    if (dimMatch?.[2]) imgAttrs.width = parseInt(dimMatch[2], 10);
    if (dimMatch?.[3]) imgAttrs.height = parseInt(dimMatch[3], 10);
    tr.delete(absStart, absEnd);
    tr.insert(absStart, imageType.create(imgAttrs));
    tr.setSelection(TextSelection.create(tr.doc, absStart + 1));
  } else {
    const linkMark = state.schema.marks.link;
    if (!linkMark) return false;
    tr.delete(absStart, absEnd);
    tr.insertText(altText, absStart);
    tr.addMark(absStart, absStart + altText.length, linkMark.create({ href: url, target: '_blank' }));
    tr.setSelection(TextSelection.create(tr.doc, absStart + altText.length));
  }

  tr.setMeta(SMART_TYPO_META, true);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function tryMarkdownLinkOnState(state: EditorState): import('@tiptap/pm/state').Transaction | null {
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

  const altText = parentText.slice(openBracketIdx + 1, closeBracketIdx);
  const url = parentText.slice(openParenIdx + 1, closeParenIdx);
  if (!altText) return null;

  const isImage = openBracketIdx > 0 && parentText[openBracketIdx - 1] === '!';
  const absStart = parentStart + (isImage ? openBracketIdx - 1 : openBracketIdx);
  const absEnd = parentStart + closeParenIdx + 1;

  const tr = state.tr;

  if (isImage) {
    const imageType = state.schema.nodes.image;
    if (!imageType) return null;
    tr.delete(absStart, absEnd);
    tr.insert(absStart, imageType.create({ src: url, alt: altText }));
    tr.setSelection(TextSelection.create(tr.doc, absStart + 1));
  } else {
    const linkMark = state.schema.marks.link;
    if (!linkMark) return null;
    tr.delete(absStart, absEnd);
    tr.insertText(altText, absStart);
    tr.addMark(absStart, absStart + altText.length, linkMark.create({ href: url, target: '_blank' }));
    tr.setSelection(TextSelection.create(tr.doc, absStart + altText.length));
  }

  return tr;
}

const MD_LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+=(\d*)x(\d*))?\)/g;

function tryConvertPastedLinks(state: EditorState): Transaction | null {
  const linkMark = state.schema.marks.link;
  const imageType = state.schema.nodes.image;

  if (!linkMark && !imageType) return null;

  type LinkHit = { kind: 'link'; from: number; to: number; text: string; url: string };
  type ImageHit = { kind: 'image'; from: number; to: number; alt: string; url: string; width?: number | null; height?: number | null };
  type Hit = LinkHit | ImageHit;
  const hits: Hit[] = [];

  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const fullText = node.textContent;
    if (!fullText.includes('[')) return false;

    if (imageType) {
      MD_IMAGE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MD_IMAGE_RE.exec(fullText)) !== null) {
        const absFrom = pos + 1 + m.index;
        const absTo = absFrom + m[0].length;
        const w = m[3] ? parseInt(m[3], 10) || null : null;
        const h = m[4] ? parseInt(m[4], 10) || null : null;
        hits.push({ kind: 'image', from: absFrom, to: absTo, alt: m[1], url: m[2], width: w, height: h });
      }
    }

    if (linkMark) {
      MD_LINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MD_LINK_RE.exec(fullText)) !== null) {
        const absFrom = pos + 1 + m.index;
        const absTo = absFrom + m[0].length;
        if (hits.some(h => h.from <= absFrom && h.to >= absTo)) continue;
        const existingMarks = state.doc.resolve(absFrom + 1).marks();
        if (existingMarks.some(mk => mk.type === linkMark)) continue;
        hits.push({ kind: 'link', from: absFrom, to: absTo, text: m[1], url: m[2] });
      }
    }

    return false;
  });

  if (hits.length === 0) return null;

  hits.sort((a, b) => a.from - b.from);

  const tr = state.tr;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (h.kind === 'image') {
      tr.delete(h.from, h.to);
      const imgAttrs: Record<string, unknown> = { src: h.url, alt: h.alt };
      if (h.width) imgAttrs.width = h.width;
      if (h.height) imgAttrs.height = h.height;
      tr.insert(h.from, imageType!.create(imgAttrs));
    } else {
      tr.delete(h.from, h.to);
      tr.insertText(h.text, h.from);
      tr.addMark(h.from, h.from + h.text.length, linkMark!.create({ href: h.url, target: '_blank' }));
    }
  }
  return tr;
}

// ── Closing delimiter detection (e.g. `text` → code, *text* → italic) ──

function tryClosingDelimiter(view: EditorView, from: number, delimiter: string, markName: string): boolean {
  const { state } = view;
  const $pos = state.doc.resolve(from);
  const parentText = $pos.parent.textContent;
  const offset = $pos.parentOffset;
  const parentStart = from - offset;
  const dLen = delimiter.length;

  if (cursorHasMark(state, markName)) return false;

  for (let i = offset - 1; i >= dLen - 1; i--) {
    const candidate = parentText.slice(i - dLen + 1, i + 1);
    if (candidate !== delimiter) continue;
    const content = parentText.slice(i + 1, offset);
    if (!content || !content.trim()) continue;
    if (content.includes(delimiter)) continue;

    const markType = state.schema.marks[markName];
    if (!markType) continue;

    const absOpenStart = parentStart + i - dLen + 1;
    const tr = state.tr;
    tr.delete(absOpenStart, absOpenStart + dLen);
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
  return false;
}

// ── Mark continuation ──

function tryContinueMark(
  session: ContinueSession,
  oldState: EditorState,
  newState: EditorState,
): import('@tiptap/pm/state').Transaction | null {
  const sizeDiff = newState.doc.content.size - oldState.doc.content.size;
  if (sizeDiff !== 1) return null;

  const newPos = newState.selection.from;
  if (!newState.selection.empty) return null;
  if (newPos !== session.endPos + 1) return null;

  const markType = newState.schema.marks[session.markName];
  if (!markType) return null;

  const tr = newState.tr;
  tr.addMark(session.endPos, newPos, markType.create());
  tr.setStoredMarks([markType.create()]);
  tr.setMeta(CONTINUE_META, { ...session, endPos: newPos } as ContinueSession);
  return tr;
}

// ── Bullet → task item conversion ──

const CHECKBOX_RE = /^\[([ xX])\]\s/;

/**
 * Scan for listItem nodes whose text starts with [ ], [x], [X].
 * Convert them to taskItem, strip the checkbox text prefix, and
 * change the parent bulletList → taskList (converting sibling
 * listItems to unchecked taskItems so the schema stays valid).
 */
function tryBulletToTask(newState: EditorState): import('@tiptap/pm/state').Transaction | null {
  const taskItemType = newState.schema.nodes.taskItem;
  const taskListType = newState.schema.nodes.taskList;
  if (!taskItemType || !taskListType) return null;

  const { $from } = newState.selection;

  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (node.type.name !== 'listItem') continue;
    if (!node.firstChild || node.firstChild.type.name !== 'paragraph') return null;

    const text = node.firstChild.textContent;
    const m = CHECKBOX_RE.exec(text);
    if (!m) return null;

    const listDepth = d - 1;
    if (listDepth < 0) return null;
    const listNode = $from.node(listDepth);
    if (listNode.type.name !== 'bulletList') return null;

    const curItemIndex = $from.index(listDepth);
    const tr = newState.tr;

    // Build the replacement taskList atomically: convert all children
    // up-front so that the resulting node is schema-valid in one step.
    const newChildren: PmNode[] = [];
    listNode.forEach((child, _offset, idx) => {
      if (idx === curItemIndex) {
        // Strip the checkbox text prefix from the first paragraph
        const para = child.firstChild!;
        const strippedText = para.textContent.slice(m[0].length);
        const newParaContent: PmNode[] = [];
        if (strippedText) {
          newParaContent.push(newState.schema.text(strippedText));
        }
        const newPara = para.type.create(para.attrs, newParaContent.length ? Fragment.from(newParaContent) : undefined);
        // Rebuild remaining content blocks (everything after the first paragraph)
        const restContent: PmNode[] = [];
        child.forEach((c, _o, i) => { if (i > 0) restContent.push(c); });
        newChildren.push(
          taskItemType.create({ checked: m[1] !== ' ' }, Fragment.from([newPara, ...restContent])),
        );
      } else if (child.type.name === 'listItem') {
        newChildren.push(taskItemType.create({ checked: false }, child.content));
      } else {
        newChildren.push(child);
      }
    });

    const newTaskList = taskListType.create(null, Fragment.from(newChildren));
    const listStart = $from.before(listDepth);
    const listEnd = $from.after(listDepth);
    tr.replaceWith(listStart, listEnd, newTaskList);

    // Restore cursor near its original relative position
    const cursorTarget = tr.mapping.map($from.pos);
    try {
      tr.setSelection(TextSelection.near(tr.doc.resolve(cursorTarget)));
    } catch { /* position out of bounds — let ProseMirror pick a default */ }

    return tr;
  }
  return null;
}

// ── Input handler ──

function handleTextInput(view: EditorView, from: number, to: number, text: string): boolean {
  if (isInsideCodeBlockView(view)) return false;

  const { state } = view;
  const { selection } = state;

  // Selection wrapping (non-empty selection)
  if (!selection.empty) {
    const pair = WRAP_PAIRS[text];
    if (!pair) return false;
    if (pair.mark) return toggleMark(view, pair.mark);
    return wrapSelection(view, pair.open, pair.close);
  }

  // Active mark session: typing the delimiter's last char exits the mark
  const pluginState = smartTypoKey.getState(state) as SmartTypoState | undefined;
  if (pluginState?.session) {
    const sess = pluginState.session;
    const delim = sess.delimiter;
    if (delim.length === 1 && text === delim) {
      // If no content was typed since session started (cursor still at
      // endPos), the user likely wants the raw delimiters (e.g. ``` for
      // code block). Undo the session and re-insert all delimiter chars.
      if (from === sess.endPos) {
        const markType = state.schema.marks[sess.markName];
        const tr = state.tr;
        if (markType) tr.removeStoredMark(markType);
        tr.insertText(delim + delim + text, from);
        tr.setMeta(CONTINUE_META, null);
        tr.setMeta(SMART_TYPO_META, true);
        view.dispatch(tr.scrollIntoView());
        return true;
      }
      return exitMarkSession(view, sess);
    }
    if (delim.length === 2 && text === delim[0]) {
      // Empty session bailout: no content typed yet, user is probably
      // reverting to raw delimiter chars.
      if (from === sess.endPos) {
        const markType = state.schema.marks[sess.markName];
        const tr = state.tr;
        if (markType) tr.removeStoredMark(markType);
        tr.insertText(delim + text, from);
        tr.setMeta(CONTINUE_META, null);
        tr.setMeta(SMART_TYPO_META, true);
        view.dispatch(tr.scrollIntoView());
        return true;
      }
    }
    if (delim.length === 2 && text === delim[1]) {
      const $f = state.doc.resolve(from);
      const off = $f.parentOffset;
      if (off > 0 && $f.parent.textContent.charAt(off - 1) === delim[0]) {
        const markType = state.schema.marks[sess.markName];
        if (markType) {
          const tr = state.tr;
          tr.delete(from - 1, from);
          tr.removeStoredMark(markType);
          tr.setMeta(CONTINUE_META, null);
          tr.setMeta(SMART_TYPO_META, true);
          view.dispatch(tr.scrollIntoView());
          return true;
        }
      }
    }
  }

  // Closing delimiter: `text` → code, *text* → italic, **text** → bold, etc.
  if (selection.empty) {
    for (const def of INLINE_MARKS) {
      const delim = def.delimiter;
      if (delim.length === 1 && text === delim) {
        if (tryClosingDelimiter(view, from, delim, def.markName)) return true;
      }
      if (delim.length === 2 && text === delim[1]) {
        const $f = state.doc.resolve(from);
        const off = $f.parentOffset;
        if (off > 0 && $f.parent.textContent.charAt(off - 1) === delim[0]) {
          if (tryClosingDelimiter(view, from - 1, delim, def.markName)) return true;
        }
      }
    }
  }

  // Double-delimiter → start mark session (e.g. `` → code, ** twice → bold)
  if (selection.empty) {
    if (tryStartMarkSession(view, from, text)) return true;
  }

  // Skip-close: if typing a closing bracket and it's right after cursor, skip
  if (CLOSE_TO_OPEN[text]) {
    const $from = state.doc.resolve(from);
    const charAtFrom = $from.parent.textContent.charAt($from.parentOffset) || '';
    if (charAtFrom === text) {
      if (text === ')' && tryMarkdownLink(view)) return true;

      const tr = state.tr.setSelection(TextSelection.create(state.doc, from + 1));
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

function exitMarkSession(view: EditorView, sess: ContinueSession): boolean {
  const { state } = view;
  const markType = state.schema.marks[sess.markName];
  if (!markType) return false;
  const tr = state.tr;
  tr.removeStoredMark(markType);
  tr.setMeta(CONTINUE_META, null);
  tr.setMeta(SMART_TYPO_META, true);
  view.dispatch(tr);
  return true;
}

/**
 * Detects delimiter completion to start a mark session.
 *
 * For 1-char delimiters (e.g. `): typing the char when the previous char
 * is the same → delete both, activate mark mode.
 *
 * For 2-char delimiters (** ~~ ==): typing the 2nd char when the previous
 * char is the 1st char of the delimiter → delete both, activate mark mode.
 *
 * 2-char delimiters are checked first so `**` activates bold, not italic.
 */
function tryStartMarkSession(view: EditorView, from: number, text: string): boolean {
  const { state } = view;
  const $f = state.doc.resolve(from);
  const off = $f.parentOffset;
  if (off === 0) return false;

  const parent = $f.parent;
  const parentText = parent.textContent;

  // Try 2-char delimiters first (longer match wins): **, ~~, ==
  // Activation: user typed first char already (e.g. `*`), now typing the
  // 2nd char (another `*`). Text before cursor is `<d0>`, typing `<d1>`.
  for (const def of INLINE_MARKS) {
    if (def.delimiter.length !== 2) continue;
    if (text !== def.delimiter[1]) continue;
    if (off < 1) continue;

    if (parentText.charAt(off - 1) !== def.delimiter[0]) continue;

    // Reject if preceded by yet another delimiter char (e.g. `***` — don't re-enter)
    if (off >= 2 && parentText.charAt(off - 2) === def.delimiter[0]) continue;

    const markType = state.schema.marks[def.markName];
    if (!markType) continue;

    const { node: leftNode } = parent.childBefore(off);
    if (leftNode && markType.isInSet(leftNode.marks)) continue;

    const tr = state.tr;
    tr.delete(from - 1, from);
    const newPos = from - 1;
    tr.setSelection(TextSelection.create(tr.doc, newPos));
    tr.setStoredMarks([markType.create()]);
    tr.setMeta(SMART_TYPO_META, true);
    tr.setMeta(CONTINUE_META, { markName: def.markName, delimiter: def.delimiter, startPos: newPos, endPos: newPos } as ContinueSession);
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  // Try 1-char delimiters: `
  // Activation: the delimiter typed twice (e.g. `` for code)
  for (const def of INLINE_MARKS) {
    if (def.delimiter.length !== 1) continue;
    if (text !== def.delimiter) continue;
    if (parentText.charAt(off - 1) !== def.delimiter) continue;

    // Reject if preceded by another same char (e.g. 3+ backticks)
    if (off >= 2 && parentText.charAt(off - 2) === def.delimiter) continue;

    // Skip if a 2-char delimiter shares the same char pair (e.g. `*` italic
    // is shadowed by `**` bold — bold wins above).
    const shadowedBy2Char = INLINE_MARKS.some(
      d2 => d2.delimiter.length === 2 && d2.delimiter[0] === def.delimiter && d2.delimiter[1] === def.delimiter,
    );
    if (shadowedBy2Char) continue;

    const markType = state.schema.marks[def.markName];
    if (!markType) continue;

    const { node: leftNode } = parent.childBefore(off);
    if (leftNode && markType.isInSet(leftNode.marks)) continue;

    const tr = state.tr;
    tr.delete(from - 1, from);
    const newPos = from - 1;
    tr.setSelection(TextSelection.create(tr.doc, newPos));
    tr.setStoredMarks([markType.create()]);
    tr.setMeta(SMART_TYPO_META, true);
    tr.setMeta(CONTINUE_META, { markName: def.markName, delimiter: def.delimiter, startPos: newPos, endPos: newPos } as ContinueSession);
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  return false;
}

// ── List indent / outdent that only affects the single item at cursor ──

const LIST_ITEM_TYPES = new Set(['listItem', 'taskItem']);

interface ListItemInfo {
  itemPos: number;
  itemNode: PmNode;
  itemType: NodeType;
  itemDepth: number;
  listType: NodeType;
  listDepth: number;
}

function findListItem(state: EditorState): ListItemInfo | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (LIST_ITEM_TYPES.has(node.type.name)) {
      const listNode = $from.node(d - 1);
      return {
        itemPos: $from.before(d),
        itemNode: node,
        itemType: node.type,
        itemDepth: d,
        listType: listNode.type,
        listDepth: d - 1,
      };
    }
  }
  return null;
}

/**
 * Indent: move only the current item into the previous sibling's sub-list.
 * Children of the current item stay attached (move with their parent).
 * Siblings are not affected.
 */
function indentListItem(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const info = findListItem(state);
  if (!info) return false;

  const { $from } = state.selection;
  const listNode = $from.node(info.listDepth);
  const indexInList = $from.index(info.listDepth);

  if (indexInList === 0) return false;

  const prevSibling = listNode.child(indexInList - 1);
  if (!LIST_ITEM_TYPES.has(prevSibling.type.name)) return false;

  if (!dispatch) return true;

  const itemStart = $from.before(info.itemDepth);
  const itemEnd = $from.after(info.itemDepth);

  const nestedBefore = prevSibling.lastChild && prevSibling.lastChild.type === info.listType;
  const inner = Fragment.from(nestedBefore ? info.itemType.create() : null);
  const slice = new Slice(
    Fragment.from(info.itemType.create(null, Fragment.from(info.listType.create(null, inner)))),
    nestedBefore ? 3 : 1,
    0,
  );

  dispatch(
    state.tr
      .step(new ReplaceAroundStep(
        itemStart - (nestedBefore ? 3 : 1),
        itemEnd,
        itemStart,
        itemEnd,
        slice,
        1,
        true,
      ))
      .scrollIntoView(),
  );
  return true;
}

/**
 * Outdent: move only the current list item one level up.
 * Siblings after it stay in the original sub-list (are NOT re-parented
 * under the lifted item, unlike ProseMirror's default liftListItem).
 */
function outdentListItem(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const info = findListItem(state);
  if (!info) return false;

  const { $from } = state.selection;

  const isNestedInsideItem = info.listDepth >= 2 && LIST_ITEM_TYPES.has($from.node(info.listDepth - 1).type.name);

  if (!isNestedInsideItem) {
    return false;
  }

  if (!dispatch) return true;

  const listNode = $from.node(info.listDepth);
  const itemStart = $from.before(info.itemDepth);
  const itemEnd = $from.after(info.itemDepth);
  const listStart = $from.before(info.listDepth);
  const listEnd = $from.after(info.listDepth);
  const parentItemEnd = $from.after(info.listDepth - 1);

  const tr = state.tr;

  if (listNode.childCount === 1) {
    tr.delete(listStart, listEnd);
  } else {
    tr.delete(itemStart, itemEnd);
  }

  const insertAt = tr.mapping.map(parentItemEnd);
  tr.insert(insertAt, info.itemNode);

  const cursorTarget = tr.mapping.map(itemStart);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cursorTarget)));

  dispatch(tr.scrollIntoView());
  return true;
}

// ── KeyDown handler ──

function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if (isInsideCodeBlockView(view)) return false;

  // ArrowRight at the trailing edge of any inline mark: exit the mark
  // and insert a space if at end-of-line (Slack-like UX).
  // Works both during an active mark session and when the cursor is
  // simply sitting at the right boundary of existing marked text.
  if (event.key === 'ArrowRight') {
    const { state } = view;
    if (!state.selection.empty) return false;

    const { $from } = state.selection;
    const pluginState = smartTypoKey.getState(state) as SmartTypoState | undefined;

    // Active mark session: check the session's mark specifically
    if (pluginState?.session) {
      const sess = pluginState.session;
      const markType = state.schema.marks[sess.markName];
      if (markType) {
        const afterHasMark = $from.nodeAfter?.marks.some(m => m.type === markType) ?? false;
        if (!afterHasMark) {
          event.preventDefault();
          const tr = state.tr;
          tr.removeStoredMark(markType);

          const after = $from.parent.textContent.charAt($from.parentOffset);
          if (!after) {
            tr.insertText(' ', $from.pos);
            tr.setSelection(TextSelection.create(tr.doc, $from.pos + 1));
          } else {
            tr.setSelection(TextSelection.create(state.doc, $from.pos + 1));
          }

          tr.setMeta(CONTINUE_META, null);
          tr.setMeta(SMART_TYPO_META, true);
          view.dispatch(tr.scrollIntoView());
          return true;
        }
      }
    }

    // No active session: check if cursor is at the trailing edge of
    // any inline formatting mark (bold, italic, strike, highlight).
    // Code is handled by Code.extend in editor.ts.
    if (!pluginState?.session) {
      for (const def of INLINE_MARKS) {
        if (def.markName === 'code') continue;
        const markType = state.schema.marks[def.markName];
        if (!markType) continue;
        if (!markType.isInSet($from.marks())) continue;

        const afterHasMark = $from.nodeAfter?.marks.some(m => m.type === markType) ?? false;
        if (afterHasMark) continue;

        event.preventDefault();
        const tr = state.tr;
        const after = $from.parent.textContent.charAt($from.parentOffset);
        if (!after) {
          tr.insertText(' ', $from.pos);
          tr.setSelection(TextSelection.create(tr.doc, $from.pos + 1));
        } else {
          const newPos = $from.pos + 1;
          if (newPos <= state.doc.content.size) {
            tr.setSelection(TextSelection.create(state.doc, newPos));
          }
        }
        tr.setStoredMarks(
          $from.marks().filter(m => m.type !== markType),
        );
        tr.setMeta(SMART_TYPO_META, true);
        view.dispatch(tr.scrollIntoView());
        return true;
      }
    }
  }

  // Escape exits an active mark session without adding anything
  if (event.key === 'Escape') {
    const { state } = view;
    const pluginState = smartTypoKey.getState(state) as SmartTypoState | undefined;
    if (pluginState?.session) {
      event.preventDefault();
      return exitMarkSession(view, pluginState.session);
    }
  }

  // Tab / Shift+Tab: indent / outdent list items
  if (event.key === 'Tab') {
    const { state } = view;
    const info = findListItem(state);
    if (info) {
      event.preventDefault();
      const command = event.shiftKey ? outdentListItem : indentListItem;
      command(state, view.dispatch);
      return true;
    }
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
            // Preserve session across normal doc changes so appendTransaction
            // can evaluate and either continue or clear it.  Clear immediately
            // on undo/redo, paste, or any non-history transaction since the
            // session is no longer meaningful.
            if (tr.docChanged && value.session) {
              if (tr.getMeta('addToHistory') === false || tr.getMeta('paste')) {
                return { session: null };
              }
              return value;
            }
            return { session: null };
          },
        },

        props: {
          handleTextInput,
          handleKeyDown,
          decorations(state) {
            const ps = smartTypoKey.getState(state) as SmartTypoState | undefined;
            if (!ps?.session) return DecorationSet.empty;
            if (!state.selection.empty) return DecorationSet.empty;

            const pos = state.selection.from;
            // Only show the indicator pill when no content has been
            // typed yet (cursor still at session start). Once the user
            // starts typing, the mark's own styling (e.g. <code>
            // background) provides sufficient visual feedback.
            if (pos !== ps.session.startPos) return DecorationSet.empty;

            const markName = ps.session.markName;
            const widget = document.createElement('span');
            widget.className = `kivi-mark-indicator kivi-mark-indicator-${markName}`;
            widget.setAttribute('aria-hidden', 'true');
            widget.contentEditable = 'false';
            return DecorationSet.create(state.doc, [
              Decoration.widget(pos, widget, { side: 0, key: `mark-ind-${markName}`, marks: [] }),
            ]);
          },
        },

        view(editorView) {
          let currentMarkClass = '';
          function syncClass(view: EditorView) {
            const ps = smartTypoKey.getState(view.state) as SmartTypoState | undefined;
            const markName = ps?.session?.markName || '';
            const cls = markName ? `kivi-mark-mode-${markName}` : '';
            if (cls !== currentMarkClass) {
              if (currentMarkClass) view.dom.classList.remove(currentMarkClass);
              if (cls) view.dom.classList.add(cls);
              currentMarkClass = cls;
            }
          }
          syncClass(editorView);
          return {
            update(view) { syncClass(view); },
            destroy() {
              if (currentMarkClass) editorView.dom.classList.remove(currentMarkClass);
            },
          };
        },

        appendTransaction(transactions, oldState, newState) {
          const isSelfMeta = transactions.some(tr => tr.getMeta(SMART_TYPO_META));
          if (isSelfMeta) return null;

          const isPaste = transactions.some(tr => tr.getMeta('paste'));
          const isNoHistory = transactions.some(tr => tr.getMeta('addToHistory') === false);

          if (isPaste && !isInsideCodeBlockState(newState)) {
            try {
              const linkTr = tryConvertPastedLinks(newState);
              if (linkTr) {
                linkTr.setMeta(SMART_TYPO_META, true);
                return linkTr;
              }
              const taskConvert = tryBulletToTask(newState);
              if (taskConvert) {
                taskConvert.setMeta(SMART_TYPO_META, true);
                return taskConvert;
              }
              const mdLink = tryMarkdownLinkOnState(newState);
              if (mdLink) {
                mdLink.setMeta(SMART_TYPO_META, true);
                return mdLink;
              }
            } catch {
              // Safety
            }
            return null;
          }

          if (isNoHistory) return null;
          if (isInsideCodeBlockState(newState)) return null;

          const docChanged = transactions.some(tr => tr.docChanged);
          const pluginState = smartTypoKey.getState(newState) as SmartTypoState | undefined;

          if (docChanged) {
            const sizeDiff = newState.doc.content.size - oldState.doc.content.size;

            // Clear stale session on deletions, large inserts, etc.
            if (sizeDiff < 0 || sizeDiff > 2) {
              if (pluginState?.session) {
                const clearTr = newState.tr;
                clearTr.setMeta(CONTINUE_META, null);
                clearTr.setMeta(SMART_TYPO_META, true);
                return clearTr;
              }
              return null;
            }

            try {
              if (pluginState?.session) {
                const cont = tryContinueMark(pluginState.session, oldState, newState);
                if (cont) {
                  cont.setMeta(SMART_TYPO_META, true);
                  return cont;
                }
                const clearTr = newState.tr;
                clearTr.setMeta(CONTINUE_META, null);
                clearTr.setMeta(SMART_TYPO_META, true);
                return clearTr;
              }

              const mdLink = tryMarkdownLinkOnState(newState);
              if (mdLink) {
                mdLink.setMeta(SMART_TYPO_META, true);
                return mdLink;
              }

              const taskConvert = tryBulletToTask(newState);
              if (taskConvert) {
                taskConvert.setMeta(SMART_TYPO_META, true);
                return taskConvert;
              }
            } catch {
              // Safety: never crash the editor
            }
          } else if (newState.selection.empty) {
            // Cursor-only change (no doc edit): check if cursor just
            // landed right after ')' — the skip-close for ')' advances
            // the cursor without inserting, so the link detection in
            // the docChanged branch never fires. This is cheap: one
            // char check + bail if not ')'.
            const $pos = newState.doc.resolve(newState.selection.from);
            const off = $pos.parentOffset;
            if (off > 0 && $pos.parent.textContent.charAt(off - 1) === ')') {
              try {
                const mdLink = tryMarkdownLinkOnState(newState);
                if (mdLink) {
                  mdLink.setMeta(SMART_TYPO_META, true);
                  return mdLink;
                }
              } catch {
                // Safety
              }
            }
          }

          return null;
        },
      }),
    ];
  },
});
