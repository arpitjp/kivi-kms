import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    excalidrawBlock: {
      insertExcalidraw: (data?: string) => ReturnType;
    };
  }
}

export const ExcalidrawBlock = Node.create({
  name: 'excalidrawBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      data: {
        default: '{}',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-excalidraw') || '{}',
        renderHTML: (attrs) => ({ 'data-excalidraw': attrs.data }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="excalidraw"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'excalidraw',
        class: 'kivi-excalidraw-block',
      }),
      'Excalidraw Diagram',
    ];
  },

  addCommands() {
    return {
      insertExcalidraw:
        (data?: string) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { data: data || '{}' },
          });
        },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const container = document.createElement('div');
      container.className = 'kivi-excalidraw-block';
      container.contentEditable = 'false';

      const header = document.createElement('div');
      header.className = 'kivi-excalidraw-header';
      header.textContent = 'Excalidraw Diagram';
      container.appendChild(header);

      const canvas = document.createElement('div');
      canvas.className = 'kivi-excalidraw-canvas';

      let excalidrawData: Record<string, unknown> = {};
      try {
        excalidrawData = JSON.parse(node.attrs.data || '{}');
      } catch {
        // Invalid JSON, start fresh
      }

      const elementCount = Array.isArray(excalidrawData.elements)
        ? excalidrawData.elements.length
        : 0;

      canvas.innerHTML = elementCount > 0
        ? `<div class="kivi-excalidraw-preview">${elementCount} element${elementCount !== 1 ? 's' : ''}</div>`
        : '<div class="kivi-excalidraw-empty">Click to add elements (Excalidraw library required)</div>';

      container.appendChild(canvas);

      const editBtn = document.createElement('button');
      editBtn.className = 'kivi-excalidraw-edit';
      editBtn.textContent = 'Edit JSON';
      editBtn.addEventListener('click', () => {
        const currentData = node.attrs.data || '{}';
        const newData = prompt('Excalidraw JSON:', currentData);
        if (newData !== null && typeof getPos === 'function') {
          const pos = getPos();
          if (pos !== undefined) {
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(pos, undefined, { data: newData }),
            );
          }
        }
      });
      container.appendChild(editBtn);

      return {
        dom: container,
        update(updatedNode) {
          if (updatedNode.type !== node.type) return false;
          node = updatedNode;
          return true;
        },
      };
    };
  },
});
