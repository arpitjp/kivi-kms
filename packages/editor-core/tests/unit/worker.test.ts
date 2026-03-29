import { describe, it, expect } from 'vitest';
import { parseMarkdownAsync, terminateParseWorker } from '../../src/worker/index.js';

describe('parseMarkdownAsync', () => {
  it('parses small files synchronously', async () => {
    const source = '# Hello\n\nA paragraph.\n';
    const result = await parseMarkdownAsync(source);

    expect(result.doc).toBeDefined();
    expect(result.blockOrder.length).toBeGreaterThan(0);
    expect(result.sourceMap.blocks.size).toBe(result.blockOrder.length);
  });

  it('returns correct block structure for basic markdown', async () => {
    const source = '# Title\n\n- item 1\n- item 2\n\nParagraph.\n';
    const result = await parseMarkdownAsync(source);

    const doc = result.doc as { content: { type: string }[] };
    const types = doc.content.map((n) => n.type);

    expect(types).toContain('heading');
    expect(types).toContain('bulletList');
    expect(types).toContain('paragraph');
  });

  it('round-trips through async parse', async () => {
    const { serializeDocument } = await import('@kivi/markdown-serializer');
    const source = '# Hello\n\nWorld.\n';
    const result = await parseMarkdownAsync(source);
    const serialized = serializeDocument(result);
    expect(serialized).toBe(source);
  });

  it('handles empty string', async () => {
    const result = await parseMarkdownAsync('');
    expect(result.doc).toBeDefined();
    expect(result.blockOrder.length).toBe(0);
  });

  it('terminateParseWorker does not throw', () => {
    expect(() => terminateParseWorker()).not.toThrow();
  });
});
