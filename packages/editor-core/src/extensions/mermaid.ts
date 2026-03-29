import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mermaidBlock: {
      insertMermaid: (code?: string) => ReturnType;
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaidLib: any = null;
let mermaidLoading = false;
const loadCallbacks: (() => void)[] = [];

async function ensureMermaid(): Promise<void> {
  // Check for globally loaded mermaid (e.g. via CDN)
  if ((globalThis as Record<string, unknown>).mermaid) {
    mermaidLib = (globalThis as Record<string, unknown>).mermaid;
    return;
  }
  if (mermaidLib) return;
  if (mermaidLoading) {
    return new Promise<void>((resolve) => loadCallbacks.push(resolve));
  }
  mermaidLoading = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await (Function('return import("mermaid")')() as Promise<any>);
    mermaidLib = mod.default || mod;
    mermaidLib.initialize({ startOnLoad: false, theme: 'dark' });
  } catch {
    // Mermaid not available — will show source fallback
  }
  mermaidLoading = false;
  for (const cb of loadCallbacks) cb();
  loadCallbacks.length = 0;
}

let renderCounter = 0;

export const MermaidBlock = Node.create({
  name: 'mermaidBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      language: { default: 'mermaid' },
    };
  },

  parseHTML() {
    return [{ tag: 'pre[data-type="mermaid"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'mermaid',
        class: 'kivi-mermaid-block',
      }),
      ['code', {}, 0],
    ];
  },

  addCommands() {
    return {
      insertMermaid:
        (code?: string) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            content: [{ type: 'text', text: code || 'graph TD\n  A --> B' }],
          });
        },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const container = document.createElement('div');
      container.className = 'kivi-mermaid-block';

      const preview = document.createElement('div');
      preview.className = 'kivi-mermaid-preview';
      container.appendChild(preview);

      const codeEl = document.createElement('pre');
      codeEl.className = 'kivi-mermaid-source';
      codeEl.style.display = 'none';
      const codeContent = document.createElement('code');
      codeEl.appendChild(codeContent);
      container.appendChild(codeEl);

      let editing = false;

      const renderDiagram = async () => {
        const text = node.textContent;
        if (!text.trim()) {
          preview.innerHTML = '<div class="kivi-mermaid-empty">Empty mermaid diagram</div>';
          return;
        }

        await ensureMermaid();
        if (!mermaidLib) {
          preview.innerHTML = `<pre class="kivi-math-fallback">${escapeHtml(text)}</pre>`;
          return;
        }

        try {
          const id = `kivi-mermaid-${++renderCounter}`;
          const { svg } = await mermaidLib.render(id, text);
          preview.innerHTML = svg;
        } catch {
          preview.innerHTML = `<div class="kivi-mermaid-error">Invalid mermaid syntax</div><pre class="kivi-math-fallback">${escapeHtml(text)}</pre>`;
        }
      };

      const toggleEdit = () => {
        editing = !editing;
        if (editing) {
          codeContent.textContent = node.textContent;
          codeEl.style.display = 'block';
          preview.style.display = 'none';
          codeEl.contentEditable = 'true';
          codeEl.focus();
        } else {
          codeEl.style.display = 'none';
          preview.style.display = 'block';
          codeEl.contentEditable = 'false';

          const newText = codeContent.textContent || '';
          if (typeof getPos === 'function') {
            const pos = getPos();
            if (pos !== undefined) {
              const tr = editor.state.tr;
              tr.replaceWith(
                pos + 1,
                pos + node.nodeSize - 1,
                newText ? editor.state.schema.text(newText) : editor.state.schema.text(' '),
              );
              editor.view.dispatch(tr);
            }
          }
          renderDiagram();
        }
      };

      preview.addEventListener('click', toggleEdit);
      codeEl.addEventListener('blur', () => {
        if (editing) toggleEdit();
      });

      renderDiagram();

      return {
        dom: container,
        contentDOM: undefined,
        update(updatedNode) {
          if (updatedNode.type !== node.type) return false;
          node = updatedNode;
          if (!editing) renderDiagram();
          return true;
        },
      };
    };
  },
});

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
