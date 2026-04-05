import { describe, it, expect } from 'vitest';
import { looksLikeMarkdown, looksLikeFilePath } from '../../src/extensions/clipboard.js';

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

describe('looksLikeFilePath', () => {
  it('detects absolute Unix paths', () => {
    expect(looksLikeFilePath('/Users/foo/bar.png')).toBe(true);
    expect(looksLikeFilePath('/tmp/file.txt')).toBe(true);
  });

  it('detects Windows absolute paths', () => {
    expect(looksLikeFilePath('C:\\Users\\foo.txt')).toBe(true);
    expect(looksLikeFilePath('D:\\projects\\readme.md')).toBe(true);
  });

  it('detects relative paths with ./', () => {
    expect(looksLikeFilePath('./assets/image.jpg')).toBe(true);
  });

  it('detects relative paths with ../', () => {
    expect(looksLikeFilePath('../docs/file.md')).toBe(true);
  });

  it('detects home-relative paths', () => {
    expect(looksLikeFilePath('~/docs/file.md')).toBe(true);
    expect(looksLikeFilePath('~/image.png')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(looksLikeFilePath('Hello world')).toBe(false);
  });

  it('returns false for URLs', () => {
    expect(looksLikeFilePath('https://example.com/file.txt')).toBe(false);
    expect(looksLikeFilePath('http://localhost:3000/api')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(looksLikeFilePath('')).toBe(false);
  });

  it('returns false for strings over 500 chars', () => {
    expect(looksLikeFilePath('/' + 'a'.repeat(500) + '.txt')).toBe(false);
  });

  it('returns false for paths without file extension', () => {
    expect(looksLikeFilePath('/Users/foo/bar')).toBe(false);
    expect(looksLikeFilePath('./src/utils')).toBe(false);
  });

  it('handles whitespace-trimmed paths', () => {
    expect(looksLikeFilePath('  /Users/foo/bar.png  ')).toBe(true);
  });

  it('detects excalidraw files', () => {
    expect(looksLikeFilePath('/workspace/drawings/diagram.excalidraw')).toBe(true);
  });

  it('detects various media extensions', () => {
    expect(looksLikeFilePath('/assets/video.mp4')).toBe(true);
    expect(looksLikeFilePath('/assets/audio.mp3')).toBe(true);
    expect(looksLikeFilePath('./code/main.cpp')).toBe(true);
  });

  it('detects bare relative paths (VS Code "Copy Relative Path")', () => {
    expect(looksLikeFilePath('docs/networking/readme.md')).toBe(true);
    expect(looksLikeFilePath('src/components/Button.tsx')).toBe(true);
    expect(looksLikeFilePath('assets/image.png')).toBe(true);
  });

  it('returns false for bare relative without slash', () => {
    expect(looksLikeFilePath('readme.md')).toBe(false);
  });

  it('returns false for sentences with slashes', () => {
    expect(looksLikeFilePath('yes/no maybe')).toBe(false);
  });
});
