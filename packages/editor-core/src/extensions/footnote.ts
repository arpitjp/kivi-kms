import { Node, mergeAttributes } from '@tiptap/core';

export interface FootnoteRefOptions {
  HTMLAttributes: Record<string, string>;
}

export const FootnoteRef = Node.create<FootnoteRefOptions>({
  name: 'footnoteRef',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      label: { default: null },
    };
  },

  addOptions() {
    return { HTMLAttributes: {} };
  },

  parseHTML() {
    return [{ tag: 'sup[data-type="footnote-ref"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'sup',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'footnote-ref',
        class: 'kivi-footnote-ref',
      }),
      `[${node.attrs.label}]`,
    ];
  },
});

export interface FootnoteDefOptions {
  HTMLAttributes: Record<string, string>;
}

export const FootnoteDef = Node.create<FootnoteDefOptions>({
  name: 'footnoteDef',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      label: { default: null },
    };
  },

  addOptions() {
    return { HTMLAttributes: {} };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="footnote-def"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'footnote-def',
        'data-label': node.attrs.label,
        class: 'kivi-footnote-def',
      }),
      0,
    ];
  },
});
