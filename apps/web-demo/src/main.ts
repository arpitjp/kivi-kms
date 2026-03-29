import { createKiviEditor, applyTheme, allThemes, searchPluginKey } from '@kivi/editor-core';
import type { KiviTheme } from '@kivi/shared-types';
import { Vault, GraphRenderer } from '@kivi/vault';
import {
  iconBold, iconItalic, iconStrike, iconCode,
  iconH1, iconH2, iconH3,
  iconBulletList, iconOrderedList, iconTaskList,
  iconQuote, iconCodeBlock, iconHr,
  iconViewLive, iconViewSplit, iconViewMarkdown,
  iconGraph, iconSearch, iconChevronDown, iconChevronUp, iconToolbar,
  iconZoomIn, iconZoomOut, iconNewFile, iconSettings,
} from './icons.js';

// ── Settings persistence ──────────────────────────────────────────
type SectionId = 'explorer' | 'backlinks' | 'outline';

interface AppearanceOverrides {
  editorBackground?: string;
  codeBlockBackground?: string;
  accentColor?: string;
  textColor?: string;
  headingColor?: string;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  customCSS?: string;
}

interface LayoutSettings {
  theme: KiviTheme;
  viewMode: 'live' | 'split' | 'markdown';
  leftPaneWidth: number;
  rightPaneWidth: number;
  splitRatio: number;
  headerCollapsed: boolean;
  leftSections: SectionId[];
  rightSections: SectionId[];
  collapsedSections: SectionId[];
  expandedDirs: string[];
  zoom: number;
  appearance: AppearanceOverrides;
  showToolbar: boolean;
  showSidebar: boolean;
  showOutline: boolean;
  showBreadcrumbs: boolean;
}

const DEFAULT_SETTINGS: LayoutSettings = {
  theme: 'dark',
  viewMode: 'split',
  leftPaneWidth: 220,
  rightPaneWidth: 180,
  splitRatio: 0.5,
  headerCollapsed: false,
  leftSections: ['explorer', 'backlinks'],
  rightSections: ['outline'],
  collapsedSections: [],
  expandedDirs: [],
  zoom: 100,
  appearance: {},
  showToolbar: true,
  showSidebar: true,
  showOutline: true,
  showBreadcrumbs: true,
};

function loadSettings(): LayoutSettings {
  try {
    const raw = localStorage.getItem('kivi-layout');
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: LayoutSettings): void {
  localStorage.setItem('kivi-layout', JSON.stringify(s));
}

const settings = loadSettings();

// ── Appearance overrides ──────────────────────────────────────────
let _overrideStyleEl: HTMLStyleElement | null = null;
let _customCSSStyleEl: HTMLStyleElement | null = null;

function applyAppearanceOverrides(a: AppearanceOverrides) {
  if (!_overrideStyleEl) {
    _overrideStyleEl = document.createElement('style');
    _overrideStyleEl.id = 'kivi-appearance-overrides';
    document.head.appendChild(_overrideStyleEl);
  }
  if (!_customCSSStyleEl) {
    _customCSSStyleEl = document.createElement('style');
    _customCSSStyleEl.id = 'kivi-custom-css';
    document.head.appendChild(_customCSSStyleEl);
  }

  const props: string[] = [];
  if (a.editorBackground) props.push(`--bg-editor: ${a.editorBackground}; --bg: ${a.editorBackground};`);
  if (a.codeBlockBackground) props.push(`--kivi-codeblock-bg: ${a.codeBlockBackground};`);
  if (a.accentColor) props.push(`--accent: ${a.accentColor}; --accent-hover: ${a.accentColor};`);
  if (a.textColor) props.push(`--text: ${a.textColor};`);
  if (a.headingColor) props.push(`--kivi-heading-color: ${a.headingColor};`);
  if (a.fontSize && a.fontSize > 0) props.push(`--kivi-font-size: ${a.fontSize}px;`);
  if (a.fontFamily) props.push(`--kivi-font-family: ${a.fontFamily};`);
  if (a.lineHeight && a.lineHeight > 0) props.push(`--kivi-line-height: ${a.lineHeight};`);

  let css = '';
  if (props.length > 0) {
    css += `:root { ${props.join(' ')} }\n`;
  }
  if (a.codeBlockBackground) {
    css += `#editor .ProseMirror pre { background: var(--kivi-codeblock-bg) !important; }\n`;
  }
  if (a.headingColor) {
    css += `#editor .ProseMirror h1, #editor .ProseMirror h2, #editor .ProseMirror h3 { color: var(--kivi-heading-color) !important; }\n`;
  }
  if (a.fontSize && a.fontSize > 0) {
    css += `#editor { font-size: var(--kivi-font-size) !important; }\n`;
  }
  if (a.fontFamily) {
    css += `#editor { font-family: var(--kivi-font-family) !important; }\n`;
  }
  if (a.lineHeight && a.lineHeight > 0) {
    css += `#editor { line-height: var(--kivi-line-height) !important; }\n`;
  }

  _overrideStyleEl.textContent = css;
  _customCSSStyleEl.textContent = a.customCSS || '';
}

function applyUIVisibility() {
  const toolbar = document.getElementById('toolbar');
  const sidebar = document.getElementById('sidebar');
  const outline = document.getElementById('outline-panel');
  const breadcrumbs = document.getElementById('breadcrumbs');

  if (toolbar) toolbar.classList.toggle('collapsed', !settings.showToolbar);
  if (sidebar) {
    sidebar.classList.toggle('collapsed', !settings.showSidebar);
    if (!settings.showSidebar) sidebar.style.width = '0';
  }
  if (outline) {
    outline.classList.toggle('collapsed', !settings.showOutline);
    if (!settings.showOutline) outline.style.width = '0';
  }
  if (breadcrumbs) breadcrumbs.style.display = settings.showBreadcrumbs ? '' : 'none';
}

// ── Utilities ─────────────────────────────────────────────────────
const yieldToUI = () => new Promise<void>(r => requestAnimationFrame(() => r()));

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = ((...args: unknown[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  }) as T & { cancel(): void };
  debounced.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return debounced;
}

// ── Sample files ──────────────────────────────────────────────────
const SAMPLE_FILES: Record<string, string> = {
  'welcome.md': `# Welcome to Kivi

This is a **WYSIWYG** Markdown editor with *lossless* round-trip editing.

See also: [[features]] and [[getting-started]]

## Tags

#editor #markdown #demo

## Features

- Bold, italic, and ~~strikethrough~~
- [Links](https://example.com) and images
- Code blocks with syntax highlighting

\`\`\`typescript
const editor = createKiviEditor({ element: document.getElementById('editor')! });
editor.loadMarkdown(source);
\`\`\`

> Blockquotes are supported too.

1. Ordered lists
2. With numbering
3. Preserved exactly

---

That's it for now. Start editing!
`,

  'features.md': `# Features

Kivi supports all CommonMark and GFM features with lossless round-trip editing.

See [[welcome]] for an introduction.

## Inline Formatting

- **Bold** and *italic*
- ~~Strikethrough~~ and \`inline code\`
- [[wiki-links]] to other pages

## Tags

#editor #features

## Block Elements

- Headings (H1-H6)
- Code blocks with language
- Tables, blockquotes, horizontal rules
- Task lists and ordered/unordered lists
`,

  'getting-started.md': `# Getting Started

Welcome to [[welcome|Kivi]]! Here's how to get started.

## Installation

\`\`\`bash
pnpm install
pnpm build
\`\`\`

## Usage

Open any \`.md\` file in VS Code and reopen with Kivi Markdown Editor.

#tutorial #getting-started
`,

  'pages/readme.md': `# Pages

This is a folder page. Create child pages using the **+** button.

See [[welcome]] for the main page.
`,
};

// ── Vault ─────────────────────────────────────────────────────────
const vault = new Vault();
let currentFile = 'welcome.md';
let _loadFileFn: ((filename: string) => void) | null = null;

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const editorEl = document.getElementById('editor')!;
  const sourceEl = document.getElementById('markdown-source')!;
  const toolbarEl = document.getElementById('toolbar')!;
  const toolbarFormat = document.getElementById('toolbar-format')!;
  const toolbarRight = document.getElementById('toolbar-right')!;
  const fileListEl = document.getElementById('file-list')!;
  const backlinksListEl = document.getElementById('backlinks-list')!;
  const newFileBtn = document.getElementById('new-file-btn')!;
  const sidebar = document.getElementById('sidebar')!;
  const outlinePanel = document.getElementById('outline-panel')!;

  function triggerNewPage() {
    newFileBtn.click();
  }

  const editor = createKiviEditor({ element: editorEl, onCreatePage: triggerNewPage });

  for (const [path, content] of Object.entries(SAMPLE_FILES)) {
    vault.addFile(path, content);
  }
  editor.loadMarkdown(SAMPLE_FILES[currentFile]);
  await yieldToUI();

  const sourceTextarea = document.createElement('textarea');
  sourceTextarea.value = SAMPLE_FILES[currentFile];
  sourceTextarea.spellcheck = false;
  sourceEl.appendChild(sourceTextarea);

  let updatingFromEditor = false;
  let updatingFromTextarea = false;

  editor.onUpdate(({ markdown }) => {
    if (updatingFromTextarea) return;
    updatingFromEditor = true;
    sourceTextarea.value = markdown;
    vault.updateFile(currentFile, markdown);
    SAMPLE_FILES[currentFile] = markdown;
    renderBacklinks();
    updatingFromEditor = false;
  });

  const debouncedSourceSync = debounce(() => {
    if (updatingFromEditor) return;
    updatingFromTextarea = true;
    const val = sourceTextarea.value;
    editor.loadMarkdown(val);
    vault.updateFile(currentFile, val);
    SAMPLE_FILES[currentFile] = val;
    renderBacklinks();
    updatingFromTextarea = false;
  }, 250);

  sourceTextarea.addEventListener('input', () => {
    if (updatingFromEditor) return;
    debouncedSourceSync();
  });

  // ── File loading ──────────────────────────────────────────────
  function loadFile(filename: string) {
    const file = vault.getFile(filename);
    if (!file) return;
    debouncedSourceSync.cancel();
    const currentMarkdown = editor.getMarkdown();
    vault.updateFile(currentFile, currentMarkdown);
    SAMPLE_FILES[currentFile] = currentMarkdown;
    currentFile = filename;

    const content = SAMPLE_FILES[filename] ?? `# ${filename.replace(/\.md$/, '').split('/').pop()}\n\n`;
    editor.loadMarkdown(content);
    sourceTextarea.value = content;
    renderFileTree();
    renderBacklinks();
    renderBreadcrumbs();
    renderOutline();
  }

  _loadFileFn = loadFile;

  function makeClickable(el: HTMLElement, action: () => void): void {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('click', action);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); }
    });
  }

  // ── File tree (VS Code-style hierarchy) ───────────────────────
  function buildFileTree(): Map<string, string[]> {
    const dirs = new Map<string, string[]>();
    dirs.set('', []);
    for (const [path] of vault.files) {
      const parts = path.split('/');
      if (parts.length === 1) {
        dirs.get('')!.push(path);
      } else {
        const dir = parts.slice(0, -1).join('/');
        if (!dirs.has(dir)) dirs.set(dir, []);
        dirs.get(dir)!.push(path);
      }
    }
    return dirs;
  }

  function renderFileTree() {
    fileListEl.innerHTML = '';
    const tree = buildFileTree();
    const dirs = [...tree.keys()].sort();

    for (const dir of dirs) {
      const files = tree.get(dir) || [];
      if (dir !== '') {
        const dirItem = document.createElement('div');
        dirItem.className = 'tree-dir';
        const isExpanded = settings.expandedDirs.includes(dir);
        dirItem.setAttribute('aria-expanded', String(isExpanded));
        dirItem.setAttribute('role', 'treeitem');

        const chevron = document.createElement('span');
        chevron.className = 'tree-chevron';
        chevron.textContent = isExpanded ? '▾' : '▸';

        const label = document.createElement('span');
        label.className = 'tree-dir-label';
        label.textContent = dir.split('/').pop() || dir;

        dirItem.appendChild(chevron);
        dirItem.appendChild(label);

        dirItem.tabIndex = 0;
        dirItem.addEventListener('click', () => {
          const idx = settings.expandedDirs.indexOf(dir);
          if (idx >= 0) settings.expandedDirs.splice(idx, 1);
          else settings.expandedDirs.push(dir);
          saveSettings(settings);
          renderFileTree();
        });
        dirItem.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dirItem.click(); }
        });

        fileListEl.appendChild(dirItem);

        if (!isExpanded) continue;
      }

      const fileContainer = document.createElement('div');
      fileContainer.className = dir !== '' ? 'tree-children' : '';

      for (const path of files.sort()) {
        const item = document.createElement('div');
        item.className = 'file-item' + (path === currentFile ? ' active' : '');
        if (dir !== '') item.classList.add('tree-nested');
        item.textContent = vault.getFile(path)?.title || path.split('/').pop() || path;
        item.title = path;
        item.setAttribute('role', 'treeitem');
        makeClickable(item, () => loadFile(path));
        fileContainer.appendChild(item);
      }
      fileListEl.appendChild(fileContainer);
    }
  }

  // ── Backlinks ─────────────────────────────────────────────────
  function renderBacklinks() {
    backlinksListEl.innerHTML = '';
    const backlinks = vault.getBacklinks(currentFile);
    if (backlinks.length === 0) {
      backlinksListEl.innerHTML = '<div class="empty-state">No backlinks</div>';
      return;
    }
    for (const bl of backlinks) {
      const item = document.createElement('div');
      item.className = 'backlink-item';
      item.textContent = bl.title;
      item.title = bl.path;
      makeClickable(item, () => loadFile(bl.path));
      backlinksListEl.appendChild(item);
    }
  }



  // ── New page ──────────────────────────────────────────────────
  newFileBtn.addEventListener('click', () => {
    const parentDir = currentFile.includes('/') ? currentFile.split('/').slice(0, -1).join('/') : 'pages';
    const name = prompt(`Page name (will be created in ${parentDir}/):`, 'new-note');
    if (!name) return;
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const filename = `${parentDir}/${safeName}.md`;
    if (vault.files.has(filename)) {
      loadFile(filename);
      return;
    }
    const title = name.charAt(0).toUpperCase() + name.slice(1);
    const content = `# ${title}\n\n`;
    SAMPLE_FILES[filename] = content;
    vault.addFile(filename, content);

    if (!settings.expandedDirs.includes(parentDir)) {
      settings.expandedDirs.push(parentDir);
      saveSettings(settings);
    }
    loadFile(filename);

    // Select the H1 text so user can rename immediately
    setTimeout(() => {
      const tiptap = editor.getTiptapEditor();
      const doc = tiptap.state.doc;
      const firstChild = doc.firstChild;
      if (firstChild?.type.name === 'heading') {
        tiptap.commands.focus();
        tiptap.commands.setTextSelection({ from: 1, to: 1 + firstChild.content.size });
      }
    }, 50);
  });

  // ── Ctrl+N for new page ───────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      newFileBtn.click();
    }
  });

  await yieldToUI();

  // ── Outline ───────────────────────────────────────────────────
  const outlineListEl = document.getElementById('outline-list')!;
  const tiptap = editor.getTiptapEditor();

  function renderOutline() {
    outlineListEl.innerHTML = '';
    const outline = editor.getOutline();
    if (outline.length === 0) {
      outlineListEl.innerHTML = '<div class="empty-state">No headings</div>';
      return;
    }
    for (const heading of outline) {
      const item = document.createElement('div');
      item.className = 'outline-item';
      item.setAttribute('data-level', String(heading.level));
      item.textContent = heading.text;
      makeClickable(item, () => {
        tiptap.commands.focus();
        const resolvedPos = tiptap.state.doc.resolve(heading.pos + 1);
        tiptap.commands.setTextSelection(resolvedPos.pos);
        const dom = tiptap.view.domAtPos(heading.pos + 1);
        if (dom.node instanceof HTMLElement) {
          dom.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (dom.node.parentElement) {
          dom.node.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      outlineListEl.appendChild(item);
    }
  }

  tiptap.on('update', renderOutline);
  renderOutline();
  // ── Breadcrumbs ───────────────────────────────────────────────
  const breadcrumbsPathEl = document.getElementById('breadcrumbs-path')!;
  const breadcrumbsActionsEl = document.getElementById('breadcrumbs-actions')!;

  function renderBreadcrumbs() {
    breadcrumbsPathEl.innerHTML = '';
    const chain: string[] = [];
    let current: string | undefined = currentFile;

    while (current) {
      chain.unshift(current);
      const file = vault.getFile(current);
      current = file?.parent;
      if (chain.length > 10) break;
    }

    for (let i = 0; i < chain.length; i++) {
      const filePath = chain[i];
      const file = vault.getFile(filePath);
      const title = file?.title || filePath;

      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '›';
        breadcrumbsPathEl.appendChild(sep);
      }

      if (i === chain.length - 1) {
        const span = document.createElement('span');
        span.className = 'breadcrumb-current';
        span.textContent = title;
        breadcrumbsPathEl.appendChild(span);
      } else {
        const link = document.createElement('span');
        link.className = 'breadcrumb-item';
        link.textContent = title;
        makeClickable(link, () => loadFile(filePath));
        breadcrumbsPathEl.appendChild(link);
      }
    }
  }

  function initBreadcrumbActions() {
    breadcrumbsActionsEl.innerHTML = '';

    function addBtn(title: string, svgHtml: string, cls: string, onClick: () => void): HTMLButtonElement {
      const btn = document.createElement('button');
      btn.className = `breadcrumb-btn ${cls}`;
      btn.type = 'button';
      btn.title = title;
      btn.innerHTML = svgHtml;
      btn.addEventListener('click', onClick);
      breadcrumbsActionsEl.appendChild(btn);
      return btn;
    }

    function addSep() {
      const s = document.createElement('span');
      s.className = 'breadcrumb-sep-bar';
      breadcrumbsActionsEl.appendChild(s);
    }

    // View mode buttons
    const viewModes: { mode: 'live' | 'split' | 'markdown'; svg: string; title: string }[] = [
      { mode: 'live', svg: iconViewLive(), title: 'Rich text view' },
      { mode: 'split', svg: iconViewSplit(), title: 'Split view' },
      { mode: 'markdown', svg: iconViewMarkdown(), title: 'Markdown source' },
    ];

    const viewBtns: HTMLButtonElement[] = [];
    for (const vm of viewModes) {
      const btn = addBtn(vm.title, vm.svg, 'bc-view-btn', () => {
        applyViewMode(vm.mode);
        viewBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-mode') === vm.mode));
      });
      btn.setAttribute('data-mode', vm.mode);
      if (settings.viewMode === vm.mode) btn.classList.add('active');
      viewBtns.push(btn);
    }

    addSep();

    // Graph button
    addBtn('Graph View (Ctrl+G)', iconGraph(), '', () => {
      const overlay = document.getElementById('graph-overlay')!;
      if (overlay.style.display === 'none' || !overlay.style.display) openGraph();
      else closeGraph();
    });

    // Search button
    addBtn('Search (Ctrl+Shift+F)', iconSearch(), '', () => {
      const panel = document.getElementById('vault-search');
      if (panel) {
        const visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : 'block';
        if (!visible) panel.querySelector<HTMLInputElement>('#vault-search-input')?.focus();
      }
    });

    addSep();

    // Zoom controls
    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'breadcrumb-zoom-label';
    zoomLabel.textContent = `${settings.zoom}%`;
    function applyZoom() {
      const editorEl = document.getElementById('editor')!;
      editorEl.style.fontSize = `${15 * settings.zoom / 100}px`;
      zoomLabel.textContent = `${settings.zoom}%`;
      saveSettings(settings);
    }
    addBtn('Zoom out', iconZoomOut(), '', () => {
      settings.zoom = Math.max(50, settings.zoom - 10);
      applyZoom();
    });
    breadcrumbsActionsEl.appendChild(zoomLabel);
    addBtn('Zoom in', iconZoomIn(), '', () => {
      settings.zoom = Math.min(200, settings.zoom + 10);
      applyZoom();
    });

    addSep();

    // Show/hide header toolbar
    const headerBtn = addBtn(
      settings.headerCollapsed ? 'Show toolbar' : 'Hide toolbar',
      settings.headerCollapsed ? iconChevronDown() : iconChevronUp(),
      settings.headerCollapsed ? '' : 'active',
      () => {
        settings.headerCollapsed = !settings.headerCollapsed;
        applyLayout();
        saveSettings(settings);
        headerBtn.innerHTML = settings.headerCollapsed ? iconChevronDown() : iconChevronUp();
        headerBtn.title = settings.headerCollapsed ? 'Show toolbar' : 'Hide toolbar';
        headerBtn.classList.toggle('active', !settings.headerCollapsed);
      }
    );

    addSep();

    // Settings button with dropdown
    const settingsBtn = addBtn('Settings', iconSettings(), '', () => {
      const existing = document.getElementById('kivi-settings-panel');
      if (existing) { existing.remove(); return; }

      const panel = document.createElement('div');
      panel.id = 'kivi-settings-panel';

      const a = settings.appearance;
      panel.innerHTML = `
        <div class="kivi-sp-title">Appearance Overrides</div>
        <label class="kivi-sp-row"><span>Editor Background</span><input type="text" data-key="editorBackground" placeholder="e.g. #1f1f1f" value="${a.editorBackground || ''}" /></label>
        <label class="kivi-sp-row"><span>Code Block Background</span><input type="text" data-key="codeBlockBackground" placeholder="e.g. #181818" value="${a.codeBlockBackground || ''}" /></label>
        <label class="kivi-sp-row"><span>Accent Color</span><input type="text" data-key="accentColor" placeholder="e.g. #4daafc" value="${a.accentColor || ''}" /></label>
        <label class="kivi-sp-row"><span>Text Color</span><input type="text" data-key="textColor" placeholder="e.g. #d4d4d4" value="${a.textColor || ''}" /></label>
        <label class="kivi-sp-row"><span>Heading Color</span><input type="text" data-key="headingColor" placeholder="e.g. #e6e6e6" value="${a.headingColor || ''}" /></label>
        <label class="kivi-sp-row"><span>Font Size</span><input type="number" data-key="fontSize" placeholder="0 = default" value="${a.fontSize || ''}" min="0" max="72" /></label>
        <label class="kivi-sp-row"><span>Font Family</span><input type="text" data-key="fontFamily" placeholder="e.g. Inter, sans-serif" value="${a.fontFamily || ''}" /></label>
        <label class="kivi-sp-row"><span>Line Height</span><input type="number" data-key="lineHeight" placeholder="0 = default" value="${a.lineHeight || ''}" min="0" max="5" step="0.1" /></label>
        <div class="kivi-sp-title" style="margin-top:8px">Custom CSS</div>
        <textarea data-key="customCSS" rows="3" placeholder=".ProseMirror h1 { color: orange; }">${a.customCSS || ''}</textarea>
        <div class="kivi-sp-title" style="margin-top:8px">UI Visibility</div>
        <label class="kivi-sp-check"><input type="checkbox" data-vis="showToolbar" ${settings.showToolbar ? 'checked' : ''} /><span>Show Toolbar</span></label>
        <label class="kivi-sp-check"><input type="checkbox" data-vis="showSidebar" ${settings.showSidebar ? 'checked' : ''} /><span>Show Sidebar</span></label>
        <label class="kivi-sp-check"><input type="checkbox" data-vis="showOutline" ${settings.showOutline ? 'checked' : ''} /><span>Show Outline</span></label>
        <label class="kivi-sp-check"><input type="checkbox" data-vis="showBreadcrumbs" ${settings.showBreadcrumbs ? 'checked' : ''} /><span>Show Breadcrumbs</span></label>
        <button class="kivi-sp-reset">Reset All</button>
      `;

      document.body.appendChild(panel);

      const btnRect = settingsBtn.getBoundingClientRect();
      panel.style.top = `${btnRect.bottom + 4}px`;
      panel.style.right = `${window.innerWidth - btnRect.right}px`;

      panel.querySelectorAll<HTMLInputElement>('input[data-key], textarea[data-key]').forEach(inp => {
        inp.addEventListener('input', () => {
          const key = inp.getAttribute('data-key')! as keyof AppearanceOverrides;
          const val = inp.value;
          if (key === 'fontSize' || key === 'lineHeight') {
            (settings.appearance as Record<string, unknown>)[key] = val ? parseFloat(val) : undefined;
          } else {
            (settings.appearance as Record<string, unknown>)[key] = val || undefined;
          }
          applyAppearanceOverrides(settings.appearance);
          saveSettings(settings);
        });
      });

      panel.querySelectorAll<HTMLInputElement>('input[data-vis]').forEach(inp => {
        inp.addEventListener('change', () => {
          const key = inp.getAttribute('data-vis')! as keyof LayoutSettings;
          (settings as Record<string, unknown>)[key] = inp.checked;
          applyUIVisibility();
          saveSettings(settings);
        });
      });

      panel.querySelector('.kivi-sp-reset')!.addEventListener('click', () => {
        settings.appearance = {};
        settings.showToolbar = true;
        settings.showSidebar = true;
        settings.showOutline = true;
        settings.showBreadcrumbs = true;
        applyAppearanceOverrides(settings.appearance);
        applyUIVisibility();
        saveSettings(settings);
        panel.remove();
      });

      const dismiss = (e: MouseEvent) => {
        if (!panel.contains(e.target as Node) && e.target !== settingsBtn && !settingsBtn.contains(e.target as Node)) {
          panel.remove();
          document.removeEventListener('mousedown', dismiss);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
    });

    // Apply initial zoom
    applyZoom();
  }

  await yieldToUI();

  // ── Find & Replace ────────────────────────────────────────────
  const findWidget = document.getElementById('find-widget')!;
  const findInput = document.getElementById('find-input') as HTMLInputElement;
  const replaceInput = document.getElementById('replace-input') as HTMLInputElement;
  const findCount = document.getElementById('find-count')!;
  const findCaseBtn = document.getElementById('find-case') as HTMLButtonElement;
  const findRegexBtn = document.getElementById('find-regex') as HTMLButtonElement;

  let findCaseActive = false;
  let findRegexActive = false;

  findCaseBtn.addEventListener('click', () => {
    findCaseActive = !findCaseActive;
    findCaseBtn.classList.toggle('active', findCaseActive);
    findCaseBtn.setAttribute('aria-pressed', String(findCaseActive));
    runFind();
  });
  findRegexBtn.addEventListener('click', () => {
    findRegexActive = !findRegexActive;
    findRegexBtn.classList.toggle('active', findRegexActive);
    findRegexBtn.setAttribute('aria-pressed', String(findRegexActive));
    runFind();
  });

  function openFind() { findWidget.style.display = 'flex'; findInput.focus(); findInput.select(); }
  function closeFind() { findWidget.style.display = 'none'; editor.clearSearch(); findCount.textContent = ''; findCount.classList.remove('no-results'); tiptap.commands.focus(); }

  function runFind() {
    const q = findInput.value;
    if (!q) { editor.clearSearch(); findCount.textContent = ''; findCount.classList.remove('no-results'); return; }
    editor.search({ query: q, caseSensitive: findCaseActive, regex: findRegexActive });
    setTimeout(updateFindCount, 10);
  }

  function updateFindCount() {
    const searchState = searchPluginKey.getState(tiptap.state) as { results: { from: number; to: number }[]; activeIndex: number } | undefined;
    if (searchState?.results) {
      const total = searchState.results.length;
      const active = searchState.activeIndex;
      if (total > 0) {
        findCount.textContent = `${active + 1} of ${total}`;
        findCount.classList.remove('no-results');
      } else {
        findCount.textContent = 'No results';
        findCount.classList.add('no-results');
      }
    }
  }

  findInput.addEventListener('input', runFind);

  document.getElementById('find-next')!.addEventListener('click', () => { editor.nextSearchResult(); setTimeout(updateFindCount, 10); });
  document.getElementById('find-prev')!.addEventListener('click', () => { editor.previousSearchResult(); setTimeout(updateFindCount, 10); });
  document.getElementById('find-close')!.addEventListener('click', closeFind);

  document.getElementById('replace-one')!.addEventListener('click', () => {
    (tiptap.commands as any).replaceCurrentResult(replaceInput.value);
    setTimeout(() => runFind(), 10);
  });
  document.getElementById('replace-all')!.addEventListener('click', () => {
    (tiptap.commands as any).replaceAllResults(replaceInput.value);
    setTimeout(() => runFind(), 10);
  });

  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) { editor.previousSearchResult(); setTimeout(updateFindCount, 10); e.preventDefault(); }
    else if (e.key === 'Enter') { editor.nextSearchResult(); setTimeout(updateFindCount, 10); e.preventDefault(); }
    else if (e.key === 'Escape') { closeFind(); e.preventDefault(); }
  });
  replaceInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeFind(); e.preventDefault(); } });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !e.shiftKey) { e.preventDefault(); openFind(); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
      e.preventDefault();
      const panel = document.getElementById('vault-search');
      if (panel) {
        const visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : 'block';
        if (!visible) panel.querySelector<HTMLInputElement>('#vault-search-input')?.focus();
      }
    }
  });

  // ── Vault search ──────────────────────────────────────────────
  const searchPanel = document.getElementById('vault-search')!;
  const searchInput = searchPanel?.querySelector<HTMLInputElement>('#vault-search-input');
  const searchResults = document.getElementById('vault-search-results');

  if (searchInput && searchResults) {
    const debouncedSearch = debounce(() => {
      const q = searchInput.value.trim();
      searchResults.innerHTML = '';
      if (!q) return;
      const results = vault.search(q);
      if (results.length === 0) { searchResults.innerHTML = '<div class="empty-state">No results</div>'; return; }
      for (const file of results) {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.textContent = file.title;
        item.title = file.path;
        item.addEventListener('click', () => loadFile(file.path));
        searchResults.appendChild(item);
      }
    }, 200);
    searchInput.addEventListener('input', debouncedSearch);
  }

  // ── View mode ─────────────────────────────────────────────────
  const editorSplit = document.getElementById('editor-split')!;

  function applyViewMode(mode: 'live' | 'split' | 'markdown') {
    settings.viewMode = mode;
    editorSplit.setAttribute('data-view', mode);
    saveSettings(settings);
    document.querySelectorAll('.view-btn, .bc-view-btn').forEach((b) => {
      (b as HTMLElement).classList.toggle('active', b.getAttribute('data-mode') === mode);
    });
  }

  await yieldToUI();

  // ── Graph ────────────────────────────────────────────────────
  let graphRenderer: GraphRenderer | null = null;

  function openGraph() {
    const overlay = document.getElementById('graph-overlay')!;
    const graphContainer = document.getElementById('graph-container')!;
    overlay.style.display = 'flex';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Knowledge graph');
    if (!graphRenderer) {
      graphRenderer = new GraphRenderer(graphContainer, {
        onNodeClick: (nodeId) => { closeGraph(); _loadFileFn?.(nodeId); },
      });
    }
    const { nodes, edges } = vault.getGraph();
    graphRenderer.setData(nodes, edges);
    graphRenderer.resize(graphContainer.clientWidth, graphContainer.clientHeight);
    setupGraphControls();
  }

  function closeGraph() { document.getElementById('graph-overlay')!.style.display = 'none'; }

  function setupGraphControls() {
    const filterInput = document.getElementById('graph-filter') as HTMLInputElement;
    const depthInput = document.getElementById('graph-depth') as HTMLInputElement;
    const legendEl = document.getElementById('graph-legend')!;

    // Build legend from tags
    const tagIndex = vault.getTagIndex();
    const tagColors = new Map<string, string>();
    const palette = ['#4fc1ff', '#4ec9b0', '#ce9178', '#dcdcaa', '#c586c0', '#9cdcfe', '#6a9955'];
    let colorIdx = 0;
    const topTags = [...tagIndex.entries()]
      .filter(([k]) => !k.includes('/'))
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 6);

    legendEl.innerHTML = '';
    for (const [tag] of topTags) {
      const color = palette[colorIdx % palette.length];
      tagColors.set(tag, color);
      colorIdx++;
      const item = document.createElement('div');
      item.className = 'graph-legend-item';
      item.innerHTML = `<span class="graph-legend-dot" style="background:${color}"></span>#${tag}`;
      legendEl.appendChild(item);
    }

    if (graphRenderer) {
      (graphRenderer as any)._tagColors = tagColors;
    }

    const refreshGraph = () => {
      const filter = filterInput?.value.trim().toLowerCase() || '';
      const depth = parseInt(depthInput?.value || '3', 10);
      const { nodes, edges } = vault.getGraph();

      let filteredNodes = nodes;
      let filteredEdges = edges;

      if (filter) {
        const matchIds = new Set(
          nodes.filter(n =>
            n.label.toLowerCase().includes(filter) ||
            n.tags.some(t => t.toLowerCase().includes(filter))
          ).map(n => n.id)
        );

        // BFS expand by depth
        for (let d = 0; d < depth; d++) {
          const newIds = new Set<string>();
          for (const edge of edges) {
            if (matchIds.has(edge.source) && !matchIds.has(edge.target)) newIds.add(edge.target);
            if (matchIds.has(edge.target) && !matchIds.has(edge.source)) newIds.add(edge.source);
          }
          for (const id of newIds) matchIds.add(id);
        }

        filteredNodes = nodes.filter(n => matchIds.has(n.id));
        filteredEdges = edges.filter(e => matchIds.has(e.source) && matchIds.has(e.target));
      }

      if (graphRenderer) {
        graphRenderer.setData(filteredNodes, filteredEdges);
        const gc = document.getElementById('graph-container')!;
        graphRenderer.resize(gc.clientWidth, gc.clientHeight);
      }
    };

    filterInput?.addEventListener('input', debounce(refreshGraph, 200));
    depthInput?.addEventListener('input', refreshGraph);
  }

  document.getElementById('close-graph')!.addEventListener('click', closeGraph);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'g') { e.preventDefault(); openGraph(); }
    const overlay = document.getElementById('graph-overlay');
    if (e.key === 'Escape' && overlay && overlay.style.display !== 'none' && overlay.style.display !== '') {
      closeGraph(); e.preventDefault();
    }
  });

  // ── Panel system: sections are drag-and-drop between left/right panes ──
  const sectionElements: Record<SectionId, HTMLElement> = {
    explorer: document.getElementById('section-explorer')!,
    backlinks: document.getElementById('section-backlinks')!,
    outline: document.getElementById('section-outline')!,
  };

  const leftPane = document.getElementById('sidebar')!;
  const rightPane = document.getElementById('outline-panel')!;

  function applyLayout() {
    const root = document.documentElement;
    const hasLeft = settings.leftSections.length > 0;
    const hasRight = settings.rightSections.length > 0;

    root.style.setProperty('--sidebar-width', hasLeft ? `${settings.leftPaneWidth}px` : '0px');
    root.style.setProperty('--outline-width', hasRight ? `${settings.rightPaneWidth}px` : '0px');

    leftPane.classList.toggle('collapsed', !hasLeft);
    rightPane.classList.toggle('collapsed', !hasRight);
    toolbarEl.classList.toggle('collapsed', settings.headerCollapsed);

    // Show/hide resize handles next to empty panes
    const leftHandle = document.querySelector('.resize-handle[data-resize="left"]') as HTMLElement;
    const rightHandle = document.querySelector('.resize-handle[data-resize="right"]') as HTMLElement;
    if (leftHandle) leftHandle.style.display = hasLeft ? '' : 'none';
    if (rightHandle) rightHandle.style.display = hasRight ? '' : 'none';

    if (settings.viewMode === 'split') {
      root.style.setProperty('--split-ratio', String(settings.splitRatio));
    }

    // Place sections into correct panes in order
    for (const id of settings.leftSections) {
      const el = sectionElements[id];
      if (el && el.parentElement !== leftPane) leftPane.appendChild(el);
    }
    for (const id of settings.rightSections) {
      const el = sectionElements[id];
      if (el && el.parentElement !== rightPane) rightPane.appendChild(el);
    }

    // Collapsed sections
    for (const id of (['explorer', 'backlinks', 'outline'] as SectionId[])) {
      const el = sectionElements[id];
      if (!el) continue;
      const collapsed = settings.collapsedSections.includes(id);
      el.classList.toggle('section-collapsed', collapsed);
      const toggle = el.querySelector('.section-toggle') as HTMLElement;
      if (toggle) {
        toggle.innerHTML = collapsed
          ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><polyline points="6,4 10,8 6,12"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><polyline points="4,6 8,10 12,6"/></svg>';
        toggle.setAttribute('aria-expanded', String(!collapsed));
      }
    }
  }

  function setupSectionDragDrop() {
    for (const [id, el] of Object.entries(sectionElements) as [SectionId, HTMLElement][]) {
      const header = el.querySelector('.section-header') as HTMLElement;
      if (!header) continue;

      // Collapse toggle
      const toggle = header.querySelector('.section-toggle') as HTMLElement;
      if (toggle) {
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = settings.collapsedSections.indexOf(id);
          if (idx >= 0) settings.collapsedSections.splice(idx, 1);
          else settings.collapsedSections.push(id);
          saveSettings(settings);
          applyLayout();
        });
      }

      // Move button (quick move to other pane)
      const moveBtn = header.querySelector('.section-move') as HTMLElement;
      if (moveBtn) {
        moveBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          moveSection(id);
        });
      }

      // Drag to reorder / move between panes
      const handle = header.querySelector('.section-drag') as HTMLElement || header;
      handle.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        const startY = e.clientY;
        const startX = e.clientX;
        let moved = false;

        const ghost = el.cloneNode(true) as HTMLElement;
        ghost.className = 'section-drag-ghost';
        ghost.style.width = `${el.offsetWidth}px`;

        const onMove = (ev: MouseEvent) => {
          if (!moved && Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < 8) return;
          if (!moved) {
            moved = true;
            document.body.appendChild(ghost);
            el.style.opacity = '0.3';
          }
          ghost.style.left = `${ev.clientX + 8}px`;
          ghost.style.top = `${ev.clientY - 12}px`;

          // Highlight drop target pane
          const overLeft = leftPane.getBoundingClientRect();
          const overRight = rightPane.getBoundingClientRect();
          leftPane.classList.toggle('drop-target', ev.clientX < overLeft.right + 50 && ev.clientX > overLeft.left - 20);
          rightPane.classList.toggle('drop-target', ev.clientX > overRight.left - 50 && ev.clientX < overRight.right + 20);
        };

        const onUp = (ev: MouseEvent) => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          el.style.opacity = '';
          ghost.remove();
          leftPane.classList.remove('drop-target');
          rightPane.classList.remove('drop-target');

          if (!moved) return;

          // Determine target pane
          const midX = (leftPane.getBoundingClientRect().right + rightPane.getBoundingClientRect().left) / 2;
          const targetIsRight = ev.clientX > midX;

          // Remove from current pane
          settings.leftSections = settings.leftSections.filter((s) => s !== id);
          settings.rightSections = settings.rightSections.filter((s) => s !== id);

          // Insert into target pane at approximate position
          const targetSections = targetIsRight ? settings.rightSections : settings.leftSections;
          const targetPane = targetIsRight ? rightPane : leftPane;
          const children = [...targetPane.querySelectorAll<HTMLElement>('.panel-section')];
          let insertIdx = children.length;
          for (let i = 0; i < children.length; i++) {
            const rect = children[i].getBoundingClientRect();
            if (ev.clientY < rect.top + rect.height / 2) { insertIdx = i; break; }
          }
          targetSections.splice(insertIdx, 0, id);

          saveSettings(settings);
          applyLayout();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
  }

  function moveSection(id: SectionId) {
    const inLeft = settings.leftSections.includes(id);
    if (inLeft) {
      settings.leftSections = settings.leftSections.filter((s) => s !== id);
      settings.rightSections.push(id);
    } else {
      settings.rightSections = settings.rightSections.filter((s) => s !== id);
      settings.leftSections.push(id);
    }
    saveSettings(settings);
    applyLayout();
  }

  function setupResizeHandles() {
    document.querySelectorAll<HTMLElement>('.resize-handle').forEach((handle) => {
      const target = handle.dataset.resize;
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        let startVal: number;
        if (target === 'left') startVal = settings.leftPaneWidth;
        else if (target === 'right') startVal = settings.rightPaneWidth;
        else startVal = settings.splitRatio;

        const onMove = (ev: MouseEvent) => {
          const dx = ev.clientX - startX;
          if (target === 'left') {
            settings.leftPaneWidth = Math.max(140, Math.min(500, startVal + dx));
          } else if (target === 'right') {
            settings.rightPaneWidth = Math.max(120, Math.min(400, startVal - dx));
          } else if (target === 'split') {
            const container = editorSplit.getBoundingClientRect();
            const ratio = (ev.clientX - container.left) / container.width;
            settings.splitRatio = Math.max(0.15, Math.min(0.85, ratio));
            if (settings.splitRatio < 0.2) { applyViewMode('markdown'); return; }
            else if (settings.splitRatio > 0.8) { applyViewMode('live'); return; }
          }
          applyLayout();
        };

        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          saveSettings(settings);
        };

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  // ── Toolbar ───────────────────────────────────────────────────
  function initToolbar() {
    const actions = [
      { id: 'bold', svg: iconBold(), title: 'Bold (Ctrl+B)', cmd: () => tiptap.chain().focus().toggleBold().run(), active: () => tiptap.isActive('bold') },
      { id: 'italic', svg: iconItalic(), title: 'Italic (Ctrl+I)', cmd: () => tiptap.chain().focus().toggleItalic().run(), active: () => tiptap.isActive('italic') },
      { id: 'strike', svg: iconStrike(), title: 'Strikethrough', cmd: () => tiptap.chain().focus().toggleStrike().run(), active: () => tiptap.isActive('strike') },
      { id: 'code', svg: iconCode(), title: 'Inline Code', cmd: () => tiptap.chain().focus().toggleCode().run(), active: () => tiptap.isActive('code') },
      { id: 'sep' },
      { id: 'h1', svg: iconH1(), title: 'Heading 1', cmd: () => tiptap.chain().focus().toggleHeading({ level: 1 }).run(), active: () => tiptap.isActive('heading', { level: 1 }) },
      { id: 'h2', svg: iconH2(), title: 'Heading 2', cmd: () => tiptap.chain().focus().toggleHeading({ level: 2 }).run(), active: () => tiptap.isActive('heading', { level: 2 }) },
      { id: 'h3', svg: iconH3(), title: 'Heading 3', cmd: () => tiptap.chain().focus().toggleHeading({ level: 3 }).run(), active: () => tiptap.isActive('heading', { level: 3 }) },
      { id: 'sep' },
      { id: 'bullet', svg: iconBulletList(), title: 'Bullet List', cmd: () => tiptap.chain().focus().toggleBulletList().run(), active: () => tiptap.isActive('bulletList') },
      { id: 'ordered', svg: iconOrderedList(), title: 'Ordered List', cmd: () => tiptap.chain().focus().toggleOrderedList().run(), active: () => tiptap.isActive('orderedList') },
      { id: 'task', svg: iconTaskList(), title: 'Task List', cmd: () => tiptap.chain().focus().toggleTaskList().run(), active: () => tiptap.isActive('taskList') },
      { id: 'sep' },
      { id: 'quote', svg: iconQuote(), title: 'Blockquote', cmd: () => tiptap.chain().focus().toggleBlockquote().run(), active: () => tiptap.isActive('blockquote') },
      { id: 'codeblock', svg: iconCodeBlock(), title: 'Code Block', cmd: () => tiptap.chain().focus().toggleCodeBlock().run(), active: () => tiptap.isActive('codeBlock') },
      { id: 'hr', svg: iconHr(), title: 'Horizontal Rule', cmd: () => tiptap.chain().focus().setHorizontalRule().run(), active: () => false },
    ];

    for (const action of actions) {
      if (action.id === 'sep') {
        const sep = document.createElement('span');
        sep.className = 'toolbar-sep';
        toolbarFormat.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'toolbar-btn';
      btn.type = 'button';
      btn.title = action.title || '';
      if (action.svg) btn.innerHTML = action.svg;
      if (action.active) btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', (e) => { e.preventDefault(); action.cmd?.(); });
      toolbarFormat.appendChild(btn);
    }

    const update = () => {
      const buttons = toolbarFormat.querySelectorAll<HTMLButtonElement>('.toolbar-btn');
      let i = 0;
      for (const action of actions) {
        if (action.id === 'sep') continue;
        const btn = buttons[i++];
        if (btn && action.active) {
          const isActive = action.active();
          btn.classList.toggle('active', isActive);
          if (btn.hasAttribute('aria-pressed')) btn.setAttribute('aria-pressed', String(isActive));
        }
      }
    };
    tiptap.on('selectionUpdate', update);
    tiptap.on('update', update);

    // ── Right section: theme picker ──────────────────────────────
    const themeSelect = document.createElement('select');
    themeSelect.className = 'theme-picker';
    themeSelect.title = 'Theme';
    themeSelect.setAttribute('aria-label', 'Select theme');
    for (const t of allThemes) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
      themeSelect.appendChild(opt);
    }
    themeSelect.value = settings.theme;
    applyTheme(document.documentElement, settings.theme);
    themeSelect.addEventListener('change', () => {
      settings.theme = themeSelect.value as KiviTheme;
      applyTheme(document.documentElement, settings.theme);
      saveSettings(settings);
    });
    toolbarRight.appendChild(themeSelect);
  }

  // ── Initialize ────────────────────────────────────────────────
  await yieldToUI();
  initToolbar();
  await yieldToUI();
  initBreadcrumbActions();
  setupResizeHandles();
  setupSectionDragDrop();
  applyLayout();
  await yieldToUI();
  applyViewMode(settings.viewMode);
  renderFileTree();
  renderBacklinks();
  renderBreadcrumbs();
  applyAppearanceOverrides(settings.appearance);
  applyUIVisibility();
}

main().catch((err) => {
  console.error('[Kivi] Fatal error during initialization:', err);
  const el = document.getElementById('editor');
  if (el) {
    el.innerHTML = `<pre style="color:#f44747;padding:24px;font-size:13px;white-space:pre-wrap;">Kivi failed to start:\n${err?.stack ?? err}</pre>`;
  }
});
