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

  // If block count changed (user added/removed blocks), the 1:1
  // mapping between blockOrder and topLevelNodes is broken.
  // Fall back to full re-serialization to avoid duplicated/missing content.
  const blockCountChanged = topLevelNodes.length !== blockOrder.length;

  const parts: string[] = [];

  if (!blockCountChanged) {
    parts.push(sourceMap.preamble);
  }

  for (let i = 0; i < topLevelNodes.length; i++) {
    const blockId = !blockCountChanged ? blockOrder[i] : undefined;
    const blockMeta = blockId ? sourceMap.blocks.get(blockId) : undefined;
    const node = topLevelNodes[i];

    if (!blockCountChanged && blockMeta && !blockMeta.dirty && blockMeta.originalSource !== null) {
      parts.push(blockMeta.originalSource);
    } else {
      parts.push(serializeNode(node, blockMeta?.styleHints));
    }

    if (!blockCountChanged) {
      const gap = sourceMap.gaps.find((g) => g.afterBlockIndex === i);
      if (gap) {
        parts.push(gap.text);
      } else if (i < topLevelNodes.length - 1) {
        parts.push('\n\n');
      }
    } else if (i < topLevelNodes.length - 1) {
      parts.push('\n\n');
    }
  }

  if (!blockCountChanged) {
    parts.push(sourceMap.postamble);
  } else {
    parts.push('\n');
  }

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wikiLinkHandler = (node: any) => {
    const target = node.value || '';
    const alias = node.data?.alias;
    if (alias && alias !== target) {
      return `[[${target}|${alias}]]`;
    }
    return `[[${target}]]`;
  };

  const processor = unified().use(remarkStringify, {
    bullet: (styleHints?.listMarker as '-' | '*' | '+') || '-',
    emphasis: styleHints?.emphasisMarker || '*',
    strong: styleHints?.strongMarker === '__' ? '_' : '*',
    fence: styleHints?.codeFenceChar || '`',
    rule: '-',
    listItemIndent: 'one',
    // Custom handler for wiki-link nodes; remark-stringify passes through
    // to mdast-util-to-markdown which supports `handlers`
    handlers: { wikiLink: wikiLinkHandler },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any).use(remarkGfm);

  const result = processor.stringify(root);
  return result.trimEnd();
}
