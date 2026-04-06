/**
 * ProseMirror-compatible JSON node/mark type definitions.
 * These mirror what Tiptap expects in its document JSON format.
 */

export interface PMNodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNodeJSON[];
  text?: string;
  marks?: PMMarkJSON[];
}

export interface PMMarkJSON {
  type: string;
  attrs?: Record<string, unknown>;
}

export function textNode(text: string, marks?: PMMarkJSON[]): PMNodeJSON {
  const node: PMNodeJSON = { type: 'text', text };
  if (marks && marks.length > 0) {
    node.marks = marks;
  }
  return node;
}

export function paragraphNode(content: PMNodeJSON[]): PMNodeJSON {
  return { type: 'paragraph', content };
}

export function headingNode(level: number, content: PMNodeJSON[]): PMNodeJSON {
  return { type: 'heading', attrs: { level }, content };
}

export function blockquoteNode(content: PMNodeJSON[]): PMNodeJSON {
  return { type: 'blockquote', content };
}

export function codeBlockNode(code: string, language?: string): PMNodeJSON {
  return {
    type: 'codeBlock',
    attrs: { language: language || null },
    content: code ? [textNode(code)] : undefined,
  };
}

export function bulletListNode(items: PMNodeJSON[]): PMNodeJSON {
  return { type: 'bulletList', content: items };
}

export function orderedListNode(start: number, items: PMNodeJSON[]): PMNodeJSON {
  return { type: 'orderedList', attrs: { start }, content: items };
}

export function listItemNode(content: PMNodeJSON[]): PMNodeJSON {
  return { type: 'listItem', content };
}

export function taskListNode(items: PMNodeJSON[]): PMNodeJSON {
  return { type: 'taskList', content: items };
}

export function taskItemNode(checked: boolean, content: PMNodeJSON[]): PMNodeJSON {
  return { type: 'taskItem', attrs: { checked }, content };
}

export function horizontalRuleNode(): PMNodeJSON {
  return { type: 'horizontalRule' };
}

export function hardBreakNode(): PMNodeJSON {
  return { type: 'hardBreak' };
}

export function imageNode(
  src: string,
  alt?: string,
  title?: string,
  extra?: { width?: number | string | null; 'data-align'?: string | null },
): PMNodeJSON {
  const attrs: Record<string, unknown> = { src, alt: alt || null, title: title || null };
  if (extra?.width) attrs.width = extra.width;
  if (extra?.['data-align']) attrs['data-align'] = extra['data-align'];
  return { type: 'image', attrs };
}

export function tableNode(rows: PMNodeJSON[]): PMNodeJSON {
  return { type: 'table', content: rows };
}

export function tableRowNode(cells: PMNodeJSON[]): PMNodeJSON {
  return { type: 'tableRow', content: cells };
}

export function tableCellNode(content: PMNodeJSON[]): PMNodeJSON {
  return { type: 'tableCell', content };
}

export function tableHeaderNode(content: PMNodeJSON[]): PMNodeJSON {
  return { type: 'tableHeader', content };
}

export function boldMark(): PMMarkJSON {
  return { type: 'bold' };
}

export function italicMark(): PMMarkJSON {
  return { type: 'italic' };
}

export function strikeMark(): PMMarkJSON {
  return { type: 'strike' };
}

export function codeMark(): PMMarkJSON {
  return { type: 'code' };
}

export function subscriptMark(): PMMarkJSON {
  return { type: 'subscript' };
}

export function superscriptMark(): PMMarkJSON {
  return { type: 'superscript' };
}

export function highlightMark(): PMMarkJSON {
  return { type: 'highlight' };
}

export function underlineMark(): PMMarkJSON {
  return { type: 'underline' };
}

export function linkMark(href: string, title?: string): PMMarkJSON {
  return { type: 'link', attrs: { href, title: title || null, target: '_blank' } };
}

export function wikiLinkMark(target: string, alias?: string): PMMarkJSON {
  return { type: 'wikiLink', attrs: { target, alias: alias || null } };
}

export function hashTagMark(tag: string): PMMarkJSON {
  return { type: 'hashTag', attrs: { tag } };
}

export function tocBlockNode(): PMNodeJSON {
  return { type: 'tocBlock' };
}
