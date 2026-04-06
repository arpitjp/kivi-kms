import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { positionFixedPopup } from '../zoom.js';

export interface SlashCommandItem {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  icon: string;
  category: string;
  action: (editor: Editor) => void;
}

function buildDefaultItems(
  promptInput?: (msg: string, placeholder?: string) => Promise<string | null>,
  createExcalidrawFile?: (name: string) => Promise<string | null>,
  onInsertAsset?: () => void,
): SlashCommandItem[] {
  const items: SlashCommandItem[] = [
    // ── Basic blocks ─────────────────────────────────────────
    { id: 'h1', label: 'Heading 1', description: 'Large section heading', aliases: ['h1', 'heading1', '#'], icon: 'H1', category: 'Basic', action: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
    { id: 'h2', label: 'Heading 2', description: 'Medium section heading', aliases: ['h2', 'heading2', '##'], icon: 'H2', category: 'Basic', action: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
    { id: 'h3', label: 'Heading 3', description: 'Small section heading', aliases: ['h3', 'heading3', '###'], icon: 'H3', category: 'Basic', action: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
    { id: 'bullet', label: 'Bullet List', description: 'Unordered list with bullets', aliases: ['ul', 'bullet', 'list', '-'], icon: '•', category: 'Basic', action: (e) => e.chain().focus().toggleBulletList().run() },
    { id: 'ordered', label: 'Numbered List', description: 'Ordered list with numbers', aliases: ['ol', 'num', 'numbered', '1.'], icon: '1.', category: 'Basic', action: (e) => e.chain().focus().toggleOrderedList().run() },
    { id: 'task', label: 'Task List', description: 'Checklist with checkboxes', aliases: ['todo', 'task', 'check', 'checkbox', '[]'], icon: '☑', category: 'Basic', action: (e) => e.chain().focus().toggleTaskList().run() },
    { id: 'quote', label: 'Blockquote', description: 'Quoted text block', aliases: ['quote', 'blockquote', 'bq', '>'], icon: '❝', category: 'Basic', action: (e) => e.chain().focus().toggleBlockquote().run() },
    { id: 'code', label: 'Code Block', description: 'Fenced code with syntax highlighting', aliases: ['code', 'codeblock', 'cb', 'fence', '```'], icon: '{ }', category: 'Basic', action: (e) => e.chain().focus().toggleCodeBlock().run() },
    { id: 'hr', label: 'Divider', description: 'Horizontal rule separator', aliases: ['hr', 'divider', 'line', 'separator', '---'], icon: '—', category: 'Basic', action: (e) => e.chain().focus().setHorizontalRule().run() },
    { id: 'callout', label: 'Callout', description: 'Highlighted note, tip, or warning', aliases: ['callout', 'note', 'tip', 'warning', 'info', 'admonition'], icon: '💡', category: 'Basic', action: (e) => {
      e.chain().focus().toggleBlockquote().run();
      requestAnimationFrame(() => {
        const { from } = e.state.selection;
        const $pos = e.state.doc.resolve(from);
        if ($pos.parent.textContent === '') {
          e.chain().insertContentAt(from, '[!note] ').run();
        }
      });
    }},

    // ── Media ─────────────────────────────────────────────────
  ];

  // Unified asset picker — opens native file dialog, auto-detects type,
  // copies external files into workspace, inserts the right markdown.
  if (onInsertAsset) {
    const cb = onInsertAsset;
    items.push({
      id: 'asset', label: 'Insert File', description: 'Image, video, diagram, or any file from disk',
      aliases: ['asset', 'file', 'image', 'img', 'video', 'pic', 'photo', 'attach', 'embed', 'media', 'upload'],
      icon: '📎', category: 'Media', action: () => cb(),
    });
  }

  // Individual media commands still available for URL/path input
  items.push(
    { id: 'image', label: 'Image (URL)', description: 'Embed an image by URL or path', aliases: ['img-url', 'image-url'], icon: '🖼', category: 'Media', action: (e) => {
      if (promptInput) {
        promptInput('Image URL or relative path:', 'https://... or assets/photo.png').then(url => { if (url) e.chain().focus().setImage({ src: url }).run(); });
      } else {
        const url = window.prompt('Image URL:');
        if (url) e.chain().focus().setImage({ src: url }).run();
      }
    }},
    { id: 'video', label: 'Video (URL)', description: 'Embed a video by URL or path', aliases: ['vid-url', 'video-url'], icon: '▶', category: 'Media', action: (e) => {
      if (promptInput) {
        promptInput('Video URL or path:', 'https://... or assets/clip.mp4').then(url => { if (url) e.chain().focus().insertContent(`<video src="${url}" controls style="max-width:100%"></video>`).run(); });
      } else {
        const url = window.prompt('Video URL or path:');
        if (url) e.chain().focus().insertContent(`<video src="${url}" controls style="max-width:100%"></video>`).run();
      }
    }},
    { id: 'excalidraw', label: 'Excalidraw', description: 'Create an Excalidraw diagram', aliases: ['excalidraw', 'draw', 'diagram', 'sketch', 'whiteboard'], icon: '✎', category: 'Media', action: (e) => {
      if (createExcalidrawFile && promptInput) {
        promptInput('Diagram name (blank for auto):', 'diagram').then(async (raw) => {
          if (raw === null) return;
          const name = raw.trim() || `diagram-${Date.now()}`;
          const relPath = await createExcalidrawFile(name);
          if (!relPath) return;
          const alt = name.replace(/\.excalidraw$/i, '');
          e.chain().focus().insertContent({ type: 'excalidrawBlock', attrs: { src: relPath, data: '{}', alt } }).run();
        });
      } else if (promptInput) {
        promptInput('Diagram name (blank for auto):', 'diagram').then(raw => {
          if (raw === null) return;
          const name = raw.trim() || `diagram-${Date.now()}`;
          const fileName = name.endsWith('.excalidraw') ? name : `${name}.excalidraw`;
          const alt = name.replace(/\.excalidraw$/i, '');
          e.chain().focus().insertContent({ type: 'excalidrawBlock', attrs: { src: fileName, data: '{}', alt } }).run();
        });
      } else {
        e.chain().focus().insertContent({ type: 'excalidrawBlock', attrs: { data: '{}' } }).run();
      }
    }},
  );

  // ── Advanced ──────────────────────────────────────────────
  items.push(
    { id: 'table', label: 'Table', description: 'Insert a 3x3 table', aliases: ['table', 'grid'], icon: '⊞', category: 'Advanced', action: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3 }).run() },
    { id: 'math', label: 'Math Block', description: 'LaTeX math equation', aliases: ['math', 'latex', 'equation', 'formula', 'katex'], icon: '∑', category: 'Advanced', action: (e) => e.chain().focus().insertContent({ type: 'mathBlock', content: [{ type: 'text', text: 'E = mc^2' }] }).run() },
    { id: 'toc', label: 'Table of Contents', description: 'Auto-generated from headings', aliases: ['toc', 'contents', 'outline'], icon: '☰', category: 'Advanced', action: (e) => e.chain().focus().insertContent({ type: 'tocBlock' }).run() },
    { id: 'link', label: 'Link', description: 'Insert a hyperlink', aliases: ['link', 'url', 'href', 'a'], icon: '🔗', category: 'Advanced', action: (e) => {
      if (promptInput) {
        promptInput('Link URL:', 'https://...').then(url => {
          if (!url) return;
          promptInput('Link text (blank to use URL):', '').then(text => {
            const label = text?.trim() || url;
            e.chain().focus().insertContent(`<a href="${url}">${label}</a>`).run();
          });
        });
      } else {
        const url = window.prompt('Link URL:');
        if (url) {
          const text = window.prompt('Link text (blank to use URL):') || url;
          e.chain().focus().insertContent(`<a href="${url}">${text}</a>`).run();
        }
      }
    }},
  );

  return items;
}

export interface SlashCommandsOptions {
  items?: SlashCommandItem[];
  onCreatePage?: () => void;
  /** Open native file picker, copy-if-external, and return markdown snippet to insert. */
  onInsertAsset?: () => void;
  /** Async input prompt — use instead of window.prompt() for sandboxed envs. */
  promptInput?: (message: string, placeholder?: string) => Promise<string | null>;
  /** Create an .excalidraw file and return its relative path from the doc. */
  createExcalidrawFile?: (name: string) => Promise<string | null>;
}

const slashPluginKey = new PluginKey('slashCommands');

export const SlashCommands = Extension.create<SlashCommandsOptions>({
  name: 'slashCommands',

  addOptions() {
    return { items: undefined, onCreatePage: undefined };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    const baseItems = opts.items ?? buildDefaultItems(opts.promptInput, opts.createExcalidrawFile, opts.onInsertAsset);

    const items: SlashCommandItem[] = [...baseItems];
    if (opts.onCreatePage) {
      const cb = opts.onCreatePage;
      items.push({
        id: 'newpage',
        label: 'Child Page',
        description: 'Create a new linked sub-page',
        aliases: ['page', 'new', 'create', 'subpage', 'child'],
        icon: '📄',
        category: 'Advanced',
        action: () => cb(),
      });
    }

    const editor = this.editor;

    let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

    return [
      new Plugin({
        key: slashPluginKey,
        view() {
          return {
            destroy() {
              if (pendingTimeout !== null) {
                clearTimeout(pendingTimeout);
                pendingTimeout = null;
              }
              const existing = document.querySelector('.kivi-slash-menu');
              if (existing) existing.remove();
            },
          };
        },
        props: {
          handleKeyDown(view: EditorView, event: KeyboardEvent) {
            if (event.key !== '/') return false;

            const { state } = view;
            const { $from } = state.selection;
            const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);

            if (textBefore.trim() !== '') return false;

            if (pendingTimeout !== null) clearTimeout(pendingTimeout);
            pendingTimeout = setTimeout(() => {
              pendingTimeout = null;
              if (!view.dom.isConnected) return;
              showSlashMenu(view, items, editor);
            }, 0);
            return false;
          },
        },
      }),
    ];
  },
});

let activeSlashMenuId = 0;

function showSlashMenu(
  view: EditorView,
  items: SlashCommandItem[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any,
) {
  const existing = view.dom.closest('.ProseMirror')?.parentElement?.querySelector('.kivi-slash-menu')
    ?? document.querySelector('.kivi-slash-menu');
  if (existing) existing.remove();

  const menuId = ++activeSlashMenuId;

  const { state } = view;
  const { from } = state.selection;
  const coords = view.coordsAtPos(from);

  const menu = document.createElement('div');
  menu.className = 'kivi-slash-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Slash commands');
  menu.style.position = 'fixed';
  menu.style.zIndex = '9999';

  let selectedIndex = 0;
  let filteredItems = [...items];
  let filterText = '';

  function positionSlashMenu(c: { left: number; top: number; bottom: number }) {
    const container = view.dom.parentElement;
    const cr = container?.getBoundingClientRect() ?? null;
    positionFixedPopup({
      anchorRect: { top: c.top, bottom: c.bottom, left: c.left, right: c.left },
      popup: menu,
      containerRect: cr,
      gap: 4,
      pad: 8,
      preferY: 'below',
      anchorEl: view.dom as HTMLElement,
    });
  }

  positionSlashMenu(coords);

  function reposition() {
    if (menuId !== activeSlashMenuId) return;
    try {
      const { from: curFrom } = view.state.selection;
      const c = view.coordsAtPos(curFrom);
      positionSlashMenu(c);
    } catch {
      // view might be destroyed
    }
  }

  function render(full = true) {
    if (!full) {
      const rows = menu.querySelectorAll<HTMLElement>('.kivi-slash-item');
      rows.forEach((row, i) => {
        row.classList.toggle('selected', i === selectedIndex);
        row.setAttribute('aria-selected', String(i === selectedIndex));
      });
      const sel = menu.querySelector('.selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
      return;
    }

    menu.innerHTML = '';
    let currentCategory = '';

    filteredItems.forEach((item, idx) => {
      if (item.category !== currentCategory) {
        currentCategory = item.category;
        const cat = document.createElement('div');
        cat.className = 'kivi-slash-category';
        cat.textContent = currentCategory;
        menu.appendChild(cat);
      }

      const row = document.createElement('div');
      row.className = 'kivi-slash-item' + (idx === selectedIndex ? ' selected' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(idx === selectedIndex));

      const icon = document.createElement('span');
      icon.className = 'kivi-slash-icon';
      icon.textContent = item.icon;

      const labelWrap = document.createElement('span');
      labelWrap.className = 'kivi-slash-label-wrap';

      const topLine = document.createElement('span');
      topLine.className = 'kivi-slash-label-line';

      const label = document.createElement('span');
      label.className = 'kivi-slash-label';
      label.textContent = item.label;
      topLine.appendChild(label);

      if (item.aliases?.length) {
        const alias = document.createElement('span');
        alias.className = 'kivi-slash-alias';
        alias.textContent = '/' + item.aliases[0];
        topLine.appendChild(alias);
      }

      labelWrap.appendChild(topLine);

      if (item.description) {
        const desc = document.createElement('span');
        desc.className = 'kivi-slash-desc';
        desc.textContent = item.description;
        labelWrap.appendChild(desc);
      }

      row.appendChild(icon);
      row.appendChild(labelWrap);

      row.addEventListener('mouseenter', () => {
        selectedIndex = idx;
        render(false);
      });
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });
      row.addEventListener('click', () => {
        selectItem(item);
      });

      menu.appendChild(row);
    });

    if (filteredItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'kivi-slash-empty';
      empty.textContent = 'No matching commands';
      menu.appendChild(empty);
    }

    const sel = menu.querySelector('.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function selectItem(item: SlashCommandItem) {
    cleanup();
    const { state: currentState } = view;
    const { from: curFrom } = currentState.selection;
    const deleteFrom = curFrom - filterText.length - 1;
    const tr = currentState.tr.delete(Math.max(0, deleteFrom), curFrom);
    view.dispatch(tr);
    item.action(editor);
  }

  function applyFilter() {
    const q = filterText.toLowerCase();
    filteredItems = items.filter((i) =>
      i.label.toLowerCase().includes(q) ||
      i.category.toLowerCase().includes(q) ||
      i.id.toLowerCase().includes(q) ||
      (i.description?.toLowerCase().includes(q) ?? false) ||
      (i.aliases?.some((a) => a.toLowerCase().startsWith(q)) ?? false),
    );
    selectedIndex = 0;
    render();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (menuId !== activeSlashMenuId) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = (selectedIndex + 1) % Math.max(1, filteredItems.length);
      render(false);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = (selectedIndex - 1 + filteredItems.length) % Math.max(1, filteredItems.length);
      render(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (filteredItems[selectedIndex]) selectItem(filteredItems[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    } else if (e.key === 'Backspace') {
      if (filterText.length > 0) {
        filterText = filterText.slice(0, -1);
        applyFilter();
      } else {
        cleanup();
      }
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      filterText += e.key;
      applyFilter();
    }
  }

  function handleClick(e: MouseEvent) {
    if (!menu.contains(e.target as Node)) {
      cleanup();
    }
  }

  function handleScroll() {
    reposition();
  }

  function cleanup() {
    menu.remove();
    document.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('click', handleClick, true);
    window.removeEventListener('scroll', handleScroll, true);
    window.removeEventListener('resize', handleScroll);
    const sp = view.dom.parentElement;
    if (sp) sp.removeEventListener('scroll', handleScroll);
  }

  render();
  document.body.appendChild(menu);
  requestAnimationFrame(() => positionSlashMenu(coords));
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('click', handleClick, true);
  window.addEventListener('scroll', handleScroll, true);
  window.addEventListener('resize', handleScroll);
  const scrollParent = view.dom.parentElement;
  if (scrollParent) {
    scrollParent.addEventListener('scroll', handleScroll, { passive: true } as AddEventListenerOptions);
  }
}
