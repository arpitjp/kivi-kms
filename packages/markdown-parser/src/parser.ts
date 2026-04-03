import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import wikiLinkPlugin from 'remark-wiki-link';
import type { Root, RootContent, Paragraph, Text, InlineCode, Code } from 'mdast';
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
    wikiLinks: options?.wikiLinks ?? true,
  };

  const processor = buildProcessor(opts);
  const mdast = processor.parse(source) as Root;
  fixIndentedFences(mdast, source);

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
const processorCache = new Map<string, any>();

function optsCacheKey(opts: Required<ParseOptions>): string {
  return `${+opts.gfm}${+opts.frontmatter}${+opts.math}${+opts.wikiLinks}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildProcessor(opts: Required<ParseOptions>): any {
  const key = optsCacheKey(opts);
  const cached = processorCache.get(key);
  if (cached) return cached;

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
  if (opts.wikiLinks) {
    processor = processor.use(wikiLinkPlugin, {
      aliasDivider: '|',
      pageResolver: (name: string) => [name],
      hrefTemplate: (permalink: string) => permalink,
    });
  }

  processorCache.set(key, processor);
  return processor;
}

/**
 * Fix paragraphs where 4+-space-indented fenced code blocks were misinterpreted
 * as inline code within a paragraph. This happens because CommonMark treats
 * 4+ space indentation as paragraph continuation, causing ``` to become inline code.
 *
 * Also fixes indented code blocks that contain literal ``` markers by stripping them.
 *
 * We detect these patterns in the AST and split paragraphs / clean code blocks.
 */
function fixIndentedFences(root: Root, _source: string): void {
  for (let i = root.children.length - 1; i >= 0; i--) {
    const node = root.children[i];

    // Fix indented code blocks whose content starts/ends with literal ``` markers
    if (node.type === 'code') {
      const code = node as Code;
      const lines = code.value.split('\n');
      const FENCE = /^`{3,}\s*(\S*)?\s*$/;
      if (lines.length >= 2 && FENCE.test(lines[0]) && FENCE.test(lines[lines.length - 1])) {
        const langMatch = lines[0].match(FENCE);
        const lang = langMatch?.[1] || undefined;
        const innerLines = lines.slice(1, -1);
        code.value = innerLines.join('\n');
        if (lang) code.lang = lang;
      }
      continue;
    }

    if (node.type !== 'paragraph') continue;

    const para = node as Paragraph;
    const result = splitParagraphAtInlineCode(para);
    if (result) {
      root.children.splice(i, 1, ...result);
    }
  }
}

function splitParagraphAtInlineCode(para: Paragraph): RootContent[] | null {
  const children = para.children;

  let fenceIdx = -1;
  for (let j = 0; j < children.length; j++) {
    const child = children[j];
    if (child.type !== 'inlineCode') continue;

    // Only treat as a misinterpreted fenced code block if the inline code
    // contains newlines (multiline content). Simple inline code like `foo`
    // should remain inline.
    const ic = child as InlineCode;
    if (!ic.value.includes('\n')) continue;

    const prevText = j > 0 && children[j - 1].type === 'text'
      ? (children[j - 1] as Text).value : '';
    if (prevText.endsWith('\n') || prevText.trimEnd() === '' || j === 0) {
      fenceIdx = j;
      break;
    }
  }

  if (fenceIdx < 0) return null;

  const inlineCode = children[fenceIdx] as InlineCode;
  const codeValue = inlineCode.value.replace(/^\s*\n?/, '').replace(/\n?\s*$/, '');

  const beforeChildren = children.slice(0, fenceIdx);
  const lastBefore = beforeChildren.length > 0 ? beforeChildren[beforeChildren.length - 1] : null;
  if (lastBefore?.type === 'text') {
    const t = lastBefore as Text;
    t.value = t.value.replace(/\n\s*$/, '');
    if (!t.value) beforeChildren.pop();
  }

  const afterChildren = children.slice(fenceIdx + 1);
  const firstAfter = afterChildren.length > 0 ? afterChildren[0] : null;
  if (firstAfter?.type === 'text') {
    const t = firstAfter as Text;
    t.value = t.value.replace(/^\s*\n/, '');
    if (!t.value) afterChildren.shift();
  }

  const codeLines = codeValue.split('\n');
  const dedented = codeLines.map(line => line.replace(/^ {1,4}/, '')).join('\n');

  const codeNode: Code = {
    type: 'code',
    value: dedented,
    lang: null as unknown as undefined,
  };

  const newNodes: RootContent[] = [];

  if (beforeChildren.length > 0) {
    newNodes.push({ ...para, children: beforeChildren as Paragraph['children'] });
  }
  newNodes.push(codeNode);

  if (afterChildren.length > 0) {
    const tailPara: Paragraph = { type: 'paragraph', children: afterChildren as Paragraph['children'] };
    const tailResult = splitParagraphAtInlineCode(tailPara);
    if (tailResult) {
      newNodes.push(...tailResult);
    } else {
      newNodes.push(tailPara);
    }
  }

  return newNodes;
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
