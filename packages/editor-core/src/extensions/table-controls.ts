import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const tableControlsKey = new PluginKey('kiviTableControls');

const svg = (d: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  rowAfter: svg('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="8" y1="10" x2="8" y2="14" stroke-width="1.8"/><line x1="6" y1="12" x2="10" y2="12" stroke-width="1.8"/>'),
  colAfter: svg('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="8" y1="2" x2="8" y2="14"/><line x1="10" y1="8" x2="14" y2="8" stroke-width="1.8"/><line x1="12" y1="6" x2="12" y2="10" stroke-width="1.8"/>'),
  rowBefore: svg('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="8" y1="2" x2="8" y2="6" stroke-width="1.8"/><line x1="6" y1="4" x2="10" y2="4" stroke-width="1.8"/>'),
  colBefore: svg('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="6" y2="8" stroke-width="1.8"/><line x1="4" y1="6" x2="4" y2="10" stroke-width="1.8"/>'),
  deleteRow: svg('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="5" y1="11" x2="11" y2="11" stroke="#f44747" stroke-width="1.8"/>'),
  deleteCol: svg('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="8" y1="2" x2="8" y2="14"/><line x1="11" y1="5" x2="11" y2="11" stroke="#f44747" stroke-width="1.8"/>'),
  headerRow: svg('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="6" x2="14" y2="6"/><rect x="3" y="3" width="10" height="2" fill="currentColor" stroke="none" rx="0.5"/>'),
  merge: svg('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/><polyline points="6,6 8,8 6,10"/><polyline points="10,6 8,8 10,10"/>'),
  alignLeft: svg('<line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="10" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/>'),
  alignCenter: svg('<line x1="2" y1="4" x2="14" y2="4"/><line x1="4" y1="8" x2="12" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/>'),
  alignRight: svg('<line x1="2" y1="4" x2="14" y2="4"/><line x1="6" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/>'),
  trash: svg('<polyline points="3,4 13,4"/><path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><path d="M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4"/>'),
};

function isElementVisibleInEditor(el: HTMLElement, view: EditorView): boolean {
  const ir = el.getBoundingClientRect();
  const container = view.dom.parentElement;
  if (!container) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return ir.bottom > 0 && ir.top < vh && ir.right > 0 && ir.left < vw;
  }
  const cr = container.getBoundingClientRect();
  return ir.bottom > cr.top && ir.top < cr.bottom && ir.right > cr.left && ir.left < cr.right;
}

export const TableControls = Extension.create({
  name: 'kiviTableControls',

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: tableControlsKey,
        view() {
          let menu: HTMLElement | null = null;
          let currentTable: HTMLElement | null = null;
          let editorViewRef: EditorView | null = null;
          let scrollParentEl: HTMLElement | null = null;
          let onScroll: (() => void) | null = null;

          function detachScroll() {
            if (scrollParentEl && onScroll) {
              scrollParentEl.removeEventListener('scroll', onScroll);
            }
            scrollParentEl = null;
            onScroll = null;
          }

          function attachScroll(view: EditorView) {
            detachScroll();
            const parent = view.dom.parentElement;
            if (!parent) return;
            scrollParentEl = parent;
            editorViewRef = view;
            onScroll = () => {
              if (!menu || !currentTable || !editorViewRef) return;
              positionMenu(editorViewRef, currentTable);
            };
            parent.addEventListener('scroll', onScroll, { passive: true });
          }

          function removeMenu() {
            detachScroll();
            menu?.remove();
            menu = null;
            currentTable = null;
            editorViewRef = null;
          }

          function btn(svgHtml: string, title: string, action: () => void, danger = false): HTMLButtonElement {
            const b = document.createElement('button');
            b.className = 'kivi-table-ctrl-btn' + (danger ? ' kivi-table-ctrl-danger' : '');
            b.innerHTML = svgHtml;
            b.title = title;
            b.style.pointerEvents = 'auto';
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.addEventListener('click', () => { action(); });
            return b;
          }

          function sep(): HTMLElement {
            const s = document.createElement('span');
            s.className = 'kivi-table-ctrl-sep';
            return s;
          }

          function showMenu(view: EditorView, tableEl: HTMLElement) {
            if (menu && currentTable === tableEl) {
              editorViewRef = view;
              attachScroll(view);
              positionMenu(view, tableEl);
              return;
            }
            removeMenu();
            currentTable = tableEl;

            menu = document.createElement('div');
            menu.className = 'kivi-table-controls';
            menu.setAttribute('role', 'toolbar');
            menu.setAttribute('aria-label', 'Table controls');
            menu.style.pointerEvents = 'none';

            menu.appendChild(btn(ICONS.rowAfter, 'Add row below', () => editor.chain().focus().addRowAfter().run()));
            menu.appendChild(btn(ICONS.colAfter, 'Add column after', () => editor.chain().focus().addColumnAfter().run()));
            menu.appendChild(sep());
            menu.appendChild(btn(ICONS.rowBefore, 'Add row before', () => editor.chain().focus().addRowBefore().run()));
            menu.appendChild(btn(ICONS.colBefore, 'Add column before', () => editor.chain().focus().addColumnBefore().run()));
            menu.appendChild(sep());
            menu.appendChild(btn(ICONS.deleteRow, 'Delete row', () => editor.chain().focus().deleteRow().run()));
            menu.appendChild(btn(ICONS.deleteCol, 'Delete column', () => editor.chain().focus().deleteColumn().run()));
            menu.appendChild(sep());
            menu.appendChild(btn(ICONS.headerRow, 'Toggle header row', () => editor.chain().focus().toggleHeaderRow().run()));
            menu.appendChild(btn(ICONS.merge, 'Merge/split cells', () => editor.chain().focus().mergeOrSplit().run()));
            menu.appendChild(sep());
            menu.appendChild(btn(ICONS.alignLeft, 'Align left', () => editor.chain().focus().setCellAttribute('textAlign', null).run()));
            menu.appendChild(btn(ICONS.alignCenter, 'Align center', () => editor.chain().focus().setCellAttribute('textAlign', 'center').run()));
            menu.appendChild(btn(ICONS.alignRight, 'Align right', () => editor.chain().focus().setCellAttribute('textAlign', 'right').run()));
            menu.appendChild(sep());
            menu.appendChild(btn(ICONS.trash, 'Delete table', () => editor.chain().focus().deleteTable().run(), true));

            document.body.appendChild(menu);
            editorViewRef = view;
            attachScroll(view);
            positionMenu(view, tableEl);
          }

          function positionMenu(view: EditorView, tableEl: HTMLElement) {
            if (!menu) return;
            if (!isElementVisibleInEditor(tableEl, view)) {
              menu.style.visibility = 'hidden';
              return;
            }
            menu.style.visibility = 'visible';
            const tableRect = tableEl.getBoundingClientRect();
            const editorRect = view.dom.getBoundingClientRect();

            let left = tableRect.left;
            let top = tableRect.top - menu.offsetHeight - 6;

            if (top < editorRect.top) {
              top = tableRect.bottom + 6;
            }

            const menuWidth = menu.offsetWidth || 400;
            if (left + menuWidth > window.innerWidth - 8) {
              left = window.innerWidth - menuWidth - 8;
            }
            if (left < 8) left = 8;

            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
          }

          return {
            update(view) {
              const { $from } = view.state.selection;
              let depth = $from.depth;
              let inTable = false;
              while (depth > 0) {
                if ($from.node(depth).type.name === 'table') {
                  inTable = true;
                  break;
                }
                depth--;
              }

              if (!inTable) {
                removeMenu();
                return;
              }

              const domNode = view.domAtPos($from.start(depth));
              const tableEl = (domNode.node as HTMLElement).closest?.('table')
                ?? (domNode.node.parentElement as HTMLElement)?.closest?.('table');

              if (tableEl) {
                showMenu(view, tableEl);
              } else {
                removeMenu();
              }
            },
            destroy() {
              removeMenu();
            },
          };
        },
      }),
    ];
  },
});
