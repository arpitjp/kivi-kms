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

export function createMonacoRawEditor(opts: MonacoRawEditorOptions) {
  const editor = monaco.editor.create(opts.container, {
    value: opts.value ?? '',
    language: 'markdown',
    theme: 'vs-dark',
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
    lineDecorationsWidth: 4,
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

  // Markdown heading-based folding
  const foldingProviderDisposable = monaco.languages.registerFoldingRangeProvider('markdown', {
    provideFoldingRanges(model) {
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

  // Gutter click → fire callback (for diff popup, blame detail, etc.)
  if (opts.onGutterClick) {
    const cb = opts.onGutterClick;
    editor.onMouseDown((e) => {
      if (
        e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS ||
        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
      ) {
        const line = e.target.position?.lineNumber;
        if (line) cb(line);
      }
    });
  }

  let diffDecorations: string[] = [];
  let blameDecorations: string[] = [];
  let blameWidgets: monaco.editor.IContentWidget[] = [];

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
            linesDecorationsClassName: 'kivi-monaco-gutter-added',
          },
        });
      } else if (mark.type === 'modified') {
        newDecorations.push({
          range: new monaco.Range(mark.startLine, 1, mark.endLine, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: 'kivi-monaco-gutter-modified',
          },
        });
      } else if (mark.type === 'deleted') {
        const line = Math.max(1, mark.startLine);
        newDecorations.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: 'kivi-monaco-gutter-deleted',
          },
        });
      }
    }
    diffDecorations = editor.deltaDecorations(diffDecorations, newDecorations);
  }

  function setBlameInfo(entries: BlameEntry[]) {
    // Remove old widgets
    for (const w of blameWidgets) {
      editor.removeContentWidget(w);
    }
    blameWidgets = [];

    const model = editor.getModel();
    if (!model) {
      blameDecorations = editor.deltaDecorations(blameDecorations, []);
      return;
    }

    const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];
    let prevHash = '';

    for (const entry of entries) {
      const lineNum = entry.currentLine + 1; // 0-indexed → 1-indexed
      if (lineNum < 1 || lineNum > model.getLineCount()) continue;

      const isUncommitted = entry.hash.startsWith('0000000');
      const isSameCommit = entry.hash === prevHash;
      prevHash = entry.hash;

      const text = isSameCommit
        ? ''
        : isUncommitted
          ? 'You • Uncommitted'
          : `${entry.author.split(' ')[0]}, ${timeAgo(entry.authorTime)}`;

      if (text) {
        newDecorations.push({
          range: new monaco.Range(lineNum, 1, lineNum, 1),
          options: {
            after: {
              content: `  ${text}  `,
              inlineClassName: 'kivi-monaco-blame-inline',
            },
          },
        });
      }
    }

    blameDecorations = editor.deltaDecorations(blameDecorations, newDecorations);
  }

  function clearBlame() {
    for (const w of blameWidgets) {
      editor.removeContentWidget(w);
    }
    blameWidgets = [];
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
    monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
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
    clearBlame();
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
