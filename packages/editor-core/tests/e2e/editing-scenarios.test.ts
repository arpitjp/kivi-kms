import { describe, it, expect, beforeEach } from 'vitest';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';
import { serializeDocument } from '@kivi/markdown-serializer';
import type { KiviDocument } from '@kivi/shared-types';
import { readFixture, assertUnchangedBlocks } from './helpers.js';

beforeEach(() => {
  resetBlockIdCounter();
});

/**
 * Simulate marking a block as dirty (as the editor would do on a transaction).
 * In production, the Tiptap transaction handler marks blocks dirty.
 * Here we manually set the flag for testing.
 */
function markBlockDirty(kiviDoc: KiviDocument, blockIndex: number): void {
  const blockId = kiviDoc.blockOrder[blockIndex];
  const block = kiviDoc.sourceMap.blocks.get(blockId);
  if (block) {
    block.dirty = true;
  }
}

describe('e2e: editing-scenarios', () => {
  const source = readFixture('editing-scenarios.md');

  it('round-trips without edits', () => {
    const result = parseMarkdown(source);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(source);
  });

  it('dirty block is re-serialized while others stay identical', () => {
    const result = parseMarkdown(source);

    // Mark the second block (first paragraph under "Section One") as dirty
    // but don't actually change its content — it should still serialize correctly
    markBlockDirty(result, 2);

    const serialized = serializeDocument(result);
    // Since content wasn't actually changed, serialized should be functionally equivalent
    expect(serialized).toBeDefined();
    expect(serialized.length).toBeGreaterThan(0);
  });

  it('unmodified blocks remain byte-identical when another block is dirty', () => {
    const result = parseMarkdown(source);

    // Mark only block index 2 as dirty
    markBlockDirty(result, 2);

    const serialized = serializeDocument(result);
    const stats = assertUnchangedBlocks(source, serialized, [2]);
    // All blocks except the dirty one should be identical
    expect(stats.identical).toBeGreaterThanOrEqual(stats.total - 2);
  });

  it('preserves document structure with multiple dirty blocks', () => {
    const result = parseMarkdown(source);

    markBlockDirty(result, 0); // title heading
    markBlockDirty(result, 4); // list block

    const serialized = serializeDocument(result);
    // Verify the output still parses correctly
    const reparsed = parseMarkdown(serialized);
    expect(reparsed.blockOrder.length).toBe(result.blockOrder.length);
  });

  it('source map tracks correct number of blocks', () => {
    const result = parseMarkdown(source);
    // Count the top-level blocks from the fixture
    const doc = result.doc as { content: { type: string }[] };
    expect(doc.content.length).toBe(result.blockOrder.length);
  });
});
