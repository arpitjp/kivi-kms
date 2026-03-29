import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const imageControlsKey = new PluginKey('kiviImageControls');

const svg = (d: string, w = 16) =>
  `<svg width="${w}" height="${w}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  alignLeft: svg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="2" y1="7" x2="10" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'),
  alignCenter: svg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="4" y1="7" x2="12" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'),
  alignRight: svg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="6" y1="7" x2="14" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'),
  link: svg('<path d="M6.5 9.5a3 3 0 0 1-.5-4l1.5-1.5a3 3 0 0 1 4.2 4.2L10.5 9.5"/><path d="M9.5 6.5a3 3 0 0 1 .5 4l-1.5 1.5a3 3 0 0 1-4.2-4.2L5.5 6.5"/>'),
  alt: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"/><polyline points="14,10 10,7 6,10 4,8.5 2,10"/>'),
  trash: svg('<polyline points="3,4 13,4"/><path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><path d="M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4"/>'),
};

const SIZE_PRESETS: { label: string; width: number }[] = [
  { label: 'XS', width: 120 },
  { label: 'S', width: 240 },
  { label: 'M', width: 400 },
  { label: 'L', width: 600 },
  { label: 'XL', width: 900 },
];

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

export const ImageControls = Extension.create({
  name: 'kiviImageControls',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: imageControlsKey,
        view(_initialView: EditorView) {
          let overlay: HTMLElement | null = null;
          let detailPanel: HTMLElement | null = null;
          let activeImg: HTMLImageElement | null = null;
          let resizing = false;
          let activePos = -1;
          let activeView: EditorView | null = null;
          const resizeHandles: HTMLElement[] = [];
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
            onScroll = () => {
              if (!activeImg || !overlay) return;
              repositionFloating();
            };
            parent.addEventListener('scroll', onScroll, { passive: true });
          }

          function setFloatingVisibility(visible: boolean) {
            const v = visible ? 'visible' : 'hidden';
            if (overlay) overlay.style.visibility = v;
            for (const h of resizeHandles) h.style.visibility = v;
            if (detailPanel) detailPanel.style.visibility = v;
          }

          function positionHandles(img: HTMLImageElement) {
            const rect = img.getBoundingClientRect();
            for (const h of resizeHandles) {
              const isSE = h.classList.contains('kivi-resize-se');
              h.style.position = 'fixed';
              h.style.left = isSE ? `${rect.right - 10}px` : `${rect.left - 2}px`;
              h.style.top = `${rect.bottom - 10}px`;
            }
          }

          function repositionFloating() {
            if (!activeImg || !overlay || !activeView) return;
            if (!isElementVisibleInEditor(activeImg, activeView)) {
              setFloatingVisibility(false);
              return;
            }
            setFloatingVisibility(true);
            const rect = activeImg.getBoundingClientRect();
            overlay.style.left = `${rect.left + rect.width / 2}px`;
            overlay.style.top = `${rect.top - 8}px`;
            positionHandles(activeImg);
            if (detailPanel) positionDetailPanel(activeImg);
          }

          function removeOverlay() {
            detachScroll();
            for (const h of resizeHandles) h.remove();
            resizeHandles.length = 0;
            overlay?.remove();
            detailPanel?.remove();
            overlay = null;
            detailPanel = null;
            activeImg = null;
            activePos = -1;
          }

          function updateNodeAttr(key: string, value: unknown) {
            if (!activeView || activePos < 0) return;
            const node = activeView.state.doc.nodeAt(activePos);
            if (!node) return;
            const tr = activeView.state.tr.setNodeMarkup(activePos, undefined, {
              ...node.attrs,
              [key]: value,
            });
            activeView.dispatch(tr);
          }

          function makeBtn(svgHtml: string, title: string, onClick: () => void, danger = false): HTMLButtonElement {
            const btn = document.createElement('button');
            btn.className = 'kivi-img-ctrl-btn' + (danger ? ' kivi-img-ctrl-danger' : '');
            btn.innerHTML = svgHtml;
            btn.title = title;
            btn.style.pointerEvents = 'auto';
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', onClick);
            return btn;
          }

          function makeSep(): HTMLElement {
            const s = document.createElement('span');
            s.className = 'kivi-img-ctrl-sep';
            return s;
          }

          function showDetailPanel(img: HTMLImageElement, panelType: 'alt' | 'url' | 'size') {
            detailPanel?.remove();
            detailPanel = document.createElement('div');
            detailPanel.className = 'kivi-img-detail-panel';
            detailPanel.style.pointerEvents = 'none';
            detailPanel.addEventListener('mousedown', (e) => e.preventDefault());

            if (panelType === 'alt' || panelType === 'url') {
              const isAlt = panelType === 'alt';
              const node = activeView?.state.doc.nodeAt(activePos);
              const currentVal = isAlt ? (node?.attrs.alt || '') : (node?.attrs.src || '');

              const label = document.createElement('label');
              label.className = 'kivi-img-detail-label';
              label.textContent = isAlt ? 'Alt text' : 'Image URL';
              label.style.pointerEvents = 'auto';

              const input = document.createElement('input');
              input.className = 'kivi-img-detail-input';
              input.type = 'text';
              input.value = currentVal;
              input.placeholder = isAlt ? 'Describe this image...' : 'https://...';
              input.style.pointerEvents = 'auto';

              const applyBtn = document.createElement('button');
              applyBtn.className = 'kivi-img-detail-apply';
              applyBtn.textContent = 'Apply';
              applyBtn.style.pointerEvents = 'auto';
              applyBtn.addEventListener('click', () => {
                updateNodeAttr(isAlt ? 'alt' : 'src', input.value);
                if (!isAlt && img) img.src = input.value;
                detailPanel?.remove();
                detailPanel = null;
              });

              input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') { applyBtn.click(); }
                if (e.key === 'Escape') { detailPanel?.remove(); detailPanel = null; }
              });

              detailPanel.appendChild(label);
              detailPanel.appendChild(input);
              detailPanel.appendChild(applyBtn);

              positionDetailPanel(img);
              document.body.appendChild(detailPanel);
              setTimeout(() => { input.focus(); input.select(); }, 0);
            } else if (panelType === 'size') {
              const label = document.createElement('span');
              label.className = 'kivi-img-detail-label';
              label.textContent = 'Size';
              label.style.pointerEvents = 'auto';

              detailPanel.appendChild(label);

              const row = document.createElement('div');
              row.className = 'kivi-img-size-row';

              for (const preset of SIZE_PRESETS) {
                const btn = document.createElement('button');
                btn.className = 'kivi-img-size-btn';
                btn.textContent = preset.label;
                btn.title = `${preset.width}px`;
                btn.style.pointerEvents = 'auto';
                if (Math.abs(img.offsetWidth - preset.width) < 20) {
                  btn.classList.add('active');
                }
                btn.addEventListener('mousedown', (e) => e.preventDefault());
                btn.addEventListener('click', () => {
                  img.style.width = `${preset.width}px`;
                  img.style.maxWidth = '100%';
                  updateNodeAttr('width', preset.width);
                  row.querySelectorAll('.active').forEach((b) => b.classList.remove('active'));
                  btn.classList.add('active');
                  repositionFloating();
                });
                row.appendChild(btn);
              }

              detailPanel.appendChild(row);

              // Custom width input
              const customRow = document.createElement('div');
              customRow.className = 'kivi-img-size-custom';
              const wInput = document.createElement('input');
              wInput.type = 'number';
              wInput.className = 'kivi-img-detail-input';
              wInput.placeholder = 'W';
              wInput.value = String(img.offsetWidth);
              wInput.style.width = '70px';
              wInput.style.pointerEvents = 'auto';
              const hInput = document.createElement('input');
              hInput.type = 'number';
              hInput.className = 'kivi-img-detail-input';
              hInput.placeholder = 'H';
              hInput.value = String(img.offsetHeight);
              hInput.style.width = '70px';
              hInput.style.pointerEvents = 'auto';
              const xLabel = document.createElement('span');
              xLabel.textContent = '×';
              xLabel.className = 'kivi-img-size-x';
              xLabel.style.pointerEvents = 'auto';
              customRow.appendChild(wInput);
              customRow.appendChild(xLabel);
              customRow.appendChild(hInput);

              const applyCustom = () => {
                const w = parseInt(wInput.value, 10);
                if (w > 0) {
                  img.style.width = `${w}px`;
                  img.style.maxWidth = '100%';
                  updateNodeAttr('width', w);
                }
                const h = parseInt(hInput.value, 10);
                if (h > 0) {
                  img.style.height = `${h}px`;
                }
                repositionFloating();
              };

              wInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') applyCustom(); });
              hInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') applyCustom(); });

              detailPanel.appendChild(customRow);

              positionDetailPanel(img);
              document.body.appendChild(detailPanel);
            }
          }

          function positionDetailPanel(_img: HTMLImageElement) {
            if (!detailPanel || !overlay) return;
            const oRect = overlay.getBoundingClientRect();
            detailPanel.style.left = `${oRect.left}px`;
            detailPanel.style.top = `${oRect.bottom + 4}px`;
          }

          function showOverlay(view: EditorView, img: HTMLImageElement, pos: number) {
            if (overlay && activeImg === img) {
              activePos = pos;
              activeView = view;
              attachScroll(view);
              repositionFloating();
              return;
            }
            removeOverlay();
            activeImg = img;
            activePos = pos;
            activeView = view;

            overlay = document.createElement('div');
            overlay.className = 'kivi-image-controls';
            overlay.setAttribute('role', 'toolbar');
            overlay.setAttribute('aria-label', 'Image controls');
            overlay.style.pointerEvents = 'none';

            // Alignment buttons
            const alignments: { svg: string; title: string; value: string }[] = [
              { svg: ICONS.alignLeft, title: 'Align left', value: 'left' },
              { svg: ICONS.alignCenter, title: 'Align center', value: 'center' },
              { svg: ICONS.alignRight, title: 'Align right', value: 'right' },
            ];
            for (const align of alignments) {
              overlay.appendChild(makeBtn(align.svg, align.title, () => {
                updateNodeAttr('data-align', align.value);
                img.setAttribute('data-align', align.value);
                img.style.display = 'block';
                img.style.marginLeft = align.value === 'center' || align.value === 'right' ? 'auto' : '';
                img.style.marginRight = align.value === 'center' || align.value === 'left' ? 'auto' : '';
              }));
            }

            overlay.appendChild(makeSep());

            // Size presets as compact buttons
            const sizeGroup = document.createElement('div');
            sizeGroup.className = 'kivi-img-size-group';
            for (const preset of SIZE_PRESETS) {
              const btn = document.createElement('button');
              btn.className = 'kivi-img-size-inline';
              btn.textContent = preset.label;
              btn.title = `${preset.width}px wide`;
              btn.style.pointerEvents = 'auto';
              if (Math.abs(img.offsetWidth - preset.width) < 20) btn.classList.add('active');
              btn.addEventListener('mousedown', (e) => e.preventDefault());
              btn.addEventListener('click', () => {
                img.style.width = `${preset.width}px`;
                img.style.maxWidth = '100%';
                updateNodeAttr('width', preset.width);
                sizeGroup.querySelectorAll('.active').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                repositionFloating();
              });
              sizeGroup.appendChild(btn);
            }
            overlay.appendChild(sizeGroup);

            overlay.appendChild(makeSep());

            // URL button
            overlay.appendChild(makeBtn(ICONS.link, 'Edit URL', () => {
              showDetailPanel(img, 'url');
            }));

            // Alt text button
            overlay.appendChild(makeBtn(ICONS.alt, 'Edit alt text', () => {
              showDetailPanel(img, 'alt');
            }));

            overlay.appendChild(makeSep());

            // Delete
            overlay.appendChild(makeBtn(ICONS.trash, 'Delete image', () => {
              const node = view.state.doc.nodeAt(pos);
              if (node) {
                const tr = view.state.tr.delete(pos, pos + node.nodeSize);
                view.dispatch(tr);
              }
              removeOverlay();
            }, true));

            // Corner resize handles
            const corners: ('se' | 'sw')[] = ['se', 'sw'];
            for (const corner of corners) {
              const handle = document.createElement('div');
              handle.className = `kivi-image-resize-handle kivi-resize-${corner}`;
              handle.title = 'Drag to resize';
              handle.style.pointerEvents = 'auto';

              let startX = 0;
              let startWidth = 0;
              const sign = corner === 'se' ? 1 : -1;

              handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                resizing = true;
                startX = e.clientX;
                startWidth = img.offsetWidth;

                const onMove = (ev: MouseEvent) => {
                  const newWidth = Math.max(60, startWidth + sign * (ev.clientX - startX));
                  img.style.width = `${newWidth}px`;
                  img.style.maxWidth = '100%';
                  repositionFloating();
                };

                const onUp = () => {
                  resizing = false;
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                  document.body.style.cursor = '';

                  updateNodeAttr('width', img.offsetWidth);
                  repositionFloating();
                };

                document.body.style.cursor = corner === 'se' ? 'se-resize' : 'sw-resize';
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              });

              document.body.appendChild(handle);
              resizeHandles.push(handle);
            }

            document.body.appendChild(overlay);
            attachScroll(view);
            repositionFloating();
          }

          return {
            update(view) {
              if (resizing) return;

              const { $from, from } = view.state.selection;
              const node = view.state.doc.nodeAt(from);

              if (node?.type.name === 'image') {
                const dom = view.nodeDOM(from);
                const img = dom instanceof HTMLImageElement ? dom : (dom as HTMLElement)?.querySelector?.('img');
                if (img instanceof HTMLImageElement) {
                  showOverlay(view, img, from);
                  return;
                }
              }

              if ($from.parent.type.name === 'image') {
                const parentPos = $from.before($from.depth);
                const dom = view.nodeDOM(parentPos);
                const img = dom instanceof HTMLImageElement ? dom : (dom as HTMLElement)?.querySelector?.('img');
                if (img instanceof HTMLImageElement) {
                  showOverlay(view, img, parentPos);
                  return;
                }
              }

              removeOverlay();
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
