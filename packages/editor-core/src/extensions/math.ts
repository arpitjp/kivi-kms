import { Node, mergeAttributes } from '@tiptap/core';

let katexModule: typeof import('katex') | null = null;
let katexLoading: Promise<void> | null = null;
const katexReadyCallbacks: (() => void)[] = [];

function ensureKatex(): Promise<void> {
  if (katexModule) return Promise.resolve();
  if (!katexLoading) {
    katexLoading = import('katex').then((mod) => {
      katexModule = mod;
      for (const cb of katexReadyCallbacks.splice(0)) cb();
    });
  }
  return katexLoading;
}

function onKatexReady(cb: () => void) {
  if (katexModule) { cb(); return; }
  katexReadyCallbacks.push(cb);
  ensureKatex();
}

export interface MathBlockOptions {
  HTMLAttributes: Record<string, string>;
  renderMath: ((latex: string, displayMode: boolean) => string) | null;
}

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
    return ({ node, editor, getPos }) => {
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

      let editing = false;

      const render = () => {
        const latex = node.textContent;
        if (!editing && renderMath && latex) {
          try {
            preview.innerHTML = renderMath(latex, true);
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

      preview.addEventListener('click', () => {
        editing = true;
        preview.style.display = 'none';
        source.style.display = '';
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos != null) {
          editor.commands.setTextSelection(pos + 1);
          editor.commands.focus();
        }
      });

      const handleBlur = () => {
        if (!editing) return;
        editing = false;
        render();
      };

      code.addEventListener('focusout', handleBlur);

      render();
      if (!katexModule) onKatexReady(render);

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
  renderMath: ((latex: string, displayMode: boolean) => string) | null;
}

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
    return ({ node, editor, getPos }) => {
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

      let editing = false;

      const render = () => {
        const latex = node.textContent;
        if (!editing && renderMath && latex) {
          try {
            preview.innerHTML = renderMath(latex, false);
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

      preview.addEventListener('click', () => {
        editing = true;
        preview.style.display = 'none';
        source.style.display = '';
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos != null) {
          editor.commands.setTextSelection(pos + 1);
          editor.commands.focus();
        }
      });

      source.addEventListener('focusout', () => {
        if (!editing) return;
        editing = false;
        render();
      });

      render();
      if (!katexModule) onKatexReady(render);

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

function defaultRenderMath(latex: string, displayMode: boolean): string {
  if (!katexModule) return '';
  const k = katexModule.default ?? katexModule;
  return (k as any).renderToString(latex, { throwOnError: false, displayMode });
}
