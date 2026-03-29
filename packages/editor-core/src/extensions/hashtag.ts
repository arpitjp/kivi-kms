import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { InputRule } from '@tiptap/core';

export interface HashTagOptions {
  HTMLAttributes: Record<string, string>;
  suggestion?: {
    items: (query: string) => string[] | Promise<string[]>;
  };
  onHashTagClick?: (tag: string) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    hashTag: {
      insertHashTag: (tag: string) => ReturnType;
    };
  }
}

const hashTagPluginKey = new PluginKey('hashTagClick');

export const HashTag = Node.create<HashTagOptions>({
  name: 'hashTag',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      suggestion: undefined,
      onHashTagClick: undefined,
    };
  },

  addAttributes() {
    return {
      tag: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-tag'),
        renderHTML: (attrs) => ({ 'data-tag': attrs.tag }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-tag]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'kivi-hashtag',
        'data-tag': node.attrs.tag,
      }),
      `#${node.attrs.tag}`,
    ];
  },

  addCommands() {
    return {
      insertHashTag:
        (tag: string) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { tag },
          });
        },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /(?:^|\s)#([a-zA-Z0-9_/][a-zA-Z0-9_/-]*)\s$/,
        handler: ({ range, match, chain }) => {
          const tag = match[1];
          const start = range.from + (match[0].startsWith(' ') ? 1 : 0);
          chain()
            .deleteRange({ from: start, to: range.to })
            .insertContentAt(start, { type: 'hashTag', attrs: { tag } })
            .run();
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const onClick = this.options.onHashTagClick;
    if (!onClick) return [];

    const nodeType = this.type;
    return [
      new Plugin({
        key: hashTagPluginKey,
        props: {
          handleClick(view, pos) {
            const node = view.state.doc.nodeAt(pos);
            if (node?.type === nodeType) {
              onClick(node.attrs.tag);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});
