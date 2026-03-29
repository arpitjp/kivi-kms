import { createKiviEditor } from '@kivi/editor-core';

const SAMPLE_MARKDOWN = `# Welcome to Kivi

This is a **WYSIWYG** Markdown editor with *lossless* round-trip editing.

## Features

- Bold, italic, and ~~strikethrough~~
- [Links](https://example.com) and images
- Code blocks with syntax highlighting

\`\`\`typescript
const editor = createKiviEditor({ element: document.getElementById('editor')! });
editor.loadMarkdown(source);
\`\`\`

> Blockquotes are supported too.

1. Ordered lists
2. With numbering
3. Preserved exactly

---

That's it for now. Start editing!
`;

async function main() {
  const editorEl = document.getElementById('editor')!;
  const sourceEl = document.getElementById('markdown-source')!;
  const toolbarEl = document.getElementById('toolbar')!;

  const editor = createKiviEditor({ element: editorEl });
  editor.loadMarkdown(SAMPLE_MARKDOWN);

  initToolbar(toolbarEl, editor);

  const sourceTextarea = document.createElement('textarea');
  sourceTextarea.value = SAMPLE_MARKDOWN;
  sourceTextarea.spellcheck = false;
  sourceEl.appendChild(sourceTextarea);

  editor.onUpdate(({ markdown }) => {
    sourceTextarea.value = markdown;
  });

  sourceTextarea.addEventListener('input', () => {
    editor.loadMarkdown(sourceTextarea.value);
  });
}

function initToolbar(el: HTMLElement, editor: ReturnType<typeof createKiviEditor>) {
  const tiptap = editor.getTiptapEditor();

  const actions = [
    { id: 'bold', icon: 'B', title: 'Bold', cmd: () => tiptap.chain().focus().toggleBold().run(), active: () => tiptap.isActive('bold') },
    { id: 'italic', icon: 'I', title: 'Italic', cmd: () => tiptap.chain().focus().toggleItalic().run(), active: () => tiptap.isActive('italic') },
    { id: 'strike', icon: 'S̶', title: 'Strikethrough', cmd: () => tiptap.chain().focus().toggleStrike().run(), active: () => tiptap.isActive('strike') },
    { id: 'code', icon: '‹›', title: 'Code', cmd: () => tiptap.chain().focus().toggleCode().run(), active: () => tiptap.isActive('code') },
    { id: 'sep' },
    { id: 'h1', icon: 'H1', title: 'Heading 1', cmd: () => tiptap.chain().focus().toggleHeading({ level: 1 }).run(), active: () => tiptap.isActive('heading', { level: 1 }) },
    { id: 'h2', icon: 'H2', title: 'Heading 2', cmd: () => tiptap.chain().focus().toggleHeading({ level: 2 }).run(), active: () => tiptap.isActive('heading', { level: 2 }) },
    { id: 'h3', icon: 'H3', title: 'Heading 3', cmd: () => tiptap.chain().focus().toggleHeading({ level: 3 }).run(), active: () => tiptap.isActive('heading', { level: 3 }) },
    { id: 'sep' },
    { id: 'bullet', icon: '•', title: 'Bullet List', cmd: () => tiptap.chain().focus().toggleBulletList().run(), active: () => tiptap.isActive('bulletList') },
    { id: 'ordered', icon: '1.', title: 'Ordered List', cmd: () => tiptap.chain().focus().toggleOrderedList().run(), active: () => tiptap.isActive('orderedList') },
    { id: 'task', icon: '☑', title: 'Task List', cmd: () => tiptap.chain().focus().toggleTaskList().run(), active: () => tiptap.isActive('taskList') },
    { id: 'sep' },
    { id: 'quote', icon: '❝', title: 'Blockquote', cmd: () => tiptap.chain().focus().toggleBlockquote().run(), active: () => tiptap.isActive('blockquote') },
    { id: 'codeblock', icon: '{ }', title: 'Code Block', cmd: () => tiptap.chain().focus().toggleCodeBlock().run(), active: () => tiptap.isActive('codeBlock') },
    { id: 'hr', icon: '—', title: 'Horizontal Rule', cmd: () => tiptap.chain().focus().setHorizontalRule().run(), active: () => false },
  ];

  for (const action of actions) {
    if (action.id === 'sep') {
      const sep = document.createElement('span');
      sep.className = 'toolbar-sep';
      el.appendChild(sep);
      continue;
    }

    const btn = document.createElement('button');
    btn.className = 'toolbar-btn';
    btn.title = action.title || '';
    btn.textContent = action.icon || '';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      action.cmd?.();
    });
    el.appendChild(btn);
  }

  const update = () => {
    const buttons = el.querySelectorAll<HTMLButtonElement>('.toolbar-btn');
    let i = 0;
    for (const action of actions) {
      if (action.id === 'sep') continue;
      const btn = buttons[i++];
      if (btn && action.active) {
        btn.classList.toggle('active', action.active());
      }
    }
  };

  tiptap.on('selectionUpdate', update);
  tiptap.on('update', update);
}

main();
