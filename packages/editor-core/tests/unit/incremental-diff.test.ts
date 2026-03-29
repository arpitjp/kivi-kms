import { describe, it, expect } from 'vitest';

/**
 * Tests for the incremental diff algorithm used by the VS Code
 * extension to send targeted edits instead of full document replacement.
 * This mirrors the logic in editor-provider.ts.
 */
function computeDiff(oldText: string, newText: string): { start: number; oldEnd: number; newEnd: number; replacement: string } {
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
    start++;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  return {
    start,
    oldEnd,
    newEnd,
    replacement: newText.slice(start, newEnd),
  };
}

describe('incremental diff', () => {
  it('detects insertion at end', () => {
    const diff = computeDiff('Hello', 'Hello World');
    expect(diff.start).toBe(5);
    expect(diff.replacement).toBe(' World');
  });

  it('detects insertion at beginning', () => {
    const diff = computeDiff('World', 'Hello World');
    expect(diff.start).toBe(0);
    expect(diff.replacement).toBe('Hello ');
  });

  it('detects deletion', () => {
    const diff = computeDiff('Hello World', 'Hello');
    expect(diff.start).toBe(5);
    expect(diff.oldEnd).toBe(11);
    expect(diff.replacement).toBe('');
  });

  it('detects replacement in middle', () => {
    const diff = computeDiff('Hello World', 'Hello Earth');
    expect(diff.start).toBe(6);
    expect(diff.replacement).toBe('Earth');
  });

  it('handles identical strings', () => {
    const diff = computeDiff('Same', 'Same');
    expect(diff.start).toBe(4);
    expect(diff.oldEnd).toBe(4);
    expect(diff.replacement).toBe('');
  });

  it('handles complete replacement', () => {
    const diff = computeDiff('abc', 'xyz');
    expect(diff.start).toBe(0);
    expect(diff.replacement).toBe('xyz');
  });

  it('handles empty old text', () => {
    const diff = computeDiff('', 'Hello');
    expect(diff.start).toBe(0);
    expect(diff.replacement).toBe('Hello');
  });

  it('handles empty new text', () => {
    const diff = computeDiff('Hello', '');
    expect(diff.start).toBe(0);
    expect(diff.oldEnd).toBe(5);
    expect(diff.replacement).toBe('');
  });

  it('handles multiline changes', () => {
    const old = '# Title\n\nParagraph 1\n\nParagraph 2\n';
    const updated = '# Title\n\nParagraph 1\n\nModified paragraph\n';
    const diff = computeDiff(old, updated);
    expect(diff.replacement).toBe('Modified paragraph');
  });

  it('correctly applies diff to reconstruct new text', () => {
    const old = 'Hello beautiful World!';
    const updated = 'Hello amazing World!';
    const diff = computeDiff(old, updated);
    const result = old.slice(0, diff.start) + diff.replacement + old.slice(diff.oldEnd);
    expect(result).toBe(updated);
  });
});
