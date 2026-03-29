import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Underline from '@tiptap/extension-underline';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';
import { serializeDocument } from '@kivi/markdown-serializer';
import { Frontmatter } from '../../src/extensions/frontmatter.js';
import { MathBlock, MathInline } from '../../src/extensions/math.js';
import { FootnoteRef, FootnoteDef } from '../../src/extensions/footnote.js';
import { DirtyTracker, getDirtyBlockIndices, applyDirtyFlags, resetDirtyTracking } from '../../src/extensions/dirty-tracker.js';
import type { KiviDocument, SourceMap } from '@kivi/shared-types';

function createTestEditor() {
  const el = document.createElement('div');
  document.body.appendChild(el);

  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      Link.configure({ openOnClick: false }),
      Image,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      Underline,
      Frontmatter,
      MathBlock.configure({ renderMath: null }),
      MathInline.configure({ renderMath: null }),
      FootnoteRef,
      FootnoteDef,
      DirtyTracker,
    ],
  });

  return { editor, el };
}

function loadAndSerialize(editor: Editor, source: string): { kiviDoc: KiviDocument; markdown: string } {
  resetBlockIdCounter();
  const kiviDoc = parseMarkdown(source);
  editor.commands.setContent(kiviDoc.doc);

  const currentDoc = editor.getJSON();
  const updatedDoc: KiviDocument = {
    ...kiviDoc,
    doc: currentDoc as Record<string, unknown>,
  };
  const markdown = serializeDocument(updatedDoc);
  return { kiviDoc: updatedDoc, markdown };
}

describe('integration: editor round-trip', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const result = createTestEditor();
    editor = result.editor;
    el = result.el;
  });

  afterEach(() => {
    editor.destroy();
    el.remove();
  });

  it('round-trips basic paragraphs', () => {
    const source = 'Hello world.\n\nSecond paragraph.\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips headings', () => {
    const source = '# Heading 1\n\n## Heading 2\n\n### Heading 3\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips bold and italic', () => {
    const source = 'This is **bold** and *italic* text.\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips bullet lists', () => {
    const source = '- Item 1\n- Item 2\n- Item 3\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips ordered lists', () => {
    const source = '1. First\n2. Second\n3. Third\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips code blocks', () => {
    const source = '```javascript\nconst x = 1;\nconsole.log(x);\n```\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips blockquotes', () => {
    const source = '> This is a quote.\n>\n> With two paragraphs.\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips links', () => {
    const source = 'Check out [Google](https://google.com) for more.\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips horizontal rules', () => {
    const source = 'Before.\n\n---\n\nAfter.\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips complex document', () => {
    const source = `# Title

A paragraph with **bold**, *italic*, and \`code\`.

## Lists

- Bullet 1
- Bullet 2

1. Ordered 1
2. Ordered 2

> A blockquote

\`\`\`python
def hello():
    print("world")
\`\`\`

---

The end.
`;
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });
});

describe('integration: editor round-trip — tables, tasks, images, strikethrough', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const result = createTestEditor();
    editor = result.editor;
    el = result.el;
  });

  afterEach(() => {
    editor.destroy();
    el.remove();
  });

  it('round-trips a simple table', () => {
    const source = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips a table with multiple rows', () => {
    const source = '| Name | Age | City |\n| --- | --- | --- |\n| Alice | 30 | NYC |\n| Bob | 25 | LA |\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips task lists', () => {
    const source = '- [x] Done task\n- [ ] Pending task\n- [x] Another done\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips images', () => {
    const source = '![Alt text](https://example.com/image.png)\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips strikethrough', () => {
    const source = 'This is ~~deleted~~ text.\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips nested lists', () => {
    const source = '- Item 1\n  - Nested A\n  - Nested B\n- Item 2\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips ordered lists with nested items', () => {
    const source = '1. First\n   1. Sub first\n   2. Sub second\n2. Second\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips link with title', () => {
    const source = '[Example](https://example.com "Example Title")\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips inline code', () => {
    const source = 'Use `const x = 1` in your code.\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips multiple headings H1-H6', () => {
    const source = '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips code block without language', () => {
    const source = '```\nplain code\n```\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips multiple adjacent code blocks', () => {
    const source = '```js\nblock1();\n```\n\n```py\nblock2()\n```\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });
});

describe('integration: edge cases through editor', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const result = createTestEditor();
    editor = result.editor;
    el = result.el;
  });

  afterEach(() => {
    editor.destroy();
    el.remove();
  });

  it('round-trips empty document', () => {
    const source = '';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown.trim()).toBe('');
  });

  it('round-trips document with only whitespace', () => {
    const source = '\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown.trim()).toBe('');
  });

  it('round-trips single heading only', () => {
    const source = '# Hello\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips blockquote with nested list', () => {
    const source = '> Quote with list:\n>\n> - Item A\n> - Item B\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips escaped markdown characters', () => {
    const source = 'This is \\*not italic\\* and \\*\\*not bold\\*\\*.\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toContain('not italic');
    expect(markdown).toContain('not bold');
  });

  it('round-trips code blocks with empty lines', () => {
    const source = '```\nline 1\n\nline 3\n```\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toBe(source);
  });

  it('round-trips bold italic combo', () => {
    const source = 'This is ***bold italic*** text.\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toContain('bold italic');
    const hasBoldItalic = markdown.includes('***bold italic***') ||
      markdown.includes('**_bold italic_**') || markdown.includes('*__bold italic__*');
    expect(hasBoldItalic).toBe(true);
  });

  it('round-trips multiple blank lines preserving structure', () => {
    const source = '# Title\n\n\nParagraph after extra blank.\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toContain('# Title');
    expect(markdown).toContain('Paragraph after extra blank.');
  });

  it('round-trips deeply nested blockquotes', () => {
    const source = '> Level 1\n>\n> > Level 2\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toContain('> Level 1');
    expect(markdown).toContain('> > Level 2');
  });

  it('round-trips mixed inline formatting', () => {
    const source = 'A paragraph with **bold**, *italic*, `code`, ~~strike~~, and a [link](https://x.com).\n';
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('*italic*');
    expect(markdown).toContain('`code`');
    expect(markdown).toContain('~~strike~~');
    expect(markdown).toContain('[link](https://x.com)');
  });

  it('round-trips a comprehensive document', () => {
    const source = `# Kitchen Sink

A paragraph with **bold**, *italic*, and \`code\`.

## Lists

- Bullet 1
- Bullet 2
  - Nested

1. Ordered 1
2. Ordered 2

- [x] Task done
- [ ] Task pending

## Table

| A | B |
| --- | --- |
| 1 | 2 |

## Blockquote

> Quote here

\`\`\`typescript
const x = 1;
\`\`\`

---

The end.
`;
    const { markdown } = loadAndSerialize(editor, source);
    expect(markdown).toContain('# Kitchen Sink');
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('- Bullet 1');
    expect(markdown).toContain('[x] Task done');
    expect(markdown).toContain('| A | B |');
    expect(markdown).toContain('> Quote here');
    expect(markdown).toContain('```typescript');
    expect(markdown).toContain('---');
  });
});

describe('integration: dirty tracking', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const result = createTestEditor();
    editor = result.editor;
    el = result.el;
  });

  afterEach(() => {
    editor.destroy();
    el.remove();
  });

  it('starts with no dirty blocks after load', () => {
    const source = '# Hello\n\nWorld.\n';
    resetBlockIdCounter();
    const kiviDoc = parseMarkdown(source);
    editor.commands.setContent(kiviDoc.doc);
    resetDirtyTracking(editor);

    const dirty = getDirtyBlockIndices(editor.state);
    expect(dirty.size).toBe(0);
  });

  it('marks blocks dirty on text insertion', () => {
    const source = '# Hello\n\nWorld.\n';
    resetBlockIdCounter();
    const kiviDoc = parseMarkdown(source);
    editor.commands.setContent(kiviDoc.doc);

    // Move cursor to end of first heading and type
    editor.commands.focus('start');
    editor.commands.insertContent('X');

    const dirty = getDirtyBlockIndices(editor.state);
    expect(dirty.size).toBeGreaterThan(0);
  });

  it('applyDirtyFlags marks the correct blocks', () => {
    const source = '# Title\n\nParagraph.\n';
    resetBlockIdCounter();
    const kiviDoc = parseMarkdown(source);
    editor.commands.setContent(kiviDoc.doc);

    const dirtySet = new Set([1]);
    applyDirtyFlags(kiviDoc, dirtySet);

    const block0 = kiviDoc.sourceMap.blocks.get(kiviDoc.blockOrder[0]);
    const block1 = kiviDoc.sourceMap.blocks.get(kiviDoc.blockOrder[1]);

    expect(block0?.dirty).toBe(false);
    expect(block1?.dirty).toBe(true);
  });
});
