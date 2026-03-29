import { Extension } from '@tiptap/core';

export interface ToolbarAction {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  action: () => void;
  isActive: () => boolean;
}

export interface KiviToolbarOptions {
  element: HTMLElement | null;
}

/**
 * Creates a floating toolbar that attaches to the editor.
 * Renders formatting buttons and updates active state on selection changes.
 */
export const KiviToolbar = Extension.create<KiviToolbarOptions>({
  name: 'kiviToolbar',

  addOptions() {
    return { element: null };
  },

  addStorage() {
    return { rendered: false };
  },

  onCreate() {
    const el = this.options.element;
    if (!el) return;
    renderToolbar(el, this.editor);
    this.storage.rendered = true;
  },

  onSelectionUpdate() {
    const el = this.options.element;
    if (!el || !this.storage.rendered) return;
    updateToolbarState(el, this.editor);
  },

  onUpdate() {
    const el = this.options.element;
    if (!el || !this.storage.rendered) return;
    updateToolbarState(el, this.editor);
  },
});

function renderToolbar(el: HTMLElement, editor: import('@tiptap/core').Editor) {
  el.innerHTML = '';
  el.className = 'kivi-toolbar';

  const actions = getActions(editor);

  for (const action of actions) {
    if (action.id.startsWith('sep')) {
      const sep = document.createElement('span');
      sep.className = 'kivi-toolbar-sep';
      el.appendChild(sep);
      continue;
    }

    const btn = document.createElement('button');
    btn.className = 'kivi-toolbar-btn';
    btn.dataset.action = action.id;
    btn.title = action.shortcut ? `${action.label} (${action.shortcut})` : action.label;
    btn.textContent = action.icon;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      action.action();
    });
    el.appendChild(btn);
  }
}

function updateToolbarState(el: HTMLElement, editor: import('@tiptap/core').Editor) {
  const buttons = el.querySelectorAll<HTMLButtonElement>('.kivi-toolbar-btn');
  const actions = getActions(editor).filter((a) => !a.id.startsWith('sep'));

  buttons.forEach((btn, i) => {
    const action = actions[i];
    if (action) {
      btn.classList.toggle('active', action.isActive());
    }
  });
}

function getActions(editor: import('@tiptap/core').Editor): ToolbarAction[] {
  return [
    { id: 'bold', label: 'Bold', icon: 'B', shortcut: '⌘B', action: () => editor.chain().focus().toggleBold().run(), isActive: () => editor.isActive('bold') },
    { id: 'italic', label: 'Italic', icon: 'I', shortcut: '⌘I', action: () => editor.chain().focus().toggleItalic().run(), isActive: () => editor.isActive('italic') },
    { id: 'strike', label: 'Strikethrough', icon: 'S̶', shortcut: '⌘⇧X', action: () => editor.chain().focus().toggleStrike().run(), isActive: () => editor.isActive('strike') },
    { id: 'code', label: 'Code', icon: '<>', shortcut: '⌘E', action: () => editor.chain().focus().toggleCode().run(), isActive: () => editor.isActive('code') },
    { id: 'sep1', label: '', icon: '', action: () => {}, isActive: () => false },
    { id: 'h1', label: 'Heading 1', icon: 'H1', shortcut: '⌘⌥1', action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(), isActive: () => editor.isActive('heading', { level: 1 }) },
    { id: 'h2', label: 'Heading 2', icon: 'H2', shortcut: '⌘⌥2', action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(), isActive: () => editor.isActive('heading', { level: 2 }) },
    { id: 'h3', label: 'Heading 3', icon: 'H3', shortcut: '⌘⌥3', action: () => editor.chain().focus().toggleHeading({ level: 3 }).run(), isActive: () => editor.isActive('heading', { level: 3 }) },
    { id: 'sep2', label: '', icon: '', action: () => {}, isActive: () => false },
    { id: 'bullet', label: 'Bullet List', icon: '•', shortcut: '⌘⇧8', action: () => editor.chain().focus().toggleBulletList().run(), isActive: () => editor.isActive('bulletList') },
    { id: 'ordered', label: 'Ordered List', icon: '1.', shortcut: '⌘⇧7', action: () => editor.chain().focus().toggleOrderedList().run(), isActive: () => editor.isActive('orderedList') },
    { id: 'task', label: 'Task List', icon: '☑', shortcut: '⌘⇧9', action: () => editor.chain().focus().toggleTaskList().run(), isActive: () => editor.isActive('taskList') },
    { id: 'sep3', label: '', icon: '', action: () => {}, isActive: () => false },
    { id: 'blockquote', label: 'Blockquote', icon: '❝', shortcut: '⌘⇧B', action: () => editor.chain().focus().toggleBlockquote().run(), isActive: () => editor.isActive('blockquote') },
    { id: 'codeblock', label: 'Code Block', icon: '{ }', shortcut: '⌘⌥C', action: () => editor.chain().focus().toggleCodeBlock().run(), isActive: () => editor.isActive('codeBlock') },
    { id: 'hr', label: 'Horizontal Rule', icon: '—', action: () => editor.chain().focus().setHorizontalRule().run(), isActive: () => false },
  ];
}
