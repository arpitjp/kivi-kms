import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export interface WikiLinkOptions {
  HTMLAttributes: Record<string, string>;
  onWikiLinkClick?: (target: string) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wikiLink: {
      setWikiLink: (target: string, alias?: string) => ReturnType;
      unsetWikiLink: () => ReturnType;
    };
  }
}

const wikiLinkPluginKey = new PluginKey('wikiLinkClick');

export const WikiLink = Mark.create<WikiLinkOptions>({
  name: 'wikiLink',
  inclusive: false,
  excludes: 'link',

  addOptions() {
    return {
      HTMLAttributes: {},
      onWikiLinkClick: undefined,
    };
  },

  addAttributes() {
    return {
      target: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-wiki-target'),
        renderHTML: (attrs) => ({ 'data-wiki-target': attrs.target }),
      },
      alias: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-wiki-alias'),
        renderHTML: (attrs) => {
          if (!attrs.alias) return {};
          return { 'data-wiki-alias': attrs.alias };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-wiki-target]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'a',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'kivi-wiki-link',
        href: '#',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setWikiLink:
        (target: string, alias?: string) =>
        ({ commands }) => {
          return commands.setMark(this.name, { target, alias: alias || null });
        },
      unsetWikiLink:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name);
        },
    };
  },

  addProseMirrorPlugins() {
    const onClick = this.options.onWikiLinkClick;
    if (!onClick) return [];

    const markType = this.type;
    return [
      new Plugin({
        key: wikiLinkPluginKey,
        props: {
          handleClick(view, pos) {
            const resolved = view.state.doc.resolve(pos);
            const marks = resolved.marks();
            const wikiMark = marks.find((m) => m.type === markType);
            if (wikiMark) {
              onClick(wikiMark.attrs.target);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});
