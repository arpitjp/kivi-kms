import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const linkPopupKey = new PluginKey('kiviLinkPopup');

const svg = (d: string) =>
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  edit: svg('<path d="M11.5 2.5a1.5 1.5 0 0 1 2 2L5 13l-3 1 1-3z"/>'),
  unlink: svg('<path d="M7 11l-1.5 1.5a2.5 2.5 0 0 1-3.5-3.5L3.5 7.5"/><path d="M9 5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L12.5 8.5"/><line x1="4" y1="12" x2="12" y2="4" stroke-dasharray="1.5,2"/>'),
  copy: svg('<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5V3.5A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5"/>'),
  check: svg('<polyline points="3,8 6.5,11.5 13,4.5" stroke-width="2"/>'),
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

export const LinkPopup = Extension.create({
  name: 'kiviLinkPopup',

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: linkPopupKey,
        view() {
          let popup: HTMLElement | null = null;
          let currentHref = '';
          let activeLinkEl: HTMLElement | null = null;
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
              if (!popup || !activeLinkEl || !editorViewRef) return;
              positionPopup(activeLinkEl);
            };
            parent.addEventListener('scroll', onScroll, { passive: true });
          }

          function removePopup() {
            detachScroll();
            popup?.remove();
            popup = null;
            currentHref = '';
            activeLinkEl = null;
            editorViewRef = null;
          }

          function showPopup(view: EditorView, href: string, linkEl: HTMLElement) {
            if (popup && currentHref === href) {
              activeLinkEl = linkEl;
              editorViewRef = view;
              attachScroll(view);
              positionPopup(activeLinkEl);
              return;
            }
            removePopup();
            currentHref = href;
            activeLinkEl = linkEl;
            editorViewRef = view;

            popup = document.createElement('div');
            popup.className = 'kivi-link-popup';
            popup.setAttribute('role', 'toolbar');
            popup.setAttribute('aria-label', 'Link actions');
            popup.style.pointerEvents = 'none';

            const urlSpan = document.createElement('a');
            urlSpan.className = 'kivi-link-popup-url';
            urlSpan.href = href;
            urlSpan.target = '_blank';
            urlSpan.rel = 'noopener noreferrer';
            urlSpan.textContent = href.length > 40 ? href.slice(0, 37) + '...' : href;
            urlSpan.title = href;
            urlSpan.style.pointerEvents = 'auto';
            popup.appendChild(urlSpan);

            const editBtn = document.createElement('button');
            editBtn.className = 'kivi-link-popup-btn';
            editBtn.innerHTML = ICONS.edit;
            editBtn.title = 'Edit link';
            editBtn.style.pointerEvents = 'auto';
            editBtn.addEventListener('mousedown', (e) => e.preventDefault());
            editBtn.addEventListener('click', () => {
              const { from, to } = editor.state.selection;
              document.dispatchEvent(new CustomEvent('kivi-link-request', {
                detail: { from, to, currentUrl: href, editMode: true },
              }));
              removePopup();
            });
            popup.appendChild(editBtn);

            const unlinkBtn = document.createElement('button');
            unlinkBtn.className = 'kivi-link-popup-btn';
            unlinkBtn.innerHTML = ICONS.unlink;
            unlinkBtn.title = 'Remove link';
            unlinkBtn.style.pointerEvents = 'auto';
            unlinkBtn.addEventListener('mousedown', (e) => e.preventDefault());
            unlinkBtn.addEventListener('click', () => {
              editor.chain().focus().extendMarkRange('link').unsetLink().run();
              removePopup();
            });
            popup.appendChild(unlinkBtn);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'kivi-link-popup-btn';
            copyBtn.innerHTML = ICONS.copy;
            copyBtn.title = 'Copy link';
            copyBtn.style.pointerEvents = 'auto';
            copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
            copyBtn.addEventListener('click', () => {
              navigator.clipboard.writeText(href).catch(() => {});
              copyBtn.innerHTML = ICONS.check;
              setTimeout(() => { copyBtn.innerHTML = ICONS.copy; }, 1200);
            });
            popup.appendChild(copyBtn);

            document.body.appendChild(popup);
            attachScroll(view);
            positionPopup(linkEl);
          }

          function positionPopup(linkEl: HTMLElement) {
            if (!popup || !editorViewRef) return;
            if (!isElementVisibleInEditor(linkEl, editorViewRef)) {
              popup.style.visibility = 'hidden';
              return;
            }
            popup.style.visibility = 'visible';
            const rect = linkEl.getBoundingClientRect();
            popup.style.left = `${rect.left}px`;
            popup.style.top = `${rect.bottom + 4}px`;

            const pr = popup.getBoundingClientRect();
            let left = pr.left;
            if (pr.right > window.innerWidth - 8) {
              left = window.innerWidth - pr.width - 8;
            }
            if (left < 8) left = 8;
            popup.style.left = `${left}px`;
          }

          return {
            update(view) {
              const { $from, from, to } = view.state.selection;
              if (from !== to) { removePopup(); return; }

              const marks = $from.marks();
              const linkMark = marks.find((m) => m.type.name === 'link');

              if (!linkMark) {
                removePopup();
                return;
              }

              const href = linkMark.attrs.href as string;
              if (!href) { removePopup(); return; }

              const dom = view.domAtPos(from);
              const linkEl = (dom.node as HTMLElement).closest?.('a')
                ?? (dom.node.parentElement as HTMLElement)?.closest?.('a');

              if (linkEl instanceof HTMLElement) {
                showPopup(view, href, linkEl);
              } else {
                removePopup();
              }
            },
            destroy() {
              removePopup();
            },
          };
        },
      }),
    ];
  },
});
