import { describe, it, expect } from 'vitest';
import { highlightMarkdown, highlightInline } from '../../src/webview/highlight-markdown.js';

describe('highlightMarkdown', () => {
  it('highlights headings with marker and content spans', () => {
    const result = highlightMarkdown('# Hello');
    expect(result).toContain('class="md-heading-marker"');
    expect(result).toContain('class="md-heading"');
    expect(result).toContain('Hello');
  });

  it('handles all heading levels (h1-h6)', () => {
    for (let level = 1; level <= 6; level++) {
      const prefix = '#'.repeat(level);
      const result = highlightMarkdown(`${prefix} Title`);
      expect(result).toContain('md-heading-marker');
      expect(result).toContain('Title');
    }
  });

  it('does not treat 7 hashes as a heading', () => {
    const result = highlightMarkdown('####### Not a heading');
    expect(result).not.toContain('md-heading-marker');
  });

  it('highlights code block fences and content', () => {
    const md = '```js\nconst x = 1;\n```';
    const result = highlightMarkdown(md);
    expect(result).toContain('md-code-fence');
    expect(result).toContain('md-code-content');
  });

  it('highlights frontmatter between --- delimiters', () => {
    const md = '---\ntitle: Test\n---\n# Hello';
    const result = highlightMarkdown(md);
    expect(result).toContain('md-frontmatter');
    expect(result).toContain('md-heading');
  });

  it('highlights unordered list markers', () => {
    const result = highlightMarkdown('- item one\n* item two\n+ item three');
    const markers = result.match(/md-list-marker/g);
    expect(markers).toHaveLength(3);
  });

  it('highlights ordered list markers', () => {
    const result = highlightMarkdown('1. first\n2. second');
    const markers = result.match(/md-list-marker/g);
    expect(markers).toHaveLength(2);
  });

  it('highlights task list items', () => {
    const result = highlightMarkdown('- [ ] todo\n- [x] done');
    expect(result).toContain('md-task-marker');
    expect(result).toContain('md-list-marker');
  });

  it('highlights blockquotes', () => {
    const result = highlightMarkdown('> quoted text');
    expect(result).toContain('md-blockquote-marker');
    expect(result).toContain('md-blockquote');
  });

  it('highlights horizontal rules', () => {
    // `---` alone on the first line is treated as frontmatter, not HR.
    // Prefix with another line so it's not misidentified.
    for (const hr of ['---', '***', '___', '- - -']) {
      const result = highlightMarkdown(`text\n${hr}`);
      expect(result).toContain('md-hr');
    }
  });

  it('treats --- on first line as frontmatter start, not HR', () => {
    const result = highlightMarkdown('---');
    expect(result).toContain('md-frontmatter');
    expect(result).not.toContain('md-hr');
  });

  it('preserves line count (one output line per input line)', () => {
    const input = 'line1\nline2\nline3\n\nline5';
    const result = highlightMarkdown(input);
    expect(result.split('\n')).toHaveLength(input.split('\n').length);
  });

  it('escapes HTML entities in content', () => {
    const result = highlightMarkdown('# <script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('handles empty input', () => {
    expect(highlightMarkdown('')).toBe('');
  });

  it('handles single empty line', () => {
    expect(highlightMarkdown('\n')).toBe('\n');
  });
});

describe('highlightInline', () => {
  it('highlights inline code', () => {
    const result = highlightInline('some `code` here');
    expect(result).toContain('md-inline-code');
    expect(result).toContain('`code`');
  });

  it('highlights bold with ** and __', () => {
    expect(highlightInline('**bold**')).toContain('md-bold');
    expect(highlightInline('__bold__')).toContain('md-bold');
  });

  it('highlights italic with * and _', () => {
    expect(highlightInline('*italic*')).toContain('md-italic');
    expect(highlightInline('_italic_')).toContain('md-italic');
  });

  it('highlights strikethrough', () => {
    expect(highlightInline('~~struck~~')).toContain('md-strike');
  });

  it('highlights wiki links', () => {
    expect(highlightInline('see [[page]]')).toContain('md-wiki-link');
  });

  it('highlights markdown links', () => {
    expect(highlightInline('[text](url)')).toContain('md-link');
  });

  it('highlights images', () => {
    expect(highlightInline('![alt](img.png)')).toContain('md-image');
  });

  it('highlights tags', () => {
    expect(highlightInline('#tag-name')).toContain('md-tag');
  });

  it('highlights URLs', () => {
    expect(highlightInline('visit https://example.com now')).toContain('md-url');
  });

  it('escapes HTML while preserving token highlighting', () => {
    const result = highlightInline('`<div>`');
    expect(result).toContain('md-inline-code');
    expect(result).not.toContain('<div>');
    expect(result).toContain('&lt;div&gt;');
  });

  it('handles plain text without any tokens', () => {
    const result = highlightInline('just plain text');
    expect(result).toBe('just plain text');
  });

  it('handles multiple tokens in one line', () => {
    const result = highlightInline('**bold** and `code` and *italic*');
    expect(result).toContain('md-bold');
    expect(result).toContain('md-inline-code');
    expect(result).toContain('md-italic');
  });
});
