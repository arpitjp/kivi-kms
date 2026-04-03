import { createKiviEditor, KiviEditor, searchPluginKey, setExcalidrawCallbacks } from '@kivi/editor-core';
import { computeKiviFontSize, detectToolbarContext } from '../shared/font.js';
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
let lastSentContent = '';
let savedBaseLines: string[] = [];
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
let currentEditorZoom = 100;
let currentWordWrap = true;
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
interface WorkspaceFile { rel: string; name: string; relToDoc: string }
let cachedWorkspaceFiles: WorkspaceFile[] = [];
let linkInputEl: HTMLElement | null = null;
let linkInputResolve: ((url: string | null) => void) | null = null;

function requestWorkspaceFiles() {
  vscode.postMessage({ type: 'listWorkspaceFiles' });
}

function handleWorkspaceFiles(files: WorkspaceFile[]) {
  cachedWorkspaceFiles = files;
  if (linkInputEl) refreshLinkSuggestions();
}

function showLinkInput(anchorRect: DOMRect, currentUrl?: string): Promise<string | null> {
  closeLinkInput();
  return new Promise((resolve) => {
    linkInputResolve = resolve;

    const container = document.createElement('div');
    container.className = 'kivi-link-input-popup';
    container.addEventListener('mousedown', (e) => e.stopPropagation());

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'kivi-link-input';
    input.placeholder = 'URL, [[wiki-link]], or filename...';
    input.value = currentUrl || '';
    container.appendChild(input);

    const list = document.createElement('ul');
    list.className = 'kivi-link-suggestions';
    container.appendChild(list);

    document.body.appendChild(container);
    linkInputEl = container;

    container.style.left = `${Math.max(8, anchorRect.left)}px`;
    container.style.top = `${anchorRect.bottom + 4}px`;
    const maxRight = window.innerWidth - 8;
    if (anchorRect.left + 320 > maxRight) {
      container.style.left = `${maxRight - 320}px`;
    }

    requestWorkspaceFiles();

    let selectedIdx = -1;

    function getSuggestions(): { label: string; value: string; kind: string }[] {
      const q = input.value.trim().toLowerCase();
      const results: { label: string; value: string; kind: string }[] = [];

      for (const f of cachedWorkspaceFiles) {
        const match = f.name.toLowerCase().includes(q) || f.rel.toLowerCase().includes(q);
        if (!q || match) {
          results.push({ label: f.name, value: `[[${f.name}]]`, kind: 'wiki' });
        }
        if (results.length >= 12) break;
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
          commitLink(suggestions[i].value);
        });
        list.appendChild(li);
      }
    }

    function commitLink(val: string) {
      closeLinkInput();
      linkInputResolve?.(val || null);
      linkInputResolve = null;
    }

    input.addEventListener('input', () => renderSuggestions());
    input.addEventListener('keydown', (e) => {
      const items = list.querySelectorAll('.kivi-link-suggestion-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('selected', i === selectedIdx));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIdx = Math.max(selectedIdx - 1, 0);
        items.forEach((el, i) => el.classList.toggle('selected', i === selectedIdx));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIdx >= 0 && items[selectedIdx]) {
          const suggestions = getSuggestions();
          commitLink(suggestions[selectedIdx].value);
        } else if (input.value.trim()) {
          commitLink(input.value.trim());
        }
      } else if (e.key === 'Escape') {
        closeLinkInput();
        linkInputResolve?.(null);
        linkInputResolve = null;
      }
    });

    const onClickOutside = (ev: MouseEvent) => {
      if (container.contains(ev.target as Node)) return;
      closeLinkInput();
      linkInputResolve?.(null);
      linkInputResolve = null;
      document.removeEventListener('mousedown', onClickOutside, true);
    };
    setTimeout(() => document.addEventListener('mousedown', onClickOutside, true), 50);

    renderSuggestions();
    requestAnimationFrame(() => input.focus());
  });
}

function refreshLinkSuggestions() {
  if (!linkInputEl) return;
  const input = linkInputEl.querySelector<HTMLInputElement>('.kivi-link-input');
  if (input) input.dispatchEvent(new Event('input'));
}

function closeLinkInput() {
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

  // CSS zoom for editor containers (does not affect toolbar)
  const editorZoomPercent = (s.editorZoom > 0) ? s.editorZoom : 100;
  currentEditorZoom = editorZoomPercent;
  const cssZoom = editorZoomPercent / 100;
  for (const id of ['editor', 'kivi-raw-wrapper', 'kivi-split-container']) {
    const el = document.getElementById(id);
    if (el) (el.style as any).zoom = String(cssZoom);
  }

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

  // Word wrap — delegated to applyWordWrap for consistency
  applyWordWrap(wordWrapEnabled);
  const wrapBtn = document.getElementById('kivi-wrap-label');
  if (wrapBtn) wrapBtn.classList.toggle('active', wordWrapEnabled);

  overrideStyleEl.textContent = css;
  customCSSStyleEl.textContent = s.customCSS || '';

  const toolbar = document.getElementById('kivi-toolbar');
  if (toolbar) {
    toolbar.style.display = s.showToolbar ? '' : 'none';
  }

  if (typeof (globalThis as any).__kiviUpdateStickyScrollSettings === 'function') {
    (globalThis as any).__kiviUpdateStickyScrollSettings(
      s.stickyScrollEnabled ?? true,
      s.stickyScrollMaxDepth ?? 5,
    );
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
  // Escape first so no raw HTML tags are ever interpreted by the browser,
  // then colorize markdown tokens inside the already-safe string.
  const safe = esc(text);
  return safe.replace(
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(~~[^~]+~~)|(\[\[[^\]]+\]\])|(\[[^\]]*\]\([^)]*\))|(!\[[^\]]*\]\([^)]*\))|(#[a-zA-Z][\w/-]*)|(https?:\/\/\S+)/g,
    (match, code, bold1, bold2, italic1, italic2, strike, wikiLink, mdLink, image, tag, url) => {
      if (code) return `<span class="md-inline-code">${match}</span>`;
      if (bold1 || bold2) return `<span class="md-bold">${match}</span>`;
      if (italic1 || italic2) return `<span class="md-italic">${match}</span>`;
      if (strike) return `<span class="md-strike">${match}</span>`;
      if (wikiLink) return `<span class="md-wiki-link">${match}</span>`;
      if (mdLink) return `<span class="md-link">${match}</span>`;
      if (image) return `<span class="md-image">${match}</span>`;
      if (tag) return `<span class="md-tag">${match}</span>`;
      if (url) return `<span class="md-url">${match}</span>`;
      return match;
    },
  );
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let _highlightFrame: ReturnType<typeof requestAnimationFrame> | null = null;
let _pendingHighlights: Set<HTMLTextAreaElement> = new Set();

const HIGHLIGHT_SIZE_LIMIT = 100 * 1024; // skip syntax highlighting above 100KB

function syncHighlight(textarea: HTMLTextAreaElement) {
  _pendingHighlights.add(textarea);
  if (!_highlightFrame) {
    _highlightFrame = requestAnimationFrame(() => {
      _highlightFrame = null;
      const pending = _pendingHighlights;
      _pendingHighlights = new Set();
      for (const ta of pending) {
        const backdrop = ta.parentElement?.querySelector('.kivi-raw-backdrop') as HTMLPreElement | null;
        if (!backdrop) continue;
        if (ta.value.length > HIGHLIGHT_SIZE_LIMIT) {
          backdrop.textContent = ta.value + '\n';
        } else {
          backdrop.innerHTML = highlightMarkdown(ta.value) + '\n';
        }
      }
    });
  }
}

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
  const brand = document.createElement('span');
  brand.className = 'kivi-toolbar-brand';
  brand.innerHTML = `<svg class="kivi-brand-icon" width="16" height="16" viewBox="63 46 913 901" fill="currentColor"><path d="M618.3,816.5C580.5,830.7,541.8,838.3,501.7,837C452.2,835.5,405.7,822.5,362.1,799.5C304.6,769.2,257.9,726.9,222.7,672.1C205.8,645.7,196.4,616.3,192.6,585.1C186.3,533.4,196,484.1,214.5,436.1C237,377.4,272.1,326.9,317.3,283.5C368,234.9,426.6,199.4,494.7,180.3C527.2,171.1,560.2,166.7,593.9,168.9C651.6,172.8,700.1,195.5,738,240.1C770,277.7,796.4,318.6,813.8,365C825.5,396.2,833,428.2,836.4,461.4C841.7,511.7,836.1,560.7,819.5,608.4C804.3,652,781.1,691.1,750.3,725.5C718.1,761.4,680,789.2,636.2,809.1C630.5,811.7,624.5,813.9,618.3,816.5M716.8,281.7C700.4,249.3,674.2,228,640.6,215.5C604.6,202.1,567.6,201.4,530.3,207.7C486.8,215.1,447.2,232.4,410.1,255.9C366.5,283.5,329.1,318.1,298.2,359.6C261.6,408.8,237.1,463.1,230,524.6C226.7,553.2,228.4,581.4,236.4,609.1C249,651.9,274.4,683.8,315.7,702.1C347.9,716.3,381.7,718.2,416.1,714.3C445.9,710.9,474.4,702.1,501.5,689.5C585.2,650.7,649.5,590.7,695.1,510.8C722.2,463.2,737.5,412.2,735.6,356.8C734.8,330.7,729,305.8,716.8,281.7z"/><path d="M443.2,539.3C417.9,537.2,403.2,521.4,402.6,496.4C402.1,477.3,408.2,460.1,418,444.1C435.6,415.2,459.5,393.5,491.8,382.1C503.4,378.1,515.3,376.5,527.6,378.5C556.3,383.2,565.3,407.9,562.9,428.3C559.1,460.2,542.2,485,519,506.1C503.5,520.3,486,531.4,465.4,536.7C458.2,538.5,451.1,539.7,443.2,539.3z"/><path d="M348.4,612.9C344.4,609.5,344.9,605.2,345.9,601.5C352.1,579.5,365,563.3,387.6,556.5C398.2,553.3,403.8,558.8,401.4,569.6C398.1,584.8,388.5,595.6,376.1,604.1C369.9,608.4,363.5,612.2,356,613.7C353.4,614.2,351.1,614.3,348.4,612.9z"/><path d="M365,473.7C376.2,479.6,377,486.4,368,494.8C354.9,507.1,325.8,510.8,310.2,502.2C302.5,497.9,301.5,492,307.7,485.7C318.5,474.6,345.6,464.7,365,473.7z"/><path d="M641.1,408.6C645.7,409.3,649.7,410.3,653.5,412.1C662,416.2,663.3,423,656.5,429.5C646.1,439.5,633.2,444.1,619.1,445.3C611.8,445.9,604.5,445.3,597.8,441.6C589.6,437,588.2,429.9,594.9,423.3C607.7,410.9,623.3,406.8,641.1,408.6z"/><path d="M465.5,576.8C467.3,572.5,469.1,568.9,472.2,565.9C478,560.1,484.2,560.3,489.1,567C496.6,577.4,498.3,589.3,497,601.6C496,610.1,493.6,618.2,488.7,625.4C482.3,634.8,474.8,634.7,469.2,624.7C460.6,609.4,459.4,593.6,465.5,576.8z"/><path d="M483.1,285.8C488.8,284,492.1,286.9,494.7,290.9C503.3,303.9,505.3,318.2,501.6,333.3C500.2,339,498.1,344.4,494.4,349.1C488.4,356.6,480.3,356.5,475.1,348.4C466.6,335.1,466.1,320.6,470.4,305.7C472.6,298,475.2,290.5,483.1,285.8z"/><path d="M569.2,332.3C579,317.9,591.5,307.6,608.3,303.5C615.8,301.7,620.3,306,618.6,313.5C613.7,335.7,600,350.5,579.3,359.2C577.1,360.1,574.8,360.4,572.4,360.4C565.7,360.3,562.1,356.3,562.8,349.4C563.5,343.3,566,337.8,569.2,332.3z"/><path d="M361.6,374C359.4,364,363.1,359.1,372.5,359.8C387.9,360.9,411,372.3,415.7,394.1C417.9,404.4,413.3,410.8,402.8,410.2C387.2,409.4,375.8,401.2,367.7,388.1C365,383.9,363,379.3,361.6,374z"/><path d="M550.9,525.8C550.4,524.3,550,523.2,549.7,522.1C547,511.9,551.7,505.5,562.2,505C581.7,504,604.6,526.1,604.3,545.5C604.2,551.7,601.7,554.2,595.5,554.4C576.8,555.1,559.2,543.9,550.9,525.8z"/></svg><span class="kivi-brand-text">Kivi</span>`;
  brand.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.querySelector('.kivi-brand-menu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'kivi-brand-menu';

    const svgI = (d: string) =>
      `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

    const items: { icon: string; label: string; action: () => void }[] = [
      {
        icon: svgI('<circle cx="8" cy="8" r="6"/><line x1="8" y1="5" x2="8" y2="8"/><circle cx="8" cy="11" r="0.5" fill="currentColor"/>'),
        label: 'About Kivi',
        action: () => vscode.postMessage({ type: 'openExternal', url: 'https://github.com/nicholasgriffintn/kivi' }),
      },
      {
        icon: svgI('<path d="M9 2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6L9 2z"/><polyline points="9,2 9,6 13,6"/>'),
        label: 'Documentation',
        action: () => vscode.postMessage({ type: 'openExternal', url: 'https://github.com/nicholasgriffintn/kivi#readme' }),
      },
      {
        icon: svgI('<circle cx="8" cy="8" r="6"/><path d="M6 6.5a2 2 0 1 1 2 2v1"/><circle cx="8" cy="12" r="0.5" fill="currentColor"/>'),
        label: 'Report Issue',
        action: () => vscode.postMessage({ type: 'openExternal', url: 'https://github.com/nicholasgriffintn/kivi/issues/new' }),
      },
      {
        icon: svgI('<path d="M8 1C4.13 1 1 4.13 1 8s3.13 7 7 7 7-3.13 7-7-3.13-7-7-7z"/><path d="M5.5 6.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 1.5-2.5 3"/><circle cx="8" cy="12.5" r="0.5" fill="currentColor"/>'),
        label: 'Keyboard Shortcuts',
        action: () => vscode.postMessage({ type: 'command', command: 'workbench.action.openGlobalKeybindings', args: ['kivi'] }),
      },
    ];

    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'kivi-brand-menu-item';
      row.innerHTML = `${it.icon}<span>${it.label}</span>`;
      row.addEventListener('click', (ev) => { ev.stopPropagation(); it.action(); menu.remove(); });
      menu.appendChild(row);
    }

    const sep = document.createElement('div');
    sep.className = 'kivi-brand-menu-sep';
    menu.appendChild(sep);

    const hint = document.createElement('div');
    hint.className = 'kivi-brand-menu-hint';
    hint.textContent = 'Kivi — Markdown knowledge base';
    menu.appendChild(hint);

    brand.appendChild(menu);

    const dismiss = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node) && ev.target !== brand) {
        menu.remove();
        document.removeEventListener('click', dismiss, true);
      }
    };
    requestAnimationFrame(() => document.addEventListener('click', dismiss, true));
  });
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

  // --- Raw source editor (with syntax highlight backdrop + line gutter) ---
  const rawWrapper = document.createElement('div');
  rawWrapper.id = 'kivi-raw-wrapper';
  rawWrapper.style.display = 'none';

  const rawGutter = document.createElement('div');
  rawGutter.id = 'kivi-source-gutter';
  rawGutter.className = 'kivi-raw-gutter';
  rawWrapper.appendChild(rawGutter);

  const rawContainer = document.createElement('div');
  rawContainer.className = 'kivi-raw-container';

  const rawBackdrop = document.createElement('pre');
  rawBackdrop.className = 'kivi-raw-backdrop';
  rawContainer.appendChild(rawBackdrop);

  const rawEl = document.createElement('textarea');
  rawEl.id = 'kivi-raw-editor';
  rawEl.spellcheck = false;
  rawContainer.appendChild(rawEl);

  rawWrapper.appendChild(rawContainer);

  editorEl.parentElement!.insertBefore(rawWrapper, splitContainer.nextSibling);

  let rawScrollFrame: ReturnType<typeof requestAnimationFrame> | null = null;
  rawEl.addEventListener('scroll', () => {
    if (!rawScrollFrame) {
      rawScrollFrame = requestAnimationFrame(() => {
        rawScrollFrame = null;
        rawBackdrop.scrollTop = rawEl.scrollTop;
        rawBackdrop.scrollLeft = rawEl.scrollLeft;
        rawGutter.scrollTop = rawEl.scrollTop;
        if (viewMode === 'source') detectActiveHeadingRaw(rawEl);
      });
    }
  }, { passive: true });

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
    promptInput: (message, placeholder) => requestInput(message, placeholder),
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
    fileStorageAdapter: {
      async store(blob: Blob, filename: string): Promise<string> {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const storeId = `${filename}-${Date.now()}`;
            vscode.postMessage({ type: 'storeFile', data: dataUrl, name: filename, storeId });

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
        return false; // Assume not available until we hear back
      }
      return _hasExcalidrawExtension;
    },
  });

  // Handle "Open in Excalidraw" from image controls for .excalidraw.png/.svg
  document.addEventListener('kivi-open-excalidraw', ((e: CustomEvent<{ src: string }>) => {
    vscode.postMessage({ type: 'openExcalidraw', src: e.detail.src });
  }) as EventListener);

  // Load content asynchronously to avoid blocking first paint
  if (initialMarkdown) {
    lastSentContent = initialMarkdown;
    savedBaseLines = initialMarkdown.split('\n');
    rawEl.value = initialMarkdown;

    // Eagerly load KaTeX CSS only if content has math markers
    if (/\$\$|\\\[|\\begin\{/.test(initialMarkdown)) ensureKatexCss();

    perfMark('async-load-start');
    editor.loadMarkdownAsync(initialMarkdown).then(() => {
      perfLog('async-load-done', 'async-load-start');
      const skeleton = document.getElementById('kivi-skeleton');
      if (skeleton) skeleton.remove();
      rewriteRelativeImages();
      editor!.focus('start');
      // Restore view mode after content is loaded so split/source has content
      if (viewMode !== 'live') doSetViewMode(viewMode, false);
    });
  } else {
    const skeleton = document.getElementById('kivi-skeleton');
    if (skeleton) skeleton.remove();
    if (viewMode !== 'live') doSetViewMode(viewMode, false);
  }

  if (searchBarVisible) {
    const bar = document.getElementById('kivi-search-bar');
    if (bar) bar.style.display = 'flex';
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
    const coords = tiptap.view.coordsAtPos(from);
    const rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
    const result = await showLinkInput(rect, currentUrl);
    if (!result) {
      tiptap.chain().focus().setTextSelection({ from, to }).run();
      return;
    }

    if (editMode) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tiptap.chain().focus().extendMarkRange('link').setLink({ href: result }) as any).run();
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = tiptap.chain().focus().setTextSelection({ from, to }) as any;
    const selectedText = tiptap.state.doc.textBetween(from, to, ' ');
    if (selectedText) {
      chain.setLink({ href: result }).run();
    } else {
      chain.insertContent({ type: 'text', text: result, marks: [{ type: 'link', attrs: { href: result } }] }).run();
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

    let bestHeading = '';
    let bestTop = -Infinity;
    const allHeadings: { text: string; level: number; relTop: number; offset: number }[] = [];

    tiptapEd.state.doc.forEach((node: any, offset: number) => {
      if (node.type.name === 'heading') {
        const dom = view.nodeDOM(offset) as HTMLElement | null;
        if (!dom) return;
        const rect = dom.getBoundingClientRect();
        const relTop = rect.top - parentRect.top + scrollTop;
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

  function detectActiveHeadingRaw(textarea: HTMLTextAreaElement) {
    const text = textarea.value;
    const lines = text.split('\n');
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    const visibleLine = Math.floor(textarea.scrollTop / lineHeight);

    let bestHeading = '';
    let inCodeBlock = false;
    for (let i = 0; i <= Math.min(visibleLine + 2, lines.length - 1); i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
      if (inCodeBlock) continue;
      const m = /^#{1,6}\s+(.+)$/.exec(line);
      if (m) bestHeading = m[1].trim();
    }

    if (bestHeading && bestHeading !== _lastActiveHeading) {
      _lastActiveHeading = bestHeading;
      vscode.postMessage({ type: 'activeHeading', heading: bestHeading });
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

  // Sync raw -> extension host
  let rawDebounce: ReturnType<typeof setTimeout> | null = null;
  const hookRawInput = (el: HTMLTextAreaElement) => {
    el.addEventListener('input', () => {
      // Highlight + gutter update immediately (already rAF-throttled internally)
      syncHighlight(el);
      const sourceGutter = document.getElementById('kivi-source-gutter');
      if (sourceGutter) updateLineNumbers(el, sourceGutter);

      // Debounce the expensive extension-host sync and split-mode live reload
      if (rawDebounce) clearTimeout(rawDebounce);
      rawDebounce = setTimeout(() => {
        const content = el.value;
        if (content === lastSentContent) return;
        lastSentContent = content;
        vscode.postMessage({ type: 'edit', content });
        if (viewMode === 'split' && editor) {
          isUpdatingFromExtension = true;
          editor.loadMarkdown(content);
          isUpdatingFromExtension = false;
        }
      }, 150);
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
        if (msg.docBaseUrl) {
          docBaseUrl = msg.docBaseUrl;
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
          const splitGutter = document.getElementById('kivi-split-gutter');
          const splitRawEl = document.getElementById('kivi-split-raw') as HTMLTextAreaElement | null;
          if (splitGutter && splitRawEl) updateLineNumbers(splitRawEl, splitGutter);
          const sourceGutter = document.getElementById('kivi-source-gutter');
          const sourceRawEl = document.getElementById('kivi-raw-editor') as HTMLTextAreaElement | null;
          if (sourceGutter && sourceRawEl) updateLineNumbers(sourceRawEl, sourceGutter);
          for (const rid of ['kivi-raw-editor', 'kivi-split-raw']) {
            const rel = document.getElementById(rid) as HTMLTextAreaElement | null;
            if (rel) syncHighlight(rel);
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
        }
        break;

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
        }
        break;
      }

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
        if (editor && (msg.heading || msg.line)) {
          const tiptapEd = editor.getTiptapEditor();
          const { doc } = tiptapEd.state;
          let foundOffset = -1;
          const target = String(msg.heading || '').trim().toLowerCase();

          doc.forEach((node, offset) => {
            if (foundOffset >= 0) return;
            if (node.type.name === 'heading') {
              const nodeText = node.textContent.trim().toLowerCase();
              if (nodeText === target) {
                foundOffset = offset;
              }
            }
          });

          if (foundOffset >= 0) {
            tiptapEd.commands.setTextSelection(foundOffset + 1);
            tiptapEd.commands.scrollIntoView();
            requestAnimationFrame(() => {
              const domNode = tiptapEd.view.nodeDOM(foundOffset) as HTMLElement | null;
              if (domNode) {
                domNode.classList.add('kivi-heading-highlight');
                setTimeout(() => domNode.classList.remove('kivi-heading-highlight'), 2000);
              }
            });
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

  perfLog('init-total', 'init-start');
  vscode.postMessage({ type: 'ready' });

  requestAnimationFrame(() => {
    perfLog('first-paint', 'init-start');
  });
}

// ── Relative image rewriting ──

function isRelativeUrl(url: string): boolean {
  if (!url) return false;
  if (/^(https?|data|vscode-webview|vscode-resource):/.test(url)) return false;
  if (url.startsWith('//')) return false;
  return true;
}

function rewriteRelativeImages() {
  if (!docBaseUrl) return;
  const editorEl = document.getElementById('editor');
  if (!editorEl) return;
  for (const img of editorEl.querySelectorAll<HTMLImageElement>('img')) {
    const src = img.getAttribute('src') || '';
    if (isRelativeUrl(src)) {
      const resolved = docBaseUrl + src.replace(/^\.\//, '');
      if (img.src !== resolved) {
        img.src = resolved;
      }
    }
  }
}

// Watch for dynamically added/updated images (ProseMirror re-renders nodes)
let _imgRewriteFrame: ReturnType<typeof requestAnimationFrame> | null = null;
const _imgObserver = new MutationObserver((mutations) => {
  if (!docBaseUrl) return;

  let needsRewrite = false;
  for (const m of mutations) {
    // Attribute change on an img element
    if (m.type === 'attributes' && m.target instanceof HTMLImageElement) {
      const src = m.target.getAttribute('src') || '';
      if (isRelativeUrl(src)) {
        const resolved = docBaseUrl + src.replace(/^\.\//, '');
        if (m.target.src !== resolved) {
          m.target.src = resolved;
        }
      }
      continue;
    }
    // New nodes added
    for (const node of m.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      const imgs = node.tagName === 'IMG' ? [node as HTMLImageElement] : node.querySelectorAll<HTMLImageElement>('img');
      for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        if (isRelativeUrl(src)) {
          img.src = docBaseUrl + src.replace(/^\.\//, '');
        }
      }
      if (imgs.length > 0) needsRewrite = true;
    }
  }

  // ProseMirror may batch DOM updates; schedule a full sweep after paint
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
  const brand = document.querySelector('.kivi-toolbar-brand');
  if (brand) {
    const textEl = brand.querySelector('.kivi-brand-text');
    if (textEl) textEl.textContent = 'Kivi';
    (brand as HTMLElement).title = filePath || 'Kivi';
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

function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  while (el) {
    if (el.scrollHeight > el.clientHeight + 1) return el;
    el = el.parentElement;
  }
  return null;
}

let scrollSyncCleanup: (() => void) | null = null;

function setupScrollSync(splitRaw: HTMLTextAreaElement) {
  if (scrollSyncCleanup) { scrollSyncCleanup(); scrollSyncCleanup = null; }

  const tiptapEd = editor?.getTiptapEditor();
  if (!tiptapEd) return;

  const editorEl = document.getElementById('editor');
  if (!editorEl) return;

  const scrollEl = editorEl;
  let syncSource: 'live' | 'raw' | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSyncLock() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncSource = null; }, 50);
  }

  // Vertical-only ratio sync: maps percentage of scroll range.
  // Horizontal scroll is independent since the two panes render
  // completely different content widths (monospace raw vs rich HTML).
  const syncLiveToRaw = () => {
    if (syncSource === 'raw') return;
    syncSource = 'live';
    const maxY = scrollEl.scrollHeight - scrollEl.clientHeight;
    const ratioY = maxY > 0 ? scrollEl.scrollTop / maxY : 0;
    splitRaw.scrollTop = ratioY * (splitRaw.scrollHeight - splitRaw.clientHeight);
    clearSyncLock();
  };

  const syncRawToLive = () => {
    if (syncSource === 'live') return;
    syncSource = 'raw';
    const maxRawY = splitRaw.scrollHeight - splitRaw.clientHeight;
    const ratioY = maxRawY > 0 ? splitRaw.scrollTop / maxRawY : 0;
    scrollEl.scrollTop = ratioY * (scrollEl.scrollHeight - scrollEl.clientHeight);
    clearSyncLock();
  };

  editorEl.addEventListener('scroll', syncLiveToRaw, { passive: true });

  const splitLeft = editorEl.closest('.kivi-split-left');
  if (splitLeft && splitLeft !== editorEl) {
    splitLeft.addEventListener('scroll', syncLiveToRaw, { passive: true });
  }

  const pmEl = editorEl.querySelector('.ProseMirror');
  if (pmEl) {
    pmEl.addEventListener('scroll', syncLiveToRaw, { passive: true });
  }

  splitRaw.addEventListener('scroll', syncRawToLive, { passive: true });

  scrollSyncCleanup = () => {
    editorEl.removeEventListener('scroll', syncLiveToRaw);
    if (splitLeft) splitLeft.removeEventListener('scroll', syncLiveToRaw);
    if (pmEl) pmEl.removeEventListener('scroll', syncLiveToRaw);
    splitRaw.removeEventListener('scroll', syncRawToLive);
    if (syncTimer) clearTimeout(syncTimer);
  };
}

function doSetViewMode(mode: 'live' | 'source' | 'split', persist = true) {
  saveCurrentPosition();

  viewMode = mode;
  if (persist) vscode.postMessage({ type: 'persistSetting', key: 'viewMode', value: mode });
  const editorEl = document.getElementById('editor');
  const rawEl = document.getElementById('kivi-raw-editor') as HTMLTextAreaElement | null;
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
  splitContainer.innerHTML = '';

  if (mode === 'source') {
    if (editor && rawEl) {
      rawEl.value = editor.getMarkdown();
      syncHighlight(rawEl);
    }
    editorEl.style.display = 'none';
    rawWrapper.style.display = 'flex';
    splitContainer.style.display = 'none';
    const sourceGutter = document.getElementById('kivi-source-gutter');
    if (rawEl && sourceGutter) updateLineNumbers(rawEl, sourceGutter);
    restorePosition('source');
    rawEl?.focus();
  } else if (mode === 'split') {
    // Sync raw editor content to live editor if coming from source mode
    const comingFromSource = rawWrapper.style.display !== 'none';
    if (comingFromSource && editor && rawEl?.value) {
      editor.loadMarkdown(rawEl.value);
      lastSentContent = rawEl.value;
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
      // Highlight + gutter immediately (visual responsiveness)
      updateLineNumbers(splitRaw, lineNumberGutter);
      syncHighlight(splitRaw);

      // Debounce expensive sync
      if (splitDebounce) clearTimeout(splitDebounce);
      splitDebounce = setTimeout(() => {
        const content = splitRaw.value;
        if (content === lastSentContent) return;
        lastSentContent = content;
        isUpdatingFromExtension = true;
        editor?.loadMarkdown(content);
        isUpdatingFromExtension = false;
        vscode.postMessage({ type: 'edit', content });
      }, 150);
    });

    let splitRawScrollFrame: ReturnType<typeof requestAnimationFrame> | null = null;
    splitRaw.addEventListener('scroll', () => {
      if (!splitRawScrollFrame) {
        splitRawScrollFrame = requestAnimationFrame(() => {
          splitRawScrollFrame = null;
          lineNumberGutter.scrollTop = splitRaw.scrollTop;
          splitBackdrop.scrollTop = splitRaw.scrollTop;
          splitBackdrop.scrollLeft = splitRaw.scrollLeft;
        });
      }
    }, { passive: true });

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
    // Only reload from raw editor if coming from source mode (not split).
    // In split mode the live editor was the left pane and is already current.
    const comingFromSource = rawWrapper.style.display !== 'none';
    if (comingFromSource && rawEl?.value && rawEl.value !== lastSentContent) {
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
      // Lines that replace existing base lines are 'modified' (blue),
      // extra lines beyond the replacement count are 'added' (green)
      const modCount = Math.min(deletedCount, insertedCount);
      for (let i = 0; i < modCount; i++) marks[h.newStart + i] = 'm';
      for (let i = modCount; i < insertedCount; i++) marks[h.newStart + i] = 'a';
    } else if (insertedCount > 0) {
      for (let i = h.newStart; i < h.newEnd; i++) marks[i] = 'a';
    }
    // Pure deletions: show red triangle indicator on the line before
    if (deletedCount > 0 && insertedCount === 0) {
      const markerLine = h.newStart > 0 ? h.newStart - 1 : 0;
      if (marks[markerLine] === 'u') marks[markerLine] = 'd';
    }
  }

  return { marks, hunks };
}

function refreshAllGutters() {
  const sourceGutter = document.getElementById('kivi-source-gutter');
  const sourceRaw = document.getElementById('kivi-raw-editor') as HTMLTextAreaElement | null;
  if (sourceGutter && sourceRaw) updateLineNumbers(sourceRaw, sourceGutter);
  const splitGutter = document.getElementById('kivi-split-gutter');
  const splitRaw = document.getElementById('kivi-split-raw') as HTMLTextAreaElement | null;
  if (splitGutter && splitRaw) updateLineNumbers(splitRaw, splitGutter);
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
  popup.style.top = `${anchorRect.bottom - wrapperRect.top + wrapper.scrollTop + 2}px`;
  popup.style.left = `${Math.max(0, anchorRect.left - wrapperRect.left)}px`;
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

function _updateLineNumbersImmediate(textarea: HTMLTextAreaElement, gutter: HTMLElement) {
  const currentLines = textarea.value.split('\n');
  const lineCount = currentLines.length;
  const info = computeGutterInfo(savedBaseLines, currentLines);
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
      const blameInfo = blameByLine.get(i);
      const prevBlame = i > 0 ? blameByLine.get(i - 1) : null;
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

  const revertBtn = document.createElement('button');
  revertBtn.title = 'Revert Change';
  revertBtn.className = 'kivi-diff-action-btn';
  revertBtn.innerHTML = codiconSvg('<path d="M12.75 8a4.5 4.5 0 0 1-8.61 1.834l-1.391.565A6.001 6.001 0 0 0 14.25 8 6 6 0 0 0 3.5 4.334V2.5H2v4h4v-1.5H3.92A4.5 4.5 0 0 1 12.75 8z"/>');
  revertBtn.addEventListener('click', () => {
    const lines = textarea.value.split('\n');
    const baseChunk = savedBaseLines.slice(baseStart, baseEnd);
    lines.splice(hunk.newStart, hunk.newEnd - hunk.newStart, ...baseChunk);
    textarea.value = lines.join('\n');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
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
  addDelayedTooltip(prevBtn);
  addDelayedTooltip(nextBtn);
  addDelayedTooltip(closeBtn);
  toolbar.append(label, changeCount, spacer, revertBtn, prevBtn, nextBtn, closeBtn);
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
      popup.style.top = `${lineRect.bottom - wrapperRect.top + (wrapper as HTMLElement).scrollTop}px`;
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

  // Wrapper that holds the context-sensitive format buttons
  const formatGroup = document.createElement('div');
  formatGroup.id = 'kivi-toolbar-format';
  el.appendChild(formatGroup);

  type ToolbarAction = { id: string; svg?: string; title?: string; cmd?: (...args: any[]) => void; active?: () => boolean };

  const textActions: ToolbarAction[] = [
    { id: 'bold', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5h4.5a3 3 0 0 1 2.12 5.12A3.25 3.25 0 0 1 9 13.5H4V2.5zM4 8h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`, title: 'Bold (⌘B)', cmd: () => cmd().toggleBold().run(), active: () => tiptap.isActive('bold') },
    { id: 'italic', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="10" y1="2.5" x2="6" y2="13.5"/><line x1="7.5" y1="2.5" x2="11.5" y2="2.5"/><line x1="4.5" y1="13.5" x2="8.5" y2="13.5"/></svg>`, title: 'Italic (⌘I)', cmd: () => cmd().toggleItalic().run(), active: () => tiptap.isActive('italic') },
    { id: 'strike', svg: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="8" x2="14" y2="8" stroke-width="1.5"/><path d="M10.2 4.8C9.7 3.6 8.6 3 7.5 3 5.8 3 4.5 4 4.5 5.5c0 1 .5 1.7 1.3 2.2" stroke-width="1.6" fill="none"/><path d="M5.8 11.2c.5 1.2 1.6 1.8 2.7 1.8 1.7 0 3-1 3-2.5 0-.7-.3-1.3-.8-1.7" stroke-width="1.6" fill="none"/></svg>`, title: 'Strikethrough (⌘⇧X)', cmd: () => cmd().toggleStrike().run(), active: () => tiptap.isActive('strike') },
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
      btn.addEventListener('click', (e) => { e.preventDefault(); action.cmd?.(undefined, btn); });
      addDelayedTooltip(btn);
      formatGroup.appendChild(btn);
    }
  }

  let currentContext: 'text' | 'image' = 'text';
  renderActions(textActions);

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
      const buttons = formatGroup.querySelectorAll<HTMLButtonElement>('.kivi-toolbar-btn');
      let i = 0;
      for (const action of textActions) {
        if (action.id === 'sep') continue;
        const btn = buttons[i++];
        if (btn && action.active) btn.classList.toggle('active', action.active());
      }
    }
  };
  tiptap.on('selectionUpdate', update);
  tiptap.on('update', update);

  // ── Right-aligned controls ──
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  el.appendChild(spacer);

  // ── Word Wrap toggle ──
  appendWordWrapToggle(el);
  appendSep(el);

  // ── Zoom controls ──
  appendZoomControls(el);
  appendSep(el);

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
  addDelayedTooltip(revealBtn);
  el.appendChild(revealBtn);
  appendSep(el);

  const hideBtn = document.createElement('button');
  hideBtn.className = 'kivi-toolbar-btn kivi-hide-toolbar-btn';
  hideBtn.title = 'Hide Toolbar';
  hideBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,10 8,6 12,10"/></svg>`;
  hideBtn.addEventListener('click', () => setToolbarVisible(false));
  addDelayedTooltip(hideBtn);
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
  addDelayedTooltip(showBtn);
  bar.appendChild(showBtn);

  document.body.appendChild(bar);
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
    { label: 'Fold Section', shortcut: '⌘⇧[', action: () => { (editor?.getTiptapEditor() as any)?.commands?.foldAtCursor?.(); } },
    { label: 'Unfold Section', shortcut: '⌘⇧]', action: () => { (editor?.getTiptapEditor() as any)?.commands?.unfoldAtCursor?.(); } },
    { label: 'Fold All', action: () => { (editor?.getTiptapEditor() as any)?.commands?.foldAll?.(); } },
    { label: 'Unfold All', action: () => { (editor?.getTiptapEditor() as any)?.commands?.unfoldAll?.(); } },
    { divider: true, label: '' },
    { label: 'Find in File', shortcut: '⌘F', action: () => toggleSearchBar() },
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
      { label: 'Find in File', shortcut: '⌘F', action: () => toggleSearchBar() },
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
      { label: 'Find in File', shortcut: '⌘F', action: () => toggleSearchBar() },
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
      const rawItems: MenuItem[] = [
        { label: 'Cut', shortcut: '⌘X', action: () => document.execCommand('cut') },
        { label: 'Copy', shortcut: '⌘C', action: () => document.execCommand('copy') },
        { label: 'Paste', shortcut: '⌘V', action: () => document.execCommand('paste') },
        { divider: true, label: '' },
        { label: 'Select All', shortcut: '⌘A', action: () => document.execCommand('selectAll') },
        { divider: true, label: '' },
        { label: blameEnabled ? 'Hide Git Blame' : 'Show Git Blame', action: () => toggleBlame() },
        { divider: true, label: '' },
        { label: 'Find in File', shortcut: '⌘F', action: () => toggleSearchBar() },
        { label: 'Reveal in Explorer', shortcut: '⌘⇧E', action: () => vscode.postMessage({ type: 'revealInExplorer' }) },
      ];
      renderMenu(rawItems);
    }

    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.display = 'block';
    menu.style.visibility = 'hidden';

    const rect = menu.getBoundingClientRect();
    const x = Math.min(e.clientX, window.innerWidth - rect.width - 4);
    const y = Math.min(e.clientY, window.innerHeight - rect.height - 4);
    menu.style.left = `${Math.max(0, x)}px`;
    menu.style.top = `${Math.max(0, y)}px`;
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

  if (!anchorRect) {
    const coords = tiptap.view.coordsAtPos(from);
    anchorRect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
  }

  const result = await showLinkInput(anchorRect);
  if (!result) {
    tiptap.chain().focus().setTextSelection({ from, to }).run();
    return;
  }

  // Wiki-link: [[target]] or [[target|alias]]
  const wikiMatch = result.match(/^\[\[(.+?)(?:\|(.+?))?\]\]$/);
  if (wikiMatch) {
    const target = wikiMatch[1];
    const alias = wikiMatch[2] || selectedText || target;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = tiptap.chain().focus().setTextSelection({ from, to }) as any;
    if (selectedText) {
      chain.setLink({ href: result }).run();
    } else {
      chain.insertContent({ type: 'text', text: alias, marks: [{ type: 'link', attrs: { href: result } }] }).run();
    }
    return;
  }

  // Regular URL
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = tiptap.chain().focus().setTextSelection({ from, to }) as any;
  if (selectedText) {
    chain.setLink({ href: result }).run();
  } else {
    chain.insertContent({ type: 'text', text: result, marks: [{ type: 'link', attrs: { href: result } }] }).run();
  }
}

function setToolbarVisible(visible: boolean, persist = true) {
  const toolbar = document.getElementById('kivi-toolbar');
  const floatingBar = document.getElementById('kivi-floating-bar');
  if (toolbar) toolbar.style.display = visible ? '' : 'none';
  if (floatingBar) floatingBar.style.display = visible ? 'none' : 'flex';
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
      const rect = btn.getBoundingClientRect();
      tip.style.left = `${rect.left + rect.width / 2}px`;
      tip.style.top = `${rect.bottom + 6}px`;
      tip.style.transform = 'translateX(-50%)';
      tip.classList.add('visible');
    }, TOOLTIP_DELAY);
  });

  btn.addEventListener('mouseleave', () => {
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
    const tip = ensureTooltipEl();
    tip.classList.remove('visible');
  });
}

// ─── Shared control builders ───

function appendWordWrapToggle(parent: HTMLElement) {
  const wrapIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="4" x2="14" y2="4"/><path d="M2 8h9.5a2.5 2.5 0 0 1 0 5H10"/><polyline points="11,11.5 10,13 9,11.5"/><line x1="2" y1="12" x2="6" y2="12"/></svg>';
  const btn = document.createElement('button');
  btn.className = 'kivi-toolbar-btn';
  btn.id = 'kivi-wrap-label';
  btn.title = 'Toggle Word Wrap';
  btn.innerHTML = wrapIcon;
  if (currentWordWrap) btn.classList.add('active');
  btn.addEventListener('click', () => {
    currentWordWrap = !currentWordWrap;
    btn.classList.toggle('active', currentWordWrap);
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

  for (const id of ['kivi-raw-editor', 'kivi-split-raw']) {
    const el = document.getElementById(id) as HTMLTextAreaElement | null;
    if (el) {
      el.style.whiteSpace = enabled ? 'pre-wrap' : 'pre';
      el.style.overflowX = enabled ? 'hidden' : 'auto';
    }
  }

  for (const bd of document.querySelectorAll<HTMLPreElement>('.kivi-raw-backdrop')) {
    bd.style.whiteSpace = enabled ? 'pre-wrap' : 'pre';
  }

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
  for (const id of ['editor', 'kivi-raw-wrapper', 'kivi-split-container']) {
    const el = document.getElementById(id);
    if (el) (el.style as any).zoom = String(cssZoom);
  }

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
  bar.querySelectorAll<HTMLElement>('button[title]').forEach(addDelayedTooltip);

  const searchInput = bar.querySelector<HTMLInputElement>('#kivi-search-input')!;
  const replaceInput = bar.querySelector<HTMLInputElement>('#kivi-replace-input')!;
  const caseCheck = bar.querySelector<HTMLInputElement>('#kivi-search-case')!;
  const regexCheck = bar.querySelector<HTMLInputElement>('#kivi-search-regex')!;
  const wordCheck = bar.querySelector<HTMLInputElement>('#kivi-search-word')!;

  const countEl = bar.querySelector<HTMLSpanElement>('#kivi-search-count')!;

  let rawSearchMatches: { start: number; end: number }[] = [];
  let rawSearchIndex = -1;

  const getVisibleRawTextarea = (): HTMLTextAreaElement | null => {
    if (viewMode === 'source') return document.getElementById('kivi-raw-editor') as HTMLTextAreaElement | null;
    if (viewMode === 'split') return document.getElementById('kivi-split-raw') as HTMLTextAreaElement | null;
    return null;
  };

  const findRawMatches = (query: string, caseSensitive: boolean, regex: boolean, wholeWord: boolean): { start: number; end: number }[] => {
    const raw = getVisibleRawTextarea();
    if (!raw) return [];
    const text = raw.value;
    const matches: { start: number; end: number }[] = [];
    try {
      let flags = 'g' + (caseSensitive ? '' : 'i');
      let pattern: string;
      if (regex) {
        pattern = query;
      } else {
        pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      if (wholeWord) pattern = `\\b${pattern}\\b`;
      const re = new RegExp(pattern, flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++;
      }
    } catch { /* invalid regex */ }
    return matches;
  };

  const highlightRawMatch = (index: number) => {
    const raw = getVisibleRawTextarea();
    if (!raw || index < 0 || index >= rawSearchMatches.length) return;
    const m = rawSearchMatches[index];
    raw.focus();
    raw.setSelectionRange(m.start, m.end);
    const linesBefore = raw.value.slice(0, m.start).split('\n').length - 1;
    const lineHeight = parseInt(getComputedStyle(raw).lineHeight) || 20;
    raw.scrollTop = Math.max(0, linesBefore * lineHeight - raw.clientHeight / 3);
  };

  const updateSearchCount = () => {
    if (!editor) return;
    if (viewMode === 'source' || viewMode === 'split') {
      if (rawSearchMatches.length > 0) {
        countEl.textContent = `${rawSearchIndex + 1} of ${rawSearchMatches.length}`;
      } else if (searchInput.value) {
        countEl.textContent = 'No results';
      } else {
        countEl.textContent = '';
      }
      return;
    }
    const tiptap = editor.getTiptapEditor();
    const searchState = searchPluginKey.getState(tiptap.state) as { results: { from: number; to: number }[]; activeIndex: number } | undefined;
    if (searchState && searchState.results.length > 0) {
      countEl.textContent = `${searchState.activeIndex + 1} of ${searchState.results.length}`;
    } else if (searchInput.value) {
      countEl.textContent = 'No results';
    } else {
      countEl.textContent = '';
    }
  };

  const doSearch = () => {
    if (!editor) return;
    const query = searchInput.value;
    if (!query) {
      editor.clearSearch();
      rawSearchMatches = [];
      rawSearchIndex = -1;
      countEl.textContent = '';
      return;
    }
    editor.search({ query, caseSensitive: caseCheck.checked, regex: regexCheck.checked, wholeWord: wordCheck.checked });
    rawSearchMatches = findRawMatches(query, caseCheck.checked, regexCheck.checked, wordCheck.checked);
    if (rawSearchMatches.length > 0) {
      rawSearchIndex = 0;
      if (viewMode === 'source' || viewMode === 'split') highlightRawMatch(0);
    } else {
      rawSearchIndex = -1;
    }
    requestAnimationFrame(updateSearchCount);
  };

  searchInput.addEventListener('input', doSearch);
  caseCheck.addEventListener('change', doSearch);
  regexCheck.addEventListener('change', doSearch);
  wordCheck.addEventListener('change', doSearch);
  const nextResult = () => {
    if ((viewMode === 'source' || viewMode === 'split') && rawSearchMatches.length > 0) {
      rawSearchIndex = (rawSearchIndex + 1) % rawSearchMatches.length;
      highlightRawMatch(rawSearchIndex);
    } else {
      editor?.nextSearchResult();
    }
    requestAnimationFrame(updateSearchCount);
  };
  const prevResult = () => {
    if ((viewMode === 'source' || viewMode === 'split') && rawSearchMatches.length > 0) {
      rawSearchIndex = (rawSearchIndex - 1 + rawSearchMatches.length) % rawSearchMatches.length;
      highlightRawMatch(rawSearchIndex);
    } else {
      editor?.previousSearchResult();
    }
    requestAnimationFrame(updateSearchCount);
  };

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); nextResult(); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); prevResult(); }
    else if (e.key === 'Escape') { toggleSearchBar(); }
  });

  bar.querySelector('#kivi-search-next')!.addEventListener('click', nextResult);
  bar.querySelector('#kivi-search-prev')!.addEventListener('click', prevResult);
  bar.querySelector('#kivi-search-close')!.addEventListener('click', () => toggleSearchBar());
  bar.querySelector('#kivi-replace-one')!.addEventListener('click', () => {
    if ((viewMode === 'source' || viewMode === 'split') && rawSearchMatches.length > 0 && rawSearchIndex >= 0) {
      const raw = getVisibleRawTextarea();
      if (raw) {
        const m = rawSearchMatches[rawSearchIndex];
        const before = raw.value.slice(0, m.start);
        const after = raw.value.slice(m.end);
        raw.value = before + replaceInput.value + after;
        raw.dispatchEvent(new Event('input', { bubbles: true }));
        doSearch();
      }
    } else {
      const tiptap = editor?.getTiptapEditor();
      if (tiptap) (tiptap.commands as Record<string, (...args: unknown[]) => boolean>)['replaceCurrentResult'](replaceInput.value);
    }
    requestAnimationFrame(updateSearchCount);
  });
  bar.querySelector('#kivi-replace-all')!.addEventListener('click', () => {
    if ((viewMode === 'source' || viewMode === 'split') && rawSearchMatches.length > 0) {
      const raw = getVisibleRawTextarea();
      if (raw) {
        let text = raw.value;
        for (let i = rawSearchMatches.length - 1; i >= 0; i--) {
          const m = rawSearchMatches[i];
          text = text.slice(0, m.start) + replaceInput.value + text.slice(m.end);
        }
        raw.value = text;
        raw.dispatchEvent(new Event('input', { bubbles: true }));
        doSearch();
      }
    } else {
      const tiptap = editor?.getTiptapEditor();
      if (tiptap) (tiptap.commands as Record<string, (...args: unknown[]) => boolean>)['replaceAllResults'](replaceInput.value);
    }
    requestAnimationFrame(updateSearchCount);
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
