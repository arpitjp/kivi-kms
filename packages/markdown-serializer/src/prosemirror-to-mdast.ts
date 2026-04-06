import type { Root, RootContent, PhrasingContent } from 'mdast';

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
}

interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/**
 * Convert a ProseMirror document JSON back to an mdast tree.
 */
export function proseMirrorToMdast(doc: PMNode): Root {
  const children = (doc.content || []).flatMap((child) => convertBlockNode(child));
  return { type: 'root', children };
}

function convertBlockNode(node: PMNode): RootContent[] {
  switch (node.type) {
    case 'paragraph': {
      const paraChildren = convertInlineContent(node.content || []);
      trimTrailingWhitespace(paraChildren);
      return [{ type: 'paragraph', children: paraChildren }];
    }

    case 'heading': {
      const headingChildren = convertInlineContent(node.content || []);
      trimTrailingWhitespace(headingChildren);
      return [{
        type: 'heading',
        depth: (node.attrs?.level as 1 | 2 | 3 | 4 | 5 | 6) || 1,
        children: headingChildren,
      }];
    }

    case 'blockquote':
      return [{
        type: 'blockquote',
        children: (node.content || []).flatMap(convertBlockNode) as import('mdast').BlockContent[],
      }];

    case 'codeBlock':
      return [{
        type: 'code',
        lang: (node.attrs?.language as string) || undefined,
        value: getTextContent(node),
      }];

    case 'bulletList':
      return [{
        type: 'list',
        ordered: false,
        spread: false,
        children: (node.content || []).map(convertMixedListItem),
      }];

    case 'orderedList':
      return [{
        type: 'list',
        ordered: true,
        start: (node.attrs?.start as number) || 1,
        spread: false,
        children: (node.content || []).map(convertListItem),
      }];

    case 'taskList':
      return [{
        type: 'list',
        ordered: false,
        spread: false,
        children: (node.content || []).map(convertMixedListItem),
      }];

    case 'horizontalRule':
      return [{ type: 'thematicBreak' }];

    case 'table':
      return [convertTable(node)];

    case 'image':
      return [convertBlockImage(node)];

    case 'video':
      return [convertVideo(node)];

    case 'audio':
      return [convertAudio(node)];

    case 'frontmatter':
      return [{ type: 'yaml' as 'code', value: getTextContent(node) } as unknown as RootContent];

    case 'mathBlock':
      return [{ type: 'math' as 'code', value: getTextContent(node) } as unknown as RootContent];

    case 'mathInline':
      return [{
        type: 'paragraph',
        children: [{ type: 'inlineMath' as 'text', value: getTextContent(node) } as unknown as import('mdast').PhrasingContent],
      }];

    case 'footnoteDef': {
      const label = (node.attrs?.label as string) || '';
      const children = (node.content || []).flatMap(convertBlockNode);
      return [{
        type: 'footnoteDefinition' as 'code',
        identifier: label,
        label,
        children,
      } as unknown as RootContent];
    }

    case 'tocBlock':
      return [{ type: 'paragraph', children: [{ type: 'text', value: '[TOC]' }] }];

    case 'mermaidBlock':
      return [{
        type: 'code',
        lang: 'mermaid',
        value: getTextContent(node),
      }];

    case 'excalidrawBlock': {
      const excSrc = node.attrs?.src as string | null;
      if (excSrc) {
        const excAlt = (node.attrs?.alt as string | null)
          || excSrc.split('/').pop()?.replace(/\.excalidraw$/i, '') || 'excalidraw';
        const width = node.attrs?.width as number | null;
        const align = node.attrs?.['data-align'] as string | null;
        if (width || align) {
          const parts = [`src="${escAttr(excSrc)}"`, `alt="${escAttr(excAlt)}"`];
          if (width) parts.push(`width="${width}"`);
          if (align) parts.push(`data-align="${escAttr(align)}"`);
          return [{
            type: 'html',
            value: `<img ${parts.join(' ')} />`,
          } as unknown as RootContent];
        }
        return [{
          type: 'paragraph',
          children: [{
            type: 'image',
            url: excSrc,
            alt: excAlt,
            title: null,
          }],
        } as unknown as RootContent];
      }
      return [{
        type: 'code',
        lang: 'excalidraw',
        value: (node.attrs?.data as string) || '{}',
      }];
    }

    default: {
      const fallbackText = getTextContent(node);
      if (fallbackText) {
        return [{ type: 'paragraph', children: [{ type: 'text', value: fallbackText }] }];
      }
      return [];
    }
  }
}

function convertListItem(node: PMNode): import('mdast').ListItem {
  const children = (node.content || []).flatMap(convertBlockNode);
  return {
    type: 'listItem',
    spread: false,
    children: children as import('mdast').ListItem['children'],
  };
}

function convertTaskItem(node: PMNode): import('mdast').ListItem {
  const children = (node.content || []).flatMap(convertBlockNode);
  return {
    type: 'listItem',
    checked: (node.attrs?.checked as boolean) ?? false,
    spread: false,
    children: children as import('mdast').ListItem['children'],
  };
}

function convertMixedListItem(node: PMNode): import('mdast').ListItem {
  if (node.type === 'taskItem') return convertTaskItem(node);
  return convertListItem(node);
}

function convertTable(node: PMNode): import('mdast').Table {
  let colCount = 0;
  const firstRow = node.content?.[0];
  if (firstRow?.content) {
    for (const cell of firstRow.content) {
      colCount += (cell.attrs?.colspan as number) || 1;
    }
  }

  const align: (('left' | 'center' | 'right') | null)[] = new Array(colCount).fill(null);

  if (firstRow?.content) {
    let col = 0;
    for (const cell of firstRow.content) {
      const span = (cell.attrs?.colspan as number) || 1;
      const ta = cell.attrs?.textAlign as string | null;
      if (ta === 'center' || ta === 'right' || ta === 'left') {
        for (let c = 0; c < span; c++) align[col + c] = ta;
      }
      col += span;
    }
  }

  const rows = (node.content || []).map((row) => {
    const cells: import('mdast').TableCell[] = [];
    for (const cell of row.content || []) {
      const children: PhrasingContent[] = [];
      const blocks = cell.content || [];
      for (let bi = 0; bi < blocks.length; bi++) {
        if (bi > 0) children.push({ type: 'html', value: '<br>' } as unknown as PhrasingContent);
        const paraContent = blocks[bi].content || [];
        children.push(...convertInlineContent(paraContent));
      }
      cells.push({ type: 'tableCell' as const, children });
      const colspan = ((cell.attrs?.colspan as number) || 1) - 1;
      for (let i = 0; i < colspan; i++) {
        cells.push({ type: 'tableCell' as const, children: [] });
      }
    }
    while (cells.length < colCount) {
      cells.push({ type: 'tableCell' as const, children: [] });
    }
    return { type: 'tableRow' as const, children: cells };
  });

  return { type: 'table', align, children: rows };
}

function convertInlineContent(nodes: PMNode[]): PhrasingContent[] {
  const result: PhrasingContent[] = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      const text = node.text || '';
      const marks = node.marks || [];

      if (marks.length === 0) {
        result.push({ type: 'text', value: text });
        continue;
      }

      let current: PhrasingContent = { type: 'text', value: text };

      for (const mark of marks) {
        current = wrapWithMark(current, mark);
      }

      result.push(current);
    } else if (node.type === 'hardBreak') {
      result.push({ type: 'break' });
    } else if (node.type === 'image') {
      if (imageHasAlignOnly(node)) {
        result.push({ type: 'html', value: buildImageHtml(node) } as unknown as PhrasingContent);
      } else if (imageHasCustomAttrs(node)) {
        result.push({ type: 'html', value: buildImageDimSyntax(node) } as unknown as PhrasingContent);
      } else {
        result.push({
          type: 'image',
          url: (node.attrs?.src as string) || '',
          alt: (node.attrs?.alt as string) || undefined,
          title: (node.attrs?.title as string) || undefined,
        });
      }
    } else if (node.type === 'footnoteRef') {
      const label = (node.attrs?.label as string) || '';
      result.push({
        type: 'footnoteReference' as 'text',
        identifier: label,
        label,
      } as unknown as PhrasingContent);
    } else if (node.type === 'mathInline') {
      const value = getTextContent(node);
      result.push({ type: 'inlineMath' as 'text', value } as unknown as PhrasingContent);
    } else {
      const fallback = getTextContent(node);
      if (fallback) {
        result.push({ type: 'text', value: fallback });
      }
    }
  }

  return result;
}

function wrapWithMark(content: PhrasingContent, mark: PMMark): PhrasingContent {
  switch (mark.type) {
    case 'bold':
      return { type: 'strong', children: [content] };
    case 'italic':
      return { type: 'emphasis', children: [content] };
    case 'strike':
      return { type: 'delete', children: [content] };
    case 'code':
      if ('value' in content) {
        return { type: 'inlineCode', value: content.value };
      }
      return content;
    case 'subscript':
      if ('value' in content) {
        return { type: 'html', value: `<sub>${content.value}</sub>` } as unknown as PhrasingContent;
      }
      return content;
    case 'superscript':
      if ('value' in content) {
        return { type: 'html', value: `<sup>${content.value}</sup>` } as unknown as PhrasingContent;
      }
      return content;
    case 'highlight':
      if ('value' in content) {
        return { type: 'html', value: `==${content.value}==` } as unknown as PhrasingContent;
      }
      return content;
    case 'underline':
      if ('value' in content) {
        return { type: 'html', value: `<u>${content.value}</u>` } as unknown as PhrasingContent;
      }
      return content;
    case 'link':
      return {
        type: 'link',
        url: (mark.attrs?.href as string) || '',
        title: (mark.attrs?.title as string) || undefined,
        children: [content],
      };
    case 'wikiLink': {
      const target = (mark.attrs?.target as string) || '';
      const alias = mark.attrs?.alias as string | undefined;
      return {
        type: 'wikiLink',
        value: target,
        data: {
          alias: alias || target,
          permalink: target,
          exists: true,
        },
      } as unknown as PhrasingContent;
    }
    case 'hashTag':
      return content;
    default:
      return content;
  }
}

/**
 * Strip trailing whitespace from the last text node(s) in an inline
 * content array.  remark-stringify encodes trailing spaces in certain
 * positions (e.g. headings) as `&#x20;`, which is an unwanted artifact.
 */
function trimTrailingWhitespace(children: PhrasingContent[]): void {
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.type === 'text') {
      child.value = child.value.trimEnd();
      if (child.value) return;
      children.splice(i, 1);
    } else {
      return;
    }
  }
}

function getTextContent(node: PMNode): string {
  if (node.text) return node.text;
  if (!node.content) return '';
  return node.content.map(getTextContent).join('');
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function imageHasCustomAttrs(node: PMNode): boolean {
  return !!node.attrs?.width || !!node.attrs?.height || !!node.attrs?.['data-align'];
}

function imageHasAlignOnly(node: PMNode): boolean {
  return !!node.attrs?.['data-align'];
}

function buildImageDimSyntax(node: PMNode): string {
  const src = (node.attrs?.src as string) || '';
  const alt = (node.attrs?.alt as string) || '';
  const width = node.attrs?.width as number | string | null;
  const height = node.attrs?.height as number | null;
  const w = width ? String(width) : '';
  const h = height ? String(height) : '';
  return `![${alt}](${src} =${w}x${h})`;
}

function buildImageHtml(node: PMNode): string {
  const src = (node.attrs?.src as string) || '';
  const alt = (node.attrs?.alt as string) || '';
  const width = node.attrs?.width as number | null;
  const height = node.attrs?.height as number | null;
  const align = node.attrs?.['data-align'] as string | null;
  let html = `<img src="${escAttr(src)}"`;
  if (alt) html += ` alt="${escAttr(alt)}"`;
  if (width) html += ` width="${width}"`;
  if (height) html += ` height="${height}"`;
  if (align) html += ` data-align="${escAttr(align)}"`;
  html += ' />';
  return html;
}

function convertVideo(node: PMNode): RootContent {
  const src = (node.attrs?.src as string) || '';
  const controls = node.attrs?.controls !== false;
  const width = (node.attrs?.width as string | null);
  let html = `<video src="${escAttr(src)}"`;
  if (controls) html += ' controls';
  if (width) html += ` width="${escAttr(width)}"`;
  html += ' style="max-width:100%">\n</video>';
  return { type: 'html', value: html } as unknown as RootContent;
}

function convertAudio(node: PMNode): RootContent {
  const src = (node.attrs?.src as string) || '';
  const controls = node.attrs?.controls !== false;
  const width = (node.attrs?.width as string | null);
  let html = `<audio src="${escAttr(src)}"`;
  if (controls) html += ' controls';
  if (width) html += ` width="${escAttr(width)}"`;
  html += '>\n</audio>';
  return { type: 'html', value: html } as unknown as RootContent;
}

function convertBlockImage(node: PMNode): RootContent {
  if (imageHasAlignOnly(node)) {
    return { type: 'html', value: buildImageHtml(node) } as unknown as RootContent;
  }
  if (imageHasCustomAttrs(node)) {
    return { type: 'html', value: buildImageDimSyntax(node) } as unknown as RootContent;
  }
  return {
    type: 'paragraph',
    children: [{
      type: 'image',
      url: (node.attrs?.src as string) || '',
      alt: (node.attrs?.alt as string) || undefined,
      title: (node.attrs?.title as string) || undefined,
    }],
  };
}
