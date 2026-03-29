import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import type { EditorConfig, EditorUpdateCallback, KiviDocument, SourceMap, SearchOptions } from '@kivi/shared-types';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';
import { serializeDocument } from '@kivi/markdown-serializer';
import { Frontmatter } from './extensions/frontmatter.js';
import { MathBlock, MathInline } from './extensions/math.js';
import { FootnoteRef, FootnoteDef } from './extensions/footnote.js';
import { KiviSearch } from './extensions/search.js';
import { KiviClipboard } from './extensions/clipboard.js';
import { DirtyTracker, getDirtyBlockIndices, applyDirtyFlags, resetDirtyTracking } from './extensions/dirty-tracker.js';

export interface KiviEditorOptions extends EditorConfig {}

export class KiviEditor {
  private editor: Editor;
  private kiviDoc: KiviDocument | null = null;
  private updateCallbacks: EditorUpdateCallback[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs = 300;

  constructor(options: KiviEditorOptions) {
    this.editor = new Editor({
      element: options.element,
      editable: !options.readOnly,
      autofocus: options.autoFocus ?? false,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          codeBlock: { HTMLAttributes: { class: 'kivi-code-block' } },
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
        TableCell,
        TableHeader,
        Underline,
        Placeholder.configure({
          placeholder: options.placeholder || 'Start writing...',
        }),
        Frontmatter,
        MathBlock,
        MathInline,
        FootnoteRef,
        FootnoteDef,
        KiviSearch,
        KiviClipboard,
        DirtyTracker,
      ],
      editorProps: {
        attributes: {
          class: options.editorClass || 'kivi-editor',
        },
      },
      onUpdate: () => {
        this.scheduleUpdate();
      },
    });

    if (options.content) {
      this.loadMarkdown(options.content);
    }
  }

  /**
   * Load Markdown content into the editor.
   */
  loadMarkdown(source: string): void {
    resetBlockIdCounter();
    this.kiviDoc = parseMarkdown(source);
    this.editor.commands.setContent(this.kiviDoc.doc);
    resetDirtyTracking(this.editor);
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
    (this.editor.commands as Record<string, (...args: unknown[]) => boolean>)['setSearchQuery'](options);
  }

  /** Clear active search. */
  clearSearch(): void {
    (this.editor.commands as Record<string, (...args: unknown[]) => boolean>)['clearSearch']();
  }

  /** Move to the next search result. */
  nextSearchResult(): void {
    (this.editor.commands as Record<string, (...args: unknown[]) => boolean>)['nextSearchResult']();
  }

  /** Move to the previous search result. */
  previousSearchResult(): void {
    (this.editor.commands as Record<string, (...args: unknown[]) => boolean>)['previousSearchResult']();
  }

  /** Get the underlying Tiptap editor instance. */
  getTiptapEditor(): Editor {
    return this.editor;
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
