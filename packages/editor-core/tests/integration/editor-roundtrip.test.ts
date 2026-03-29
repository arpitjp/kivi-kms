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
