import { describe, it, expect, beforeEach } from 'vitest';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';
import { serializeDocument, serializeNode } from '../src/serializer.js';

beforeEach(() => {
  resetBlockIdCounter();
});

describe('serializeDocument', () => {
  it('round-trips a simple paragraph', () => {
    const md = 'Hello, world!';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips headings', () => {
    const md = '# Heading 1\n\n## Heading 2\n\n### Heading 3';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips bold and italic', () => {
    const md = 'This is **bold** and *italic* text.';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips code blocks', () => {
    const md = '```typescript\nconst x = 1;\n```';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips unordered lists', () => {
    const md = '- Item 1\n- Item 2\n- Item 3';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips ordered lists', () => {
    const md = '1. First\n2. Second\n3. Third';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips blockquotes', () => {
    const md = '> This is a quote';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips links', () => {
    const md = 'Visit [example](https://example.com) now.';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips horizontal rules', () => {
    const md = 'Above\n\n---\n\nBelow';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('preserves gaps between blocks', () => {
    const md = '# Title\n\n\n\nParagraph with extra gap';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('preserves preamble whitespace', () => {
    const md = '\n\n# Title';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips tables', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips task lists', () => {
    const md = '- [x] Done\n- [ ] Not done';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });

  it('round-trips strikethrough', () => {
    const md = 'This is ~~deleted~~ text.';
    const kiviDoc = parseMarkdown(md);
    const result = serializeDocument(kiviDoc);
    expect(result).toBe(md);
  });
});

describe('serializeNode', () => {
  it('serializes a paragraph', () => {
    const node = { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] };
    expect(serializeNode(node)).toBe('Hello');
  });

  it('serializes a heading', () => {
    const node = { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] };
    expect(serializeNode(node)).toBe('## Title');
  });

  it('serializes a code block', () => {
    const node = { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'code()' }] };
    const result = serializeNode(node);
    expect(result).toContain('```js');
    expect(result).toContain('code()');
  });
});
