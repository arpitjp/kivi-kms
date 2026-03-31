import { createKiviEditor, KiviEditor } from '@kivi/editor-core';
import './styles.css';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface KiviSettings {
  editorBackground: string;
  codeBlockBackground: string;
  accentColor: string;
  textColor: string;
  headingColor: string;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  customCSS: string;
  showToolbar: boolean;
  zoom: number;
  vscodeEditorFontSize: number;
  vscodeEditorFontFamily: string;
  vscodeEditorWordWrap: string;
}

interface VsCodeMessage {
  type: string;
  content?: string;
  settings?: KiviSettings;
  id?: number;
  data?: Record<string, unknown> | null;
  filePath?: string;
  fileName?: string;
  isReadonly?: boolean;
  newPath?: string;
  heading?: string;
  line?: number;
  headings?: { level: number; text: string; line: number }[];
  path?: string;
  name?: string;
}

const vscode = acquireVsCodeApi();

let editor: KiviEditor | null = null;
let isUpdatingFromExtension = false;
let lastSentContent = '';
let overrideStyleEl: HTMLStyleElement | null = null;
let customCSSStyleEl: HTMLStyleElement | null = null;
let viewMode: 'live' | 'source' | 'split' = 'live';
let filePath = '';
let fileName = '';

// Position state preserved across mode switches
let savedLiveScrollTop = 0;
let savedLiveCursorPos = 0;
let savedSourceScrollTop = 0;
let savedSourceSelStart = 0;
let savedSourceSelEnd = 0;
let splitScrollSyncLock = false;

// ── Persisted state ──

interface WebviewState {
  viewMode?: string;
  searchBarVisible?: boolean;
}

function saveState() {
  const state: WebviewState = { viewMode, searchBarVisible };
  vscode.setState(state);
}

function restoreState() {
  const state = vscode.getState() as WebviewState | undefined;
  if (!state) return;
  if (state.viewMode === 'source' || state.viewMode === 'split' || state.viewMode === 'live') {
    viewMode = state.viewMode;
  }
  if (typeof state.searchBarVisible === 'boolean') searchBarVisible = state.searchBarVisible;
}

// ── Settings ──

function applySettings(s: KiviSettings) {
  if (!overrideStyleEl) {
    overrideStyleEl = document.createElement('style');
    overrideStyleEl.id = 'kivi-setting-overrides';
    document.head.appendChild(overrideStyleEl);
  }
  if (!customCSSStyleEl) {
    customCSSStyleEl = document.createElement('style');
    customCSSStyleEl.id = 'kivi-custom-css';
    document.head.appendChild(customCSSStyleEl);
  }

  // Font size: Kivi override > VS Code editor setting > fallback
  const baseFontSize = (s.fontSize && s.fontSize > 0) ? s.fontSize : (s.vscodeEditorFontSize || 14);
  const zoomFactor = (s.zoom && s.zoom > 0) ? s.zoom / 100 : 1;
  const effectiveFontSize = Math.round(baseFontSize * zoomFactor);

  // Live editor font: Kivi override > system UI font (proportional, for prose)
  // Raw/source font: VS Code editor.fontFamily (monospace, for code)
  const liveFont = s.fontFamily || '';
  const monoFont = s.vscodeEditorFontFamily || '';

  const wordWrapEnabled = s.vscodeEditorWordWrap !== 'off';

  const props: string[] = [];
  if (s.editorBackground) props.push(`--kivi-editor-bg: ${s.editorBackground};`);
  if (s.codeBlockBackground) props.push(`--kivi-codeblock-bg: ${s.codeBlockBackground};`);
  if (s.accentColor) props.push(`--kivi-accent: ${s.accentColor};`);
  if (s.textColor) props.push(`--kivi-text: ${s.textColor};`);
  if (s.headingColor) props.push(`--kivi-heading-color: ${s.headingColor};`);
  props.push(`--kivi-font-size: ${effectiveFontSize}px;`);
  if (monoFont) props.push(`--kivi-mono-font: ${monoFont};`);
  if (s.lineHeight && s.lineHeight > 0) props.push(`--kivi-line-height: ${s.lineHeight};`);

  let css = `:root { ${props.join(' ')} }\n`;

  css += `#editor { font-size: var(--kivi-font-size) !important; }\n`;
  if (liveFont) {
    css += `#editor { font-family: ${liveFont} !important; }\n`;
  }

  if (s.editorBackground) {
    css += `body { background: var(--kivi-editor-bg) !important; }\n`;
    css += `#editor { background: var(--kivi-editor-bg) !important; }\n`;
  }
  if (s.textColor) {
    css += `body { color: var(--kivi-text) !important; }\n`;
    css += `.kivi-vscode-editor { color: var(--kivi-text) !important; }\n`;
  }
  if (s.headingColor) {
    css += `.kivi-vscode-editor h1, .kivi-vscode-editor h2, .kivi-vscode-editor h3, .kivi-vscode-editor h4, .kivi-vscode-editor h5, .kivi-vscode-editor h6 { color: var(--kivi-heading-color) !important; }\n`;
  }
  if (s.codeBlockBackground) {
    css += `.kivi-vscode-editor pre { background: var(--kivi-codeblock-bg) !important; }\n`;
  }
  if (s.accentColor) {
    css += `.kivi-vscode-editor a { color: var(--kivi-accent) !important; }\n`;
  }
  if (s.lineHeight && s.lineHeight > 0) {
    css += `#editor { line-height: var(--kivi-line-height) !important; }\n`;
  }

  // Raw editors + backdrops: monospace font from VS Code editor.fontFamily
  const rawSize = `${effectiveFontSize}px`;
  for (const id of ['kivi-raw-editor', 'kivi-split-raw']) {
    const el = document.getElementById(id) as HTMLTextAreaElement | null;
    if (el) {
      el.style.fontSize = rawSize;
      if (monoFont) el.style.fontFamily = monoFont;
      el.style.whiteSpace = wordWrapEnabled ? 'pre-wrap' : 'pre';
      el.style.overflowX = wordWrapEnabled ? 'hidden' : 'auto';
    }
  }

  // Sync backdrop styles with textarea
  for (const bd of document.querySelectorAll<HTMLPreElement>('.kivi-raw-backdrop')) {
    bd.style.fontSize = rawSize;
    if (monoFont) bd.style.fontFamily = monoFont;
    bd.style.whiteSpace = wordWrapEnabled ? 'pre-wrap' : 'pre';
  }

  // Gutter font size
  const gutter = document.getElementById('kivi-split-gutter');
  if (gutter) {
    gutter.style.fontSize = rawSize;
    if (monoFont) gutter.style.fontFamily = monoFont;
  }

  overrideStyleEl.textContent = css;
  customCSSStyleEl.textContent = s.customCSS || '';

  const toolbar = document.getElementById('kivi-toolbar');
  if (toolbar) {
    toolbar.style.display = s.showToolbar ? '' : 'none';
  }
}

// ── Markdown syntax highlighting for raw/source mode ──

function highlightMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let inFrontmatter = false;
  const firstLine = lines[0]?.trim();
  if (firstLine === '---') inFrontmatter = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Frontmatter
    if (inFrontmatter) {
      if (i > 0 && trimmed === '---') {
        result.push(`<span class="md-frontmatter">${esc(line)}</span>`);
        inFrontmatter = false;
        continue;
      }
      result.push(`<span class="md-frontmatter">${esc(line)}</span>`);
      continue;
    }

    // Code block fences
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(`<span class="md-code-fence">${esc(line)}</span>`);
      continue;
    }

    if (inCodeBlock) {
      result.push(`<span class="md-code-content">${esc(line)}</span>`);
      continue;
    }

    // Headings
    const headingMatch = /^(#{1,6}\s)(.*)$/.exec(line);
    if (headingMatch) {
      result.push(`<span class="md-heading-marker">${esc(headingMatch[1])}</span><span class="md-heading">${highlightInline(headingMatch[2])}</span>`);
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]\s*){3,}$/.test(trimmed)) {
      result.push(`<span class="md-hr">${esc(line)}</span>`);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const qMatch = /^(>\s?)(.*)$/.exec(line);
      if (qMatch) {
        result.push(`<span class="md-blockquote-marker">${esc(qMatch[1])}</span><span class="md-blockquote">${highlightInline(qMatch[2])}</span>`);
        continue;
      }
    }

    // List items
    const ulMatch = /^(\s*)([-*+]\s)(.*)$/.exec(line);
    if (ulMatch) {
      result.push(`${esc(ulMatch[1])}<span class="md-list-marker">${esc(ulMatch[2])}</span>${highlightInline(ulMatch[3])}`);
      continue;
    }
    const olMatch = /^(\s*)(\d+\.\s)(.*)$/.exec(line);
    if (olMatch) {
      result.push(`${esc(olMatch[1])}<span class="md-list-marker">${esc(olMatch[2])}</span>${highlightInline(olMatch[3])}`);
      continue;
    }

    // Task list
    const taskMatch = /^(\s*[-*+]\s)(\[[ xX]\]\s)(.*)$/.exec(line);
    if (taskMatch) {
      result.push(`<span class="md-list-marker">${esc(taskMatch[1])}</span><span class="md-task-marker">${esc(taskMatch[2])}</span>${highlightInline(taskMatch[3])}`);
      continue;
    }

    // Normal line with inline highlighting
    result.push(highlightInline(line));
  }

  return result.join('\n');
}

function highlightInline(text: string): string {
  // Process inline tokens left-to-right with a regex
  return text.replace(
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(~~[^~]+~~)|(\[\[[^\]]+\]\])|(\[[^\]]*\]\([^)]*\))|(!\[[^\]]*\]\([^)]*\))|(#[a-zA-Z][\w/-]*)|(https?:\/\/\S+)/g,
    (match, code, bold1, bold2, italic1, italic2, strike, wikiLink, mdLink, image, tag, url) => {
      if (code) return `<span class="md-inline-code">${esc(match)}</span>`;
      if (bold1 || bold2) return `<span class="md-bold">${esc(match)}</span>`;
      if (italic1 || italic2) return `<span class="md-italic">${esc(match)}</span>`;
      if (strike) return `<span class="md-strike">${esc(match)}</span>`;
      if (wikiLink) return `<span class="md-wiki-link">${esc(match)}</span>`;
      if (mdLink) return `<span class="md-link">${esc(match)}</span>`;
      if (image) return `<span class="md-image">${esc(match)}</span>`;
      if (tag) return `<span class="md-tag">${esc(match)}</span>`;
      if (url) return `<span class="md-url">${esc(match)}</span>`;
      return esc(match);
    },
  );
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function syncHighlight(textarea: HTMLTextAreaElement) {
  const backdrop = textarea.parentElement?.querySelector('.kivi-raw-backdrop') as HTMLPreElement | null;
  if (backdrop) {
    backdrop.innerHTML = highlightMarkdown(textarea.value) + '\n';
  }
}

// ── Init ──

function init() {
  restoreState();

  const editorEl = document.getElementById('editor');
  if (!editorEl) return;

  // --- Main toolbar ---
  const toolbarEl = document.createElement('div');
  toolbarEl.id = 'kivi-toolbar';
  const brand = document.createElement('span');
  brand.className = 'kivi-toolbar-brand';
  brand.textContent = 'Kivi';
  toolbarEl.appendChild(brand);
  const brandSep = document.createElement('span');
  brandSep.className = 'kivi-toolbar-sep';
  toolbarEl.appendChild(brandSep);
  document.body.insertBefore(toolbarEl, editorEl);

  // --- Split container ---
  const splitContainer = document.createElement('div');
  splitContainer.id = 'kivi-split-container';
  splitContainer.style.display = 'none';
  editorEl.parentElement!.insertBefore(splitContainer, editorEl.nextSibling);

  // --- Raw source editor (with syntax highlight backdrop) ---
  const rawWrapper = document.createElement('div');
  rawWrapper.id = 'kivi-raw-wrapper';
  rawWrapper.style.display = 'none';

  const rawBackdrop = document.createElement('pre');
  rawBackdrop.className = 'kivi-raw-backdrop';
  rawWrapper.appendChild(rawBackdrop);

  const rawEl = document.createElement('textarea');
  rawEl.id = 'kivi-raw-editor';
  rawEl.spellcheck = false;
  rawWrapper.appendChild(rawEl);

  editorEl.parentElement!.insertBefore(rawWrapper, splitContainer.nextSibling);

  rawEl.addEventListener('scroll', () => {
    rawBackdrop.scrollTop = rawEl.scrollTop;
    rawBackdrop.scrollLeft = rawEl.scrollLeft;
  });

  createSearchBar();

  // Link preview: request/response pattern via postMessage
  let linkResolveId = 0;
  const pendingLinkResolves = new Map<number, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>();

  function requestLinkResolve(link: { kind: string; target: string; alias?: string }): Promise<any> {
    return new Promise((resolve) => {
      const id = ++linkResolveId;
      const timer = setTimeout(() => {
        pendingLinkResolves.delete(id);
        resolve(null);
      }, 3000);
      pendingLinkResolves.set(id, { resolve, timer });
      vscode.postMessage({ type: 'resolveLink', id, link });
    });
  }

  editor = createKiviEditor({
    element: editorEl,
    autoFocus: true,
    editorClass: 'kivi-vscode-editor',
    onResolveLink: (link) => requestLinkResolve(link),
    onNavigateLink: (link) => {
      vscode.postMessage({ type: 'navigateLink', link });
    },
    onCreatePage: () => {
      const name = prompt('New page name:');
      if (name) vscode.postMessage({ type: 'createChildPage', name });
    },
    imageStorageAdapter: {
      async store(blob: Blob, filename: string): Promise<string> {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const uploadId = `${filename}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            vscode.postMessage({ type: 'storeImage', data: dataUrl, name: filename, uploadId });

            const handler = (event: MessageEvent) => {
              if (event.data?.type === 'imageStored' && event.data?.name === filename) {
                window.removeEventListener('message', handler);
                resolve(event.data.path);
              }
            };
            window.addEventListener('message', handler);
            setTimeout(() => {
              window.removeEventListener('message', handler);
              resolve(dataUrl);
            }, 5000);
          };
          reader.readAsDataURL(blob);
        });
      },
    },
  });

  initToolbar(toolbarEl);
  initFloatingBar();
  initContextMenu();

  // Apply restored state
  if (viewMode !== 'live') doSetViewMode(viewMode);
  if (searchBarVisible) {
    const bar = document.getElementById('kivi-search-bar');
    if (bar) bar.style.display = 'flex';
  }

  // Sync raw -> extension host
  let rawDebounce: ReturnType<typeof setTimeout> | null = null;
  const hookRawInput = (el: HTMLTextAreaElement) => {
    el.addEventListener('input', () => {
      if (rawDebounce) clearTimeout(rawDebounce);
      rawDebounce = setTimeout(() => {
        const content = el.value;
        if (content === lastSentContent) return;
        lastSentContent = content;
        vscode.postMessage({ type: 'edit', content });
        syncHighlight(el);
        if (viewMode === 'split' && editor) {
          isUpdatingFromExtension = true;
          editor.loadMarkdown(content);
          isUpdatingFromExtension = false;
        }
      }, 300);
    });
  };
  hookRawInput(rawEl);

  // Debounced edit send from ProseMirror
  editor.onUpdate(({ markdown }) => {
    if (isUpdatingFromExtension) return;
    if (markdown === lastSentContent) return;
    lastSentContent = markdown;
    vscode.postMessage({ type: 'edit', content: markdown });
    if (viewMode === 'split') {
      const splitRaw = document.getElementById('kivi-split-raw') as HTMLTextAreaElement | null;
      if (splitRaw) {
        const scrollTop = splitRaw.scrollTop;
        splitRaw.value = markdown;
        splitRaw.scrollTop = scrollTop;
        const gutter = document.getElementById('kivi-split-gutter');
        if (gutter) updateLineNumbers(splitRaw, gutter);
        syncHighlight(splitRaw);
      }
    }
    saveState();
  });

  // ── Message handler ──

  window.addEventListener('message', (event: MessageEvent<VsCodeMessage>) => {
    const msg = event.data;
    if (!editor) return;

    switch (msg.type) {
      case 'init': {
        if (msg.filePath) filePath = msg.filePath;
        if (msg.fileName) fileName = msg.fileName;
        updateBreadcrumb();
        break;
      }

      case 'load':
      case 'externalChange': {
        if (msg.content !== undefined) {
          isUpdatingFromExtension = true;
          lastSentContent = msg.content;
          if (viewMode === 'live' || viewMode === 'split') {
            const currentMd = editor.getMarkdown();
            if (msg.content !== currentMd) {
              const tiptapEd = editor.getTiptapEditor();
              const savedPos = Math.min(
                tiptapEd.state.selection.anchor,
                tiptapEd.state.doc.content.size - 1,
              );
              const scrollParent = tiptapEd.view.dom.parentElement;
              const savedScroll = scrollParent?.scrollTop || 0;

              editor.loadMarkdown(msg.content);

              try {
                const maxPos = tiptapEd.state.doc.content.size - 1;
                tiptapEd.commands.setTextSelection(Math.min(savedPos, maxPos));
              } catch { /* position out of bounds */ }

              // Restore scroll position after DOM updates
              requestAnimationFrame(() => {
                if (scrollParent) scrollParent.scrollTop = savedScroll;
              });
            }
          }
          for (const id of ['kivi-raw-editor', 'kivi-split-raw']) {
            const raw = document.getElementById(id) as HTMLTextAreaElement | null;
            if (!raw) continue;
            if (viewMode === 'source' || viewMode === 'split') {
              const scrollTop = raw.scrollTop;
              const selStart = raw.selectionStart;
              const selEnd = raw.selectionEnd;
              raw.value = msg.content;
              raw.scrollTop = scrollTop;
              raw.setSelectionRange(selStart, selEnd);
            } else {
              raw.value = msg.content;
            }
          }
          const gutter = document.getElementById('kivi-split-gutter');
          const splitRawEl = document.getElementById('kivi-split-raw') as HTMLTextAreaElement | null;
          if (gutter && splitRawEl) updateLineNumbers(splitRawEl, gutter);
          for (const rid of ['kivi-raw-editor', 'kivi-split-raw']) {
            const rel = document.getElementById(rid) as HTMLTextAreaElement | null;
            if (rel) syncHighlight(rel);
          }
          isUpdatingFromExtension = false;
        }
        break;
      }

      case 'settings':
        if (msg.settings) applySettings(msg.settings);
        break;

      case 'linkResolved': {
        if (msg.id !== undefined) {
          const pending = pendingLinkResolves.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingLinkResolves.delete(msg.id);
            pending.resolve(msg.data ?? null);
          }
        }
        break;
      }

      case 'flushEdits': {
        // Force flush any pending debounced edit
        if (editor) {
          const md = editor.getMarkdown();
          if (md !== lastSentContent) {
            lastSentContent = md;
            vscode.postMessage({ type: 'edit', content: md });
          }
        }
        break;
      }

      case 'fileDeleted': {
        const overlay = document.createElement('div');
        overlay.className = 'kivi-file-deleted-overlay';
        overlay.innerHTML = '<div class="kivi-file-deleted-msg">This file has been deleted.</div>';
        document.body.appendChild(overlay);
        break;
      }

      case 'fileRenamed': {
        if (msg.newPath) {
          filePath = msg.newPath;
          fileName = msg.newPath.split('/').pop()?.replace(/\.md$/, '') || '';
          updateBreadcrumb();
        }
        break;
      }

      case 'scrollToHeading': {
        if (editor && msg.heading) {
          const tiptapEd = editor.getTiptapEditor();
          const { doc } = tiptapEd.state;
          let found = false;
          doc.forEach((node, offset) => {
            if (found) return;
            if (node.type.name === 'heading' && node.textContent.trim() === msg.heading) {
              tiptapEd.commands.setTextSelection(offset + 1);
              tiptapEd.commands.scrollIntoView();
              found = true;
            }
          });
        }
        break;
      }

      case 'scrollToLine': {
        if (editor && typeof msg.line === 'number') {
          const tiptapEd = editor.getTiptapEditor();
          const { doc } = tiptapEd.state;
          let currentLine = 1;
          let targetPos = 0;
          let found = false;
          doc.forEach((node, offset) => {
            if (found) return;
            if (currentLine >= (msg.line || 1)) { found = true; return; }
            currentLine += node.textContent.split('\n').length;
            targetPos = offset + node.nodeSize;
          });
          tiptapEd.commands.setTextSelection(Math.min(targetPos, doc.content.size - 1));
          tiptapEd.commands.scrollIntoView();
        }
        break;
      }

      case 'focus': {
        editor?.focus();
        break;
      }

      case 'childPageCreated': {
        // The new page was created and opened by the extension host.
        // No additional action needed in the source webview.
        break;
      }

      case 'imageStored': {
        // Handled by the pending promise in imageStorageAdapter
        break;
      }
    }
  });

  // ── Keyboard shortcuts ──

  document.addEventListener('keydown', (e) => {
    // Cmd+F: search
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      toggleSearchBar();
    }
    // Cmd+Shift+E: reveal in explorer
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'e') {
      vscode.postMessage({ type: 'revealInExplorer' });
    }
  });

  // Save state before unload
  window.addEventListener('beforeunload', () => saveState());

  vscode.postMessage({ type: 'ready' });
}

// ── Breadcrumb ──

function updateBreadcrumb() {
  const brand = document.querySelector('.kivi-toolbar-brand');
  if (brand && fileName) {
    brand.textContent = fileName;
    (brand as HTMLElement).title = filePath;
  }
}

// ─── View mode / zoom / wrap helpers ───

function saveCurrentPosition() {
  if (viewMode === 'live' || viewMode === 'split') {
    const tiptapEd = editor?.getTiptapEditor();
    if (tiptapEd) {
      savedLiveScrollTop = tiptapEd.view.dom.parentElement?.scrollTop || 0;
      savedLiveCursorPos = tiptapEd.state.selection.anchor;
    }
  }
  if (viewMode === 'source' || viewMode === 'split') {
    const raw = (viewMode === 'split')
      ? document.getElementById('kivi-split-raw') as HTMLTextAreaElement | null
      : document.getElementById('kivi-raw-editor') as HTMLTextAreaElement | null;
    if (raw) {
      savedSourceScrollTop = raw.scrollTop;
      savedSourceSelStart = raw.selectionStart;
      savedSourceSelEnd = raw.selectionEnd;
    }
  }
}

function restorePosition(target: 'live' | 'source' | 'both') {
  if (target === 'live' || target === 'both') {
    const tiptapEd = editor?.getTiptapEditor();
    if (tiptapEd) {
      requestAnimationFrame(() => {
        try {
          const maxPos = tiptapEd.state.doc.content.size - 1;
          tiptapEd.commands.setTextSelection(Math.min(savedLiveCursorPos, maxPos));
        } catch { /* pos out of bounds */ }
        const scrollParent = tiptapEd.view.dom.parentElement;
        if (scrollParent) scrollParent.scrollTop = savedLiveScrollTop;
      });
    }
  }
  if (target === 'source' || target === 'both') {
    const raw = (viewMode === 'split')
      ? document.getElementById('kivi-split-raw') as HTMLTextAreaElement | null
      : document.getElementById('kivi-raw-editor') as HTMLTextAreaElement | null;
    if (raw) {
      requestAnimationFrame(() => {
        raw.scrollTop = savedSourceScrollTop;
        raw.setSelectionRange(savedSourceSelStart, savedSourceSelEnd);
      });
    }
  }
}

function setupScrollSync(splitRaw: HTMLTextAreaElement) {
  const tiptapEd = editor?.getTiptapEditor();
  if (!tiptapEd) return;
  const scrollParent = tiptapEd.view.dom.parentElement;
  if (!scrollParent) return;

  scrollParent.addEventListener('scroll', () => {
    if (splitScrollSyncLock) return;
    splitScrollSyncLock = true;
    const ratio = scrollParent.scrollTop / (scrollParent.scrollHeight - scrollParent.clientHeight || 1);
    splitRaw.scrollTop = ratio * (splitRaw.scrollHeight - splitRaw.clientHeight);
    requestAnimationFrame(() => { splitScrollSyncLock = false; });
  });

  splitRaw.addEventListener('scroll', () => {
    if (splitScrollSyncLock) return;
    splitScrollSyncLock = true;
    const ratio = splitRaw.scrollTop / (splitRaw.scrollHeight - splitRaw.clientHeight || 1);
    scrollParent.scrollTop = ratio * (scrollParent.scrollHeight - scrollParent.clientHeight);
    requestAnimationFrame(() => { splitScrollSyncLock = false; });
  });
}

function doSetViewMode(mode: 'live' | 'source' | 'split') {
  saveCurrentPosition();

  viewMode = mode;
  const editorEl = document.getElementById('editor')!;
  const rawEl = document.getElementById('kivi-raw-editor') as HTMLTextAreaElement;
  const rawWrapper = document.getElementById('kivi-raw-wrapper')!;
  const splitContainer = document.getElementById('kivi-split-container')!;

  const body = document.querySelector('body')!;
  if (editorEl.parentElement !== body && editorEl.closest('#kivi-split-container')) {
    const searchBar = document.getElementById('kivi-search-bar');
    if (searchBar && searchBar.nextSibling) {
      body.insertBefore(editorEl, searchBar.nextSibling);
    } else {
      body.insertBefore(editorEl, splitContainer);
    }
  }

  splitContainer.innerHTML = '';

  if (mode === 'source') {
    if (editor) {
      rawEl.value = editor.getMarkdown();
      syncHighlight(rawEl);
    }
    editorEl.style.display = 'none';
    rawWrapper.style.display = 'flex';
    splitContainer.style.display = 'none';
    restorePosition('source');
    rawEl.focus();
  } else if (mode === 'split') {
    rawWrapper.style.display = 'none';
    splitContainer.style.display = 'flex';

    const leftPane = document.createElement('div');
    leftPane.className = 'kivi-split-pane kivi-split-left';
    leftPane.appendChild(editorEl);
    editorEl.style.display = '';

    const divider = document.createElement('div');
    divider.className = 'kivi-split-divider';

    const rightPane = document.createElement('div');
    rightPane.className = 'kivi-split-pane kivi-split-right';

    const lineNumberGutter = document.createElement('div');
    lineNumberGutter.id = 'kivi-split-gutter';
    lineNumberGutter.className = 'kivi-raw-gutter';
    rightPane.appendChild(lineNumberGutter);

    const splitRawContainer = document.createElement('div');
    splitRawContainer.className = 'kivi-raw-container';

    const splitBackdrop = document.createElement('pre');
    splitBackdrop.className = 'kivi-raw-backdrop';
    splitRawContainer.appendChild(splitBackdrop);

    const splitRaw = document.createElement('textarea');
    splitRaw.id = 'kivi-split-raw';
    splitRaw.className = 'kivi-split-raw-editor';
    splitRaw.spellcheck = false;
    if (editor) {
      splitRaw.value = editor.getMarkdown();
    }
    splitRawContainer.appendChild(splitRaw);
    rightPane.appendChild(splitRawContainer);

    splitBackdrop.innerHTML = highlightMarkdown(splitRaw.value) + '\n';

    splitContainer.appendChild(leftPane);
    splitContainer.appendChild(divider);
    splitContainer.appendChild(rightPane);

    updateLineNumbers(splitRaw, lineNumberGutter);
    setupScrollSync(splitRaw);

    let isDragging = false;
    const onDragMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const rect = splitContainer.getBoundingClientRect();
      const ratio = Math.max(0.2, Math.min(0.8, (e.clientX - rect.left) / rect.width));
      leftPane.style.flex = `${ratio}`;
      rightPane.style.flex = `${1 - ratio}`;
    };
    const onDragEnd = () => {
      if (isDragging) { isDragging = false; document.body.classList.remove('kivi-dragging'); }
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
    };
    divider.addEventListener('mousedown', (e) => {
      isDragging = true; e.preventDefault(); document.body.classList.add('kivi-dragging');
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    });

    let splitDebounce: ReturnType<typeof setTimeout> | null = null;
    splitRaw.addEventListener('input', () => {
      if (splitDebounce) clearTimeout(splitDebounce);
      splitDebounce = setTimeout(() => {
        const content = splitRaw.value;
        if (content === lastSentContent) return;
        lastSentContent = content;
        isUpdatingFromExtension = true;
        editor?.loadMarkdown(content);
        isUpdatingFromExtension = false;
        vscode.postMessage({ type: 'edit', content });
        updateLineNumbers(splitRaw, lineNumberGutter);
        splitBackdrop.innerHTML = highlightMarkdown(content) + '\n';
      }, 300);
    });

    splitRaw.addEventListener('scroll', () => {
      lineNumberGutter.scrollTop = splitRaw.scrollTop;
      splitBackdrop.scrollTop = splitRaw.scrollTop;
      splitBackdrop.scrollLeft = splitRaw.scrollLeft;
    });

    splitRaw.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = splitRaw.selectionStart;
        const end = splitRaw.selectionEnd;
        splitRaw.value = splitRaw.value.substring(0, start) + '  ' + splitRaw.value.substring(end);
        splitRaw.selectionStart = splitRaw.selectionEnd = start + 2;
        splitRaw.dispatchEvent(new Event('input'));
      }
    });

    restorePosition('both');
    editor?.focus();
  } else {
    if (rawEl.value && rawEl.value !== lastSentContent) {
      editor?.loadMarkdown(rawEl.value);
      lastSentContent = rawEl.value;
    }
    rawWrapper.style.display = 'none';
    editorEl.style.display = '';
    splitContainer.style.display = 'none';
    restorePosition('live');
    editor?.focus();
  }

  syncViewButtons();
  saveState();
}

function updateLineNumbers(textarea: HTMLTextAreaElement, gutter: HTMLElement) {
  const lineCount = textarea.value.split('\n').length;
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i++) lines.push(`${i}`);
  gutter.textContent = lines.join('\n');
}

function syncViewButtons() {
  document.querySelectorAll<HTMLButtonElement>('.kivi-view-btn').forEach((btn) => {
    const m = btn.getAttribute('data-mode');
    btn.classList.toggle('active', m === viewMode);
  });
}

// ─── Toolbar ───

function initToolbar(el: HTMLElement) {
  if (!editor) return;
  const tiptap = editor.getTiptapEditor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = () => (tiptap.chain().focus() as any);

  const _s = (d: string) =>
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  const actions = [
    { id: 'bold', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5h4.5a3 3 0 0 1 2.12 5.12A3.25 3.25 0 0 1 9 13.5H4V2.5zM4 8h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`, title: 'Bold (⌘B)', cmd: () => cmd().toggleBold().run(), active: () => tiptap.isActive('bold') },
    { id: 'italic', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="10" y1="2.5" x2="6" y2="13.5"/><line x1="7.5" y1="2.5" x2="11.5" y2="2.5"/><line x1="4.5" y1="13.5" x2="8.5" y2="13.5"/></svg>`, title: 'Italic (⌘I)', cmd: () => cmd().toggleItalic().run(), active: () => tiptap.isActive('italic') },
    { id: 'strike', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="8" x2="14" y2="8" stroke-width="1.5"/><path d="M10.2 4.8C9.7 3.6 8.6 3 7.5 3 5.8 3 4.5 4 4.5 5.5c0 1 .5 1.7 1.3 2.2" stroke-width="1.6" fill="none"/><path d="M5.8 11.2c.5 1.2 1.6 1.8 2.7 1.8 1.7 0 3-1 3-2.5 0-.7-.3-1.3-.8-1.7" stroke-width="1.6" fill="none"/></svg>`, title: 'Strikethrough (⌘⇧X)', cmd: () => cmd().toggleStrike().run(), active: () => tiptap.isActive('strike') },
    { id: 'code', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,3.5 1.5,8 5,12.5"/><polyline points="11,3.5 14.5,8 11,12.5"/></svg>`, title: 'Code (⌘E)', cmd: () => cmd().toggleCode().run(), active: () => tiptap.isActive('code') },
    { id: 'sep' },
    { id: 'h1', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 3v10M2.5 8h5M7.5 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M11 11V6l-1.2.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`, title: 'Heading 1', cmd: () => cmd().toggleHeading({ level: 1 }).run(), active: () => tiptap.isActive('heading', { level: 1 }) },
    { id: 'h2', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3v10M2 8h4.5M6.5 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M9.5 6.5a2 2 0 0 1 3.8.7c0 1.2-1.3 2.3-3.3 3.8h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`, title: 'Heading 2', cmd: () => cmd().toggleHeading({ level: 2 }).run(), active: () => tiptap.isActive('heading', { level: 2 }) },
    { id: 'h3', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3v10M1.5 8h4M5.5 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M9.5 6.3a1.8 1.8 0 0 1 3.2.5 1.6 1.6 0 0 1-1.2 1.7 1.8 1.8 0 0 1 1.5 1.8 2 2 0 0 1-3.5 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`, title: 'Heading 3', cmd: () => cmd().toggleHeading({ level: 3 }).run(), active: () => tiptap.isActive('heading', { level: 3 }) },
    { id: 'sep' },
    { id: 'bullet', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="4" r="1.3" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r="1.3" fill="currentColor" stroke="none"/><line x1="6.5" y1="4" x2="14" y2="4"/><line x1="6.5" y1="8" x2="14" y2="8"/><line x1="6.5" y1="12" x2="14" y2="12"/></svg>`, title: 'Bullet List', cmd: () => cmd().toggleBulletList().run(), active: () => tiptap.isActive('bulletList') },
    { id: 'ordered', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-linecap="round"><text x="1.5" y="5.5" font-size="5.5" font-family="system-ui,-apple-system,sans-serif" font-weight="700" stroke="none">1</text><text x="1.5" y="9.5" font-size="5.5" font-family="system-ui,-apple-system,sans-serif" font-weight="700" stroke="none">2</text><text x="1.5" y="13.5" font-size="5.5" font-family="system-ui,-apple-system,sans-serif" font-weight="700" stroke="none">3</text><line x1="6.5" y1="4" x2="14" y2="4" stroke-width="1.6" fill="none"/><line x1="6.5" y1="8" x2="14" y2="8" stroke-width="1.6" fill="none"/><line x1="6.5" y1="12" x2="14" y2="12" stroke-width="1.6" fill="none"/></svg>`, title: 'Ordered List', cmd: () => cmd().toggleOrderedList().run(), active: () => tiptap.isActive('orderedList') },
    { id: 'task', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="1.5" width="5" height="5" rx="1"/><polyline points="3,4 4,5.2 6,2.8" stroke-width="1.6"/><line x1="9" y1="4" x2="14.5" y2="4"/><rect x="1.5" y="9.5" width="5" height="5" rx="1"/><line x1="9" y1="12" x2="14.5" y2="12"/></svg>`, title: 'Task List', cmd: () => cmd().toggleTaskList().run(), active: () => tiptap.isActive('taskList') },
    { id: 'sep' },
    { id: 'quote', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="1.5" y1="2.5" x2="1.5" y2="13.5" stroke-width="2.5"/><line x1="5" y1="4" x2="14" y2="4" stroke-width="1.5"/><line x1="5" y1="8" x2="11" y2="8" stroke-width="1.5"/><line x1="5" y1="12" x2="13" y2="12" stroke-width="1.5"/></svg>`, title: 'Blockquote', cmd: () => cmd().toggleBlockquote().run(), active: () => tiptap.isActive('blockquote') },
    { id: 'codeblock', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="1" width="13" height="14" rx="2"/><polyline points="5.5,5.5 3.5,8 5.5,10.5"/><polyline points="10.5,5.5 12.5,8 10.5,10.5"/></svg>`, title: 'Code Block', cmd: () => cmd().toggleCodeBlock().run(), active: () => tiptap.isActive('codeBlock') },
    { id: 'hr', svg: _s('<line x1="2" y1="8" x2="14" y2="8" stroke-width="1.5" stroke-dasharray="3,2"/>'), title: 'Horizontal Rule', cmd: () => cmd().setHorizontalRule().run(), active: () => false },
  ];

  for (const action of actions) {
    if (action.id === 'sep') {
      const sep = document.createElement('span');
      sep.className = 'kivi-toolbar-sep';
      el.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'kivi-toolbar-btn';
    btn.title = action.title || '';
    if (action.svg) btn.innerHTML = action.svg;
    btn.addEventListener('click', (e) => { e.preventDefault(); action.cmd?.(); });
    el.appendChild(btn);
  }

  const update = () => {
    const buttons = el.querySelectorAll<HTMLButtonElement>('.kivi-toolbar-btn:not(.kivi-view-btn):not(.kivi-wrap-btn):not(.kivi-graph-btn):not(.kivi-hide-toolbar-btn)');
    let i = 0;
    for (const action of actions) {
      if (action.id === 'sep') continue;
      const btn = buttons[i++];
      if (btn && action.active) btn.classList.toggle('active', action.active());
    }
  };
  tiptap.on('selectionUpdate', update);
  tiptap.on('update', update);

  // ── Right-aligned controls ──
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  el.appendChild(spacer);

  appendViewModeGroup(el);
  appendSep(el);
  appendGraphButton(el);
  appendSep(el);

  // Reveal in explorer button
  const revealBtn = document.createElement('button');
  revealBtn.className = 'kivi-toolbar-btn';
  revealBtn.title = 'Reveal in Explorer';
  revealBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V10"/><path d="M14 2l-5 5"/><path d="M10 2h4v4"/></svg>`;
  revealBtn.addEventListener('click', () => vscode.postMessage({ type: 'revealInExplorer' }));
  el.appendChild(revealBtn);
  appendSep(el);

  const hideBtn = document.createElement('button');
  hideBtn.className = 'kivi-toolbar-btn kivi-hide-toolbar-btn';
  hideBtn.title = 'Hide Toolbar';
  hideBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,10 8,6 12,10"/></svg>`;
  hideBtn.addEventListener('click', () => setToolbarVisible(false));
  el.appendChild(hideBtn);
}

// ─── Floating mini-bar ───

function initFloatingBar() {
  const bar = document.createElement('div');
  bar.id = 'kivi-floating-bar';
  bar.style.display = 'none';

  appendViewModeGroup(bar);
  appendSep(bar);
  appendGraphButton(bar);
  appendSep(bar);

  const showBtn = document.createElement('button');
  showBtn.className = 'kivi-toolbar-btn kivi-show-toolbar-btn';
  showBtn.title = 'Show Toolbar';
  showBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,6 8,10 12,6"/></svg>`;
  showBtn.addEventListener('click', () => setToolbarVisible(true));
  bar.appendChild(showBtn);

  document.body.appendChild(bar);
}

// ─── Context Menu ───

function initContextMenu() {
  const menu = document.createElement('div');
  menu.id = 'kivi-context-menu';
  menu.style.display = 'none';
  document.body.appendChild(menu);

  const items: Array<{ label: string; shortcut?: string; divider?: boolean; action?: () => void }> = [
    { label: 'Cut', shortcut: '⌘X', action: () => document.execCommand('cut') },
    { label: 'Copy', shortcut: '⌘C', action: () => document.execCommand('copy') },
    { label: 'Paste', shortcut: '⌘V', action: () => document.execCommand('paste') },
    { divider: true, label: '' },
    { label: 'Select All', shortcut: '⌘A', action: () => document.execCommand('selectAll') },
    { divider: true, label: '' },
    { label: 'Bold', shortcut: '⌘B', action: () => { const c = editor?.getTiptapEditor()?.chain().focus() as any; c?.toggleBold().run(); } },
    { label: 'Italic', shortcut: '⌘I', action: () => { const c = editor?.getTiptapEditor()?.chain().focus() as any; c?.toggleItalic().run(); } },
    { label: 'Code', shortcut: '⌘E', action: () => { const c = editor?.getTiptapEditor()?.chain().focus() as any; c?.toggleCode().run(); } },
    { label: 'Strikethrough', shortcut: '⌘⇧X', action: () => { const c = editor?.getTiptapEditor()?.chain().focus() as any; c?.toggleStrike().run(); } },
    { divider: true, label: '' },
    { label: 'Insert Link', shortcut: '⌘K', action: () => insertLinkAtCursor() },
    { label: 'Insert Horizontal Rule', action: () => { const c = editor?.getTiptapEditor()?.chain().focus() as any; c?.setHorizontalRule().run(); } },
    { label: 'Toggle Blockquote', action: () => { const c = editor?.getTiptapEditor()?.chain().focus() as any; c?.toggleBlockquote().run(); } },
    { label: 'Toggle Code Block', action: () => { const c = editor?.getTiptapEditor()?.chain().focus() as any; c?.toggleCodeBlock().run(); } },
    { divider: true, label: '' },
    { label: 'Find in File', shortcut: '⌘F', action: () => toggleSearchBar() },
    { label: 'Reveal in Explorer', shortcut: '⌘⇧E', action: () => vscode.postMessage({ type: 'revealInExplorer' }) },
  ];

  for (const item of items) {
    if (item.divider) {
      const hr = document.createElement('div');
      hr.className = 'kivi-ctx-divider';
      menu.appendChild(hr);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'kivi-ctx-item';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = item.label;
    row.appendChild(labelSpan);
    if (item.shortcut) {
      const shortcutSpan = document.createElement('span');
      shortcutSpan.className = 'kivi-ctx-shortcut';
      shortcutSpan.textContent = item.shortcut;
      row.appendChild(shortcutSpan);
    }
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = 'none';
      item.action?.();
    });
    menu.appendChild(row);
  }

  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('#editor') && !target.closest('.kivi-split-raw-editor') && !target.closest('#kivi-raw-editor')) return;
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 350);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = 'block';
  });

  document.addEventListener('click', () => { menu.style.display = 'none'; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.style.display = 'none';
  });
}

function insertLinkAtCursor() {
  const tiptap = editor?.getTiptapEditor();
  if (!tiptap) return;
  const { from, to } = tiptap.state.selection;
  const selectedText = tiptap.state.doc.textBetween(from, to, ' ');
  const url = prompt('Enter URL:', 'https://');
  if (url) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = tiptap.chain().focus() as any;
    chain.setLink({ href: url }).insertContent(selectedText || url).run();
  }
}

function setToolbarVisible(visible: boolean) {
  const toolbar = document.getElementById('kivi-toolbar');
  const floatingBar = document.getElementById('kivi-floating-bar');
  if (toolbar) toolbar.style.display = visible ? '' : 'none';
  if (floatingBar) floatingBar.style.display = visible ? 'none' : 'flex';
}

// ─── Shared control builders ───

function appendViewModeGroup(parent: HTMLElement) {
  const viewGroup = document.createElement('span');
  viewGroup.className = 'kivi-toolbar-view-group';

  const modes: Array<{ mode: 'live' | 'source' | 'split'; label: string; title: string }> = [
    { mode: 'live', label: 'L', title: 'Live Editor' },
    { mode: 'split', label: 'B', title: 'Split View (Both)' },
    { mode: 'source', label: 'S', title: 'Source (Markdown)' },
  ];

  for (const m of modes) {
    const btn = document.createElement('button');
    btn.className = `kivi-toolbar-btn kivi-view-btn${viewMode === m.mode ? ' active' : ''}`;
    btn.title = m.title;
    btn.textContent = m.label;
    btn.setAttribute('data-mode', m.mode);
    btn.addEventListener('click', () => doSetViewMode(m.mode));
    viewGroup.appendChild(btn);
  }

  parent.appendChild(viewGroup);
}


function appendGraphButton(parent: HTMLElement) {
  const graphBtn = document.createElement('button');
  graphBtn.className = 'kivi-toolbar-btn kivi-graph-btn';
  graphBtn.title = 'Open Graph View';
  graphBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><line x1="5.5" y1="5.5" x2="6.8" y2="10.5"/><line x1="10.5" y1="5.5" x2="9.2" y2="10.5"/><line x1="6" y1="4" x2="10" y2="4"/></svg>`;
  graphBtn.addEventListener('click', () => { vscode.postMessage({ type: 'openGraph' }); });
  parent.appendChild(graphBtn);
}

function appendSep(parent: HTMLElement) {
  const sep = document.createElement('span');
  sep.className = 'kivi-toolbar-sep';
  parent.appendChild(sep);
}

// ─── Search ───

let searchBarVisible = false;

function createSearchBar() {
  const bar = document.createElement('div');
  bar.id = 'kivi-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <input type="text" id="kivi-search-input" placeholder="Search..." />
    <button id="kivi-search-prev" title="Previous (⇧Enter)">↑</button>
    <button id="kivi-search-next" title="Next (Enter)">↓</button>
    <label><input type="checkbox" id="kivi-search-case" /> Aa</label>
    <label><input type="checkbox" id="kivi-search-regex" /> .*</label>
    <label><input type="checkbox" id="kivi-search-word" /> \\b</label>
    <span id="kivi-search-count"></span>
    <input type="text" id="kivi-replace-input" placeholder="Replace..." />
    <button id="kivi-replace-one" title="Replace">⏎</button>
    <button id="kivi-replace-all" title="Replace All">⏎⏎</button>
    <button id="kivi-search-close" title="Close (Esc)">✕</button>
  `;
  document.body.insertBefore(bar, document.getElementById('editor'));

  const searchInput = bar.querySelector<HTMLInputElement>('#kivi-search-input')!;
  const replaceInput = bar.querySelector<HTMLInputElement>('#kivi-replace-input')!;
  const caseCheck = bar.querySelector<HTMLInputElement>('#kivi-search-case')!;
  const regexCheck = bar.querySelector<HTMLInputElement>('#kivi-search-regex')!;
  const wordCheck = bar.querySelector<HTMLInputElement>('#kivi-search-word')!;

  const doSearch = () => {
    if (!editor) return;
    const query = searchInput.value;
    if (!query) { editor.clearSearch(); return; }
    editor.search({ query, caseSensitive: caseCheck.checked, regex: regexCheck.checked, wholeWord: wordCheck.checked });
  };

  searchInput.addEventListener('input', doSearch);
  caseCheck.addEventListener('change', doSearch);
  regexCheck.addEventListener('change', doSearch);
  wordCheck.addEventListener('change', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editor?.nextSearchResult(); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); editor?.previousSearchResult(); }
    else if (e.key === 'Escape') { toggleSearchBar(); }
  });

  bar.querySelector('#kivi-search-next')!.addEventListener('click', () => editor?.nextSearchResult());
  bar.querySelector('#kivi-search-prev')!.addEventListener('click', () => editor?.previousSearchResult());
  bar.querySelector('#kivi-search-close')!.addEventListener('click', () => toggleSearchBar());
  bar.querySelector('#kivi-replace-one')!.addEventListener('click', () => {
    const tiptap = editor?.getTiptapEditor();
    if (tiptap) (tiptap.commands as Record<string, (...args: unknown[]) => boolean>)['replaceCurrentResult'](replaceInput.value);
  });
  bar.querySelector('#kivi-replace-all')!.addEventListener('click', () => {
    const tiptap = editor?.getTiptapEditor();
    if (tiptap) (tiptap.commands as Record<string, (...args: unknown[]) => boolean>)['replaceAllResults'](replaceInput.value);
  });
}

function toggleSearchBar() {
  const bar = document.getElementById('kivi-search-bar');
  if (!bar) return;
  searchBarVisible = !searchBarVisible;
  bar.style.display = searchBarVisible ? 'flex' : 'none';
  if (searchBarVisible) {
    const input = bar.querySelector<HTMLInputElement>('#kivi-search-input');
    input?.focus();
    input?.select();
  } else {
    editor?.clearSearch();
    editor?.focus();
  }
  saveState();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
