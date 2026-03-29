import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export interface SlashCommandItem {
  id: string;
  label: string;
  aliases?: string[];
  icon: string;
  category: string;
  action: (editor: Editor) => void;
}

const defaultItems: SlashCommandItem[] = [
  { id: 'h1', label: 'Heading 1', aliases: ['h1', '#'], icon: 'H1', category: 'Basic', action: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: 'h2', label: 'Heading 2', aliases: ['h2', '##'], icon: 'H2', category: 'Basic', action: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'h3', label: 'Heading 3', aliases: ['h3', '###'], icon: 'H3', category: 'Basic', action: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'bullet', label: 'Bullet List', aliases: ['ul', 'bullet'], icon: '•', category: 'Basic', action: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'ordered', label: 'Numbered List', aliases: ['ol', 'num'], icon: '1.', category: 'Basic', action: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: 'task', label: 'Task List', aliases: ['todo', 'task', 'check'], icon: '☑', category: 'Basic', action: (e) => e.chain().focus().toggleTaskList().run() },
  { id: 'quote', label: 'Blockquote', aliases: ['quote', 'bq'], icon: '❝', category: 'Basic', action: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: 'Code Block', aliases: ['code', 'cb'], icon: '{ }', category: 'Basic', action: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: 'hr', label: 'Horizontal Rule', aliases: ['hr', 'divider', '---'], icon: '—', category: 'Basic', action: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: 'table', label: 'Table', aliases: ['table'], icon: '⊞', category: 'Advanced', action: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3 }).run() },
  { id: 'math', label: 'Math Block', aliases: ['math', 'latex', 'equation'], icon: '∑', category: 'Advanced', action: (e) => e.chain().focus().insertContent({ type: 'mathBlock', content: [{ type: 'text', text: 'E = mc^2' }] }).run() },
  { id: 'image', label: 'Image', aliases: ['img', 'image', 'pic'], icon: '🖼', category: 'Insert', action: (e) => {
    const url = window.prompt('Image URL:');
    if (url) e.chain().focus().setImage({ src: url }).run();
  }},
  { id: 'video', label: 'Video', aliases: ['video', 'vid'], icon: '▶', category: 'Insert', action: (e) => {
    const url = window.prompt('Video URL or path:');
    if (url) e.chain().focus().insertContent(`<video src="${url}" controls style="max-width:100%"></video>`).run();
  }},
  { id: 'toc', label: 'Table of Contents', aliases: ['toc', 'contents'], icon: '☰', category: 'Insert', action: (e) => e.chain().focus().insertContent({ type: 'tocBlock' }).run() },
];

export interface SlashCommandsOptions {
  items?: SlashCommandItem[];
  onCreatePage?: () => void;
}

const slashPluginKey = new PluginKey('slashCommands');

export const SlashCommands = Extension.create<SlashCommandsOptions>({
  name: 'slashCommands',

  addOptions() {
    return { items: undefined, onCreatePage: undefined };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    const baseItems = opts.items ?? defaultItems;

    const items: SlashCommandItem[] = [...baseItems];
    if (opts.onCreatePage) {
      const cb = opts.onCreatePage;
      items.push({
        id: 'newpage',
        label: 'New Page',
        aliases: ['page', 'new', 'create'],
        icon: '📄',
        category: 'Insert',
        action: () => cb(),
      });
    }

    const editor = this.editor;

    return [
      new Plugin({
        key: slashPluginKey,
        props: {
          handleKeyDown(view: EditorView, event: KeyboardEvent) {
            if (event.key !== '/') return false;

            const { state } = view;
            const { $from } = state.selection;
            const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);

            if (textBefore.trim() !== '') return false;

            setTimeout(() => {
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
  menu.style.left = `${coords.left}px`;
  menu.style.top = `${coords.bottom + 4}px`;
  menu.style.zIndex = '9999';

  let selectedIndex = 0;
  let filteredItems = [...items];
  let filterText = '';

  function reposition() {
    if (menuId !== activeSlashMenuId) return;
    try {
      const { from: curFrom } = view.state.selection;
      const c = view.coordsAtPos(curFrom);
      menu.style.left = `${c.left}px`;
      menu.style.top = `${c.bottom + 4}px`;
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

      const label = document.createElement('span');
      label.className = 'kivi-slash-label';
      label.textContent = item.label;
      labelWrap.appendChild(label);

      if (item.aliases?.length) {
        const alias = document.createElement('span');
        alias.className = 'kivi-slash-alias';
        alias.textContent = '/' + item.aliases[0];
        labelWrap.appendChild(alias);
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
  }

  render();
  document.body.appendChild(menu);
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('click', handleClick, true);
  window.addEventListener('scroll', handleScroll, true);
  window.addEventListener('resize', handleScroll);
}
