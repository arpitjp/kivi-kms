/**
 * Thin wrapper around Monaco Editor for the raw/source mode.
 *
 * Provides a markdown-configured Monaco instance with:
 * - Markdown syntax highlighting (built-in)
 * - Word wrap (toggleable)
 * - Line numbers with correct wrap-aware numbering
 * - Built-in find/replace (Ctrl/Cmd+F / Ctrl/Cmd+H)
 * - Code folding via markdown heading regions
 * - Git diff decorations (gutter bar)
 * - Git blame inline decorations
 */

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

export type MonacoRawEditor = ReturnType<typeof createMonacoRawEditor>;

export interface MonacoRawEditorOptions {
  container: HTMLElement;
  value?: string;
  wordWrap?: boolean;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  readOnly?: boolean;
  onGutterClick?: (lineNumber: number) => void;
}

export interface BlameEntry {
  hash: string;
  author: string;
  authorTime: number;
  summary: string;
  currentLine: number;
}

export interface DiffMark {
  type: 'added' | 'modified' | 'deleted';
  startLine: number;
  endLine: number;
}

// Re-export monaco for type access
export { monaco };

let themeRegistered = false;
function ensureMarkdownTheme() {
  if (themeRegistered) return;
  themeRegistered = true;

  // The ESM build of Monaco ships no languages — register markdown explicitly.
  monaco.languages.register({
    id: 'markdown',
    extensions: ['.md', '.markdown', '.mdown', '.mkdn', '.mkd'],
    aliases: ['Markdown', 'markdown', 'md'],
    mimetypes: ['text/markdown'],
  });

  monaco.languages.setLanguageConfiguration('markdown', {
    brackets: [['(', ')'], ['[', ']'], ['{', '}']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '`', close: '`' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '*', close: '*' },
      { open: '_', close: '_' },
      { open: '~', close: '~' },
      { open: '$', close: '$' },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '`', close: '`' },
      { open: '*', close: '*' },
      { open: '_', close: '_' },
      { open: '~', close: '~' },
      { open: '$', close: '$' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    folding: {
      markers: {
        start: /^\s*<!--\s*#?region\b.*-->/,
        end: /^\s*<!--\s*#?endregion\b.*-->/,
      },
    },
  });

  // Register a rich Monarch tokenizer so we control token names precisely.
  monaco.languages.setMonarchTokensProvider('markdown', {
    defaultToken: '',
    tokenPostfix: '.md',

    escapes: /\\[\\`*_{}\[\]()#+\-.!~=]/,

    tokenizer: {
      root: [
        [/^---\s*$/, { token: 'meta', next: '@frontmatter' }],
        [/^\s*`{3,}\s*(\S+)?\s*$/, { token: 'string.code.fence', next: '@codeblock' }],
        [/^\$\$\s*$/, { token: 'keyword.math', next: '@mathblock' }],
        [/^(\s{0,3})(#{1,6}\s)(.+)$/, ['white', 'keyword.heading', 'keyword.heading']],
        [/^\s*>\s+/, 'comment.quote'],
        [/^\s*[-*+]\s+\[[ xX]\]\s/, 'keyword.checkbox'],
        [/^\s*[-*+]\s/, 'keyword.list'],
        [/^\s*\d+[.)]\s/, 'keyword.list'],
        [/^\s*[-*_]{3,}\s*$/, 'keyword.hr'],
        [/^\|/, { token: 'keyword.table', next: '@tableline' }],
        { include: '@inline' },
      ],

      inline: [
        [/@escapes/, 'string.escape'],
        [/`[^`]+`/, 'variable.code'],
        [/\*\*([^*\\]|@escapes|\*(?!\*))+\*\*/, 'strong'],
        [/__([^_\\]|@escapes|_(?!_))+__/, 'strong'],
        [/\*([^*\\]|@escapes)+\*/, 'emphasis'],
        [/_([^_\\]|@escapes)+_/, 'emphasis'],
        [/~~([^~\\]|@escapes)+~~/, 'strikethrough'],
        [/==[^=]+==/,  'constant.highlight'],
        [/\$[^$]+\$/, 'number.math'],
        [/\[\[[^\]]+\]\]/, 'string.link.wiki'],
        [/!\[[^\]]*\]\([^)]+\)/, 'string.link.image'],
        [/\[[^\]]*\]\([^)]+\)/, 'string.link'],
        [/\[[^\]]*\]\[[^\]]*\]/, 'string.link'],
        [/<https?:\/\/[^>]+>/, 'string.link'],
        [/<[a-zA-Z][\w-]*[^>]*\/?>/, 'tag'],
        [/<\/[a-zA-Z][\w-]*>/, 'tag'],
        [/(?:^|\s)#[a-zA-Z0-9_/][a-zA-Z0-9_/-]*/, 'type.hashtag'],
      ],

      frontmatter: [
        [/^---\s*$/, { token: 'meta', next: '@pop' }],
        [/^[a-zA-Z_][\w-]*:/, 'variable.key'],
        [/.*/, 'meta.value'],
      ],

      codeblock: [
        [/^\s*`{3,}\s*$/, { token: 'string.code.fence', next: '@pop' }],
        [/.*/, 'variable.source'],
      ],

      mathblock: [
        [/^\$\$\s*$/, { token: 'keyword.math', next: '@pop' }],
        [/.*/, 'number.math'],
      ],

      tableline: [
        [/$/, { token: '', next: '@pop' }],
        [/\|/, 'keyword.table'],
        [/[-:]+/, 'keyword.table'],
        { include: '@inline' },
      ],
    },
  } as monaco.languages.IMonarchLanguage);

  // Themes are created dynamically in applyVscodeTheme() which reads CSS vars.
  // Register fallback themes here so Monaco doesn't error before the first apply.
  monaco.editor.defineTheme('kivi-markdown-dark', {
    base: 'vs-dark', inherit: true, colors: {}, rules: [],
  });
  monaco.editor.defineTheme('kivi-markdown-light', {
    base: 'vs', inherit: true, colors: {}, rules: [],
  });
}

function cssVar(name: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

function hexFromCssColor(cssColor: string): string {
  if (cssColor.startsWith('#')) return cssColor.replace('#', '');
  const m = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    const [, r, g, b] = m;
    return [r, g, b].map(c => parseInt(c).toString(16).padStart(2, '0')).join('');
  }
  return cssColor.replace('#', '');
}

function applyVscodeTheme(isDark: boolean) {
  const fg = hexFromCssColor(cssVar('--vscode-editor-foreground', isDark ? 'cccccc' : '333333'));
  const bg = hexFromCssColor(cssVar('--vscode-editor-background', isDark ? '1e1e1e' : 'ffffff'));
  const link = hexFromCssColor(cssVar('--vscode-textLink-foreground', isDark ? '4fc1ff' : '006ab1'));
  const keyword = hexFromCssColor(cssVar('--vscode-symbolIcon-keywordForeground', isDark ? '569cd6' : '0000ff'));
  const str = hexFromCssColor(cssVar('--vscode-symbolIcon-stringForeground', isDark ? 'ce9178' : 'a31515'));
  const number = hexFromCssColor(cssVar('--vscode-symbolIcon-numberForeground', isDark ? 'b5cea8' : '098658'));
  const variable = hexFromCssColor(cssVar('--vscode-symbolIcon-variableForeground', isDark ? '9cdcfe' : '001080'));
  const comment = hexFromCssColor(cssVar('--vscode-symbolIcon-enumeratorForeground', isDark ? '6a9955' : '008000'));
  const type = hexFromCssColor(cssVar('--vscode-symbolIcon-typeParameterForeground', isDark ? '4ec9b0' : '267f99'));
  const muted = hexFromCssColor(cssVar('--vscode-disabledForeground', isDark ? '808080' : '808080'));
  const strongFg = hexFromCssColor(cssVar('--vscode-editor-foreground', isDark ? 'e0e0e0' : '333333'));

  const rules: monaco.editor.ITokenThemeRule[] = [
    { token: 'keyword.heading.md', foreground: keyword, fontStyle: 'bold' },
    { token: 'keyword.list.md', foreground: keyword },
    { token: 'keyword.hr.md', foreground: keyword },
    { token: 'keyword.checkbox.md', foreground: keyword },
    { token: 'keyword.table.md', foreground: keyword },
    { token: 'keyword.math.md', foreground: number },
    { token: 'strong.md', fontStyle: 'bold', foreground: strongFg },
    { token: 'emphasis.md', fontStyle: 'italic', foreground: variable },
    { token: 'strikethrough.md', fontStyle: 'strikethrough', foreground: muted },
    { token: 'variable.code.md', foreground: str },
    { token: 'variable.source.md', foreground: str },
    { token: 'variable.key.md', foreground: variable },
    { token: 'string.link.md', foreground: link, fontStyle: 'underline' },
    { token: 'string.link.wiki.md', foreground: link, fontStyle: 'underline' },
    { token: 'string.link.image.md', foreground: link },
    { token: 'string.code.fence.md', foreground: str },
    { token: 'string.escape.md', foreground: str },
    { token: 'comment.quote.md', foreground: comment, fontStyle: 'italic' },
    { token: 'tag.md', foreground: muted },
    { token: 'meta.md', foreground: keyword },
    { token: 'meta.value.md', foreground: comment },
    { token: 'constant.highlight.md', foreground: isDark ? 'fde68a' : '92600c' },
    { token: 'number.math.md', foreground: number },
    { token: 'type.hashtag.md', foreground: type },
  ];

  const themeName = isDark ? 'kivi-markdown-dark' : 'kivi-markdown-light';
  monaco.editor.defineTheme(themeName, {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    colors: {
      'editor.background': `#${bg}`,
      'editor.foreground': `#${fg}`,
    },
    rules,
  });
  monaco.editor.setTheme(themeName);
}

export function createMonacoRawEditor(opts: MonacoRawEditorOptions) {
  ensureMarkdownTheme();

  const isDark = document.body.classList.contains('vscode-dark')
    || document.body.classList.contains('vscode-high-contrast');
  applyVscodeTheme(isDark);

  const editor = monaco.editor.create(opts.container, {
    value: opts.value ?? '',
    language: 'markdown',
    theme: isDark ? 'kivi-markdown-dark' : 'kivi-markdown-light',
    automaticLayout: true,
    wordWrap: opts.wordWrap ? 'on' : 'off',
    fontSize: opts.fontSize ?? 14,
    fontFamily: opts.fontFamily ?? "'Menlo', 'Monaco', 'Courier New', monospace",
    lineHeight: opts.lineHeight ?? 0,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    lineNumbers: 'on',
    glyphMargin: true,
    folding: true,
    foldingStrategy: 'indentation',
    lineDecorationsWidth: 5,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
    },
    padding: { top: 16, bottom: 16 },
    readOnly: opts.readOnly ?? false,
    contextmenu: true,
    // Find widget built-in
    find: {
      addExtraSpaceOnTop: false,
      autoFindInSelection: 'never',
      seedSearchStringFromSelection: 'selection',
    },
    tabSize: 2,
    insertSpaces: true,
    renderWhitespace: 'none',
    guides: { indentation: false },
    occurrencesHighlight: 'singleFile',
    selectionHighlight: true,
    bracketPairColorization: { enabled: false },
    matchBrackets: 'never',
  });

  // Markdown heading-based folding — scoped to this editor's model
  const foldingProviderDisposable = monaco.languages.registerFoldingRangeProvider('markdown', {
    provideFoldingRanges(model) {
      if (model !== editor.getModel()) return [];
      const ranges: monaco.languages.FoldingRange[] = [];
      const lines = model.getLineCount();
      const headingStack: { level: number; start: number }[] = [];

      for (let i = 1; i <= lines; i++) {
        const line = model.getLineContent(i);
        const match = /^(#{1,6})\s/.exec(line);
        if (match) {
          const level = match[1].length;
          while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
            const prev = headingStack.pop()!;
            const endLine = i - 1;
            if (endLine > prev.start) {
              ranges.push({
                start: prev.start,
                end: endLine,
                kind: monaco.languages.FoldingRangeKind.Region,
              });
            }
          }
          headingStack.push({ level, start: i });
        }
      }

      // Close remaining
      for (const item of headingStack) {
        if (lines > item.start) {
          ranges.push({
            start: item.start,
            end: lines,
            kind: monaco.languages.FoldingRangeKind.Region,
          });
        }
      }

      return ranges;
    },
  });

  // Re-apply theme when VS Code switches between dark/light/high-contrast.
  const themeObserver = new MutationObserver(() => {
    const dark = document.body.classList.contains('vscode-dark')
      || document.body.classList.contains('vscode-high-contrast');
    applyVscodeTheme(dark);
  });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // Gutter click → fire callback (diff popup on changed gutter decorations only)
  if (opts.onGutterClick) {
    const cb = opts.onGutterClick;
    editor.onMouseDown((e) => {
      if (
        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
      ) {
        const line = e.target.position?.lineNumber;
        if (line) cb(line);
      }
    });
  }

  // Git blame context menu actions
  let blameActionDisposable: monaco.IDisposable | null = null;
  let copyShaDisposable: monaco.IDisposable | null = null;
  let copyMsgDisposable: monaco.IDisposable | null = null;
  let onToggleBlameCallback: (() => void) | null = null;

  function getBlameEntryAtCursor(): BlameEntry | null {
    const pos = editor.getPosition();
    if (!pos || currentBlameEntries.length === 0) return null;
    return blameByLine.get(pos.lineNumber) ?? null;
  }

  function setOnToggleBlame(cb: () => void) {
    onToggleBlameCallback = cb;
    if (!blameActionDisposable) {
      blameActionDisposable = editor.addAction({
        id: 'kivi.toggleBlame',
        label: 'Toggle Git Blame',
        contextMenuGroupId: '9_kivi',
        contextMenuOrder: 1,
        run: () => { onToggleBlameCallback?.(); },
      });
      copyShaDisposable = editor.addAction({
        id: 'kivi.copyCommitSha',
        label: 'Copy Commit SHA',
        contextMenuGroupId: '9_kivi',
        contextMenuOrder: 2,
        precondition: undefined,
        run: () => {
          const entry = getBlameEntryAtCursor();
          if (entry && !entry.hash.startsWith('0000000')) {
            navigator.clipboard.writeText(entry.hash).catch(() => {});
          }
        },
      });
      copyMsgDisposable = editor.addAction({
        id: 'kivi.copyCommitMessage',
        label: 'Copy Commit Message',
        contextMenuGroupId: '9_kivi',
        contextMenuOrder: 3,
        run: () => {
          const entry = getBlameEntryAtCursor();
          if (entry && !entry.hash.startsWith('0000000')) {
            navigator.clipboard.writeText(entry.summary).catch(() => {});
          }
        },
      });
    }
  }

  let diffDecorations: string[] = [];
  let blameDecorations: string[] = [];
  let currentBlameEntries: BlameEntry[] = [];
  let blameByLine = new Map<number, BlameEntry>();

  // Blame hover — scoped to this editor instance's model to avoid cross-editor interference
  const blameHoverDisposable = monaco.languages.registerHoverProvider('markdown', {
    provideHover(model, position) {
      if (model !== editor.getModel()) return null;
      if (currentBlameEntries.length === 0) return null;
      const entry = blameByLine.get(position.lineNumber);
      if (!entry) return null;
      const isUncommitted = entry.hash.startsWith('0000000');
      let md: string;
      if (isUncommitted) {
        md = '**Not Yet Committed**\n\nUncommitted changes';
      } else {
        const d = new Date(entry.authorTime * 1000);
        const dateStr = d.toLocaleString(undefined, {
          weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        md = `**${entry.author}** \u2022 ${timeAgo(entry.authorTime)}\n\n` +
          `\`${entry.hash.slice(0, 8)}\` \u2014 ${entry.summary}\n\n` +
          `${dateStr}`;
      }
      return {
        range: new monaco.Range(position.lineNumber, 1, position.lineNumber, 1),
        contents: [{ value: md }],
      };
    },
  });

  function setDiffMarks(marks: DiffMark[]) {
    const model = editor.getModel();
    if (!model) return;

    const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (const mark of marks) {
      if (mark.type === 'added') {
        newDecorations.push({
          range: new monaco.Range(mark.startLine, 1, mark.endLine, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: 'dirty-diff-glyph dirty-diff-added',
          },
        });
      } else if (mark.type === 'modified') {
        newDecorations.push({
          range: new monaco.Range(mark.startLine, 1, mark.endLine, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: 'dirty-diff-glyph dirty-diff-modified',
          },
        });
      } else if (mark.type === 'deleted') {
        const line = Math.max(1, mark.startLine);
        newDecorations.push({
          range: new monaco.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER),
          options: {
            isWholeLine: false,
            linesDecorationsClassName: 'dirty-diff-glyph dirty-diff-deleted',
          },
        });
      }
    }
    diffDecorations = editor.deltaDecorations(diffDecorations, newDecorations);
  }

  function setBlameInfo(entries: BlameEntry[]) {
    currentBlameEntries = entries;
    blameByLine = new Map(entries.map(e => [e.currentLine + 1, e]));
    const model = editor.getModel();
    if (!model) {
      blameDecorations = editor.deltaDecorations(blameDecorations, []);
      return;
    }

    // Assign stable colors to commits for glyph margin dots
    const commitColorMap = new Map<string, number>();
    let colorIdx = 0;
    for (const e of entries) {
      if (!commitColorMap.has(e.hash)) {
        commitColorMap.set(e.hash, colorIdx++ % 8);
      }
    }

    const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];
    let prevHash = '';

    for (const entry of entries) {
      const lineNum = entry.currentLine + 1;
      if (lineNum < 1 || lineNum > model.getLineCount()) continue;

      const isUncommitted = entry.hash.startsWith('0000000');
      const isSameCommit = entry.hash === prevHash;
      const isFirstOfGroup = !isSameCommit;
      prevHash = entry.hash;

      const blameText = isFirstOfGroup
        ? isUncommitted
          ? 'You \u2022 Uncommitted'
          : `${entry.author.split(' ')[0]} \u2022 ${timeAgo(entry.authorTime)} \u2022 ${entry.summary.slice(0, 40)}${entry.summary.length > 40 ? '\u2026' : ''}`
        : '';

      const ci = commitColorMap.get(entry.hash) ?? 0;
      const decOpts: monaco.editor.IModelDecorationOptions = {
        glyphMarginClassName: `kivi-blame-dot kivi-blame-dot-${ci}`,
      };

      if (blameText) {
        decOpts.after = {
          content: `\u00A0\u00A0${blameText}\u00A0\u00A0`,
          inlineClassName: 'kivi-monaco-blame-inline',
        };
      }

      newDecorations.push({
        range: new monaco.Range(lineNum, 1, lineNum, 1),
        options: decOpts,
      });
    }

    blameDecorations = editor.deltaDecorations(blameDecorations, newDecorations);
  }

  function clearBlame() {
    currentBlameEntries = [];
    blameByLine = new Map();
    blameDecorations = editor.deltaDecorations(blameDecorations, []);
  }

  function getValue(): string {
    return editor.getValue();
  }

  function setValue(content: string, preserveState = true) {
    const model = editor.getModel();
    if (!model) return;
    if (preserveState) {
      const viewState = editor.saveViewState();
      model.setValue(content);
      if (viewState) editor.restoreViewState(viewState);
    } else {
      model.setValue(content);
    }
  }

  function setWordWrap(enabled: boolean) {
    editor.updateOptions({ wordWrap: enabled ? 'on' : 'off' });
  }

  function setFontSize(size: number) {
    editor.updateOptions({ fontSize: size });
  }

  function setFontFamily(family: string) {
    editor.updateOptions({ fontFamily: family });
  }

  function setTheme(isDark: boolean) {
    applyVscodeTheme(isDark);
  }

  function openFind() {
    editor.focus();
    editor.trigger('keyboard', 'actions.find', null);
  }

  function openReplace() {
    editor.focus();
    editor.trigger('keyboard', 'editor.action.startFindReplaceAction', null);
  }

  function focus() {
    editor.focus();
  }

  function layout() {
    editor.layout();
  }

  function getScrollTop(): number {
    return editor.getScrollTop();
  }

  function setScrollTop(top: number) {
    editor.setScrollTop(top);
  }

  function getScrollHeight(): number {
    return editor.getScrollHeight();
  }

  function getClientHeight(): number {
    return editor.getLayoutInfo().height;
  }

  function getPosition(): { lineNumber: number; column: number } | null {
    return editor.getPosition();
  }

  function setPosition(lineNumber: number, column: number) {
    editor.setPosition({ lineNumber, column });
    editor.revealLineInCenter(lineNumber);
  }

  function onDidChangeContent(cb: (content: string) => void): monaco.IDisposable {
    return editor.onDidChangeModelContent(() => {
      cb(editor.getValue());
    });
  }

  function onDidScrollChange(cb: (scrollTop: number) => void): monaco.IDisposable {
    return editor.onDidScrollChange((e) => {
      cb(e.scrollTop);
    });
  }

  function revealLine(line: number) {
    editor.revealLineInCenter(line);
  }

  function dispose() {
    themeObserver.disconnect();
    clearBlame();
    blameActionDisposable?.dispose();
    copyShaDisposable?.dispose();
    copyMsgDisposable?.dispose();
    blameHoverDisposable.dispose();
    foldingProviderDisposable.dispose();
    editor.dispose();
  }

  function getEditor(): monaco.editor.IStandaloneCodeEditor {
    return editor;
  }

  return {
    editor: getEditor,
    getValue,
    setValue,
    setWordWrap,
    setFontSize,
    setFontFamily,
    setTheme,
    setDiffMarks,
    setBlameInfo,
    clearBlame,
    openFind,
    openReplace,
    focus,
    layout,
    getScrollTop,
    setScrollTop,
    getScrollHeight,
    getClientHeight,
    getPosition,
    setPosition,
    onDidChangeContent,
    onDidScrollChange,
    revealLine,
    setOnToggleBlame,
    dispose,
  };
}

function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
  return `${Math.floor(diff / 31536000)}y ago`;
}
