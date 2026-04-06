import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { positionFixedPopup } from '../zoom.js';

const calloutPluginKey = new PluginKey('kiviCallout');
const calloutControlsKey = new PluginKey('kiviCalloutControls');

const CALLOUT_REGEX = /^\[!([\w-]+)\]\s*/;

const CALLOUT_META: Record<string, { icon: string; label: string; color: string }> = {
  note:      { icon: 'ℹ', label: 'Note',      color: '#4fc1ff' },
  tip:       { icon: '💡', label: 'Tip',       color: '#4ec9b0' },
  important: { icon: '❗', label: 'Important', color: '#c586c0' },
  warning:   { icon: '⚠', label: 'Warning',   color: '#dcdcaa' },
  caution:   { icon: '🔴', label: 'Caution',   color: '#f48771' },
  info:      { icon: 'ℹ', label: 'Info',       color: '#4fc1ff' },
  success:   { icon: '✅', label: 'Success',   color: '#4ec9b0' },
  danger:    { icon: '🔴', label: 'Danger',    color: '#f48771' },
  bug:       { icon: '🐛', label: 'Bug',       color: '#f44747' },
  example:   { icon: '📋', label: 'Example',   color: '#569cd6' },
  quote:     { icon: '❝', label: 'Quote',      color: '#858585' },
  todo:      { icon: '☑', label: 'Todo',       color: '#4fc1ff' },
  abstract:  { icon: '📄', label: 'Abstract',  color: '#569cd6' },
  question:  { icon: '❓', label: 'Question',  color: '#dcdcaa' },
  faq:       { icon: '❓', label: 'FAQ',        color: '#dcdcaa' },
  failure:   { icon: '❌', label: 'Failure',    color: '#f48771' },
};

const PRIMARY_TYPES = ['note', 'tip', 'warning', 'danger', 'important', 'success', 'bug', 'todo', 'question', 'info'];

function detectCallout(node: PMNode): { type: string; pos: number; markerLength: number } | null {
  if (node.type.name !== 'blockquote') return null;
  const first = node.firstChild;
  if (!first || !first.isTextblock) return null;
  const text = first.textContent;
  const match = CALLOUT_REGEX.exec(text);
  if (!match) return null;
  return { type: match[1].toLowerCase(), pos: 0, markerLength: match[0].length };
}

function buildCalloutDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockquote') return;
    const info = detectCallout(node);
    if (!info) return;

    const meta = CALLOUT_META[info.type] || { icon: 'ℹ', label: info.type, color: '#4fc1ff' };
    const safeType = info.type.replace(/[^a-z0-9-]/g, '');

    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `kivi-callout kivi-callout-${safeType}`,
        'data-callout-type': info.type,
        'data-callout-label': meta.label,
        'data-callout-icon': meta.icon,
      }),
    );

    const firstChild = node.firstChild;
    if (firstChild) {
      const firstChildPos = pos + 1;
      const textStart = firstChildPos + 1;
      decorations.push(
        Decoration.inline(textStart, textStart + info.markerLength, {
          class: 'kivi-callout-marker',
        }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * Find the callout blockquote the cursor is currently inside, if any.
 * Returns the blockquote node, its position, the detected type, and the
 * absolute range of the `[!type]` marker text so we can replace it.
 */
function calloutAtCursor(view: EditorView): {
  bqPos: number;
  bqNode: PMNode;
  type: string;
  markerFrom: number;
  markerTo: number;
} | null {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (node.type.name !== 'blockquote') continue;
    const info = detectCallout(node);
    if (!info) continue;
    const bqPos = $from.before(d);
    const firstChildPos = bqPos + 1;
    const textStart = firstChildPos + 1;
    return {
      bqPos,
      bqNode: node,
      type: info.type,
      markerFrom: textStart,
      markerTo: textStart + info.markerLength,
    };
  }
  return null;
}

function changeCalloutType(view: EditorView, info: ReturnType<typeof calloutAtCursor>, newType: string) {
  if (!info) return;
  const newMarker = `[!${newType}] `;
  const tr = view.state.tr.replaceWith(
    info.markerFrom,
    info.markerTo,
    view.state.schema.text(newMarker),
  );
  view.dispatch(tr);
}

function removeCallout(view: EditorView, info: ReturnType<typeof calloutAtCursor>) {
  if (!info) return;
  const tr = view.state.tr.delete(info.markerFrom, info.markerTo);
  const $bq = tr.doc.resolve(info.bqPos);
  const bqNode = $bq.nodeAfter;
  if (bqNode && bqNode.type.name === 'blockquote') {
    const { content } = bqNode;
    tr.replaceWith(info.bqPos, info.bqPos + bqNode.nodeSize, content);
  }
  view.dispatch(tr);
}

export const CalloutDecoration = Extension.create({
  name: 'kiviCallout',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: calloutPluginKey,
        state: {
          init(_, state) {
            return buildCalloutDecorations(state.doc);
          },
          apply(tr, oldDecorations) {
            if (!tr.docChanged) return oldDecorations;
            return buildCalloutDecorations(tr.doc);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state) ?? DecorationSet.empty;
          },
        },
      }),

      new Plugin({
        key: calloutControlsKey,
        view(_view: EditorView) {
          let toolbar: HTMLElement | null = null;
          let currentType: string | null = null;
          let expandedPicker: HTMLElement | null = null;

          function destroyToolbar() {
            expandedPicker?.remove();
            expandedPicker = null;
            toolbar?.remove();
            toolbar = null;
            currentType = null;
          }

          function buildToolbar(view: EditorView, info: NonNullable<ReturnType<typeof calloutAtCursor>>) {
            if (toolbar && currentType === info.type) {
              reposition(view, info);
              return;
            }
            destroyToolbar();
            currentType = info.type;

            toolbar = document.createElement('div');
            toolbar.className = 'kivi-callout-controls';
            toolbar.addEventListener('mousedown', (e) => e.preventDefault());

            const meta = CALLOUT_META[info.type] || { icon: 'ℹ', label: info.type, color: '#4fc1ff' };

            // Current type label
            const currentLabel = document.createElement('span');
            currentLabel.className = 'kcc-current';
            currentLabel.style.color = meta.color;
            currentLabel.textContent = `${meta.icon} ${meta.label}`;
            toolbar.appendChild(currentLabel);

            const sep1 = document.createElement('span');
            sep1.className = 'kcc-sep';
            toolbar.appendChild(sep1);

            // Quick-switch pills for primary types
            for (const t of PRIMARY_TYPES) {
              if (t === info.type) continue;
              const m = CALLOUT_META[t];
              if (!m) continue;
              const pill = document.createElement('button');
              pill.className = 'kcc-pill';
              pill.title = m.label;
              pill.textContent = m.icon;
              pill.style.setProperty('--pill-color', m.color);
              pill.addEventListener('click', () => {
                const fresh = calloutAtCursor(view);
                changeCalloutType(view, fresh, t);
              });
              toolbar.appendChild(pill);
            }

            const sep2 = document.createElement('span');
            sep2.className = 'kcc-sep';
            toolbar.appendChild(sep2);

            // Remove callout button
            const removeBtn = document.createElement('button');
            removeBtn.className = 'kcc-pill kcc-remove';
            removeBtn.title = 'Remove callout';
            removeBtn.innerHTML = '✕';
            removeBtn.addEventListener('click', () => {
              const fresh = calloutAtCursor(view);
              removeCallout(view, fresh);
            });
            toolbar.appendChild(removeBtn);

            document.body.appendChild(toolbar);
            reposition(view, info);
          }

          function reposition(view: EditorView, info: NonNullable<ReturnType<typeof calloutAtCursor>>) {
            if (!toolbar) return;
            try {
              const coords = view.coordsAtPos(info.bqPos + 1);
              const container = view.dom.parentElement;
              const cr = container?.getBoundingClientRect() ?? null;
              positionFixedPopup({
                anchorRect: { top: coords.top, bottom: coords.bottom, left: coords.left, right: coords.left + 200 },
                popup: toolbar,
                containerRect: cr,
                gap: 4,
                pad: 8,
                preferY: 'above',
                anchorEl: view.dom as HTMLElement,
              });
            } catch {
              // view coords may fail during rapid edits
            }
          }

          return {
            update(view: EditorView) {
              const info = calloutAtCursor(view);
              if (info) {
                buildToolbar(view, info);
              } else {
                destroyToolbar();
              }
            },
            destroy() {
              destroyToolbar();
            },
          };
        },
      }),
    ];
  },
});
