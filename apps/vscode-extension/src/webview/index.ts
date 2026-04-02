import { createKiviEditor, KiviEditor, searchPluginKey } from '@kivi/editor-core';
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
  zoom: number;
  vscodeEditorFontSize: number;
  vscodeEditorFontFamily: string;
  vscodeEditorLineHeight: number;
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
let savedBaseLines: string[] = [];
let overrideStyleEl: HTMLStyleElement | null = null;
let customCSSStyleEl: HTMLStyleElement | null = null;
let viewMode: 'live' | 'source' | 'split' = 'live';
let filePath = '';
let fileName = '';
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

  const hasKiviFontSize = s.fontSize && s.fontSize > 0;
  const zoomFactor = (s.zoom && s.zoom > 0) ? s.zoom / 100 : 1;

  // Live editor font: Kivi override > VS Code editor font > VS Code UI font
  const liveFont = s.fontFamily || '';
  // Mono font for raw/source from VS Code editor.fontFamily (forwarded from host)
  const monoFont = s.vscodeEditorFontFamily || '';

  const wordWrapEnabled = s.vscodeEditorWordWrap !== 'off';

  // Always resolve the effective font size so it matches the VS Code editor.
  // Uses kivi override if set, otherwise the VS Code editor.fontSize (forwarded
  // from the host, already the user's configured value). The kivi zoom setting
  // is applied on top. VS Code's window.zoomLevel is handled by the webview
  // container itself (CSS transform on the iframe).
  const baseFontSize = hasKiviFontSize ? s.fontSize : (s.vscodeEditorFontSize || 14);
  const effectiveFontSize = Math.round(baseFontSize * zoomFactor);

  const props: string[] = [];
  props.push(`--kivi-font-size: ${effectiveFontSize}px;`);
  if (s.editorBackground) props.push(`--kivi-editor-bg: ${s.editorBackground};`);
  if (s.codeBlockBackground) props.push(`--kivi-codeblock-bg: ${s.codeBlockBackground};`);
  if (s.accentColor) props.push(`--kivi-accent: ${s.accentColor};`);
  if (s.textColor) props.push(`--kivi-text: ${s.textColor};`);
  if (s.headingColor) props.push(`--kivi-heading-color: ${s.headingColor};`);
  if (monoFont) props.push(`--kivi-mono-font: ${monoFont};`);
  if (s.lineHeight && s.lineHeight > 0) props.push(`--kivi-line-height: ${s.lineHeight};`);

  let css = `:root { ${props.join(' ')} }\n`;

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

  // Raw editors + backdrops: word-wrap setting only (font handled by CSS variables)
  for (const id of ['kivi-raw-editor', 'kivi-split-raw']) {
    const el = document.getElementById(id) as HTMLTextAreaElement | null;
    if (el) {
      el.style.whiteSpace = wordWrapEnabled ? 'pre-wrap' : 'pre';
      el.style.overflowX = wordWrapEnabled ? 'hidden' : 'auto';
    }
  }

  for (const bd of document.querySelectorAll<HTMLPreElement>('.kivi-raw-backdrop')) {
    bd.style.whiteSpace = wordWrapEnabled ? 'pre-wrap' : 'pre';
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
  brand.innerHTML = `<svg class="kivi-brand-icon" width="16" height="16" viewBox="63 46 913 901" fill="currentColor"><path d="M618.3,816.5C580.5,830.7,541.8,838.3,501.7,837C452.2,835.5,405.7,822.5,362.1,799.5C304.6,769.2,257.9,726.9,222.7,672.1C205.8,645.7,196.4,616.3,192.6,585.1C186.3,533.4,196,484.1,214.5,436.1C237,377.4,272.1,326.9,317.3,283.5C368,234.9,426.6,199.4,494.7,180.3C527.2,171.1,560.2,166.7,593.9,168.9C651.6,172.8,700.1,195.5,738,240.1C770,277.7,796.4,318.6,813.8,365C825.5,396.2,833,428.2,836.4,461.4C841.7,511.7,836.1,560.7,819.5,608.4C804.3,652,781.1,691.1,750.3,725.5C718.1,761.4,680,789.2,636.2,809.1C630.5,811.7,624.5,813.9,618.3,816.5M716.8,281.7C700.4,249.3,674.2,228,640.6,215.5C604.6,202.1,567.6,201.4,530.3,207.7C486.8,215.1,447.2,232.4,410.1,255.9C366.5,283.5,329.1,318.1,298.2,359.6C261.6,408.8,237.1,463.1,230,524.6C226.7,553.2,228.4,581.4,236.4,609.1C249,651.9,274.4,683.8,315.7,702.1C347.9,716.3,381.7,718.2,416.1,714.3C445.9,710.9,474.4,702.1,501.5,689.5C585.2,650.7,649.5,590.7,695.1,510.8C722.2,463.2,737.5,412.2,735.6,356.8C734.8,330.7,729,305.8,716.8,281.7z"/><path d="M443.2,539.3C417.9,537.2,403.2,521.4,402.6,496.4C402.1,477.3,408.2,460.1,418,444.1C435.6,415.2,459.5,393.5,491.8,382.1C503.4,378.1,515.3,376.5,527.6,378.5C556.3,383.2,565.3,407.9,562.9,428.3C559.1,460.2,542.2,485,519,506.1C503.5,520.3,486,531.4,465.4,536.7C458.2,538.5,451.1,539.7,443.2,539.3z"/><path d="M348.4,612.9C344.4,609.5,344.9,605.2,345.9,601.5C352.1,579.5,365,563.3,387.6,556.5C398.2,553.3,403.8,558.8,401.4,569.6C398.1,584.8,388.5,595.6,376.1,604.1C369.9,608.4,363.5,612.2,356,613.7C353.4,614.2,351.1,614.3,348.4,612.9z"/><path d="M365,473.7C376.2,479.6,377,486.4,368,494.8C354.9,507.1,325.8,510.8,310.2,502.2C302.5,497.9,301.5,492,307.7,485.7C318.5,474.6,345.6,464.7,365,473.7z"/><path d="M641.1,408.6C645.7,409.3,649.7,410.3,653.5,412.1C662,416.2,663.3,423,656.5,429.5C646.1,439.5,633.2,444.1,619.1,445.3C611.8,445.9,604.5,445.3,597.8,441.6C589.6,437,588.2,429.9,594.9,423.3C607.7,410.9,623.3,406.8,641.1,408.6z"/><path d="M465.5,576.8C467.3,572.5,469.1,568.9,472.2,565.9C478,560.1,484.2,560.3,489.1,567C496.6,577.4,498.3,589.3,497,601.6C496,610.1,493.6,618.2,488.7,625.4C482.3,634.8,474.8,634.7,469.2,624.7C460.6,609.4,459.4,593.6,465.5,576.8z"/><path d="M483.1,285.8C488.8,284,492.1,286.9,494.7,290.9C503.3,303.9,505.3,318.2,501.6,333.3C500.2,339,498.1,344.4,494.4,349.1C488.4,356.6,480.3,356.5,475.1,348.4C466.6,335.1,466.1,320.6,470.4,305.7C472.6,298,475.2,290.5,483.1,285.8z"/><path d="M569.2,332.3C579,317.9,591.5,307.6,608.3,303.5C615.8,301.7,620.3,306,618.6,313.5C613.7,335.7,600,350.5,579.3,359.2C577.1,360.1,574.8,360.4,572.4,360.4C565.7,360.3,562.1,356.3,562.8,349.4C563.5,343.3,566,337.8,569.2,332.3z"/><path d="M361.6,374C359.4,364,363.1,359.1,372.5,359.8C387.9,360.9,411,372.3,415.7,394.1C417.9,404.4,413.3,410.8,402.8,410.2C387.2,409.4,375.8,401.2,367.7,388.1C365,383.9,363,379.3,361.6,374z"/><path d="M550.9,525.8C550.4,524.3,550,523.2,549.7,522.1C547,511.9,551.7,505.5,562.2,505C581.7,504,604.6,526.1,604.3,545.5C604.2,551.7,601.7,554.2,595.5,554.4C576.8,555.1,559.2,543.9,550.9,525.8z"/></svg><span class="kivi-brand-text">kivi</span>`;
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

  rawEl.addEventListener('scroll', () => {
    rawBackdrop.scrollTop = rawEl.scrollTop;
    rawBackdrop.scrollLeft = rawEl.scrollLeft;
    rawGutter.scrollTop = rawEl.scrollTop;
  });

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
      const name = prompt('New page name:');
      if (name) vscode.postMessage({ type: 'createChildPage', name });
    },
    tagSuggestion: {
      items: (query: string) => {
        const q = query.toLowerCase();
        return workspaceTags.filter(t => t.toLowerCase().startsWith(q));
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
  });

  perfLog('editor-created', 'editor-create-start');

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
        const sourceGutter = document.getElementById('kivi-source-gutter');
        if (sourceGutter) updateLineNumbers(el, sourceGutter);
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
        if (editor && msg.heading) {
          const tiptapEd = editor.getTiptapEditor();
          const { doc } = tiptapEd.state;
          let found = false;
          const normalizeHeading = (s: string) =>
            s.replace(/`([^`]*)`/g, '$1').trim().toLowerCase();
          const target = normalizeHeading(String(msg.heading));
          doc.forEach((node, offset) => {
            if (found) return;
            if (node.type.name === 'heading') {
              const nodeText = node.textContent.trim().toLowerCase();
              if (nodeText === target) {
                tiptapEd.commands.setTextSelection(offset + 1);
                tiptapEd.commands.scrollIntoView();
                found = true;

                // Brief highlight effect on the heading
                requestAnimationFrame(() => {
                  const domNode = tiptapEd.view.nodeDOM(offset) as HTMLElement | null;
                  if (domNode) {
                    domNode.classList.add('kivi-heading-highlight');
                    setTimeout(() => domNode.classList.remove('kivi-heading-highlight'), 2000);
                  }
                });
              }
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

// ── Breadcrumb ──

function updateBreadcrumb() {
  const brand = document.querySelector('.kivi-toolbar-brand');
  if (brand) {
    const textEl = brand.querySelector('.kivi-brand-text');
    if (textEl) textEl.textContent = 'kivi';
    (brand as HTMLElement).title = filePath || 'kivi';
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

  // The scroll container is #editor itself (overflow-y: auto).
  // Also listen on its ProseMirror child in case a future CSS change shifts
  // the scrollable to the inner element, and on the split-left wrapper.
  const scrollEl = editorEl;

  const syncLiveToRaw = () => {
    if (splitScrollSyncLock) return;
    splitScrollSyncLock = true;
    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
    const ratio = maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 0;
    splitRaw.scrollTop = ratio * (splitRaw.scrollHeight - splitRaw.clientHeight);
    requestAnimationFrame(() => { splitScrollSyncLock = false; });
  };

  const syncRawToLive = () => {
    if (splitScrollSyncLock) return;
    splitScrollSyncLock = true;
    const maxRaw = splitRaw.scrollHeight - splitRaw.clientHeight;
    const ratio = maxRaw > 0 ? splitRaw.scrollTop / maxRaw : 0;
    scrollEl.scrollTop = ratio * (scrollEl.scrollHeight - scrollEl.clientHeight);
    requestAnimationFrame(() => { splitScrollSyncLock = false; });
  };

  // Listen on #editor and its parent wrapper (scroll event doesn't bubble,
  // so we cover both possible scroll containers)
  editorEl.addEventListener('scroll', syncLiveToRaw, { passive: true });

  const splitLeft = editorEl.closest('.kivi-split-left');
  if (splitLeft && splitLeft !== editorEl) {
    splitLeft.addEventListener('scroll', syncLiveToRaw, { passive: true });
  }

  // Also listen on the ProseMirror element itself
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

function computeLineDiff(baseLines: string[], currentLines: string[]): ('u' | 'a' | 'm')[] {
  const n = currentLines.length;
  const m = baseLines.length;
  if (m === 0) return new Array(n).fill('a');
  if (n === 0) return [];

  const baseSet = new Set<string>();
  for (const l of baseLines) baseSet.add(l);

  const lcsMatch = new Set<number>();
  let bi = 0;
  for (let ci = 0; ci < n && bi < m; ci++) {
    if (currentLines[ci] === baseLines[bi]) {
      lcsMatch.add(ci);
      bi++;
    } else {
      let found = false;
      for (let look = 1; look <= 10 && bi + look < m; look++) {
        if (currentLines[ci] === baseLines[bi + look]) {
          lcsMatch.add(ci);
          bi = bi + look + 1;
          found = true;
          break;
        }
      }
      if (!found) {
        for (let look = 1; look <= 3 && ci + look < n; look++) {
          if (currentLines[ci + look] === baseLines[bi]) {
            break;
          }
        }
      }
    }
  }

  const result: ('u' | 'a' | 'm')[] = new Array(n).fill('a');
  bi = 0;
  for (let ci = 0; ci < n; ci++) {
    if (lcsMatch.has(ci)) {
      result[ci] = 'u';
    } else if (baseSet.has(currentLines[ci])) {
      result[ci] = 'm';
    } else {
      result[ci] = bi < m ? 'm' : 'a';
    }
    if (bi < m && (currentLines[ci] === baseLines[bi])) bi++;
  }

  return result;
}

function refreshAllGutters() {
  const sourceGutter = document.getElementById('kivi-source-gutter');
  const sourceRaw = document.getElementById('kivi-raw-editor') as HTMLTextAreaElement | null;
  if (sourceGutter && sourceRaw) updateLineNumbers(sourceRaw, sourceGutter);
  const splitGutter = document.getElementById('kivi-split-gutter');
  const splitRaw = document.getElementById('kivi-split-raw') as HTMLTextAreaElement | null;
  if (splitGutter && splitRaw) updateLineNumbers(splitRaw, splitGutter);
}

function updateLineNumbers(textarea: HTMLTextAreaElement, gutter: HTMLElement) {
  const currentLines = textarea.value.split('\n');
  const lineCount = currentLines.length;
  const diff = computeLineDiff(savedBaseLines, currentLines);

  gutter.innerHTML = '';
  for (let i = 0; i < lineCount; i++) {
    const div = document.createElement('div');
    div.className = 'gutter-line';
    div.textContent = `${i + 1}`;
    if (diff[i] === 'a') {
      div.classList.add('gutter-added');
    } else if (diff[i] === 'm') {
      div.classList.add('gutter-modified');
    }
    if (diff[i] !== 'u') {
      div.addEventListener('click', () => showDiffPopup(textarea, gutter, i, diff));
    }
    gutter.appendChild(div);
  }
}

// ── Diff popup (inline change preview) ──

interface Hunk {
  start: number;
  end: number; // exclusive
}

function getHunks(diff: ('u' | 'a' | 'm')[]): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < diff.length) {
    if (diff[i] !== 'u') {
      const start = i;
      while (i < diff.length && diff[i] !== 'u') i++;
      hunks.push({ start, end: i });
    } else {
      i++;
    }
  }
  return hunks;
}

function findHunkForLine(hunks: Hunk[], line: number): number {
  return hunks.findIndex(h => line >= h.start && line < h.end);
}

function findCorrespondingBaseRange(hunk: Hunk, currentLines: string[], baseLines: string[]): { baseStart: number; baseEnd: number } {
  // Find the base line range by matching context before/after the hunk
  let baseStart = 0;
  let matchesBefore = 0;
  for (let ci = 0; ci < hunk.start; ci++) {
    if (baseStart < baseLines.length && currentLines[ci] === baseLines[baseStart]) {
      baseStart++;
      matchesBefore++;
    }
  }
  const contextBefore = matchesBefore;

  // Find base end by matching after the hunk
  let afterCurrent = hunk.end;
  let baseEnd = baseStart;
  let afterBase = baseStart;
  while (afterCurrent < currentLines.length && afterBase < baseLines.length) {
    if (currentLines[afterCurrent] === baseLines[afterBase]) {
      break;
    }
    afterBase++;
  }
  baseEnd = afterBase;

  // If we couldn't find a good range, estimate based on context line count
  if (baseEnd < baseStart) baseEnd = baseStart;
  if (baseEnd > baseLines.length) baseEnd = baseLines.length;

  return { baseStart: Math.max(0, baseStart - (contextBefore > 0 ? 0 : 0)), baseEnd };
}

let activeDiffPopup: HTMLElement | null = null;

function closeDiffPopup() {
  if (activeDiffPopup) {
    activeDiffPopup.remove();
    activeDiffPopup = null;
  }
}

function showDiffPopup(textarea: HTMLTextAreaElement, gutter: HTMLElement, lineIndex: number, diff: ('u' | 'a' | 'm')[]) {
  closeDiffPopup();

  const currentLines = textarea.value.split('\n');
  const hunks = getHunks(diff);
  const hunkIdx = findHunkForLine(hunks, lineIndex);
  if (hunkIdx < 0) return;

  const hunk = hunks[hunkIdx];
  const { baseStart, baseEnd } = findCorrespondingBaseRange(hunk, currentLines, savedBaseLines);

  const popup = document.createElement('div');
  popup.className = 'kivi-diff-popup';
  activeDiffPopup = popup;

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'kivi-diff-toolbar';

  const revertBtn = document.createElement('button');
  revertBtn.title = 'Revert Change';
  revertBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1,4 1,10 7,10"/><path d="M3.51 6.03a7 7 0 1 1 .54 7.18"/></svg> Revert`;
  revertBtn.addEventListener('click', () => {
    const lines = textarea.value.split('\n');
    const baseChunk = savedBaseLines.slice(baseStart, baseEnd);
    lines.splice(hunk.start, hunk.end - hunk.start, ...baseChunk);
    textarea.value = lines.join('\n');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    closeDiffPopup();
  });

  const label = document.createElement('span');
  label.className = 'kivi-diff-label';
  label.textContent = `Change ${hunkIdx + 1} of ${hunks.length}`;

  const spacer = document.createElement('span');
  spacer.className = 'kivi-diff-spacer';

  const prevBtn = document.createElement('button');
  prevBtn.title = 'Previous Change';
  prevBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="12,10 8,6 4,10"/></svg>`;
  prevBtn.disabled = hunkIdx === 0;
  prevBtn.addEventListener('click', () => {
    if (hunkIdx > 0) {
      const newDiff = computeLineDiff(savedBaseLines, textarea.value.split('\n'));
      const newHunks = getHunks(newDiff);
      if (hunkIdx - 1 < newHunks.length) {
        showDiffPopup(textarea, gutter, newHunks[hunkIdx - 1].start, newDiff);
      }
    }
  });

  const nextBtn = document.createElement('button');
  nextBtn.title = 'Next Change';
  nextBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,6 8,10 12,6"/></svg>`;
  nextBtn.disabled = hunkIdx >= hunks.length - 1;
  nextBtn.addEventListener('click', () => {
    if (hunkIdx < hunks.length - 1) {
      const newDiff = computeLineDiff(savedBaseLines, textarea.value.split('\n'));
      const newHunks = getHunks(newDiff);
      if (hunkIdx + 1 < newHunks.length) {
        showDiffPopup(textarea, gutter, newHunks[hunkIdx + 1].start, newDiff);
      }
    }
  });

  const closeBtn = document.createElement('button');
  closeBtn.title = 'Close';
  closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
  closeBtn.addEventListener('click', closeDiffPopup);

  toolbar.append(revertBtn, label, spacer, prevBtn, nextBtn, closeBtn);
  popup.appendChild(toolbar);

  // Diff content
  const content = document.createElement('div');
  content.className = 'kivi-diff-content';

  const removedLines = savedBaseLines.slice(baseStart, baseEnd);
  const addedLines = currentLines.slice(hunk.start, hunk.end);

  // Context before (up to 2 lines)
  const ctxBeforeStart = Math.max(0, baseStart - 2);
  for (let i = ctxBeforeStart; i < baseStart; i++) {
    const line = document.createElement('div');
    line.className = 'kivi-diff-line kivi-diff-line-context';
    line.textContent = savedBaseLines[i];
    content.appendChild(line);
  }

  for (const l of removedLines) {
    const line = document.createElement('div');
    line.className = 'kivi-diff-line kivi-diff-line-removed';
    line.textContent = l;
    content.appendChild(line);
  }

  for (const l of addedLines) {
    const line = document.createElement('div');
    line.className = 'kivi-diff-line kivi-diff-line-added';
    line.textContent = l;
    content.appendChild(line);
  }

  // Context after (up to 2 lines)
  for (let i = baseEnd; i < Math.min(savedBaseLines.length, baseEnd + 2); i++) {
    const line = document.createElement('div');
    line.className = 'kivi-diff-line kivi-diff-line-context';
    line.textContent = savedBaseLines[i];
    content.appendChild(line);
  }

  popup.appendChild(content);

  // Position: place inside the raw wrapper, below the clicked line
  const wrapper = textarea.closest('#kivi-raw-wrapper') || textarea.closest('.kivi-split-right');
  if (wrapper) {
    (wrapper as HTMLElement).style.position = 'relative';
    const lineEl = gutter.children[lineIndex] as HTMLElement | undefined;
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

  const actions = [
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
    btn.addEventListener('click', (e) => { e.preventDefault(); action.cmd?.(undefined, btn); });
    addDelayedTooltip(btn);
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
