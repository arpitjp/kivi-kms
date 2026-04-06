import { unified } from 'unified';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
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

  // Single empty paragraph = empty document
  if (topLevelNodes.length === 1 && isEmptyParagraph(topLevelNodes[0])) {
    return options?.trailingNewline !== false ? '\n' : '';
  }

  // If block count changed (user added/removed blocks), the 1:1
  // mapping between blockOrder and topLevelNodes is broken.
  // Fall back to full re-serialization to avoid duplicated/missing content.
  const blockCountChanged = topLevelNodes.length !== blockOrder.length;

  const parts: string[] = [];

  // Build gap index for O(1) lookup instead of O(n) per block
  let gapIndex: Map<number, string> | null = null;
  if (!blockCountChanged) {
    gapIndex = new Map();
    for (const g of sourceMap.gaps) {
      gapIndex.set(g.afterBlockIndex, g.text);
    }
    parts.push(sourceMap.preamble);
  }

  const lastIdx = topLevelNodes.length - 1;

  for (let i = 0; i < topLevelNodes.length; i++) {
    const blockId = !blockCountChanged ? blockOrder[i] : undefined;
    const blockMeta = blockId ? sourceMap.blocks.get(blockId) : undefined;
    const node = topLevelNodes[i];

    // Skip trailing empty paragraph (editor adds one for cursor placement)
    if (i === lastIdx && i > 0 && isEmptyParagraph(node)) break;

    if (!blockCountChanged && blockMeta && !blockMeta.dirty && blockMeta.originalSource !== null) {
      parts.push(blockMeta.originalSource);
    } else if (isEmptyParagraph(node)) {
      parts.push('<br>');
    } else {
      parts.push(serializeNode(node, blockMeta?.styleHints));
    }

    if (!blockCountChanged && gapIndex) {
      const gapText = gapIndex.get(i);
      if (gapText !== undefined) {
        parts.push(gapText);
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

function isEmptyParagraph(node: PMNodeJSON): boolean {
  if (node.type !== 'paragraph') return false;
  if (!node.content || node.content.length === 0) return true;
  return node.content.every(
    (c) => c.type === 'text' && (!c.text || c.text.trim() === ''),
  );
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wikiLinkHandler = (node: any) => {
  const target = node.value || '';
  const alias = node.data?.alias;
  if (alias && alias !== target) {
    return `[[${target}|${alias}]]`;
  }
  return `[[${target}]]`;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stringifyProcessorCache = new Map<string, any>();

function stringifyCacheKey(hints?: StyleHints): string {
  if (!hints) return 'default';
  return `${hints.listMarker || '-'}|${hints.emphasisMarker || '*'}|${hints.strongMarker || '*'}|${hints.codeFenceChar || '\`'}`;
}

function stringifyMdast(root: Root, styleHints?: StyleHints): string {
  const key = stringifyCacheKey(styleHints);
  let processor = stringifyProcessorCache.get(key);

  if (!processor) {
    processor = unified().use(remarkStringify, {
      bullet: (styleHints?.listMarker as '-' | '*' | '+') || '-',
      emphasis: styleHints?.emphasisMarker || '*',
      strong: styleHints?.strongMarker === '__' ? '_' : '*',
      fence: styleHints?.codeFenceChar || '`',
      rule: '-',
      listItemIndent: 'one',
      handlers: { wikiLink: wikiLinkHandler },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).use(remarkGfm).use(remarkMath).use(remarkFrontmatter, ['yaml', 'toml']);
    stringifyProcessorCache.set(key, processor);
  }

  const result = processor.stringify(root);
  return result
    .replace(/&#x20;/g, ' ')
    // remark-stringify escapes [ in some contexts; restore task-list syntax
    .replace(/^(\s*[-*+]\s)\\\[([xX ])\\\]/gm, '$1[$2]')
    .replace(/^(\s*[-*+]\s)\\\[([xX ])\]/gm, '$1[$2]')
    .replace(/^(\s*[-*+]\s)\[([xX ])\\\]/gm, '$1[$2]')
    // remark-stringify escapes brackets/parens in text that looks like markdown links/images;
    // restore `[text](url)` and `![alt](url)` patterns.
    .replace(/(!?)\\\[([^\]]*)\\\]\\\(([^)]*)\)/g, '$1[$2]($3)')
    .replace(/(!?)\\\[([^\]]*)\]\\\(([^)]*)\)/g, '$1[$2]($3)')
    .replace(/(!?)\[([^\]]*)\\\]\\\(([^)]*)\)/g, '$1[$2]($3)')
    .replace(/(!?)\\\[([^\]]*)\\\]\(([^)]*)\)/g, '$1[$2]($3)')
    .replace(/(!?)\\\[([^\]]*)\]\(([^)]*)\)/g, '$1[$2]($3)')
    .replace(/(!?)\[([^\]]*)\\\]\(([^)]*)\)/g, '$1[$2]($3)')
    // Restore callout/admonition syntax inside blockquotes: > [!type]
    .replace(/^(>\s*)\\\[(![\w-]+)\\\]/gm, '$1[$2]')
    .replace(/^(>\s*)\\\[(![\w-]+)\]/gm, '$1[$2]')
    .replace(/^(>\s*)\[(![\w-]+)\\\]/gm, '$1[$2]')
    .trimEnd();
}
