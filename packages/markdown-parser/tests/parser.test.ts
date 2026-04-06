import { describe, it, expect, beforeEach } from 'vitest';
import { parseMarkdown, resetBlockIdCounter } from '../src/index.js';

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

  it('parses mixed lists: plain bullets and checkboxes in one list', () => {
    const md = '- plain item\n- [ ] unchecked\n- [x] checked\n- another plain';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content: { type: string; attrs?: { checked: boolean } }[] }[] };
    const list = doc.content[0];
    expect(list.type).toBe('bulletList');
    expect(list.content).toHaveLength(4);
    expect(list.content[0].type).toBe('listItem');
    expect(list.content[1].type).toBe('taskItem');
    expect(list.content[1].attrs?.checked).toBe(false);
    expect(list.content[2].type).toBe('taskItem');
    expect(list.content[2].attrs?.checked).toBe(true);
    expect(list.content[3].type).toBe('listItem');
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

type PMText = {
  type: string;
  text?: string;
  marks?: { type: string; attrs?: { target?: string; alias?: string | null } }[];
};

type PMParagraph = { type: string; content?: PMNode[] };
type PMNode = PMText | PMParagraph | { type: string; attrs?: Record<string, unknown>; content?: PMNode[] };

function paragraphContent(doc: { content: PMNode[] }): PMNode[] {
  const first = doc.content[0] as PMParagraph;
  expect(first.type).toBe('paragraph');
  return first.content ?? [];
}

describe('wiki links', () => {
  it('parses [[page-name]] into text with wikiLink mark (target, alias)', () => {
    const result = parseMarkdown('See [[page-name]] here.');
    const doc = result.doc as { type: string; content: PMNode[] };
    const nodes = paragraphContent(doc);
    const wiki = nodes.find(
      (n): n is PMText =>
        n.type === 'text' && Boolean((n as PMText).marks?.some((m) => m.type === 'wikiLink')),
    );
    expect(wiki).toBeDefined();
    expect(wiki?.text).toBe('page-name');
    const mark = wiki?.marks?.find((m) => m.type === 'wikiLink');
    expect(mark?.attrs?.target).toBe('page-name');
    expect(mark?.attrs?.alias).toBeNull();
  });

  it('parses [[page-name|display text]] into wikiLink with target and alias', () => {
    const result = parseMarkdown('Link: [[page-name|display text]].');
    const doc = result.doc as { type: string; content: PMNode[] };
    const nodes = paragraphContent(doc);
    const wiki = nodes.find(
      (n): n is PMText =>
        n.type === 'text' && Boolean((n as PMText).marks?.some((m) => m.type === 'wikiLink')),
    );
    expect(wiki?.text).toBe('display text');
    const mark = wiki?.marks?.find((m) => m.type === 'wikiLink');
    expect(mark?.attrs?.target).toBe('page-name');
    expect(mark?.attrs?.alias).toBe('display text');
  });

  it('does not parse wiki links when wikiLinks option is false', () => {
    const result = parseMarkdown('[[not-a-link]]', { wikiLinks: false });
    const doc = result.doc as { type: string; content: PMNode[] };
    const nodes = paragraphContent(doc);
    const wiki = nodes.find(
      (n) => n.type === 'text' && (n as PMText).marks?.some((m) => m.type === 'wikiLink'),
    );
    expect(wiki).toBeUndefined();
    const text = nodes.find((n) => n.type === 'text') as PMText | undefined;
    expect(text?.text).toContain('not-a-link');
  });
});

describe('hashtags', () => {
  it('parses #tag-name in plain text into hashTag marks', () => {
    const result = parseMarkdown('Track #tag-name in prose.');
    const doc = result.doc as { type: string; content: PMNode[] };
    const nodes = paragraphContent(doc);
    const tagged = nodes.find(
      (n) => n.type === 'text' && (n as PMText).marks?.some((m) => m.type === 'hashTag'),
    ) as PMText | undefined;
    expect(tagged).toBeDefined();
    expect(tagged?.text).toBe('#tag-name');
    const mark = (tagged as PMText).marks?.find((m) => m.type === 'hashTag');
    expect(mark?.attrs?.tag).toBe('tag-name');
  });

  it('parses hashtag after whitespace', () => {
    const result = parseMarkdown('Hello world #my_tag');
    const doc = result.doc as { type: string; content: PMNode[] };
    const nodes = paragraphContent(doc);
    const tagged = nodes.find(
      (n) => n.type === 'text' && (n as PMText).marks?.some((m) => m.type === 'hashTag'),
    ) as PMText | undefined;
    const mark = tagged?.marks?.find((m) => m.type === 'hashTag');
    expect(mark?.attrs?.tag).toBe('my_tag');
  });

  it('parses multiple hashtags in one paragraph', () => {
    const result = parseMarkdown('#first and #second');
    const doc = result.doc as { type: string; content: PMNode[] };
    const nodes = paragraphContent(doc);
    const tags = nodes
      .filter((n) => n.type === 'text' && (n as PMText).marks?.some((m) => m.type === 'hashTag'))
      .map((n) => (n as PMText).marks?.find((m) => m.type === 'hashTag')?.attrs?.tag);
    expect(tags).toEqual(['first', 'second']);
  });

  it('does not split hashtags inside inline code', () => {
    const result = parseMarkdown('Use `#not-a-tag` here.');
    const doc = result.doc as { type: string; content: PMNode[] };
    const nodes = paragraphContent(doc);
    const tagged = nodes.find(
      (n) => n.type === 'text' && (n as PMText).marks?.some((m) => m.type === 'hashTag'),
    );
    expect(tagged).toBeUndefined();
    const codeText = nodes.find(
      (n) => n.type === 'text' && (n as PMText).marks?.some((m) => m.type === 'code'),
    ) as PMText | undefined;
    expect(codeText?.text).toBe('#not-a-tag');
  });

  it('does not emit hashTag marks inside fenced code blocks', () => {
    const md = '```\n#comment-not-tag\n```';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: PMNode[] };
    expect(doc.content[0].type).toBe('codeBlock');
    const block = doc.content[0] as { content?: PMText[] };
    expect(block.content?.[0]?.text).toContain('#comment-not-tag');
  });
});

describe('frontmatter', () => {
  it('parses YAML frontmatter into a frontmatter node', () => {
    const md = '---\ntitle: Hello\ntags: [a, b]\n---\n\n# Heading';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content?: PMNode[] }[] };
    expect(doc.content[0].type).toBe('frontmatter');
    const text = (doc.content[0].content?.[0] as PMText)?.text;
    expect(text).toContain('title: Hello');
    expect(doc.content[1].type).toBe('heading');
  });
});

describe('math', () => {
  it('parses display math $$ into mathBlock', () => {
    const md = '$$\n\\sum_{i=0}^n i\n$$';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content?: PMNode[] }[] };
    expect(doc.content[0].type).toBe('mathBlock');
    const text = (doc.content[0].content?.[0] as PMText)?.text;
    expect(text).toContain('\\sum');
  });

  it('parses inline math $ into mathInline', () => {
    const md = 'Energy is $E=mc^2$ always.';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content?: PMNode[] }[] };
    const para = doc.content[0];
    expect(para.type).toBe('paragraph');
    const mathNode = para.content?.find((n: PMNode) => (n as { type: string }).type === 'mathInline');
    expect(mathNode).toBeDefined();
  });
});

describe('footnotes', () => {
  it('parses [^1] reference into footnoteRef', () => {
    const md = 'Some claim[^1] here.\n\n[^1]: The source.';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content?: PMNode[] }[] };
    const para = doc.content[0];
    const fnRef = para.content?.find((n: PMNode) => (n as { type: string }).type === 'footnoteRef');
    expect(fnRef).toBeDefined();
    expect((fnRef as { attrs?: { label: string } })?.attrs?.label).toBe('1');
  });

  it('parses [^1]: definition into footnoteDef', () => {
    const md = 'Text[^note].\n\n[^note]: This is the definition.';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; attrs?: { label: string } }[] };
    const fnDef = doc.content.find(n => n.type === 'footnoteDef');
    expect(fnDef).toBeDefined();
    expect(fnDef?.attrs?.label).toBe('note');
  });
});

describe('advanced block structures', () => {
  it('parses nested blockquotes', () => {
    const md = '> Outer\n>\n> > Inner nested';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content?: { type: string }[] }[] };
    expect(doc.content[0].type).toBe('blockquote');
    const innerBq = doc.content[0].content?.find(n => n.type === 'blockquote');
    expect(innerBq).toBeDefined();
  });

  it('parses deeply nested lists (4 levels, mixed)', () => {
    const md = '- L1\n  1. L2\n     - L3\n       1. L4';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: PMNode[] };
    expect(doc.content[0].type).toBe('bulletList');
  });

  it('parses ordered list with start != 1', () => {
    const md = '3. Third\n4. Fourth\n5. Fifth';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; attrs?: { start: number } }[] };
    expect(doc.content[0].type).toBe('orderedList');
    expect(doc.content[0].attrs?.start).toBe(3);
  });
});

describe('inline elements', () => {
  it('parses inline code', () => {
    const md = 'Use `console.log` for output.';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: PMNode[] };
    const nodes = paragraphContent(doc);
    const codeNode = nodes.find(
      (n) => n.type === 'text' && (n as PMText).marks?.some(m => m.type === 'code'),
    ) as PMText | undefined;
    expect(codeNode?.text).toBe('console.log');
  });

  it('parses hard breaks (trailing double space)', () => {
    const md = 'Line one  \nLine two';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content?: PMNode[] }[] };
    const para = doc.content[0];
    const hardBreak = para.content?.find((n: PMNode) => (n as { type: string }).type === 'hardBreak');
    expect(hardBreak).toBeDefined();
  });

  it('parses links with titles', () => {
    const md = '[Example](https://example.com "A title")';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; content?: PMNode[] }[] };
    const nodes = doc.content[0].content ?? [];
    const linkNode = nodes.find(
      (n: PMNode) => (n as PMText).marks?.some(m => m.type === 'link'),
    );
    expect(linkNode).toBeDefined();
    const linkMark = (linkNode as PMText).marks?.find(m => m.type === 'link');
    expect((linkMark?.attrs as Record<string, unknown>)?.href).toBe('https://example.com');
  });
});

describe('HTML blocks', () => {
  it('parses <img> with poster attribute', () => {
    const md = '<img src="thumb.jpg" alt="Video" poster="poster.jpg" />';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; attrs?: Record<string, unknown> }[] };
    expect(doc.content[0].type).toBe('image');
    expect(doc.content[0].attrs?.src).toBe('thumb.jpg');
  });
});

describe('TOC marker', () => {
  it('parses standalone [TOC] paragraph into tocBlock', () => {
    const result = parseMarkdown('[TOC]');
    const doc = result.doc as { type: string; content: { type: string }[] };
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('tocBlock');
  });

  it('parses standalone [[toc]] paragraph into tocBlock', () => {
    const result = parseMarkdown('[[toc]]');
    const doc = result.doc as { type: string; content: { type: string }[] };
    expect(doc.content[0].type).toBe('tocBlock');
  });

  it('parses [toc] case-insensitively', () => {
    const result = parseMarkdown('[ToC]');
    const doc = result.doc as { type: string; content: { type: string }[] };
    expect(doc.content[0].type).toBe('tocBlock');
  });

  it('does not treat [TOC] inside a longer paragraph as tocBlock', () => {
    const result = parseMarkdown('See [TOC] for more.');
    const doc = result.doc as { type: string; content: PMNode[] };
    expect(doc.content[0].type).toBe('paragraph');
  });
});

describe('mermaid and excalidraw fenced blocks', () => {
  it('parses ```mermaid fences into mermaidBlock', () => {
    const md = '```mermaid\nflowchart LR\n  A --> B\n```';
    const result = parseMarkdown(md);
    const doc = result.doc as { type: string; content: { type: string; attrs?: { language: string }; content?: PMText[] }[] };
    expect(doc.content[0].type).toBe('mermaidBlock');
    expect(doc.content[0].attrs?.language).toBe('mermaid');
    expect(doc.content[0].content?.[0]?.text).toContain('flowchart');
  });

  it('parses ```excalidraw fences into excalidrawBlock', () => {
    const md = '```excalidraw\n{"foo":1}\n```';
    const result = parseMarkdown(md);
    const doc = result.doc as {
      content: { type: string; attrs?: { data: string } }[];
    };
    expect(doc.content[0].type).toBe('excalidrawBlock');
    expect(doc.content[0].attrs?.data).toContain('foo');
  });

  it('parses ![alt](file.excalidraw) image syntax as excalidrawBlock', () => {
    const md = '![diagram](assets/drawing.excalidraw)';
    const result = parseMarkdown(md);
    const doc = result.doc as { content: { type: string; attrs?: Record<string, unknown> }[] };
    expect(doc.content[0].type).toBe('excalidrawBlock');
    expect(doc.content[0].attrs?.src).toBe('assets/drawing.excalidraw');
    expect(doc.content[0].attrs?.alt).toBe('diagram');
  });

  it('parses [label](file.excalidraw) link syntax as regular link (not excalidrawBlock)', () => {
    const md = '[my drawing](assets/drawing.excalidraw)';
    const result = parseMarkdown(md);
    const doc = result.doc as { content: { type: string; content?: { type: string; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] }[] }[] };
    const para = doc.content[0];
    expect(para.type).toBe('paragraph');
    const textNode = para.content?.[0];
    expect(textNode?.text).toBe('my drawing');
    expect(textNode?.marks?.[0]?.type).toBe('link');
    expect(textNode?.marks?.[0]?.attrs?.href).toBe('assets/drawing.excalidraw');
  });

  it('inline excalidraw link mixed with text stays inline', () => {
    const md = 'See [this diagram](drawing.excalidraw) for details.';
    const result = parseMarkdown(md);
    const doc = result.doc as { content: { type: string; content?: { type: string }[] }[] };
    expect(doc.content[0].type).toBe('paragraph');
    expect(doc.content[0].content?.length).toBeGreaterThan(1);
  });

  // ── HTML <img> tag parsing ──

  it('parses standard markdown image as block node', () => {
    const md = '![Alt text](photo.png)';
    const result = parseMarkdown(md);
    const doc = result.doc as { content: { type: string; attrs?: Record<string, unknown> }[] };
    const img = doc.content[0];
    expect(img.type).toBe('image');
    expect(img.attrs?.src).toBe('photo.png');
    expect(img.attrs?.alt).toBe('Alt text');
  });

  it('parses <img> HTML tag with width', () => {
    const md = '<img src="photo.png" alt="A photo" width="300" />';
    const result = parseMarkdown(md);
    const doc = result.doc as { content: { type: string; attrs?: Record<string, unknown> }[] };
    const img = doc.content[0];
    expect(img.type).toBe('image');
    expect(img.attrs?.src).toBe('photo.png');
    expect(img.attrs?.alt).toBe('A photo');
    expect(img.attrs?.width).toBe(300);
  });

  it('parses <img> HTML tag with data-align', () => {
    const md = '<img src="photo.png" data-align="center" />';
    const result = parseMarkdown(md);
    const doc = result.doc as { content: { type: string; attrs?: Record<string, unknown> }[] };
    const img = doc.content[0];
    expect(img.type).toBe('image');
    expect(img.attrs?.src).toBe('photo.png');
    expect(img.attrs?.['data-align']).toBe('center');
  });

  it('parses <img> HTML tag with width and data-align', () => {
    const md = '<img src="img.jpg" alt="Pic" width="200" data-align="right" />';
    const result = parseMarkdown(md);
    const doc = result.doc as { content: { type: string; attrs?: Record<string, unknown> }[] };
    const img = doc.content[0];
    expect(img.type).toBe('image');
    expect(img.attrs?.src).toBe('img.jpg');
    expect(img.attrs?.alt).toBe('Pic');
    expect(img.attrs?.width).toBe(200);
    expect(img.attrs?.['data-align']).toBe('right');
  });

  it('parses <img> tag without self-closing slash', () => {
    const md = '<img src="test.png" width="100">';
    const result = parseMarkdown(md);
    const doc = result.doc as { content: { type: string; attrs?: Record<string, unknown> }[] };
    const img = doc.content[0];
    expect(img.type).toBe('image');
    expect(img.attrs?.src).toBe('test.png');
    expect(img.attrs?.width).toBe(100);
  });
});
