import { Node, mergeAttributes } from '@tiptap/core';

export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      controls: {
        default: true,
        parseHTML: (el: HTMLElement) => el.hasAttribute('controls'),
        renderHTML: (attrs: Record<string, unknown>) => {
          return attrs.controls ? { controls: '' } : {};
        },
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const w = el.getAttribute('width');
          return w ? parseInt(w, 10) : null;
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.width) return {};
          return { width: String(attrs.width), style: `width:${attrs.width}px;max-width:100%` };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'video[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { style: existingStyle, ...rest } = HTMLAttributes;
    const baseStyle = rest.width ? undefined : 'max-width:100%';
    return ['video', mergeAttributes(rest, {
      class: 'kivi-video',
      ...(baseStyle ? { style: baseStyle } : {}),
    })];
  },
});

export const Audio = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      controls: {
        default: true,
        parseHTML: (el: HTMLElement) => el.hasAttribute('controls'),
        renderHTML: (attrs: Record<string, unknown>) => {
          return attrs.controls ? { controls: '' } : {};
        },
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const w = el.getAttribute('width');
          return w ? parseInt(w, 10) : null;
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.width) return {};
          return { width: String(attrs.width), style: `width:${attrs.width}px;max-width:100%` };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'audio[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { style: existingStyle, ...rest } = HTMLAttributes;
    const baseStyle = rest.width ? undefined : 'max-width:100%';
    return ['audio', mergeAttributes(rest, {
      class: 'kivi-audio',
      ...(baseStyle ? { style: baseStyle } : {}),
    })];
  },
});
