import type {
  Root,
  RootContent,
  Paragraph,
  Heading,
  Blockquote,
  Code,
  List,
  ListItem,
  Table,
  TableRow,
  TableCell,
  Image,
  Text,
  Emphasis,
  Strong,
  Delete,
  InlineCode,
  Link,
  Html,
  PhrasingContent,
} from 'mdast';
import type {
  PMNodeJSON,
  PMMarkJSON,
} from './schema.js';
import {
  textNode,
  paragraphNode,
  headingNode,
  blockquoteNode,
  codeBlockNode,
  bulletListNode,
  orderedListNode,
  listItemNode,
  taskListNode,
  taskItemNode,
  horizontalRuleNode,
  hardBreakNode,
  imageNode,
  tableNode,
  tableRowNode,
  tableCellNode,
  tableHeaderNode,
  boldMark,
  italicMark,
  strikeMark,
  codeMark,
  linkMark,
  wikiLinkMark,
  hashTagNode,
  tocBlockNode,
} from './schema.js';

/**
 * Convert an mdast tree into a ProseMirror-compatible JSON document.
 */
export function mdastToProseMirror(root: Root): PMNodeJSON {
  const content = convertChildren(root.children, []);
  return {
    type: 'doc',
    content: content.length > 0 ? content : [paragraphNode([])],
  };
}

function convertChildren(nodes: RootContent[], marks: PMMarkJSON[]): PMNodeJSON[] {
  const result: PMNodeJSON[] = [];
  for (const node of nodes) {
    const converted = convertNode(node, marks);
    if (converted) {
      if (Array.isArray(converted)) {
        result.push(...converted);
      } else {
        result.push(converted);
      }
    }
  }
  return result;
}

function convertNode(
  node: RootContent,
  parentMarks: PMMarkJSON[],
): PMNodeJSON | PMNodeJSON[] | null {
  switch (node.type) {
    case 'paragraph':
      return convertParagraph(node);
    case 'heading':
      return convertHeading(node);
    case 'blockquote':
      return convertBlockquote(node);
    case 'code':
      return convertCode(node);
    case 'list':
      return convertList(node);
    case 'listItem':
      return convertListItem(node);
    case 'thematicBreak':
      return horizontalRuleNode();
    case 'table':
      return convertTable(node);
    case 'tableRow':
      return convertTableRow(node, false);
    case 'tableCell':
      return convertTableCell(node, parentMarks, false);
    case 'image':
      return convertImage(node);
    case 'text':
      return convertText(node, parentMarks);
    case 'emphasis':
      return convertEmphasis(node, parentMarks);
    case 'strong':
      return convertStrong(node, parentMarks);
    case 'delete':
      return convertDelete(node, parentMarks);
    case 'inlineCode':
      return convertInlineCode(node, parentMarks);
    case 'link':
      return convertLink(node, parentMarks);
    case 'break':
      return hardBreakNode();
    case 'html':
      return convertHtml(node);
    case 'yaml':
      return convertFrontmatter(node as RootContent & { value: string });
    case 'math':
      return convertMathBlock(node as RootContent & { value: string });
    case 'inlineMath':
      return convertMathInline(node as RootContent & { value: string }, parentMarks);
    default: {
      // Wiki-link nodes from remark-wiki-link
      if ((node as { type: string }).type === 'wikiLink') {
        return convertWikiLink(node as unknown as RootContent & { value: string; data?: { alias?: string } }, parentMarks);
      }
      // Handle frontmatter types that remark-frontmatter adds (e.g. 'toml')
      const anyNode = node as RootContent & { value?: string };
      if ('value' in anyNode && typeof anyNode.value === 'string' && node.type === ('toml' as string)) {
        return convertFrontmatter(anyNode as RootContent & { value: string });
      }
      return null;
    }
  }
}

const TOC_RE = /^\[toc\]$|^\[\[toc\]\]$/i;

function convertParagraph(node: Paragraph): PMNodeJSON {
  // Detect [TOC] or [[toc]] marker (plain text form)
  if (node.children.length === 1 && node.children[0].type === 'text') {
    const text = (node.children[0] as Text).value.trim();
    if (TOC_RE.test(text)) {
      return tocBlockNode();
    }
  }
  // [[toc]] is parsed as wikiLink by remark-wiki-link; treat standalone as TOC
  if (node.children.length === 1 && (node.children[0] as { type: string }).type === 'wikiLink') {
    const wl = node.children[0] as RootContent & { value: string; data?: { alias?: string } };
    const target = wl.value.trim();
    if (target.toLowerCase() === 'toc') {
      const alias = wl.data?.alias?.trim();
      const plainToc =
        !alias || alias.toLowerCase() === target.toLowerCase();
      if (plainToc) {
        return tocBlockNode();
      }
    }
  }
  const content = convertPhrasingContent(node.children, []);
  return paragraphNode(content);
}

function convertHeading(node: Heading): PMNodeJSON {
  const content = convertPhrasingContent(node.children, []);
  return headingNode(node.depth, content);
}

function convertBlockquote(node: Blockquote): PMNodeJSON {
  const content = convertChildren(node.children as RootContent[], []);
  return blockquoteNode(content);
}

function convertCode(node: Code): PMNodeJSON {
  if (node.lang === 'mermaid') {
    return {
      type: 'mermaidBlock',
      attrs: { language: 'mermaid' },
      content: node.value ? [textNode(node.value)] : undefined,
    };
  }
  if (node.lang === 'excalidraw') {
    return {
      type: 'excalidrawBlock',
      attrs: { data: node.value || '{}' },
    };
  }
  return codeBlockNode(node.value, node.lang ?? undefined);
}

function convertList(node: List): PMNodeJSON {
  const isTaskList = node.children.some(
    (child) => typeof child.checked === 'boolean',
  );

  if (isTaskList) {
    const items = node.children.map((child) => {
      const checked = child.checked === true;
      const content = convertChildren(child.children as RootContent[], []);
      return taskItemNode(checked, content);
    });
    return taskListNode(items);
  }

  const items = node.children.map((child) => convertListItem(child));

  if (node.ordered) {
    return orderedListNode(node.start ?? 1, items);
  }
  return bulletListNode(items);
}

function convertListItem(node: ListItem): PMNodeJSON {
  const content = convertChildren(node.children as RootContent[], []);
  return listItemNode(content.length > 0 ? content : [paragraphNode([])]);
}

function convertTable(node: Table): PMNodeJSON {
  if (node.children.length === 0) {
    return tableNode([]);
  }

  const rows: PMNodeJSON[] = [];
  for (let i = 0; i < node.children.length; i++) {
    rows.push(convertTableRow(node.children[i], i === 0));
  }

  return tableNode(rows);
}

function convertTableRow(node: TableRow, isHeader: boolean): PMNodeJSON {
  const cells = node.children.map((cell) =>
    convertTableCell(cell, [], isHeader),
  );
  return tableRowNode(cells);
}

function convertTableCell(
  node: TableCell,
  marks: PMMarkJSON[],
  isHeader: boolean,
): PMNodeJSON {
  const content = convertPhrasingContent(node.children, marks);
  const para = paragraphNode(content);
  return isHeader ? tableHeaderNode([para]) : tableCellNode([para]);
}

function convertImage(node: Image): PMNodeJSON {
  return imageNode(node.url, node.alt ?? undefined, node.title ?? undefined);
}

const HASHTAG_RE = /(?:^|\s)#([a-zA-Z0-9_/][a-zA-Z0-9_/-]*)/g;

function convertText(node: Text, marks: PMMarkJSON[]): PMNodeJSON | PMNodeJSON[] {
  // If text has marks (bold, italic, etc.) or no hashtags, return as-is
  if (marks.length > 0 || !HASHTAG_RE.test(node.value)) {
    return textNode(node.value, marks.length > 0 ? marks : undefined);
  }

  HASHTAG_RE.lastIndex = 0;
  const parts: PMNodeJSON[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = HASHTAG_RE.exec(node.value)) !== null) {
    const fullMatch = match[0];
    const tag = match[1];
    const prefixLen = fullMatch.length - tag.length - 1; // space or start-of-string before #

    const beforeEnd = match.index + prefixLen;
    if (beforeEnd > lastIndex) {
      parts.push(textNode(node.value.slice(lastIndex, beforeEnd)));
    }

    parts.push(hashTagNode(tag));
    lastIndex = match.index + fullMatch.length;
  }

  if (parts.length === 0) {
    return textNode(node.value);
  }

  if (lastIndex < node.value.length) {
    parts.push(textNode(node.value.slice(lastIndex)));
  }

  return parts;
}

function convertEmphasis(node: Emphasis, parentMarks: PMMarkJSON[]): PMNodeJSON[] {
  return convertPhrasingContent(node.children, [...parentMarks, italicMark()]);
}

function convertStrong(node: Strong, parentMarks: PMMarkJSON[]): PMNodeJSON[] {
  return convertPhrasingContent(node.children, [...parentMarks, boldMark()]);
}

function convertDelete(node: Delete, parentMarks: PMMarkJSON[]): PMNodeJSON[] {
  return convertPhrasingContent(node.children, [...parentMarks, strikeMark()]);
}

function convertInlineCode(node: InlineCode, parentMarks: PMMarkJSON[]): PMNodeJSON {
  return textNode(node.value, [...parentMarks, codeMark()]);
}

function convertLink(node: Link, parentMarks: PMMarkJSON[]): PMNodeJSON[] {
  const mark = linkMark(node.url, node.title ?? undefined);
  return convertPhrasingContent(node.children, [...parentMarks, mark]);
}

function convertHtml(node: Html): PMNodeJSON {
  return paragraphNode([textNode(node.value)]);
}

function convertFrontmatter(node: RootContent & { value: string }): PMNodeJSON {
  return {
    type: 'frontmatter',
    content: node.value ? [textNode(node.value)] : undefined,
  };
}

function convertMathBlock(node: RootContent & { value: string }): PMNodeJSON {
  return {
    type: 'mathBlock',
    content: node.value ? [textNode(node.value)] : undefined,
  };
}

function convertMathInline(
  node: RootContent & { value: string },
  _marks: PMMarkJSON[],
): PMNodeJSON {
  return {
    type: 'mathInline',
    content: node.value ? [textNode(node.value)] : undefined,
  };
}

function convertWikiLink(
  node: RootContent & { value: string; data?: { alias?: string } },
  parentMarks: PMMarkJSON[],
): PMNodeJSON {
  const target = node.value;
  const alias = node.data?.alias !== target ? node.data?.alias : undefined;
  const displayText = alias || target;
  const mark = wikiLinkMark(target, alias);
  return textNode(displayText, [...parentMarks, mark]);
}

function convertPhrasingContent(
  children: PhrasingContent[],
  marks: PMMarkJSON[],
): PMNodeJSON[] {
  const result: PMNodeJSON[] = [];
  for (const child of children) {
    const converted = convertNode(child as RootContent, marks);
    if (converted) {
      if (Array.isArray(converted)) {
        result.push(...converted);
      } else {
        result.push(converted);
      }
    }
  }
  return result;
}
