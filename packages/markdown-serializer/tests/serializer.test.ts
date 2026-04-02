import { describe, it, expect, beforeEach } from 'vitest';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';
import { serializeDocument, serializeNode } from '../src/index.js';

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

  it('heading with trailing space does not produce &#x20; entity', () => {
    const node = {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Child A ' }],
    };
    const result = serializeNode(node);
    expect(result).not.toContain('&#x20;');
    expect(result).toBe('# Child A');
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

describe('serializeDocument wiki-link round-trip', () => {
  it('round-trips `[[page-name]]`', () => {
    const md = 'Link to [[page-name]] here.';
    const kiviDoc = parseMarkdown(md);
    expect(serializeDocument(kiviDoc)).toBe(md);
  });

  it('round-trips `[[page-name|display text]]`', () => {
    const md = 'See [[page-name|display text]] for details.';
    const kiviDoc = parseMarkdown(md);
    expect(serializeDocument(kiviDoc)).toBe(md);
  });
});

describe('serializeDocument TOC round-trip', () => {
  it('round-trips `[TOC]` marker as `[TOC]`', () => {
    const md = '[TOC]';
    const kiviDoc = parseMarkdown(md);
    expect(serializeDocument(kiviDoc)).toBe(md);
  });
});

describe('serializeDocument mermaid and excalidraw round-trip', () => {
  it('round-trips a mermaid fenced code block', () => {
    const md = '```mermaid\ngraph TD\n  A --> B\n```';
    const kiviDoc = parseMarkdown(md);
    expect(serializeDocument(kiviDoc)).toBe(md);
  });

  it('round-trips an excalidraw fenced code block', () => {
    const md = '```excalidraw\n{}\n```';
    const kiviDoc = parseMarkdown(md);
    expect(serializeDocument(kiviDoc)).toBe(md);
  });
});

describe('serializeDocument hashtag round-trip', () => {
  it('round-trips a hashtag in a paragraph', () => {
    const md = 'Track #mytag in prose.';
    const kiviDoc = parseMarkdown(md);
    expect(serializeDocument(kiviDoc)).toBe(md);
  });
});

describe('serializeNode wiki-link, hashtag, TOC, mermaid, excalidraw', () => {
  it('serializes a wiki-link mark as `[[target]]`', () => {
    const node = {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'page-name', marks: [{ type: 'wikiLink', attrs: { target: 'page-name', alias: null } }] },
      ],
    };
    expect(serializeNode(node)).toBe('[[page-name]]');
  });

  it('serializes a wiki-link with alias as `[[target|alias]]`', () => {
    const node = {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'display text',
          marks: [{ type: 'wikiLink', attrs: { target: 'page-name', alias: 'display text' } }],
        },
      ],
    };
    expect(serializeNode(node)).toBe('[[page-name|display text]]');
  });

  it('serializes tocBlock (remark-stringify escapes brackets in plain text)', () => {
    expect(serializeNode({ type: 'tocBlock' })).toBe('\\[TOC]');
  });

  it('serializes mermaidBlock as fenced mermaid code', () => {
    const node = {
      type: 'mermaidBlock',
      attrs: { language: 'mermaid' },
      content: [{ type: 'text', text: 'graph TD\n  A --> B' }],
    };
    const out = serializeNode(node);
    expect(out).toBe('```mermaid\ngraph TD\n  A --> B\n```');
  });

  it('serializes excalidrawBlock from attrs.data as fenced excalidraw code', () => {
    const node = { type: 'excalidrawBlock', attrs: { data: '{}' } };
    expect(serializeNode(node)).toBe('```excalidraw\n{}\n```');
  });

  it('serializes a hashTag mark (remark-stringify escapes leading # in paragraph)', () => {
    const node = {
      type: 'paragraph',
      content: [{ type: 'text', text: '#mytag', marks: [{ type: 'hashTag', attrs: { tag: 'mytag' } }] }],
    };
    expect(serializeNode(node)).toBe('\\#mytag');
  });
});
