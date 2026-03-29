import { describe, it, expect, beforeEach } from 'vitest';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';
import { serializeDocument } from '@kivi/markdown-serializer';
import { readFixture } from './helpers.js';

beforeEach(() => {
  resetBlockIdCounter();
});

describe('e2e: edge-cases', () => {
  const source = readFixture('edge-cases.md');

  it('round-trips without edits', () => {
    const result = parseMarkdown(source);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(source);
  });

  it('handles empty document', () => {
    const result = parseMarkdown('');
    const serialized = serializeDocument(result);
    // Empty doc should produce minimal output
    expect(serialized.trim()).toBe('');
  });

  it('handles document with only a heading', () => {
    const md = '# Just a heading';
    const result = parseMarkdown(md);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(md);
  });

  it('handles adjacent code blocks', () => {
    const md = '```js\nblock1();\n```\n\n```js\nblock2();\n```';
    const result = parseMarkdown(md);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(md);
  });

  it('preserves escaped markdown syntax', () => {
    const md = 'This is \\*not italic\\* and \\*\\*not bold\\*\\*.';
    const result = parseMarkdown(md);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(md);
  });

  it('preserves code blocks with empty lines', () => {
    const md = '```\nline 1\n\nline 3\n\nline 5\n```';
    const result = parseMarkdown(md);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(md);
  });

  it('handles single paragraph', () => {
    const md = 'Just a simple paragraph.';
    const result = parseMarkdown(md);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(md);
  });

  it('handles multiple blank lines between blocks', () => {
    const md = '# Title\n\n\n\n\nParagraph';
    const result = parseMarkdown(md);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(md);
  });
});
