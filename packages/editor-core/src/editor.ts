import { Editor, Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
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
import { KiviSearch } from './extensions/search.js';
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

export interface KiviEditorOptions extends EditorConfig {}

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
          inclusive: false,
          addInputRules() { return []; },
        }),
        Link.configure({
          openOnClick: false,
          HTMLAttributes: { class: 'kivi-link' },
        }),
        Image.configure({
          HTMLAttributes: { class: 'kivi-image' },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
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
        }),
        DirtyTracker,
        WikiLink,
        HashTag.configure({
          suggestion: options.tagSuggestion ? { items: options.tagSuggestion.items } : undefined,
        }),
        TocBlock,
        SlashCommands.configure({
          onCreatePage: options.onCreatePage,
        }),
        MermaidBlock,
        ExcalidrawBlock,
        TableControls,
        ImageControls,
        LinkPopup,
        CodeBlockEnhanced,
        SelectionToolbar,
        DevWatchdog,
        SmartTypography,
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
    if (t0) {
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
    if (t0) {
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
  }

  /** Move to the previous search result. */
  previousSearchResult(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.editor.commands as any).previousSearchResult();
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
