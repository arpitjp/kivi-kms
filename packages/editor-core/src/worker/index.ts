import type { KiviDocument, SourceMap, BlockMeta, BlockGap } from '@kivi/shared-types';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';

const LARGE_FILE_THRESHOLD = 100 * 1024; // 100KB
let workerInstance: Worker | null = null;
let requestId = 0;

interface PendingRequest {
  resolve: (doc: KiviDocument) => void;
  reject: (err: Error) => void;
}

const pendingRequests = new Map<string, PendingRequest>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;

  if (!workerInstance) {
    try {
      workerInstance = new Worker(
        new URL('./parse-worker.ts', import.meta.url),
        { type: 'module' },
      );
      workerInstance.addEventListener('message', handleWorkerMessage);
      workerInstance.addEventListener('error', (err) => {
        for (const [, req] of pendingRequests) {
          req.reject(new Error(`Worker error: ${err.message}`));
        }
        pendingRequests.clear();
      });
    } catch {
      return null;
    }
  }

  return workerInstance;
}

function handleWorkerMessage(event: MessageEvent) {
  const data = event.data;
  const pending = pendingRequests.get(data.id);
  if (!pending) return;

  pendingRequests.delete(data.id);

  if (data.type === 'error') {
    pending.reject(new Error(data.message));
    return;
  }

  if (data.type === 'parsed') {
    const blocks = new Map<string, BlockMeta>(data.sourceMapJson.blocks);

    const sourceMap: SourceMap = {
      source: data.sourceMapJson.source,
      blocks,
      gaps: data.sourceMapJson.gaps as BlockGap[],
      preamble: data.sourceMapJson.preamble,
      postamble: data.sourceMapJson.postamble,
    };

    const kiviDoc: KiviDocument = {
      doc: data.doc,
      sourceMap,
      blockOrder: data.blockOrder,
    };

    pending.resolve(kiviDoc);
  }
}

/**
 * Parse markdown in a Web Worker if the source is large enough.
 * Falls back to synchronous parsing for small files or when Workers
 * are not available.
 */
export function parseMarkdownAsync(source: string): Promise<KiviDocument> {
  if (source.length < LARGE_FILE_THRESHOLD) {
    resetBlockIdCounter();
    return Promise.resolve(parseMarkdown(source));
  }

  const worker = getWorker();
  if (!worker) {
    resetBlockIdCounter();
    return Promise.resolve(parseMarkdown(source));
  }

  const id = `parse-${++requestId}`;

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage({ type: 'parse', source, id });
  });
}

/**
 * Terminate the worker if it exists.
 */
export function terminateParseWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
    pendingRequests.clear();
  }
}
