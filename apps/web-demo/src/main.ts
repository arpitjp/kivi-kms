import { createKiviEditor, applyTheme, allThemes } from '@kivi/editor-core';
import type { KiviTheme } from '@kivi/shared-types';
import { Vault, GraphRenderer } from '@kivi/vault';

const SAMPLE_FILES: Record<string, string> = {
  'welcome.md': `# Welcome to Kivi

This is a **WYSIWYG** Markdown editor with *lossless* round-trip editing.

See also: [[features]] and [[getting-started]]

## Tags

#editor #markdown #demo

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
`,

  'features.md': `# Features

Kivi supports all CommonMark and GFM features with lossless round-trip editing.

See [[welcome]] for an introduction.

## Inline Formatting

- **Bold** and *italic*
- ~~Strikethrough~~ and \`inline code\`
- [[wiki-links]] to other pages

## Tags

#editor #features

## Block Elements

- Headings (H1-H6)
- Code blocks with language
- Tables, blockquotes, horizontal rules
- Task lists and ordered/unordered lists
`,

  'getting-started.md': `# Getting Started

Welcome to [[welcome|Kivi]]! Here's how to get started.

## Installation

\`\`\`bash
pnpm install
pnpm build
\`\`\`

## Usage

Open any \`.md\` file in VS Code and reopen with Kivi Markdown Editor.

#tutorial #getting-started
`,
};

const vault = new Vault();
let currentFile = 'welcome.md';

async function main() {
  const editorEl = document.getElementById('editor')!;
  const sourceEl = document.getElementById('markdown-source')!;
  const toolbarEl = document.getElementById('toolbar')!;
  const fileListEl = document.getElementById('file-list')!;
  const backlinksListEl = document.getElementById('backlinks-list')!;
  const newFileBtn = document.getElementById('new-file-btn')!;

  const editor = createKiviEditor({ element: editorEl });

  // Initialize vault with sample files
  for (const [path, content] of Object.entries(SAMPLE_FILES)) {
    vault.addFile(path, content);
  }

  // Load initial file
  editor.loadMarkdown(SAMPLE_FILES[currentFile]);

  initToolbar(toolbarEl, editor);

  const sourceTextarea = document.createElement('textarea');
  sourceTextarea.value = SAMPLE_FILES[currentFile];
  sourceTextarea.spellcheck = false;
  sourceEl.appendChild(sourceTextarea);

  let updatingFromEditor = false;
  let updatingFromTextarea = false;

  editor.onUpdate(({ markdown }) => {
    if (updatingFromTextarea) return;
    updatingFromEditor = true;
    sourceTextarea.value = markdown;
    // Update vault index for current file
    vault.updateFile(currentFile, markdown);
    renderBacklinks();
    updatingFromEditor = false;
  });

  sourceTextarea.addEventListener('input', () => {
    if (updatingFromEditor) return;
    updatingFromTextarea = true;
    editor.loadMarkdown(sourceTextarea.value);
    vault.updateFile(currentFile, sourceTextarea.value);
    renderBacklinks();
    updatingFromTextarea = false;
  });

  function loadFile(filename: string) {
    const file = vault.getFile(filename);
    if (!file) return;
    // Save current changes
    vault.updateFile(currentFile, editor.getMarkdown());
    currentFile = filename;

    const content = SAMPLE_FILES[filename] ?? editor.getMarkdown();
    editor.loadMarkdown(content);
    sourceTextarea.value = content;
    renderFileList();
    renderBacklinks();
    if (typeof renderBreadcrumbs === 'function') renderBreadcrumbs();
  }

  // Forward declaration for breadcrumb rendering
  // eslint-disable-next-line prefer-const
  let renderBreadcrumbs: (() => void) | undefined;

  function renderFileList() {
    fileListEl.innerHTML = '';
    for (const [path] of vault.files) {
      const item = document.createElement('div');
      item.className = 'file-item' + (path === currentFile ? ' active' : '');
      item.textContent = vault.getFile(path)?.title || path;
      item.title = path;
      item.addEventListener('click', () => loadFile(path));
      fileListEl.appendChild(item);
    }
  }

  function renderBacklinks() {
    backlinksListEl.innerHTML = '';
    const backlinks = vault.getBacklinks(currentFile);
    if (backlinks.length === 0) {
      backlinksListEl.innerHTML = '<div class="empty-state">No backlinks</div>';
      return;
    }
    for (const bl of backlinks) {
      const item = document.createElement('div');
      item.className = 'backlink-item';
      item.textContent = bl.title;
      item.title = bl.path;
      item.addEventListener('click', () => loadFile(bl.path));
      backlinksListEl.appendChild(item);
    }
  }

  newFileBtn.addEventListener('click', () => {
    const name = prompt('File name (e.g. my-note.md):');
    if (!name) return;
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    if (vault.files.has(filename)) {
      loadFile(filename);
      return;
    }
    const content = `# ${filename.replace(/\.md$/, '')}\n\n`;
    SAMPLE_FILES[filename] = content;
    vault.addFile(filename, content);
    loadFile(filename);
  });

  // Outline panel
  const outlineListEl = document.getElementById('outline-list')!;
  const tiptap = editor.getTiptapEditor();

  function renderOutline() {
    outlineListEl.innerHTML = '';
    const outline = editor.getOutline();
    if (outline.length === 0) {
      outlineListEl.innerHTML = '<div class="empty-state">No headings</div>';
      return;
    }
    for (const heading of outline) {
      const item = document.createElement('div');
      item.className = 'outline-item';
      item.setAttribute('data-level', String(heading.level));
      item.textContent = heading.text;
      item.addEventListener('click', () => {
        editor.getTiptapEditor().commands.focus();
        const resolvedPos = editor.getTiptapEditor().state.doc.resolve(heading.pos + 1);
        editor.getTiptapEditor().commands.setTextSelection(resolvedPos.pos);
        const dom = editor.getTiptapEditor().view.domAtPos(heading.pos + 1);
        if (dom.node instanceof HTMLElement) {
          dom.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (dom.node.parentElement) {
          dom.node.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      outlineListEl.appendChild(item);
    }
  }

  tiptap.on('update', renderOutline);
  renderOutline();

  // Breadcrumbs
  const breadcrumbsEl = document.getElementById('breadcrumbs')!;

  renderBreadcrumbs = function renderBreadcrumbsFn() {
    breadcrumbsEl.innerHTML = '';
    const chain: string[] = [];
    let current: string | undefined = currentFile;

    while (current) {
      chain.unshift(current);
      const file = vault.getFile(current);
      current = file?.parent;
      if (chain.length > 10) break; // safety
    }

    for (let i = 0; i < chain.length; i++) {
      const filePath = chain[i];
      const file = vault.getFile(filePath);
      const title = file?.title || filePath;

      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '›';
        breadcrumbsEl.appendChild(sep);
      }

      if (i === chain.length - 1) {
        const span = document.createElement('span');
        span.className = 'breadcrumb-current';
        span.textContent = title;
        breadcrumbsEl.appendChild(span);
      } else {
        const link = document.createElement('span');
        link.className = 'breadcrumb-item';
        link.textContent = title;
        link.addEventListener('click', () => loadFile(filePath));
        breadcrumbsEl.appendChild(link);
      }
    }
  }

  renderFileList();
  renderBacklinks();
  renderBreadcrumbs();
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

  // Graph view toggle
  const graphBtn = document.createElement('button');
  graphBtn.className = 'toolbar-btn';
  graphBtn.title = 'Graph View';
  graphBtn.textContent = '◎';
  let graphRenderer: GraphRenderer | null = null;

  graphBtn.addEventListener('click', () => {
    const overlay = document.getElementById('graph-overlay')!;
    const graphContainer = document.getElementById('graph-container')!;

    if (overlay.style.display === 'none') {
      overlay.style.display = 'flex';
      if (!graphRenderer) {
        graphRenderer = new GraphRenderer(graphContainer, {
          onNodeClick: (nodeId) => {
            overlay.style.display = 'none';
            loadFile(nodeId);
          },
        });
      }
      const { nodes, edges } = vault.getGraph();
      graphRenderer.setData(nodes, edges);
      graphRenderer.resize(graphContainer.clientWidth, graphContainer.clientHeight);
    } else {
      overlay.style.display = 'none';
    }
  });

  document.getElementById('close-graph')!.addEventListener('click', () => {
    document.getElementById('graph-overlay')!.style.display = 'none';
  });

  el.appendChild(graphBtn);

  // Theme picker
  const sep = document.createElement('span');
  sep.className = 'toolbar-sep';
  el.appendChild(sep);

  const themeSelect = document.createElement('select');
  themeSelect.className = 'theme-picker';
  themeSelect.title = 'Theme';
  for (const t of allThemes) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
    themeSelect.appendChild(opt);
  }

  const savedTheme = (localStorage.getItem('kivi-theme') as KiviTheme) || 'dark';
  themeSelect.value = savedTheme;
  applyTheme(document.documentElement, savedTheme);

  themeSelect.addEventListener('change', () => {
    const theme = themeSelect.value as KiviTheme;
    applyTheme(document.documentElement, theme);
    localStorage.setItem('kivi-theme', theme);
  });

  el.appendChild(themeSelect);
}

main();
