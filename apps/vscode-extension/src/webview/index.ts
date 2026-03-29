import { createKiviEditor, KiviEditor } from '@kivi/editor-core';
import './styles.css';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface VsCodeMessage {
  type: 'load' | 'externalChange' | 'themeChanged';
  content?: string;
}

const vscode = acquireVsCodeApi();

let editor: KiviEditor | null = null;
let isUpdatingFromExtension = false;
let lastSentContent = '';

function init() {
  const editorEl = document.getElementById('editor');
  if (!editorEl) return;

  const toolbarEl = document.createElement('div');
  toolbarEl.id = 'kivi-toolbar';

  const iconUri = document.body.dataset.iconUri;
  if (iconUri) {
    const brand = document.createElement('span');
    brand.className = 'kivi-toolbar-brand';
    const img = document.createElement('img');
    img.src = iconUri;
    img.alt = 'Kivi';
    img.width = 18;
    img.height = 18;
    brand.appendChild(img);
    const label = document.createElement('span');
    label.textContent = 'Kivi';
    brand.appendChild(label);
    toolbarEl.appendChild(brand);

    const sep = document.createElement('span');
    sep.className = 'kivi-toolbar-sep';
    toolbarEl.appendChild(sep);
  }

  document.body.insertBefore(toolbarEl, editorEl);

  createSearchBar();

  editor = createKiviEditor({
    element: editorEl,
    autoFocus: true,
    editorClass: 'kivi-vscode-editor',
  });

  initToolbar(toolbarEl);

  editor.onUpdate(({ markdown }) => {
    if (isUpdatingFromExtension) return;
    if (markdown === lastSentContent) return;
    lastSentContent = markdown;
    vscode.postMessage({ type: 'edit', content: markdown });
  });

  window.addEventListener('message', (event: MessageEvent<VsCodeMessage>) => {
    const msg = event.data;
    if (!editor) return;

    switch (msg.type) {
      case 'load':
      case 'externalChange':
        if (msg.content !== undefined) {
          isUpdatingFromExtension = true;
          lastSentContent = msg.content;
          editor.loadMarkdown(msg.content);
          isUpdatingFromExtension = false;
        }
        break;
      case 'themeChanged':
        break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      toggleSearchBar();
    }
  });

  vscode.postMessage({ type: 'ready' });
}

function initToolbar(el: HTMLElement) {
  if (!editor) return;
  const tiptap = editor.getTiptapEditor();

  const actions = [
    { id: 'bold', icon: 'B', title: 'Bold (⌘B)', cmd: () => tiptap.chain().focus().toggleBold().run(), active: () => tiptap.isActive('bold') },
    { id: 'italic', icon: 'I', title: 'Italic (⌘I)', cmd: () => tiptap.chain().focus().toggleItalic().run(), active: () => tiptap.isActive('italic') },
    { id: 'strike', icon: 'S̶', title: 'Strikethrough (⌘⇧X)', cmd: () => tiptap.chain().focus().toggleStrike().run(), active: () => tiptap.isActive('strike') },
    { id: 'code', icon: '‹›', title: 'Code (⌘E)', cmd: () => tiptap.chain().focus().toggleCode().run(), active: () => tiptap.isActive('code') },
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
      sep.className = 'kivi-toolbar-sep';
      el.appendChild(sep);
      continue;
    }

    const btn = document.createElement('button');
    btn.className = 'kivi-toolbar-btn';
    btn.title = action.title || '';
    btn.textContent = action.icon || '';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      action.cmd?.();
    });
    el.appendChild(btn);
  }

  const update = () => {
    const buttons = el.querySelectorAll<HTMLButtonElement>('.kivi-toolbar-btn');
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

let searchBarVisible = false;

function createSearchBar() {
  const bar = document.createElement('div');
  bar.id = 'kivi-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <input type="text" id="kivi-search-input" placeholder="Search..." />
    <button id="kivi-search-prev" title="Previous (⇧Enter)">↑</button>
    <button id="kivi-search-next" title="Next (Enter)">↓</button>
    <label><input type="checkbox" id="kivi-search-case" /> Aa</label>
    <label><input type="checkbox" id="kivi-search-regex" /> .*</label>
    <label><input type="checkbox" id="kivi-search-word" /> \\b</label>
    <span id="kivi-search-count"></span>
    <input type="text" id="kivi-replace-input" placeholder="Replace..." />
    <button id="kivi-replace-one" title="Replace">⏎</button>
    <button id="kivi-replace-all" title="Replace All">⏎⏎</button>
    <button id="kivi-search-close" title="Close (Esc)">✕</button>
  `;
  document.body.insertBefore(bar, document.getElementById('editor'));

  const searchInput = bar.querySelector<HTMLInputElement>('#kivi-search-input')!;
  const replaceInput = bar.querySelector<HTMLInputElement>('#kivi-replace-input')!;
  const caseCheck = bar.querySelector<HTMLInputElement>('#kivi-search-case')!;
  const regexCheck = bar.querySelector<HTMLInputElement>('#kivi-search-regex')!;
  const wordCheck = bar.querySelector<HTMLInputElement>('#kivi-search-word')!;

  const doSearch = () => {
    if (!editor) return;
    const query = searchInput.value;
    if (!query) {
      editor.clearSearch();
      return;
    }
    editor.search({
      query,
      caseSensitive: caseCheck.checked,
      regex: regexCheck.checked,
      wholeWord: wordCheck.checked,
    });
  };

  searchInput.addEventListener('input', doSearch);
  caseCheck.addEventListener('change', doSearch);
  regexCheck.addEventListener('change', doSearch);
  wordCheck.addEventListener('change', doSearch);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      editor?.nextSearchResult();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      editor?.previousSearchResult();
    } else if (e.key === 'Escape') {
      toggleSearchBar();
    }
  });

  bar.querySelector('#kivi-search-next')!.addEventListener('click', () => editor?.nextSearchResult());
  bar.querySelector('#kivi-search-prev')!.addEventListener('click', () => editor?.previousSearchResult());
  bar.querySelector('#kivi-search-close')!.addEventListener('click', () => toggleSearchBar());

  bar.querySelector('#kivi-replace-one')!.addEventListener('click', () => {
    const tiptap = editor?.getTiptapEditor();
    if (tiptap) {
      (tiptap.commands as Record<string, (...args: unknown[]) => boolean>)['replaceCurrentResult'](replaceInput.value);
    }
  });

  bar.querySelector('#kivi-replace-all')!.addEventListener('click', () => {
    const tiptap = editor?.getTiptapEditor();
    if (tiptap) {
      (tiptap.commands as Record<string, (...args: unknown[]) => boolean>)['replaceAllResults'](replaceInput.value);
    }
  });
}

function toggleSearchBar() {
  const bar = document.getElementById('kivi-search-bar');
  if (!bar) return;

  searchBarVisible = !searchBarVisible;
  bar.style.display = searchBarVisible ? 'flex' : 'none';

  if (searchBarVisible) {
    const input = bar.querySelector<HTMLInputElement>('#kivi-search-input');
    input?.focus();
    input?.select();
  } else {
    editor?.clearSearch();
    editor?.focus();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
