import { describe, it, expect } from 'vitest';
import { looksLikeMarkdown } from '../../src/extensions/clipboard.js';

describe('looksLikeMarkdown', () => {
  it('returns false for plain text', () => {
    expect(looksLikeMarkdown('Hello world')).toBe(false);
  });

  it('returns true for single markdown pattern', () => {
    expect(looksLikeMarkdown('# Just a heading')).toBe(true);
  });

  it('returns true for heading + list', () => {
    expect(looksLikeMarkdown('# Title\n- item 1\n- item 2')).toBe(true);
  });

  it('returns true for bold + code', () => {
    expect(looksLikeMarkdown('This is **bold** with `code` inline')).toBe(true);
  });

  it('returns true for code block + heading', () => {
    expect(looksLikeMarkdown('# Title\n\n```\ncode\n```')).toBe(true);
  });

  it('returns true for link + italic', () => {
    expect(looksLikeMarkdown('Check *this* [link](https://example.com)')).toBe(true);
  });

  it('returns true for table + list', () => {
    expect(looksLikeMarkdown('| A | B |\n| --- | --- |\n- item')).toBe(true);
  });

  it('returns true for blockquote + ordered list', () => {
    expect(looksLikeMarkdown('> quote\n1. first\n2. second')).toBe(true);
  });

  it('returns true for task list + heading', () => {
    expect(looksLikeMarkdown('# Tasks\n[x] done\n[ ] pending')).toBe(true);
  });

  it('returns false for HTML-like content', () => {
    expect(looksLikeMarkdown('<div>Hello</div>')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(looksLikeMarkdown('')).toBe(false);
  });
});
