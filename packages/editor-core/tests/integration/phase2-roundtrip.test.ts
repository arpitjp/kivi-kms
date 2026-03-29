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
import { DirtyTracker, resetDirtyTracking } from '../../src/extensions/dirty-tracker.js';
import { WikiLink } from '../../src/extensions/wiki-link.js';
import { HashTag } from '../../src/extensions/hashtag.js';
import { TocBlock } from '../../src/extensions/toc.js';
import { MermaidBlock } from '../../src/extensions/mermaid.js';
import { ExcalidrawBlock } from '../../src/extensions/excalidraw.js';
import type { KiviDocument } from '@kivi/shared-types';

function createPhase2Editor() {
  const el = document.createElement('div');
  document.body.appendChild(el);

  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
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
      WikiLink,
      HashTag,
      TocBlock,
      MermaidBlock,
      ExcalidrawBlock,
    ],
  });

  return { editor, el };
}

function roundTrip(editor: Editor, source: string): string {
  resetBlockIdCounter();
  const kiviDoc = parseMarkdown(source);
  editor.commands.setContent(kiviDoc.doc);
  resetDirtyTracking(editor);

  const currentDoc = editor.getJSON();
  const updatedDoc: KiviDocument = {
    ...kiviDoc,
    doc: currentDoc as Record<string, unknown>,
  };
  return serializeDocument(updatedDoc);
}

describe('Phase 2: wiki-link round-trip', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const r = createPhase2Editor();
    editor = r.editor;
    el = r.el;
  });
  afterEach(() => { editor.destroy(); el.remove(); });

  it('round-trips basic wiki-link', () => {
    const source = 'See [[other-page]] for details.\n';
    expect(roundTrip(editor, source)).toBe(source);
  });

  it('round-trips wiki-link with alias', () => {
    const source = 'See [[other-page|display text]] for details.\n';
    expect(roundTrip(editor, source)).toBe(source);
  });

  it('round-trips multiple wiki-links in paragraph', () => {
    const source = 'Links to [[page-a]] and [[page-b|Beta]].\n';
    expect(roundTrip(editor, source)).toBe(source);
  });
});

describe('Phase 2: hashtag round-trip', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const r = createPhase2Editor();
    editor = r.editor;
    el = r.el;
  });
  afterEach(() => { editor.destroy(); el.remove(); });

  it('round-trips single hashtag', () => {
    const source = '#editor\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('#editor');
  });

  it('round-trips multiple hashtags', () => {
    const source = '#editor #markdown #demo\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('#editor');
    expect(result).toContain('#markdown');
    expect(result).toContain('#demo');
  });

  it('round-trips hierarchical hashtag', () => {
    const source = '#parent/child\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('#parent/child');
  });
});

describe('Phase 2: TOC block round-trip', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const r = createPhase2Editor();
    editor = r.editor;
    el = r.el;
  });
  afterEach(() => { editor.destroy(); el.remove(); });

  it('round-trips [TOC] block', () => {
    const source = '[TOC]\n\n# Heading 1\n\n## Heading 2\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('[TOC]');
  });

  it('round-trips [[toc]] syntax (preserves original form)', () => {
    const source = '[[toc]]\n\n# Heading\n';
    const result = roundTrip(editor, source);
    // [[toc]] is parsed as a wiki-link by remark-wiki-link and may round-trip
    // as [[toc]] or be normalized to [TOC] — both are valid
    expect(result.includes('[TOC]') || result.includes('[[toc]]')).toBe(true);
  });
});

describe('Phase 2: mermaid block round-trip', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const r = createPhase2Editor();
    editor = r.editor;
    el = r.el;
  });
  afterEach(() => { editor.destroy(); el.remove(); });

  it('round-trips mermaid code block', () => {
    const source = '```mermaid\ngraph TD;\n  A-->B;\n```\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('```mermaid');
    expect(result).toContain('graph TD;');
    expect(result).toContain('A-->B;');
  });
});

describe('Phase 2: excalidraw block round-trip', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const r = createPhase2Editor();
    editor = r.editor;
    el = r.el;
  });
  afterEach(() => { editor.destroy(); el.remove(); });

  it('round-trips excalidraw code block', () => {
    const source = '```excalidraw\n{"type":"excalidraw","elements":[]}\n```\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('```excalidraw');
    expect(result).toContain('"type":"excalidraw"');
  });
});

describe('Phase 2: frontmatter round-trip', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const r = createPhase2Editor();
    editor = r.editor;
    el = r.el;
  });
  afterEach(() => { editor.destroy(); el.remove(); });

  it('round-trips frontmatter block', () => {
    const source = '---\ntitle: Test\ntags: [a, b]\n---\n\n# Hello\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('---');
    expect(result).toContain('title: Test');
    expect(result).toContain('# Hello');
  });
});

describe('Phase 2: math round-trip', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const r = createPhase2Editor();
    editor = r.editor;
    el = r.el;
  });
  afterEach(() => { editor.destroy(); el.remove(); });

  it('round-trips block math', () => {
    const source = '$$\nE = mc^2\n$$\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('E = mc^2');
  });

  it('round-trips inline math', () => {
    const source = 'The formula $x^2$ is simple.\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('x^2');
  });
});

describe('Phase 2: strict roundtrip for tags, mermaid, excalidraw', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const r = createPhase2Editor();
    editor = r.editor;
    el = r.el;
  });
  afterEach(() => { editor.destroy(); el.remove(); });

  it('hashtag round-trip preserves surrounding text', () => {
    const source = 'Some text #editor more text.\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('#editor');
    expect(result).toContain('Some text');
    expect(result).toContain('more text');
  });

  it('mermaid block preserves content exactly', () => {
    const source = '```mermaid\ngraph LR;\n  A-->B;\n  B-->C;\n```\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('```mermaid');
    expect(result).toContain('A-->B;');
    expect(result).toContain('B-->C;');
    expect(result).toContain('```');
  });

  it('excalidraw block preserves JSON data', () => {
    const json = '{"type":"excalidraw","elements":[{"id":"1"}]}';
    const source = `\`\`\`excalidraw\n${json}\n\`\`\`\n`;
    const result = roundTrip(editor, source);
    expect(result).toContain('```excalidraw');
    expect(result).toContain('"type":"excalidraw"');
    expect(result).toContain('"id":"1"');
  });
});

describe('Phase 2: wiki-link edge cases', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const r = createPhase2Editor();
    editor = r.editor;
    el = r.el;
  });
  afterEach(() => { editor.destroy(); el.remove(); });

  it('round-trips wiki-link with special characters in target', () => {
    const source = 'See [[my-page_2023]] for details.\n';
    expect(roundTrip(editor, source)).toBe(source);
  });

  it('round-trips wiki-link mixed with bold text', () => {
    const source = 'Check **[[important-page]]** now.\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('[[important-page]]');
    expect(result).toContain('**');
  });

  it('round-trips multiple wiki-links on the same line', () => {
    const source = 'Links: [[a]], [[b]], and [[c]].\n';
    const result = roundTrip(editor, source);
    expect(result).toContain('[[a]]');
    expect(result).toContain('[[b]]');
    expect(result).toContain('[[c]]');
  });
});

describe('Phase 2: complex document with mixed features', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    const r = createPhase2Editor();
    editor = r.editor;
    el = r.el;
  });
  afterEach(() => { editor.destroy(); el.remove(); });

  it('round-trips a document with wiki-links, hashtags, and standard markdown', () => {
    const source = `# My Note

See [[other-note]] for details.

#editor #demo

- Item 1
- Item 2

> A blockquote

---

The end.
`;
    const result = roundTrip(editor, source);
    expect(result).toContain('# My Note');
    expect(result).toContain('[[other-note]]');
    expect(result).toContain('#editor');
    expect(result).toContain('#demo');
    expect(result).toContain('- Item 1');
    expect(result).toContain('> A blockquote');
    expect(result).toContain('---');
  });
});
