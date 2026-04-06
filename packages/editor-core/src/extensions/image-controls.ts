import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { addDelayedTooltip } from '../tooltip.js';
import { getHostZoom } from '../zoom.js';

const mediaControlsKey = new PluginKey('kiviMediaControls');

const svg = (d: string, w = 16) =>
  `<svg width="${w}" height="${w}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  alignLeft: svg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="2" y1="7" x2="10" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'),
  alignCenter: svg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="4" y1="7" x2="12" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'),
  alignRight: svg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="6" y1="7" x2="14" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'),
  fullWidth: svg('<path d="M2 4h12M2 12h12"/><path d="M4.5 7.5L2 8l2.5.5"/><path d="M11.5 7.5L14 8l-2.5.5"/>'),
  resetWidth: svg('<path d="M5 4h6M5 12h6"/><path d="M6.5 7.5L9 8l-2.5.5"/><path d="M9.5 7.5L7 8l2.5.5"/>'),
  trash: svg('<polyline points="3,4 13,4"/><path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><path d="M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4"/>'),
  copy: svg('<rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V3a1.5 1.5 0 0 1 1.5-1.5H11"/>'),
  caption: svg('<rect x="2" y="2" width="12" height="7" rx="1"/><line x1="3" y1="11.5" x2="13" y2="11.5"/><line x1="4.5" y1="14" x2="11.5" y2="14"/>'),
  openExt: svg('<path d="M10 2h4v4"/><path d="M14 2L8 8"/><path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4"/>'),
  play: svg('<polygon points="5,3 13,8 5,13" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="4" y="3" width="3" height="10" rx="0.5" fill="currentColor" stroke="none"/><rect x="9" y="3" width="3" height="10" rx="0.5" fill="currentColor" stroke="none"/>'),
};

type HandlePosition = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface HandleInfo {
  pos: HandlePosition;
  cursor: string;
  xSign: number;
  ySign: number;
  edgeOnly?: boolean;
}

const HANDLE_DEFS: HandleInfo[] = [
  { pos: 'nw', cursor: 'nwse-resize', xSign: -1, ySign: -1 },
  { pos: 'n',  cursor: 'ns-resize',   xSign:  0, ySign: -1, edgeOnly: true },
  { pos: 'ne', cursor: 'nesw-resize', xSign:  1, ySign: -1 },
  { pos: 'e',  cursor: 'ew-resize',   xSign:  1, ySign:  0, edgeOnly: true },
  { pos: 'se', cursor: 'nwse-resize', xSign:  1, ySign:  1 },
  { pos: 's',  cursor: 'ns-resize',   xSign:  0, ySign:  1, edgeOnly: true },
  { pos: 'sw', cursor: 'nesw-resize', xSign: -1, ySign:  1 },
  { pos: 'w',  cursor: 'ew-resize',   xSign: -1, ySign:  0, edgeOnly: true },
];


type MediaKind = 'image' | 'video' | 'audio' | 'excalidrawBlock';

function isElementVisibleInEditor(el: HTMLElement, view: EditorView): boolean {
  const wrapper = el.closest('.kivi-video-wrapper, .kivi-audio-wrapper');
  const ir = wrapper ? wrapper.getBoundingClientRect() : el.getBoundingClientRect();
  const container = view.dom.parentElement;
  if (!container) {
    return ir.bottom > 0 && ir.top < window.innerHeight && ir.right > 0 && ir.left < window.innerWidth;
  }
  const cr = container.getBoundingClientRect();
  return ir.bottom > cr.top && ir.top < cr.bottom && ir.right > cr.left && ir.left < cr.right;
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
  const found = (dom as HTMLElement)?.querySelector?.(selector) as HTMLElement | null;
  if (found) return found;
  if (dom instanceof HTMLElement && dom.classList?.contains(`kivi-${typeName}-wrapper`)) {
    return dom.querySelector(selector) as HTMLElement | null;
  }
  return null;
}

/**
 * Compute the offset of `el` relative to `ancestor` by walking the
 * offsetParent chain. Returns layout-space coordinates (unaffected by
 * CSS zoom on the ancestor) suitable for position:absolute inside it.
 */
function getOffsetRelativeTo(el: HTMLElement, ancestor: HTMLElement): { left: number; top: number; width: number; height: number } {
  let left = 0;
  let top = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== ancestor) {
    left += cur.offsetLeft;
    top += cur.offsetTop;
    const op = cur.offsetParent as HTMLElement | null;
    if (!op || op === ancestor) break;
    cur = op;
  }
  return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}

export const ImageControls = Extension.create({
  name: 'kiviImageControls',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mediaControlsKey,
        props: {
          handleDOMEvents: {
            dblclick(view, event) {
              const target = event.target as HTMLElement;
              if (!target.closest('img')) return false;
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!pos) return false;
              const node = view.state.doc.nodeAt(pos.inside >= 0 ? pos.inside : pos.pos);
              if (!node || !MEDIA_NODE_NAMES.has(node.type.name)) return false;
              const src = node.attrs.src as string | undefined;
              if (src && !src.startsWith('data:')) {
                event.preventDefault();
                document.dispatchEvent(new CustomEvent('kivi-open-asset', { detail: { src } }));
                return true;
              }
              return false;
            },
            click(view, event) {
              if (!(event.metaKey || event.ctrlKey)) return false;
              const target = event.target as HTMLElement;
              if (!target.closest('img, video, audio, .kivi-excalidraw-block')) return false;
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!pos) return false;
              const node = view.state.doc.nodeAt(pos.inside >= 0 ? pos.inside : pos.pos);
              if (!node || !MEDIA_NODE_NAMES.has(node.type.name)) return false;
              const src = node.attrs.src as string | undefined;
              if (src && !src.startsWith('data:')) {
                event.preventDefault();
                document.dispatchEvent(new CustomEvent('kivi-open-asset', { detail: { src } }));
                return true;
              }
              return false;
            },
          },
        },
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
          let overlayHost: HTMLElement | null = null;

          function getOverlayHost(view: EditorView): HTMLElement {
            if (overlayHost) return overlayHost;
            const parent = view.dom.parentElement;
            if (parent) {
              if (!getComputedStyle(parent).position || getComputedStyle(parent).position === 'static') {
                parent.style.position = 'relative';
              }
              overlayHost = parent;
              return parent;
            }
            return document.body;
          }

          function detachScroll() {
            if (scrollParentEl && onScroll) {
              scrollParentEl.removeEventListener('scroll', onScroll);
            }
            scrollParentEl = null;
            onScroll = null;
          }

          let scrollRaf: number | null = null;

          function attachScroll(view: EditorView) {
            detachScroll();
            const parent = view.dom.parentElement;
            if (!parent) return;
            scrollParentEl = parent;
            onScroll = () => {
              if (!activeEl || !panel) return;
              if (scrollRaf) return;
              scrollRaf = requestAnimationFrame(() => {
                scrollRaf = null;
                if (activeEl && panel) repositionFloating();
              });
            };
            parent.addEventListener('scroll', onScroll, { passive: true });
          }

          function setFloatingVisibility(visible: boolean) {
            const v = visible ? 'visible' : 'hidden';
            if (panel) panel.style.visibility = v;
            if (selectionOutline) selectionOutline.style.visibility = v;
            for (const h of resizeHandles) h.style.visibility = v;
          }

          /**
           * Get the rect of the media element in the overlay host's coordinate
           * space using offsetLeft/offsetTop chain — these are always in layout
           * space (unaffected by CSS zoom), which is exactly what position:absolute
           * inside the host expects.
           */
          function getRelativeRect(el: HTMLElement, host: HTMLElement) {
            const wrapper = el.closest('.kivi-video-wrapper, .kivi-audio-wrapper') as HTMLElement | null;
            const target = wrapper ?? el;
            return getOffsetRelativeTo(target, host);
          }

          function positionHandles(el: HTMLElement, host: HTMLElement) {
            const rect = getRelativeRect(el, host);
            const midX = rect.left + rect.width / 2;
            const midY = rect.top + rect.height / 2;

            const CS = 10; const CH = CS / 2;
            const EW = 20; const EH = 8;

            for (const handle of resizeHandles) {
              const pos = handle.dataset.handlePos as HandlePosition;
              let left: number, top: number;

              switch (pos) {
                case 'nw': left = rect.left - CH;       top = rect.top - CH; break;
                case 'n':  left = midX - EW / 2;        top = rect.top - EH / 2; break;
                case 'ne': left = rect.left + rect.width - CH; top = rect.top - CH; break;
                case 'e':  left = rect.left + rect.width - EH / 2; top = midY - EW / 2; break;
                case 'se': left = rect.left + rect.width - CH; top = rect.top + rect.height - CH; break;
                case 's':  left = midX - EW / 2;        top = rect.top + rect.height - EH / 2; break;
                case 'sw': left = rect.left - CH;       top = rect.top + rect.height - CH; break;
                case 'w':  left = rect.left - EH / 2;   top = midY - EW / 2; break;
                default: left = 0; top = 0;
              }

              handle.style.left = `${Math.round(left)}px`;
              handle.style.top = `${Math.round(top)}px`;
            }
          }

          function positionOutline(el: HTMLElement, host: HTMLElement) {
            if (!selectionOutline) return;
            const rect = getRelativeRect(el, host);
            const pad = 3;
            selectionOutline.style.left = `${Math.round(rect.left - pad)}px`;
            selectionOutline.style.top = `${Math.round(rect.top - pad)}px`;
            selectionOutline.style.width = `${Math.round(rect.width + pad * 2)}px`;
            selectionOutline.style.height = `${Math.round(rect.height + pad * 2)}px`;
          }

          function repositionFloating() {
            if (!activeEl || !panel || !activeView) return;
            const host = getOverlayHost(activeView);
            if (!isElementVisibleInEditor(activeEl, activeView)) {
              setFloatingVisibility(false);
              return;
            }
            setFloatingVisibility(true);
            const rect = getRelativeRect(activeEl, host);
            const z = getHostZoom(host);

            // Counter-zoom the panel so its visual size stays constant
            panel.style.transform = z !== 1 ? `scale(${1 / z})` : '';
            panel.style.transformOrigin = 'top left';

            const rawPW = panel.offsetWidth || 200;
            const rawPH = panel.offsetHeight || 48;
            // After scale(1/z), panel occupies rawPW/z × rawPH/z layout pixels
            const panelFootprintW = rawPW / z;
            const panelFootprintH = rawPH / z;

            const hostHeight = host.clientHeight;
            const hostWidth = host.clientWidth;
            const scrollTop = host.scrollTop;
            const gap = 4;

            const visibleTop = Math.max(rect.top, scrollTop);
            const visibleBottom = Math.min(rect.top + rect.height, scrollTop + hostHeight);

            let top = visibleTop - panelFootprintH - gap;
            if (top < scrollTop) {
              top = visibleTop + gap;
            }
            if (top + panelFootprintH > visibleBottom - gap) {
              top = visibleBottom - panelFootprintH - gap;
            }
            top = Math.max(scrollTop + gap, Math.min(top, scrollTop + hostHeight - panelFootprintH - gap));

            let left = rect.left + rect.width / 2 - panelFootprintW / 2;
            if (left + panelFootprintW > hostWidth - 8) left = hostWidth - panelFootprintW - 8;
            if (left < 8) left = 8;

            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
            positionHandles(activeEl, host);
            positionOutline(activeEl, host);
          }

          function removeOverlay() {
            detachScroll();
            if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
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

          function toggleEditRow(mode: 'alt') {
            if (!panel) return;
            if (editRow) {
              editRow.remove();
              editRow = null;
              repositionFloating();
              return;
            }

            editRow = document.createElement('div');
            editRow.className = 'kivi-img-ctrl-edit-row';
            editRow.style.pointerEvents = 'auto';

            const label = document.createElement('span');
            label.className = 'kivi-img-ctrl-edit-label';
            label.textContent = 'Alt';
            editRow.appendChild(label);

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'kivi-img-ctrl-edit-input';
            const currentVal = getNodeAttr(mode);
            input.value = currentVal != null ? String(currentVal) : '';
            input.placeholder = 'Describe this image…';
            input.addEventListener('mousedown', (e) => e.stopPropagation());
            input.addEventListener('keydown', (e) => {
              e.stopPropagation();
              if (e.key === 'Enter') updateNodeAttr(mode, input.value);
              if (e.key === 'Escape') { editRow?.remove(); editRow = null; repositionFloating(); }
            });
            input.addEventListener('change', () => updateNodeAttr(mode, input.value));
            editRow.appendChild(input);

            panel.appendChild(editRow);
            repositionFloating();
            requestAnimationFrame(() => input.focus());
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

            const host = getOverlayHost(view);

            selectionOutline = document.createElement('div');
            selectionOutline.className = 'kivi-media-outline';
            host.appendChild(selectionOutline);

            panel = document.createElement('div');
            panel.className = 'kivi-image-controls';
            panel.setAttribute('role', 'toolbar');
            panel.setAttribute('aria-label', `${kind} controls`);
            panel.style.pointerEvents = 'none';
            panel.addEventListener('mousedown', (e) => e.preventDefault());

            const buttonRow = document.createElement('div');
            buttonRow.className = 'kivi-img-ctrl-row';

            if (kind !== 'audio') {
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

              const isFullWidth = getNodeAttr('width') === '100%';
              const fwBtn = makeBtn(
                isFullWidth ? ICONS.resetWidth : ICONS.fullWidth,
                isFullWidth ? 'Reset to natural size' : 'Full width',
                () => {
                  const currentlyFull = getNodeAttr('width') === '100%';
                  updateNodeAttr('width', currentlyFull ? null : '100%');
                  reattachAfterTransaction(view);
                  requestAnimationFrame(() => {
                    if (activeEl && activeView) {
                      const m = detectMediaAtSelection(activeView);
                      if (m) showOverlay(activeView, m.el, m.pos, m.kind);
                    }
                  });
                },
              );
              if (isFullWidth) fwBtn.classList.add('active');
              buttonRow.appendChild(fwBtn);
              buttonRow.appendChild(makeSep());
            }

            if (kind === 'image') {
              buttonRow.appendChild(makeBtn(ICONS.caption, 'Edit alt text', () => toggleEditRow('alt')));
              const imgSrc = (getNodeAttr('src') as string) || '';
              if (/\.gif(\?|$)/i.test(imgSrc)) {
                const img = el as HTMLImageElement;
                const isPaused = !!img.dataset.kiviGifPaused;
                buttonRow.appendChild(makeBtn(
                  isPaused ? ICONS.play : ICONS.pause,
                  isPaused ? 'Play GIF' : 'Pause GIF',
                  () => {
                    if (img.dataset.kiviGifPaused) {
                      if (img.dataset.kiviOrigSrc) {
                        img.src = img.dataset.kiviOrigSrc;
                        delete img.dataset.kiviOrigSrc;
                      }
                      delete img.dataset.kiviGifPaused;
                    } else {
                      const cw = img.naturalWidth || img.width;
                      const ch = img.naturalHeight || img.height;
                      if (cw > 0 && ch > 0) {
                        const c = document.createElement('canvas');
                        c.width = cw;
                        c.height = ch;
                        const ctx = c.getContext('2d');
                        if (ctx) {
                          ctx.drawImage(img, 0, 0, c.width, c.height);
                          img.dataset.kiviOrigSrc = img.src;
                          img.src = c.toDataURL('image/png');
                          img.dataset.kiviGifPaused = '1';
                        }
                      }
                    }
                    requestAnimationFrame(() => {
                      if (activeEl && activeView) {
                        const m = detectMediaAtSelection(activeView);
                        if (m) showOverlay(activeView, m.el, m.pos, m.kind);
                      }
                    });
                  },
                ));
              }
              if (/\.excalidraw\.(png|svg)$/i.test(imgSrc)) {
                buttonRow.appendChild(makeBtn(ICONS.openExt, 'Open in Excalidraw',
                  () => document.dispatchEvent(new CustomEvent('kivi-open-excalidraw', { detail: { src: imgSrc } }))));
              }
            }

            let hasSpecificOpenBtn = false;
            if (kind === 'excalidrawBlock') {
              const excSrc = getNodeAttr('src') as string | null;
              if (excSrc) {
                hasSpecificOpenBtn = true;
                buttonRow.appendChild(makeBtn(ICONS.openExt, 'Edit in Excalidraw',
                  () => document.dispatchEvent(new CustomEvent('kivi-open-excalidraw', { detail: { src: excSrc } }))));
              }
            }

            const mediaSrc = (getNodeAttr('src') as string) || '';
            if (mediaSrc && !hasSpecificOpenBtn) {
              if (kind === 'image' && /\.excalidraw\.(png|svg)$/i.test(mediaSrc)) {
                // "Open in Excalidraw" already added above for this case; skip generic open
              } else {
                const openLabel = kind === 'image' ? 'Open image' : kind === 'video' ? 'Open video' : 'Open audio';
                buttonRow.appendChild(makeBtn(ICONS.openExt, openLabel, () => {
                  document.dispatchEvent(new CustomEvent('kivi-open-asset', { detail: { src: mediaSrc } }));
                }));
              }
            }

            buttonRow.appendChild(makeSep());

            buttonRow.appendChild(makeBtn(ICONS.copy, 'Copy path', () => {
              const src = (getNodeAttr('src') as string) || '';
              document.dispatchEvent(new CustomEvent('kivi-copy-asset-path', { detail: { src } }));
            }));

            buttonRow.appendChild(makeBtn(ICONS.trash, 'Delete', () => {
              const node = view.state.doc.nodeAt(pos);
              if (node) {
                const src = node.attrs.src as string | undefined;
                view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
                if (src) document.dispatchEvent(new CustomEvent('kivi-asset-deleted', { detail: { src } }));
              }
              removeOverlay();
            }, true));

            panel.appendChild(buttonRow);

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
                  const z = getHostZoom(host);
                  const dx = (ev.clientX - startX) / z;
                  const dy = (ev.clientY - startY) / z;
                  let newWidth: number;
                  if (def.edgeOnly && def.ySign !== 0 && def.xSign === 0) {
                    newWidth = Math.max(60, startWidth + def.ySign * dy * aspectRatio);
                  } else if (def.edgeOnly && def.xSign !== 0 && def.ySign === 0) {
                    newWidth = Math.max(60, startWidth + def.xSign * dx);
                  } else {
                    const primaryDelta = def.xSign * dx;
                    const secondaryDelta = def.ySign * dy * aspectRatio;
                    newWidth = Math.max(60, startWidth + (primaryDelta + secondaryDelta) / 2);
                  }
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

              host.appendChild(handle);
              resizeHandles.push(handle);
            }

            host.appendChild(panel);
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
