import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { SmartTypography } from '../../src/extensions/smart-typography.js';
import { CodeBlockEnhanced } from '../../src/extensions/code-block-enhanced.js';

let editors: Editor[] = [];

function createEditor(content: string, extraExtensions: any[] = []) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({
        codeBlock: { HTMLAttributes: { class: 'kivi-code-block' } },
      }),
      ...extraExtensions,
    ],
    content,
  });
  editors.push(editor);
  return { editor, el };
}

function allExtensions() {
  return [SmartTypography, CodeBlockEnhanced];
}

/** Simulate typing a character via the ProseMirror handleTextInput path. */
function typeChar(editor: Editor, char: string) {
  const { view } = editor;
  const { from, to } = view.state.selection;
  const handled = view.someProp('handleTextInput', (f) =>
    f(view, from, to, char),
  );
  if (!handled) {
    const tr = view.state.tr.insertText(char, from, to);
    view.dispatch(tr);
  }
  // Flush input rules after the character is inserted
  view.dispatch(view.state.tr);
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

describe('Inline code via Tiptap input rule', () => {
  it('`text` creates inline code mark', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '`hello`');
    const doc = editor.state.doc;
    const codeMark = editor.state.schema.marks.code;
    let found = false;
    doc.descendants((node) => {
      if (node.isText && node.text === 'hello') {
        if (codeMark.isInSet(node.marks)) found = true;
      }
    });
    expect(found).toBe(true);
  });

  it('single backtick does not prematurely create inline code', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeChar(editor, '`');
    expect(text(editor)).toBe('`');
    expect(codeBlockCount(editor)).toBe(0);
  });

  it('two backticks do not create inline code', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '``');
    expect(text(editor)).toBe('``');
    expect(codeBlockCount(editor)).toBe(0);
  });

  it('`` followed by a non-backtick does NOT prematurely activate code', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '``j');
    expect(text(editor)).toBe('``j');
    const codeMark = editor.state.schema.marks.code;
    let hasCode = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && codeMark.isInSet(node.marks)) hasCode = true;
    });
    expect(hasCode).toBe(false);
  });

  it('`text` creates inline code even after adjacent backticks (Slack-like)', () => {
    const { editor } = createEditor('<p>```</p>', allExtensions());
    // Place cursor at end of the ``` text
    editor.commands.setTextSelection(4);
    typeString(editor, '`hello`');
    const codeMark = editor.state.schema.marks.code;
    let found = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === 'hello' && codeMark.isInSet(node.marks)) found = true;
    });
    expect(found).toBe(true);
  });

  it('`j` creates inline code (single char content)', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '`j`');
    const codeMark = editor.state.schema.marks.code;
    let found = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === 'j' && codeMark.isInSet(node.marks)) found = true;
    });
    expect(found).toBe(true);
  });

  it('`a`b` creates code mark for a, then b` remains as text', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '`a`b`');
    const codeMark = editor.state.schema.marks.code;
    let codeTexts: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isText && codeMark.isInSet(node.marks)) codeTexts.push(node.text || '');
    });
    // The first `a` should be caught as inline code
    expect(codeTexts).toContain('a');
  });
});

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

  it('~~~ followed by space also creates a code block', () => {
    const { editor } = createEditor('<p></p>', allExtensions());
    editor.commands.focus('start');
    typeString(editor, '~~~ ');
    expect(codeBlockCount(editor)).toBe(1);
  });
});

// ── Selection wrapping with backtick ──────────────────────────

describe('Selection wrapping with backtick', () => {
  it('selecting text and typing ` toggles code mark', () => {
    const { editor } = createEditor('<p>hello world</p>', allExtensions());
    const { doc } = editor.state;
    const from = 1;
    const to = 6; // "hello"
    editor.commands.setTextSelection({ from, to });

    typeChar(editor, '`');

    const codeMark = editor.state.schema.marks.code;
    let found = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === 'hello' && codeMark.isInSet(node.marks)) {
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it('selecting code text and typing ` removes code mark', () => {
    const { editor } = createEditor('<p><code>hello</code> world</p>', allExtensions());
    const from = 1;
    const to = 6;
    editor.commands.setTextSelection({ from, to });

    typeChar(editor, '`');

    const codeMark = editor.state.schema.marks.code;
    let found = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text?.includes('hello') && codeMark.isInSet(node.marks)) {
        found = true;
      }
    });
    expect(found).toBe(false);
  });

  it('does not wrap with backtick if inside code block', () => {
    const { editor } = createEditor('<pre><code>hello world</code></pre>', allExtensions());
    editor.commands.setTextSelection({ from: 1, to: 6 });

    typeChar(editor, '`');

    expect(text(editor)).toContain('`');
  });
});

// ── Other SmartTypography wrapping ────────────────────────────

describe('SmartTypography other wrapping', () => {
  it('selecting text and typing * toggles bold', () => {
    const { editor } = createEditor('<p>hello world</p>', allExtensions());
    editor.commands.setTextSelection({ from: 1, to: 6 });
    typeChar(editor, '*');

    const boldMark = editor.state.schema.marks.bold;
    let found = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === 'hello' && boldMark.isInSet(node.marks)) {
        found = true;
      }
    });
    expect(found).toBe(true);
  });

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

  it('undo after inline code wrapping works', () => {
    const { editor } = createEditor('<p>hello world</p>', allExtensions());
    editor.commands.setTextSelection({ from: 1, to: 6 });
    typeChar(editor, '`');
    editor.commands.undo();
    const codeMark = editor.state.schema.marks.code;
    let found = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === 'hello' && codeMark.isInSet(node.marks)) {
        found = true;
      }
    });
    expect(found).toBe(false);
  });
});

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
