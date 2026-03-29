import { createKiviEditor, KiviEditor } from '@kivi/editor-core';
import './styles.css';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface KiviSettings {
  editorBackground: string;
  codeBlockBackground: string;
  accentColor: string;
  textColor: string;
  headingColor: string;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  customCSS: string;
  showToolbar: boolean;
  showLineNumbers: boolean;
}

interface VsCodeMessage {
  type: 'load' | 'externalChange' | 'themeChanged' | 'settings';
  content?: string;
  settings?: KiviSettings;
}

const vscode = acquireVsCodeApi();

let editor: KiviEditor | null = null;
let isUpdatingFromExtension = false;
let lastSentContent = '';
let overrideStyleEl: HTMLStyleElement | null = null;
let customCSSStyleEl: HTMLStyleElement | null = null;

function applySettings(s: KiviSettings) {
  if (!overrideStyleEl) {
    overrideStyleEl = document.createElement('style');
    overrideStyleEl.id = 'kivi-setting-overrides';
    document.head.appendChild(overrideStyleEl);
  }
  if (!customCSSStyleEl) {
    customCSSStyleEl = document.createElement('style');
    customCSSStyleEl.id = 'kivi-custom-css';
    document.head.appendChild(customCSSStyleEl);
  }

  const props: string[] = [];
  if (s.editorBackground) props.push(`--kivi-editor-bg: ${s.editorBackground};`);
  if (s.codeBlockBackground) props.push(`--kivi-codeblock-bg: ${s.codeBlockBackground};`);
  if (s.accentColor) props.push(`--kivi-accent: ${s.accentColor};`);
  if (s.textColor) props.push(`--kivi-text: ${s.textColor};`);
  if (s.headingColor) props.push(`--kivi-heading-color: ${s.headingColor};`);
  if (s.fontSize && s.fontSize > 0) props.push(`--kivi-font-size: ${s.fontSize}px;`);
  if (s.fontFamily) props.push(`--kivi-font-family: ${s.fontFamily};`);
  if (s.lineHeight && s.lineHeight > 0) props.push(`--kivi-line-height: ${s.lineHeight};`);

  let css = '';
  if (props.length > 0) {
    css += `:root { ${props.join(' ')} }\n`;
  }

  if (s.editorBackground) {
    css += `body { background: var(--kivi-editor-bg) !important; }\n`;
    css += `#editor { background: var(--kivi-editor-bg) !important; }\n`;
  }
  if (s.textColor) {
    css += `body { color: var(--kivi-text) !important; }\n`;
    css += `.kivi-vscode-editor { color: var(--kivi-text) !important; }\n`;
  }
  if (s.headingColor) {
    css += `.kivi-vscode-editor h1, .kivi-vscode-editor h2, .kivi-vscode-editor h3, .kivi-vscode-editor h4, .kivi-vscode-editor h5, .kivi-vscode-editor h6 { color: var(--kivi-heading-color) !important; }\n`;
  }
  if (s.codeBlockBackground) {
    css += `.kivi-vscode-editor pre { background: var(--kivi-codeblock-bg) !important; }\n`;
  }
  if (s.accentColor) {
    css += `.kivi-vscode-editor a { color: var(--kivi-accent) !important; }\n`;
    css += `.kivi-toolbar-btn.active { border-color: var(--kivi-accent) !important; }\n`;
  }
  if (s.fontSize && s.fontSize > 0) {
    css += `#editor { font-size: var(--kivi-font-size) !important; }\n`;
  }
  if (s.fontFamily) {
    css += `#editor { font-family: var(--kivi-font-family) !important; }\n`;
  }
  if (s.lineHeight && s.lineHeight > 0) {
    css += `#editor { line-height: var(--kivi-line-height) !important; }\n`;
  }

  overrideStyleEl.textContent = css;

  customCSSStyleEl.textContent = s.customCSS || '';

  const toolbar = document.getElementById('kivi-toolbar');
  if (toolbar) {
    toolbar.style.display = s.showToolbar ? '' : 'none';
  }
}

function init() {
  const editorEl = document.getElementById('editor');
  if (!editorEl) return;

  const toolbarEl = document.createElement('div');
  toolbarEl.id = 'kivi-toolbar';

  const brand = document.createElement('span');
  brand.className = 'kivi-toolbar-brand';
  brand.textContent = 'Kivi';
  toolbarEl.appendChild(brand);

  const brandSep = document.createElement('span');
  brandSep.className = 'kivi-toolbar-sep';
  toolbarEl.appendChild(brandSep);

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
      case 'settings':
        if (msg.settings) applySettings(msg.settings);
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

  const _s = (d: string) =>
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  const actions = [
    { id: 'bold', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5h4.5a3 3 0 0 1 2.12 5.12A3.25 3.25 0 0 1 9 13.5H4V2.5zM4 8h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`, title: 'Bold (⌘B)', cmd: () => tiptap.chain().focus().toggleBold().run(), active: () => tiptap.isActive('bold') },
    { id: 'italic', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="10" y1="2.5" x2="6" y2="13.5"/><line x1="7.5" y1="2.5" x2="11.5" y2="2.5"/><line x1="4.5" y1="13.5" x2="8.5" y2="13.5"/></svg>`, title: 'Italic (⌘I)', cmd: () => tiptap.chain().focus().toggleItalic().run(), active: () => tiptap.isActive('italic') },
    { id: 'strike', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="8" x2="14" y2="8" stroke-width="1.5"/><path d="M10.2 4.8C9.7 3.6 8.6 3 7.5 3 5.8 3 4.5 4 4.5 5.5c0 1 .5 1.7 1.3 2.2" stroke-width="1.6" fill="none"/><path d="M5.8 11.2c.5 1.2 1.6 1.8 2.7 1.8 1.7 0 3-1 3-2.5 0-.7-.3-1.3-.8-1.7" stroke-width="1.6" fill="none"/></svg>`, title: 'Strikethrough (⌘⇧X)', cmd: () => tiptap.chain().focus().toggleStrike().run(), active: () => tiptap.isActive('strike') },
    { id: 'code', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,3.5 1.5,8 5,12.5"/><polyline points="11,3.5 14.5,8 11,12.5"/></svg>`, title: 'Code (⌘E)', cmd: () => tiptap.chain().focus().toggleCode().run(), active: () => tiptap.isActive('code') },
    { id: 'sep' },
    { id: 'h1', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 3v10M2.5 8h5M7.5 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M11 11V6l-1.2.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`, title: 'Heading 1', cmd: () => tiptap.chain().focus().toggleHeading({ level: 1 }).run(), active: () => tiptap.isActive('heading', { level: 1 }) },
    { id: 'h2', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3v10M2 8h4.5M6.5 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M9.5 6.5a2 2 0 0 1 3.8.7c0 1.2-1.3 2.3-3.3 3.8h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`, title: 'Heading 2', cmd: () => tiptap.chain().focus().toggleHeading({ level: 2 }).run(), active: () => tiptap.isActive('heading', { level: 2 }) },
    { id: 'h3', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3v10M1.5 8h4M5.5 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M9.5 6.3a1.8 1.8 0 0 1 3.2.5 1.6 1.6 0 0 1-1.2 1.7 1.8 1.8 0 0 1 1.5 1.8 2 2 0 0 1-3.5 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`, title: 'Heading 3', cmd: () => tiptap.chain().focus().toggleHeading({ level: 3 }).run(), active: () => tiptap.isActive('heading', { level: 3 }) },
    { id: 'sep' },
    { id: 'bullet', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="4" r="1.3" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r="1.3" fill="currentColor" stroke="none"/><line x1="6.5" y1="4" x2="14" y2="4"/><line x1="6.5" y1="8" x2="14" y2="8"/><line x1="6.5" y1="12" x2="14" y2="12"/></svg>`, title: 'Bullet List', cmd: () => tiptap.chain().focus().toggleBulletList().run(), active: () => tiptap.isActive('bulletList') },
    { id: 'ordered', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-linecap="round"><text x="1.5" y="5.5" font-size="5.5" font-family="system-ui,-apple-system,sans-serif" font-weight="700" stroke="none">1</text><text x="1.5" y="9.5" font-size="5.5" font-family="system-ui,-apple-system,sans-serif" font-weight="700" stroke="none">2</text><text x="1.5" y="13.5" font-size="5.5" font-family="system-ui,-apple-system,sans-serif" font-weight="700" stroke="none">3</text><line x1="6.5" y1="4" x2="14" y2="4" stroke-width="1.6" fill="none"/><line x1="6.5" y1="8" x2="14" y2="8" stroke-width="1.6" fill="none"/><line x1="6.5" y1="12" x2="14" y2="12" stroke-width="1.6" fill="none"/></svg>`, title: 'Ordered List', cmd: () => tiptap.chain().focus().toggleOrderedList().run(), active: () => tiptap.isActive('orderedList') },
    { id: 'task', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="1.5" width="5" height="5" rx="1"/><polyline points="3,4 4,5.2 6,2.8" stroke-width="1.6"/><line x1="9" y1="4" x2="14.5" y2="4"/><rect x="1.5" y="9.5" width="5" height="5" rx="1"/><line x1="9" y1="12" x2="14.5" y2="12"/></svg>`, title: 'Task List', cmd: () => tiptap.chain().focus().toggleTaskList().run(), active: () => tiptap.isActive('taskList') },
    { id: 'sep' },
    { id: 'quote', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="1.5" y1="2.5" x2="1.5" y2="13.5" stroke-width="2.5"/><line x1="5" y1="4" x2="14" y2="4" stroke-width="1.5"/><line x1="5" y1="8" x2="11" y2="8" stroke-width="1.5"/><line x1="5" y1="12" x2="13" y2="12" stroke-width="1.5"/></svg>`, title: 'Blockquote', cmd: () => tiptap.chain().focus().toggleBlockquote().run(), active: () => tiptap.isActive('blockquote') },
    { id: 'codeblock', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="1" width="13" height="14" rx="2"/><polyline points="5.5,5.5 3.5,8 5.5,10.5"/><polyline points="10.5,5.5 12.5,8 10.5,10.5"/></svg>`, title: 'Code Block', cmd: () => tiptap.chain().focus().toggleCodeBlock().run(), active: () => tiptap.isActive('codeBlock') },
    { id: 'hr', svg: _s('<line x1="2" y1="8" x2="14" y2="8" stroke-width="1.5" stroke-dasharray="3,2"/>'), title: 'Horizontal Rule', cmd: () => tiptap.chain().focus().setHorizontalRule().run(), active: () => false },
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
    if (action.svg) btn.innerHTML = action.svg;
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
