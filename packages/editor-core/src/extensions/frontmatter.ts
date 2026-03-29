import { Node, mergeAttributes } from '@tiptap/core';

export interface FrontmatterOptions {
  HTMLAttributes: Record<string, string>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    frontmatter: {
      setFrontmatter: (content: string) => ReturnType;
    };
  }
}

export const Frontmatter = Node.create<FrontmatterOptions>({
  name: 'frontmatter',
  group: 'block',
  content: 'text*',
  marks: '',
  defining: true,
  isolating: true,
  code: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  parseHTML() {
    return [{ tag: 'pre[data-type="frontmatter"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'frontmatter',
        class: 'kivi-frontmatter',
      }),
      ['code', {}, 0],
    ];
  },

  addCommands() {
    return {
      setFrontmatter:
        (content: string) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            content: [{ type: 'text', text: content }],
          });
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-f': () => this.editor.commands.setFrontmatter('---\ntitle: \n---'),
    };
  },
});
