import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export interface SlashCommandItem {
  id: string;
  label: string;
  icon: string;
  category: string;
  action: (editor: Editor) => void;
}

const defaultItems: SlashCommandItem[] = [
  { id: 'h1', label: 'Heading 1', icon: 'H1', category: 'Basic', action: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: 'h2', label: 'Heading 2', icon: 'H2', category: 'Basic', action: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'h3', label: 'Heading 3', icon: 'H3', category: 'Basic', action: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'bullet', label: 'Bullet List', icon: '•', category: 'Basic', action: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'ordered', label: 'Numbered List', icon: '1.', category: 'Basic', action: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: 'task', label: 'Task List', icon: '☑', category: 'Basic', action: (e) => e.chain().focus().toggleTaskList().run() },
  { id: 'quote', label: 'Blockquote', icon: '❝', category: 'Basic', action: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: 'Code Block', icon: '{ }', category: 'Basic', action: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: 'hr', label: 'Horizontal Rule', icon: '—', category: 'Basic', action: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: 'table', label: 'Table', icon: '⊞', category: 'Advanced', action: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3 }).run() },
  { id: 'math', label: 'Math Block', icon: '∑', category: 'Advanced', action: (e) => e.chain().focus().insertContent({ type: 'mathBlock', content: [{ type: 'text', text: 'E = mc^2' }] }).run() },
  { id: 'toc', label: 'Table of Contents', icon: '☰', category: 'Insert', action: (e) => e.chain().focus().insertContent({ type: 'tocBlock' }).run() },
];

export interface SlashCommandsOptions {
  items?: SlashCommandItem[];
}

const slashPluginKey = new PluginKey('slashCommands');

export const SlashCommands = Extension.create<SlashCommandsOptions>({
  name: 'slashCommands',

  addOptions() {
    return { items: undefined };
  },

  addProseMirrorPlugins() {
    const items = this.options.items ?? defaultItems;
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

            // Defer to next tick so the / character is inserted first
            setTimeout(() => showSlashMenu(view, items, editor), 0);
            return false;
          },
        },
      }),
    ];
  },
});

function showSlashMenu(
  view: EditorView,
  items: SlashCommandItem[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any,
) {
  // Remove any existing slash menu
  const existing = document.querySelector('.kivi-slash-menu');
  if (existing) existing.remove();

  const { state } = view;
  const { from } = state.selection;
  const coords = view.coordsAtPos(from);

  const menu = document.createElement('div');
  menu.className = 'kivi-slash-menu';
  menu.style.position = 'fixed';
  menu.style.left = `${coords.left}px`;
  menu.style.top = `${coords.bottom + 4}px`;
  menu.style.zIndex = '9999';

  let selectedIndex = 0;
  let filteredItems = [...items];
  let filterText = '';

  function render() {
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

      const icon = document.createElement('span');
      icon.className = 'kivi-slash-icon';
      icon.textContent = item.icon;

      const label = document.createElement('span');
      label.className = 'kivi-slash-label';
      label.textContent = item.label;

      row.appendChild(icon);
      row.appendChild(label);

      row.addEventListener('mouseenter', () => {
        selectedIndex = idx;
        render();
      });
      row.addEventListener('click', (e) => {
        e.preventDefault();
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
  }

  function selectItem(item: SlashCommandItem) {
    cleanup();
    // Delete the slash and any filter text
    const { state: currentState } = view;
    const { from: curFrom } = currentState.selection;
    const deleteFrom = curFrom - filterText.length - 1;
    const tr = currentState.tr.delete(Math.max(0, deleteFrom), curFrom);
    view.dispatch(tr);
    item.action(editor);
  }

  function updateFilter(char: string) {
    filterText += char;
    filteredItems = items.filter((i) =>
      i.label.toLowerCase().includes(filterText.toLowerCase()),
    );
    selectedIndex = 0;
    render();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % Math.max(1, filteredItems.length);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + filteredItems.length) % Math.max(1, filteredItems.length);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredItems[selectedIndex]) selectItem(filteredItems[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
    } else if (e.key === 'Backspace') {
      if (filterText.length > 0) {
        filterText = filterText.slice(0, -1);
        filteredItems = items.filter((i) =>
          i.label.toLowerCase().includes(filterText.toLowerCase()),
        );
        selectedIndex = 0;
        render();
      } else {
        cleanup();
      }
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      updateFilter(e.key);
    }
  }

  function handleClick(e: MouseEvent) {
    if (!menu.contains(e.target as Node)) {
      cleanup();
    }
  }

  function cleanup() {
    menu.remove();
    document.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('click', handleClick, true);
  }

  render();
  document.body.appendChild(menu);
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('click', handleClick, true);
}
