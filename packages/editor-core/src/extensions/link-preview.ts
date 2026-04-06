import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { positionFixedPopup } from '../zoom.js';

// ── Types ──────────────────────────────────────────────────

export type LinkKind =
  | 'wiki-link'
  | 'markdown-link'
  | 'tag'
  | 'heading-ref'
  | 'block-ref'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'code-file'
  | 'external-url'
  | 'unresolved'
  | 'footnote'
  | 'unknown';

export interface DetectedLink {
  kind: LinkKind;
  target: string;
  alias?: string;
  /** Position range in the document (ProseMirror positions) */
  from: number;
  to: number;
  /** The DOM element that was hovered */
  element: HTMLElement;
}

export interface LinkPreviewData {
  kind: LinkKind;
  target: string;
  /** Short title for the preview header */
  title: string;
  /** Human-readable description or content snippet */
  snippet?: string;
  /** Tags associated with the target */
  tags?: string[];
  /** ISO date string or relative time */
  modified?: string;
  /** Number of backlinks */
  backlinkCount?: number;
  /** Heading list for note previews */
  headings?: { level: number; text: string }[];
  /** Image/media URL for thumbnail preview */
  thumbnailUrl?: string;
  /** For external URLs: domain */
  domain?: string;
  /** For tags: count of notes using this tag */
  noteCount?: number;
  /** Example note titles (for tag preview) */
  exampleNotes?: string[];
  /** For code files: detected language */
  language?: string;
  /** Whether the target exists */
  exists: boolean;
  /** File size in bytes (optional) */
  fileSize?: number;
  /** Favicon URL for external sites */
  favicon?: string;
  /** OG type (article, video, etc.) */
  ogType?: string;
}

export type LinkResolver = (link: DetectedLink) => Promise<LinkPreviewData | null>;
export type LinkNavigator = (link: DetectedLink) => void;

export interface LinkPreviewOptions {
  /** Resolve a link to preview data. Called on hover after debounce. */
  onResolveLink?: LinkResolver;
  /** Navigate to a link target. Called on Cmd/Ctrl+click. */
  onNavigate?: LinkNavigator;
  /** Delay before showing preview (ms). Default: 350 */
  hoverDelay?: number;
  /** Delay for Cmd/Ctrl+hover (ms). Default: 80 */
  modifierHoverDelay?: number;
  /** Max cached entries. Default: 64 */
  cacheSize?: number;
}

const linkPreviewKey = new PluginKey('kiviLinkPreview');

// ── LRU Cache ──────────────────────────────────────────────

class LRUCache<V> {
  private map = new Map<string, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }
}

// ── Asset extensions ───────────────────────────────────────

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?)$/i;
const VIDEO_EXTS = /\.(mp4|webm|mov|avi|mkv)$/i;
const AUDIO_EXTS = /\.(mp3|ogg|wav|flac|aac|m4a)$/i;
const PDF_EXTS = /\.pdf$/i;
const CODE_EXTS = /\.(ts|tsx|js|jsx|py|rb|rs|go|java|c|cpp|h|hpp|cs|swift|kt|sh|bash|zsh|json|yaml|yml|toml|xml|html|css|scss|sql|md)$/i;

function classifyHref(href: string): LinkKind {
  if (!href) return 'unknown';
  if (href.startsWith('http://') || href.startsWith('https://')) return 'external-url';
  if (href.startsWith('#')) return 'heading-ref';
  if (IMAGE_EXTS.test(href)) return 'image';
  if (VIDEO_EXTS.test(href)) return 'video';
  if (AUDIO_EXTS.test(href)) return 'audio';
  if (PDF_EXTS.test(href)) return 'pdf';
  if (CODE_EXTS.test(href)) return 'code-file';
  return 'markdown-link';
}

// ── Link Detection ─────────────────────────────────────────

function detectLinkAtPos(view: EditorView, domEvent: MouseEvent): DetectedLink | null {
  const target = domEvent.target as HTMLElement;
  if (!target) return null;

  // Don't detect links inside code blocks
  if (target.closest('.kivi-code-block, pre, code')) return null;

  // Wiki link: <a class="kivi-wiki-link" data-wiki-target="...">
  const wikiEl = target.closest('a.kivi-wiki-link') as HTMLElement;
  if (wikiEl) {
    const wikiTarget = wikiEl.getAttribute('data-wiki-target');
    if (wikiTarget) {
      const pos = view.posAtDOM(wikiEl, 0);
      const resolved = view.state.doc.resolve(pos);
      const marks = resolved.marks();
      const wikiMark = marks.find(m => m.type.name === 'wikiLink');
      return {
        kind: 'wiki-link',
        target: wikiTarget,
        alias: wikiMark?.attrs.alias || undefined,
        from: pos,
        to: pos + (wikiEl.textContent?.length || 0),
        element: wikiEl,
      };
    }
  }

  // Hashtag: <span class="kivi-hashtag" data-tag="...">
  const tagEl = target.closest('span.kivi-hashtag') as HTMLElement;
  if (tagEl) {
    const tag = tagEl.getAttribute('data-tag');
    if (tag) {
      const pos = view.posAtDOM(tagEl, 0);
      const textLen = tagEl.textContent?.length || 0;
      return {
        kind: 'tag',
        target: tag,
        from: pos,
        to: pos + textLen,
        element: tagEl,
      };
    }
  }

  // Standard markdown link: <a class="kivi-link" href="...">
  const linkEl = target.closest('a.kivi-link') as HTMLElement;
  if (linkEl) {
    const href = linkEl.getAttribute('href');
    if (href) {
      const pos = view.posAtDOM(linkEl, 0);
      return {
        kind: classifyHref(href),
        target: href,
        from: pos,
        to: pos + (linkEl.textContent?.length || 0),
        element: linkEl,
      };
    }
  }

  // Footnote reference: <sup> elements typically
  const footnoteEl = target.closest('.kivi-footnote-ref') as HTMLElement;
  if (footnoteEl) {
    const label = footnoteEl.textContent?.replace(/[\[\]]/g, '') || '';
    const pos = view.posAtDOM(footnoteEl, 0);
    return {
      kind: 'footnote',
      target: label,
      from: pos,
      to: pos + 1,
      element: footnoteEl,
    };
  }

  return null;
}

// ── Tooltip Rendering ──────────────────────────────────────

function createTooltipElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'kivi-link-preview';
  el.setAttribute('role', 'tooltip');
  return el;
}

function renderPreviewContent(data: LinkPreviewData): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';

  // Header with kind badge
  const kindBadge = data.kind !== 'wiki-link' && data.kind !== 'markdown-link'
    ? `<span class="klp-badge klp-badge-${data.kind}">${esc(data.kind)}</span>` : '';

  if (!data.exists) {
    html += `<div class="klp-header"><span class="klp-title klp-unresolved">${esc(data.title)}</span>${kindBadge}</div>`;
    html += '<div class="klp-missing">Target does not exist</div>';
    return html;
  }

  // ── Rich card for external URLs with OG metadata ──
  if (data.kind === 'external-url' && (data.thumbnailUrl || data.snippet)) {
    if (data.thumbnailUrl) {
      html += `<div class="klp-og-thumb"><img src="${esc(data.thumbnailUrl)}" alt="" loading="lazy" /></div>`;
    }
    html += '<div class="klp-og-body">';
    // Site identity line: favicon + siteName/domain
    const siteLine = data.domain || '';
    if (siteLine) {
      const faviconHtml = data.favicon
        ? `<img class="klp-og-favicon" src="${esc(data.favicon)}" alt="" width="14" height="14" loading="lazy" onerror="this.style.display='none'" />`
        : '';
      html += `<div class="klp-og-site">${faviconHtml}<span>${esc(siteLine)}</span></div>`;
    }
    html += `<div class="klp-og-title">${esc(data.title)}</div>`;
    if (data.snippet) {
      html += `<div class="klp-og-desc">${esc(data.snippet)}</div>`;
    }
    html += '</div>';
    html += '<div class="klp-hint">⌘+Hover to preview · Click to open</div>';
    return html;
  }

  // Thumbnail for images
  if (data.thumbnailUrl && data.kind === 'image') {
    html += `<div class="klp-thumb"><img src="${esc(data.thumbnailUrl)}" alt="${esc(data.title)}" /></div>`;
  }

  html += `<div class="klp-header"><span class="klp-title">${esc(data.title)}</span>${kindBadge}</div>`;

  // Tags
  if (data.tags && data.tags.length > 0) {
    html += `<div class="klp-tags">${data.tags.map(t => `<span class="klp-tag">#${esc(t)}</span>`).join('')}</div>`;
  }

  // Stats row
  const stats: string[] = [];
  if (data.backlinkCount && data.backlinkCount > 0) stats.push(`${data.backlinkCount} backlinks`);
  if (data.noteCount && data.noteCount > 0) stats.push(`${data.noteCount} notes`);
  if (data.modified) stats.push(data.modified);
  if (data.language) stats.push(data.language);
  if (data.domain) stats.push(data.domain);
  if (data.fileSize) {
    const kb = data.fileSize / 1024;
    stats.push(kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`);
  }
  if (stats.length > 0) {
    html += `<div class="klp-stats">${stats.join(' · ')}</div>`;
  }

  // Snippet
  if (data.snippet) {
    html += `<div class="klp-snippet">${esc(data.snippet)}</div>`;
  }

  // Example notes for tags
  if (data.exampleNotes && data.exampleNotes.length > 0) {
    html += '<div class="klp-examples">';
    for (const note of data.exampleNotes.slice(0, 5)) {
      html += `<div class="klp-example">• ${esc(note)}</div>`;
    }
    html += '</div>';
  }

  // Headings outline (scrollable, all headings, clickable)
  if (data.headings && data.headings.length > 0) {
    html += '<div class="klp-outline">';
    for (const h of data.headings) {
      const indent = Math.max(0, h.level - 1) * 10;
      const headingSlug = h.text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
      html += `<div class="klp-heading klp-heading-link" data-heading="${esc(headingSlug)}" data-target="${esc(data.target)}" style="padding-left:${indent}px"><span class="klp-h-marker">${'#'.repeat(h.level)}</span> ${esc(h.text)}</div>`;
    }
    html += '</div>';
  }

  // Navigation hint
  html += '<div class="klp-hint">⌘+Hover to preview · Click to open</div>';

  return html;
}

function positionTooltip(tooltip: HTMLDivElement, anchor: HTMLElement, view: EditorView): void {
  const anchorRect = anchor.getBoundingClientRect();
  const container = view.dom.parentElement;
  const cr = container?.getBoundingClientRect() ?? null;

  tooltip.style.visibility = 'hidden';
  tooltip.style.display = 'block';
  void tooltip.offsetHeight;

  positionFixedPopup({
    anchorRect,
    popup: tooltip,
    containerRect: cr,
    gap: 6,
    pad: 8,
    preferY: 'above',
    anchorEl: anchor,
  });
  tooltip.style.visibility = 'visible';
}

const LINK_PREVIEW_CSS = `
.kivi-link-preview {
  position: fixed;
  display: none;
  z-index: 9999;
  max-width: 320px;
  min-width: 180px;
  max-height: 400px;
  background: var(--vscode-editorWidget-background, rgba(37, 37, 38, 0.97));
  color: var(--vscode-editor-foreground, #d4d4d4);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.06));
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.08);
  font-size: 11px;
  font-family: var(--vscode-font-family, -apple-system, sans-serif);
  overflow-y: auto;
  overflow-x: hidden;
  opacity: 0;
  transform: translateY(4px) scale(0.97);
  transition: opacity 0.15s ease, transform 0.15s ease;
  pointer-events: auto;
}
.kivi-link-preview::-webkit-scrollbar { width: 4px; }
.kivi-link-preview::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
.kivi-link-preview::-webkit-scrollbar-track { background: transparent; }
.kivi-link-preview.klp-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.klp-header {
  padding: 10px 12px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.klp-title {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.klp-title.klp-unresolved {
  color: #d16969;
  text-decoration: line-through;
  opacity: 0.7;
}
.klp-badge {
  font-size: 9px;
  font-weight: 500;
  border-radius: 3px;
  padding: 1px 5px;
  flex-shrink: 0;
}
.klp-badge-tag { background: rgba(78,201,176,0.2); color: #4ec9b0; }
.klp-badge-image { background: rgba(206,145,120,0.2); color: #ce9178; }
.klp-badge-video, .klp-badge-audio { background: rgba(197,134,192,0.2); color: #c586c0; }
.klp-badge-pdf { background: rgba(209,105,105,0.2); color: #d16969; }
.klp-badge-code-file { background: rgba(156,220,254,0.2); color: #9cdcfe; }
.klp-badge-external-url { background: rgba(79,193,255,0.2); color: #4fc1ff; }
.klp-badge-unresolved { background: rgba(209,105,105,0.2); color: #d16969; }
.klp-badge-footnote { background: rgba(220,220,170,0.2); color: #dcdcaa; }
.klp-badge-heading-ref { background: rgba(156,220,254,0.2); color: #9cdcfe; }

.klp-missing {
  padding: 6px 12px 10px;
  font-size: 10px;
  color: #d16969;
  font-style: italic;
}

.klp-thumb {
  max-height: 120px;
  overflow: hidden;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.klp-thumb img {
  width: 100%;
  height: auto;
  display: block;
  object-fit: cover;
  max-height: 120px;
}

.klp-tags {
  padding: 4px 12px 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.klp-tag {
  font-size: 10px;
  color: var(--vscode-textLink-foreground, #4fc1ff);
  opacity: 0.7;
}

.klp-stats {
  padding: 5px 12px 0;
  font-size: 10px;
  color: var(--vscode-descriptionForeground, #888);
}

.klp-snippet {
  padding: 6px 12px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--vscode-editor-foreground, #ccc);
  opacity: 0.85;
  max-height: 120px;
  overflow: hidden;
  border-top: 1px solid rgba(255,255,255,0.05);
  margin-top: 4px;
}

.klp-examples {
  padding: 4px 12px 6px;
  border-top: 1px solid rgba(255,255,255,0.05);
  margin-top: 4px;
}
.klp-example {
  font-size: 10px;
  line-height: 1.6;
  color: var(--vscode-descriptionForeground, #999);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.klp-outline {
  padding: 4px 8px 6px;
  border-top: 1px solid rgba(255,255,255,0.05);
  margin-top: 4px;
  max-height: 200px;
  overflow-y: auto;
}
.klp-outline::-webkit-scrollbar { width: 3px; }
.klp-outline::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
.klp-heading {
  font-size: 10px;
  line-height: 1.6;
  color: var(--vscode-descriptionForeground, #999);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.klp-heading-link {
  cursor: pointer;
  border-radius: 3px;
  padding: 1px 4px;
  transition: background 0.1s, color 0.1s;
}
.klp-heading-link:hover {
  background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
  color: var(--vscode-foreground, #ccc);
}
.klp-h-marker {
  color: var(--vscode-descriptionForeground, #555);
  opacity: 0.4;
  font-size: 9px;
  margin-right: 3px;
}

/* ── External URL rich card (OG metadata) ── */
.klp-og-thumb {
  max-height: 160px;
  overflow: hidden;
  border-radius: 7px 7px 0 0;
}
.klp-og-thumb img {
  width: 100%;
  height: auto;
  display: block;
  object-fit: cover;
  max-height: 160px;
}
.klp-og-body {
  padding: 10px 12px 6px;
}
.klp-og-site {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--vscode-descriptionForeground, #888);
  margin-bottom: 4px;
}
.klp-og-favicon {
  border-radius: 2px;
  flex-shrink: 0;
}
.klp-og-title {
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--vscode-editor-foreground, #e0e0e0);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.klp-og-desc {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--vscode-descriptionForeground, #999);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.klp-hint {
  padding: 4px 12px 8px;
  font-size: 9px;
  color: var(--vscode-descriptionForeground, #666);
  opacity: 0.5;
}

.klp-loading {
  padding: 12px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
  display: flex;
  align-items: center;
  gap: 8px;
}
.klp-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255,255,255,0.15);
  border-top-color: var(--vscode-textLink-foreground, #4fc1ff);
  border-radius: 50%;
  animation: klp-spin 0.6s linear infinite;
}
@keyframes klp-spin {
  to { transform: rotate(360deg); }
}

/* Links are always clickable */
.kivi-wiki-link,
.kivi-link {
  cursor: pointer;
}
.kivi-wiki-link:hover,
.kivi-link:hover,
.kivi-hashtag:hover {
  text-decoration: underline;
  cursor: pointer;
}
/* Cmd/Ctrl held: underline all link types */
.kivi-cmd-hover .kivi-wiki-link,
.kivi-cmd-hover .kivi-link,
.kivi-cmd-hover .kivi-hashtag {
  text-decoration: underline;
  cursor: pointer;
}
`;

// Inject CSS once
let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = LINK_PREVIEW_CSS;
  document.head.appendChild(style);
  cssInjected = true;
}

// ── Clean Extension with DOM event handlers ────────────────

export const LinkPreviewExtension = Extension.create<LinkPreviewOptions>({
  name: 'kiviLinkPreview',

  addOptions() {
    return {
      onResolveLink: undefined,
      onNavigate: undefined,
      hoverDelay: 350,
      modifierHoverDelay: 80,
      cacheSize: 64,
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    const cache = new LRUCache<LinkPreviewData>(opts.cacheSize ?? 64);

    injectCSS();

    let tooltip: HTMLDivElement | null = null;
    let currentLink: DetectedLink | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveAbort: AbortController | null = null;
    let isInsideTooltip = false;
    let editorView: EditorView | null = null;

    function clearTimers() {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }

    function hideTooltip() {
      clearTimers();
      if (resolveAbort) { resolveAbort.abort(); resolveAbort = null; }
      if (tooltip) {
        tooltip.classList.remove('klp-visible');
        const ref = tooltip;
        setTimeout(() => {
          if (ref && !ref.classList.contains('klp-visible')) {
            ref.style.display = 'none';
          }
        }, 160);
      }
      currentLink = null;
    }

    function scheduleHide() {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!isInsideTooltip) hideTooltip();
      }, 200);
    }

    function ensureTooltip(): HTMLDivElement {
      if (!tooltip) {
        tooltip = createTooltipElement();
        document.body.appendChild(tooltip);

        tooltip.addEventListener('mouseenter', () => {
          isInsideTooltip = true;
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        });
        tooltip.addEventListener('mouseleave', () => {
          isInsideTooltip = false;
          scheduleHide();
        });
      }
      return tooltip;
    }

    async function showPreview(link: DetectedLink, view: EditorView) {
      if (!opts.onResolveLink) return;

      const cacheKey = `${link.kind}:${link.target}`;
      const tt = ensureTooltip();

      let data = cache.get(cacheKey);
      if (!data) {
        tt.innerHTML = '<div class="klp-loading"><span class="klp-spinner"></span> Loading...</div>';
        tt.style.display = 'block';
        positionTooltip(tt, link.element, view);
        void tt.offsetHeight;
        tt.classList.add('klp-visible');

        if (resolveAbort) resolveAbort.abort();
        const controller = new AbortController();
        resolveAbort = controller;

        try {
          const resolved = await opts.onResolveLink(link);
          if (controller.signal.aborted) return;
          if (!resolved) { hideTooltip(); return; }
          data = resolved;
          cache.set(cacheKey, data);
        } catch {
          if (!controller.signal.aborted) hideTooltip();
          return;
        }
      }

      if (!currentLink || currentLink.kind !== link.kind || currentLink.target !== link.target) return;

      tt.innerHTML = renderPreviewContent(data);
      tt.style.display = 'block';
      positionTooltip(tt, link.element, view);
      void tt.offsetHeight;
      tt.classList.add('klp-visible');

      // Attach click handlers to outline headings
      tt.querySelectorAll<HTMLElement>('.klp-heading-link').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const heading = el.getAttribute('data-heading') || '';
          const target = el.getAttribute('data-target') || '';
          hideTooltip();
          if (opts.onNavigate && target) {
            const headingTarget = heading ? `${target}#${heading}` : target;
            opts.onNavigate({
              kind: link.kind,
              target: headingTarget,
              from: link.from,
              to: link.to,
              element: link.element,
            });
          }
        });
      });
    }

    return [
      new Plugin({
        key: linkPreviewKey,
        view(view) {
          editorView = view;
          const scrollParent = view.dom.parentElement;
          const onScroll = () => {
            if (tooltip?.classList.contains('klp-visible') && currentLink) {
              positionTooltip(tooltip, currentLink.element, view);
            }
          };
          if (scrollParent) {
            scrollParent.addEventListener('scroll', onScroll, { passive: true });
          }

          return {
            update(v) { editorView = v; },
            destroy() {
              hideTooltip();
              tooltip?.remove();
              tooltip = null;
              editorView?.dom.classList.remove('kivi-cmd-hover');
              if (scrollParent) scrollParent.removeEventListener('scroll', onScroll);
            },
          };
        },
        props: {
          handleDOMEvents: {
            mouseover(view, event) {
              if (!opts.onResolveLink) return false;

              const me = event as MouseEvent;
              const link = detectLinkAtPos(view, me);

              if (!link) {
                if (!isInsideTooltip) scheduleHide();
                return false;
              }

              // Same link still hovered
              if (currentLink && currentLink.target === link.target && currentLink.kind === link.kind) {
                if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
                return false;
              }

              // Only show preview when Cmd/Ctrl is held
              const isModifierHeld = me.metaKey || me.ctrlKey;
              if (!isModifierHeld) {
                // Plain hover — just track the link for potential later Cmd press
                clearTimers();
                currentLink = link;
                return false;
              }

              // Cmd/Ctrl + hover — show preview
              clearTimers();
              if (resolveAbort) { resolveAbort.abort(); resolveAbort = null; }
              currentLink = link;

              hoverTimer = setTimeout(() => {
                if (currentLink === link) {
                  showPreview(link, view);
                }
              }, opts.modifierHoverDelay ?? 80);

              return false;
            },

            mouseout(_view, event) {
              const related = (event as MouseEvent).relatedTarget as HTMLElement | null;
              if (related && tooltip?.contains(related)) return false;
              if (!isInsideTooltip) {
                clearTimers();
                scheduleHide();
              }
              return false;
            },

            keydown(view, event) {
              const ke = event as KeyboardEvent;
              if (ke.key === 'Escape') {
                hideTooltip();
                return false;
              }
              if (ke.key === 'Meta' || ke.key === 'Control') {
                editorView?.dom.classList.add('kivi-cmd-hover');
                // If already hovering a link, start showing the preview
                if (currentLink && !tooltip?.classList.contains('klp-visible')) {
                  clearTimers();
                  if (resolveAbort) { resolveAbort.abort(); resolveAbort = null; }
                  const link = currentLink;
                  hoverTimer = setTimeout(() => {
                    if (currentLink === link) {
                      showPreview(link, view);
                    }
                  }, opts.modifierHoverDelay ?? 80);
                }
              }
              return false;
            },

            keyup(_view, event) {
              const ke = event as KeyboardEvent;
              if (ke.key === 'Meta' || ke.key === 'Control') {
                editorView?.dom.classList.remove('kivi-cmd-hover');
                // Hide preview when Cmd/Ctrl is released (unless mouse is inside tooltip)
                if (!isInsideTooltip) {
                  scheduleHide();
                }
              }
              return false;
            },

            click(view, event) {
              if (!opts.onNavigate) return false;
              const me = event as MouseEvent;
              // Only navigate on Cmd/Ctrl+click — plain click places caret and
              // lets LinkPopup show the edit UI (Notion/Confluence model).
              if (!(me.metaKey || me.ctrlKey)) return false;
              const link = detectLinkAtPos(view, me);
              if (!link) return false;

              me.preventDefault();
              hideTooltip();
              opts.onNavigate(link);
              return true;
            },

            handleDoubleClickOn: ((view: EditorView, _pos: number, _node: PMNode, _nodePos: number, event: MouseEvent) => {
              if (!opts.onNavigate) return false;
              const link = detectLinkAtPos(view, event);
              if (!link) return false;

              event.preventDefault();
              hideTooltip();
              opts.onNavigate(link);
              return true;
            }) as unknown as (view: EditorView, event: MouseEvent) => boolean | void,
          },
        },
      }),
    ];
  },
});
