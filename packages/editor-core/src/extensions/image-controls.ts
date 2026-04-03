import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { addDelayedTooltip } from '../tooltip.js';

const mediaControlsKey = new PluginKey('kiviMediaControls');

const svg = (d: string, w = 16) =>
  `<svg width="${w}" height="${w}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  alignLeft: svg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="2" y1="7" x2="10" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'),
  alignCenter: svg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="4" y1="7" x2="12" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'),
  alignRight: svg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="6" y1="7" x2="14" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'),
  trash: svg('<polyline points="3,4 13,4"/><path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><path d="M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4"/>'),
  copy: svg('<rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V3a1.5 1.5 0 0 1 1.5-1.5H11"/>'),
  link: svg('<path d="M6.5 9.5a3 3 0 0 1-.5-4l1.5-1.5a3 3 0 0 1 4.2 4.2L10.5 9.5"/><path d="M9.5 6.5a3 3 0 0 1 .5 4l-1.5 1.5a3 3 0 0 1-4.2-4.2L5.5 6.5"/>'),
  alt: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><text x="5" y="10" font-size="7" font-family="system-ui" font-weight="700" fill="currentColor" stroke="none">A</text>'),
};

type HandlePosition = 'nw' | 'ne' | 'se' | 'sw';

interface HandleInfo {
  pos: HandlePosition;
  cursor: string;
  xSign: number;
  ySign: number;
}

const HANDLE_DEFS: HandleInfo[] = [
  { pos: 'nw', cursor: 'nwse-resize', xSign: -1, ySign: -1 },
  { pos: 'ne', cursor: 'nesw-resize', xSign:  1, ySign: -1 },
  { pos: 'se', cursor: 'nwse-resize', xSign:  1, ySign:  1 },
  { pos: 'sw', cursor: 'nesw-resize', xSign: -1, ySign:  1 },
];

const SIZE_PRESETS = [
  { label: 'S',  pct: 25  },
  { label: 'M',  pct: 50  },
  { label: 'L',  pct: 75  },
  { label: 'XL', pct: 100 },
];

type MediaKind = 'image' | 'video' | 'audio' | 'excalidrawBlock';

function isElementVisibleInEditor(el: HTMLElement, view: EditorView): boolean {
  const ir = el.getBoundingClientRect();
  const container = view.dom.parentElement;
  if (!container) {
    return ir.bottom > 0 && ir.top < window.innerHeight && ir.right > 0 && ir.left < window.innerWidth;
  }
  const cr = container.getBoundingClientRect();
  return ir.bottom > cr.top && ir.top < cr.bottom && ir.right > cr.left && ir.left < cr.right;
}

function getEditorContentWidth(view: EditorView): number {
  const editorEl = view.dom;
  const style = getComputedStyle(editorEl);
  return editorEl.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}

const MEDIA_NODE_NAMES = new Set(['image', 'video', 'audio', 'excalidrawBlock']);

function detectMediaAtSelection(view: EditorView): { kind: MediaKind; pos: number; el: HTMLElement } | null {
  const { $from, from } = view.state.selection;

  const nodeAtFrom = view.state.doc.nodeAt(from);
  if (nodeAtFrom && MEDIA_NODE_NAMES.has(nodeAtFrom.type.name)) {
    const name = nodeAtFrom.type.name;
    const dom = view.nodeDOM(from);
    const el = resolveMediaElement(dom, name);
    if (el) return { kind: name as MediaKind, pos: from, el };
  }

  const parentName = $from.parent.type.name;
  if (MEDIA_NODE_NAMES.has(parentName)) {
    const parentPos = $from.before($from.depth);
    const dom = view.nodeDOM(parentPos);
    const el = resolveMediaElement(dom, parentName);
    if (el) return { kind: parentName as MediaKind, pos: parentPos, el };
  }

  return null;
}

function resolveMediaElement(dom: Node | null, typeName: string): HTMLElement | null {
  if (!dom) return null;
  const tagMap: Record<string, string> = {
    image: 'img', video: 'video', audio: 'audio',
    excalidrawBlock: '.kivi-excalidraw-block',
  };
  const selector = tagMap[typeName];
  if (!selector) return null;
  if (selector.startsWith('.')) {
    if (dom instanceof HTMLElement && dom.matches(selector)) return dom;
    return (dom as HTMLElement)?.querySelector?.(selector) as HTMLElement | null;
  }
  if (dom instanceof HTMLElement && dom.tagName.toLowerCase() === selector) return dom;
  return (dom as HTMLElement)?.querySelector?.(selector) as HTMLElement | null;
}

export const ImageControls = Extension.create({
  name: 'kiviImageControls',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mediaControlsKey,
        view(_initialView: EditorView) {
          let panel: HTMLElement | null = null;
          let activeEl: HTMLElement | null = null;
          let activeKind: MediaKind = 'image';
          let resizing = false;
          let activePos = -1;
          let activeView: EditorView | null = null;
          const resizeHandles: HTMLElement[] = [];
          let scrollParentEl: HTMLElement | null = null;
          let onScroll: (() => void) | null = null;
          let editRow: HTMLElement | null = null;
          let selectionOutline: HTMLElement | null = null;

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
            onScroll = () => {
              if (!activeEl || !panel) return;
              repositionFloating();
            };
            parent.addEventListener('scroll', onScroll, { passive: true });
          }

          function setFloatingVisibility(visible: boolean) {
            const v = visible ? 'visible' : 'hidden';
            if (panel) panel.style.visibility = v;
            if (selectionOutline) selectionOutline.style.visibility = v;
            for (const h of resizeHandles) h.style.visibility = v;
          }

          function positionHandles(el: HTMLElement) {
            const rect = el.getBoundingClientRect();
            const hs = 10; // handle size (square corners)
            const half = hs / 2;

            for (const handle of resizeHandles) {
              const pos = handle.dataset.handlePos as HandlePosition;
              let left: number, top: number;

              switch (pos) {
                case 'nw': left = rect.left - half; top = rect.top - half; break;
                case 'ne': left = rect.right - half; top = rect.top - half; break;
                case 'se': left = rect.right - half; top = rect.bottom - half; break;
                case 'sw': left = rect.left - half; top = rect.bottom - half; break;
                default: left = 0; top = 0;
              }

              handle.style.left = `${left}px`;
              handle.style.top = `${top}px`;
            }
          }

          function positionOutline(el: HTMLElement) {
            if (!selectionOutline) return;
            const rect = el.getBoundingClientRect();
            selectionOutline.style.left = `${rect.left - 2}px`;
            selectionOutline.style.top = `${rect.top - 2}px`;
            selectionOutline.style.width = `${rect.width + 4}px`;
            selectionOutline.style.height = `${rect.height + 4}px`;
          }

          function repositionFloating() {
            if (!activeEl || !panel || !activeView) return;
            if (!isElementVisibleInEditor(activeEl, activeView)) {
              setFloatingVisibility(false);
              return;
            }
            setFloatingVisibility(true);
            const elRect = activeEl.getBoundingClientRect();
            const editorRect = activeView.dom.getBoundingClientRect();
            const panelWidth = panel.offsetWidth || 200;
            const panelHeight = panel.offsetHeight || 48;

            let left = elRect.left + elRect.width / 2 - panelWidth / 2;
            const insidePadding = 12;
            let top = elRect.top + insidePadding;

            if (elRect.height < panelHeight + insidePadding * 2 + 8) {
              top = elRect.bottom + 6;
            }

            const visibleTop = Math.max(editorRect.top, 0);
            if (top < visibleTop + 4) top = visibleTop + 4;
            if (top + panelHeight > window.innerHeight - 8) top = window.innerHeight - panelHeight - 8;

            if (left + panelWidth > window.innerWidth - 8) left = window.innerWidth - panelWidth - 8;
            if (left < 8) left = 8;

            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
            positionHandles(activeEl);
            positionOutline(activeEl);
          }

          function removeOverlay() {
            detachScroll();
            for (const h of resizeHandles) h.remove();
            resizeHandles.length = 0;
            panel?.remove();
            panel = null;
            selectionOutline?.remove();
            selectionOutline = null;
            editRow = null;
            activeEl = null;
            activePos = -1;
          }

          function updateNodeAttr(key: string, value: unknown) {
            if (!activeView || activePos < 0) return;
            const node = activeView.state.doc.nodeAt(activePos);
            if (!node) return;
            activeView.dispatch(
              activeView.state.tr.setNodeMarkup(activePos, undefined, { ...node.attrs, [key]: value }),
            );
          }

          function reattachAfterTransaction(view: EditorView) {
            requestAnimationFrame(() => {
              if (activePos < 0) return;
              const dom = view.nodeDOM(activePos);
              const newEl = resolveMediaElement(dom, activeKind);
              if (newEl) {
                activeEl = newEl;
                repositionFloating();
              }
            });
          }

          function getNodeAttr(key: string): unknown {
            if (!activeView || activePos < 0) return undefined;
            return activeView.state.doc.nodeAt(activePos)?.attrs[key];
          }

          function makeBtn(svgHtml: string, title: string, action: () => void, danger = false): HTMLButtonElement {
            const b = document.createElement('button');
            b.className = 'kivi-img-ctrl-btn' + (danger ? ' kivi-img-ctrl-danger' : '');
            b.innerHTML = svgHtml;
            b.title = title;
            b.style.pointerEvents = 'auto';
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.addEventListener('click', () => { action(); });
            addDelayedTooltip(b);
            return b;
          }

          function makeSep(): HTMLElement {
            const s = document.createElement('span');
            s.className = 'kivi-img-ctrl-sep';
            return s;
          }

          function toggleEditRow(mode: 'src' | 'alt') {
            if (!panel) return;
            const currentMode = editRow?.dataset.mode;
            if (editRow) {
              editRow.remove();
              editRow = null;
              if (currentMode === mode) { repositionFloating(); return; }
            }

            editRow = document.createElement('div');
            editRow.className = 'kivi-img-ctrl-edit-row';
            editRow.dataset.mode = mode;
            editRow.style.pointerEvents = 'auto';

            const labels: Record<string, string> = { src: 'URL', alt: 'Alt' };
            const attrKeys: Record<string, string> = { src: 'src', alt: 'alt' };
            const placeholders: Record<string, string> = { src: 'Source URL or path...', alt: 'Alt text...' };

            const label = document.createElement('span');
            label.className = 'kivi-img-ctrl-edit-label';
            label.textContent = labels[mode];
            editRow.appendChild(label);

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'kivi-img-ctrl-edit-input';
            const currentVal = getNodeAttr(attrKeys[mode]);
            input.value = currentVal != null ? String(currentVal) : '';
            input.placeholder = placeholders[mode];
            input.addEventListener('mousedown', (e) => e.stopPropagation());
            input.addEventListener('keydown', (e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                updateNodeAttr(attrKeys[mode], input.value);
                if (mode === 'src' && activeEl) (activeEl as HTMLMediaElement).src = input.value;
              }
              if (e.key === 'Escape') { editRow?.remove(); editRow = null; repositionFloating(); }
            });
            input.addEventListener('change', () => {
              updateNodeAttr(attrKeys[mode], input.value);
              if (mode === 'src' && activeEl) (activeEl as HTMLMediaElement).src = input.value;
            });
            editRow.appendChild(input);

            panel.appendChild(editRow);
            repositionFloating();
            requestAnimationFrame(() => input.focus());
          }

          function buildSizePresetRow(view: EditorView): HTMLElement {
            const row = document.createElement('div');
            row.className = 'kivi-img-size-presets';
            const currentWidth = (getNodeAttr('width') as number | null) ?? 0;
            const editorWidth = getEditorContentWidth(view);

            for (const preset of SIZE_PRESETS) {
              const btn = document.createElement('button');
              btn.className = 'kivi-img-size-preset-btn';
              btn.textContent = preset.label;
              btn.title = `${preset.pct}% width`;
              const targetWidth = Math.round(editorWidth * preset.pct / 100);
              if (currentWidth > 0 && Math.abs(currentWidth - targetWidth) < 10) btn.classList.add('active');
              btn.addEventListener('mousedown', (e) => e.preventDefault());
              btn.addEventListener('click', () => {
                updateNodeAttr('width', targetWidth);
                reattachAfterTransaction(view);
                row.querySelectorAll('.kivi-img-size-preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
              });
              row.appendChild(btn);
            }
            return row;
          }

          function showOverlay(view: EditorView, el: HTMLElement, pos: number, kind: MediaKind) {
            if (kind === 'image') {
              const img = el as HTMLImageElement;
              if (!img.dataset.kiviBrokenWatched) {
                img.dataset.kiviBrokenWatched = '1';
                img.addEventListener('error', () => img.classList.add('kivi-img-broken'));
                img.addEventListener('load', () => img.classList.remove('kivi-img-broken'));
                if (img.complete && img.naturalWidth === 0 && img.src) img.classList.add('kivi-img-broken');
              }
            }

            if (panel && activeEl === el) {
              activePos = pos;
              activeView = view;
              activeKind = kind;
              attachScroll(view);
              repositionFloating();
              return;
            }
            removeOverlay();
            activeEl = el;
            activePos = pos;
            activeView = view;
            activeKind = kind;

            // Selection outline (replaces scattered blue squares with a clean border)
            selectionOutline = document.createElement('div');
            selectionOutline.className = 'kivi-media-outline';
            document.body.appendChild(selectionOutline);

            panel = document.createElement('div');
            panel.className = 'kivi-image-controls';
            panel.setAttribute('role', 'toolbar');
            panel.setAttribute('aria-label', `${kind} controls`);
            panel.style.pointerEvents = 'none';
            panel.addEventListener('mousedown', (e) => e.preventDefault());

            const buttonRow = document.createElement('div');
            buttonRow.className = 'kivi-img-ctrl-row';

            // Alignment buttons (for images and videos, not audio or excalidraw)
            if (kind !== 'audio' && kind !== 'excalidrawBlock') {
              const currentAlign = (getNodeAttr('data-align') as string) || 'left';
              const alignOptions = [
                { value: 'left', icon: ICONS.alignLeft, title: 'Align left' },
                { value: 'center', icon: ICONS.alignCenter, title: 'Align center' },
                { value: 'right', icon: ICONS.alignRight, title: 'Align right' },
              ];
              const alignBtns: HTMLButtonElement[] = [];
              for (const opt of alignOptions) {
                const b = makeBtn(opt.icon, opt.title, () => {
                  updateNodeAttr('data-align', opt.value);
                  reattachAfterTransaction(view);
                  for (const ab of alignBtns) ab.classList.remove('active');
                  b.classList.add('active');
                });
                if (currentAlign === opt.value) b.classList.add('active');
                alignBtns.push(b);
                buttonRow.appendChild(b);
              }
              buttonRow.appendChild(makeSep());
            }

            // Source URL button (not for excalidraw with src — show file path instead)
            if (kind === 'excalidrawBlock') {
              const excSrc = getNodeAttr('src') as string | null;
              if (excSrc) {
                const label = document.createElement('span');
                label.className = 'kivi-img-ctrl-label';
                label.textContent = excSrc.split('/').pop() || 'excalidraw';
                label.title = excSrc;
                buttonRow.appendChild(label);
              }
            } else {
              buttonRow.appendChild(makeBtn(ICONS.link, 'Edit source URL', () => toggleEditRow('src')));
              if (kind === 'image') {
                buttonRow.appendChild(makeBtn(ICONS.alt, 'Edit alt text', () => toggleEditRow('alt')));
              }
            }

            buttonRow.appendChild(makeSep());

            // Copy source
            buttonRow.appendChild(makeBtn(ICONS.copy, 'Copy source URL', () => {
              const src = (getNodeAttr('src') as string) || '';
              navigator.clipboard.writeText(src).catch(() => {});
            }));

            // Delete
            buttonRow.appendChild(makeBtn(ICONS.trash, `Delete ${kind}`, () => {
              const node = view.state.doc.nodeAt(pos);
              if (node) {
                const src = node.attrs.src as string | undefined;
                view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
                if (src) document.dispatchEvent(new CustomEvent('kivi-asset-deleted', { detail: { src } }));
              }
              removeOverlay();
            }, true));

            panel.appendChild(buttonRow);
            panel.appendChild(buildSizePresetRow(view));

            // 4 corner resize handles
            for (const def of HANDLE_DEFS) {
              const handle = document.createElement('div');
              handle.className = 'kivi-media-resize-handle';
              handle.dataset.handlePos = def.pos;
              handle.style.cursor = def.cursor;

              let startX = 0, startY = 0, startWidth = 0, startHeight = 0, aspectRatio = 1;

              handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                resizing = true;
                startX = e.clientX;
                startY = e.clientY;
                startWidth = el.offsetWidth;
                startHeight = el.offsetHeight;
                aspectRatio = startWidth / (startHeight || 1);

                const onMove = (ev: MouseEvent) => {
                  const dx = ev.clientX - startX;
                  const dy = ev.clientY - startY;
                  const primaryDelta = def.xSign * dx;
                  const secondaryDelta = def.ySign * dy * aspectRatio;
                  const newWidth = Math.max(60, startWidth + (primaryDelta + secondaryDelta) / 2);
                  el.style.width = `${Math.round(newWidth)}px`;
                  el.style.maxWidth = '100%';
                  repositionFloating();
                };

                const onUp = () => {
                  resizing = false;
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                  document.body.style.cursor = '';
                  updateNodeAttr('width', Math.round(el.offsetWidth));
                  reattachAfterTransaction(view);
                };

                document.body.style.cursor = def.cursor;
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              });

              document.body.appendChild(handle);
              resizeHandles.push(handle);
            }

            document.body.appendChild(panel);
            attachScroll(view);
            repositionFloating();
          }

          let brokenSweepDone = false;

          return {
            update(view) {
              if (!brokenSweepDone) {
                brokenSweepDone = true;
                view.dom.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
                  if (img.dataset.kiviBrokenWatched) return;
                  img.dataset.kiviBrokenWatched = '1';
                  img.addEventListener('error', () => img.classList.add('kivi-img-broken'));
                  img.addEventListener('load', () => img.classList.remove('kivi-img-broken'));
                  if (img.complete && img.naturalWidth === 0 && img.src) img.classList.add('kivi-img-broken');
                });
              }

              if (resizing) return;

              const media = detectMediaAtSelection(view);
              if (media) {
                showOverlay(view, media.el, media.pos, media.kind);
              } else {
                removeOverlay();
              }
            },
            destroy() {
              removeOverlay();
            },
          };
        },
      }),
    ];
  },
});
