import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { getHostZoom, isScrollZoomed } from '../zoom.js';

export interface LinkSuggestFileInfo {
  rel: string;
  name: string;
  relToDoc: string;
  fileType: string;
  ext: string;
}

export interface LinkSuggestOptions {
  getFiles: () => LinkSuggestFileInfo[] | Promise<LinkSuggestFileInfo[]>;
}

const linkSuggestKey = new PluginKey('linkSuggest');

type TriggerKind = 'wiki' | 'md';

interface TriggerMatch {
  kind: TriggerKind;
  from: number;
  to: number;
  query: string;
}

const FILE_TYPE_ICONS: Record<string, string> = {
  note: '📄',
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  excalidraw: '✏️',
  pdf: '📕',
  file: '📎',
};

function detectTrigger(state: EditorState): TriggerMatch | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = state.doc.resolve(selection.from);

  for (let d = $pos.depth; d >= 0; d--) {
    if ($pos.node(d).type.name === 'codeBlock') return null;
  }

  const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '\ufffc');
  const parentStart = selection.from - $pos.parentOffset;

  // [[ wiki-link trigger
  const wikiMatch = textBefore.match(/\[\[([^\]|]*)$/);
  if (wikiMatch) {
    const query = wikiMatch[1];
    const offset = $pos.parentOffset - query.length - 2;
    return { kind: 'wiki', from: parentStart + offset, to: selection.from, query };
  }

  // ]( markdown link trigger — only when preceded by [text]
  const mdMatch = textBefore.match(/\[[^\]]*\]\(([^)]*)$/);
  if (mdMatch) {
    const query = mdMatch[1];
    const offset = $pos.parentOffset - query.length;
    return { kind: 'md', from: parentStart + offset, to: selection.from, query };
  }

  return null;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightMatch(text: string, query: string): string {
  if (!query) return escHtml(text);
  const tLower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = tLower.indexOf(qLower);
  if (idx >= 0) {
    return (
      escHtml(text.substring(0, idx)) +
      '<b>' + escHtml(text.substring(idx, idx + query.length)) + '</b>' +
      escHtml(text.substring(idx + query.length))
    );
  }
  let result = '';
  let qi = 0;
  for (let ti = 0; ti < text.length; ti++) {
    if (qi < qLower.length && tLower[ti] === qLower[qi]) {
      result += '<b>' + escHtml(text[ti]) + '</b>';
      qi++;
    } else {
      result += escHtml(text[ti]);
    }
  }
  if (qi < qLower.length) return escHtml(text);
  return result;
}

/**
 * Character-by-character fuzzy scoring (VS Code / Sublime style).
 *
 * Returns 0 for no match.  Higher = better match quality.
 * Bonuses:
 *   - Exact match → 200
 *   - Prefix match → 150 + length bonus
 *   - Contiguous substring → 100 + position bonus (earlier = better)
 *   - Character-by-character subsequence with bonuses for:
 *     · consecutive char runs
 *     · matches at path-segment boundaries (after `/`, `.`, `-`, `_`, space)
 *     · matches at camelCase transitions
 *     · earlier first-match position
 */
function fuzzyScore(name: string, query: string): number {
  if (!query) return 1;
  const nLower = name.toLowerCase();
  const qLower = query.toLowerCase();
  const nLen = nLower.length;
  const qLen = qLower.length;

  if (nLower === qLower) return 200;
  if (nLower.startsWith(qLower)) return 150 + qLen;

  const subIdx = nLower.indexOf(qLower);
  if (subIdx >= 0) return 100 + Math.max(0, 50 - subIdx);

  // Character-by-character subsequence matching
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let firstMatchIdx = -1;

  const SEPARATOR_SET = new Set(['/', '.', '-', '_', ' ']);

  for (let ni = 0; ni < nLen && qi < qLen; ni++) {
    if (nLower[ni] === qLower[qi]) {
      if (firstMatchIdx < 0) firstMatchIdx = ni;
      qi++;
      consecutive++;

      // Consecutive bonus: longer runs score higher
      score += 1 + consecutive;

      // Segment boundary bonus
      if (ni === 0 || SEPARATOR_SET.has(name[ni - 1])) {
        score += 8;
      }
      // camelCase boundary bonus
      else if (ni > 0 && name[ni] !== name[ni].toLowerCase() && name[ni - 1] === name[ni - 1].toLowerCase()) {
        score += 5;
      }
    } else {
      consecutive = 0;
    }
  }

  if (qi < qLen) return 0;

  // Earlier first match is better
  score += Math.max(0, 20 - firstMatchIdx);

  // Length proximity bonus: shorter names that match fully rank higher
  score += Math.max(0, 10 - Math.abs(nLen - qLen));

  return score;
}

function insertSyntaxForFile(
  view: EditorView,
  file: LinkSuggestFileInfo,
  trigger: TriggerMatch,
) {
  const { state } = view;
  const tr = state.tr;
  const { kind, from } = trigger;
  const filePath = file.relToDoc;

  if (kind === 'wiki') {
    const wikiStart = from;

    // For media types in wiki-link context, replace the [[ trigger with
    // type-appropriate block syntax instead of wiki-link mark
    if (file.fileType === 'image') {
      tr.delete(wikiStart, trigger.to);
      const imageType = state.schema.nodes.image;
      if (imageType) {
        tr.replaceWith(wikiStart, wikiStart, imageType.create({ src: filePath, alt: file.name }));
      } else {
        tr.insertText(`![${file.name}](${filePath})`, wikiStart);
      }
    } else if (file.fileType === 'video') {
      tr.delete(wikiStart, trigger.to);
      const videoType = state.schema.nodes.video;
      if (videoType) {
        tr.replaceWith(wikiStart, wikiStart, videoType.create({ src: filePath }));
      } else {
        tr.insertText(`[${file.name}](${filePath})`, wikiStart);
      }
    } else if (file.fileType === 'audio') {
      tr.delete(wikiStart, trigger.to);
      const audioType = state.schema.nodes.audio;
      if (audioType) {
        tr.replaceWith(wikiStart, wikiStart, audioType.create({ src: filePath }));
      } else {
        tr.insertText(`[${file.name}](${filePath})`, wikiStart);
      }
    } else if (file.fileType === 'excalidraw') {
      tr.delete(wikiStart, trigger.to);
      const excalidrawType = state.schema.nodes.excalidrawBlock;
      if (excalidrawType) {
        tr.replaceWith(wikiStart, wikiStart, excalidrawType.create({ file: filePath }));
      } else {
        tr.insertText(`[[${filePath}]]`, wikiStart);
      }
    } else {
      const alias = file.name;
      const target = filePath;
      const insertText = `[[${target}|${alias}]]`;
      tr.delete(wikiStart, trigger.to);
      tr.insertText(insertText, wikiStart);
      const wikiLink = state.schema.marks.wikiLink;
      if (wikiLink) {
        tr.addMark(wikiStart, wikiStart + insertText.length, wikiLink.create({ target, alias }));
      }
      tr.setSelection(TextSelection.create(tr.doc, wikiStart + insertText.length));
    }
  } else {
    // Markdown link context: user typed [text]( — complete the URL portion
    if (file.fileType === 'image') {
      const $pos = state.doc.resolve(from);
      const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '\ufffc');
      const parentStart = from - $pos.parentOffset;
      const bracketIdx = textBefore.lastIndexOf('[');
      if (bracketIdx >= 0 && (bracketIdx === 0 || textBefore[bracketIdx - 1] !== '!')) {
        const $trigEnd = state.doc.resolve(trigger.to);
        const afterChar = $trigEnd.parent.textContent.charAt($trigEnd.parentOffset);
        const closingExists = afterChar === ')';

        tr.insertText('!', parentStart + bracketIdx);
        const shifted = from + 1;
        const deleteEnd = closingExists ? trigger.to + 2 : trigger.to + 1;
        tr.delete(shifted, deleteEnd);
        const insert = filePath + ')';
        tr.insertText(insert, shifted);
        tr.setSelection(TextSelection.create(tr.doc, shifted + insert.length));
        view.dispatch(tr.scrollIntoView());
        view.focus();
        return;
      }
    }

    // Check if a closing `)` already exists right after the query
    // (e.g. from auto-close brackets: `[text]()` with cursor inside parens)
    const $end = state.doc.resolve(trigger.to);
    const charAfter = $end.parent.textContent.charAt($end.parentOffset);
    const hasClosingParen = charAfter === ')';

    if (hasClosingParen) {
      // Delete the partial query + the existing `)`, then insert path + `)`
      tr.delete(from, trigger.to + 1);
      const insertText = filePath + ')';
      tr.insertText(insertText, from);
      tr.setSelection(TextSelection.create(tr.doc, from + insertText.length));
    } else {
      const insertText = filePath + ')';
      tr.delete(from, trigger.to);
      tr.insertText(insertText, from);
      tr.setSelection(TextSelection.create(tr.doc, from + insertText.length));
    }
  }

  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export const LinkSuggest = Extension.create<LinkSuggestOptions>({
  name: 'linkSuggest',

  addOptions() {
    return {
      getFiles: () => [],
    };
  },

  addProseMirrorPlugins() {
    const ext = this;

    let popupEl: HTMLElement | null = null;
    let items: LinkSuggestFileInfo[] = [];
    let selectedIndex = 0;
    let active = false;
    let activeTrigger: TriggerMatch | null = null;
    let editorView: EditorView | null = null;
    let cachedFiles: LinkSuggestFileInfo[] | null = null;
    let lastRenderedQuery = '';
    let lastRenderedItems: string[] | null = null;
    let lastRenderedSelected = -1;
    let fetchingFiles = false;
    let suppressUntil = 0;

    function destroy() {
      if (popupEl) { popupEl.remove(); popupEl = null; }
      items = [];
      selectedIndex = 0;
      active = false;
      activeTrigger = null;
      lastRenderedItems = null;
      lastRenderedSelected = -1;
      lastRenderedQuery = '';
    }

    function applyItem(view: EditorView, file: LinkSuggestFileInfo) {
      const trigger = detectTrigger(view.state);
      if (!trigger) { destroy(); return; }
      suppressUntil = Date.now() + 300;
      insertSyntaxForFile(view, file, trigger);
      destroy();
    }

    function updateSelectedHighlight() {
      if (!popupEl) return;
      const children = popupEl.children;
      for (let i = 0; i < children.length; i++) {
        children[i].classList.toggle('kivi-link-suggest-active', i === selectedIndex);
      }
      const el = children[selectedIndex] as HTMLElement | undefined;
      if (el) el.scrollIntoView({ block: 'nearest' });
      lastRenderedSelected = selectedIndex;
    }

    function renderPopup(view: EditorView) {
      if (!active || items.length === 0 || !activeTrigger) {
        if (popupEl) { popupEl.remove(); popupEl = null; }
        lastRenderedItems = null;
        return;
      }

      const query = activeTrigger.query;
      const itemIds = items.map(f => f.rel);
      const itemsChanged = !lastRenderedItems
        || itemIds.length !== lastRenderedItems.length
        || itemIds.some((id, i) => id !== lastRenderedItems![i])
        || query !== lastRenderedQuery;

      if (!popupEl) {
        popupEl = document.createElement('div');
        popupEl.className = 'kivi-link-suggest';
        popupEl.style.position = 'absolute';
        popupEl.style.zIndex = '10000';
        popupEl.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const target = (e.target as HTMLElement).closest('.kivi-link-suggest-item') as HTMLElement | null;
          if (target) {
            const idx = parseInt(target.dataset.idx ?? '0', 10);
            applyItem(view, items[idx]);
          }
        });
        popupEl.addEventListener('mouseover', (e) => {
          const target = (e.target as HTMLElement).closest('.kivi-link-suggest-item') as HTMLElement | null;
          if (target) {
            const idx = parseInt(target.dataset.idx ?? '0', 10);
            if (idx !== selectedIndex) {
              selectedIndex = idx;
              updateSelectedHighlight();
            }
          }
        });
        view.dom.parentElement?.appendChild(popupEl);
      }

      if (itemsChanged) {
        // Strip path prefixes for display highlighting
        let effectiveQ = query;
        if (query.startsWith('/')) effectiveQ = query.slice(1);
        else if (query.startsWith('~')) effectiveQ = query.slice(1).replace(/^\//, '');
        else if (query.startsWith('./')) effectiveQ = query.slice(2);
        // For ../ keep as-is — relToDoc uses same convention
        // Extract just the filename part for name highlighting
        const lastSlash = effectiveQ.lastIndexOf('/');
        const filePartQ = lastSlash >= 0 ? effectiveQ.slice(lastSlash + 1) : effectiveQ;
        popupEl.innerHTML = items.map((file, i) => {
          const icon = FILE_TYPE_ICONS[file.fileType] || FILE_TYPE_ICONS.file;
          const cls = i === selectedIndex ? ' kivi-link-suggest-active' : '';
          const nameHtml = highlightMatch(file.name, filePartQ);
          const pathHtml = `<span class="kivi-link-suggest-path" title="${escHtml(file.rel)}">${highlightMatch(file.rel, effectiveQ)}</span>`;
          return `<div class="kivi-link-suggest-item${cls}" data-idx="${i}">` +
            `<span class="kivi-link-suggest-icon">${icon}</span>` +
            `<span class="kivi-link-suggest-label">${nameHtml}</span>` +
            pathHtml +
            `</div>`;
        }).join('');
        lastRenderedItems = itemIds;
        lastRenderedSelected = selectedIndex;
        lastRenderedQuery = query;
      } else if (selectedIndex !== lastRenderedSelected) {
        updateSelectedHighlight();
      }

      const coords = view.coordsAtPos(activeTrigger.from);
      const container = view.dom.parentElement;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      const z = getHostZoom(container);

      // Counter-zoom the popup so it stays the same visual size
      popupEl.style.transform = z !== 1 ? `scale(${1 / z})` : '';
      popupEl.style.transformOrigin = 'top left';

      const gap = 4;
      const pad = 8;
      const scrollZ = isScrollZoomed(container);
      const rawPH = popupEl.offsetHeight || 200;
      const rawPW = popupEl.offsetWidth || 280;
      const ph = scrollZ ? rawPH / z : rawPH;
      const pw = scrollZ ? rawPW / z : rawPW;
      const scaledH = ph / z;
      const scaledW = pw / z;
      const lz = (v: number) => scrollZ ? v / z : v;
      const coordTop = scrollZ
        ? (coords.top - cr.top + container.scrollTop) / z
        : (coords.top - cr.top) / z + container.scrollTop;
      const coordBottom = scrollZ
        ? (coords.bottom - cr.top + container.scrollTop) / z
        : (coords.bottom - cr.top) / z + container.scrollTop;
      const coordLeft = scrollZ
        ? (coords.left - cr.left + container.scrollLeft) / z
        : (coords.left - cr.left) / z + container.scrollLeft;

      const viewH = lz(container.clientHeight);
      const scrollTop = lz(container.scrollTop);
      const spaceBelow = (scrollTop + viewH) - coordBottom;
      const spaceAbove = coordTop - scrollTop;

      let top: number;
      if (spaceAbove >= scaledH + gap) {
        top = coordTop - scaledH - gap;
      } else if (spaceBelow >= scaledH + gap) {
        top = coordBottom + gap;
      } else {
        top = spaceAbove >= spaceBelow ? coordTop - scaledH - gap : coordBottom + gap;
      }
      top = Math.max(scrollTop + pad, Math.min(top, scrollTop + viewH - scaledH - pad));

      let left = coordLeft;
      const scrollW = lz(container.scrollWidth);
      if (left + scaledW + pad > scrollW) left = scrollW - scaledW - pad;
      if (left < pad) left = pad;

      popupEl.style.left = `${left}px`;
      popupEl.style.top = `${top}px`;
    }

    function filterAndSort(files: LinkSuggestFileInfo[], query: string): LinkSuggestFileInfo[] {
      // `/` prefix — browse from workspace root; match against `rel`
      if (query.startsWith('/')) {
        return pathPrefixFilter(files, query.slice(1), 'rel');
      }

      // `../` prefix — relative to current doc; relToDoc already uses `../`
      if (query.startsWith('../')) {
        return pathPrefixFilter(files, query, 'relToDoc');
      }

      // `./` prefix — relative to current doc; strip `./` since relToDoc
      // for same-directory files is just `filename.md` (no `./` prefix)
      if (query.startsWith('./')) {
        return pathPrefixFilter(files, query.slice(2), 'relToDoc');
      }

      // `~` prefix — treat as workspace root shorthand
      if (query.startsWith('~')) {
        return pathPrefixFilter(files, query.slice(1).replace(/^\//, ''), 'rel');
      }

      // No prefix — fuzzy match, but boost files closer to current doc
      return fuzzyFilter(files, query);
    }

    /**
     * Path-prefix filtering: show files whose target path starts with the
     * typed directory prefix, then fuzzy-score the remaining portion.
     * If the query is just a directory prefix (ends with `/`), list all
     * direct children of that directory.
     */
    function pathPrefixFilter(
      files: LinkSuggestFileInfo[],
      pathQuery: string,
      field: 'rel' | 'relToDoc',
    ): LinkSuggestFileInfo[] {
      // Split into directory prefix and filename part
      const lastSlash = pathQuery.lastIndexOf('/');
      const dirPrefix = lastSlash >= 0 ? pathQuery.slice(0, lastSlash + 1) : '';
      const filePart = lastSlash >= 0 ? pathQuery.slice(lastSlash + 1) : pathQuery;
      const dirPrefixLower = dirPrefix.toLowerCase();

      const scored: Array<{ file: LinkSuggestFileInfo; score: number }> = [];

      for (const f of files) {
        const target = f[field];
        const targetLower = target.toLowerCase();

        // File must be under the typed directory prefix
        if (dirPrefixLower && !targetLower.startsWith(dirPrefixLower)) continue;

        // The portion after the directory prefix
        const remainder = target.slice(dirPrefix.length);

        if (!filePart) {
          // Just a directory prefix (e.g. "/docs/") — show direct children
          // Direct child = no additional `/` in remainder, or only one segment
          const depth = remainder.split('/').length - 1;
          // Prioritize direct children, then sub-items
          scored.push({ file: f, score: 100 - depth * 10 + (f.fileType === 'note' ? 5 : 0) });
        } else {
          // Score the remainder against the file part
          const score = fuzzyScore(remainder, filePart);
          if (score > 0) scored.push({ file: f, score });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 20).map(s => s.file);
    }

    /**
     * General fuzzy filter with proximity boost for files near the current doc.
     */
    function fuzzyFilter(files: LinkSuggestFileInfo[], query: string): LinkSuggestFileInfo[] {
      const scored: Array<{ file: LinkSuggestFileInfo; score: number }> = [];

      for (const f of files) {
        const nameScore = fuzzyScore(f.name, query);
        const relScore = fuzzyScore(f.rel, query);
        const relToDocScore = fuzzyScore(f.relToDoc, query);
        let score = Math.max(nameScore, relScore, relToDocScore);
        if (score <= 0) continue;

        // Proximity boost: files closer to current doc rank higher
        const depth = (f.relToDoc.match(/\.\.\//g) || []).length;
        if (depth === 0) score += 15; // same directory or child
        else if (depth === 1) score += 8; // sibling directory
        else if (depth === 2) score += 3;

        scored.push({ file: f, score });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 20).map(s => s.file);
    }

    function refreshItems(query: string, view: EditorView) {
      if (cachedFiles) {
        items = filterAndSort(cachedFiles, query);
        selectedIndex = 0;
        renderPopup(view);
        return;
      }
      if (fetchingFiles) return;
      fetchingFiles = true;
      const result = ext.options.getFiles();
      if (result instanceof Promise) {
        result.then((files) => {
          fetchingFiles = false;
          cachedFiles = files;
          if (!active || editorView !== view) return;
          items = filterAndSort(files, query);
          selectedIndex = 0;
          renderPopup(view);
        }).catch(() => { fetchingFiles = false; });
      } else {
        fetchingFiles = false;
        cachedFiles = result;
        items = filterAndSort(result, query);
        selectedIndex = 0;
        renderPopup(view);
      }
    }

    return [
      new Plugin({
        key: linkSuggestKey,
        view() {
          return {
            update(view) {
              editorView = view;

              // Suppress re-activation briefly after applying a suggestion
              // so undo doesn't immediately re-open the popup.
              if (Date.now() < suppressUntil) {
                if (active) destroy();
                return;
              }

              const trigger = detectTrigger(view.state);
              if (!trigger) {
                if (active) destroy();
                return;
              }
              active = true;
              activeTrigger = trigger;
              refreshItems(trigger.query, view);
            },
            destroy() {
              destroy();
              editorView = null;
              cachedFiles = null;
            },
          };
        },
        props: {
          handleKeyDown(view, event) {
            if (!active) return false;

            if (event.key === 'Escape') {
              event.preventDefault();
              destroy();
              return true;
            }

            if (items.length === 0) return false;

            if (event.key === 'ArrowDown') {
              event.preventDefault();
              selectedIndex = (selectedIndex + 1) % items.length;
              updateSelectedHighlight();
              return true;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              selectedIndex = (selectedIndex - 1 + items.length) % items.length;
              updateSelectedHighlight();
              return true;
            }
            if (event.key === 'Tab' || event.key === 'Enter') {
              event.preventDefault();
              applyItem(view, items[selectedIndex]);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});
