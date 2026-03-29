import { describe, it, expect, beforeEach } from 'vitest';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';
import { serializeDocument } from '@kivi/markdown-serializer';
import { readFixture } from './helpers.js';

beforeEach(() => {
  resetBlockIdCounter();
});

describe('e2e: style-preservation', () => {
  const source = readFixture('style-preservation.md');

  it('round-trips without edits', () => {
    const result = parseMarkdown(source);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(source);
  });

  it('preserves mixed list marker styles', () => {
    const result = parseMarkdown(source);

    // Find blocks with different list markers
    const blocks = Array.from(result.sourceMap.blocks.values());
    const listBlocks = blocks.filter((b) => b.styleHints.listMarker);

    const markers = listBlocks.map((b) => b.styleHints.listMarker);
    expect(markers).toContain('*');
    expect(markers).toContain('-');
    expect(markers).toContain('+');
  });

  it('preserves code fence styles', () => {
    const result = parseMarkdown(source);
    const blocks = Array.from(result.sourceMap.blocks.values());
    const codeBlocks = blocks.filter((b) => b.styleHints.codeFenceChar);

    const fenceChars = codeBlocks.map((b) => b.styleHints.codeFenceChar);
    expect(fenceChars).toContain('`');
    expect(fenceChars).toContain('~');
  });

  it('preserves heading style hints', () => {
    const result = parseMarkdown(source);
    const blocks = Array.from(result.sourceMap.blocks.values());
    const headingBlocks = blocks.filter((b) => b.styleHints.headingStyle);

    expect(headingBlocks.length).toBeGreaterThan(0);
    expect(headingBlocks.every((b) => b.styleHints.headingStyle === 'atx')).toBe(true);
  });

  it('preserves double blank line spacing', () => {
    const result = parseMarkdown(source);
    // The fixture has a double blank line between two paragraphs
    const hasDoubleGap = result.sourceMap.gaps.some((g) => g.text === '\n\n\n');
    expect(hasDoubleGap).toBe(true);
  });
});
