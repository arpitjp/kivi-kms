import { describe, it, expect, beforeEach } from 'vitest';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';
import { serializeDocument } from '@kivi/markdown-serializer';
import { readFixture } from './helpers.js';

beforeEach(() => {
  resetBlockIdCounter();
});

describe('e2e: kitchen-sink', () => {
  const source = readFixture('kitchen-sink.md');

  it('parses without errors', () => {
    const result = parseMarkdown(source);
    expect(result.doc).toBeDefined();
    expect(result.blockOrder.length).toBeGreaterThan(0);
    expect(result.sourceMap.blocks.size).toBe(result.blockOrder.length);
  });

  it('produces expected node types', () => {
    const result = parseMarkdown(source);
    const doc = result.doc as { content: { type: string }[] };
    const types = doc.content.map((n) => n.type);

    expect(types).toContain('heading');
    expect(types).toContain('paragraph');
    expect(types).toContain('bulletList');
    expect(types).toContain('orderedList');
    expect(types).toContain('taskList');
    expect(types).toContain('blockquote');
    expect(types).toContain('codeBlock');
    expect(types).toContain('table');
    expect(types).toContain('horizontalRule');
  });

  it('round-trips without edits', () => {
    const result = parseMarkdown(source);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(source);
  });

  it('preserves all source map blocks', () => {
    const result = parseMarkdown(source);
    for (const blockId of result.blockOrder) {
      const block = result.sourceMap.blocks.get(blockId)!;
      expect(block.originalSource).not.toBeNull();
      expect(block.dirty).toBe(false);
    }
  });

  it('preserves inter-block gaps', () => {
    const result = parseMarkdown(source);
    expect(result.sourceMap.gaps.length).toBeGreaterThan(0);
    for (const gap of result.sourceMap.gaps) {
      expect(gap.text).toMatch(/^\n+$/);
    }
  });
});
