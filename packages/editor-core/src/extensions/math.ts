import { Node, mergeAttributes } from '@tiptap/core';

export interface MathBlockOptions {
  HTMLAttributes: Record<string, string>;
  renderMath: ((latex: string) => string) | null;
}

/**
 * Block-level math ($$...$$).
 * If KaTeX is available, renders the math visually.
 * Falls back to displaying raw LaTeX in a code block.
 */
export const MathBlock = Node.create<MathBlockOptions>({
  name: 'mathBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  defining: true,
  code: true,
  atom: false,

  addOptions() {
    return {
      HTMLAttributes: {},
      renderMath: defaultRenderMath,
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="math-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'math-block',
        class: 'kivi-math-block',
      }),
      ['pre', { class: 'kivi-math-source' }, ['code', {}, 0]],
    ];
  },

  addNodeView() {
    const renderMath = this.options.renderMath;
    return ({ node }) => {
      const container = document.createElement('div');
      container.classList.add('kivi-math-block');
      container.dataset.type = 'math-block';

      const preview = document.createElement('div');
      preview.classList.add('kivi-math-preview');
      preview.contentEditable = 'false';

      const source = document.createElement('pre');
      source.classList.add('kivi-math-source');
      const code = document.createElement('code');
      source.appendChild(code);

      container.appendChild(preview);
      container.appendChild(source);

      const render = () => {
        const latex = node.textContent;
        if (renderMath && latex) {
          try {
            preview.innerHTML = renderMath(latex);
            preview.style.display = '';
            source.style.display = 'none';
          } catch {
            preview.style.display = 'none';
            source.style.display = '';
          }
        } else {
          preview.style.display = 'none';
          source.style.display = '';
        }
      };

      render();

      return {
        dom: container,
        contentDOM: code,
        update(updatedNode) {
          if (updatedNode.type.name !== 'mathBlock') return false;
          node = updatedNode;
          render();
          return true;
        },
      };
    };
  },
});

export interface MathInlineOptions {
  HTMLAttributes: Record<string, string>;
  renderMath: ((latex: string) => string) | null;
}

/**
 * Inline math ($...$).
 */
export const MathInline = Node.create<MathInlineOptions>({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  content: 'text*',
  marks: '',
  atom: false,
  code: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      renderMath: defaultRenderMath,
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="math-inline"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'math-inline',
        class: 'kivi-math-inline',
      }),
      0,
    ];
  },

  addNodeView() {
    const renderMath = this.options.renderMath;
    return ({ node }) => {
      const container = document.createElement('span');
      container.classList.add('kivi-math-inline');
      container.dataset.type = 'math-inline';

      const preview = document.createElement('span');
      preview.classList.add('kivi-math-preview');
      preview.contentEditable = 'false';

      const source = document.createElement('code');
      source.classList.add('kivi-math-source');

      container.appendChild(preview);
      container.appendChild(source);

      const render = () => {
        const latex = node.textContent;
        if (renderMath && latex) {
          try {
            preview.innerHTML = renderMath(latex);
            preview.style.display = '';
            source.style.display = 'none';
          } catch {
            preview.style.display = 'none';
            source.style.display = '';
          }
        } else {
          preview.style.display = 'none';
          source.style.display = '';
        }
      };

      render();

      return {
        dom: container,
        contentDOM: source,
        update(updatedNode) {
          if (updatedNode.type.name !== 'mathInline') return false;
          node = updatedNode;
          render();
          return true;
        },
      };
    };
  },
});

/**
 * Default math renderer using KaTeX if available on window.
 * In a browser environment where katex is loaded, this renders real math.
 * Otherwise returns null and the node view falls back to source display.
 */
function defaultRenderMath(latex: string): string {
  const w = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : null;
  if (w && typeof w['katex'] === 'object' && w['katex'] !== null) {
    const katex = w['katex'] as { renderToString: (tex: string, opts?: Record<string, unknown>) => string };
    return katex.renderToString(latex, { throwOnError: false, displayMode: true });
  }
  // Return escaped HTML as fallback
  return `<code class="kivi-math-fallback">${escapeHtml(latex)}</code>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
