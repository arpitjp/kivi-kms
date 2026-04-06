import { describe, it, expect } from 'vitest';
import { computeMinimalDiff } from '@kivi/shared-types';

describe('incremental diff', () => {
  it('detects insertion at end', () => {
    const diff = computeMinimalDiff('Hello', 'Hello World');
    expect(diff.start).toBe(5);
    expect(diff.replacement).toBe(' World');
  });

  it('detects insertion at beginning', () => {
    const diff = computeMinimalDiff('World', 'Hello World');
    expect(diff.start).toBe(0);
    expect(diff.replacement).toBe('Hello ');
  });

  it('detects deletion', () => {
    const diff = computeMinimalDiff('Hello World', 'Hello');
    expect(diff.start).toBe(5);
    expect(diff.oldEnd).toBe(11);
    expect(diff.replacement).toBe('');
  });

  it('detects replacement in middle', () => {
    const diff = computeMinimalDiff('Hello World', 'Hello Earth');
    expect(diff.start).toBe(6);
    expect(diff.replacement).toBe('Earth');
  });

  it('handles identical strings', () => {
    const diff = computeMinimalDiff('Same', 'Same');
    expect(diff.start).toBe(4);
    expect(diff.oldEnd).toBe(4);
    expect(diff.replacement).toBe('');
  });

  it('handles complete replacement', () => {
    const diff = computeMinimalDiff('abc', 'xyz');
    expect(diff.start).toBe(0);
    expect(diff.replacement).toBe('xyz');
  });

  it('handles empty old text', () => {
    const diff = computeMinimalDiff('', 'Hello');
    expect(diff.start).toBe(0);
    expect(diff.replacement).toBe('Hello');
  });

  it('handles empty new text', () => {
    const diff = computeMinimalDiff('Hello', '');
    expect(diff.start).toBe(0);
    expect(diff.oldEnd).toBe(5);
    expect(diff.replacement).toBe('');
  });

  it('handles multiline changes', () => {
    const old = '# Title\n\nParagraph 1\n\nParagraph 2\n';
    const updated = '# Title\n\nParagraph 1\n\nModified paragraph\n';
    const diff = computeMinimalDiff(old, updated);
    expect(diff.replacement).toBe('Modified paragraph');
  });

  it('correctly applies diff to reconstruct new text', () => {
    const old = 'Hello beautiful World!';
    const updated = 'Hello amazing World!';
    const diff = computeMinimalDiff(old, updated);
    const result = old.slice(0, diff.start) + diff.replacement + old.slice(diff.oldEnd);
    expect(result).toBe(updated);
  });
});
