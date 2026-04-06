import { createKiviEditor, KiviEditor, searchPluginKey, setExcalidrawCallbacks, getHostZoom, getBodyZoom, getRectZoomCorrection } from '@kivi/editor-core';
import { computeKiviFontSize, detectToolbarContext } from '../shared/font.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { createMonacoRawEditor, type MonacoRawEditor, type BlameEntry as MonacoBlameEntry, type DiffMark } from './monaco-raw-editor.js';
import './styles.css';


let katexCssLoaded = false;
function ensureKatexCss() {
  if (katexCssLoaded) return;
  katexCssLoaded = true;
  import('katex/dist/katex.min.css');
}

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
  editorZoom: number;
  wordWrap: boolean;
  stickyScrollEnabled: boolean;
  stickyScrollMaxDepth: number;
  vscodeEditorFontSize: number;
  vscodeEditorFontFamily: string;
  vscodeEditorLineHeight: number;
  vscodeEditorWordWrap: string;
  vscodeZoomLevel: number;
}

interface VsCodeMessage {
  type: string;
  content?: string;
  text?: string;
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
  docBaseUrl?: string;
}

const vscode = acquireVsCodeApi();

let editor: KiviEditor | null = null;
let isUpdatingFromExtension = false;
let lastRawEditTimestamp = 0;
let lastSentContent = '';
let savedBaseLines: string[] = [];
let savedGitDiffHunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }> | null = null;
let pendingBlameCallback: ((entries: Array<{ line: number; author: string; date: string; summary: string; hash: string }>) => void) | null = null;

// ── Inline Git Blame (GitLens-style) ──
type BlameEntry = {
  line: number; author: string; authorMail: string;
  authorTime: number; summary: string; hash: string;
};
let blameEnabled = false;
let blameEntries: BlameEntry[] = [];
let blameByLine: Map<number, BlameEntry> = new Map();
let activeBlamePopup: HTMLElement | null = null;
let overrideStyleEl: HTMLStyleElement | null = null;
let customCSSStyleEl: HTMLStyleElement | null = null;
let viewMode: 'live' | 'source' | 'split' = 'live';
let filePath = '';
let fileName = '';
let docBaseUrl = '';
let workspaceBaseUrl = '';
let currentEditorZoom = 100;
let currentWordWrap = true;
let _lastFontSize = 14;
let _lastFontFamily = '';
let rawMonaco: MonacoRawEditor | null = null;
let splitMonaco: MonacoRawEditor | null = null;
let _rawMonacoContainer: HTMLElement | null = null;

function ensureRawMonaco(): MonacoRawEditor {
  if (rawMonaco) return rawMonaco;
  if (!_rawMonacoContainer) throw new Error('Raw Monaco container not initialized');
  const isDark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  rawMonaco = createMonacoRawEditor({
    container: _rawMonacoContainer,
    value: '',
    wordWrap: currentWordWrap,
    fontSize: _lastFontSize || 14,
    fontFamily: _lastFontFamily || undefined,
    onGutterClick: (lineNumber) => handleMonacoGutterClick(rawMonaco!, lineNumber),
  });
  rawMonaco.setTheme(isDark);
  rawMonaco.setOnToggleBlame(() => toggleBlame());

  rawMonaco.onDidChangeContent((content) => {
    if (isUpdatingFromExtension) return;
    vscode.postMessage({ type: 'edit', content });
    if (viewMode === 'source') detectActiveHeadingMonaco();
    // Invalidate authoritative git hunks (stale after edit) and use LCS fallback
    savedGitDiffHunks = null;
    applyDiffToMonaco();
  });

  rawMonaco.onDidScrollChange(() => {
    if (viewMode === 'source') detectActiveHeadingMonaco();
  });

  // Apply any existing diff/blame decorations
  applyDiffToMonaco();
  applyBlameToMonaco();

  return rawMonaco;
}

function detectActiveHeadingMonaco() {
  if (!rawMonaco) return;
  const model = rawMonaco.editor().getModel();
  if (!model) return;
  const scrollTop = rawMonaco.getScrollTop();
  const lineHeight = Number(rawMonaco.editor().getOption(66 /* EditorOption.lineHeight */)) || 20;
  const visibleLine = Math.max(1, Math.floor(scrollTop / lineHeight) + 1);

  let bestHeading = '';
  for (let i = visibleLine; i >= 1; i--) {
    const line = model.getLineContent(i);
    const m = /^(#{1,6})\s+(.*)/.exec(line);
    if (m) { bestHeading = m[2].trim(); break; }
  }
  if (bestHeading) {
    vscode.postMessage({ type: 'activeHeading', heading: bestHeading });
  }
}
let linkResolveId = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pendingLinkResolves = new Map<number, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>();
let workspaceTags: string[] = [];

// Position state preserved across mode switches
let savedLiveScrollTop = 0;
let savedLiveCursorPos = 0;
let savedSourceScrollTop = 0;
let savedSourceSelStart = 0;
let savedSourceSelEnd = 0;

// ─── Link input with autocomplete ───
interface WorkspaceFile { rel: string; name: string; relToDoc: string; fileType?: string; ext?: string }
let cachedWorkspaceFiles: WorkspaceFile[] = [];
let linkInputEl: HTMLElement | null = null;
let linkInputResolve: ((url: string | null) => void) | null = null;

function requestWorkspaceFiles() {
  vscode.postMessage({ type: 'listWorkspaceFiles' });
}

const pendingHeadingCallbacks = new Map<string, (h: Array<{ name: string; slug: string; level: number }>) => void>();
let headingReqCounter = 0;

function fetchFileHeadings(relPath: string): Promise<Array<{ rel: string; name: string; relToDoc: string; fileType: string; ext: string }>> {
  return new Promise((resolve) => {
    const reqId = `h_${++headingReqCounter}`;
    const timer = setTimeout(() => { pendingHeadingCallbacks.delete(reqId); resolve([]); }, 3000);
    pendingHeadingCallbacks.set(reqId, (headings) => {
      clearTimeout(timer);
      const slugify = (t: string) => t.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
      resolve(headings.map(h => ({
        rel: relPath + '#' + (h.slug || slugify(h.name)),
        name: h.name,
        relToDoc: relPath + '#' + (h.slug || slugify(h.name)),
        fileType: 'heading',
        ext: String(h.level),
      })));
    });
    vscode.postMessage({ type: 'getFileHeadings', relPath, reqId });
  });
}

function handleWorkspaceFiles(files: WorkspaceFile[]) {
  cachedWorkspaceFiles = files;
  if (linkInputEl) refreshLinkSuggestions();
}

interface LinkInputResult {
  url: string;
  text?: string;
}

function showLinkInput(
  anchorRect: DOMRect,
  currentUrl?: string,
  currentText?: string,
): Promise<LinkInputResult | null> {
  closeLinkInput();
  return new Promise((resolve) => {
    linkInputResolve = resolve as (v: unknown) => void;

    const container = document.createElement('div');
    container.className = 'kivi-link-input-popup';
    container.addEventListener('mousedown', (e) => e.stopPropagation());

    // Text field — pre-filled with selection or existing link text
    const textRow = document.createElement('div');
    textRow.className = 'kivi-link-input-row';
    const textLabel = document.createElement('span');
    textLabel.className = 'kivi-link-input-label';
    textLabel.textContent = 'Text';
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'kivi-link-input';
    textInput.placeholder = 'Display text...';
    textInput.value = currentText || '';
    textRow.appendChild(textLabel);
    textRow.appendChild(textInput);
    container.appendChild(textRow);

    // URL field — with autocomplete
    const urlRow = document.createElement('div');
    urlRow.className = 'kivi-link-input-row';
    const urlLabel = document.createElement('span');
    urlLabel.className = 'kivi-link-input-label';
    urlLabel.textContent = 'Link';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'kivi-link-input';
    urlInput.placeholder = 'URL, [[wiki-link]], or filename...';
    urlInput.value = currentUrl || '';
    urlRow.appendChild(urlLabel);
    urlRow.appendChild(urlInput);
    container.appendChild(urlRow);

    const list = document.createElement('ul');
    list.className = 'kivi-link-suggestions';
    container.appendChild(list);

    document.body.appendChild(container);
    linkInputEl = container;

    const bz = getBodyZoom();
    const editorDom = document.getElementById('editor');
    const zc = editorDom ? getRectZoomCorrection(editorDom) : 1;
    let linkLeft = Math.max(8, anchorRect.left * zc);
    const maxRight = window.innerWidth - 8;
    if (linkLeft + 340 > maxRight) linkLeft = maxRight - 340;
    container.style.left = `${linkLeft / bz}px`;
    container.style.top = `${(anchorRect.bottom * zc + 4) / bz}px`;

    requestWorkspaceFiles();

    let selectedIdx = -1;

    function getSuggestions(): { label: string; value: string; kind: string }[] {
      const q = urlInput.value.trim().toLowerCase();
      const results: { label: string; value: string; kind: string }[] = [];

      for (const f of cachedWorkspaceFiles) {
        const match = f.name.toLowerCase().includes(q) || f.rel.toLowerCase().includes(q);
        if (!q || match) {
          results.push({ label: f.name, value: `[[${f.name}]]`, kind: 'wiki' });
        }
        if (results.length >= 10) break;
      }

      if (q && /^https?:\/\//.test(q)) {
        results.unshift({ label: q, value: q, kind: 'url' });
      } else if (q && !q.startsWith('[[')) {
        results.push({ label: `https://${q}`, value: `https://${q}`, kind: 'url' });
      }

      return results;
    }

    function renderSuggestions() {
      const suggestions = getSuggestions();
      list.innerHTML = '';
      selectedIdx = -1;
      for (let i = 0; i < suggestions.length; i++) {
        const li = document.createElement('li');
        li.className = 'kivi-link-suggestion-item';
        const kindIcon = suggestions[i].kind === 'wiki' ? '📄' : '🔗';
        li.textContent = `${kindIcon} ${suggestions[i].label}`;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pickSuggestion(suggestions[i]);
        });
        list.appendChild(li);
      }
    }

    function pickSuggestion(s: { label: string; value: string; kind: string }) {
      urlInput.value = s.value;
      if (!textInput.value.trim() && s.kind === 'wiki') {
        textInput.value = s.label;
      }
      commit();
    }

    function commit() {
      const url = urlInput.value.trim();
      if (!url) return;
      closeLinkInput();
      const text = textInput.value.trim() || undefined;
      (linkInputResolve as (v: LinkInputResult | null) => void)?.({ url, text });
      linkInputResolve = null;
    }

    urlInput.addEventListener('input', () => renderSuggestions());
    const handleKeyDown = (e: KeyboardEvent) => {
      const items = list.querySelectorAll('.kivi-link-suggestion-item');
      if (e.key === 'ArrowDown' && document.activeElement === urlInput) {
        e.preventDefault();
        selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('selected', i === selectedIdx));
      } else if (e.key === 'ArrowUp' && document.activeElement === urlInput) {
        e.preventDefault();
        selectedIdx = Math.max(selectedIdx - 1, -1);
        items.forEach((el, i) => el.classList.toggle('selected', i === selectedIdx));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIdx >= 0 && document.activeElement === urlInput) {
          const suggestions = getSuggestions();
          if (suggestions[selectedIdx]) { pickSuggestion(suggestions[selectedIdx]); return; }
        }
        commit();
      } else if (e.key === 'Escape') {
        closeLinkInput();
        (linkInputResolve as (v: LinkInputResult | null) => void)?.(null);
        linkInputResolve = null;
      }
    };
    textInput.addEventListener('keydown', handleKeyDown);
    urlInput.addEventListener('keydown', handleKeyDown);

    const onClickOutside = (ev: MouseEvent) => {
      if (container.contains(ev.target as Node)) return;
      closeLinkInput();
      (linkInputResolve as (v: LinkInputResult | null) => void)?.(null);
      linkInputResolve = null;
    };
    _linkInputClickOutside = onClickOutside;
    setTimeout(() => document.addEventListener('mousedown', onClickOutside, true), 50);

    renderSuggestions();
    // Focus URL field if no text to edit, otherwise text field first
    requestAnimationFrame(() => {
      if (currentUrl) textInput.focus();
      else urlInput.focus();
    });
  });
}

function refreshLinkSuggestions() {
  if (!linkInputEl) return;
  const input = linkInputEl.querySelector<HTMLInputElement>('.kivi-link-input');
  if (input) input.dispatchEvent(new Event('input'));
}

let _linkInputClickOutside: ((ev: MouseEvent) => void) | null = null;
function closeLinkInput() {
  if (_linkInputClickOutside) {
    document.removeEventListener('mousedown', _linkInputClickOutside, true);
    _linkInputClickOutside = null;
  }
  linkInputEl?.remove();
  linkInputEl = null;
}

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

  const wordWrapEnabled = s.wordWrap;
  currentWordWrap = wordWrapEnabled;

  const props: string[] = [];

  const computedSize = computeKiviFontSize(s.fontSize || 0);
  if (computedSize !== null) {
    props.push(`--kivi-font-size: ${computedSize}px;`);
  }

  // CSS zoom for the live editor container only; raw editors use font scaling
  // because CSS zoom breaks textarea selection/cursor positioning.
  const editorZoomPercent = (s.editorZoom > 0) ? s.editorZoom : 100;
  currentEditorZoom = editorZoomPercent;
  const cssZoom = editorZoomPercent / 100;
  const editorDiv = document.getElementById('editor');
  if (editorDiv) (editorDiv.style as any).zoom = String(cssZoom);
  props.push(`--kivi-raw-zoom: ${cssZoom};`);

  // Update toolbar zoom display
  const zoomLabel = document.getElementById('kivi-zoom-label');
  if (zoomLabel) zoomLabel.textContent = `${editorZoomPercent}%`;

  if (s.editorBackground) props.push(`--kivi-editor-bg: ${s.editorBackground};`);
  if (s.codeBlockBackground) props.push(`--kivi-codeblock-bg: ${s.codeBlockBackground};`);
  if (s.accentColor) props.push(`--kivi-accent: ${s.accentColor};`);
  if (s.textColor) props.push(`--kivi-text: ${s.textColor};`);
  if (s.headingColor) props.push(`--kivi-heading-color: ${s.headingColor};`);
  if (s.vscodeEditorFontFamily) props.push(`--kivi-mono-font: ${s.vscodeEditorFontFamily};`);
  if (s.lineHeight && s.lineHeight > 0) props.push(`--kivi-line-height: ${s.lineHeight};`);

  let css = `:root { ${props.join(' ')} }\n`;

  // Font family: kivi override > VS Code editor font (--vscode-editor-font-family).
  // Both live and raw editors default to the editor font via CSS.
  if (s.fontFamily) {
    css += `.kivi-vscode-editor { font-family: ${s.fontFamily} !important; }\n`;
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

  // The live editor (#editor) gets CSS zoom on its container, so its effective
  // visual body font size = baseFontSize * cssZoom.  Monaco editors live outside
  // that zoom container, so we must multiply the base size by the zoom factor to
  // keep them visually consistent.
  const baseFontSize = computedSize ?? s.vscodeEditorFontSize ?? 14;
  _lastFontSize = Math.round(baseFontSize * cssZoom);
  _lastFontFamily = s.fontFamily || s.vscodeEditorFontFamily || '';

  // Word wrap — delegated to applyWordWrap for consistency
  applyWordWrap(wordWrapEnabled);
  syncWordWrapButtons();

  overrideStyleEl.textContent = css;
  customCSSStyleEl.textContent = s.customCSS || '';

  // Update Monaco editors if they exist
  if (rawMonaco) {
    rawMonaco.setFontSize(_lastFontSize);
    if (_lastFontFamily) rawMonaco.setFontFamily(_lastFontFamily);
    rawMonaco.setWordWrap(wordWrapEnabled);
    const isDark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
    rawMonaco.setTheme(isDark);
  }
  if (splitMonaco) {
    splitMonaco.setFontSize(_lastFontSize);
    if (_lastFontFamily) splitMonaco.setFontFamily(_lastFontFamily);
    splitMonaco.setWordWrap(wordWrapEnabled);
    const isDark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
    splitMonaco.setTheme(isDark);
  }

  const toolbar = document.getElementById('kivi-toolbar');
  if (toolbar) {
    toolbar.classList.toggle('kivi-toolbar-collapsed', !s.showToolbar);
  }

  if (typeof (globalThis as any).__kiviUpdateStickyScrollSettings === 'function') {
    (globalThis as any).__kiviUpdateStickyScrollSettings(
      s.stickyScrollEnabled ?? true,
      s.stickyScrollMaxDepth ?? 5,
    );
  }
}

// (Syntax highlighting and search overlay for old textarea raw editor removed —
//  Monaco handles this natively.)

// ── Performance tracing ──

const _perfEnabled = typeof performance !== 'undefined';
const _perfMarks: Record<string, number> = {};

function perfMark(label: string) {
  if (_perfEnabled) _perfMarks[label] = performance.now();
}

function perfLog(label: string, sinceLabel?: string) {
  if (!_perfEnabled) return;
  const now = performance.now();
  const since = sinceLabel ? _perfMarks[sinceLabel] : undefined;
  if (since !== undefined) {
    console.log(`[kivi-perf] ${label}: ${(now - since).toFixed(1)}ms`);
  } else {
    console.log(`[kivi-perf] ${label}: ${now.toFixed(1)}ms (absolute)`);
  }
  _perfMarks[label] = now;
}

// ── Init ──

function init() {
  perfMark('init-start');
  restoreState();

  const editorEl = document.getElementById('editor');
  if (!editorEl) return;

  // --- Main toolbar ---
  const toolbarEl = document.createElement('div');
  toolbarEl.id = 'kivi-toolbar';
  document.body.insertBefore(toolbarEl, editorEl);

  // --- Split container ---
  const splitContainer = document.createElement('div');
  splitContainer.id = 'kivi-split-container';
  splitContainer.style.display = 'none';
  editorEl.parentElement!.insertBefore(splitContainer, editorEl.nextSibling);

  // --- Raw source editor (Monaco) ---
  const rawWrapper = document.createElement('div');
  rawWrapper.id = 'kivi-raw-wrapper';
  rawWrapper.style.display = 'none';

  const rawMonacoContainer = document.createElement('div');
  rawMonacoContainer.id = 'kivi-raw-monaco';
  rawMonacoContainer.style.cssText = 'width:100%;height:100%;';
  rawWrapper.appendChild(rawMonacoContainer);
  _rawMonacoContainer = rawMonacoContainer;

  editorEl.parentElement!.insertBefore(rawWrapper, splitContainer.nextSibling);

  // Legacy compatibility shims — some code still references rawGutter
  const rawGutter = document.createElement('div');
  rawGutter.id = 'kivi-source-gutter';
  rawGutter.style.display = 'none';

  createSearchBar();

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

  let inputPromptId = 0;
  const pendingInputPrompts = new Map<number, { resolve: (v: string | null) => void; timer: ReturnType<typeof setTimeout> }>();

  function requestInput(message: string, placeholder?: string): Promise<string | null> {
    return new Promise((resolve) => {
      const id = ++inputPromptId;
      const timer = setTimeout(() => {
        pendingInputPrompts.delete(id);
        resolve(null);
      }, 60000);
      pendingInputPrompts.set(id, { resolve, timer });
      vscode.postMessage({ type: 'promptInput', id, message, placeholder });
    });
  }

  perfLog('dom-setup', 'init-start');

  // Extract embedded markdown for instant first-paint (avoids ready → load round-trip)
  let initialMarkdown: string | undefined;
  const embeddedEl = document.getElementById('kivi-initial-md');
  if (embeddedEl?.textContent) {
    try { initialMarkdown = JSON.parse(embeddedEl.textContent); } catch { /* ignore */ }
    embeddedEl.remove();
  }

  perfMark('editor-create-start');
  if (initialMarkdown) {
    console.log(`[kivi-perf] markdown size: ${(initialMarkdown.length / 1024).toFixed(1)}KB`);
  }

  try {
  editor = createKiviEditor({
    element: editorEl,
    autoFocus: !initialMarkdown,
    content: initialMarkdown,
    deferContent: !!initialMarkdown,
    editorClass: 'kivi-vscode-editor',
    onResolveLink: (link) => requestLinkResolve(link),
    onNavigateLink: (link) => {
      vscode.postMessage({ type: 'navigateLink', link });
    },
    onCreatePage: () => {
      vscode.postMessage({ type: 'promptCreateChildPage' });
    },
    onInsertAsset: () => {
      vscode.postMessage({ type: 'pickAsset' });
    },
    promptInput: (message, placeholder) => requestInput(message, placeholder),
    createExcalidrawFile: (name: string) => {
      return new Promise<string | null>((resolve) => {
        const reqId = `exc-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        vscode.postMessage({ type: 'createExcalidrawFile', name, reqId });
        const handler = (event: MessageEvent) => {
          if (event.data?.type === 'excalidrawFileCreated' && event.data?.reqId === reqId) {
            window.removeEventListener('message', handler);
            resolve(event.data.relPath || null);
          }
        };
        window.addEventListener('message', handler);
        setTimeout(() => { window.removeEventListener('message', handler); resolve(null); }, 10000);
      });
    },
    linkSuggest: {
      getFileHeadings: (relPath: string) => fetchFileHeadings(relPath),
      getFiles: () => {
        const mapFiles = () => cachedWorkspaceFiles.map(f => ({
          rel: f.rel,
          name: f.name,
          relToDoc: f.relToDoc,
          fileType: f.fileType || 'file',
          ext: f.ext || '',
        }));
        try {
          if (cachedWorkspaceFiles.length > 0) return mapFiles();
          requestWorkspaceFiles();
          return new Promise<Array<{ rel: string; name: string; relToDoc: string; fileType: string; ext: string }>>((resolve) => {
            const onMsg = (ev: MessageEvent) => {
              if (ev.data?.type === 'workspaceFiles') {
                window.removeEventListener('message', onMsg);
                clearTimeout(fallback);
                resolve(mapFiles());
              }
            };
            window.addEventListener('message', onMsg);
            const fallback = setTimeout(() => { window.removeEventListener('message', onMsg); resolve([]); }, 3000);
          });
        } catch { return []; }
      },
    },
    tagSuggestion: {
      items: (query: string) => {
        if (!query) return workspaceTags.slice(0, 15);
        const qLower = query.toLowerCase();

        const scored: { tag: string; score: number }[] = [];
        for (const tag of workspaceTags) {
          const tLower = tag.toLowerCase();

          if (tLower.startsWith(qLower)) {
            scored.push({ tag, score: 100 });
            continue;
          }

          const segments = tLower.split('/');
          if (segments.some(s => s.startsWith(qLower))) {
            scored.push({ tag, score: 80 });
            continue;
          }

          if (tLower.includes(qLower)) {
            scored.push({ tag, score: 60 });
            continue;
          }

          let qi = 0;
          for (let ti = 0; ti < tLower.length && qi < qLower.length; ti++) {
            if (tLower[ti] === qLower[qi]) qi++;
          }
          if (qi === qLower.length) {
            scored.push({ tag, score: 40 - (tLower.length - qLower.length) });
            continue;
          }
        }

        scored.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
        return scored.map(s => s.tag);
      },
    },
    imageStorageAdapter: {
      async store(blob: Blob, filename: string, originalName?: string): Promise<string> {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const uploadId = `${filename}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            vscode.postMessage({ type: 'storeImage', data: dataUrl, name: filename, originalName, uploadId });

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
    fileStorageAdapter: {
      async store(blob: Blob, filename: string, originalName?: string): Promise<string> {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const storeId = `${filename}-${Date.now()}`;
            vscode.postMessage({ type: 'storeFile', data: dataUrl, name: filename, originalName, storeId });

            const handler = (event: MessageEvent) => {
              if (event.data?.type === 'fileStored' && event.data?.storeId === storeId) {
                window.removeEventListener('message', handler);
                resolve(event.data.path);
              }
            };
            window.addEventListener('message', handler);
            setTimeout(() => {
              window.removeEventListener('message', handler);
              reject(new Error('File store timeout'));
            }, 15000);
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      },
    },
  });
  } catch (err) {
    console.error('[kivi] FATAL: editor creation failed', err);
    const errEl = document.createElement('pre');
    errEl.style.cssText = 'color:red;padding:20px;font-size:14px;white-space:pre-wrap;';
    errEl.textContent = `Kivi editor failed to initialize:\n${err instanceof Error ? err.stack || err.message : String(err)}`;
    editorEl.appendChild(errEl);
    return;
  }

  perfLog('editor-created', 'editor-create-start');

  // Wire up Excalidraw file reading / editing callbacks
  let _hasExcalidrawExtension: boolean | null = null;
  setExcalidrawCallbacks({
    readFile: (src: string) => {
      return new Promise<string>((resolve, reject) => {
        const reqId = `excalidraw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        vscode.postMessage({ type: 'readExcalidrawFile', src, reqId });
        const handler = (event: MessageEvent) => {
          if (event.data?.type === 'excalidrawFileContent' && event.data?.reqId === reqId) {
            window.removeEventListener('message', handler);
            if (event.data.error) reject(new Error(event.data.error));
            else resolve(event.data.content);
          }
        };
        window.addEventListener('message', handler);
        setTimeout(() => { window.removeEventListener('message', handler); reject(new Error('timeout')); }, 5000);
      });
    },
    openInEditor: (src: string) => {
      vscode.postMessage({ type: 'openExcalidraw', src });
    },
    hasExcalidrawExtension: () => {
      if (_hasExcalidrawExtension === null) {
        vscode.postMessage({ type: 'checkExcalidrawExtension' });
        return false;
      }
      return _hasExcalidrawExtension;
    },
  });

  // Handle "Open in Excalidraw" from image controls for .excalidraw.png/.svg
  document.addEventListener('kivi-open-excalidraw', ((e: CustomEvent<{ src: string }>) => {
    vscode.postMessage({ type: 'openExcalidraw', src: e.detail.src });
  }) as EventListener);

  // Defer markdown render until docBaseUrl is available so that relative
  // image src attributes are resolved correctly on first paint (avoids
  // ERR_ACCESS_DENIED from the browser fetching against the webview origin).
  // The ready → init round-trip is sub-millisecond so the delay is negligible.
  if (initialMarkdown) {
    lastSentContent = initialMarkdown;
    savedBaseLines = initialMarkdown.split('\n');

    if (/\$\$|\\\[|\\begin\{/.test(initialMarkdown)) ensureKatexCss();

    const loadInitial = () => {
      perfMark('async-load-start');
      editor!.loadMarkdownAsync(initialMarkdown!).then(() => {
        perfLog('async-load-done', 'async-load-start');
        const skeleton = document.getElementById('kivi-skeleton');
        if (skeleton) skeleton.remove();
        document.body.classList.remove('kivi-loading');
        rewriteRelativeImages();
        editor!.focus('start');
        if (viewMode !== 'live') doSetViewMode(viewMode, false);
      }).catch((err: unknown) => {
        console.error('[kivi] loadMarkdownAsync failed:', err);
        const skeleton = document.getElementById('kivi-skeleton');
        if (skeleton) skeleton.remove();
        document.body.classList.remove('kivi-loading');
      });
    };

    if (docBaseUrl) {
      loadInitial();
    } else {
      const onInit = (ev: MessageEvent<VsCodeMessage>) => {
        if (ev.data?.type === 'init') {
          window.removeEventListener('message', onInit);
          loadInitial();
        }
      };
      window.addEventListener('message', onInit);
    }
  } else {
    const skeleton = document.getElementById('kivi-skeleton');
    if (skeleton) skeleton.remove();
    document.body.classList.remove('kivi-loading');
    if (viewMode !== 'live') doSetViewMode(viewMode, false);
  }

  if (searchBarVisible) {
    const bar = document.getElementById('kivi-search-bar');
    if (bar) bar.style.display = '';
  }

  // Defer toolbar/UI chrome to after first frame
  requestAnimationFrame(() => {
    initToolbar(toolbarEl);
    initFloatingBar();
    initContextMenu();
    perfLog('toolbar-setup', 'editor-created');
  });

  document.addEventListener('kivi-link-request', async (e) => {
    const detail = (e as CustomEvent).detail as { from: number; to: number; currentUrl?: string; editMode?: boolean } | undefined;
    if (!detail || !editor) return;
    const tiptap = editor.getTiptapEditor();
    const { from, to, currentUrl, editMode } = detail;
    const selectedText = tiptap.state.doc.textBetween(from, to, ' ');
    const coords = tiptap.view.coordsAtPos(from);
    const rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
    const result = await showLinkInput(rect, currentUrl, selectedText || undefined);
    if (!result) {
      tiptap.chain().focus().setTextSelection({ from, to }).run();
      return;
    }

    const { url, text } = result;
    const displayText = text || selectedText;

    if (editMode) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tiptap.chain().focus().extendMarkRange('link').setLink({ href: url }) as any).run();
      return;
    }

    const wikiMatch = url.match(/^\[\[(.+?)(?:\|(.+?))?\]\]$/);
    if (wikiMatch) {
      const label = displayText || wikiMatch[2] || wikiMatch[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain = tiptap.chain().focus().setTextSelection({ from, to }) as any;
      if (selectedText && !text) {
        chain.setLink({ href: url }).run();
      } else {
        chain.insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href: url } }] }).run();
      }
      return;
    }

    const label = displayText || url;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = tiptap.chain().focus().setTextSelection({ from, to }) as any;
    if (selectedText && !text) {
      chain.setLink({ href: url }).run();
    } else {
      chain.insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    }
  });

  document.addEventListener('kivi-link-navigate', (e) => {
    const detail = (e as CustomEvent).detail as { href: string } | undefined;
    if (!detail?.href) return;
    const href = detail.href;
    const isExternal = href.startsWith('http://') || href.startsWith('https://');
    vscode.postMessage({ type: 'navigateLink', link: { kind: isExternal ? 'external-url' : 'markdown-link', target: href } });
  });

  document.addEventListener('kivi-asset-deleted', (e) => {
    const detail = (e as CustomEvent).detail as { src: string } | undefined;
    if (detail?.src) vscode.postMessage({ type: 'checkOrphanAsset', src: detail.src });
  });

  document.addEventListener('kivi-copy-asset-path', (e) => {
    const detail = (e as CustomEvent).detail as { src: string } | undefined;
    if (detail?.src) vscode.postMessage({ type: 'copyAssetPath', src: detail.src });
  });

  document.addEventListener('kivi-open-asset', (e) => {
    const detail = (e as CustomEvent).detail as { src: string } | undefined;
    if (detail?.src) vscode.postMessage({ type: 'openAsset', src: detail.src });
  });

  // ── Sticky scroll container ──
  let stickyScrollEnabled = true;
  let stickyScrollMaxDepth = 5;

  const stickyScrollEl = document.createElement('div');
  stickyScrollEl.id = 'kivi-sticky-scroll';
  stickyScrollEl.style.display = 'none';
  editorEl.parentElement?.insertBefore(stickyScrollEl, editorEl);

  function updateStickyScrollSettings(enabled: boolean, maxDepth: number) {
    stickyScrollEnabled = enabled;
    stickyScrollMaxDepth = maxDepth;
    if (!enabled) {
      stickyScrollEl.style.display = 'none';
      stickyScrollEl.innerHTML = '';
    }
  }
  (globalThis as any).__kiviUpdateStickyScrollSettings = updateStickyScrollSettings;

  // ── Outline sync: track which heading is visible as user scrolls ──
  let _lastActiveHeading = '';
  let _headingScrollFrame: ReturnType<typeof requestAnimationFrame> | null = null;

  function detectActiveHeading() {
    if (!editor || (viewMode !== 'live' && viewMode !== 'split')) return;
    const tiptapEd = editor.getTiptapEditor();
    const view = tiptapEd.view;
    const scrollParent = view.dom.parentElement;
    if (!scrollParent) return;

    const scrollTop = scrollParent.scrollTop;
    const viewportMid = scrollTop + scrollParent.clientHeight * 0.15;
    const parentRect = scrollParent.getBoundingClientRect();
    const z = getHostZoom(scrollParent);

    let bestHeading = '';
    let bestTop = -Infinity;
    const allHeadings: { text: string; level: number; relTop: number; offset: number }[] = [];

    tiptapEd.state.doc.forEach((node: any, offset: number) => {
      if (node.type.name === 'heading') {
        const dom = view.nodeDOM(offset) as HTMLElement | null;
        if (!dom) return;
        const rect = dom.getBoundingClientRect();
        const relTop = (rect.top - parentRect.top) / z + scrollTop;
        const level = node.attrs?.level ?? 1;
        const text = node.textContent.trim();

        allHeadings.push({ text, level, relTop, offset });

        if (relTop <= viewportMid && relTop > bestTop) {
          bestTop = relTop;
          bestHeading = text;
        }
      }
    });

    if (bestHeading && bestHeading !== _lastActiveHeading) {
      _lastActiveHeading = bestHeading;
      vscode.postMessage({ type: 'activeHeading', heading: bestHeading });
    }

    if (stickyScrollEnabled && allHeadings.length > 0) {
      updateStickyScroll(allHeadings, viewportMid, tiptapEd);
    } else if (!stickyScrollEnabled || allHeadings.length === 0) {
      stickyScrollEl.style.display = 'none';
      stickyScrollEl.innerHTML = '';
    }
  }

  let _lastStickyKey = '';

  function updateStickyScroll(
    allHeadings: { text: string; level: number; relTop: number; offset: number }[],
    viewportMid: number,
    tiptapEd: any,
  ) {
    const above = allHeadings.filter(h => h.relTop <= viewportMid);
    if (above.length === 0) {
      if (_lastStickyKey !== '') {
        _lastStickyKey = '';
        stickyScrollEl.style.display = 'none';
        stickyScrollEl.innerHTML = '';
      }
      return;
    }

    const breadcrumb: { text: string; level: number; offset: number }[] = [];
    for (const h of above) {
      while (breadcrumb.length > 0 && breadcrumb[breadcrumb.length - 1].level >= h.level) {
        breadcrumb.pop();
      }
      breadcrumb.push(h);
    }

    const visible = breadcrumb.filter(h => h.level <= stickyScrollMaxDepth);
    if (visible.length === 0) {
      if (_lastStickyKey !== '') {
        _lastStickyKey = '';
        stickyScrollEl.style.display = 'none';
        stickyScrollEl.innerHTML = '';
      }
      return;
    }

    const key = visible.map(h => `${h.level}:${h.offset}`).join('|');
    if (key === _lastStickyKey) return;
    _lastStickyKey = key;

    stickyScrollEl.style.display = '';
    stickyScrollEl.innerHTML = '';

    for (let i = 0; i < visible.length; i++) {
      const h = visible[i];
      const span = document.createElement('span');
      span.className = 'kivi-sticky-crumb';
      span.dataset.level = String(h.level);
      span.textContent = h.text;
      span.addEventListener('click', () => {
        tiptapEd.commands.setTextSelection(h.offset + 1);
        tiptapEd.commands.scrollIntoView();
      });
      stickyScrollEl.appendChild(span);
      if (i < visible.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'kivi-sticky-sep';
        sep.textContent = '›';
        stickyScrollEl.appendChild(sep);
      }
    }
  }

  const scrollEl = editorEl.querySelector('.ProseMirror')?.parentElement || editorEl;
  scrollEl.addEventListener('scroll', () => {
    if (_headingScrollFrame) return;
    _headingScrollFrame = requestAnimationFrame(() => {
      _headingScrollFrame = null;
      detectActiveHeading();
    });
  }, { passive: true });

  // Raw -> extension host sync is now handled by Monaco's onDidChangeContent
  // in ensureRawMonaco() and the split mode setup in doSetViewMode().

  // Debounced edit send from ProseMirror
  editor.onUpdate(({ markdown }) => {
    if (isUpdatingFromExtension) return;
    // Skip if the raw textarea was the source of this PM change (guard
    // covers debounce window — loadMarkdown fires synchronous onUpdate via
    // suppressUpdates, but post-setContent DOM observation or plugin
    // transactions can trigger this callback asynchronously).
    if (Date.now() - lastRawEditTimestamp < 600) return;
    if (markdown === lastSentContent) return;
    lastSentContent = markdown;
    vscode.postMessage({ type: 'edit', content: markdown });
    if (viewMode === 'split' && splitMonaco && splitMonaco.getValue() !== markdown) {
      splitMonaco.setValue(markdown, true);
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
        if (msg.docBaseUrl) {
          docBaseUrl = msg.docBaseUrl;
        }
        if (msg.workspaceBaseUrl) {
          workspaceBaseUrl = msg.workspaceBaseUrl;
        }
        if (msg.docBaseUrl || msg.workspaceBaseUrl) {
          rewriteRelativeImages();
          requestAnimationFrame(() => rewriteRelativeImages());
        }
        updateBreadcrumb();
        // Check if excalidraw extension is installed
        vscode.postMessage({ type: 'checkExcalidrawExtension' });
        break;
      }

      case 'load':
      case 'externalChange': {
        if (msg.content !== undefined) {
          if (/\$\$|\\\[|\\begin\{/.test(msg.content)) ensureKatexCss();
          isUpdatingFromExtension = true;
          lastSentContent = msg.content;
          if (msg.type === 'load') savedBaseLines = msg.content.split('\n');
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
          // Update Monaco editors with new content
          if (rawMonaco && rawMonaco.getValue() !== msg.content) {
            rawMonaco.setValue(msg.content, true);
          }
          if (splitMonaco && splitMonaco.getValue() !== msg.content) {
            splitMonaco.setValue(msg.content, true);
          }
          isUpdatingFromExtension = false;
          rewriteRelativeImages();
        }
        break;
      }

      case 'settings':
        if (msg.settings) applySettings(msg.settings);
        break;

      case 'gitBase':
        if (msg.content !== undefined) {
          savedBaseLines = msg.content.split('\n');
          refreshAllGutters();
          // Only apply LCS-based diff if we don't have authoritative git hunks
          if (!savedGitDiffHunks) applyDiffToMonaco();
        }
        break;

      case 'gitDiffHunks': {
        const hunks = (msg as Record<string, unknown>).hunks as typeof savedGitDiffHunks;
        if (hunks) {
          savedGitDiffHunks = hunks;
          applyGitDiffHunksToMonaco();
        }
        break;
      }

      case 'blameResult': {
        const entries = msg.entries as Array<{ line: number; author: string; date: string; summary: string; hash: string }> | undefined;
        if (entries && pendingBlameCallback) {
          pendingBlameCallback(entries);
          pendingBlameCallback = null;
        }
        break;
      }

      case 'fullBlameResult': {
        const entries = msg.entries as BlameEntry[] | undefined;
        if (entries) {
          blameEntries = entries;
          blameByLine = new Map();
          for (const e of entries) blameByLine.set(e.line, e);
          refreshAllGutters();
          applyBlameToMonaco();
        }
        break;
      }

      case 'find':
        showSearchBar(false);
        break;

      case 'findReplace':
        showSearchBar(true);
        break;

      case 'toggleBlame':
        toggleBlame();
        break;

      case 'excalidrawExtensionStatus': {
        _hasExcalidrawExtension = !!msg.installed;
        break;
      }

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

      case 'inputPromptResult': {
        if (msg.id !== undefined) {
          const pending = pendingInputPrompts.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingInputPrompts.delete(msg.id);
            pending.resolve(msg.value ?? null);
          }
        }
        break;
      }

      case 'workspaceFiles': {
        const files = (msg as unknown as { files: WorkspaceFile[] }).files;
        if (files) handleWorkspaceFiles(files);
        break;
      }

      case 'fileHeadings': {
        const reqId = (msg as Record<string, unknown>).reqId as string | undefined;
        const headings = (msg as Record<string, unknown>).headings as Array<{ name: string; slug: string; level: number }> | undefined;
        if (reqId && pendingHeadingCallbacks.has(reqId)) {
          const cb = pendingHeadingCallbacks.get(reqId)!;
          pendingHeadingCallbacks.delete(reqId);
          cb(headings || []);
        }
        break;
      }

      case 'flushEdits': {
        if (viewMode === 'source' || viewMode === 'split') {
          const monacoInst = viewMode === 'split' ? splitMonaco : rawMonaco;
          if (monacoInst) {
            const content = monacoInst.getValue();
            if (content !== lastSentContent) {
              lastSentContent = content;
              vscode.postMessage({ type: 'edit', content });
            }
          }
        } else if (editor) {
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
        if (editor && (msg.heading || msg.line)) {
          const tiptapEd = editor.getTiptapEditor();
          const { doc } = tiptapEd.state;
          let foundOffset = -1;
          const target = String(msg.heading || '').trim().toLowerCase();
          const targetLine = typeof msg.line === 'number' ? msg.line : -1;

          // First pass: try to match both heading text AND approximate position
          // (handles duplicate headings by preferring the one at the right line)
          let bestOffset = -1;
          let bestDist = Infinity;
          let headingIdx = 0;
          doc.forEach((node, offset) => {
            if (node.type.name === 'heading') {
              headingIdx++;
              const nodeText = node.textContent.trim().toLowerCase();
              if (nodeText === target) {
                if (foundOffset < 0) foundOffset = offset;
                // Use heading index as proxy for line distance
                const dist = targetLine >= 0 ? Math.abs(headingIdx - targetLine) : 0;
                if (dist < bestDist) {
                  bestDist = dist;
                  bestOffset = offset;
                }
              }
            }
          });

          const scrollOffset = bestOffset >= 0 ? bestOffset : foundOffset;
          if (scrollOffset >= 0) {
            tiptapEd.commands.setTextSelection(scrollOffset + 1);

            // Double-rAF ensures layout is computed after selection/unfold change
            requestAnimationFrame(() => { requestAnimationFrame(() => {
              const domNode = tiptapEd.view.nodeDOM(scrollOffset) as HTMLElement | null;
              if (!domNode) return;

              const livePane = document.getElementById('kivi-live') || domNode.closest('.ProseMirror')?.parentElement;
              if (livePane) {
                const paneRect = livePane.getBoundingClientRect();
                const headingRect = domNode.getBoundingClientRect();
                const pz = getHostZoom(livePane as HTMLElement);
                const scrollTarget = livePane.scrollTop + (headingRect.top - paneRect.top) / pz - 16;
                livePane.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'smooth' });
              } else {
                domNode.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }

              domNode.classList.remove('kivi-heading-highlight');
              void domNode.offsetWidth;
              domNode.classList.add('kivi-heading-highlight');
              setTimeout(() => domNode.classList.remove('kivi-heading-highlight'), 2500);
            }); });
          }
        }
        break;
      }

      case 'insertExcalidraw': {
        if (editor && msg.src) {
          const tiptapEd = editor.getTiptapEditor();
          (tiptapEd.commands as any).insertExcalidraw?.({ src: msg.src });
        }
        break;
      }

      case 'scrollToLine': {
        const targetLine = typeof msg.line === 'number' ? msg.line : 0;
        if (!targetLine) break;

        // Live / split mode: scroll TipTap to the target line
        if (editor && (viewMode === 'live' || viewMode === 'split')) {
          const tiptapEd = editor.getTiptapEditor();
          const { doc } = tiptapEd.state;
          let currentLine = 1;
          let targetPos = 0;
          let found = false;
          doc.forEach((node, offset) => {
            if (found) return;
            if (currentLine >= targetLine) { found = true; return; }
            currentLine += node.textContent.split('\n').length;
            targetPos = offset + node.nodeSize;
          });
          tiptapEd.commands.setTextSelection(Math.min(targetPos, doc.content.size - 1));
          tiptapEd.commands.scrollIntoView();
        }

        // Source / split mode: scroll Monaco to the target line
        const monacoInst = viewMode === 'source' ? rawMonaco : viewMode === 'split' ? splitMonaco : null;
        if (monacoInst) {
          if (viewMode === 'split') suppressScrollSync();
          monacoInst.revealLine(targetLine);
        }
        break;
      }

      case 'focus': {
        editor?.focus();
        break;
      }

      case 'childPageCreated': {
        break;
      }

      case 'assetInserted': {
        const content = msg.content as string | undefined;
        if (content && editor) {
          const tiptap = editor.getTiptapEditor();
          tiptap.chain().focus().insertContent(content).run();
        }
        break;
      }

      case 'imageStored': {
        // Handled by the pending promise in imageStorageAdapter
        break;
      }

      case 'fileStored': {
        // Handled by the pending promise in fileStorageAdapter
        break;
      }

      case 'globalPrefs': {
        const prefs = msg.prefs as Record<string, unknown> | undefined;
        if (!prefs) break;
        if (prefs.viewMode === 'source' || prefs.viewMode === 'split' || prefs.viewMode === 'live') {
          if (prefs.viewMode !== viewMode) doSetViewMode(prefs.viewMode, false);
        }
        if (typeof prefs.toolbarVisible === 'boolean') {
          setToolbarVisible(prefs.toolbarVisible, false);
        }
        break;
      }

      case 'globalPrefChanged': {
        const key = msg.key as string | undefined;
        const value = msg.value;
        if (!key) break;
        if (key === 'viewMode' && (value === 'source' || value === 'split' || value === 'live')) {
          if (value !== viewMode) doSetViewMode(value, false);
        }
        if (key === 'toolbarVisible' && typeof value === 'boolean') {
          setToolbarVisible(value, false);
        }
        break;
      }

      case 'tagIndex': {
        if (Array.isArray(msg.tags)) {
          workspaceTags = msg.tags;
        }
        break;
      }

    }
  });

  // ── Keyboard shortcuts ──

  // Monaco editors dispatch 'kivi-find' when Cmd+F / Cmd+H is pressed inside them,
  // since Monaco's internal handlers intercept the key event before it bubbles to document.
  document.addEventListener('kivi-find', ((e: CustomEvent<{ replace: boolean }>) => {
    showSearchBar(e.detail?.replace ?? false);
  }) as EventListener);

  document.addEventListener('keydown', (e) => {
    // Cmd+F: search (always opens, never toggles — matches VS Code)
    if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      showSearchBar(false);
      return;
    }
    // Cmd+H / Cmd+Alt+F: find and replace
    if ((e.metaKey || e.ctrlKey) && (e.key === 'h' || (e.key === 'f' && e.altKey))) {
      e.preventDefault();
      showSearchBar(true);
      return;
    }
    // Cmd+Shift+E: reveal in explorer
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'e') {
      vscode.postMessage({ type: 'revealInExplorer' });
    }
    // Cmd+K: insert / edit link
    if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      insertLinkAtCursor();
    }
    // Escape: close search bar from anywhere (matches VS Code)
    if (e.key === 'Escape' && searchBarVisible) {
      hideSearchBar();
    }
  });

  // Recalculate gutter heights when window resizes (word-wrap changes)
  let _resizeGutterTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (_resizeGutterTimer) clearTimeout(_resizeGutterTimer);
    _resizeGutterTimer = setTimeout(() => {
      _resizeGutterTimer = null;
      refreshAllGutters();
    }, 120);
  });

  // Save state before unload
  window.addEventListener('beforeunload', () => saveState());

  perfLog('init-total', 'init-start');
  vscode.postMessage({ type: 'ready' });

  requestAnimationFrame(() => {
    perfLog('first-paint', 'init-start');
  });
}

// ── Relative image rewriting ──

function isRelativeUrl(url: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // Absolute schemes (case-insensitive) and protocol-relative URLs
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return false;
  if (trimmed.startsWith('//')) return false;
  return true;
}

let _rewritingSrc = false;
const _failedSrcs = new Set<string>();
const _rewrittenEls = new WeakSet<HTMLElement>();

function resolveMediaUrl(src: string): string | null {
  if (!src || !isRelativeUrl(src)) return null;
  if (src.startsWith('/') && workspaceBaseUrl) {
    return workspaceBaseUrl + src.slice(1);
  }
  if (!docBaseUrl) return null;
  return docBaseUrl + src.replace(/^\.\//, '');
}

function rewriteRelativeImages() {
  if (!docBaseUrl && !workspaceBaseUrl) return;
  const editorEl = document.getElementById('editor');
  if (!editorEl) return;
  _rewritingSrc = true;
  try {
    for (const el of editorEl.querySelectorAll<HTMLElement>('img, video, audio')) {
      const src = el.getAttribute('src') || '';
      const resolved = resolveMediaUrl(src);
      if (resolved && !_failedSrcs.has(resolved) && (el as HTMLMediaElement).src !== resolved) {
        (el as HTMLMediaElement).src = resolved;
        _rewrittenEls.add(el);
        if (el instanceof HTMLImageElement) {
          el.addEventListener('error', () => { _failedSrcs.add(resolved); }, { once: true });
        }
      }
    }
  } finally {
    _rewritingSrc = false;
  }
}

let _imgRewriteFrame: ReturnType<typeof requestAnimationFrame> | null = null;

function rewriteMediaSrc(el: HTMLElement) {
  if (!docBaseUrl && !workspaceBaseUrl) return;
  if (_rewrittenEls.has(el)) return;
  const src = el.getAttribute('src') || '';
  const resolved = resolveMediaUrl(src);
  if (resolved && !_failedSrcs.has(resolved) && (el as HTMLMediaElement).src !== resolved) {
    _rewritingSrc = true;
    (el as HTMLMediaElement).src = resolved;
    _rewrittenEls.add(el);
    if (el instanceof HTMLImageElement) {
      el.addEventListener('error', () => { _failedSrcs.add(resolved); }, { once: true });
    }
    _rewritingSrc = false;
  }
}

const _imgObserver = new MutationObserver((mutations) => {
  if (_rewritingSrc) return;
  if (!docBaseUrl && !workspaceBaseUrl) return;

  let needsRewrite = false;
  for (const m of mutations) {
    if (m.type === 'attributes') {
      if (_rewritingSrc) continue;
      if (
        m.target instanceof HTMLImageElement ||
        m.target instanceof HTMLVideoElement ||
        m.target instanceof HTMLAudioElement
      ) {
        _rewrittenEls.delete(m.target as HTMLElement);
        rewriteMediaSrc(m.target as HTMLElement);
      }
      continue;
    }
    for (const node of m.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.tagName === 'IMG' || node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
        rewriteMediaSrc(node);
        needsRewrite = true;
      } else if (node.querySelector) {
        const media = node.querySelectorAll<HTMLElement>('img, video, audio');
        if (media.length > 0) {
          for (const el of media) rewriteMediaSrc(el);
          needsRewrite = true;
        }
      }
    }
  }

  if (needsRewrite && !_imgRewriteFrame) {
    _imgRewriteFrame = requestAnimationFrame(() => {
      _imgRewriteFrame = null;
      rewriteRelativeImages();
    });
  }
});

requestAnimationFrame(() => {
  const editorEl = document.getElementById('editor');
  if (editorEl) {
    _imgObserver.observe(editorEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  }
});

// ── Breadcrumb ──

function updateBreadcrumb() {
  // Brand icon removed; breadcrumb is now a no-op
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
    const monacoInst = viewMode === 'split' ? splitMonaco : rawMonaco;
    if (monacoInst) {
      savedSourceScrollTop = monacoInst.getScrollTop();
      const pos = monacoInst.getPosition();
      if (pos) {
        savedSourceSelStart = pos.lineNumber;
        savedSourceSelEnd = pos.column;
      }
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
    const monacoInst = viewMode === 'split' ? splitMonaco : rawMonaco;
    if (monacoInst) {
      requestAnimationFrame(() => {
        monacoInst.setScrollTop(savedSourceScrollTop);
        monacoInst.setPosition(savedSourceSelStart, savedSourceSelEnd);
      });
    }
  }
}

function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  while (el) {
    if (el.scrollHeight > el.clientHeight + 1) return el;
    el = el.parentElement;
  }
  return null;
}

let scrollSyncCleanup: (() => void) | null = null;

// Temporarily suppress scroll sync during search navigation so both
// editors independently center on their active match.
let _scrollSyncSuppressed = false;
let _scrollSyncTimer: ReturnType<typeof setTimeout> | null = null;
function suppressScrollSync(ms = 400) {
  _scrollSyncSuppressed = true;
  if (_scrollSyncTimer) clearTimeout(_scrollSyncTimer);
  _scrollSyncTimer = setTimeout(() => { _scrollSyncSuppressed = false; }, ms);
}

function doSetViewMode(mode: 'live' | 'source' | 'split', persist = true) {
  saveCurrentPosition();

  viewMode = mode;
  if (persist) vscode.postMessage({ type: 'persistSetting', key: 'viewMode', value: mode });
  const editorEl = document.getElementById('editor');
  const rawWrapper = document.getElementById('kivi-raw-wrapper');
  const splitContainer = document.getElementById('kivi-split-container');

  if (!editorEl || !rawWrapper || !splitContainer) return;

  const body = document.querySelector('body')!;
  if (editorEl.parentElement !== body && editorEl.closest('#kivi-split-container')) {
    const searchBar = document.getElementById('kivi-search-bar');
    if (searchBar && searchBar.nextSibling) {
      body.insertBefore(editorEl, searchBar.nextSibling);
    } else {
      body.insertBefore(editorEl, splitContainer);
    }
  }

  if (scrollSyncCleanup) { scrollSyncCleanup(); scrollSyncCleanup = null; }
  // Dispose split Monaco if it exists
  if (splitMonaco) { splitMonaco.dispose(); splitMonaco = null; }
  splitContainer.innerHTML = '';

  if (mode === 'source') {
    const rm = ensureRawMonaco();
    if (editor) {
      rm.setValue(editor.getMarkdown());
    }
    editorEl.style.display = 'none';
    rawWrapper.style.display = 'flex';
    splitContainer.style.display = 'none';
    requestAnimationFrame(() => rm.layout());
    restorePosition('source');
    rm.focus();
  } else if (mode === 'split') {
    // Sync raw editor content to live editor if coming from source mode
    const comingFromSource = rawWrapper.style.display !== 'none';
    if (comingFromSource && rawMonaco) {
      const content = rawMonaco.getValue();
      if (editor && content) {
        editor.loadMarkdown(content);
        lastSentContent = content;
      }
    }

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

    const splitMonacoContainer = document.createElement('div');
    splitMonacoContainer.id = 'kivi-split-monaco';
    splitMonacoContainer.style.cssText = 'width:100%;height:100%;';
    rightPane.appendChild(splitMonacoContainer);

    splitContainer.appendChild(leftPane);
    splitContainer.appendChild(divider);
    splitContainer.appendChild(rightPane);

    // Create split Monaco editor
    const isDark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
    splitMonaco = createMonacoRawEditor({
      container: splitMonacoContainer,
      value: editor ? editor.getMarkdown() : '',
      wordWrap: currentWordWrap,
      fontSize: _lastFontSize || 14,
      fontFamily: _lastFontFamily || undefined,
      onGutterClick: (lineNumber) => handleMonacoGutterClick(splitMonaco!, lineNumber),
    });
    splitMonaco.setTheme(isDark);
    splitMonaco.setOnToggleBlame(() => toggleBlame());

    let splitDebounce: ReturnType<typeof setTimeout> | null = null;
    splitMonaco.onDidChangeContent((content) => {
      if (isUpdatingFromExtension) return;
      savedGitDiffHunks = null;
      if (splitDebounce) clearTimeout(splitDebounce);
      splitDebounce = setTimeout(() => {
        if (content === lastSentContent) return;
        lastSentContent = content;
        lastRawEditTimestamp = Date.now();
        isUpdatingFromExtension = true;
        editor?.loadMarkdown(content);
        isUpdatingFromExtension = false;
        vscode.postMessage({ type: 'edit', content });
        applyDiffToMonaco();
      }, 150);
    });

    // Apply diff/blame decorations
    applyDiffToMonaco();
    applyBlameToMonaco();

    // ── Scroll sync: vertical ratio-based, live ↔ split Monaco ──
    {
      const scrollEl = editorEl;
      let syncSource: 'live' | 'raw' | null = null;
      let syncTimer: ReturnType<typeof setTimeout> | null = null;
      const clearLock = () => {
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => { syncSource = null; }, 50);
      };

      const syncLiveToRaw = () => {
        if (_scrollSyncSuppressed || syncSource === 'raw' || !splitMonaco) return;
        syncSource = 'live';
        const maxY = scrollEl.scrollHeight - scrollEl.clientHeight;
        const ratio = maxY > 0 ? scrollEl.scrollTop / maxY : 0;
        const rawMaxY = splitMonaco.getScrollHeight() - splitMonaco.getClientHeight();
        splitMonaco.setScrollTop(ratio * rawMaxY);
        clearLock();
      };

      const syncRawToLive = () => {
        if (_scrollSyncSuppressed || syncSource === 'live' || !splitMonaco) return;
        syncSource = 'raw';
        const rawMaxY = splitMonaco.getScrollHeight() - splitMonaco.getClientHeight();
        const ratio = rawMaxY > 0 ? splitMonaco.getScrollTop() / rawMaxY : 0;
        scrollEl.scrollTop = ratio * (scrollEl.scrollHeight - scrollEl.clientHeight);
        clearLock();
      };

      editorEl.addEventListener('scroll', syncLiveToRaw, { passive: true });
      const splitLeft = editorEl.closest('.kivi-split-left');
      if (splitLeft && splitLeft !== editorEl) {
        splitLeft.addEventListener('scroll', syncLiveToRaw, { passive: true });
      }
      const pmEl = editorEl.querySelector('.ProseMirror');
      if (pmEl) pmEl.addEventListener('scroll', syncLiveToRaw, { passive: true });

      splitMonaco.onDidScrollChange(() => syncRawToLive());

      scrollSyncCleanup = () => {
        editorEl.removeEventListener('scroll', syncLiveToRaw);
        if (splitLeft) splitLeft.removeEventListener('scroll', syncLiveToRaw);
        if (pmEl) pmEl.removeEventListener('scroll', syncLiveToRaw);
        if (syncTimer) clearTimeout(syncTimer);
      };
    }

    // Divider drag resize
    let isDragging = false;
    const onDragMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const rect = splitContainer.getBoundingClientRect();
      const ratio = Math.max(0.2, Math.min(0.8, (e.clientX - rect.left) / rect.width));
      leftPane.style.flex = `${ratio}`;
      rightPane.style.flex = `${1 - ratio}`;
      splitMonaco?.layout();
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

    requestAnimationFrame(() => splitMonaco?.layout());
    restorePosition('both');
    editor?.focus();
  } else {
    // Switching to live mode — sync content from raw if coming from source
    const comingFromSource = rawWrapper.style.display !== 'none';
    if (comingFromSource && rawMonaco) {
      const content = rawMonaco.getValue();
      if (editor && content && content !== lastSentContent) {
        editor.loadMarkdown(content);
        lastSentContent = content;
      }
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

// ── Line diff via LCS (DP approach, correct and simple) ──

interface DiffHunk {
  newStart: number;
  newEnd: number;   // exclusive
  oldStart: number;
  oldEnd: number;   // exclusive
}

function computeDiffHunks(baseLines: string[], currentLines: string[]): DiffHunk[] {
  const a = baseLines;
  const b = currentLines;
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ oldStart: 0, oldEnd: 0, newStart: 0, newEnd: m }];
  if (m === 0) return [{ oldStart: 0, oldEnd: n, newStart: 0, newEnd: 0 }];

  // Strip common prefix and suffix to reduce work
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const aStart = prefix, aEnd = n - suffix;
  const bStart = prefix, bEnd = m - suffix;
  const tn = aEnd - aStart;
  const tm = bEnd - bStart;

  if (tn === 0 && tm === 0) return [];
  if (tn === 0) return [{ oldStart: aStart, oldEnd: aStart, newStart: bStart, newEnd: bEnd }];
  if (tm === 0) return [{ oldStart: aStart, oldEnd: aEnd, newStart: bStart, newEnd: bStart }];

  // Compute LCS on the trimmed region via DP or fallback for huge files
  // lcsA and lcsB hold ABSOLUTE indices into a[] and b[]
  let lcsA: number[];
  let lcsB: number[];

  const MAX_DP_CELLS = 1000000;
  if (tn * tm <= MAX_DP_CELLS) {
    // Standard DP LCS
    const dp: number[][] = new Array(tn + 1);
    for (let i = 0; i <= tn; i++) dp[i] = new Array(tm + 1).fill(0);
    for (let i = tn - 1; i >= 0; i--) {
      for (let j = tm - 1; j >= 0; j--) {
        if (a[aStart + i] === b[bStart + j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    lcsA = [];
    lcsB = [];
    let i = 0, j = 0;
    while (i < tn && j < tm) {
      if (a[aStart + i] === b[bStart + j]) {
        lcsA.push(aStart + i);
        lcsB.push(bStart + j);
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }
  } else {
    // For very large diffs, greedy forward match (not optimal but fast and usually good)
    lcsA = [];
    lcsB = [];
    const bMap = new Map<string, number[]>();
    for (let j = bStart; j < bEnd; j++) {
      const arr = bMap.get(b[j]);
      if (arr) arr.push(j); else bMap.set(b[j], [j]);
    }
    let lastBj = bStart - 1;
    for (let i = aStart; i < aEnd; i++) {
      const positions = bMap.get(a[i]);
      if (!positions) continue;
      // Find the smallest position > lastBj
      let lo = 0, hi = positions.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (positions[mid] <= lastBj) lo = mid + 1; else hi = mid; }
      if (lo < positions.length) {
        lcsA.push(i);
        lcsB.push(positions[lo]);
        lastBj = positions[lo];
      }
    }
  }

  // Build full LCS: prefix matches + trimmed LCS + suffix matches
  const fullLcsA: number[] = [];
  const fullLcsB: number[] = [];
  for (let i = 0; i < prefix; i++) { fullLcsA.push(i); fullLcsB.push(i); }
  for (let i = 0; i < lcsA.length; i++) { fullLcsA.push(lcsA[i]); fullLcsB.push(lcsB[i]); }
  for (let i = 0; i < suffix; i++) { fullLcsA.push(n - suffix + i); fullLcsB.push(m - suffix + i); }

  // Walk full LCS to find hunks
  const hunks: DiffHunk[] = [];
  let ai = 0, bi = 0;

  for (let li = 0; li < fullLcsA.length; li++) {
    const la = fullLcsA[li];
    const lb = fullLcsB[li];
    if (ai < la || bi < lb) {
      hunks.push({ oldStart: ai, oldEnd: la, newStart: bi, newEnd: lb });
    }
    ai = la + 1;
    bi = lb + 1;
  }
  if (ai < n || bi < m) {
    hunks.push({ oldStart: ai, oldEnd: n, newStart: bi, newEnd: m });
  }

  return hunks;
}

type GutterMark = 'u' | 'a' | 'm' | 'd';

interface GutterInfo {
  marks: GutterMark[];
  hunks: DiffHunk[];
}

function computeGutterInfo(baseLines: string[], currentLines: string[]): GutterInfo {
  const hunks = computeDiffHunks(baseLines, currentLines);
  const n = currentLines.length;
  const marks: GutterMark[] = new Array(n).fill('u');

  for (const h of hunks) {
    const deletedCount = h.oldEnd - h.oldStart;
    const insertedCount = h.newEnd - h.newStart;

    if (insertedCount > 0 && deletedCount > 0) {
      // VS Code marks the entire replacement span as 'modified' (blue)
      for (let i = h.newStart; i < h.newEnd; i++) marks[i] = 'm';
    } else if (insertedCount > 0) {
      for (let i = h.newStart; i < h.newEnd; i++) marks[i] = 'a';
    } else if (deletedCount > 0) {
      const markerLine = h.newStart > 0 ? h.newStart - 1 : 0;
      if (marks[markerLine] === 'u') marks[markerLine] = 'd';
    }
  }

  return { marks, hunks };
}

/**
 * Build a mapping from current-buffer line index to the corresponding
 * base (on-disk) line index using diff hunks.  Returns -1 for lines
 * that are purely added (no base counterpart).
 */
function buildCurrentToBaseMap(hunks: DiffHunk[], currentLineCount: number): Int32Array {
  const map = new Int32Array(currentLineCount);
  let curIdx = 0;
  let baseIdx = 0;

  for (const h of hunks) {
    // Unchanged lines before this hunk
    while (curIdx < h.newStart && curIdx < currentLineCount) {
      map[curIdx] = baseIdx;
      curIdx++;
      baseIdx++;
    }
    const deletedCount = h.oldEnd - h.oldStart;
    const insertedCount = h.newEnd - h.newStart;
    const modCount = Math.min(deletedCount, insertedCount);

    // Modified lines map 1-to-1 to their base counterparts
    for (let i = 0; i < modCount && curIdx < currentLineCount; i++) {
      map[curIdx] = baseIdx;
      curIdx++;
      baseIdx++;
    }
    // Extra inserted lines have no base counterpart
    for (let i = modCount; i < insertedCount && curIdx < currentLineCount; i++) {
      map[curIdx] = -1;
      curIdx++;
    }
    // Skip deleted base lines (not present in current buffer)
    baseIdx += Math.max(0, deletedCount - modCount);
  }

  // Remaining unchanged lines after the last hunk
  while (curIdx < currentLineCount) {
    map[curIdx] = baseIdx;
    curIdx++;
    baseIdx++;
  }
  return map;
}

function applyGitDiffHunksToMonaco() {
  if (!savedGitDiffHunks) return;
  const marks: DiffMark[] = [];

  for (const h of savedGitDiffHunks) {
    if (h.oldCount === 0 && h.newCount > 0) {
      marks.push({ type: 'added', startLine: h.newStart, endLine: h.newStart + h.newCount - 1 });
    } else if (h.oldCount > 0 && h.newCount === 0) {
      marks.push({ type: 'deleted', startLine: h.newStart, endLine: h.newStart });
    } else if (h.oldCount > 0 && h.newCount > 0) {
      marks.push({ type: 'modified', startLine: h.newStart, endLine: h.newStart + h.newCount - 1 });
    }
  }

  rawMonaco?.setDiffMarks(marks);
  splitMonaco?.setDiffMarks(marks);
}

function applyDiffToMonaco() {
  // Prefer authoritative git diff hunks when available
  if (savedGitDiffHunks) {
    applyGitDiffHunksToMonaco();
    return;
  }

  if (!savedBaseLines.length) return;
  const applyToEditor = (monacoInst: MonacoRawEditor | null) => {
    if (!monacoInst) return;
    const currentLines = monacoInst.getValue().split('\n');
    const info = computeGutterInfo(savedBaseLines, currentLines);
    const marks: DiffMark[] = [];

    let i = 0;
    while (i < info.marks.length) {
      const m = info.marks[i];
      if (m === 'u') { i++; continue; }
      const start = i;
      while (i < info.marks.length && info.marks[i] === m) i++;
      const type = m === 'a' ? 'added' : m === 'm' ? 'modified' : 'deleted';
      marks.push({ type, startLine: start + 1, endLine: i });
    }
    monacoInst.setDiffMarks(marks);
  };
  applyToEditor(rawMonaco);
  applyToEditor(splitMonaco);
}

function refreshAllGutters() {
  // Legacy — old textarea gutter refresh. Now a no-op.
  // Diff/blame decorations are handled by applyDiffToMonaco/applyBlameToMonaco.
}

let _gutterUpdateFrame: ReturnType<typeof requestAnimationFrame> | null = null;
let _pendingGutterUpdates: Array<{ textarea: HTMLTextAreaElement; gutter: HTMLElement }> = [];

function updateLineNumbers(textarea: HTMLTextAreaElement, gutter: HTMLElement) {
  _pendingGutterUpdates = _pendingGutterUpdates.filter(u => u.gutter !== gutter);
  _pendingGutterUpdates.push({ textarea, gutter });
  if (!_gutterUpdateFrame) {
    _gutterUpdateFrame = requestAnimationFrame(() => {
      _gutterUpdateFrame = null;
      const pending = _pendingGutterUpdates;
      _pendingGutterUpdates = [];
      for (const { textarea: ta, gutter: g } of pending) {
        _updateLineNumbersImmediate(ta, g);
      }
    });
  }
}

// ── Inline blame (GitLens-style) ──

function timeAgo(epoch: number): string {
  const now = Date.now() / 1000;
  const diff = now - epoch;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
  const years = Math.floor(diff / 31536000);
  return years === 1 ? '1y ago' : `${years}y ago`;
}

function toggleBlame() {
  blameEnabled = !blameEnabled;
  if (blameEnabled && blameEntries.length === 0) {
    vscode.postMessage({ type: 'requestFullBlame' });
  }
  refreshAllGutters();
  document.querySelectorAll('.kivi-raw-gutter').forEach(g => {
    g.classList.toggle('blame-active', blameEnabled);
  });
  applyBlameToMonaco();
}

function applyBlameToMonaco() {
  if (!blameEnabled) {
    rawMonaco?.clearBlame();
    splitMonaco?.clearBlame();
    return;
  }
  if (blameEntries.length === 0) return;

  const applyToEditor = (monacoInst: MonacoRawEditor | null) => {
    if (!monacoInst) return;
    const currentLines = monacoInst.getValue().split('\n');
    const info = computeGutterInfo(savedBaseLines, currentLines);
    const curToBase = buildCurrentToBaseMap(info.hunks, currentLines.length);

    const entries: MonacoBlameEntry[] = [];
    for (let i = 0; i < currentLines.length; i++) {
      const baseLine = curToBase[i];
      const blameInfo = baseLine >= 0 ? blameByLine.get(baseLine) : null;
      if (blameInfo) {
        entries.push({
          hash: blameInfo.hash,
          author: blameInfo.author,
          authorTime: blameInfo.authorTime,
          summary: blameInfo.summary,
          currentLine: i,
        });
      }
    }
    monacoInst.setBlameInfo(entries);
  };
  applyToEditor(rawMonaco);
  applyToEditor(splitMonaco);
}

function closeBlamePopup() {
  if (activeBlamePopup) {
    activeBlamePopup.remove();
    activeBlamePopup = null;
  }
}

function showBlameDetailPopup(entry: BlameEntry, anchor: HTMLElement, wrapper: HTMLElement) {
  closeBlamePopup();

  const popup = document.createElement('div');
  popup.className = 'kivi-blame-popup';
  activeBlamePopup = popup;

  const isUncommitted = entry.hash.startsWith('0000000');

  const header = document.createElement('div');
  header.className = 'kivi-blame-popup-header';

  const avatar = document.createElement('span');
  avatar.className = 'kivi-blame-popup-avatar';
  avatar.textContent = entry.author.charAt(0).toUpperCase();

  const authorInfo = document.createElement('div');
  authorInfo.className = 'kivi-blame-popup-author';
  const authorName = document.createElement('strong');
  authorName.textContent = isUncommitted ? 'Uncommitted' : entry.author;
  const authorTime = document.createElement('span');
  authorTime.className = 'kivi-blame-popup-time';
  authorTime.textContent = isUncommitted ? '' : ` • ${timeAgo(entry.authorTime)}`;
  authorInfo.appendChild(authorName);
  authorInfo.appendChild(authorTime);

  header.appendChild(avatar);
  header.appendChild(authorInfo);
  popup.appendChild(header);

  if (!isUncommitted) {
    const commitRow = document.createElement('div');
    commitRow.className = 'kivi-blame-popup-commit';

    const hashEl = document.createElement('code');
    hashEl.className = 'kivi-blame-popup-hash';
    hashEl.textContent = entry.hash.slice(0, 8);

    const summaryEl = document.createElement('span');
    summaryEl.className = 'kivi-blame-popup-summary';
    summaryEl.textContent = entry.summary;

    commitRow.appendChild(hashEl);
    commitRow.appendChild(summaryEl);
    popup.appendChild(commitRow);

    if (entry.authorMail) {
      const emailRow = document.createElement('div');
      emailRow.className = 'kivi-blame-popup-detail';
      emailRow.textContent = entry.authorMail;
      popup.appendChild(emailRow);
    }

    const dateRow = document.createElement('div');
    dateRow.className = 'kivi-blame-popup-detail';
    const d = new Date(entry.authorTime * 1000);
    dateRow.textContent = d.toLocaleString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    popup.appendChild(dateRow);

    const actions = document.createElement('div');
    actions.className = 'kivi-blame-popup-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'kivi-blame-popup-btn';
    copyBtn.textContent = 'Copy Hash';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(entry.hash).catch(() => {});
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy Hash'; }, 1500);
    });

    const copyFullBtn = document.createElement('button');
    copyFullBtn.className = 'kivi-blame-popup-btn';
    copyFullBtn.textContent = 'Copy Message';
    copyFullBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(`${entry.hash.slice(0, 8)} ${entry.summary}`).catch(() => {});
      copyFullBtn.textContent = 'Copied!';
      setTimeout(() => { copyFullBtn.textContent = 'Copy Message'; }, 1500);
    });

    const openBtn = document.createElement('button');
    openBtn.className = 'kivi-blame-popup-btn kivi-blame-popup-btn-primary';
    openBtn.textContent = 'Open Commit';
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'openCommit', hash: entry.hash });
    });

    actions.appendChild(copyBtn);
    actions.appendChild(copyFullBtn);
    actions.appendChild(openBtn);
    popup.appendChild(actions);
  }

  wrapper.style.position = 'relative';
  const anchorRect = anchor.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();
  const bz = getHostZoom(wrapper);
  popup.style.top = `${(anchorRect.bottom - wrapperRect.top) / bz + wrapper.scrollTop + 2}px`;
  popup.style.left = `${Math.max(0, (anchorRect.left - wrapperRect.left) / bz + wrapper.scrollLeft)}px`;
  wrapper.appendChild(popup);

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeBlamePopup(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);

  const clickHandler = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node)) {
      closeBlamePopup();
      document.removeEventListener('click', clickHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', clickHandler), 0);
}

/**
 * Measure the rendered height of each logical line in the textarea,
 * accounting for word-wrap.  Uses a hidden mirror div that replicates
 * the textarea's text layout and inserts zero-width markers at each
 * newline boundary to read their offsetTop deltas.
 */
const _lineHeightCache = new WeakMap<HTMLTextAreaElement, { text: string; width: number; heights: number[] }>();

function measureLineHeights(textarea: HTMLTextAreaElement, lineCount: number): number[] {
  const style = getComputedStyle(textarea);
  const baseLineH = parseFloat(style.lineHeight) || 20;

  if (style.whiteSpace === 'pre' || style.overflowWrap === 'normal') {
    return new Array(lineCount).fill(baseLineH);
  }

  const text = textarea.value;
  const width = textarea.clientWidth;
  const cached = _lineHeightCache.get(textarea);
  if (cached && cached.text === text && cached.width === width) {
    return cached.heights;
  }

  let mirror = textarea.parentElement?.querySelector('.kivi-gutter-mirror') as HTMLDivElement | null;
  if (!mirror) {
    mirror = document.createElement('div');
    mirror.className = 'kivi-gutter-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    textarea.parentElement?.appendChild(mirror);
  }

  mirror.style.cssText = `
    position: absolute; top: -9999px; left: -9999px;
    visibility: hidden; pointer-events: none;
    white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word;
  `;
  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontSize = style.fontSize;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.tabSize = style.tabSize;
  mirror.style.width = `${width}px`;
  mirror.style.paddingLeft = style.paddingLeft;
  mirror.style.paddingRight = style.paddingRight;
  mirror.style.boxSizing = 'border-box';

  // Build content: one <br>-terminated div per logical line for
  // reliable height measurement (block elements have stable offsetTop)
  mirror.innerHTML = '';
  const wrappers: HTMLDivElement[] = [];
  let pos = 0;

  for (let i = 0; i < lineCount; i++) {
    const nlIdx = text.indexOf('\n', pos);
    const end = nlIdx === -1 ? text.length : nlIdx;
    const lineText = text.slice(pos, end);

    const row = document.createElement('div');
    row.style.cssText = 'white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word;';
    if (lineText) {
      row.textContent = lineText;
    } else {
      row.innerHTML = '\u200b';
    }
    mirror.appendChild(row);
    wrappers.push(row);

    pos = nlIdx === -1 ? text.length : nlIdx + 1;
  }

  const heights: number[] = [];
  for (let i = 0; i < lineCount; i++) {
    const h = wrappers[i].offsetHeight;
    heights.push(Math.max(baseLineH, h));
  }

  // Collapse mirror to zero height when done
  mirror.style.cssText = 'position:absolute;top:0;left:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;';
  _lineHeightCache.set(textarea, { text, width, heights });
  return heights;
}

function _updateLineNumbersImmediate(textarea: HTMLTextAreaElement, gutter: HTMLElement) {
  const currentLines = textarea.value.split('\n');
  const lineCount = currentLines.length;
  const info = computeGutterInfo(savedBaseLines, currentLines);
  const curToBase = blameEnabled ? buildCurrentToBaseMap(info.hunks, lineCount) : null;
  const lineHeights = measureLineHeights(textarea, lineCount);
  const existingChildren = gutter.children;
  const existingCount = existingChildren.length;

  let inCodeBlock = false;

  for (let i = 0; i < lineCount; i++) {
    let div: HTMLElement;
    if (i < existingCount) {
      div = existingChildren[i] as HTMLElement;
    } else {
      div = document.createElement('div');
      gutter.appendChild(div);
    }
    div.className = 'gutter-line';
    div.style.height = `${lineHeights[i]}px`;

    const mark = info.marks[i];
    if (mark === 'a') div.classList.add('gutter-added');
    else if (mark === 'm') div.classList.add('gutter-modified');
    else if (mark === 'd') div.classList.add('gutter-deleted');

    const line = currentLines[i];
    if (line.trimStart().startsWith('```')) inCodeBlock = !inCodeBlock;
    const headingLevel = inCodeBlock ? 0 : (/^(#{1,6})\s/.exec(line)?.[1]?.length ?? 0);

    let foldArrow = div.querySelector('.gutter-fold-arrow') as HTMLElement | null;
    if (headingLevel > 0) {
      if (!foldArrow) {
        foldArrow = document.createElement('span');
        foldArrow.className = 'gutter-fold-arrow';
        foldArrow.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M7.976 10.072l4.357-4.357.62.618L7.976 11.31 2.93 6.333l.62-.618z"/></svg>';
        div.insertBefore(foldArrow, div.firstChild);
      }
    } else if (foldArrow) {
      foldArrow.remove();
    }

    const isChanged = mark !== 'u';
    div.onclick = isChanged ? () => showDiffPopup(textarea, gutter, i, info) : null;

    if (blameEnabled) {
      const baseLine = curToBase ? curToBase[i] : i;
      const prevBaseLine = i > 0 && curToBase ? curToBase[i - 1] : (i > 0 ? i - 1 : -1);
      const blameInfo = baseLine >= 0 ? blameByLine.get(baseLine) : null;
      const prevBlame = prevBaseLine >= 0 ? blameByLine.get(prevBaseLine) : null;
      const isSameCommit = prevBlame && blameInfo && prevBlame.hash === blameInfo.hash;

      let lineNum = div.querySelector('.gutter-linenum') as HTMLElement | null;
      if (!lineNum) {
        lineNum = document.createElement('span');
        lineNum.className = 'gutter-linenum';
        div.appendChild(lineNum);
      }
      lineNum.textContent = `${i + 1}`;

      let blameAnnotation = div.querySelector('.gutter-blame') as HTMLElement | null;
      if (!blameAnnotation) {
        blameAnnotation = document.createElement('span');
        blameAnnotation.className = 'gutter-blame';
        div.insertBefore(blameAnnotation, lineNum);
      }

      if (blameInfo && !isSameCommit) {
        const isUncommitted = blameInfo.hash.startsWith('0000000');
        blameAnnotation.textContent = isUncommitted
          ? 'You • Uncommitted'
          : `${blameInfo.author.split(' ')[0]}, ${timeAgo(blameInfo.authorTime)}`;
        blameAnnotation.title = `${blameInfo.author} • ${blameInfo.hash.slice(0, 8)} • ${blameInfo.summary}\n⌘+hover for details`;
        blameAnnotation.classList.remove('gutter-blame-dim');
      } else if (blameInfo && isSameCommit) {
        blameAnnotation.textContent = '⁞';
        blameAnnotation.title = `${blameInfo.author} • ${blameInfo.hash.slice(0, 8)}\n⌘+hover for details`;
        blameAnnotation.classList.add('gutter-blame-dim');
      } else {
        blameAnnotation.textContent = '';
        blameAnnotation.title = '';
        blameAnnotation.classList.remove('gutter-blame-dim');
      }

      if (blameInfo) {
        const entry = blameInfo;
        const wrapper = textarea.closest('#kivi-raw-wrapper') || textarea.closest('.kivi-split-right');
        blameAnnotation.onclick = (e: MouseEvent) => {
          e.stopPropagation();
          showBlameDetailPopup(entry, div, wrapper as HTMLElement);
        };
        div.onmouseenter = (e: MouseEvent) => {
          if (e.metaKey || e.ctrlKey) {
            showBlameDetailPopup(entry, div, wrapper as HTMLElement);
          }
        };
      } else {
        div.onmouseenter = null;
      }
    } else {
      div.textContent = `${i + 1}`;
      div.onmouseenter = null;
      const existingBlame = div.querySelector('.gutter-blame');
      if (existingBlame) existingBlame.remove();
      const existingNum = div.querySelector('.gutter-linenum');
      if (existingNum) existingNum.remove();
    }
  }

  while (gutter.children.length > lineCount) {
    gutter.removeChild(gutter.lastChild!);
  }
}

// ── Diff popup (inline change preview) ──

function findHunkForLine(hunks: DiffHunk[], line: number): number {
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (h.newEnd > h.newStart) {
      if (line >= h.newStart && line < h.newEnd) return i;
    } else {
      // Pure deletion: marker is on newStart-1 or 0
      const marker = h.newStart > 0 ? h.newStart - 1 : 0;
      if (line === marker) return i;
    }
  }
  // Fallback: find closest hunk
  let best = -1, bestDist = Infinity;
  for (let i = 0; i < hunks.length; i++) {
    const mid = hunks[i].newEnd > hunks[i].newStart
      ? (hunks[i].newStart + hunks[i].newEnd) / 2
      : hunks[i].newStart;
    const dist = Math.abs(mid - line);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

let activeDiffPopup: HTMLElement | null = null;

function closeDiffPopup() {
  if (activeDiffPopup) {
    activeDiffPopup.remove();
    activeDiffPopup = null;
  }
}

function showDiffPopup(textarea: HTMLTextAreaElement, gutterEl: HTMLElement, lineIndex: number, info: GutterInfo) {
  closeDiffPopup();

  const currentLines = textarea.value.split('\n');
  const { hunks } = info;
  if (hunks.length === 0) return;

  let hunkIdx = findHunkForLine(hunks, lineIndex);
  if (hunkIdx < 0) return;

  const hunk = hunks[hunkIdx];
  const baseStart = hunk.oldStart;
  const baseEnd = hunk.oldEnd;

  const popup = document.createElement('div');
  popup.className = 'kivi-diff-popup';
  activeDiffPopup = popup;

  const toolbar = document.createElement('div');
  toolbar.className = 'kivi-diff-toolbar';

  const svgIcon = (d: string, w = 16) =>
    `<svg width="${w}" height="${w}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  const codiconSvg = (d: string) =>
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">${d}</svg>`;

  const removedCount = baseEnd - baseStart;
  const addedCount = hunk.newEnd - hunk.newStart;
  const changeSummary = removedCount > 0 && addedCount > 0
    ? `−${removedCount} +${addedCount}`
    : removedCount > 0 ? `−${removedCount}` : `+${addedCount}`;

  const label = document.createElement('span');
  label.className = 'kivi-diff-label';
  label.textContent = `Change ${hunkIdx + 1}/${hunks.length}`;

  const changeCount = document.createElement('span');
  changeCount.className = 'kivi-diff-change-count';
  changeCount.textContent = changeSummary;

  const spacer = document.createElement('span');
  spacer.className = 'kivi-diff-spacer';

  // Revert (discard) — VS Code "discard-clean" icon
  const revertBtn = document.createElement('button');
  revertBtn.title = 'Revert Change';
  revertBtn.className = 'kivi-diff-action-btn kivi-diff-action-revert';
  revertBtn.innerHTML = codiconSvg('<path d="M3.5 2v3.5H7v1H2.5V2h1zm9.08 5.33a4.5 4.5 0 0 0-8.33-.96l-.89-.45a5.5 5.5 0 0 1 10.2 1.2l.6-.56.69.72-2.02 1.88-1.88-2.02.69-.72.94.89zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/>');
  revertBtn.addEventListener('click', () => {
    const lines = textarea.value.split('\n');
    const baseChunk = savedBaseLines.slice(baseStart, baseEnd);
    lines.splice(hunk.newStart, hunk.newEnd - hunk.newStart, ...baseChunk);
    textarea.value = lines.join('\n');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    closeDiffPopup();
  });

  // Stage — VS Code "add" / plus icon
  const stageBtn = document.createElement('button');
  stageBtn.title = 'Stage Change';
  stageBtn.className = 'kivi-diff-action-btn kivi-diff-action-stage';
  stageBtn.innerHTML = codiconSvg('<path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/>');
  stageBtn.addEventListener('click', () => {
    vscode.postMessage({
      type: 'stageChange',
      newStart: hunk.newStart,
      newEnd: hunk.newEnd,
      oldStart: baseStart,
      oldEnd: baseEnd,
    });
    closeDiffPopup();
  });

  const prevBtn = document.createElement('button');
  prevBtn.title = 'Previous Change';
  prevBtn.innerHTML = svgIcon('<polyline points="12,10 8,6 4,10"/>');
  prevBtn.disabled = hunkIdx === 0;
  prevBtn.addEventListener('click', () => {
    if (hunkIdx > 0) {
      const newInfo = computeGutterInfo(savedBaseLines, textarea.value.split('\n'));
      if (hunkIdx - 1 < newInfo.hunks.length) {
        const target = newInfo.hunks[hunkIdx - 1];
        const targetLine = target.newEnd > target.newStart ? target.newStart : Math.max(0, target.newStart - 1);
        showDiffPopup(textarea, gutterEl, targetLine, newInfo);
      }
    }
  });

  const nextBtn = document.createElement('button');
  nextBtn.title = 'Next Change';
  nextBtn.innerHTML = svgIcon('<polyline points="4,6 8,10 12,6"/>');
  nextBtn.disabled = hunkIdx >= hunks.length - 1;
  nextBtn.addEventListener('click', () => {
    if (hunkIdx < hunks.length - 1) {
      const newInfo = computeGutterInfo(savedBaseLines, textarea.value.split('\n'));
      if (hunkIdx + 1 < newInfo.hunks.length) {
        const target = newInfo.hunks[hunkIdx + 1];
        const targetLine = target.newEnd > target.newStart ? target.newStart : Math.max(0, target.newStart - 1);
        showDiffPopup(textarea, gutterEl, targetLine, newInfo);
      }
    }
  });

  const closeBtn = document.createElement('button');
  closeBtn.title = 'Close (Escape)';
  closeBtn.innerHTML = svgIcon('<line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>');
  closeBtn.addEventListener('click', closeDiffPopup);

  addDelayedTooltip(revertBtn);
  addDelayedTooltip(stageBtn);
  addDelayedTooltip(prevBtn);
  addDelayedTooltip(nextBtn);
  addDelayedTooltip(closeBtn);
  toolbar.append(label, changeCount, spacer, stageBtn, revertBtn, prevBtn, nextBtn, closeBtn);
  popup.appendChild(toolbar);

  const content = document.createElement('div');
  content.className = 'kivi-diff-content';

  const removedLines = savedBaseLines.slice(baseStart, baseEnd);
  const addedLines = currentLines.slice(hunk.newStart, hunk.newEnd);

  function makeDiffLine(text: string, type: 'context' | 'removed' | 'added', oldNum?: number, newNum?: number): HTMLElement {
    const row = document.createElement('div');
    row.className = `kivi-diff-line kivi-diff-line-${type}`;
    const oldGutter = document.createElement('span');
    oldGutter.className = 'kivi-diff-line-gutter';
    oldGutter.textContent = oldNum != null ? String(oldNum + 1) : '';
    const newGutter = document.createElement('span');
    newGutter.className = 'kivi-diff-line-gutter';
    newGutter.textContent = newNum != null ? String(newNum + 1) : '';
    const sign = document.createElement('span');
    sign.className = 'kivi-diff-line-sign';
    sign.textContent = type === 'removed' ? '−' : type === 'added' ? '+' : ' ';
    const txt = document.createElement('span');
    txt.className = 'kivi-diff-line-text';
    txt.textContent = text || ' ';
    row.append(oldGutter, newGutter, sign, txt);
    return row;
  }

  // Context before (up to 3 base lines before the hunk)
  const ctxBeforeStart = Math.max(0, baseStart - 3);
  for (let i = ctxBeforeStart; i < baseStart; i++) {
    const newLineForCtx = hunk.newStart - (baseStart - i);
    content.appendChild(makeDiffLine(savedBaseLines[i], 'context', i, newLineForCtx >= 0 ? newLineForCtx : undefined));
  }

  // Show removed lines first, then added lines (VS Code style)
  for (let i = 0; i < removedLines.length; i++) {
    content.appendChild(makeDiffLine(removedLines[i], 'removed', baseStart + i, undefined));
  }

  for (let i = 0; i < addedLines.length; i++) {
    content.appendChild(makeDiffLine(addedLines[i], 'added', undefined, hunk.newStart + i));
  }

  // Context after (up to 3 base lines after the hunk)
  for (let i = baseEnd; i < Math.min(savedBaseLines.length, baseEnd + 3); i++) {
    const newLineForCtx = hunk.newEnd + (i - baseEnd);
    content.appendChild(makeDiffLine(savedBaseLines[i], 'context', i, newLineForCtx < currentLines.length ? newLineForCtx : undefined));
  }

  popup.appendChild(content);

  // Blame info footer — request from extension host
  const blameBar = document.createElement('div');
  blameBar.className = 'kivi-diff-blame';
  blameBar.textContent = 'Loading blame info…';
  popup.appendChild(blameBar);

  // Request blame for the base lines in this hunk
  pendingBlameCallback = (entries) => {
    if (!activeDiffPopup || activeDiffPopup !== popup) return;
    blameBar.textContent = '';
    if (entries.length === 0) {
      blameBar.textContent = 'Uncommitted change';
      return;
    }
    // Deduplicate: show most recent blame entry for the hunk
    const byHash = new Map<string, { author: string; date: string; summary: string; hash: string }>();
    for (const e of entries) {
      if (!byHash.has(e.hash)) byHash.set(e.hash, e);
    }
    for (const e of byHash.values()) {
      const row = document.createElement('div');
      row.className = 'kivi-diff-blame-entry';

      const avatar = document.createElement('span');
      avatar.className = 'kivi-diff-blame-avatar';
      avatar.textContent = e.author.charAt(0).toUpperCase();

      const info = document.createElement('span');
      info.className = 'kivi-diff-blame-info';
      info.innerHTML = `<strong>${esc(e.author)}</strong> <span class="kivi-diff-blame-date">${esc(e.date)}</span>`;

      const msg = document.createElement('span');
      msg.className = 'kivi-diff-blame-msg';
      msg.textContent = `${e.hash} — ${e.summary}`;

      row.append(avatar, info, msg);
      blameBar.appendChild(row);
    }
  };

  // Request blame for the base range (HEAD lines corresponding to this hunk)
  vscode.postMessage({
    type: 'requestBlame',
    lineStart: baseStart,
    lineEnd: Math.max(baseStart, baseEnd - 1),
  });

  // Position: place inside the raw wrapper, below the clicked line
  const wrapper = textarea.closest('#kivi-raw-wrapper') || textarea.closest('.kivi-split-right');
  if (wrapper) {
    (wrapper as HTMLElement).style.position = 'relative';
    const lineEl = gutterEl.children[lineIndex] as HTMLElement | undefined;
    if (lineEl) {
      const wrapperRect = (wrapper as HTMLElement).getBoundingClientRect();
      const lineRect = lineEl.getBoundingClientRect();
      const dz = getHostZoom(wrapper as HTMLElement);
      popup.style.top = `${(lineRect.bottom - wrapperRect.top) / dz + (wrapper as HTMLElement).scrollTop}px`;
    }
    (wrapper as HTMLElement).appendChild(popup);
  }

  // Close on Escape
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeDiffPopup();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

function gitHunksToDiffHunks(gitHunks: typeof savedGitDiffHunks): DiffHunk[] {
  if (!gitHunks) return [];
  return gitHunks.map(h => {
    const isDel = h.newCount === 0;
    const isAdd = h.oldCount === 0;
    return {
      oldStart: isAdd ? h.oldStart : h.oldStart - 1,
      oldEnd: isAdd ? h.oldStart : h.oldStart - 1 + h.oldCount,
      newStart: isDel ? h.newStart : h.newStart - 1,
      newEnd: isDel ? h.newStart : h.newStart - 1 + h.newCount,
    };
  });
}

function getGutterInfoForMonaco(monacoInst: MonacoRawEditor): GutterInfo | null {
  const currentLines = monacoInst.getValue().split('\n');
  if (savedGitDiffHunks) {
    const hunks = gitHunksToDiffHunks(savedGitDiffHunks);
    const n = currentLines.length;
    const marks: GutterMark[] = new Array(n).fill('u');
    for (const h of hunks) {
      const deleted = h.oldEnd - h.oldStart;
      const inserted = h.newEnd - h.newStart;
      if (inserted > 0 && deleted > 0) {
        for (let i = h.newStart; i < h.newEnd && i < n; i++) marks[i] = 'm';
      } else if (inserted > 0) {
        for (let i = h.newStart; i < h.newEnd && i < n; i++) marks[i] = 'a';
      } else if (deleted > 0) {
        const marker = h.newStart > 0 ? h.newStart - 1 : 0;
        if (marker < n && marks[marker] === 'u') marks[marker] = 'd';
      }
    }
    return { marks, hunks };
  }
  if (!savedBaseLines.length) return null;
  return computeGutterInfo(savedBaseLines, currentLines);
}

function handleMonacoGutterClick(monacoInst: MonacoRawEditor, lineNumber: number) {
  const info = getGutterInfoForMonaco(monacoInst);
  if (!info || info.hunks.length === 0) return;
  const lineIndex = lineNumber - 1;
  const hunkIdx = findHunkForLine(info.hunks, lineIndex);
  if (hunkIdx < 0) return;

  showMonacoDiffPopup(monacoInst, lineIndex, info, hunkIdx);
}

function showMonacoDiffPopup(monacoInst: MonacoRawEditor, lineIndex: number, info: GutterInfo, hunkIdx: number) {
  closeDiffPopup();

  const ed = monacoInst.editor();
  const currentLines = monacoInst.getValue().split('\n');
  const hunk = info.hunks[hunkIdx];
  const baseStart = hunk.oldStart;
  const baseEnd = hunk.oldEnd;

  const popup = document.createElement('div');
  popup.className = 'kivi-diff-popup';
  activeDiffPopup = popup;

  const toolbar = document.createElement('div');
  toolbar.className = 'kivi-diff-toolbar';

  const svgIcon = (d: string, w = 16) =>
    `<svg width="${w}" height="${w}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const codiconSvg = (d: string) =>
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">${d}</svg>`;

  const removedCount = baseEnd - baseStart;
  const addedCount = hunk.newEnd - hunk.newStart;
  const changeSummary = removedCount > 0 && addedCount > 0
    ? `−${removedCount} +${addedCount}`
    : removedCount > 0 ? `−${removedCount}` : `+${addedCount}`;

  const label = document.createElement('span');
  label.className = 'kivi-diff-label';
  label.textContent = `Change ${hunkIdx + 1}/${info.hunks.length}`;

  const changeCount = document.createElement('span');
  changeCount.className = 'kivi-diff-change-count';
  changeCount.textContent = changeSummary;

  const spacer = document.createElement('span');
  spacer.className = 'kivi-diff-spacer';

  const revertBtn = document.createElement('button');
  revertBtn.title = 'Revert Change';
  revertBtn.className = 'kivi-diff-action-btn kivi-diff-action-revert';
  revertBtn.innerHTML = codiconSvg('<path d="M3.5 2v3.5H7v1H2.5V2h1zm9.08 5.33a4.5 4.5 0 0 0-8.33-.96l-.89-.45a5.5 5.5 0 0 1 10.2 1.2l.6-.56.69.72-2.02 1.88-1.88-2.02.69-.72.94.89zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/>');
  revertBtn.addEventListener('click', () => {
    const lines = monacoInst.getValue().split('\n');
    const baseChunk = savedBaseLines.slice(baseStart, baseEnd);
    lines.splice(hunk.newStart, hunk.newEnd - hunk.newStart, ...baseChunk);
    monacoInst.setValue(lines.join('\n'));
    closeDiffPopup();
  });

  const stageBtn = document.createElement('button');
  stageBtn.title = 'Stage Change';
  stageBtn.className = 'kivi-diff-action-btn kivi-diff-action-stage';
  stageBtn.innerHTML = codiconSvg('<path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/>');
  stageBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stageChange', newStart: hunk.newStart, newEnd: hunk.newEnd, oldStart: baseStart, oldEnd: baseEnd });
    closeDiffPopup();
  });

  const prevBtn = document.createElement('button');
  prevBtn.title = 'Previous Change';
  prevBtn.innerHTML = svgIcon('<polyline points="12,10 8,6 4,10"/>');
  prevBtn.disabled = hunkIdx === 0;
  prevBtn.addEventListener('click', () => {
    if (hunkIdx > 0) {
      const newInfo = getGutterInfoForMonaco(monacoInst);
      if (newInfo && hunkIdx - 1 < newInfo.hunks.length) {
        const target = newInfo.hunks[hunkIdx - 1];
        const targetLine = target.newEnd > target.newStart ? target.newStart : Math.max(0, target.newStart - 1);
        monacoInst.revealLine(targetLine + 1);
        showMonacoDiffPopup(monacoInst, targetLine, newInfo, hunkIdx - 1);
      }
    }
  });

  const nextBtn = document.createElement('button');
  nextBtn.title = 'Next Change';
  nextBtn.innerHTML = svgIcon('<polyline points="4,6 8,10 12,6"/>');
  nextBtn.disabled = hunkIdx >= info.hunks.length - 1;
  nextBtn.addEventListener('click', () => {
    if (hunkIdx < info.hunks.length - 1) {
      const newInfo = getGutterInfoForMonaco(monacoInst);
      if (newInfo && hunkIdx + 1 < newInfo.hunks.length) {
        const target = newInfo.hunks[hunkIdx + 1];
        const targetLine = target.newEnd > target.newStart ? target.newStart : Math.max(0, target.newStart - 1);
        monacoInst.revealLine(targetLine + 1);
        showMonacoDiffPopup(monacoInst, targetLine, newInfo, hunkIdx + 1);
      }
    }
  });

  const closeBtn = document.createElement('button');
  closeBtn.title = 'Close (Escape)';
  closeBtn.innerHTML = svgIcon('<line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>');
  closeBtn.addEventListener('click', closeDiffPopup);

  addDelayedTooltip(revertBtn);
  addDelayedTooltip(stageBtn);
  addDelayedTooltip(prevBtn);
  addDelayedTooltip(nextBtn);
  addDelayedTooltip(closeBtn);
  toolbar.append(label, changeCount, spacer, stageBtn, revertBtn, prevBtn, nextBtn, closeBtn);
  popup.appendChild(toolbar);

  const content = document.createElement('div');
  content.className = 'kivi-diff-content';

  const removedLines = savedBaseLines.slice(baseStart, baseEnd);
  const addedLines = currentLines.slice(hunk.newStart, hunk.newEnd);

  function makeDiffLine(text: string, type: 'context' | 'removed' | 'added', oldNum?: number, newNum?: number): HTMLElement {
    const row = document.createElement('div');
    row.className = `kivi-diff-line kivi-diff-line-${type}`;
    const oldGutter = document.createElement('span');
    oldGutter.className = 'kivi-diff-line-gutter';
    oldGutter.textContent = oldNum != null ? String(oldNum + 1) : '';
    const newGutter = document.createElement('span');
    newGutter.className = 'kivi-diff-line-gutter';
    newGutter.textContent = newNum != null ? String(newNum + 1) : '';
    const sign = document.createElement('span');
    sign.className = 'kivi-diff-line-sign';
    sign.textContent = type === 'removed' ? '−' : type === 'added' ? '+' : ' ';
    const txt = document.createElement('span');
    txt.className = 'kivi-diff-line-text';
    txt.textContent = text || ' ';
    row.append(oldGutter, newGutter, sign, txt);
    return row;
  }

  const ctxBeforeStart = Math.max(0, baseStart - 3);
  for (let i = ctxBeforeStart; i < baseStart; i++) {
    const newLineForCtx = hunk.newStart - (baseStart - i);
    content.appendChild(makeDiffLine(savedBaseLines[i], 'context', i, newLineForCtx >= 0 ? newLineForCtx : undefined));
  }
  for (let i = 0; i < removedLines.length; i++) {
    content.appendChild(makeDiffLine(removedLines[i], 'removed', baseStart + i, undefined));
  }
  for (let i = 0; i < addedLines.length; i++) {
    content.appendChild(makeDiffLine(addedLines[i], 'added', undefined, hunk.newStart + i));
  }
  for (let i = baseEnd; i < Math.min(savedBaseLines.length, baseEnd + 3); i++) {
    const newLineForCtx = hunk.newEnd + (i - baseEnd);
    content.appendChild(makeDiffLine(savedBaseLines[i], 'context', i, newLineForCtx < currentLines.length ? newLineForCtx : undefined));
  }
  popup.appendChild(content);

  const blameBar = document.createElement('div');
  blameBar.className = 'kivi-diff-blame';
  blameBar.textContent = 'Loading blame info…';
  popup.appendChild(blameBar);

  pendingBlameCallback = (entries) => {
    if (!activeDiffPopup || activeDiffPopup !== popup) return;
    blameBar.textContent = '';
    if (entries.length === 0) { blameBar.textContent = 'Uncommitted change'; return; }
    const byHash = new Map<string, { author: string; date: string; summary: string; hash: string }>();
    for (const e of entries) { if (!byHash.has(e.hash)) byHash.set(e.hash, e); }
    for (const e of byHash.values()) {
      const row = document.createElement('div');
      row.className = 'kivi-diff-blame-entry';
      const avatar = document.createElement('span');
      avatar.className = 'kivi-diff-blame-avatar';
      avatar.textContent = e.author.charAt(0).toUpperCase();
      const bInfo = document.createElement('span');
      bInfo.className = 'kivi-diff-blame-info';
      bInfo.innerHTML = `<strong>${esc(e.author)}</strong> <span class="kivi-diff-blame-date">${esc(e.date)}</span>`;
      const msg = document.createElement('span');
      msg.className = 'kivi-diff-blame-msg';
      msg.textContent = `${e.hash} — ${e.summary}`;
      row.append(avatar, bInfo, msg);
      blameBar.appendChild(row);
    }
  };

  vscode.postMessage({ type: 'requestBlame', lineStart: baseStart, lineEnd: Math.max(baseStart, baseEnd - 1) });

  // Position: use Monaco's getTopForLineNumber for pixel-accurate placement
  const container = ed.getDomNode()?.closest('#kivi-raw-wrapper, .kivi-split-right') as HTMLElement | null;
  if (container) {
    container.style.position = 'relative';
    const topForLine = ed.getTopForLineNumber(lineIndex + 1);
    const scrollTop = ed.getScrollTop();
    const editorDom = ed.getDomNode();
    const editorRect = editorDom?.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const editorOffset = editorRect ? editorRect.top - containerRect.top : 0;
    const lineHeight = ed.getOption(monaco.editor.EditorOption.lineHeight);
    popup.style.top = `${editorOffset + (topForLine - scrollTop) + lineHeight}px`;
    container.appendChild(popup);
  } else {
    document.body.appendChild(popup);
  }

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeDiffPopup(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
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

  // Scrollable zone for format + extras; right-side items stay pinned
  const scrollZone = document.createElement('div');
  scrollZone.className = 'kivi-toolbar-scroll';
  el.appendChild(scrollZone);

  const formatGroup = document.createElement('div');
  formatGroup.id = 'kivi-toolbar-format';
  scrollZone.appendChild(formatGroup);

  type ToolbarAction = { id: string; svg?: string; title?: string; cmd?: (...args: any[]) => void; active?: () => boolean };

  // Toolbar layout:
  //   [B I S] | [<> hl] | [H1 H2 H3] | [UL OL Task] | [Quote Code HR] | [Link]
  // Inline marks first (most used), then structure, then insert actions.
  // Sub/superscript are niche — kept but grouped with code/highlight.
  const textActions: ToolbarAction[] = [
    { id: 'bold', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5h4.5a3 3 0 0 1 2.12 5.12A3.25 3.25 0 0 1 9 13.5H4V2.5zM4 8h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`, title: 'Bold (⌘B)', cmd: () => cmd().toggleBold().run(), active: () => tiptap.isActive('bold') },
    { id: 'italic', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="10" y1="2.5" x2="6" y2="13.5"/><line x1="7.5" y1="2.5" x2="11.5" y2="2.5"/><line x1="4.5" y1="13.5" x2="8.5" y2="13.5"/></svg>`, title: 'Italic (⌘I)', cmd: () => cmd().toggleItalic().run(), active: () => tiptap.isActive('italic') },
    { id: 'strike', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="8" x2="14" y2="8" stroke-width="1.5"/><path d="M10.2 4.8C9.7 3.6 8.6 3 7.5 3 5.8 3 4.5 4 4.5 5.5c0 1 .5 1.7 1.3 2.2" stroke-width="1.6" fill="none"/><path d="M5.8 11.2c.5 1.2 1.6 1.8 2.7 1.8 1.7 0 3-1 3-2.5 0-.7-.3-1.3-.8-1.7" stroke-width="1.6" fill="none"/></svg>`, title: 'Strikethrough (⌘⇧X)', cmd: () => cmd().toggleStrike().run(), active: () => tiptap.isActive('strike') },
    { id: 'sep' },
    { id: 'code', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,3.5 1.5,8 5,12.5"/><polyline points="11,3.5 14.5,8 11,12.5"/></svg>`, title: 'Code (⌘E)', cmd: () => cmd().toggleCode().run(), active: () => tiptap.isActive('code') },
    { id: 'subscript', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="10" y2="11"/><line x1="10" y1="2" x2="2" y2="11"/><text x="11" y="15" font-size="6.5" font-family="system-ui" font-weight="700" fill="currentColor" stroke="none">2</text></svg>`, title: 'Subscript', cmd: () => cmd().toggleSubscript().run(), active: () => tiptap.isActive('subscript') },
    { id: 'superscript', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="5" x2="9" y2="14"/><line x1="9" y1="5" x2="1" y2="14"/><text x="11" y="6" font-size="6.5" font-family="system-ui" font-weight="700" fill="currentColor" stroke="none">2</text></svg>`, title: 'Superscript', cmd: () => cmd().toggleSuperscript().run(), active: () => tiptap.isActive('superscript') },
    { id: 'highlight', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="8" height="11" rx="1" fill="#fde68a" fill-opacity="0.4"/><path d="M12 11l-2 4h4l-2-4z" fill="currentColor" stroke="none"/></svg>`, title: 'Highlight', cmd: () => cmd().toggleHighlight().run(), active: () => tiptap.isActive('highlight') },
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
    { id: 'sep' },
    { id: 'link', svg: _s('<path d="M6.5 9.5a3 3 0 0 1-.5-4l1.5-1.5a3 3 0 0 1 4.2 4.2L10.5 9.5"/><path d="M9.5 6.5a3 3 0 0 1 .5 4l-1.5 1.5a3 3 0 0 1-4.2-4.2L5.5 6.5"/>'), title: 'Insert Link (⌘K)', cmd: (_e: unknown, btn: HTMLElement) => { insertLinkAtCursor(btn.getBoundingClientRect()); }, active: () => tiptap.isActive('link') },
  ];

  const imageAlignSvg = (d: string) =>
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  const imageActions: ToolbarAction[] = [
    { id: 'img-align-left', svg: imageAlignSvg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="2" y1="7" x2="10" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'), title: 'Align Left', cmd: () => { setSelectedImageAttr('data-align', 'left'); } },
    { id: 'img-align-center', svg: imageAlignSvg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="4" y1="7" x2="12" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'), title: 'Align Center', cmd: () => { setSelectedImageAttr('data-align', 'center'); } },
    { id: 'img-align-right', svg: imageAlignSvg('<line x1="2" y1="3" x2="14" y2="3"/><line x1="6" y1="7" x2="14" y2="7"/><line x1="2" y1="11" x2="14" y2="11"/>'), title: 'Align Right', cmd: () => { setSelectedImageAttr('data-align', 'right'); } },
    { id: 'sep' },
    { id: 'img-copy-src', svg: _s('<rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V3a1.5 1.5 0 0 1 1.5-1.5H11"/>'), title: 'Copy Image Source', cmd: () => { const src = getSelectedImageAttr('src') as string || ''; navigator.clipboard.writeText(src).catch(() => {}); } },
    { id: 'sep' },
    { id: 'img-delete', svg: _s('<polyline points="3,4 13,4"/><path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><path d="M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4"/>'), title: 'Delete Image', cmd: () => { deleteSelectedImage(); } },
  ];

  function setSelectedImageAttr(key: string, value: unknown) {
    const { from } = tiptap.state.selection;
    const node = tiptap.state.doc.nodeAt(from);
    if (node?.type.name !== 'image') return;
    const tr = tiptap.state.tr.setNodeMarkup(from, undefined, { ...node.attrs, [key]: value });
    tiptap.view.dispatch(tr);
  }

  function getSelectedImageAttr(key: string): unknown {
    const { from } = tiptap.state.selection;
    const node = tiptap.state.doc.nodeAt(from);
    return node?.attrs[key];
  }

  function deleteSelectedImage() {
    const { from } = tiptap.state.selection;
    const node = tiptap.state.doc.nodeAt(from);
    if (node?.type.name !== 'image') return;
    const src = node.attrs.src as string | undefined;
    tiptap.view.dispatch(tiptap.state.tr.delete(from, from + node.nodeSize));
    if (src) vscode.postMessage({ type: 'checkOrphanAsset', src });
  }

  function renderActions(actions: ToolbarAction[]) {
    formatGroup.innerHTML = '';
    for (const action of actions) {
      if (action.id === 'sep') {
        const sep = document.createElement('span');
        sep.className = 'kivi-toolbar-sep';
        formatGroup.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'kivi-toolbar-btn';
      btn.dataset.actionId = action.id;
      btn.title = action.title || '';
      if (action.svg) btn.innerHTML = action.svg;
      btn.addEventListener('click', (e) => { e.preventDefault(); action.cmd?.(undefined, btn); update(); });
      addDelayedTooltip(btn);
      formatGroup.appendChild(btn);
    }
  }

  let currentContext: 'text' | 'image' = 'text';
  renderActions(textActions);

  // IDs of formatting buttons that don't work inside code blocks
  const INLINE_FORMAT_IDS = new Set(['bold', 'italic', 'strike', 'code', 'subscript', 'superscript', 'highlight', 'link']);

  const update = () => {
    const { from } = tiptap.state.selection;
    const node = tiptap.state.doc.nodeAt(from);
    const newContext = detectToolbarContext(node?.type.name);

    if (newContext !== currentContext) {
      currentContext = newContext;
      renderActions(currentContext === 'image' ? imageActions : textActions);
      return;
    }

    if (currentContext === 'text') {
      const inCodeBlock = tiptap.isActive('codeBlock');
      const buttons = formatGroup.querySelectorAll<HTMLButtonElement>('.kivi-toolbar-btn');
      const seps = formatGroup.querySelectorAll<HTMLElement>('.kivi-toolbar-sep');
      let i = 0;
      let sepIdx = 0;
      let groupAllHidden = true;
      for (const action of textActions) {
        if (action.id === 'sep') {
          const sep = seps[sepIdx++];
          if (sep) sep.style.display = groupAllHidden ? 'none' : '';
          groupAllHidden = true;
          continue;
        }
        const btn = buttons[i++];
        if (!btn) continue;
        if (action.active) btn.classList.toggle('active', action.active());
        const disabled = inCodeBlock && INLINE_FORMAT_IDS.has(action.id);
        btn.classList.toggle('kivi-btn-disabled', disabled);
        btn.style.display = disabled ? 'none' : '';
        btn.setAttribute('aria-disabled', String(disabled));
        if (!disabled) groupAllHidden = false;
      }
    }
  };
  tiptap.on('selectionUpdate', update);
  tiptap.on('update', update);

  // ── Collapsible extras: zoom, graph, reveal, new page, insert file ──
  const extras = document.createElement('div');
  extras.className = 'kivi-toolbar-extras';
  appendZoomControls(extras);
  appendSep(extras);
  appendGraphButton(extras);
  appendSep(extras);
  const revealBtn = document.createElement('button');
  revealBtn.className = 'kivi-toolbar-btn';
  revealBtn.title = 'Reveal in Explorer';
  revealBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V10"/><path d="M14 2l-5 5"/><path d="M10 2h4v4"/></svg>`;
  revealBtn.addEventListener('click', () => vscode.postMessage({ type: 'revealInExplorer' }));
  addDelayedTooltip(revealBtn);
  extras.appendChild(revealBtn);
  appendSep(extras);
  const newPageBtn = document.createElement('button');
  newPageBtn.className = 'kivi-toolbar-btn';
  newPageBtn.title = 'New Page';
  newPageBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2z"/><polyline points="9,2 9,6 13,6"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="6" y1="11" x2="10" y2="11"/></svg>`;
  newPageBtn.addEventListener('click', () => vscode.postMessage({ type: 'promptCreateChildPage' }));
  addDelayedTooltip(newPageBtn);
  extras.appendChild(newPageBtn);
  const insertFileBtn = document.createElement('button');
  insertFileBtn.className = 'kivi-toolbar-btn';
  insertFileBtn.title = 'Insert File';
  insertFileBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 8.5L8.3 14.3a2.83 2.83 0 0 1-4-4L10.7 4a1.89 1.89 0 0 1 2.7 2.7L7 13"/></svg>`;
  insertFileBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAsset' }));
  addDelayedTooltip(insertFileBtn);
  extras.appendChild(insertFileBtn);
  scrollZone.appendChild(extras);

  // ── Pinned right: word-wrap, L/S/R, toggle ──
  // These stay visible even when the toolbar is collapsed.
  const pinnedRight = document.createElement('div');
  pinnedRight.className = 'kivi-toolbar-pinned';
  appendWordWrapToggle(pinnedRight);
  appendViewModeGroup(pinnedRight);
  appendSep(pinnedRight);
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'kivi-toolbar-btn kivi-toolbar-toggle-btn';
  toggleBtn.title = 'Hide Toolbar';
  toggleBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,10 8,6 12,10"/></svg>`;
  toggleBtn.addEventListener('click', () => {
    setToolbarVisible(el.classList.contains('kivi-toolbar-collapsed'));
  });
  addDelayedTooltip(toggleBtn);
  pinnedRight.appendChild(toggleBtn);
  el.appendChild(pinnedRight);
}

function initFloatingBar() {
  // Floating bar replaced by toolbar collapse mode — no separate element needed.
}

// ─── Context Menu ───

function initContextMenu() {
  const menu = document.createElement('div');
  menu.id = 'kivi-context-menu';
  menu.style.display = 'none';
  document.body.appendChild(menu);

  type MenuItem = { label: string; shortcut?: string; divider?: boolean; action?: () => void };

  const textItems: MenuItem[] = [
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
    { label: 'Find in File', shortcut: '⌘F', action: () => showSearchBar(false) },
    { label: 'Reveal in Explorer', shortcut: '⌘⇧E', action: () => vscode.postMessage({ type: 'revealInExplorer' }) },
  ];

  function buildImageItems(img: HTMLImageElement): MenuItem[] {
    const tiptap = editor?.getTiptapEditor();
    const imgPos = tiptap ? findImagePos(tiptap, img) : -1;
    return [
      { label: 'Copy Image Source', action: () => { navigator.clipboard.writeText(img.getAttribute('src') || '').catch(() => {}); } },
      { label: 'Copy Image', action: () => { document.execCommand('copy'); } },
      { divider: true, label: '' },
      { label: 'Align Left', action: () => { if (tiptap && imgPos >= 0) setImageAttr(tiptap, imgPos, 'data-align', 'left'); } },
      { label: 'Align Center', action: () => { if (tiptap && imgPos >= 0) setImageAttr(tiptap, imgPos, 'data-align', 'center'); } },
      { label: 'Align Right', action: () => { if (tiptap && imgPos >= 0) setImageAttr(tiptap, imgPos, 'data-align', 'right'); } },
      { divider: true, label: '' },
      { label: 'Delete Image', action: () => {
        if (tiptap && imgPos >= 0) {
          const node = tiptap.state.doc.nodeAt(imgPos);
          if (node) {
            const src = node.attrs.src as string | undefined;
            tiptap.view.dispatch(tiptap.state.tr.delete(imgPos, imgPos + node.nodeSize));
            if (src) vscode.postMessage({ type: 'checkOrphanAsset', src });
          }
        }
      }},
      { divider: true, label: '' },
      { label: 'Find in File', shortcut: '⌘F', action: () => showSearchBar(false) },
      { label: 'Reveal in Explorer', shortcut: '⌘⇧E', action: () => vscode.postMessage({ type: 'revealInExplorer' }) },
    ];
  }

  function buildVideoItems(video: HTMLVideoElement): MenuItem[] {
    return buildMediaItems(video, 'video');
  }

  function buildMediaItems(el: HTMLElement, kind: 'video' | 'audio'): MenuItem[] {
    const tiptap = editor?.getTiptapEditor();
    const pos = tiptap ? findNodePos(tiptap, el, kind) : -1;
    const label = kind.charAt(0).toUpperCase() + kind.slice(1);
    return [
      { label: `Copy ${label} Source`, action: () => { navigator.clipboard.writeText(el.getAttribute('src') || '').catch(() => {}); } },
      { divider: true, label: '' },
      { label: `Delete ${label}`, action: () => {
        if (tiptap && pos >= 0) {
          const node = tiptap.state.doc.nodeAt(pos);
          if (node) {
            const src = node.attrs.src as string | undefined;
            tiptap.view.dispatch(tiptap.state.tr.delete(pos, pos + node.nodeSize));
            if (src) vscode.postMessage({ type: 'checkOrphanAsset', src });
          }
        }
      }},
      { divider: true, label: '' },
      { label: 'Find in File', shortcut: '⌘F', action: () => showSearchBar(false) },
      { label: 'Reveal in Explorer', shortcut: '⌘⇧E', action: () => vscode.postMessage({ type: 'revealInExplorer' }) },
    ];
  }

  function renderMenu(items: MenuItem[]) {
    menu.innerHTML = '';
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
  }

  function detectLinkElement(el: HTMLElement): { kind: string; target: string; alias?: string; displayText: string } | null {
    const wiki = el.closest('a.kivi-wiki-link') as HTMLElement | null;
    if (wiki) {
      const t = wiki.getAttribute('data-wiki-target');
      if (t) return { kind: 'wiki-link', target: t, alias: wiki.textContent || undefined, displayText: wiki.textContent || t };
    }
    const tag = el.closest('span.kivi-hashtag') as HTMLElement | null;
    if (tag) {
      const t = tag.getAttribute('data-tag');
      if (t) return { kind: 'tag', target: t, displayText: `#${t}` };
    }
    const link = el.closest('a.kivi-link') as HTMLAnchorElement | null;
    if (link) {
      const href = link.getAttribute('href');
      if (href) {
        const isExternal = href.startsWith('http://') || href.startsWith('https://');
        return { kind: isExternal ? 'external-url' : 'markdown-link', target: href, displayText: link.textContent || href };
      }
    }
    return null;
  }

  function buildLinkItems(linkInfo: { kind: string; target: string; alias?: string; displayText: string }): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'Open Link', action: () => vscode.postMessage({ type: 'navigateLink', link: linkInfo }) },
      { label: 'Open Link to the Side', action: () => vscode.postMessage({ type: 'navigateLinkBeside', link: linkInfo }) },
      { divider: true, label: '' },
      { label: 'Copy Link Address', action: () => { navigator.clipboard.writeText(linkInfo.target).catch(() => {}); } },
    ];
    if (linkInfo.kind === 'external-url') {
      items.push({ label: 'Copy Link Text', action: () => { navigator.clipboard.writeText(linkInfo.displayText).catch(() => {}); } });
    }
    items.push(
      { divider: true, label: '' },
      ...textItems.slice(0, 5),
    );
    return items;
  }

  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('#editor') && !target.closest('.kivi-split-raw-editor') && !target.closest('#kivi-raw-editor') && !target.closest('.kivi-raw-gutter')) return;
    e.preventDefault();

    const img = target.tagName === 'IMG' ? target as HTMLImageElement : target.closest('img') as HTMLImageElement | null;
    const video = target.tagName === 'VIDEO' ? target as HTMLVideoElement : target.closest('video') as HTMLVideoElement | null;
    const audio = target.tagName === 'AUDIO' ? target as HTMLAudioElement : target.closest('audio') as HTMLAudioElement | null;
    if (img && target.closest('#editor')) {
      renderMenu(buildImageItems(img));
    } else if (video && target.closest('#editor')) {
      renderMenu(buildVideoItems(video));
    } else if (audio && target.closest('#editor')) {
      renderMenu(buildMediaItems(audio, 'audio'));
    } else if (target.closest('#editor')) {
      const linkInfo = detectLinkElement(target);
      if (linkInfo) {
        renderMenu(buildLinkItems(linkInfo));
      } else {
        renderMenu(textItems);
      }
    } else {
      const monacoInst = viewMode === 'split' ? splitMonaco : rawMonaco;
      const rawItems: MenuItem[] = [
        { label: 'Cut', shortcut: '⌘X', action: () => document.execCommand('cut') },
        { label: 'Copy', shortcut: '⌘C', action: () => document.execCommand('copy') },
        { label: 'Paste', shortcut: '⌘V', action: () => document.execCommand('paste') },
        { divider: true, label: '' },
        { label: 'Select All', shortcut: '⌘A', action: () => document.execCommand('selectAll') },
        { divider: true, label: '' },
        { label: blameEnabled ? 'Hide Git Blame' : 'Show Git Blame', action: () => toggleBlame() },
        { divider: true, label: '' },
        { label: 'Find in File', shortcut: '⌘F', action: () => showSearchBar(false) },
        { label: 'Reveal in Explorer', shortcut: '⌘⇧E', action: () => vscode.postMessage({ type: 'revealInExplorer' }) },
      ];
      renderMenu(rawItems);
    }

    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.display = 'block';
    menu.style.visibility = 'hidden';

    const rect = menu.getBoundingClientRect();
    const cbz = getBodyZoom();
    const x = Math.min(e.clientX, window.innerWidth - rect.width - 4);
    const y = Math.min(e.clientY, window.innerHeight - rect.height - 4);
    menu.style.left = `${Math.max(0, x) / cbz}px`;
    menu.style.top = `${Math.max(0, y) / cbz}px`;
    menu.style.visibility = '';
  });

  document.addEventListener('click', () => { menu.style.display = 'none'; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.style.display = 'none';
  });
}

function findImagePos(tiptap: any, img: HTMLImageElement): number {
  return findNodePos(tiptap, img, 'image');
}

function findNodePos(tiptap: any, targetDom: HTMLElement, typeName: string): number {
  const view = tiptap.view;
  let found = -1;
  view.state.doc.descendants((node: any, pos: number) => {
    if (found >= 0) return false;
    if (node.type.name === typeName) {
      const dom = view.nodeDOM(pos);
      if (dom === targetDom) { found = pos; return false; }
      const nested = (dom as HTMLElement)?.querySelector?.(targetDom.tagName.toLowerCase());
      if (nested === targetDom) { found = pos; return false; }
    }
    return true;
  });
  return found;
}

function setImageAttr(tiptap: any, pos: number, key: string, value: unknown) {
  const node = tiptap.state.doc.nodeAt(pos);
  if (!node) return;
  const tr = tiptap.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, [key]: value });
  tiptap.view.dispatch(tr);
}


async function insertLinkAtCursor(anchorRect?: DOMRect) {
  const tiptap = editor?.getTiptapEditor();
  if (!tiptap) return;
  const { from, to } = tiptap.state.selection;
  const selectedText = tiptap.state.doc.textBetween(from, to, ' ');

  const $from = tiptap.state.doc.resolve(from);
  const linkMark = $from.marks().find(m => m.type.name === 'link');
  const existingHref = linkMark?.attrs.href as string | undefined;

  if (!anchorRect) {
    const coords = tiptap.view.coordsAtPos(from);
    anchorRect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
  }

  const result = await showLinkInput(anchorRect, existingHref || undefined, selectedText || undefined);
  if (!result) {
    tiptap.chain().focus().setTextSelection({ from, to }).run();
    return;
  }

  const { url, text } = result;
  const displayText = text || selectedText;

  if (existingHref) {
    // Editing an existing link — update href (and text if changed)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = tiptap.chain().focus().extendMarkRange('link') as any;
    chain.setLink({ href: url });
    if (text && text !== selectedText) {
      chain.command(({ tr, state }: { tr: any; state: any }) => {
        const { from: mFrom, to: mTo } = state.selection;
        tr.insertText(text, mFrom, mTo);
        return true;
      });
    }
    chain.run();
    return;
  }

  // Wiki-link: [[target]] or [[target|alias]]
  const wikiMatch = url.match(/^\[\[(.+?)(?:\|(.+?))?\]\]$/);
  if (wikiMatch) {
    const target = wikiMatch[1];
    const label = displayText || wikiMatch[2] || target;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = tiptap.chain().focus().setTextSelection({ from, to }) as any;
    if (selectedText && !text) {
      chain.setLink({ href: url }).run();
    } else {
      chain.insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    }
    return;
  }

  // Regular URL
  const label = displayText || url;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = tiptap.chain().focus().setTextSelection({ from, to }) as any;
  if (selectedText && !text) {
    chain.setLink({ href: url }).run();
  } else {
    chain.insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href: url } }] }).run();
  }
}

function setToolbarVisible(visible: boolean, persist = true) {
  const toolbar = document.getElementById('kivi-toolbar');
  if (toolbar) {
    toolbar.classList.toggle('kivi-toolbar-collapsed', !visible);
    const btn = toolbar.querySelector('.kivi-toolbar-toggle-btn') as HTMLElement | null;
    if (btn) {
      btn.innerHTML = visible
        ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,10 8,6 12,10"/></svg>`
        : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,6 8,10 12,6"/></svg>`;
      btn.title = visible ? 'Hide Toolbar' : 'Show Toolbar';
      btn.setAttribute('data-tooltip', visible ? 'Hide Toolbar' : 'Show Toolbar');
    }
  }
  if (persist) vscode.postMessage({ type: 'persistSetting', key: 'toolbarVisible', value: visible });
}

// ─── Delayed tooltip ───

let tooltipEl: HTMLDivElement | null = null;
let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
const TOOLTIP_DELAY = 600;

function ensureTooltipEl(): HTMLDivElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'kivi-tooltip';
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function addDelayedTooltip(btn: HTMLElement) {
  const text = btn.title;
  if (!text) return;
  btn.removeAttribute('title');
  btn.setAttribute('data-tooltip', text);

  btn.addEventListener('mouseenter', () => {
    if (tooltipTimer) clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => {
      const tip = ensureTooltipEl();
      tip.textContent = text;
      tip.style.left = '0';
      tip.style.top = '0';
      tip.style.transform = 'none';
      tip.classList.add('visible');

      const rect = btn.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const pad = 4;
      const gap = 6;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const tbz = getBodyZoom();

      let left = rect.left + rect.width / 2 - tw / 2;
      left = Math.max(pad, Math.min(left, vw - tw - pad));

      let top = rect.bottom + gap;
      if (top + th > vh - pad) {
        top = rect.top - th - gap;
      }
      top = Math.max(pad, top);

      tip.style.left = `${left / tbz}px`;
      tip.style.top = `${top / tbz}px`;
    }, TOOLTIP_DELAY);
  });

  btn.addEventListener('mouseleave', () => {
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
    const tip = ensureTooltipEl();
    tip.classList.remove('visible');
  });
}

// ─── Shared control builders ───

function syncWordWrapButtons() {
  document.querySelectorAll<HTMLButtonElement>('.kivi-wrap-toggle').forEach(b => {
    b.classList.toggle('active', currentWordWrap);
  });
}

function appendWordWrapToggle(parent: HTMLElement) {
  const wrapIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="4" x2="14" y2="4"/><path d="M2 8h9.5a2.5 2.5 0 0 1 0 5H10"/><polyline points="11,11.5 10,13 9,11.5"/><line x1="2" y1="12" x2="6" y2="12"/></svg>';
  const btn = document.createElement('button');
  btn.className = 'kivi-toolbar-btn kivi-wrap-toggle';
  btn.id = '';
  btn.title = 'Toggle Word Wrap';
  btn.innerHTML = wrapIcon;
  if (currentWordWrap) btn.classList.add('active');
  btn.addEventListener('click', () => {
    currentWordWrap = !currentWordWrap;
    syncWordWrapButtons();
    applyWordWrap(currentWordWrap);
    vscode.postMessage({ type: 'updateKiviSetting', key: 'appearance.wordWrap', value: currentWordWrap ? 'on' : 'off' });
  });
  addDelayedTooltip(btn);
  parent.appendChild(btn);
}

function applyWordWrap(enabled: boolean) {
  const editorEl = document.getElementById('editor');
  if (editorEl) {
    editorEl.style.overflowX = enabled ? 'hidden' : 'auto';
  }

  // Also constrain the split-left pane when in split mode
  const splitLeft = document.querySelector('.kivi-split-left') as HTMLElement | null;
  if (splitLeft) {
    splitLeft.style.overflowX = enabled ? 'hidden' : 'auto';
  }

  // Update Monaco editors
  if (rawMonaco) rawMonaco.setWordWrap(enabled);
  if (splitMonaco) splitMonaco.setWordWrap(enabled);

  const wrapStyleEl = document.getElementById('kivi-wrap-style') || (() => {
    const el = document.createElement('style');
    el.id = 'kivi-wrap-style';
    document.head.appendChild(el);
    return el;
  })();
  if (enabled) {
    wrapStyleEl.textContent = [
      `.kivi-vscode-editor { white-space: normal !important; overflow-wrap: break-word !important; word-break: break-word !important; }`,
      `.kivi-vscode-editor p, .kivi-vscode-editor li, .kivi-vscode-editor h1, .kivi-vscode-editor h2, .kivi-vscode-editor h3, .kivi-vscode-editor h4, .kivi-vscode-editor h5, .kivi-vscode-editor h6, .kivi-vscode-editor blockquote { overflow-wrap: break-word !important; word-break: break-word !important; }`,
      `.kivi-vscode-editor img { max-width: 100% !important; height: auto !important; }`,
      `.kivi-vscode-editor table { max-width: 100% !important; table-layout: auto !important; }`,
    ].join('\n');
  } else {
    wrapStyleEl.textContent = `.kivi-vscode-editor { white-space: nowrap !important; overflow-wrap: normal !important; }`;
  }
}

function appendZoomControls(parent: HTMLElement) {
  const group = document.createElement('span');
  group.className = 'kivi-toolbar-zoom-group';

  const minus = document.createElement('button');
  minus.className = 'kivi-toolbar-btn kivi-zoom-btn';
  minus.title = 'Zoom Out (−5%)';
  minus.textContent = '−';
  minus.addEventListener('click', () => changeEditorZoom(-5));
  addDelayedTooltip(minus);
  group.appendChild(minus);

  const label = document.createElement('span');
  label.className = 'kivi-toolbar-btn kivi-zoom-label';
  label.id = 'kivi-zoom-label';
  label.title = 'Click to set zoom · Double-click to reset';
  label.textContent = `${currentEditorZoom}%`;

  const input = document.createElement('input');
  input.className = 'kivi-zoom-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.style.display = 'none';

  function showInput() {
    label.style.display = 'none';
    input.style.display = '';
    input.value = String(currentEditorZoom);
    input.focus();
    input.select();
  }

  function commitInput() {
    input.style.display = 'none';
    label.style.display = '';
    const raw = input.value.replace(/[^0-9]/g, '');
    const val = parseInt(raw, 10);
    if (!isNaN(val) && val > 0) {
      changeEditorZoom(0, Math.max(50, Math.min(300, val)));
    }
  }

  label.addEventListener('click', showInput);
  label.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    changeEditorZoom(0, 100);
  });

  input.addEventListener('blur', commitInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); input.style.display = 'none'; label.style.display = ''; }
  });

  group.appendChild(label);
  group.appendChild(input);

  const plus = document.createElement('button');
  plus.className = 'kivi-toolbar-btn kivi-zoom-btn';
  plus.title = 'Zoom In (+5%)';
  plus.textContent = '+';
  plus.addEventListener('click', () => changeEditorZoom(5));
  addDelayedTooltip(plus);
  group.appendChild(plus);

  parent.appendChild(group);
}

function changeEditorZoom(delta: number, absolute?: number) {
  const newZoom = absolute !== undefined
    ? Math.max(50, Math.min(300, absolute))
    : Math.max(50, Math.min(300, currentEditorZoom + delta));
  if (newZoom === currentEditorZoom) return;
  currentEditorZoom = newZoom;

  const cssZoom = newZoom / 100;
  const editorDiv = document.getElementById('editor');
  if (editorDiv) (editorDiv.style as any).zoom = String(cssZoom);
  document.documentElement.style.setProperty('--kivi-raw-zoom', String(cssZoom));

  const label = document.getElementById('kivi-zoom-label');
  if (label) label.textContent = `${newZoom}%`;

  vscode.postMessage({ type: 'updateKiviSetting', key: 'appearance.editorZoom', value: newZoom });
}

function appendViewModeGroup(parent: HTMLElement) {
  const viewGroup = document.createElement('span');
  viewGroup.className = 'kivi-toolbar-view-group';

  const modes: Array<{ mode: 'live' | 'source' | 'split'; label: string; title: string }> = [
    { mode: 'live', label: 'L', title: 'Live' },
    { mode: 'split', label: 'S', title: 'Split' },
    { mode: 'source', label: 'R', title: 'Raw' },
  ];

  for (const m of modes) {
    const btn = document.createElement('button');
    btn.className = `kivi-toolbar-btn kivi-view-btn${viewMode === m.mode ? ' active' : ''}`;
    btn.title = m.title;
    btn.textContent = m.label;
    btn.setAttribute('data-mode', m.mode);
    btn.addEventListener('click', () => doSetViewMode(m.mode));
    addDelayedTooltip(btn);
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
  addDelayedTooltip(graphBtn);
  parent.appendChild(graphBtn);
}

function appendSep(parent: HTMLElement) {
  const sep = document.createElement('span');
  sep.className = 'kivi-toolbar-sep';
  parent.appendChild(sep);
}

// ─── Search ───

let searchBarVisible = false;
// (rawSearchMatches/rawSearchIndex removed — Monaco handles search natively)

// VS Code codicon-compatible SVG icons for the search bar
const _si = (d: string, s = 14) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">${d}</svg>`;

const SEARCH_ICONS = {
  chevronRight: _si('<path fill-rule="evenodd" clip-rule="evenodd" d="M5.7 13.7L5 13l4.6-4.6.7-.4-.7-.4L5 3l.7-.7 5.3 5.4-5.3 5z" fill="currentColor"/>'),
  chevronDown: _si('<path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L7.976 11.3 3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/>'),
  prevMatch: _si('<path fill-rule="evenodd" clip-rule="evenodd" d="M5.649 10.356l2.349-2.35 2.349 2.35.707-.707L8 6.592l-3.054 3.057.703.707z" fill="currentColor"/>'),
  nextMatch: _si('<path fill-rule="evenodd" clip-rule="evenodd" d="M10.349 5.644l-2.35 2.349-2.348-2.35-.707.707L8 9.408l3.054-3.057-.705-.707z" fill="currentColor"/>'),
  close: _si('<path fill-rule="evenodd" clip-rule="evenodd" d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z" fill="currentColor"/>'),
  replace: _si('<path fill-rule="evenodd" clip-rule="evenodd" d="M3.221 3.739l2.261 2.269L7.7 3.784l-.7-.7-1.012 1.007-.008-1.6a.523.523 0 0 1 .5-.526H8V1h-1.52a1.523 1.523 0 0 0-1.48 1.56l.007 1.529L4.006 3.1l-.785.639zM12.5 7h-8a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5zm-8-1A1.5 1.5 0 0 0 3 7.5v6A1.5 1.5 0 0 0 4.5 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12.5 6h-8z" fill="currentColor"/>'),
  replaceAll: _si('<path fill-rule="evenodd" clip-rule="evenodd" d="M11.6 2.677a1.47 1.47 0 0 0-1.06.44l-.057.058-.463.462h1.38l.14-.14a.47.47 0 0 1 .338-.14h.22a.47.47 0 0 1 .471.47v.14H13.5v-.14A1.47 1.47 0 0 0 12.029 2.5l-.429.177zm-2.853 2.5l.708-.708L11 2.924l1.546 1.545-.707.708L11 4.339l-.838.838-.415-.415zm2.853.308V5h.93v.485a1.47 1.47 0 0 1-1.47 1.47h-.22a1.47 1.47 0 0 1-1.061-.441l-.088-.089.708-.707.088.089a.47.47 0 0 0 .338.14h.22a.47.47 0 0 0 .47-.47V5.5l.085-.015zM4.5 7h8a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5zm-1.5.5A1.5 1.5 0 0 1 4.5 6h8A1.5 1.5 0 0 1 14 7.5v6a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 3 13.5v-6zM2 9H1v4.5A1.5 1.5 0 0 0 2.5 15H7v-1H2.5a.5.5 0 0 1-.5-.5V9z" fill="currentColor"/>'),
};

function createSearchBar() {
  const bar = document.createElement('div');
  bar.id = 'kivi-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <div class="ks-rows">
      <div class="ks-row">
        <button class="ks-toggle-replace ks-icon-btn" id="ks-toggle-replace" title="Toggle Replace">${SEARCH_ICONS.chevronRight}</button>
        <div class="ks-input-wrap">
          <input type="text" id="kivi-search-input" placeholder="Search" />
          <div class="ks-input-actions">
            <button class="ks-option-btn" id="ks-case" title="Match Case">Aa</button>
            <button class="ks-option-btn" id="ks-word" title="Match Whole Word">ab</button>
            <button class="ks-option-btn" id="ks-regex" title="Use Regular Expression">.*</button>
          </div>
        </div>
        <span class="ks-count" id="kivi-search-count"></span>
        <button class="ks-icon-btn" id="kivi-search-prev" title="Previous Match (⇧Enter)">${SEARCH_ICONS.prevMatch}</button>
        <button class="ks-icon-btn" id="kivi-search-next" title="Next Match (Enter)">${SEARCH_ICONS.nextMatch}</button>
        <button class="ks-icon-btn" id="kivi-search-close" title="Close (Escape)">${SEARCH_ICONS.close}</button>
      </div>
      <div class="ks-row ks-replace-row" id="ks-replace-row" style="display:none">
        <div class="ks-spacer"></div>
        <div class="ks-input-wrap">
          <input type="text" id="kivi-replace-input" placeholder="Replace" />
        </div>
        <button class="ks-icon-btn" id="kivi-replace-one" title="Replace">${SEARCH_ICONS.replace}</button>
        <button class="ks-icon-btn" id="kivi-replace-all" title="Replace All">${SEARCH_ICONS.replaceAll}</button>
      </div>
    </div>
  `;
  document.body.insertBefore(bar, document.getElementById('editor'));
  bar.querySelectorAll<HTMLElement>('.ks-icon-btn[title],.ks-option-btn[title]').forEach(addDelayedTooltip);

  const searchInput = bar.querySelector<HTMLInputElement>('#kivi-search-input')!;
  const replaceInput = bar.querySelector<HTMLInputElement>('#kivi-replace-input')!;
  const caseBtn = bar.querySelector<HTMLButtonElement>('#ks-case')!;
  const wordBtn = bar.querySelector<HTMLButtonElement>('#ks-word')!;
  const regexBtn = bar.querySelector<HTMLButtonElement>('#ks-regex')!;
  const countEl = bar.querySelector<HTMLSpanElement>('#kivi-search-count')!;
  const replaceRow = bar.querySelector<HTMLElement>('#ks-replace-row')!;
  const toggleReplaceBtn = bar.querySelector<HTMLButtonElement>('#ks-toggle-replace')!;

  let replaceVisible = false;
  let caseSensitive = false;
  let wholeWord = false;
  let useRegex = false;

  const toggleOption = (btn: HTMLButtonElement, getter: () => boolean, setter: (v: boolean) => void) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      setter(!getter());
      btn.classList.toggle('active', getter());
      doSearch();
      searchInput.focus();
    });
  };
  toggleOption(caseBtn, () => caseSensitive, (v) => { caseSensitive = v; });
  toggleOption(wordBtn, () => wholeWord, (v) => { wholeWord = v; });
  toggleOption(regexBtn, () => useRegex, (v) => { useRegex = v; });

  toggleReplaceBtn.addEventListener('mousedown', (e) => e.preventDefault());
  toggleReplaceBtn.addEventListener('click', () => {
    replaceVisible = !replaceVisible;
    replaceRow.style.display = replaceVisible ? 'flex' : 'none';
    toggleReplaceBtn.innerHTML = replaceVisible ? SEARCH_ICONS.chevronDown : SEARCH_ICONS.chevronRight;
    if (replaceVisible) replaceInput.focus();
    else searchInput.focus();
  });

  const updateSearchCount = () => {
    let total = 0;
    let activeIdx = -1;

    if (viewMode === 'source') {
      const monacoInst = rawMonaco;
      if (monacoInst) {
        total = monacoInst.getSearchMatchCount();
        activeIdx = monacoInst.getSearchActiveIdx();
      }
    } else if (viewMode === 'split') {
      const monacoInst = splitMonaco;
      if (monacoInst) {
        total = monacoInst.getSearchMatchCount();
        activeIdx = monacoInst.getSearchActiveIdx();
      }
    } else if (editor) {
      const info = editor.getSearchInfo();
      total = info.total;
      activeIdx = info.activeIndex;
    }

    if (total > 0) {
      countEl.textContent = `${activeIdx + 1} of ${total}`;
      countEl.classList.remove('ks-no-results');
    } else if (searchInput.value) {
      countEl.textContent = 'No results';
      countEl.classList.add('ks-no-results');
    } else {
      countEl.textContent = '';
      countEl.classList.remove('ks-no-results');
    }
  };

  const doSearch = () => {
    const query = searchInput.value;
    if (!query) {
      editor?.clearSearch();
      if (rawMonaco) rawMonaco.clearSearchHighlights();
      if (splitMonaco) splitMonaco.clearSearchHighlights();
      countEl.textContent = '';
      countEl.classList.remove('ks-no-results');
      return;
    }
    const focused = document.activeElement;

    if (viewMode === 'split') suppressScrollSync();

    if (viewMode === 'live' || viewMode === 'split') {
      editor?.search({ query, caseSensitive, regex: useRegex, wholeWord });
    }

    const monacoInst = viewMode === 'source' ? rawMonaco : viewMode === 'split' ? splitMonaco : null;
    if (monacoInst) {
      monacoInst.setSearchHighlights({ query, caseSensitive, regex: useRegex, wholeWord });
    }

    if (focused && bar.contains(focused)) (focused as HTMLElement).focus();
    requestAnimationFrame(updateSearchCount);
  };

  let _searchDebounce: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener('input', () => {
    if (_searchDebounce) clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(doSearch, 80);
  });

  const nextResult = () => {
    if (viewMode === 'source' && rawMonaco) {
      rawMonaco.nextSearchMatch();
    } else if (viewMode === 'split' && splitMonaco) {
      suppressScrollSync();
      splitMonaco.nextSearchMatch();
      editor?.nextSearchResult();
    } else {
      editor?.nextSearchResult();
    }
    requestAnimationFrame(updateSearchCount);
  };
  const prevResult = () => {
    if (viewMode === 'source' && rawMonaco) {
      rawMonaco.prevSearchMatch();
    } else if (viewMode === 'split' && splitMonaco) {
      suppressScrollSync();
      splitMonaco.prevSearchMatch();
      editor?.previousSearchResult();
    } else {
      editor?.previousSearchResult();
    }
    requestAnimationFrame(updateSearchCount);
  };

  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); nextResult(); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); prevResult(); }
    else if (e.key === 'Escape') { hideSearchBar(); }
  });

  replaceInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doReplace(); }
    else if (e.key === 'Escape') { hideSearchBar(); }
  });

  bar.querySelector('#kivi-search-next')!.addEventListener('click', nextResult);
  bar.querySelector('#kivi-search-prev')!.addEventListener('click', prevResult);
  bar.querySelector('#kivi-search-close')!.addEventListener('click', () => hideSearchBar());

  const doReplace = () => {
    const monacoInst = viewMode === 'source' ? rawMonaco : viewMode === 'split' ? splitMonaco : null;
    if (monacoInst) {
      monacoInst.replaceCurrentMatch(replaceInput.value);
      doSearch();
    } else {
      const tiptap = editor?.getTiptapEditor();
      if (tiptap) (tiptap.commands as Record<string, (...args: unknown[]) => boolean>)['replaceCurrentResult'](replaceInput.value);
    }
    requestAnimationFrame(updateSearchCount);
  };

  bar.querySelector('#kivi-replace-one')!.addEventListener('click', doReplace);
  bar.querySelector('#kivi-replace-all')!.addEventListener('click', () => {
    const monacoInst = viewMode === 'source' ? rawMonaco : viewMode === 'split' ? splitMonaco : null;
    if (monacoInst) {
      monacoInst.replaceAllMatches(replaceInput.value);
      doSearch();
    } else {
      const tiptap = editor?.getTiptapEditor();
      if (tiptap) (tiptap.commands as Record<string, (...args: unknown[]) => boolean>)['replaceAllResults'](replaceInput.value);
    }
    requestAnimationFrame(updateSearchCount);
  });

  // Prevent clicks inside the bar from propagating to the editor
  bar.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault();
  });
}

function showSearchBar(openReplace = false) {
  const bar = document.getElementById('kivi-search-bar');
  if (!bar) return;
  searchBarVisible = true;
  bar.style.display = '';
  if (openReplace) {
    const replaceRow = bar.querySelector<HTMLElement>('#ks-replace-row');
    const toggleBtn = bar.querySelector<HTMLButtonElement>('#ks-toggle-replace');
    if (replaceRow) replaceRow.style.display = 'flex';
    if (toggleBtn) toggleBtn.innerHTML = SEARCH_ICONS.chevronDown;
  }
  const input = bar.querySelector<HTMLInputElement>('#kivi-search-input');
  input?.focus();
  input?.select();
  if (input && input.value) {
    _triggerUnifiedSearch();
  }
  saveState();
}

function hideSearchBar() {
  const bar = document.getElementById('kivi-search-bar');
  if (!bar || !searchBarVisible) return;
  searchBarVisible = false;
  bar.style.display = 'none';
  editor?.clearSearch();
  if (rawMonaco) rawMonaco.clearSearchHighlights();
  if (splitMonaco) splitMonaco.clearSearchHighlights();
  if (viewMode === 'source' && rawMonaco) rawMonaco.focus();
  else editor?.focus();
  saveState();
}

function _triggerUnifiedSearch() {
  const bar = document.getElementById('kivi-search-bar');
  if (!bar) return;
  const searchInput = bar.querySelector<HTMLInputElement>('#kivi-search-input');
  if (!searchInput) return;
  const query = searchInput.value;
  const caseSensitive = bar.querySelector<HTMLButtonElement>('#ks-case')?.classList.contains('active') ?? false;
  const wholeWord = bar.querySelector<HTMLButtonElement>('#ks-word')?.classList.contains('active') ?? false;
  const useRegex = bar.querySelector<HTMLButtonElement>('#ks-regex')?.classList.contains('active') ?? false;

  if (!query) {
    editor?.clearSearch();
    if (rawMonaco) rawMonaco.clearSearchHighlights();
    if (splitMonaco) splitMonaco.clearSearchHighlights();
    return;
  }

  // Drive TipTap search (live editor) in live and split modes
  if (viewMode === 'live' || viewMode === 'split') {
    editor?.search({ query, caseSensitive, regex: useRegex, wholeWord });
  }

  // Drive Monaco search in source and split modes
  const monacoInst = viewMode === 'source' ? rawMonaco : viewMode === 'split' ? splitMonaco : null;
  if (monacoInst) {
    monacoInst.setSearchHighlights({ query, caseSensitive, regex: useRegex, wholeWord });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
