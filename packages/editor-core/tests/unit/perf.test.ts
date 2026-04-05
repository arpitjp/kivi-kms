import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Code from '@tiptap/extension-code';
import { DirtyTracker, resetDirtyTracking } from '../../src/extensions/dirty-tracker.js';
import { HeadingFold, headingFoldKey } from '../../src/extensions/heading-fold.js';
import { KiviSearch, searchPluginKey } from '../../src/extensions/search.js';
import { HashTag } from '../../src/extensions/hashtag.js';
import { SmartTypography } from '../../src/extensions/smart-typography.js';

function generateLargeDoc(paragraphs: number, headingInterval = 10): any {
  const content: any[] = [];
  for (let i = 0; i < paragraphs; i++) {
    if (i % headingInterval === 0) {
      const level = (i % 30 === 0) ? 1 : (i % 20 === 0) ? 2 : 3;
      content.push({
        type: 'heading',
        attrs: { level },
        content: [{ type: 'text', text: `Heading ${i / headingInterval + 1}` }],
      });
    }
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: `Paragraph ${i} with some text content that makes it realistic enough for testing purposes.` }],
    });
  }
  return { type: 'doc', content };
}

function measure(fn: () => void, iterations = 1): number {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return performance.now() - t0;
}

describe('Performance: DirtyTracker', () => {
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

  it('handles 500 block document edits within budget', () => {
    editor.commands.setContent(generateLargeDoc(500));
    resetDirtyTracking(editor);

    const elapsed = measure(() => {
      editor.commands.focus('start');
      editor.commands.insertContent('X');
    });

    expect(elapsed).toBeLessThan(200);
  });

  it('handles rapid sequential edits within budget', () => {
    editor.commands.setContent(generateLargeDoc(200));
    resetDirtyTracking(editor);
    editor.commands.focus('start');

    const elapsed = measure(() => {
      for (let i = 0; i < 50; i++) {
        editor.commands.insertContent('x');
      }
    });

    expect(elapsed).toBeLessThan(1000);
  });
});

describe('Performance: HeadingFold', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    editor = new Editor({
      element: el,
      extensions: [StarterKit, HeadingFold],
    });
  });

  afterEach(() => {
    editor.destroy();
    el.remove();
  });

  it('heading index is built efficiently for large docs', () => {
    const doc = generateLargeDoc(500);
    const elapsed = measure(() => {
      editor.commands.setContent(doc);
    });

    const state = headingFoldKey.getState(editor.state);
    expect(state).toBeDefined();
    expect(state!.headingIndex.size).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });

  it('fold all headings completes quickly', () => {
    editor.commands.setContent(generateLargeDoc(300));

    const elapsed = measure(() => {
      (editor.commands as any).foldAll();
    });

    const state = headingFoldKey.getState(editor.state);
    expect(state!.foldedPositions.size).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });

  it('typing with folds active stays fast', () => {
    editor.commands.setContent(generateLargeDoc(200));
    (editor.commands as any).foldAll();
    editor.commands.focus('start');

    const elapsed = measure(() => {
      for (let i = 0; i < 20; i++) {
        editor.commands.insertContent('x');
      }
    });

    expect(elapsed).toBeLessThan(500);
  });
});

describe('Performance: KiviSearch', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    editor = new Editor({
      element: el,
      extensions: [StarterKit, KiviSearch],
    });
  });

  afterEach(() => {
    editor.destroy();
    el.remove();
  });

  it('search in a large document completes quickly', () => {
    editor.commands.setContent(generateLargeDoc(500));

    const elapsed = measure(() => {
      (editor.commands as any).setSearchQuery({ query: 'Paragraph', caseSensitive: false });
    });

    const state = searchPluginKey.getState(editor.state);
    expect(state?.results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  it('typing with active search stays responsive', () => {
    editor.commands.setContent(generateLargeDoc(200));
    (editor.commands as any).setSearchQuery({ query: 'text', caseSensitive: false });
    editor.commands.focus('start');

    const elapsed = measure(() => {
      for (let i = 0; i < 20; i++) {
        editor.commands.insertContent('x');
      }
    });

    expect(elapsed).toBeLessThan(1000);
  });

  it('clearing search is instant', () => {
    editor.commands.setContent(generateLargeDoc(500));
    (editor.commands as any).setSearchQuery({ query: 'Paragraph' });

    const elapsed = measure(() => {
      (editor.commands as any).clearSearch();
    });

    expect(elapsed).toBeLessThan(200);
  });
});

describe('Performance: plugin stack overhead', () => {
  let editor: Editor;
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    editor = new Editor({
      element: el,
      extensions: [
        StarterKit.configure({ codeBlock: { HTMLAttributes: { class: 'kivi-code-block' } }, code: false }),
        Code,
        DirtyTracker,
        HeadingFold,
        KiviSearch,
        HashTag,
        SmartTypography,
      ],
    });
  });

  afterEach(() => {
    editor?.destroy();
    el.remove();
  });

  it('transaction throughput with multiple plugins stays high', () => {
    editor.commands.setContent(generateLargeDoc(100));
    editor.commands.focus('start');

    const iterations = 100;
    const elapsed = measure(() => {
      for (let i = 0; i < iterations; i++) {
        editor.commands.insertContent('a');
      }
    });

    const msPerTx = elapsed / iterations;
    expect(msPerTx).toBeLessThan(20);
  });

  it('editor creation with full plugin stack is fast', () => {
    const tempEl = document.createElement('div');
    document.body.appendChild(tempEl);

    let tempEditor: Editor | null = null;
    const elapsed = measure(() => {
      tempEditor = new Editor({
        element: tempEl,
        extensions: [
          StarterKit.configure({ codeBlock: { HTMLAttributes: { class: 'kivi-code-block' } }, code: false }),
          Code,
          DirtyTracker,
          HeadingFold,
          KiviSearch,
          HashTag,
          SmartTypography,
        ],
      });
    });

    expect(elapsed).toBeLessThan(500);
    tempEditor?.destroy();
    tempEl.remove();
  });

  it('setContent on a 200-block doc is fast', () => {
    const doc = generateLargeDoc(200);

    const elapsed = measure(() => {
      editor.commands.setContent(doc);
    });

    expect(elapsed).toBeLessThan(500);
  });
});
