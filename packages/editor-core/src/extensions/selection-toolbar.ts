import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { addDelayedTooltip } from '../tooltip.js';
import { positionFixedPopup } from '../zoom.js';

const selectionToolbarKey = new PluginKey('kiviSelectionToolbar');

const svg = (d: string) =>
  `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  bold: `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5h4.5a3 3 0 0 1 2.12 5.12A3.25 3.25 0 0 1 9 13.5H4V2.5zM4 8h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  italic: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="10" y1="2.5" x2="6" y2="13.5"/><line x1="7.5" y1="2.5" x2="11.5" y2="2.5"/><line x1="4.5" y1="13.5" x2="8.5" y2="13.5"/></svg>`,
  strike: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="8" x2="14" y2="8" stroke-width="1.5"/><path d="M10.2 4.8C9.7 3.6 8.6 3 7.5 3 5.8 3 4.5 4 4.5 5.5c0 1 .5 1.7 1.3 2.2" stroke-width="1.6" fill="none"/><path d="M5.8 11.2c.5 1.2 1.6 1.8 2.7 1.8 1.7 0 3-1 3-2.5 0-.7-.3-1.3-.8-1.7" stroke-width="1.6" fill="none"/></svg>`,
  code: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,3.5 1.5,8 5,12.5"/><polyline points="11,3.5 14.5,8 11,12.5"/></svg>`,
  highlight: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2L3.5 10h4l-1 4 6-8h-4l1-4z" fill="#fde68a" fill-opacity="0.35"/></svg>`,
  link: svg('<path d="M6.5 9.5a3 3 0 0 1-.5-4l1.5-1.5a3 3 0 0 1 4.2 4.2L10.5 9.5"/><path d="M9.5 6.5a3 3 0 0 1 .5 4l-1.5 1.5a3 3 0 0 1-4.2-4.2L5.5 6.5"/>'),
  bullet: svg('<circle cx="3" cy="4" r="1.2" fill="currentColor" stroke="none"/><line x1="6" y1="4" x2="14" y2="4"/><circle cx="3" cy="8" r="1.2" fill="currentColor" stroke="none"/><line x1="6" y1="8" x2="14" y2="8"/><circle cx="3" cy="12" r="1.2" fill="currentColor" stroke="none"/><line x1="6" y1="12" x2="14" y2="12"/>'),
  ordered: svg('<text x="1" y="5.5" font-size="6" font-family="system-ui" font-weight="700" fill="currentColor" stroke="none">1</text><line x1="6" y1="4" x2="14" y2="4"/><text x="1" y="9.5" font-size="6" font-family="system-ui" font-weight="700" fill="currentColor" stroke="none">2</text><line x1="6" y1="8" x2="14" y2="8"/><text x="1" y="13.5" font-size="6" font-family="system-ui" font-weight="700" fill="currentColor" stroke="none">3</text><line x1="6" y1="12" x2="14" y2="12"/>'),
  task: svg('<rect x="2" y="2.5" width="4" height="4" rx="0.8" stroke-width="1.3"/><polyline points="3,4.5 3.8,5.5 5.3,3.5" stroke-width="1.2"/><line x1="8" y1="4.5" x2="14" y2="4.5"/><rect x="2" y="9.5" width="4" height="4" rx="0.8" stroke-width="1.3"/><line x1="8" y1="11.5" x2="14" y2="11.5"/>'),
};

type FormatAction = {
  id: string;
  icon: string;
  title: string;
  separator?: boolean;
  cmd: (editor: import('@tiptap/core').Editor) => void;
  isActive: (editor: import('@tiptap/core').Editor) => boolean;
};

const ACTIONS: FormatAction[] = [
  { id: 'bold', icon: ICONS.bold, title: 'Bold', cmd: (e) => e.chain().focus().toggleBold().run(), isActive: (e) => e.isActive('bold') },
  { id: 'italic', icon: ICONS.italic, title: 'Italic', cmd: (e) => e.chain().focus().toggleItalic().run(), isActive: (e) => e.isActive('italic') },
  { id: 'strike', icon: ICONS.strike, title: 'Strikethrough', cmd: (e) => e.chain().focus().toggleStrike().run(), isActive: (e) => e.isActive('strike') },
  { id: 'code', icon: ICONS.code, title: 'Code', cmd: (e) => e.chain().focus().toggleCode().run(), isActive: (e) => e.isActive('code') },
  { id: 'highlight', icon: ICONS.highlight, title: 'Highlight', cmd: (e) => e.chain().focus().toggleHighlight().run(), isActive: (e) => e.isActive('highlight') },
  { id: 'link', icon: ICONS.link, title: 'Link (⌘K)', cmd: (e) => {
    if (e.isActive('link')) {
      e.chain().focus().unsetLink().run();
    } else {
      const { from, to } = e.state.selection;
      document.dispatchEvent(new CustomEvent('kivi-link-request', {
        detail: { from, to },
      }));
    }
  }, isActive: (e) => e.isActive('link') },
  { id: 'sep-list', icon: '', title: '', separator: true, cmd: () => {}, isActive: () => false },
  { id: 'bullet', icon: ICONS.bullet, title: 'Bullet list', cmd: (e) => e.chain().focus().toggleBulletList().run(), isActive: (e) => e.isActive('bulletList') },
  { id: 'ordered', icon: ICONS.ordered, title: 'Numbered list', cmd: (e) => e.chain().focus().toggleOrderedList().run(), isActive: (e) => e.isActive('orderedList') },
  { id: 'task', icon: ICONS.task, title: 'Task list', cmd: (e) => e.chain().focus().toggleTaskList().run(), isActive: (e) => e.isActive('taskList') },
];

function selectionVisibleInEditor(view: EditorView): boolean {
  const { from, to } = view.state.selection;
  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to);
  const left = Math.min(start.left, end.left);
  const right = Math.max(start.right, end.right);
  const top = Math.min(start.top, end.top);
  const bottom = Math.max(start.bottom, end.bottom);
  const container = view.dom.parentElement;
  if (!container) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return bottom > 0 && top < vh && right > 0 && left < vw;
  }
  const cr = container.getBoundingClientRect();
  return bottom > cr.top && top < cr.bottom && right > cr.left && left < cr.right;
}

export const SelectionToolbar = Extension.create({
  name: 'kiviSelectionToolbar',

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: selectionToolbarKey,
        view(editorView: EditorView) {
          let toolbar: HTMLElement | null = null;
          let isMouseDown = false;
          let hideTimeout: ReturnType<typeof setTimeout> | null = null;
          let scrollParentEl: HTMLElement | null = null;
          let onScroll: (() => void) | null = null;

          function detachScroll() {
            if (scrollParentEl && onScroll) {
              scrollParentEl.removeEventListener('scroll', onScroll);
            }
            scrollParentEl = null;
            onScroll = null;
          }

          function attachScroll() {
            detachScroll();
            const parent = editorView.dom.parentElement;
            if (!parent) return;
            scrollParentEl = parent;
            onScroll = () => {
              if (!toolbar) return;
              if (!selectionVisibleInEditor(editorView)) {
                toolbar.style.visibility = 'hidden';
                return;
              }
              toolbar.style.visibility = 'visible';
              positionToolbar(editorView);
            };
            parent.addEventListener('scroll', onScroll, { passive: true });
          }

          function clearHideTimeout() {
            if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
          }

          const onMouseDown = () => { isMouseDown = true; removeToolbar(); };
          const onMouseUp = () => {
            isMouseDown = false;
            setTimeout(() => reconcile(editorView), 20);
          };
          const onMouseLeave = () => {
            if (isMouseDown) {
              isMouseDown = false;
              setTimeout(() => reconcile(editorView), 50);
            }
          };

          editorView.dom.addEventListener('mousedown', onMouseDown);
          document.addEventListener('mouseup', onMouseUp);
          document.documentElement.addEventListener('mouseleave', onMouseLeave);

          function createToolbar(): HTMLElement {
            const el = document.createElement('div');
            el.className = 'kivi-selection-toolbar';
            el.setAttribute('role', 'toolbar');
            el.setAttribute('aria-label', 'Text formatting');
            el.style.pointerEvents = 'none';

            for (const action of ACTIONS) {
              if (action.separator) {
                const sep = document.createElement('span');
                sep.className = 'kivi-sel-sep';
                sep.style.pointerEvents = 'none';
                el.appendChild(sep);
                continue;
              }
              const btn = document.createElement('button');
              btn.className = 'kivi-sel-btn';
              btn.type = 'button';
              btn.title = action.title;
              btn.innerHTML = action.icon;
              btn.style.pointerEvents = 'auto';
              btn.addEventListener('mousedown', (e) => e.preventDefault());
              btn.addEventListener('click', () => {
                action.cmd(editor);
                updateActiveState(el);
              });
              addDelayedTooltip(btn);
              el.appendChild(btn);
            }

            el.addEventListener('mousedown', (e) => e.preventDefault());

            return el;
          }

          const INLINE_FORMAT_IDS = new Set(['bold', 'italic', 'strike', 'code', 'highlight', 'link']);

          function updateActiveState(el: HTMLElement) {
            const actionButtons = ACTIONS.filter((a) => !a.separator);
            const buttons = el.querySelectorAll<HTMLButtonElement>('.kivi-sel-btn');
            const inCodeBlock = editor.isActive('codeBlock');
            buttons.forEach((btn, i) => {
              if (i >= actionButtons.length) return;
              const action = actionButtons[i];
              btn.classList.toggle('active', action.isActive(editor));
              const disabled = inCodeBlock && INLINE_FORMAT_IDS.has(action.id);
              btn.classList.toggle('kivi-btn-disabled', disabled);
            });
          }

          function positionToolbar(view: EditorView) {
            if (!toolbar) return;
            if (!selectionVisibleInEditor(view)) {
              toolbar.style.visibility = 'hidden';
              return;
            }
            toolbar.style.visibility = 'visible';
            const { from, to } = view.state.selection;

            const domSel = window.getSelection();
            let selRect: { top: number; bottom: number; left: number; right: number } | null = null;
            if (domSel && domSel.rangeCount > 0) {
              const range = domSel.getRangeAt(0);
              const rects = range.getClientRects();
              if (rects.length > 0) {
                let minT = Infinity, maxB = -Infinity, minL = Infinity, maxR = -Infinity;
                for (let i = 0; i < rects.length; i++) {
                  const r = rects[i];
                  if (r.width === 0 && r.height === 0) continue;
                  minT = Math.min(minT, r.top);
                  maxB = Math.max(maxB, r.bottom);
                  minL = Math.min(minL, r.left);
                  maxR = Math.max(maxR, r.right);
                }
                if (minT < Infinity) selRect = { top: minT, bottom: maxB, left: minL, right: maxR };
              }
            }

            if (!selRect) {
              const start = view.coordsAtPos(from);
              const end = view.coordsAtPos(to);
              selRect = {
                top: Math.min(start.top, end.top),
                bottom: Math.max(start.bottom, end.bottom),
                left: Math.min(start.left, end.left),
                right: Math.max(start.right, end.right),
              };
            }

            const container = view.dom.parentElement;
            const cr = container?.getBoundingClientRect() ?? null;

            positionFixedPopup({
              anchorRect: selRect,
              popup: toolbar,
              containerRect: cr,
              gap: 8,
              pad: 8,
              alignX: 'center',
              preferY: 'above',
              anchorEl: view.dom as HTMLElement,
            });
          }

          function showToolbar(view: EditorView) {
            clearHideTimeout();
            if (!toolbar) {
              toolbar = createToolbar();
              document.body.appendChild(toolbar);
              attachScroll();
            }
            updateActiveState(toolbar);
            positionToolbar(view);
          }

          function removeToolbar() {
            clearHideTimeout();
            detachScroll();
            if (toolbar) {
              toolbar.remove();
              toolbar = null;
            }
          }

          function reconcile(view: EditorView) {
            if (isMouseDown) return;
            const { from, to, empty } = view.state.selection;
            if (empty || to - from < 1) {
              removeToolbar();
              return;
            }

            if (view.state.selection instanceof NodeSelection) {
              removeToolbar();
              return;
            }

            const inCodeBlock = view.state.selection.$from.parent.type.name === 'codeBlock';
            if (inCodeBlock) {
              removeToolbar();
              return;
            }

            showToolbar(view);
          }

          return {
            update(view: EditorView) {
              if (!isMouseDown) reconcile(view);
            },
            destroy() {
              removeToolbar();
              editorView.dom.removeEventListener('mousedown', onMouseDown);
              document.removeEventListener('mouseup', onMouseUp);
              document.documentElement.removeEventListener('mouseleave', onMouseLeave);
            },
          };
        },
      }),
    ];
  },
});
