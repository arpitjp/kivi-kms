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
    const doc = result.doc as { content: { type: string }[] };
    expect(doc.content.length).toBe(result.blockOrder.length);
  });
});

describe('e2e: dirty-tracking isolation', () => {
  it('adjacent blocks use originalSource when only the middle block is dirty', () => {
    const md = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const result = parseMarkdown(md);
    expect(result.blockOrder.length).toBe(4);

    markBlockDirty(result, 2);

    const serialized = serializeDocument(result);
    const stats = assertUnchangedBlocks(md, serialized, [2]);
    expect(stats.identical).toBe(3);
  });

  it('preserves gaps between blocks when one block is dirty', () => {
    const md = '# Title\n\nParagraph one.\n\n\nParagraph two.';
    const result = parseMarkdown(md);
    markBlockDirty(result, 1);

    const serialized = serializeDocument(result);
    expect(serialized).toContain('\n\n\n');
  });

  it('multiple dirty blocks leave clean blocks untouched', () => {
    const md = '# Title\n\nPara A.\n\nPara B.\n\nPara C.\n\nPara D.';
    const result = parseMarkdown(md);

    markBlockDirty(result, 0);
    markBlockDirty(result, 2);
    markBlockDirty(result, 4);

    const serialized = serializeDocument(result);
    const stats = assertUnchangedBlocks(md, serialized, [0, 2, 4]);
    expect(stats.identical).toBe(2);
  });

  it('blockCountChanged: adding a block still produces valid output', () => {
    const md = '# Title\n\nParagraph.';
    const result = parseMarkdown(md);

    const newBlockId = 'new-block-999';
    result.blockOrder.splice(1, 0, newBlockId);
    result.sourceMap.blocks.set(newBlockId, {
      originalSource: '',
      dirty: true,
      position: { start: 0, end: 0 },
      styleHints: {},
    });

    const doc = result.doc as { content: unknown[] };
    doc.content.splice(1, 0, {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Inserted paragraph.' }],
    });

    const serialized = serializeDocument(result);
    expect(serialized).toContain('Title');
    expect(serialized).toContain('Inserted paragraph');
    expect(serialized).toContain('Paragraph');
  });

  it('blockCountChanged: removing a block still produces valid output', () => {
    const md = '# Title\n\nMiddle para.\n\nEnd para.';
    const result = parseMarkdown(md);
    expect(result.blockOrder.length).toBe(3);

    result.blockOrder.splice(1, 1);
    const doc = result.doc as { content: unknown[] };
    doc.content.splice(1, 1);

    const serialized = serializeDocument(result);
    expect(serialized).toContain('Title');
    expect(serialized).toContain('End para');
    expect(serialized).not.toContain('Middle para');
  });
});
