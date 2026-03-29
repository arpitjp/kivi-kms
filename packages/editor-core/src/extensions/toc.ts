import { Node, type NodeViewRenderer } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tocBlock: {
      insertToc: () => ReturnType;
    };
  }
}

export const TocBlock = Node.create({
  name: 'tocBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="toc"]' }];
  },

  renderHTML() {
    return ['div', { 'data-type': 'toc', class: 'kivi-toc' }, 0];
  },

  addCommands() {
    return {
      insertToc:
        () =>
        ({ commands }) => {
          return commands.insertContent({ type: this.name });
        },
    };
  },

  addNodeView(): NodeViewRenderer {
    return ({ editor }) => {
      const container = document.createElement('div');
      container.className = 'kivi-toc';
      container.setAttribute('data-type', 'toc');
      container.contentEditable = 'false';

      const title = document.createElement('div');
      title.className = 'kivi-toc-title';
      title.textContent = 'Table of Contents';
      container.appendChild(title);

      const list = document.createElement('div');
      list.className = 'kivi-toc-list';
      container.appendChild(list);

      const renderToc = () => {
        list.innerHTML = '';
        const doc = editor.state.doc;
        doc.forEach((node, offset) => {
          if (node.type.name === 'heading') {
            const level = node.attrs.level as number;
            const text = node.textContent;
            const item = document.createElement('div');
            item.className = 'kivi-toc-item';
            item.style.paddingLeft = `${(level - 1) * 16}px`;
            item.textContent = text;
            item.addEventListener('click', () => {
              editor.commands.focus();
              const resolvedPos = editor.state.doc.resolve(offset + 1);
              editor.commands.setTextSelection(resolvedPos.pos);
              const dom = editor.view.domAtPos(offset + 1);
              const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
              el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            list.appendChild(item);
          }
        });

        if (list.children.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'kivi-toc-empty';
          empty.textContent = 'No headings found';
          list.appendChild(empty);
        }
      };

      renderToc();
      editor.on('update', renderToc);

      return {
        dom: container,
        destroy() {
          editor.off('update', renderToc);
        },
      };
    };
  },
});
