/**
 * Web Worker entry point for background Markdown parsing.
 * Offloads heavy parse operations for large files to avoid
 * blocking the main thread.
 *
 * Usage from main thread:
 *   const worker = new Worker(new URL('./parse-worker.ts', import.meta.url), { type: 'module' });
 *   worker.postMessage({ type: 'parse', source: markdownString, id: requestId });
 *   worker.onmessage = (e) => { if (e.data.type === 'parsed') { ... } };
 */

import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';

interface ParseRequest {
  type: 'parse';
  source: string;
  id: string;
}

interface ParseResponse {
  type: 'parsed';
  id: string;
  doc: Record<string, unknown>;
  blockOrder: string[];
  sourceMapJson: {
    source: string;
    blocks: Array<[string, unknown]>;
    gaps: unknown[];
    preamble: string;
    postamble: string;
  };
  elapsed: number;
}

interface ParseError {
  type: 'error';
  id: string;
  message: string;
}

const ctx = self as unknown as Worker;

ctx.addEventListener('message', (event: MessageEvent<ParseRequest>) => {
  const { type, source, id } = event.data;

  if (type !== 'parse') return;

  const start = performance.now();

  try {
    resetBlockIdCounter();
    const result = parseMarkdown(source);
    const elapsed = performance.now() - start;

    // Serialize the Map for transfer (Maps can't be postMessage'd)
    const blocksArray = Array.from(result.sourceMap.blocks.entries());

    const response: ParseResponse = {
      type: 'parsed',
      id,
      doc: result.doc,
      blockOrder: result.blockOrder,
      sourceMapJson: {
        source: result.sourceMap.source,
        blocks: blocksArray,
        gaps: result.sourceMap.gaps,
        preamble: result.sourceMap.preamble,
        postamble: result.sourceMap.postamble,
      },
      elapsed,
    };

    ctx.postMessage(response);
  } catch (err) {
    const response: ParseError = {
      type: 'error',
      id,
      message: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(response);
  }
});
