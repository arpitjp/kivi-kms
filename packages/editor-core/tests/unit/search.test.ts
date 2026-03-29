import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { KiviSearch, searchPluginKey } from '../../src/extensions/search.js';

function createSearchEditor(content: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);

  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit,
      KiviSearch,
    ],
    content,
  });

  return { editor, el };
}

function getSearchState(editor: Editor) {
  return searchPluginKey.getState(editor.state) as {
    query: string;
    results: { from: number; to: number; matchText: string }[];
    activeIndex: number;
  } | undefined;
}

describe('KiviSearch extension', () => {
  let editor: Editor;
  let el: HTMLElement;

  afterEach(() => {
    editor?.destroy();
    el?.remove();
  });

  it('finds text in document and reports correct result count', () => {
    const r = createSearchEditor('<p>Hello world, hello universe</p>');
    editor = r.editor;
    el = r.el;

    (editor.commands as any).setSearchQuery({ query: 'hello', caseSensitive: false });

    const state = getSearchState(editor);
    expect(state).toBeDefined();
    expect(state!.results).toHaveLength(2);
    expect(state!.activeIndex).toBe(0);
    expect(state!.results[0].matchText).toBe('Hello');
    expect(state!.results[1].matchText).toBe('hello');
  });

  it('case-sensitive search returns fewer results', () => {
    const r = createSearchEditor('<p>Hello world, hello universe</p>');
    editor = r.editor;
    el = r.el;

    (editor.commands as any).setSearchQuery({ query: 'Hello', caseSensitive: true });

    const state = getSearchState(editor);
    expect(state!.results).toHaveLength(1);
    expect(state!.results[0].matchText).toBe('Hello');
  });

  it('clears search removes results and decorations', () => {
    const r = createSearchEditor('<p>Hello world</p>');
    editor = r.editor;
    el = r.el;

    (editor.commands as any).setSearchQuery({ query: 'Hello' });
    expect(getSearchState(editor)!.results.length).toBeGreaterThan(0);

    (editor.commands as any).clearSearch();
    const state = getSearchState(editor);
    expect(state!.results).toHaveLength(0);
    expect(state!.activeIndex).toBe(-1);
  });

  it('nextSearchResult advances the active index', () => {
    const r = createSearchEditor('<p>aa bb aa</p>');
    editor = r.editor;
    el = r.el;

    (editor.commands as any).setSearchQuery({ query: 'aa' });
    expect(getSearchState(editor)!.activeIndex).toBe(0);

    (editor.commands as any).nextSearchResult();
    expect(getSearchState(editor)!.activeIndex).toBe(1);

    (editor.commands as any).nextSearchResult();
    expect(getSearchState(editor)!.activeIndex).toBe(0);
  });

  it('previousSearchResult wraps around', () => {
    const r = createSearchEditor('<p>aa bb aa</p>');
    editor = r.editor;
    el = r.el;

    (editor.commands as any).setSearchQuery({ query: 'aa' });
    (editor.commands as any).previousSearchResult();
    expect(getSearchState(editor)!.activeIndex).toBe(1);
  });

  it('nextSearchResult does not throw with no results', () => {
    const r = createSearchEditor('<p>Hello world</p>');
    editor = r.editor;
    el = r.el;

    (editor.commands as any).nextSearchResult();
    expect(editor.state.doc.textContent).toBe('Hello world');
  });

  it('regex search finds pattern matches', () => {
    const r = createSearchEditor('<p>Hello world 123 and 456</p>');
    editor = r.editor;
    el = r.el;

    (editor.commands as any).setSearchQuery({ query: '\\d+', regex: true });
    const state = getSearchState(editor);
    expect(state!.results).toHaveLength(2);
    expect(state!.results[0].matchText).toBe('123');
    expect(state!.results[1].matchText).toBe('456');
  });

  it('invalid regex does not crash and returns no results', () => {
    const r = createSearchEditor('<p>Hello world</p>');
    editor = r.editor;
    el = r.el;

    expect(() => {
      (editor.commands as any).setSearchQuery({ query: '[invalid', regex: true });
    }).not.toThrow();

    const state = getSearchState(editor);
    expect(state!.results).toHaveLength(0);
  });

  it('replaceCurrentResult replaces the active match', () => {
    const r = createSearchEditor('<p>foo bar foo</p>');
    editor = r.editor;
    el = r.el;

    (editor.commands as any).setSearchQuery({ query: 'foo' });
    expect(getSearchState(editor)!.results).toHaveLength(2);

    (editor.commands as any).replaceCurrentResult('baz');
    expect(editor.state.doc.textContent).toBe('baz bar foo');

    const state = getSearchState(editor);
    expect(state!.results).toHaveLength(1);
  });

  it('replaceAllResults replaces all matches', () => {
    const r = createSearchEditor('<p>foo bar foo baz foo</p>');
    editor = r.editor;
    el = r.el;

    (editor.commands as any).setSearchQuery({ query: 'foo' });
    expect(getSearchState(editor)!.results).toHaveLength(3);

    (editor.commands as any).replaceAllResults('X');
    expect(editor.state.doc.textContent).toBe('X bar X baz X');
  });

  it('replace with empty string deletes the match', () => {
    const r = createSearchEditor('<p>hello world</p>');
    editor = r.editor;
    el = r.el;

    (editor.commands as any).setSearchQuery({ query: 'hello ' });
    (editor.commands as any).replaceCurrentResult('');
    expect(editor.state.doc.textContent).toBe('world');
  });
});
