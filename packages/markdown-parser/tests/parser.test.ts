import { describe, it, expect, beforeEach } from 'vitest';
import { parseMarkdown, resetBlockIdCounter } from '../src/parser.js';

beforeEach(() => {
  resetBlockIdCounter();
});

describe('parseMarkdown', () => {
  it('parses a simple paragraph', () => {
    const result = parseMarkdown('Hello, world!');
    const doc = result.doc as { type: string; content: unknown[] };
    expect(doc.type).toBe('doc');
    expect(doc.content).toHaveLength(1);
    expect((doc.content[0] as { type: string }).type).toBe('paragraph');
  });

  it('parses headings', () => {
    const md = '# Heading 1\n\n## Heading 2\n\n### Heading 3';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; attrs?: { level: number } }[] };
    expect(doc.content).toHaveLength(3);
    expect(doc.content[0].type).toBe('heading');
    expect(doc.content[0].attrs?.level).toBe(1);
    expect(doc.content[1].attrs?.level).toBe(2);
    expect(doc.content[2].attrs?.level).toBe(3);
  });

  it('parses bold and italic', () => {
    const md = 'This is **bold** and *italic* text.';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content: { type: string; text?: string; marks?: { type: string }[] }[] }[] };
    const paragraph = doc.content[0];
    expect(paragraph.type).toBe('paragraph');
    const boldNode = paragraph.content.find(
      (n) => n.marks?.some((m) => m.type === 'bold'),
    );
    expect(boldNode).toBeDefined();
    expect(boldNode?.text).toBe('bold');
    const italicNode = paragraph.content.find(
      (n) => n.marks?.some((m) => m.type === 'italic'),
    );
    expect(italicNode).toBeDefined();
    expect(italicNode?.text).toBe('italic');
  });

  it('parses code blocks', () => {
    const md = '```typescript\nconst x = 1;\n```';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; attrs?: { language: string } }[] };
    expect(doc.content[0].type).toBe('codeBlock');
    expect(doc.content[0].attrs?.language).toBe('typescript');
  });

  it('parses unordered lists', () => {
    const md = '- Item 1\n- Item 2\n- Item 3';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content: unknown[] }[] };
    expect(doc.content[0].type).toBe('bulletList');
    expect(doc.content[0].content).toHaveLength(3);
  });

  it('parses ordered lists', () => {
    const md = '1. First\n2. Second\n3. Third';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; attrs?: { start: number } }[] };
    expect(doc.content[0].type).toBe('orderedList');
    expect(doc.content[0].attrs?.start).toBe(1);
  });

  it('parses blockquotes', () => {
    const md = '> This is a quote';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string }[] };
    expect(doc.content[0].type).toBe('blockquote');
  });

  it('parses links', () => {
    const md = 'Visit [example](https://example.com) now.';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content: { marks?: { type: string; attrs?: { href: string } }[] }[] }[] };
    const linkNode = doc.content[0].content.find(
      (n) => n.marks?.some((m) => m.type === 'link'),
    );
    expect(linkNode).toBeDefined();
    expect(linkNode?.marks?.find((m) => m.type === 'link')?.attrs?.href).toBe(
      'https://example.com',
    );
  });

  it('parses horizontal rules', () => {
    const md = 'Above\n\n---\n\nBelow';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string }[] };
    expect(doc.content[1].type).toBe('horizontalRule');
  });

  it('parses task lists (GFM)', () => {
    const md = '- [x] Done\n- [ ] Not done';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content: { type: string; attrs?: { checked: boolean } }[] }[] };
    expect(doc.content[0].type).toBe('taskList');
    expect(doc.content[0].content[0].attrs?.checked).toBe(true);
    expect(doc.content[0].content[1].attrs?.checked).toBe(false);
  });

  it('parses tables (GFM)', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string }[] };
    expect(doc.content[0].type).toBe('table');
  });

  it('parses strikethrough (GFM)', () => {
    const md = 'This is ~~deleted~~ text.';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { content: { marks?: { type: string }[] }[] }[] };
    const strikeNode = doc.content[0].content.find(
      (n) => n.marks?.some((m) => m.type === 'strike'),
    );
    expect(strikeNode).toBeDefined();
  });
});

describe('source map', () => {
  it('captures block positions', () => {
    const md = '# Title\n\nA paragraph.\n\n- list item';
    const result = parseMarkdown(md);
    expect(result.blockOrder).toHaveLength(3);
    expect(result.sourceMap.blocks.size).toBe(3);

    const firstBlock = result.sourceMap.blocks.get(result.blockOrder[0])!;
    expect(firstBlock.originalSource).toBe('# Title');
    expect(firstBlock.dirty).toBe(false);
  });

  it('captures gaps between blocks', () => {
    const md = '# Title\n\nParagraph';
    const result = parseMarkdown(md);
    expect(result.sourceMap.gaps).toHaveLength(1);
    expect(result.sourceMap.gaps[0].text).toBe('\n\n');
  });

  it('captures preamble and postamble', () => {
    const md = '\n\n# Title\n\n';
    const result = parseMarkdown(md);
    expect(result.sourceMap.preamble).toBe('\n\n');
    expect(result.sourceMap.postamble).toBe('\n\n');
  });

  it('extracts heading style hints', () => {
    const md = '# ATX Heading';
    const result = parseMarkdown(md);
    const block = result.sourceMap.blocks.get(result.blockOrder[0])!;
    expect(block.styleHints.headingStyle).toBe('atx');
  });

  it('extracts list marker style hints', () => {
    const md = '* Item 1\n* Item 2';
    const result = parseMarkdown(md);
    const block = result.sourceMap.blocks.get(result.blockOrder[0])!;
    expect(block.styleHints.listMarker).toBe('*');
  });

  it('extracts code fence style hints', () => {
    const md = '~~~js\ncode\n~~~';
    const result = parseMarkdown(md);
    const block = result.sourceMap.blocks.get(result.blockOrder[0])!;
    expect(block.styleHints.codeFenceChar).toBe('~');
    expect(block.styleHints.codeFenceLength).toBe(3);
  });
});
