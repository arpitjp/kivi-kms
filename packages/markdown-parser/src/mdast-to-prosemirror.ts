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
      // Handle frontmatter types that remark-frontmatter adds (e.g. 'toml')
      const anyNode = node as RootContent & { value?: string };
      if ('value' in anyNode && typeof anyNode.value === 'string' && node.type === ('toml' as string)) {
        return convertFrontmatter(anyNode as RootContent & { value: string });
      }
      return null;
    }
  }
}

function convertParagraph(node: Paragraph): PMNodeJSON {
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

function convertText(node: Text, marks: PMMarkJSON[]): PMNodeJSON {
  return textNode(node.value, marks.length > 0 ? marks : undefined);
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
