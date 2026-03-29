import { unified } from 'unified';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import type { KiviDocument, StyleHints } from '@kivi/shared-types';
import type { SerializeOptions } from './types.js';
import { proseMirrorToMdast } from './prosemirror-to-mdast.js';

interface PMNodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNodeJSON[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/**
 * Serialize a KiviDocument back to Markdown.
 *
 * Uses block-level dirty tracking: clean blocks emit their original source
 * verbatim, dirty blocks are re-serialized via remark-stringify.
 */
export function serializeDocument(kiviDoc: KiviDocument, options?: SerializeOptions): string {
  const doc = kiviDoc.doc as unknown as PMNodeJSON;
  const { sourceMap, blockOrder } = kiviDoc;
  const topLevelNodes = doc.content || [];

  if (topLevelNodes.length === 0) {
    return options?.trailingNewline !== false ? '\n' : '';
  }

  const parts: string[] = [];

  parts.push(sourceMap.preamble);

  for (let i = 0; i < topLevelNodes.length; i++) {
    const blockId = blockOrder[i];
    const blockMeta = blockId ? sourceMap.blocks.get(blockId) : undefined;
    const node = topLevelNodes[i];

    if (blockMeta && !blockMeta.dirty && blockMeta.originalSource !== null) {
      parts.push(blockMeta.originalSource);
    } else {
      parts.push(serializeNode(node, blockMeta?.styleHints));
    }

    const gap = sourceMap.gaps.find((g) => g.afterBlockIndex === i);
    if (gap) {
      parts.push(gap.text);
    } else if (i < topLevelNodes.length - 1) {
      parts.push('\n\n');
    }
  }

  parts.push(sourceMap.postamble);

  return parts.join('');
}

/**
 * Serialize a single ProseMirror node to Markdown using remark-stringify.
 */
export function serializeNode(node: PMNodeJSON, styleHints?: StyleHints): string {
  const mdastRoot = proseMirrorToMdast({
    type: 'doc',
    content: [node],
  });

  return stringifyMdast(mdastRoot, styleHints);
}

function stringifyMdast(root: Root, styleHints?: StyleHints): string {
  const processor = unified().use(remarkStringify, {
    bullet: (styleHints?.listMarker as '-' | '*' | '+') || '-',
    emphasis: styleHints?.emphasisMarker || '*',
    strong: styleHints?.strongMarker === '__' ? '_' : '*',
    fence: styleHints?.codeFenceChar || '`',
    rule: '-',
    listItemIndent: 'one',
  }).use(remarkGfm);

  const result = processor.stringify(root);
  return result.trimEnd();
}
