import type { Node as MdastNode, Root, RootContent, PhrasingContent } from 'mdast';

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
    case 'paragraph':
      return [{ type: 'paragraph', children: convertInlineContent(node.content || []) }];

    case 'heading':
      return [{
        type: 'heading',
        depth: (node.attrs?.level as 1 | 2 | 3 | 4 | 5 | 6) || 1,
        children: convertInlineContent(node.content || []),
      }];

    case 'blockquote':
      return [{
        type: 'blockquote',
        children: (node.content || []).flatMap(convertBlockNode) as RootContent[],
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
        children: (node.content || []).map(convertListItem),
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
        children: (node.content || []).map(convertTaskItem),
      }];

    case 'horizontalRule':
      return [{ type: 'thematicBreak' }];

    case 'table':
      return [convertTable(node)];

    case 'image':
      return [{
        type: 'paragraph',
        children: [{
          type: 'image',
          url: (node.attrs?.src as string) || '',
          alt: (node.attrs?.alt as string) || undefined,
          title: (node.attrs?.title as string) || undefined,
        }],
      }];

    case 'frontmatter':
      return [{ type: 'yaml' as 'code', value: getTextContent(node) } as unknown as RootContent];

    case 'mathBlock':
      return [{ type: 'math' as 'code', value: getTextContent(node) } as unknown as RootContent];

    case 'mathInline':
      return [];

    case 'footnoteDef':
      return [];

    case 'tocBlock':
      return [{ type: 'paragraph', children: [{ type: 'text', value: '[TOC]' }] }];

    case 'mermaidBlock':
      return [{
        type: 'code',
        lang: 'mermaid',
        value: getTextContent(node),
      }];

    case 'excalidrawBlock':
      return [{
        type: 'code',
        lang: 'excalidraw',
        value: (node.attrs?.data as string) || '{}',
      }];

    default:
      return [];
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

function convertTable(node: PMNode): import('mdast').Table {
  const rows = (node.content || []).map((row) => {
    const cells = (row.content || []).map((cell) => {
      const paraContent = cell.content?.[0]?.content || [];
      const children = convertInlineContent(paraContent);
      return { type: 'tableCell' as const, children };
    });
    return { type: 'tableRow' as const, children: cells };
  });

  return { type: 'table', children: rows };
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
      result.push({
        type: 'image',
        url: (node.attrs?.src as string) || '',
        alt: (node.attrs?.alt as string) || undefined,
        title: (node.attrs?.title as string) || undefined,
      });
    } else if (node.type === 'hashTag') {
      result.push({ type: 'text', value: `#${node.attrs?.tag || ''}` });
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
    default:
      return content;
  }
}

function getTextContent(node: PMNode): string {
  if (node.text) return node.text;
  if (!node.content) return '';
  return node.content.map(getTextContent).join('');
}
