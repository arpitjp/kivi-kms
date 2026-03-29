import type { StyleHints } from '@kivi/shared-types';
import type { Node as MdastNode, List } from 'mdast';

function getOffset(node: MdastNode): number | null {
  return node.position?.start.offset ?? null;
}

/**
 * Extract style hints from an mdast node and its original source text.
 * These hints are used during serialization to match the user's original style.
 */
export function extractStyleHints(node: MdastNode, source: string): StyleHints {
  const hints: StyleHints = {};

  switch (node.type) {
    case 'heading':
      hints.headingStyle = detectHeadingStyle(node, source);
      break;

    case 'list': {
      const list = node as List;
      if (!list.ordered && list.children[0]) {
        hints.listMarker = detectUnorderedListMarker(list.children[0], source);
      }
      break;
    }

    case 'code':
      Object.assign(hints, detectCodeFenceStyle(node, source));
      break;

    case 'emphasis':
      hints.emphasisMarker = detectEmphasisMarker(node, source);
      break;

    case 'strong':
      hints.strongMarker = detectStrongMarker(node, source);
      break;

    case 'blockquote':
      hints.blockquoteMarker = detectBlockquoteMarker(node, source);
      break;
  }

  const indent = detectIndent(node, source);
  if (indent !== undefined) {
    hints.indent = indent;
  }

  return hints;
}

function detectHeadingStyle(node: MdastNode, source: string): 'atx' | 'setext' {
  const offset = getOffset(node);
  if (offset === null) return 'atx';
  const line = getSourceLine(source, offset);
  return line.startsWith('#') ? 'atx' : 'setext';
}

function detectUnorderedListMarker(firstItem: MdastNode, source: string): string {
  const offset = getOffset(firstItem);
  if (offset === null) return '-';
  const line = getSourceLine(source, offset);
  const trimmed = line.trimStart();
  if (trimmed.startsWith('* ')) return '*';
  if (trimmed.startsWith('+ ')) return '+';
  return '-';
}

function detectCodeFenceStyle(
  node: MdastNode,
  source: string,
): { codeFenceChar: '`' | '~'; codeFenceLength: number } {
  const offset = getOffset(node);
  if (offset === null) return { codeFenceChar: '`', codeFenceLength: 3 };
  const line = getSourceLine(source, offset);
  const trimmed = line.trimStart();
  if (trimmed.startsWith('~')) {
    const match = trimmed.match(/^(~+)/);
    return { codeFenceChar: '~', codeFenceLength: match ? match[1].length : 3 };
  }
  const match = trimmed.match(/^(`+)/);
  return { codeFenceChar: '`', codeFenceLength: match ? match[1].length : 3 };
}

function detectEmphasisMarker(node: MdastNode, source: string): '*' | '_' {
  const offset = getOffset(node);
  if (offset === null) return '*';
  const char = source.charAt(offset);
  return char === '_' ? '_' : '*';
}

function detectStrongMarker(node: MdastNode, source: string): '**' | '__' {
  const offset = getOffset(node);
  if (offset === null) return '**';
  const chars = source.slice(offset, offset + 2);
  return chars === '__' ? '__' : '**';
}

function detectBlockquoteMarker(node: MdastNode, source: string): string {
  const offset = getOffset(node);
  if (offset === null) return '> ';
  const line = getSourceLine(source, offset);
  const match = line.match(/^(\s*>[\s]*)/);
  return match ? match[1] : '> ';
}

function detectIndent(node: MdastNode, source: string): 'tab' | number | undefined {
  const offset = getOffset(node);
  if (offset === null) return undefined;
  const line = getSourceLine(source, offset);
  const leadingWhitespace = line.match(/^(\s*)/);
  if (!leadingWhitespace || leadingWhitespace[1].length === 0) return undefined;
  if (leadingWhitespace[1].includes('\t')) return 'tab';
  return leadingWhitespace[1].length;
}

function getSourceLine(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = source.indexOf('\n', offset);
  return source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
}
