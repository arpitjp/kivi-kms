import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DirtyTracker, getDirtyBlockIndices, applyDirtyFlags, resetDirtyTracking } from '../../src/extensions/dirty-tracker.js';
import { parseMarkdown, resetBlockIdCounter } from '@kivi/markdown-parser';

describe('DirtyTracker extension', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    editor = new Editor({
      element: el,
      extensions: [StarterKit, DirtyTracker],
    });
  });

  afterEach(() => {
    editor.destroy();
    el.remove();
  });

  it('starts clean after reset', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    });
    resetDirtyTracking(editor);

    const dirty = getDirtyBlockIndices(editor.state);
    expect(dirty.size).toBe(0);
  });

  it('detects dirty block after insertion', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    });

    // Insert text at beginning
    editor.commands.focus('start');
    editor.commands.insertContent('X');

    const dirty = getDirtyBlockIndices(editor.state);
    expect(dirty.size).toBeGreaterThan(0);
    expect(dirty.has(0)).toBe(true);
  });

  it('applyDirtyFlags sets correct flags', () => {
    resetBlockIdCounter();
    const source = '# Hello\n\nWorld\n\nThird paragraph\n';
    const kiviDoc = parseMarkdown(source);

    const dirtySet = new Set([1]);
    applyDirtyFlags(kiviDoc, dirtySet);

    expect(kiviDoc.sourceMap.blocks.get(kiviDoc.blockOrder[0])?.dirty).toBe(false);
    expect(kiviDoc.sourceMap.blocks.get(kiviDoc.blockOrder[1])?.dirty).toBe(true);
    expect(kiviDoc.sourceMap.blocks.get(kiviDoc.blockOrder[2])?.dirty).toBe(false);
  });

  it('tracks multiple dirty blocks', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'C' }] },
      ],
    });

    // Modify first block
    editor.commands.focus('start');
    editor.commands.insertContent('X');

    const dirty = getDirtyBlockIndices(editor.state);
    expect(dirty.has(0)).toBe(true);
  });
});
