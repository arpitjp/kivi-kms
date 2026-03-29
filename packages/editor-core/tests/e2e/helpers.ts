import { readFileSync } from 'fs';
import { join, dirname } from 'path';

const fixturesDir = join(dirname(new URL(import.meta.url).pathname), 'fixtures');

export function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8');
}

/**
 * Split markdown into top-level blocks by double newlines.
 * This is a simplified splitter for test assertions —
 * the real block boundaries come from the parser.
 */
export function splitBlocks(md: string): string[] {
  return md.split(/\n\n+/).filter((b) => b.trim().length > 0);
}

/**
 * Get a specific block by index from a markdown string.
 */
export function getBlock(md: string, index: number): string {
  const blocks = splitBlocks(md);
  if (index < 0 || index >= blocks.length) {
    throw new Error(`Block index ${index} out of range (0..${blocks.length - 1})`);
  }
  return blocks[index];
}

/**
 * Assert that all blocks except the specified indices are byte-identical
 * between original and result markdown.
 */
export function assertUnchangedBlocks(
  original: string,
  result: string,
  changedIndices: number[],
): { identical: number; changed: number; total: number } {
  const origBlocks = splitBlocks(original);
  const resultBlocks = splitBlocks(result);

  let identical = 0;
  let changed = 0;

  const len = Math.min(origBlocks.length, resultBlocks.length);
  for (let i = 0; i < len; i++) {
    if (changedIndices.includes(i)) {
      changed++;
      continue;
    }
    if (origBlocks[i] === resultBlocks[i]) {
      identical++;
    }
  }

  return { identical, changed, total: origBlocks.length };
}

/**
 * Assert a function completes within a time budget.
 */
export function assertTimeBudget<T>(fn: () => T, maxMs: number): T {
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  if (elapsed > maxMs) {
    throw new Error(`Exceeded time budget: ${elapsed.toFixed(1)}ms > ${maxMs}ms`);
  }
  return result;
}

/**
 * Generate a large markdown document by repeating patterns.
 */
export function generateLargeDocument(targetLines: number): string {
  const blocks = [
    '# Section {n}\n\nThis is paragraph {n} with **bold** and *italic* content.\n',
    '## Subsection {n}\n\n- Item {n}a\n- Item {n}b\n- Item {n}c\n',
    '> Blockquote {n}: Some quoted text that spans a reasonable length.\n',
    '```javascript\nfunction fn{n}() {\n  return {n};\n}\n```\n',
    '| Col A | Col B |\n| --- | --- |\n| val {n}a | val {n}b |\n',
    '1. Ordered {n}a\n2. Ordered {n}b\n3. Ordered {n}c\n',
  ];

  const parts: string[] = [];
  let lineCount = 0;
  let blockIndex = 0;

  while (lineCount < targetLines) {
    const pattern = blocks[blockIndex % blocks.length];
    const block = pattern.replace(/\{n\}/g, String(blockIndex + 1));
    parts.push(block);
    lineCount += block.split('\n').length;
    blockIndex++;
  }

  return parts.join('\n');
}
