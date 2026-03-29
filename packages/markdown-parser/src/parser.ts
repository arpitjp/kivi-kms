import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import type { Root } from 'mdast';
import type { KiviDocument, BlockMeta, BlockGap, SourceMap, SourcePosition } from '@kivi/shared-types';
import type { ParseOptions } from './types.js';
import { mdastToProseMirror } from './mdast-to-prosemirror.js';
import { extractStyleHints } from './style-extractor.js';

let blockIdCounter = 0;
function nextBlockId(): string {
  return `block-${++blockIdCounter}`;
}

/** Reset counter (useful for deterministic tests) */
export function resetBlockIdCounter(): void {
  blockIdCounter = 0;
}

/**
 * Parse a Markdown string into a KiviDocument.
 *
 * Returns a ProseMirror-compatible document JSON plus all the
 * source map metadata needed for lossless round-trip serialization.
 */
export function parseMarkdown(source: string, options?: ParseOptions): KiviDocument {
  const opts: Required<ParseOptions> = {
    gfm: options?.gfm ?? true,
    frontmatter: options?.frontmatter ?? true,
    math: options?.math ?? true,
  };

  const processor = buildProcessor(opts);
  const mdast = processor.parse(source) as Root;

  const doc = mdastToProseMirror(mdast);

  const { blocks, gaps, preamble, postamble, blockOrder } = buildSourceMap(
    source,
    mdast,
  );

  const sourceMap: SourceMap = {
    source,
    blocks,
    gaps,
    preamble,
    postamble,
  };

  return {
    doc: doc as unknown as Record<string, unknown>,
    sourceMap,
    blockOrder,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildProcessor(opts: Required<ParseOptions>): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processor: any = unified().use(remarkParse);

  if (opts.gfm) {
    processor = processor.use(remarkGfm);
  }
  if (opts.frontmatter) {
    processor = processor.use(remarkFrontmatter, ['yaml', 'toml']);
  }
  if (opts.math) {
    processor = processor.use(remarkMath);
  }

  return processor;
}

function toSourcePosition(pos: Root['children'][number]['position']): SourcePosition | null {
  if (!pos) return null;
  return {
    start: {
      line: pos.start.line,
      column: pos.start.column,
      offset: pos.start.offset ?? 0,
    },
    end: {
      line: pos.end.line,
      column: pos.end.column,
      offset: pos.end.offset ?? 0,
    },
  };
}

function buildSourceMap(
  source: string,
  mdast: Root,
): {
  blocks: Map<string, BlockMeta>;
  gaps: BlockGap[];
  preamble: string;
  postamble: string;
  blockOrder: string[];
} {
  const blocks = new Map<string, BlockMeta>();
  const gaps: BlockGap[] = [];
  const blockOrder: string[] = [];

  const topLevelChildren = mdast.children;

  if (topLevelChildren.length === 0) {
    return {
      blocks,
      gaps,
      preamble: source,
      postamble: '',
      blockOrder,
    };
  }

  const firstChild = topLevelChildren[0];
  const preamble = firstChild.position
    ? source.slice(0, firstChild.position.start.offset ?? 0)
    : '';

  const lastChild = topLevelChildren[topLevelChildren.length - 1];
  const postamble = lastChild.position
    ? source.slice(lastChild.position.end.offset ?? source.length)
    : '';

  for (let i = 0; i < topLevelChildren.length; i++) {
    const child = topLevelChildren[i];
    const id = nextBlockId();
    blockOrder.push(id);

    const startOffset = child.position?.start.offset ?? 0;
    const endOffset = child.position?.end.offset ?? 0;

    const originalSource = child.position
      ? source.slice(startOffset, endOffset)
      : null;

    const sourcePosition = toSourcePosition(child.position);
    const styleHints = extractStyleHints(child, source);

    blocks.set(id, {
      id,
      sourcePosition,
      originalSource,
      dirty: false,
      styleHints,
    });

    if (i < topLevelChildren.length - 1) {
      const nextChild = topLevelChildren[i + 1];
      if (child.position && nextChild.position) {
        const gapText = source.slice(
          child.position.end.offset ?? 0,
          nextChild.position.start.offset ?? 0,
        );
        gaps.push({
          afterBlockIndex: i,
          text: gapText,
        });
      }
    }
  }

  return { blocks, gaps, preamble, postamble, blockOrder };
}
