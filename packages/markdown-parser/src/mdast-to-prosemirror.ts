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
  subscriptMark,
  superscriptMark,
  highlightMark,
  linkMark,
  wikiLinkMark,
  hashTagMark,
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
      return convertTableRow(node, false, []);
    case 'tableCell':
      return convertTableCell(node, parentMarks, false, null);
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
      const nt = (node as { type: string }).type;
      if (nt === 'wikiLink') {
        return convertWikiLink(node as unknown as RootContent & { value: string; data?: { alias?: string } }, parentMarks);
      }
      // GFM footnote reference: [^label]
      if (nt === 'footnoteReference') {
        const label = (node as unknown as { identifier: string }).identifier || '';
        return { type: 'footnoteRef', attrs: { label } };
      }
      // GFM footnote definition: [^label]: content
      if (nt === 'footnoteDefinition') {
        const fnNode = node as unknown as { identifier: string; children: RootContent[] };
        const children = convertChildren(fnNode.children as RootContent[], []);
        return { type: 'footnoteDef', attrs: { label: fnNode.identifier || '' }, content: children.length ? children : [paragraphNode([])] };
      }
      const anyNode = node as RootContent & { value?: string };
      if ('value' in anyNode && typeof anyNode.value === 'string' && nt === 'toml') {
        return convertFrontmatter(anyNode as RootContent & { value: string });
      }
      return null;
    }
  }
}

const TOC_RE = /^\[toc\]$|^\[\[toc\]\]$/i;

function convertParagraph(node: Paragraph): PMNodeJSON | PMNodeJSON[] {
  // remark-parse doesn't treat <video>/<audio> as block HTML on a single line;
  // it splits them into inline html children. Concatenate and detect the pattern.
  if (node.children.length > 0 && node.children.every(c => c.type === 'html' || c.type === 'text')) {
    const combined = node.children.map(c =>
      c.type === 'html' ? (c as Html).value : (c as Text).value,
    ).join('').trim();
    const videoInline = combined.match(/^<video\s+([^>]*?)(?:\/>|>\s*<\/video>)$/is);
    if (videoInline) return convertVideoHtml(videoInline[1]);
    const audioInline = combined.match(/^<audio\s+([^>]*?)(?:\/>|>\s*<\/audio>)$/is);
    if (audioInline) return convertAudioHtml(audioInline[1]);
  }
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

  // Block nodes (images) cannot live inside paragraphs.
  // If the paragraph is just a single block-producing child, lift it.
  // Note: [text](file.excalidraw) links stay inline; only ![](file.excalidraw)
  // image syntax is promoted to excalidrawBlock (handled by convertImage).
  if (node.children.length === 1) {
    const only = node.children[0];
    if (only.type === 'image') return convertImage(only);
  }

  // Mixed content: split into runs of inline content vs block-producing nodes.
  const isBlockChild = (c: PhrasingContent) => c.type === 'image';

  const hasBlockChild = node.children.some(isBlockChild);
  if (hasBlockChild) {
    const blocks: PMNodeJSON[] = [];
    let inlineBuf: PhrasingContent[] = [];

    const flushInline = () => {
      if (inlineBuf.length === 0) return;
      const content = convertPhrasingContent(inlineBuf, []);
      if (content.length > 0) blocks.push(paragraphNode(content));
      inlineBuf = [];
    };

    for (const child of node.children) {
      if (child.type === 'image') {
        flushInline();
        blocks.push(convertImage(child));
      } else {
        inlineBuf.push(child);
      }
    }
    flushInline();
    return blocks.length === 1 ? blocks[0] : blocks;
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
  if (node.ordered) {
    const items = node.children.map((child) => convertListItem(child));
    return orderedListNode(node.start ?? 1, items);
  }

  const hasAnyTask = node.children.some(
    (child) => typeof child.checked === 'boolean',
  );
  const allTasks = hasAnyTask && node.children.every(
    (child) => typeof child.checked === 'boolean',
  );

  if (!hasAnyTask) {
    return bulletListNode(node.children.map((child) => convertListItem(child)));
  }

  if (allTasks) {
    return taskListNode(node.children.map((child) => {
      const content = convertChildren(child.children as RootContent[], []);
      return taskItemNode(child.checked === true, content);
    }));
  }

  // Mixed list: preserve each item's type inside a single bulletList.
  const items = node.children.map((child) => {
    if (typeof child.checked === 'boolean') {
      const content = convertChildren(child.children as RootContent[], []);
      return taskItemNode(child.checked === true, content);
    }
    return convertListItem(child);
  });
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

  const align = node.align || [];
  const rows: PMNodeJSON[] = [];
  for (let i = 0; i < node.children.length; i++) {
    rows.push(convertTableRow(node.children[i], i === 0, align));
  }

  return tableNode(rows);
}

function convertTableRow(node: TableRow, isHeader: boolean, align: (string | null)[]): PMNodeJSON {
  const cells = node.children.map((cell, colIdx) =>
    convertTableCell(cell, [], isHeader, align[colIdx] || null),
  );
  return tableRowNode(cells);
}

function convertTableCell(
  node: TableCell,
  marks: PMMarkJSON[],
  isHeader: boolean,
  textAlign: string | null,
): PMNodeJSON {
  const content = convertPhrasingContent(node.children, marks);
  const para = paragraphNode(content);
  const cellNode = isHeader ? tableHeaderNode([para]) : tableCellNode([para]);
  if (textAlign) {
    cellNode.attrs = { ...(cellNode.attrs || {}), textAlign };
  }
  return cellNode;
}

function isExcalidrawUrl(url: string): boolean {
  return /\.excalidraw(?:\?|#|$)/i.test(url);
}

function convertImage(node: Image): PMNodeJSON {
  if (isExcalidrawUrl(node.url)) {
    return { type: 'excalidrawBlock', attrs: { src: node.url, data: '{}', alt: node.alt || null } };
  }
  return imageNode(node.url, node.alt ?? undefined, node.title ?? undefined);
}

const HASHTAG_RE = /(?:^|\s)#([a-zA-Z0-9_/][a-zA-Z0-9_/-]*)/g;
const HIGHLIGHT_RE = /==([^=\n]+?)==/g;

function convertText(node: Text, marks: PMMarkJSON[]): PMNodeJSON | PMNodeJSON[] {
  const value = node.value;

  // Split ==highlight== before other processing
  if (marks.length === 0 && HIGHLIGHT_RE.test(value)) {
    HIGHLIGHT_RE.lastIndex = 0;
    const parts: PMNodeJSON[] = [];
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    while ((m = HIGHLIGHT_RE.exec(value)) !== null) {
      if (m.index > lastIdx) {
        parts.push(...flatArray(convertText({ type: 'text', value: value.slice(lastIdx, m.index) } as Text, marks)));
      }
      parts.push(textNode(m[1], [highlightMark()]));
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < value.length) {
      parts.push(...flatArray(convertText({ type: 'text', value: value.slice(lastIdx) } as Text, marks)));
    }
    return parts.length === 1 ? parts[0] : parts;
  }

  if (!HASHTAG_RE.test(value)) {
    return textNode(value, marks.length > 0 ? marks : undefined);
  }

  HASHTAG_RE.lastIndex = 0;
  const parts: PMNodeJSON[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = HASHTAG_RE.exec(value)) !== null) {
    const fullMatch = match[0];
    const tag = match[1];
    const prefixLen = fullMatch.length - tag.length - 1;

    const beforeEnd = match.index + prefixLen;
    if (beforeEnd > lastIndex) {
      parts.push(textNode(value.slice(lastIndex, beforeEnd), marks.length > 0 ? marks : undefined));
    }

    parts.push(textNode(`#${tag}`, [...marks, hashTagMark(tag)]));
    lastIndex = match.index + fullMatch.length;
  }

  if (parts.length === 0) {
    return textNode(value, marks.length > 0 ? marks : undefined);
  }

  if (lastIndex < value.length) {
    parts.push(textNode(value.slice(lastIndex), marks.length > 0 ? marks : undefined));
  }

  return parts;
}

function flatArray(v: PMNodeJSON | PMNodeJSON[]): PMNodeJSON[] {
  return Array.isArray(v) ? v : [v];
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

const INLINE_HTML_MARKS: [RegExp, () => PMMarkJSON][] = [
  [/^<sub>(.*?)<\/sub>$/s, subscriptMark],
  [/^<sup>(.*?)<\/sup>$/s, superscriptMark],
  [/^<mark>(.*?)<\/mark>$/s, () => ({ type: 'highlight' })],
  [/^<u>(.*?)<\/u>$/s, () => ({ type: 'underline' })],
  [/^<ins>(.*?)<\/ins>$/s, () => ({ type: 'underline' })],
  [/^<kbd>(.*?)<\/kbd>$/s, () => ({ type: 'code' })],
  [/^<del>(.*?)<\/del>$/s, () => ({ type: 'strike' })],
  [/^<em>(.*?)<\/em>$/s, () => ({ type: 'italic' })],
  [/^<strong>(.*?)<\/strong>$/s, () => ({ type: 'bold' })],
  [/^<b>(.*?)<\/b>$/s, () => ({ type: 'bold' })],
  [/^<i>(.*?)<\/i>$/s, () => ({ type: 'italic' })],
  [/^<s>(.*?)<\/s>$/s, () => ({ type: 'strike' })],
  [/^<code>(.*?)<\/code>$/s, () => ({ type: 'code' })],
];

function convertHtml(node: Html): PMNodeJSON | PMNodeJSON[] {
  // <br> / <br/> → empty paragraph (preserves intentional blank lines)
  if (/^<br\s*\/?>$/i.test(node.value.trim())) {
    return paragraphNode([]);
  }
  for (const [regex, markFn] of INLINE_HTML_MARKS) {
    const m = node.value.match(regex);
    if (m) return textNode(m[1], [markFn()]);
  }
  // Self-closing <img /> tag with optional width/data-align attributes
  const imgMatch = node.value.match(/^<img\s+([^>]*?)\/?\s*>$/i);
  if (imgMatch) {
    return convertImgHtml(imgMatch[1]);
  }
  // <video> tag
  const videoMatch = node.value.match(/^<video\s+([^>]*?)(?:\/>|>\s*<\/video>)$/is);
  if (videoMatch) {
    return convertVideoHtml(videoMatch[1]);
  }
  // <audio> tag
  const audioMatch = node.value.match(/^<audio\s+([^>]*?)(?:\/>|>\s*<\/audio>)$/is);
  if (audioMatch) {
    return convertAudioHtml(audioMatch[1]);
  }
  // Standalone link HTML
  const linkMatch = node.value.match(/^<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>$/s);
  if (linkMatch) {
    return textNode(linkMatch[2], [{ type: 'link', attrs: { href: linkMatch[1], title: null, target: '_blank' } }]);
  }
  return paragraphNode([textNode(node.value)]);
}

function convertVideoHtml(attrStr: string): PMNodeJSON {
  const src = extractHtmlAttr(attrStr, 'src') || '';
  const width = extractHtmlAttr(attrStr, 'width') || null;
  const style = extractHtmlAttr(attrStr, 'style') || 'max-width:100%';
  const controls = /\bcontrols\b/.test(attrStr);
  return {
    type: 'video',
    attrs: { src, controls, width, style },
  };
}

function convertAudioHtml(attrStr: string): PMNodeJSON {
  const src = extractHtmlAttr(attrStr, 'src') || '';
  const width = extractHtmlAttr(attrStr, 'width') || null;
  const controls = /\bcontrols\b/.test(attrStr);
  return {
    type: 'audio',
    attrs: { src, controls, width },
  };
}

const _attrRegexCache = new Map<string, RegExp>();
function extractHtmlAttr(attrs: string, name: string): string | null {
  let re = _attrRegexCache.get(name);
  if (!re) {
    re = new RegExp(`${name}="([^"]*)"`, 'i');
    _attrRegexCache.set(name, re);
  }
  const m = attrs.match(re);
  return m ? m[1] : null;
}

function convertImgHtml(attrStr: string): PMNodeJSON {
  const src = extractHtmlAttr(attrStr, 'src') || '';
  const alt = extractHtmlAttr(attrStr, 'alt') || undefined;
  const widthStr = extractHtmlAttr(attrStr, 'width');
  const align = extractHtmlAttr(attrStr, 'data-align');
  const width = widthStr === '100%' ? '100%' : widthStr ? parseInt(widthStr, 10) || null : null;
  if (isExcalidrawUrl(src)) {
    return { type: 'excalidrawBlock', attrs: { src, data: '{}', alt: alt || null, width, 'data-align': align || null } };
  }
  return imageNode(src, alt, undefined, {
    width: width,
    'data-align': align,
  });
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
