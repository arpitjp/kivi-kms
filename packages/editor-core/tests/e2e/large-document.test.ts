import { describe, it, expect, beforeEach } from 'vitest';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';
import { serializeDocument } from '@kivi/markdown-serializer';
import { generateLargeDocument, assertTimeBudget } from './helpers.js';

beforeEach(() => {
  resetBlockIdCounter();
});

describe('e2e: large-document', () => {
  const source = generateLargeDocument(1000);

  it('parses large document within time budget', () => {
    assertTimeBudget(() => {
      parseMarkdown(source);
    }, 2000);
  });

  it('serializes large document within time budget', () => {
    const result = parseMarkdown(source);
    assertTimeBudget(() => {
      serializeDocument(result);
    }, 1000);
  });

  it('round-trips large document', () => {
    const result = parseMarkdown(source);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(source);
  });

  it('large document has many blocks', () => {
    const result = parseMarkdown(source);
    expect(result.blockOrder.length).toBeGreaterThan(50);
  });

  it('parse + serialize round-trip within 3 second budget', () => {
    assertTimeBudget(() => {
      const result = parseMarkdown(source);
      serializeDocument(result);
    }, 3000);
  });
});
