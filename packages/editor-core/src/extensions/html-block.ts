import { Node } from '@tiptap/core';

function sanitizeHtml(raw: string): string {
  if (!raw) return '';

  // Fallback for non-DOM environments (keeps tests from crashing).
  if (typeof document === 'undefined') {
    return raw.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
  }

  const blockedTags = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta']);
  const urlAttrs = new Set(['src', 'href', 'xlink:href']);

  const tpl = document.createElement('template');
  tpl.innerHTML = raw;

  const walk = (root: ParentNode) => {
    const nodes = Array.from(root.querySelectorAll('*'));
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      if (blockedTags.has(tag)) {
        el.remove();
        continue;
      }

      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (urlAttrs.has(name) && /^\s*javascript:/i.test(value)) {
          el.removeAttribute(attr.name);
        }
      }
    }
  };

  walk(tpl.content);
  return tpl.innerHTML;
}

export const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      content: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="html-block"]' }];
  },

  renderHTML({ node }) {
    const raw = (node.attrs.content as string) || '';
    return [
      'div',
      {
        'data-type': 'html-block',
        class: 'kivi-html-block',
        contenteditable: 'false',
      },
      ['div', { class: 'kivi-html-rendered' }, sanitizeHtml(raw)],
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.setAttribute('data-type', 'html-block');
      dom.className = 'kivi-html-block';
      dom.setAttribute('contenteditable', 'false');

      const rendered = document.createElement('div');
      rendered.className = 'kivi-html-rendered';
      rendered.innerHTML = sanitizeHtml((node.attrs.content as string) || '');
      dom.appendChild(rendered);

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'htmlBlock') return false;
          rendered.innerHTML = sanitizeHtml((updatedNode.attrs.content as string) || '');
          return true;
        },
      };
    };
  },
});
