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
import { createKiviEditor } from '../../src/editor.js';
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

// ── Mode switch simulation ─────────────────────────────────
//
// Mode switching (live ↔ source ↔ split) serializes via getMarkdown()
// and reloads via loadMarkdown(). These tests verify that content is
// preserved across multiple cycles through that path.

describe('integration: mode switch (getMarkdown → loadMarkdown round-trip)', () => {
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

  function simulateModeSwitch(source: string): string {
    resetBlockIdCounter();
    const kiviDoc = parseMarkdown(source);
    editor.commands.setContent(kiviDoc.doc);
    const exported = serializeDocument({
      ...kiviDoc,
      doc: editor.getJSON() as Record<string, unknown>,
    });
    return exported;
  }

  function multiCycleRoundTrip(source: string, cycles: number): string {
    let current = source;
    for (let i = 0; i < cycles; i++) {
      current = simulateModeSwitch(current);
    }
    return current;
  }

  it('single live→source→live preserves headings and paragraphs', () => {
    const source = '# Hello\n\nThis is a test.\n';
    const result = multiCycleRoundTrip(source, 1);
    expect(result).toBe(source);
  });

  it('single cycle preserves links', () => {
    const source = 'Check [Google](https://google.com) and [MDN](https://mdn.dev).\n';
    const result = multiCycleRoundTrip(source, 1);
    expect(result).toBe(source);
  });

  it('single cycle preserves inline formatting', () => {
    const source = 'This is **bold**, *italic*, ~~struck~~, and `code`.\n';
    const result = multiCycleRoundTrip(source, 1);
    expect(result).toBe(source);
  });

  it('single cycle preserves lists', () => {
    const source = '- Item A\n- Item B\n\n1. First\n2. Second\n';
    const result = multiCycleRoundTrip(source, 1);
    expect(result).toBe(source);
  });

  it('single cycle preserves code blocks', () => {
    const source = '```typescript\nconst x: number = 42;\n```\n';
    const result = multiCycleRoundTrip(source, 1);
    expect(result).toBe(source);
  });

  it('single cycle preserves tables', () => {
    const source = '| Name | Value |\n| --- | --- |\n| foo | bar |\n';
    const result = multiCycleRoundTrip(source, 1);
    expect(result).toBe(source);
  });

  it('single cycle preserves blockquotes', () => {
    const source = '> First line\n>\n> Second line\n';
    const result = multiCycleRoundTrip(source, 1);
    expect(result).toBe(source);
  });

  it('three cycles preserve content (no drift)', () => {
    const source = `# Multi-cycle Test

Paragraph with **bold** and [link](https://example.com).

- List item

\`\`\`js
console.log("hello");
\`\`\`

> Blockquote
`;
    const result = multiCycleRoundTrip(source, 3);
    expect(result).toContain('# Multi-cycle Test');
    expect(result).toContain('**bold**');
    expect(result).toContain('[link](https://example.com)');
    expect(result).toContain('- List item');
    expect(result).toContain('```js');
    expect(result).toContain('> Blockquote');
  });

  it('five cycles of kitchen-sink document show no content loss', () => {
    const source = `# Kitchen Sink

Paragraph with **bold**, *italic*, ~~strikethrough~~, and \`inline code\`.

## Links

Visit [Example](https://example.com) or [MDN](https://mdn.dev).

## Lists

- Bullet 1
- Bullet 2

1. Ordered 1
2. Ordered 2

- [x] Done
- [ ] Pending

## Table

| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |

## Code

\`\`\`python
print("hello world")
\`\`\`

## Blockquote

> This is a quote
>
> With multiple paragraphs

---

The end.
`;
    const after5 = multiCycleRoundTrip(source, 5);
    expect(after5).toContain('# Kitchen Sink');
    expect(after5).toContain('**bold**');
    expect(after5).toContain('*italic*');
    expect(after5).toContain('~~strikethrough~~');
    expect(after5).toContain('`inline code`');
    expect(after5).toContain('[Example](https://example.com)');
    expect(after5).toContain('- Bullet 1');
    expect(after5).toContain('| A | B | C |');
    expect(after5).toContain('```python');
    expect(after5).toContain('> This is a quote');
    expect(after5).toContain('---');
    expect(after5).toContain('The end.');
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

// ── deferContent + loadMarkdownAsync ──────────────────────────

describe('deferContent and loadMarkdownAsync', () => {
  let kiviEditors: ReturnType<typeof createKiviEditor>[] = [];

  afterEach(() => {
    for (const ke of kiviEditors) ke.destroy();
    kiviEditors = [];
    document.body.innerHTML = '';
  });

  it('deferContent=true creates an empty editor', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const kivi = createKiviEditor({
      element: el,
      content: '# Hello\n\nWorld\n',
      deferContent: true,
    });
    kiviEditors.push(kivi);
    const md = kivi.getMarkdown();
    expect(md.trim()).toBe('');
  });

  it('loadMarkdownAsync loads content into a deferred editor', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const kivi = createKiviEditor({
      element: el,
      content: '# Hello\n\nWorld\n',
      deferContent: true,
    });
    kiviEditors.push(kivi);
    await kivi.loadMarkdownAsync('# Hello\n\nWorld\n');
    const md = kivi.getMarkdown();
    expect(md).toContain('# Hello');
    expect(md).toContain('World');
  });

  it('deferContent=false loads content synchronously', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const kivi = createKiviEditor({
      element: el,
      content: '# Sync\n\nLoaded\n',
      deferContent: false,
    });
    kiviEditors.push(kivi);
    const md = kivi.getMarkdown();
    expect(md).toContain('# Sync');
    expect(md).toContain('Loaded');
  });

  it('loadMarkdownAsync round-trips task lists', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const kivi = createKiviEditor({ element: el, deferContent: true });
    kiviEditors.push(kivi);
    const source = '- [ ] unchecked\n- [x] checked\n';
    await kivi.loadMarkdownAsync(source);
    const md = kivi.getMarkdown();
    expect(md).toContain('- [ ] unchecked');
    expect(md).toContain('- [x] checked');
  });
});
