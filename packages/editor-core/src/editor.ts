import { Editor, Extension, InputRule } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Code from '@tiptap/extension-code';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Underline from '@tiptap/extension-underline';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Highlight from '@tiptap/extension-highlight';
import Placeholder from '@tiptap/extension-placeholder';
import type { EditorConfig, EditorUpdateCallback, KiviDocument, SourceMap, SearchOptions } from '@kivi/shared-types';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';
import { serializeDocument } from '@kivi/markdown-serializer';
import { parseMarkdownAsync } from './worker/index.js';
import { Frontmatter } from './extensions/frontmatter.js';
import { MathBlock, MathInline } from './extensions/math.js';
import { FootnoteRef, FootnoteDef } from './extensions/footnote.js';
import { KiviSearch, searchPluginKey } from './extensions/search.js';
import { KiviClipboard } from './extensions/clipboard.js';
import { DirtyTracker, getDirtyBlockIndices, applyDirtyFlags, resetDirtyTracking } from './extensions/dirty-tracker.js';
import { WikiLink } from './extensions/wiki-link.js';
import { HashTag } from './extensions/hashtag.js';
import { TocBlock } from './extensions/toc.js';
import { SlashCommands } from './extensions/slash-commands.js';
import { MermaidBlock } from './extensions/mermaid.js';
import { ExcalidrawBlock } from './extensions/excalidraw.js';
import { TableControls } from './extensions/table-controls.js';
import { ImageControls } from './extensions/image-controls.js';
import { LinkPopup } from './extensions/link-popup.js';
import { CodeBlockEnhanced } from './extensions/code-block-enhanced.js';
import { SelectionToolbar } from './extensions/selection-toolbar.js';
import { DevWatchdog } from './extensions/dev-watchdog.js';
import { LinkPreviewExtension } from './extensions/link-preview.js';
import type { DetectedLink, LinkPreviewData } from './extensions/link-preview.js';
import { SmartTypography } from './extensions/smart-typography.js';
import { Video, Audio } from './extensions/video.js';

import { CursorFix } from './extensions/cursor-fix.js';
import { BlockCopyControls } from './extensions/block-copy-controls.js';
import { LinkSuggest } from './extensions/link-suggest.js';
import { CalloutDecoration } from './extensions/callout.js';

export interface KiviEditorOptions extends EditorConfig {}

const _PERF_LOG = typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>).__KIVI_DEV__ === true;

export class KiviEditor {
  private editor: Editor;
  private kiviDoc: KiviDocument | null = null;
  private updateCallbacks: EditorUpdateCallback[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs = 300;
  private suppressUpdates = false;

  constructor(options: KiviEditorOptions) {
    this.editor = new Editor({
      element: options.element,
      editable: !options.readOnly,
      autofocus: options.autoFocus ?? false,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          codeBlock: { HTMLAttributes: { class: 'kivi-code-block' } },
          code: false,
        }),
        Code.extend({
          exitable: false,
          addInputRules() { return []; },

          addKeyboardShortcuts() {
            const parentShortcuts = this.parent?.() ?? {};
            return {
              ...parentShortcuts,
              ArrowRight: () => {
                const { state } = this.editor;
                const { $from, empty } = state.selection;
                if (!empty) return false;

                const codeType = state.schema.marks.code;
                if (!codeType || !codeType.isInSet($from.marks())) return false;

                const afterHasCode = $from.nodeAfter?.marks.some(
                  (m) => m.type === codeType,
                ) ?? false;
                if (afterHasCode) return false;

                const tr = state.tr;
                const after = $from.parent.textContent.charAt($from.parentOffset);
                if (!after) {
                  tr.insertText(' ', $from.pos);
                  tr.setSelection(TextSelection.create(tr.doc, $from.pos + 1));
                } else {
                  const newPos = $from.pos + 1;
                  if (newPos <= state.doc.content.size) {
                    tr.setSelection(TextSelection.create(state.doc, newPos));
                  }
                }
                tr.setStoredMarks(
                  $from.marks().filter((m: any) => m.type !== codeType),
                );
                tr.setMeta('kiviSmartTypoHandled', true);
                tr.setMeta('smartTypoContinue', null);
                this.editor.view.dispatch(tr.scrollIntoView());
                return true;
              },

              ArrowLeft: () => {
                const { state } = this.editor;
                const { $from, empty } = state.selection;
                if (!empty) return false;

                const codeType = state.schema.marks.code;
                if (!codeType || !codeType.isInSet($from.marks())) return false;

                const beforeHasCode = $from.nodeBefore?.marks.some(
                  (m: any) => m.type === codeType,
                ) ?? false;
                if (beforeHasCode) return false;

                const newPos = $from.pos - 1;
                const tr = state.tr;
                if (newPos >= 0) {
                  tr.setSelection(TextSelection.create(state.doc, newPos));
                }
                tr.setStoredMarks(
                  $from.marks().filter((m: any) => m.type !== codeType),
                );
                tr.setMeta('kiviSmartTypoHandled', true);
                tr.setMeta('smartTypoContinue', null);
                this.editor.view.dispatch(tr.scrollIntoView());
                return true;
              },
            };
          },

          addProseMirrorPlugins() {
            const codeType = this.type;
            return [
              new Plugin({
                props: {
                  handleTextInput(
                    view: EditorView,
                    from: number,
                    to: number,
                    text: string,
                  ): boolean {
                    if (from === to) return false;
                    if ('`"\'([{*_~'.includes(text)) return false;

                    const { state } = view;
                    if (!codeType) return false;

                    let allCode = true;
                    let anyCode = false;
                    state.doc.nodesBetween(from, to, (node: any) => {
                      if (node.isText) {
                        if (node.marks.some((m: any) => m.type === codeType)) {
                          anyCode = true;
                        } else {
                          allCode = false;
                        }
                      }
                    });

                    if (!anyCode || !allCode) return false;

                    const tr = state.tr;
                    tr.insertText(text, from, to);
                    tr.addMark(from, from + text.length, codeType.create());
                    tr.setStoredMarks([codeType.create()]);
                    view.dispatch(tr);
                    return true;
                  },
                },
              }),
            ];
          },
        }),
        Link.configure({
          openOnClick: false,
          HTMLAttributes: { class: 'kivi-link' },
        }),
        Image.extend({
          draggable: true,
          addAttributes() {
            return {
              ...this.parent?.(),
              width: {
                default: null,
                parseHTML: (el: HTMLElement) => {
                  const w = el.getAttribute('width');
                  if (!w) return null;
                  if (w === '100%') return '100%';
                  return parseInt(w, 10) || null;
                },
                renderHTML: (attrs: Record<string, unknown>) => {
                  if (!attrs.width) return {};
                  if (attrs.width === '100%') return { width: '100%', style: 'width:100%' };
                  return { width: String(attrs.width) };
                },
              },
              height: {
                default: null,
                parseHTML: (el: HTMLElement) => {
                  const h = el.getAttribute('height');
                  if (!h) return null;
                  return parseInt(h, 10) || null;
                },
                renderHTML: (attrs: Record<string, unknown>) => {
                  if (!attrs.height) return {};
                  return { height: String(attrs.height) };
                },
              },
              'data-align': {
                default: null,
                parseHTML: (el: HTMLElement) => el.getAttribute('data-align') || null,
                renderHTML: (attrs: Record<string, unknown>) => {
                  if (!attrs['data-align']) return {};
                  return { 'data-align': attrs['data-align'] as string };
                },
              },
            };
          },
        }).configure({
          HTMLAttributes: { class: 'kivi-image' },
        }),
        TaskList,
        TaskItem.extend({
          addInputRules() {
            return [
              new InputRule({
                find: /^\s*-?\s*\[([ xX])?\]\s$/,
                handler: ({ state, range, match }) => {
                  const checked = match[1] === 'x';
                  const { schema, tr } = state;
                  const taskItemType = schema.nodes.taskItem;
                  const taskListType = schema.nodes.taskList;
                  if (!taskItemType || !taskListType) return;

                  const $start = state.doc.resolve(range.from);

                  // If already inside a listItem (e.g. user typed `- [ ] `),
                  // bail — tryBulletToTask in SmartTypography handles the
                  // bulletList → taskList conversion without creating a nested list.
                  for (let d = $start.depth; d >= 0; d--) {
                    const name = $start.node(d).type.name;
                    if (name === 'listItem' || name === 'taskItem') return;
                  }

                  const blockFrom = $start.before($start.depth);
                  const blockTo = $start.after($start.depth);

                  const paragraph = schema.nodes.paragraph.createAndFill()!;
                  const taskItem = taskItemType.create({ checked }, paragraph);
                  const taskList = taskListType.create(null, taskItem);

                  tr.replaceWith(blockFrom, blockTo, taskList);
                  tr.setSelection(TextSelection.create(tr.doc, blockFrom + 3));
                  tr.scrollIntoView();
                },
              }),
            ];
          },
        }).configure({ nested: true }),
        Table.configure({ resizable: false }),
        TableRow,
        TableCell.extend({
          addAttributes() {
            return {
              ...this.parent?.(),
              textAlign: {
                default: null,
                parseHTML: (el: HTMLElement) => el.style.textAlign || null,
                renderHTML: (attrs: Record<string, unknown>) => {
                  if (!attrs.textAlign) return {};
                  return { style: `text-align: ${attrs.textAlign}` };
                },
              },
            };
          },
        }),
        TableHeader.extend({
          addAttributes() {
            return {
              ...this.parent?.(),
              textAlign: {
                default: null,
                parseHTML: (el: HTMLElement) => el.style.textAlign || null,
                renderHTML: (attrs: Record<string, unknown>) => {
                  if (!attrs.textAlign) return {};
                  return { style: `text-align: ${attrs.textAlign}` };
                },
              },
            };
          },
        }),
        Underline,
        Subscript,
        Superscript,
        Highlight.configure({ multicolor: false }),
        Placeholder.configure({
          placeholder: options.placeholder || 'Start writing...',
        }),
        Frontmatter,
        MathBlock,
        MathInline,
        FootnoteRef,
        FootnoteDef,
        KiviSearch,
        KiviClipboard.configure({
          imageAdapter: options.imageStorageAdapter,
          fileAdapter: options.fileStorageAdapter,
        }),
        DirtyTracker,
        WikiLink,
        HashTag.configure({
          suggestion: options.tagSuggestion ? { items: options.tagSuggestion.items } : undefined,
        }),
        TocBlock,
        SlashCommands.configure({
          onCreatePage: options.onCreatePage,
          onInsertAsset: options.onInsertAsset,
          promptInput: options.promptInput,
          createExcalidrawFile: options.createExcalidrawFile,
        }),
        MermaidBlock,
        ExcalidrawBlock,
        TableControls,
        ImageControls,
        LinkPopup,
        CodeBlockEnhanced,
        SelectionToolbar,
        Video,
        Audio,
        DevWatchdog,
        SmartTypography,

        CursorFix,
        BlockCopyControls,
        CalloutDecoration,
        ...(options.linkSuggest ? (() => {
          try {
            return [LinkSuggest.configure({
              getFiles: options.linkSuggest!.getFiles,
            })];
          } catch { return []; }
        })() : []),
        LinkPreviewExtension.configure({
          onResolveLink: options.onResolveLink
            ? async (link: DetectedLink) => {
                const result = await options.onResolveLink!({ kind: link.kind, target: link.target, alias: link.alias });
                return result as LinkPreviewData | null;
              }
            : undefined,
          onNavigate: options.onNavigateLink
            ? (link: DetectedLink) => {
                options.onNavigateLink!({ kind: link.kind, target: link.target, alias: link.alias });
              }
            : undefined,
        }),
        Extension.create({
          name: 'selectAllFix',
          addKeyboardShortcuts() {
            return {
              'Mod-a': ({ editor: ed }) => {
                const { doc } = ed.state;
                const from = TextSelection.atStart(doc).from;
                const to = TextSelection.atEnd(doc).to;
                ed.commands.setTextSelection({ from, to });
                return true;
              },
            };
          },
        }),
      ],
      editorProps: {
        attributes: {
          class: options.editorClass || 'kivi-editor',
        },
      },
      onUpdate: () => {
        if (!this.suppressUpdates) {
          this.scheduleUpdate();
        }
      },
    });

    if (options.content && !options.deferContent) {
      this.loadMarkdown(options.content);
    }
  }

  /**
   * Load Markdown content into the editor (synchronous).
   */
  loadMarkdown(source: string): void {
    this.suppressUpdates = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    resetBlockIdCounter();
    this.kiviDoc = parseMarkdown(source);
    const t1 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.editor.commands.setContent(this.kiviDoc.doc);
    const t2 = typeof performance !== 'undefined' ? performance.now() : 0;
    resetDirtyTracking(this.editor);
    this.suppressUpdates = false;
    if (t0 && _PERF_LOG) {
      console.log(`[kivi-perf] parseMarkdown: ${(t1 - t0).toFixed(1)}ms, setContent: ${(t2 - t1).toFixed(1)}ms`);
    }
  }

  /**
   * Load Markdown content asynchronously.
   * Uses a Web Worker for larger files; yields to allow paint before setContent.
   */
  async loadMarkdownAsync(source: string): Promise<void> {
    this.suppressUpdates = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.kiviDoc = await parseMarkdownAsync(source);
    const t1 = typeof performance !== 'undefined' ? performance.now() : 0;
    // Yield to let the browser paint the empty editor before the heavy setContent
    await new Promise(r => requestAnimationFrame(r));
    this.editor.commands.setContent(this.kiviDoc.doc);
    const t2 = typeof performance !== 'undefined' ? performance.now() : 0;
    resetDirtyTracking(this.editor);
    this.suppressUpdates = false;
    if (t0 && _PERF_LOG) {
      console.log(`[kivi-perf] async parseMarkdown: ${(t1 - t0).toFixed(1)}ms, setContent: ${(t2 - t1).toFixed(1)}ms`);
    }
  }

  /**
   * Get the current content as Markdown with minimal diffs.
   * Uses block-level dirty tracking: only changed blocks are re-serialized.
   */
  getMarkdown(): string {
    if (this.kiviDoc) {
      const dirtyIndices = getDirtyBlockIndices(this.editor.state);
      applyDirtyFlags(this.kiviDoc, dirtyIndices);

      const currentDoc = this.editor.getJSON();
      const updatedKiviDoc: KiviDocument = {
        ...this.kiviDoc,
        doc: currentDoc as Record<string, unknown>,
      };
      return serializeDocument(updatedKiviDoc);
    }

    const json = this.editor.getJSON();
    const emptySourceMap: SourceMap = {
      source: '',
      blocks: new Map(),
      gaps: [],
      preamble: '',
      postamble: '',
    };
    return serializeDocument({
      doc: json as Record<string, unknown>,
      sourceMap: emptySourceMap,
      blockOrder: [],
    });
  }

  /**
   * Register a callback for content updates.
   * Updates are debounced to avoid serializing on every keystroke.
   */
  onUpdate(callback: EditorUpdateCallback): () => void {
    this.updateCallbacks.push(callback);
    return () => {
      const idx = this.updateCallbacks.indexOf(callback);
      if (idx !== -1) this.updateCallbacks.splice(idx, 1);
    };
  }

  /** Search within the document. */
  search(options: SearchOptions): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.editor.commands as any).setSearchQuery(options);
    this.scrollToActiveSearchResult();
  }

  /** Clear active search. */
  clearSearch(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.editor.commands as any).clearSearch();
  }

  /** Move to the next search result. */
  nextSearchResult(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.editor.commands as any).nextSearchResult();
    this.scrollToActiveSearchResult();
  }

  /** Move to the previous search result. */
  previousSearchResult(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.editor.commands as any).previousSearchResult();
    this.scrollToActiveSearchResult();
  }

  /**
   * Set the active search result to the match nearest the given document position,
   * then scroll it into view.
   */
  setSearchActiveByPosition(docPos: number): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.editor.commands as any).setSearchActiveIndex(docPos);
    this.scrollToActiveSearchResult();
  }

  /** Get info about the current search state (total matches, active index). */
  getSearchInfo(): { total: number; activeIndex: number } {
    const state = this.editor.state;
    const searchState = searchPluginKey.getState(state) as
      | { results: Array<{ from: number; to: number }>; activeIndex: number }
      | undefined;
    if (!searchState) return { total: 0, activeIndex: -1 };
    return { total: searchState.results.length, activeIndex: searchState.activeIndex };
  }

  /** Scroll the view so the active search match is visible. */
  private scrollToActiveSearchResult(): void {
    requestAnimationFrame(() => {
      const state = this.editor.state;
      const searchState = searchPluginKey.getState(state) as
        | { results: Array<{ from: number; to: number }>; activeIndex: number }
        | undefined;
      if (!searchState || searchState.activeIndex < 0 || searchState.activeIndex >= searchState.results.length) return;
      const match = searchState.results[searchState.activeIndex];
      const view = this.editor.view;
      const dom = view.domAtPos(match.from);
      if (dom.node) {
        const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    });
  }

  /** Get the underlying Tiptap editor instance. */
  getTiptapEditor(): Editor {
    return this.editor;
  }

  /**
   * Get the document outline (headings).
   */
  getOutline(): { level: number; text: string; pos: number }[] {
    const outline: { level: number; text: string; pos: number }[] = [];
    const doc = this.editor.state.doc;
    doc.forEach((node, offset) => {
      if (node.type.name === 'heading') {
        outline.push({
          level: node.attrs.level as number,
          text: node.textContent,
          pos: offset,
        });
      }
    });
    return outline;
  }

  isEmpty(): boolean {
    return this.editor.isEmpty;
  }

  focus(position?: 'start' | 'end' | 'all'): void {
    this.editor.commands.focus(position);
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.updateCallbacks = [];
    this.kiviDoc = null;
    this.editor.destroy();
  }

  private scheduleUpdate(): void {
    if (this.suppressUpdates) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.notifyUpdate();
    }, this.debounceMs);
  }

  private notifyUpdate(): void {
    const isEmpty = this.editor.isEmpty;
    const markdown = this.getMarkdown();
    for (const cb of this.updateCallbacks) {
      cb({ markdown, isEmpty });
    }
  }
}

/**
 * Create a new Kivi editor instance.
 */
export function createKiviEditor(options: KiviEditorOptions): KiviEditor {
  return new KiviEditor(options);
}
