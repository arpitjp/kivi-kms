import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Code from '@tiptap/extension-code';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { SmartTypography } from '../../src/extensions/smart-typography.js';
import { CodeBlockEnhanced } from '../../src/extensions/code-block-enhanced.js';

const KiviCode = Code.extend({
  inclusive: false,
  addInputRules() { return []; },
});

let editors: Editor[] = [];

function createEditor(content: string, extraExtensions: any[] = []) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({
        codeBlock: { HTMLAttributes: { class: 'kivi-code-block' } },
        code: false,
      }),
      KiviCode,
      ...extraExtensions,
    ],
    content,
  });
  editors.push(editor);
  return { editor, el };
}

function allExtensions() {
  return [
    SmartTypography,
    CodeBlockEnhanced,
    Highlight.configure({ multicolor: false }),
    Link.configure({ openOnClick: false }),
  ];
}

/**
 * Simulate typing a character more accurately:
 * 1. Call handleTextInput handlers (like real ProseMirror does via someProp)
 * 2. If not handled, insert the text AND let input rules run
 *    (input rules also use handleTextInput, so someProp covers them too)
 *
 * In a real browser, ProseMirror calls someProp('handleTextInput', ...)
 * which iterates ALL plugins with handleTextInput props in order.
 * The input rules plugin's handleTextInput is in there too.
 * someProp stops at the first handler that returns a truthy value.
 */
function typeChar(editor: Editor, char: string) {
  const { view } = editor;
  const { from, to } = view.state.selection;
  const handled = view.someProp('handleTextInput', (f) =>
    f(view, from, to, char),
  );
  if (!handled) {
    const tr = view.state.tr.insertText(char, from, to);
    // In a real browser, ProseMirror applies storedMarks to newly typed text.
    // Simulate that here so tests behave like real input.
    const storedMarks = view.state.storedMarks;
    if (storedMarks && storedMarks.length > 0) {
      for (const mark of storedMarks) {
        tr.addMark(from, from + char.length, mark);
      }
    }
    view.dispatch(tr);
  }
}

/** Simulate typing a string character by character. */
function typeString(editor: Editor, str: string) {
  for (const ch of str) {
    typeChar(editor, ch);
  }
}

/** Get all text content of the document (plain text). */
function text(editor: Editor): string {
  return editor.state.doc.textContent;
}

/** Check if inline code mark is present at a position in the doc. */
function hasCodeMarkAt(editor: Editor, pos: number): boolean {
  const codeMark = editor.state.schema.marks.code;
  if (!codeMark) return false;
  const $pos = editor.state.doc.resolve(pos);
  return codeMark.isInSet($pos.marks()) !== undefined;
}

/** Find all text nodes with a given mark name. */
function textsWithMark(editor: Editor, markName: string): string[] {
  const markType = editor.state.schema.marks[markName];
  if (!markType) return [];
  const results: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText && markType.isInSet(node.marks)) results.push(node.text || '');
  });
  return results;
}

/** Simulate ArrowRight: handleKeyDown then manual move as fallback. */
function pressArrowRight(editor: Editor) {
  const { view } = editor;
  const event = new KeyboardEvent('keydown', { key: 'ArrowRight' });
  const handled = view.someProp('handleKeyDown', (f) => f(view, event));
  if (!handled) {
    const tr = view.state.tr.setSelection(
      TextSelection.create(view.state.doc, view.state.selection.from + 1),
    );
    view.dispatch(tr);
  }
}

/** Check if the selection is inside a code block node. */
function isInCodeBlock(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'codeBlock') return true;
  }
  return false;
}

/** Count how many codeBlock nodes are in the document. */
function codeBlockCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'codeBlock') count++;
  });
  return count;
}

/** Get the language attribute of the first code block. */
function firstCodeBlockLang(editor: Editor): string {
  let lang = '';
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'codeBlock' && !lang) {
      lang = node.attrs.language || '';
    }
  });
  return lang;
}

afterEach(() => {
  editors.forEach((e) => { if (!e.isDestroyed) e.destroy(); });
  editors = [];
  document.body.innerHTML = '';
});

// ── Inline Code (Tiptap built-in) ─────────────────────────────

// Inline code via Tiptap input rule tests removed — smart-typography inline mark
// conversion was removed.

// ── Code Block (Tiptap built-in input rule) ────────────────────

describe('Code block via Tiptap input rule', () => {
  it('``` followed by space creates a code block', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '``` ');
    expect(codeBlockCount(editor)).toBe(1);
  });

  it('```js followed by space creates a code block with language', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '```js ');
    expect(codeBlockCount(editor)).toBe(1);
    expect(firstCodeBlockLang(editor)).toBe('js');
  });

  it('```python followed by space creates a code block with language', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '```python ');
    expect(codeBlockCount(editor)).toBe(1);
    expect(firstCodeBlockLang(editor)).toBe('python');
  });

  it('typing ``` does not accidentally create inline code', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '```');
    const codeMark = editor.state.schema.marks.code;
    let hasInlineCode = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && codeMark.isInSet(node.marks)) hasInlineCode = true;
    });
    expect(hasInlineCode).toBe(false);
  });

  it('typing ``` via direct insertion does not create inline code', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    const { view } = editor;
    let tr = view.state.tr.insertText('`', 1, 1);
    view.dispatch(tr);
    tr = view.state.tr.insertText('`', 2, 2);
    view.dispatch(tr);
    tr = view.state.tr.insertText('`', 3, 3);
    view.dispatch(tr);
    const codeMark = editor.state.schema.marks.code;
    let hasInlineCode = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && codeMark.isInSet(node.marks)) hasInlineCode = true;
    });
    expect(hasInlineCode).toBe(false);
  });

  it('```js + space via direct insertion still creates code block', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    const { view } = editor;
    for (const ch of '```js') {
      const { from, to } = view.state.selection;
      const tr = view.state.tr.insertText(ch, from, to);
      view.dispatch(tr);
    }
    // The space triggers the textblockTypeInputRule via typeChar
    typeChar(editor, ' ');
    expect(codeBlockCount(editor)).toBe(1);
    expect(firstCodeBlockLang(editor)).toBe('js');
  });

  it('~~~ followed by space also creates a code block', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '~~~ ');
    expect(codeBlockCount(editor)).toBe(1);
  });
});

// ── Selection wrapping with backtick ──────────────────────────

// Selection wrapping with backtick tests removed — mark toggling via typing removed.

// ── Other SmartTypography wrapping ────────────────────────────

describe('SmartTypography other wrapping', () => {
  it('selecting text and typing ( wraps with parentheses', () => {
    const { editor } = createEditor('<p>hello world</p>', allExtensions());
    editor.commands.setTextSelection({ from: 1, to: 6 });
    typeChar(editor, '(');

    expect(text(editor)).toBe('(hello) world');
  });

  it('auto-close bracket on empty selection', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeChar(editor, '(');
    expect(text(editor)).toBe('()');
    expect(editor.state.selection.from).toBe(2); // cursor between parens
  });

  it('skip-close bracket', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeChar(editor, '(');
    typeChar(editor, ')');
    expect(text(editor)).toBe('()');
    expect(editor.state.selection.from).toBe(3); // cursor after )
  });
});

// ── Edge cases ────────────────────────────────────────────────

describe('Edge cases', () => {
  it('backtick inside code block passes through', () => {
    const { editor } = createEditor('<pre><code>x</code></pre>', allExtensions());
    editor.commands.setTextSelection(2);
    typeChar(editor, '`');
    expect(text(editor)).toContain('`');
  });

  it('typing in empty paragraph after code block works', () => {
    const { editor } = createEditor('<pre><code>hello</code></pre><p></p>', allExtensions());
    const lastParaPos = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(lastParaPos);
    typeString(editor, 'world');
    expect(text(editor)).toContain('world');
  });

  it('multiple backticks without closing do not corrupt document', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '````');
    const content = text(editor);
    // Should either be literal backticks or a code block, not broken state
    expect(content.length + codeBlockCount(editor)).toBeGreaterThan(0);
  });

  it('backtick at end of line does not break editor', () => {
    const { editor } = createEditor('<p>hello</p>', allExtensions());
    editor.commands.setTextSelection(6); // end of "hello"
    typeChar(editor, '`');
    expect(text(editor)).toBe('hello`');
  });

  it('SmartTypography does not interfere with normal typing', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, 'hello world');
    expect(text(editor)).toBe('hello world');
  });

  it('`` after space preserves the space', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, 'hello ');
    expect(text(editor)).toBe('hello ');
    typeString(editor, '``');
    // Space should still be there; backticks consumed to start code mode
    expect(text(editor)).toBe('hello ');
    // Now type a character in code mode
    typeChar(editor, 'x');
    expect(text(editor)).toBe('hello x');
  });

  it('`` at start of paragraph does not produce extra whitespace', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '``');
    expect(text(editor)).toBe('');
    typeChar(editor, 'x');
    expect(text(editor)).toBe('x');
  });

});

// Between-delimiter, closing-delimiter, and ArrowRight-exit tests removed —
// smart-typography inline mark conversion was removed.

// ── Code block from existing content ──────────────────────────

describe('Code blocks in loaded documents', () => {
  it('renders existing code block with language attribute', () => {
    const { editor } = createEditor(
      '<pre data-language="typescript"><code>const x = 1;</code></pre>',
      allExtensions(),
    );
    expect(codeBlockCount(editor)).toBe(1);
  });

  it('renders empty code block', () => {
    const { editor } = createEditor(
      '<pre><code></code></pre>',
      allExtensions(),
    );
    expect(codeBlockCount(editor)).toBe(1);
  });

  it('typing inside existing code block works', () => {
    const { editor } = createEditor(
      '<pre><code>hello</code></pre>',
      allExtensions(),
    );
    editor.commands.setTextSelection(6);
    typeString(editor, ' world');
    expect(text(editor)).toBe('hello world');
    expect(isInCodeBlock(editor)).toBe(true);
  });
});

// ── Markdown link [text](url) conversion ─────────────────────

function linksInDoc(editor: Editor): Array<{ text: string; href: string }> {
  const linkType = editor.state.schema.marks.link;
  if (!linkType) return [];
  const results: Array<{ text: string; href: string }> = [];
  editor.state.doc.descendants((node) => {
    if (node.isText) {
      const linkMark = linkType.isInSet(node.marks);
      if (linkMark) {
        results.push({ text: node.text || '', href: linkMark.attrs.href || '' });
      }
    }
  });
  return results;
}

describe('Markdown link [text](url) conversion', () => {
  afterEach(() => {
    editors.forEach((e) => e.destroy());
    editors = [];
  });

  it('typing [hello](https://example.com) converts to a link', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.setTextSelection(1);
    typeString(editor, '[hello](https://example.com)');
    const links = linksInDoc(editor);
    expect(links.length).toBe(1);
    expect(links[0].text).toBe('hello');
    expect(links[0].href).toBe('https://example.com');
    expect(text(editor)).toBe('hello');
  });

  it('typing [link text](url) after existing text converts correctly', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.setTextSelection(1);
    typeString(editor, 'See [docs](https://docs.dev)');
    const links = linksInDoc(editor);
    expect(links.length).toBe(1);
    expect(links[0].text).toBe('docs');
    expect(links[0].href).toBe('https://docs.dev');
    expect(text(editor)).toBe('See docs');
  });

  it('does not convert wiki-link-style [[text]]', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.setTextSelection(1);
    typeString(editor, '[[hello]]');
    const links = linksInDoc(editor);
    expect(links.length).toBe(0);
  });

  it('empty link text [](url) does not convert', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.setTextSelection(1);
    typeString(editor, '[](https://empty.com)');
    const links = linksInDoc(editor);
    expect(links.length).toBe(0);
  });

  it('empty URL [text]() converts with empty href', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.setTextSelection(1);
    typeString(editor, '[text]()');
    const links = linksInDoc(editor);
    expect(links.length).toBe(1);
    expect(links[0].text).toBe('text');
    expect(links[0].href).toBe('');
  });
});

// ── Bullet list → task list conversion ───────────────────────

function taskListExtensions() {
  return [
    ...allExtensions(),
    TaskList,
    TaskItem.configure({ nested: true }),
  ];
}

function createTaskEditor(content: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({
        codeBlock: { HTMLAttributes: { class: 'kivi-code-block' } },
        code: false,
      }),
      KiviCode,
      ...taskListExtensions(),
    ],
    content,
  });
  editors.push(editor);
  return { editor, el };
}

function hasNodeType(editor: Editor, typeName: string): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) found = true;
  });
  return found;
}

function getTaskItemChecked(editor: Editor): boolean | null {
  let checked: boolean | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'taskItem' && checked === null) {
      checked = node.attrs.checked ?? false;
    }
  });
  return checked;
}

describe('Bullet list → task list conversion', () => {
  it('converts listItem to taskItem when text starts with [ ] ', () => {
    const { editor } = createTaskEditor(
      '<ul><li><p>[ ] hello</p></li></ul>',
    );

    // Place cursor inside the list item text (after "[ ] ")
    let curPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('[ ]') && curPos < 0) {
        curPos = pos + 5;
      }
    });

    if (curPos > 0) {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, curPos)),
      );
    }

    // Simulate a single character insert to trigger appendTransaction
    editor.view.dispatch(editor.state.tr.insertText('!', editor.state.selection.from));

    expect(hasNodeType(editor, 'taskItem')).toBe(true);
    expect(hasNodeType(editor, 'taskList')).toBe(true);
    expect(hasNodeType(editor, 'bulletList')).toBe(false);
    expect(hasNodeType(editor, 'listItem')).toBe(false);
  });

  it('sets checked=true for [x] prefix', () => {
    const { editor } = createTaskEditor(
      '<ul><li><p>[x] done</p></li></ul>',
    );

    let curPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('[x]') && curPos < 0) {
        curPos = pos + 5;
      }
    });

    if (curPos > 0) {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, curPos)),
      );
    }

    editor.view.dispatch(editor.state.tr.insertText('!', editor.state.selection.from));

    expect(hasNodeType(editor, 'taskItem')).toBe(true);
    expect(getTaskItemChecked(editor)).toBe(true);
  });

  it('converts siblings to unchecked taskItems in multi-item list', () => {
    const { editor } = createTaskEditor(
      '<ul><li><p>[ ] first</p></li><li><p>second</p></li></ul>',
    );

    let curPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('[ ]') && curPos < 0) {
        curPos = pos + 5;
      }
    });

    if (curPos > 0) {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, curPos)),
      );
    }

    editor.view.dispatch(editor.state.tr.insertText('!', editor.state.selection.from));

    expect(hasNodeType(editor, 'taskList')).toBe(true);
    expect(hasNodeType(editor, 'bulletList')).toBe(false);
    expect(hasNodeType(editor, 'listItem')).toBe(false);

    let taskItemCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'taskItem') taskItemCount++;
    });
    expect(taskItemCount).toBe(2);
  });
});
