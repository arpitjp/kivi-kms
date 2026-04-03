import { createKiviEditor, applyTheme, allThemes, searchPluginKey } from '@kivi/editor-core';
import type { KiviTheme } from '@kivi/shared-types';
import { Vault, GraphRenderer } from '@kivi/vault';
import type { GraphMode, EdgeType } from '@kivi/vault';
import {
  iconBold, iconItalic, iconStrike, iconCode,
  iconH1, iconH2, iconH3,
  iconBulletList, iconOrderedList, iconTaskList,
  iconQuote, iconCodeBlock, iconHr,
  iconViewLive, iconViewSplit, iconViewMarkdown,
  iconGraph, iconSearch, iconChevronDown, iconChevronUp, iconToolbar,
  iconZoomIn, iconZoomOut, iconNewFile, iconSettings,
  iconFileMarkdown, iconFolder, iconFolderOpen, iconCollapseAll, iconChevronRight,
  iconBacklink,
} from './icons.js';

// ── Settings persistence ──────────────────────────────────────────
type SectionId = 'explorer' | 'tags' | 'backlinks' | 'outline' | 'warnings';

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
  wordWrap: boolean;
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
  wordWrap: true,
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
  const collapseAllBtn = document.getElementById('collapse-all-btn');
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

  const sourceEditorRow = document.createElement('div');
  sourceEditorRow.className = 'markdown-source-row';

  const lineGutter = document.createElement('div');
  lineGutter.className = 'line-gutter';
  const lineGutterInner = document.createElement('div');
  lineGutterInner.className = 'line-gutter-inner';
  lineGutter.appendChild(lineGutterInner);

  const sourceTextarea = document.createElement('textarea');
  sourceTextarea.value = SAMPLE_FILES[currentFile];
  sourceTextarea.spellcheck = false;

  sourceEditorRow.append(lineGutter, sourceTextarea);
  sourceEl.appendChild(sourceEditorRow);

  function syncLineGutterScroll(): void {
    lineGutter.scrollTop = sourceTextarea.scrollTop;
  }

  function caretLineIndex(text: string, pos: number): number {
    let line = 0;
    for (let i = 0; i < pos && i < text.length; i++) {
      if (text[i] === '\n') line++;
    }
    return line;
  }

  function refreshSourceLineGutter(): void {
    const text = sourceTextarea.value;
    const lineCount = text === '' ? 1 : text.split('\n').length;
    const activeLine = caretLineIndex(text, sourceTextarea.selectionStart);

    lineGutterInner.replaceChildren();
    for (let i = 0; i < lineCount; i++) {
      const row = document.createElement('div');
      row.className = 'line-gutter-num' + (i === activeLine ? ' line-gutter-num--active' : '');
      row.textContent = String(i + 1);
      lineGutterInner.appendChild(row);
    }

    requestAnimationFrame(() => {
      const taH = sourceTextarea.scrollHeight;
      const innerH = lineGutterInner.scrollHeight;
      const extra = Math.max(0, taH - innerH);
      lineGutterInner.style.paddingBottom = extra > 0 ? `${32 + extra}px` : '';
      syncLineGutterScroll();
    });
  }

  let updatingFromEditor = false;
  let updatingFromTextarea = false;

  editor.onUpdate(({ markdown }) => {
    if (updatingFromTextarea) return;
    updatingFromEditor = true;
    sourceTextarea.value = markdown;
    refreshSourceLineGutter();
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
    refreshSourceLineGutter();
    debouncedSourceSync();
  });

  sourceTextarea.addEventListener('scroll', syncLineGutterScroll);

  document.addEventListener('selectionchange', () => {
    if (document.activeElement === sourceTextarea) refreshSourceLineGutter();
  });

  refreshSourceLineGutter();

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
    refreshSourceLineGutter();
    renderFileTree();
    renderBacklinks();
    renderBreadcrumbs();
    renderOutline();
    renderTags();
    renderWarnings();
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

  interface TreeDir {
    name: string;
    path: string;
    files: string[];
    children: TreeDir[];
  }

  function buildFileTree(): TreeDir {
    const root: TreeDir = { name: '', path: '', files: [], children: [] };
    const dirMap = new Map<string, TreeDir>([['', root]]);

    const ensureDir = (dirPath: string): TreeDir => {
      if (dirMap.has(dirPath)) return dirMap.get(dirPath)!;
      const parts = dirPath.split('/');
      const parentPath = parts.slice(0, -1).join('/');
      const parent = ensureDir(parentPath);
      const dir: TreeDir = { name: parts[parts.length - 1], path: dirPath, files: [], children: [] };
      parent.children.push(dir);
      dirMap.set(dirPath, dir);
      return dir;
    };

    for (const [filePath] of vault.files) {
      const parts = filePath.split('/');
      if (parts.length === 1) {
        root.files.push(filePath);
      } else {
        const dirPath = parts.slice(0, -1).join('/');
        ensureDir(dirPath).files.push(filePath);
      }
    }

    const sortDir = (d: TreeDir) => {
      d.children.sort((a, b) => a.name.localeCompare(b.name));
      d.files.sort();
      d.children.forEach(sortDir);
    };
    sortDir(root);
    return root;
  }

  function collapseAllDirs() {
    settings.expandedDirs = [];
    saveSettings(settings);
    renderFileTree();
  }

  function renderFileTree() {
    fileListEl.innerHTML = '';
    const tree = buildFileTree();

    const INDENT_PX = 16;

    function addIndentGuides(el: HTMLElement, depth: number) {
      for (let i = 1; i <= depth; i++) {
        const guide = document.createElement('span');
        guide.className = 'tree-indent-guide';
        guide.style.left = `${i * INDENT_PX + 2}px`;
        el.appendChild(guide);
      }
    }

    function renderDir(dir: TreeDir, depth: number) {
      if (dir.path !== '') {
        const isExpanded = settings.expandedDirs.includes(dir.path);
        const dirItem = document.createElement('div');
        dirItem.className = 'tree-dir';
        dirItem.style.paddingLeft = `${depth * INDENT_PX + 4}px`;
        dirItem.setAttribute('aria-expanded', String(isExpanded));
        dirItem.setAttribute('role', 'treeitem');

        addIndentGuides(dirItem, depth);

        const chevron = document.createElement('span');
        chevron.className = 'tree-chevron' + (isExpanded ? ' expanded' : '');
        chevron.innerHTML = iconChevronRight();

        const folderIcon = document.createElement('span');
        folderIcon.className = 'tree-icon';
        folderIcon.innerHTML = isExpanded ? iconFolderOpen() : iconFolder();

        const label = document.createElement('span');
        label.className = 'tree-dir-label';
        label.textContent = dir.name;

        dirItem.appendChild(chevron);
        dirItem.appendChild(folderIcon);
        dirItem.appendChild(label);

        dirItem.tabIndex = 0;
        dirItem.addEventListener('click', () => {
          const idx = settings.expandedDirs.indexOf(dir.path);
          if (idx >= 0) settings.expandedDirs.splice(idx, 1);
          else settings.expandedDirs.push(dir.path);
          saveSettings(settings);
          renderFileTree();
        });
        dirItem.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dirItem.click(); }
        });

        fileListEl.appendChild(dirItem);
        if (!isExpanded) return;
      }

      const childDepth = dir.path !== '' ? depth + 1 : depth;

      for (const child of dir.children) {
        renderDir(child, childDepth);
      }

      for (const filePath of dir.files) {
        const item = document.createElement('div');
        const isActive = filePath === currentFile;
        item.className = 'file-item' + (isActive ? ' active' : '');
        item.style.paddingLeft = `${childDepth * INDENT_PX + 4}px`;
        item.title = filePath;
        item.setAttribute('role', 'treeitem');

        addIndentGuides(item, childDepth);

        const fileIcon = document.createElement('span');
        fileIcon.className = 'tree-icon file-icon';
        fileIcon.innerHTML = iconFileMarkdown();
        item.appendChild(fileIcon);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-name';
        nameSpan.textContent = vault.getFile(filePath)?.title || filePath.split('/').pop() || filePath;
        item.appendChild(nameSpan);

        makeClickable(item, () => loadFile(filePath));
        fileListEl.appendChild(item);

        if (isActive) {
          requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' }));
        }
      }
    }

    renderDir(tree, 0);
  }

  // ── Backlinks ─────────────────────────────────────────────────
  function renderBacklinks() {
    backlinksListEl.innerHTML = '';
    const backlinks = vault.getBacklinks(currentFile);

    const countEl = document.querySelector('#section-backlinks .section-count');
    if (countEl) countEl.textContent = String(backlinks.length);

    if (backlinks.length === 0) {
      backlinksListEl.innerHTML = '<div class="empty-state">No backlinks found</div>';
      return;
    }
    for (const bl of backlinks) {
      const item = document.createElement('div');
      item.className = 'backlink-item';
      item.title = bl.path;

      const icon = document.createElement('span');
      icon.className = 'backlink-icon';
      icon.innerHTML = iconBacklink();
      item.appendChild(icon);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'backlink-name';
      nameSpan.textContent = bl.title;
      item.appendChild(nameSpan);

      makeClickable(item, () => loadFile(bl.path));
      backlinksListEl.appendChild(item);
    }
  }



  // ── Tags subpane ─────────────────────────────────────────────
  const tagsListEl = document.getElementById('tags-list')!;

  function renderTags() {
    tagsListEl.innerHTML = '';
    const tagIndex = vault.getTagIndex();
    const rootTags = [...tagIndex.entries()]
      .filter(([k]) => !k.includes('/'))
      .sort((a, b) => b[1].length - a[1].length);

    const countEl = document.querySelector('#section-tags .section-count');
    if (countEl) countEl.textContent = String(rootTags.length);

    if (rootTags.length === 0) {
      tagsListEl.innerHTML = '<div class="empty-state">No tags</div>';
      return;
    }
    const palette = TAG_PALETTE;
    rootTags.forEach(([tag, files], i) => {
      const item = document.createElement('div');
      item.className = 'tag-item';

      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = palette[i % palette.length];
      item.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'tag-name';
      name.textContent = `#${tag}`;
      item.appendChild(name);

      const count = document.createElement('span');
      count.className = 'tag-count';
      count.textContent = String(files.length);
      item.appendChild(count);

      item.addEventListener('click', () => {
        // Filter file list to just files with this tag
        const filteredFiles = files;
        fileListEl.innerHTML = '';
        for (const fp of filteredFiles) {
          const fi = document.createElement('div');
          fi.className = 'file-item';
          fi.textContent = vault.getFile(fp)?.title || fp;
          fi.title = fp;
          makeClickable(fi, () => { loadFile(fp); renderFileTree(); });
          fileListEl.appendChild(fi);
        }
      });
      tagsListEl.appendChild(item);
    });
  }

  const TAG_PALETTE = ['#4fc1ff', '#4ec9b0', '#ce9178', '#dcdcaa', '#c586c0', '#9cdcfe', '#6a9955', '#d16969'];

  // ── Integrity / Warnings subpane ───────────────────────────
  const warningsListEl = document.getElementById('warnings-list')!;
  const warningsSection = document.getElementById('section-warnings')!;

  interface IntegrityIssue {
    type: 'broken-link' | 'orphan';
    file: string;
    detail: string;
  }

  function checkIntegrity(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    for (const [path, file] of vault.files) {
      for (const link of file.wikiLinks) {
        const resolved = vault.getFile(link) ||
          vault.getFile(link + '.md') ||
          [...vault.files.values()].find(f =>
            f.path.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() === link.toLowerCase()
          );
        if (!resolved) {
          issues.push({ type: 'broken-link', file: path, detail: `Broken link: [[${link}]]` });
        }
      }
    }
    for (const [path, file] of vault.files) {
      if (file.backlinks.length === 0 && file.wikiLinks.length === 0) {
        issues.push({ type: 'orphan', file: path, detail: 'Orphan page (no links in or out)' });
      }
    }
    return issues;
  }

  function renderWarnings() {
    const issues = checkIntegrity();
    const countEl = warningsSection.querySelector('.section-count');
    if (countEl) countEl.textContent = String(issues.length);

    if (issues.length === 0) {
      warningsSection.style.display = 'none';
      return;
    }

    warningsSection.style.display = '';
    warningsListEl.innerHTML = '';
    for (const issue of issues) {
      const item = document.createElement('div');
      item.className = 'issue-item';

      const icon = document.createElement('span');
      icon.className = 'issue-icon' + (issue.type === 'broken-link' ? ' error' : '');
      icon.innerHTML = issue.type === 'broken-link'
        ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.8" fill="currentColor" stroke="none"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2L14 13H2z"/><line x1="8" y1="6" x2="8" y2="9.5"/><circle cx="8" cy="11.2" r="0.7" fill="currentColor" stroke="none"/></svg>';
      item.appendChild(icon);

      const textWrap = document.createElement('div');
      textWrap.className = 'issue-text';
      const detail = document.createElement('div');
      detail.textContent = issue.detail;
      textWrap.appendChild(detail);
      const pathEl = document.createElement('div');
      pathEl.className = 'issue-path';
      pathEl.textContent = issue.file;
      textWrap.appendChild(pathEl);
      item.appendChild(textWrap);

      item.addEventListener('click', () => loadFile(issue.file));
      warningsListEl.appendChild(item);
    }
  }

  // ── Collapse all ────────────────────────────────────────────────
  collapseAllBtn?.addEventListener('click', collapseAllDirs);

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

    const countEl = document.querySelector('#section-outline .section-count');
    if (countEl) countEl.textContent = String(outline.length);

    if (outline.length === 0) {
      outlineListEl.innerHTML = '<div class="empty-state">No headings</div>';
      return;
    }
    for (const heading of outline) {
      const item = document.createElement('div');
      item.className = 'outline-item';
      item.setAttribute('data-level', String(heading.level));

      const badge = document.createElement('span');
      badge.className = 'outline-badge';
      badge.textContent = `H${heading.level}`;
      item.appendChild(badge);

      const text = document.createElement('span');
      text.className = 'outline-text';
      text.textContent = heading.text;
      item.appendChild(text);

      makeClickable(item, () => {
        tiptap.commands.focus();
        const resolvedPos = tiptap.state.doc.resolve(heading.pos + 1);
        tiptap.commands.setTextSelection(resolvedPos.pos);
        const domAtPos = tiptap.view.domAtPos(heading.pos + 1);
        const scrollTarget = domAtPos.node instanceof HTMLElement
          ? domAtPos.node
          : domAtPos.node.parentElement;
        if (scrollTarget) {
          scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        requestAnimationFrame(() => {
          const headingEl = tiptap.view.nodeDOM(heading.pos) as HTMLElement | null;
          if (headingEl) {
            headingEl.classList.add('kivi-heading-highlight');
            setTimeout(() => headingEl.classList.remove('kivi-heading-highlight'), 1800);
          }
        });
      });
      outlineListEl.appendChild(item);
    }
  }

  tiptap.on('update', renderOutline);
  renderOutline();

  // ── Breadcrumbs ───────────────────────────────────────────────
  const breadcrumbsPathEl = document.getElementById('breadcrumbs-path')!;
  const breadcrumbsActionsEl = document.getElementById('breadcrumbs-actions')!;

  let activeBreadcrumbDropdown: HTMLElement | null = null;

  function dismissBreadcrumbDropdown() {
    activeBreadcrumbDropdown?.remove();
    activeBreadcrumbDropdown = null;
  }

  function showBreadcrumbDropdown(anchor: HTMLElement, items: { label: string; icon: string; path: string }[]) {
    dismissBreadcrumbDropdown();
    const dd = document.createElement('div');
    dd.className = 'breadcrumb-dropdown';
    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'breadcrumb-dropdown-item';
      el.innerHTML = `<span class="breadcrumb-icon">${item.icon}</span>${item.label}`;
      el.addEventListener('click', () => {
        dismissBreadcrumbDropdown();
        loadFile(item.path);
      });
      dd.appendChild(el);
    }
    anchor.style.position = 'relative';
    anchor.appendChild(dd);
    activeBreadcrumbDropdown = dd;

    const dismiss = (e: MouseEvent) => {
      if (!dd.contains(e.target as Node) && e.target !== anchor) {
        dismissBreadcrumbDropdown();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  function renderBreadcrumbs() {
    breadcrumbsPathEl.innerHTML = '';
    dismissBreadcrumbDropdown();

    const chain: string[] = [];
    let cur: string | undefined = currentFile;
    while (cur) {
      chain.unshift(cur);
      const file = vault.getFile(cur);
      cur = file?.parent;
      if (chain.length > 10) break;
    }

    // Root breadcrumb — click shows all root files
    const rootCrumb = document.createElement('span');
    rootCrumb.className = 'breadcrumb-item breadcrumb-root';
    rootCrumb.innerHTML = `<span class="breadcrumb-icon">${iconFolder()}</span>kivi`;
    rootCrumb.addEventListener('click', () => {
      const allFiles = [...vault.files.entries()].map(([p, f]) => ({
        label: f.title, icon: iconFileMarkdown(), path: p,
      }));
      showBreadcrumbDropdown(rootCrumb, allFiles);
    });
    breadcrumbsPathEl.appendChild(rootCrumb);

    // Directory breadcrumb — click shows sibling files in that folder
    const fileParts = currentFile.split('/');
    if (fileParts.length > 1) {
      const dirPath = fileParts.slice(0, -1).join('/');
      const addSep = () => {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '›';
        breadcrumbsPathEl.appendChild(sep);
      };
      addSep();
      const dirCrumb = document.createElement('span');
      dirCrumb.className = 'breadcrumb-item';
      dirCrumb.innerHTML = `<span class="breadcrumb-icon">${iconFolderOpen()}</span>${dirPath}`;
      dirCrumb.addEventListener('click', () => {
        const siblings = [...vault.files.entries()]
          .filter(([p]) => p.startsWith(dirPath + '/') && !p.slice(dirPath.length + 1).includes('/'))
          .map(([p, f]) => ({ label: f.title, icon: iconFileMarkdown(), path: p }));
        showBreadcrumbDropdown(dirCrumb, siblings);
      });
      breadcrumbsPathEl.appendChild(dirCrumb);
    }

    // Parent chain — each clickable with dropdown of siblings
    for (let i = 0; i < chain.length; i++) {
      const filePath = chain[i];
      const file = vault.getFile(filePath);
      const title = file?.title || filePath;

      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '›';
      breadcrumbsPathEl.appendChild(sep);

      if (i === chain.length - 1) {
        const span = document.createElement('span');
        span.className = 'breadcrumb-current';
        span.innerHTML = `<span class="breadcrumb-icon">${iconFileMarkdown()}</span>${title}`;
        // Click on current file shows outline headings
        span.style.cursor = 'pointer';
        span.addEventListener('click', () => {
          const outline = editor.getOutline();
          if (outline.length > 0) {
            showBreadcrumbDropdown(span, outline.map(h => ({
              label: `${'  '.repeat(h.level - 1)}${h.text}`,
              icon: `<span style="font-size:9px;font-weight:700;opacity:0.5">H${h.level}</span>`,
              path: currentFile,
            })));
          }
        });
        breadcrumbsPathEl.appendChild(span);
      } else {
        const link = document.createElement('span');
        link.className = 'breadcrumb-item';
        link.innerHTML = `<span class="breadcrumb-icon">${iconFileMarkdown()}</span>${title}`;
        link.addEventListener('click', () => {
          // Show children of this parent
          const children = vault.getFile(filePath)?.children || [];
          if (children.length > 0) {
            showBreadcrumbDropdown(link, children.map(p => ({
              label: vault.getFile(p)?.title || p,
              icon: iconFileMarkdown(),
              path: p,
            })));
          } else {
            loadFile(filePath);
          }
        });
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
        settings.wordWrap = true;
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
  let graphMode: GraphMode = 'local';
  let graphControlsWired = false;

  function getGraphFilter() {
    const filterInput = document.getElementById('graph-filter') as HTMLInputElement;
    const edgeToggles = document.querySelectorAll<HTMLInputElement>('#graph-edge-toggles input');
    const edgeTypes: EdgeType[] = [];
    edgeToggles.forEach(cb => { if (cb.checked) edgeTypes.push(cb.value as EdgeType); });
    return {
      mode: graphMode,
      focusNode: graphMode === 'local' ? currentFile : undefined,
      depth: 999,
      query: filterInput?.value.trim() || '',
      edgeTypes,
      tags: [] as string[],
      orphansOnly: false,
    };
  }

  function refreshGraph() {
    if (!graphRenderer) return;
    const filter = getGraphFilter();
    const data = vault.getGraph(filter);
    graphRenderer.setData(data, filter.focusNode);
    const gc = document.getElementById('graph-container')!;
    graphRenderer.resize(gc.clientWidth, gc.clientHeight);
    buildLegend();
  }

  function buildLegend() {
    // Edge types are shown inline in the header toggles; no separate legend needed
  }

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
    refreshGraph();
    if (!graphControlsWired) wireGraphControls();
  }

  function closeGraph() { document.getElementById('graph-overlay')!.style.display = 'none'; }

  function wireGraphControls() {
    graphControlsWired = true;
    const filterInput = document.getElementById('graph-filter') as HTMLInputElement;
    const edgeToggles = document.querySelectorAll<HTMLInputElement>('#graph-edge-toggles input');
    const modeTabs = document.querySelectorAll<HTMLButtonElement>('.graph-tab');

    filterInput?.addEventListener('input', debounce(refreshGraph, 200));
    edgeToggles.forEach(cb => cb.addEventListener('change', refreshGraph));
    modeTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        modeTabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        graphMode = (tab.dataset.mode || 'local') as GraphMode;
        refreshGraph();
      });
    });
  }

  document.getElementById('close-graph')!.addEventListener('click', closeGraph);

  // ── Graph search bar (Ctrl/Cmd+F) ──
  function openGraphSearch() {
    const bar = document.getElementById('graph-search-bar');
    const input = document.getElementById('graph-filter') as HTMLInputElement;
    if (!bar || !input) return;
    bar.style.display = 'flex';
    input.focus();
    input.select();
  }
  function closeGraphSearch() {
    const bar = document.getElementById('graph-search-bar');
    const input = document.getElementById('graph-filter') as HTMLInputElement;
    if (!bar) return;
    bar.style.display = 'none';
    if (input) { input.value = ''; input.dispatchEvent(new Event('input')); }
    document.getElementById('graph-container')?.querySelector('canvas')?.focus();
  }
  document.getElementById('graph-search-close')?.addEventListener('click', closeGraphSearch);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'g') { e.preventDefault(); openGraph(); }
    const overlay = document.getElementById('graph-overlay');
    const isGraphOpen = overlay && overlay.style.display !== 'none' && overlay.style.display !== '';
    if (!isGraphOpen) return;

    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      openGraphSearch();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      const searchBar = document.getElementById('graph-search-bar');
      if (searchBar && searchBar.style.display !== 'none') {
        closeGraphSearch();
      } else {
        closeGraph();
      }
    }
  });

  // ── Panel system: sections are drag-and-drop between left/right panes ──
  const sectionElements: Record<SectionId, HTMLElement> = {
    explorer: document.getElementById('section-explorer')!,
    tags: document.getElementById('section-tags')!,
    backlinks: document.getElementById('section-backlinks')!,
    outline: document.getElementById('section-outline')!,
    warnings: document.getElementById('section-warnings')!,
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
    for (const id of (['explorer', 'tags', 'backlinks', 'outline', 'warnings'] as SectionId[])) {
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

    // ── Right section: word wrap toggle ─────────────────────────
    const wrapBtn = document.createElement('button');
    wrapBtn.className = 'toolbar-btn';
    wrapBtn.type = 'button';
    wrapBtn.title = 'Toggle Word Wrap';
    wrapBtn.setAttribute('aria-label', 'Toggle word wrap');
    wrapBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10"/><path d="M3 8h7a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2H8"/><polyline points="9.5,10.5 8,12 9.5,13.5"/></svg>';
    function applyWordWrap() {
      const pm = document.querySelector('#editor .ProseMirror') as HTMLElement | null;
      if (pm) {
        pm.classList.toggle('kivi-word-wrap', settings.wordWrap);
      }
      if (sourceTextarea) {
        sourceTextarea.style.whiteSpace = settings.wordWrap ? 'pre-wrap' : 'pre';
        sourceTextarea.wrap = settings.wordWrap ? 'soft' : 'off';
        requestAnimationFrame(() => refreshSourceLineGutter());
      }
      wrapBtn.classList.toggle('active', settings.wordWrap);
    }
    wrapBtn.addEventListener('click', () => {
      settings.wordWrap = !settings.wordWrap;
      applyWordWrap();
      saveSettings(settings);
    });
    toolbarRight.appendChild(wrapBtn);
    applyWordWrap();

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
      requestAnimationFrame(() => graphRenderer?.refreshTheme());
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
  renderTags();
  renderWarnings();
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
