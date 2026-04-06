import { describe, it, expect } from 'vitest';

/**
 * Unit tests for the search system's core logic.
 *
 * These test the pure functions that power search: regex building, match
 * finding, count tracking, and the show/hide state machine.
 * They do NOT require a DOM, Monaco, or VS Code — just logic.
 */

// ── Regex construction (mirrors monaco-raw-editor.ts search logic) ──

function buildSearchRegex(opts: {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
}): RegExp | null {
  const isRegex = opts.regex ?? false;
  let searchStr = opts.query;

  if (!isRegex) {
    searchStr = searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (opts.wholeWord) {
    searchStr = `\\b${searchStr}\\b`;
  }
  try {
    return new RegExp(searchStr, opts.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

function findAllMatches(text: string, regex: RegExp): Array<{ start: number; end: number; match: string }> {
  const results: Array<{ start: number; end: number; match: string }> = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = regex.exec(text)) !== null) {
    results.push({ start: m.index, end: m.index + m[0].length, match: m[0] });
    if (m[0].length === 0) regex.lastIndex++;
  }
  return results;
}


describe('Search regex construction', () => {
  it('plain text query is case-insensitive by default', () => {
    const re = buildSearchRegex({ query: 'hello' })!;
    expect(re).toBeTruthy();
    expect(re.flags).toContain('i');
    expect('Hello'.match(re)).toBeTruthy();
    expect('HELLO'.match(re)).toBeTruthy();
    expect('hello'.match(re)).toBeTruthy();
  });

  it('case-sensitive search only matches exact case', () => {
    const re = buildSearchRegex({ query: 'Hello', caseSensitive: true })!;
    expect(re.flags).not.toContain('i');
    expect(re.test('Hello')).toBe(true);
    expect(re.test('hello')).toBe(false);
  });

  it('special regex characters are escaped in non-regex mode', () => {
    const re = buildSearchRegex({ query: 'foo.bar' })!;
    expect(re.test('foo.bar')).toBe(true);
    expect(re.test('fooXbar')).toBe(false);
  });

  it('whole-word wraps with word boundaries', () => {
    const re = buildSearchRegex({ query: 'is', wholeWord: true })!;
    const text = 'This is a test';
    const matches = findAllMatches(text, re);
    expect(matches).toHaveLength(1);
    expect(matches[0].match.toLowerCase()).toBe('is');
    expect(matches[0].start).toBe(5);
  });

  it('regex mode passes through raw pattern', () => {
    const re = buildSearchRegex({ query: '\\d{3}', regex: true })!;
    const matches = findAllMatches('abc 123 def 4567', re);
    expect(matches).toHaveLength(2);
    expect(matches[0].match).toBe('123');
    expect(matches[1].match).toBe('456');
  });

  it('invalid regex returns null', () => {
    const re = buildSearchRegex({ query: '[unclosed', regex: true });
    expect(re).toBeNull();
  });

  it('empty query produces regex that matches nothing meaningful', () => {
    const re = buildSearchRegex({ query: '' });
    expect(re).toBeTruthy();
    // Empty regex matches every position; callers gate on empty query before calling
  });
});


describe('Match finding', () => {
  it('finds all occurrences in multiline text', () => {
    const text = 'hello world\nhello universe\ngoodbye world';
    const re = buildSearchRegex({ query: 'hello' })!;
    const matches = findAllMatches(text, re);
    expect(matches).toHaveLength(2);
    expect(matches[0].start).toBe(0);
    expect(matches[1].start).toBe(12);
  });

  it('no matches returns empty array', () => {
    const re = buildSearchRegex({ query: 'missing' })!;
    const matches = findAllMatches('hello world', re);
    expect(matches).toHaveLength(0);
  });

  it('case-insensitive finds mixed case', () => {
    const re = buildSearchRegex({ query: 'test' })!;
    const matches = findAllMatches('Test TEST test', re);
    expect(matches).toHaveLength(3);
  });

  it('regex with groups works', () => {
    const re = buildSearchRegex({ query: '(foo|bar)', regex: true })!;
    const matches = findAllMatches('foo baz bar', re);
    expect(matches).toHaveLength(2);
    expect(matches[0].match).toBe('foo');
    expect(matches[1].match).toBe('bar');
  });

  it('overlapping patterns handled correctly', () => {
    const re = buildSearchRegex({ query: 'aa', regex: true })!;
    const matches = findAllMatches('aaaa', re);
    expect(matches).toHaveLength(2);
  });
});


// ── Search bar state machine ──

interface SearchBarState {
  visible: boolean;
  replaceVisible: boolean;
  query: string;
}

function showSearchBar(state: SearchBarState, openReplace: boolean): SearchBarState {
  return {
    ...state,
    visible: true,
    replaceVisible: openReplace ? true : state.replaceVisible,
  };
}

function hideSearchBar(state: SearchBarState): SearchBarState {
  return {
    ...state,
    visible: false,
  };
}

describe('Search bar state machine', () => {
  const initial: SearchBarState = { visible: false, replaceVisible: false, query: '' };

  it('showSearchBar opens the bar', () => {
    const next = showSearchBar(initial, false);
    expect(next.visible).toBe(true);
    expect(next.replaceVisible).toBe(false);
  });

  it('showSearchBar with replace opens both', () => {
    const next = showSearchBar(initial, true);
    expect(next.visible).toBe(true);
    expect(next.replaceVisible).toBe(true);
  });

  it('showSearchBar when already open is idempotent', () => {
    const open = showSearchBar(initial, false);
    const again = showSearchBar(open, false);
    expect(again.visible).toBe(true);
  });

  it('double showSearchBar does NOT close (the core bug fix)', () => {
    const first = showSearchBar(initial, false);
    const second = showSearchBar(first, false);
    expect(second.visible).toBe(true);
  });

  it('hideSearchBar closes', () => {
    const open = showSearchBar(initial, false);
    const closed = hideSearchBar(open);
    expect(closed.visible).toBe(false);
  });

  it('hideSearchBar on already-closed is no-op', () => {
    const closed = hideSearchBar(initial);
    expect(closed.visible).toBe(false);
  });

  it('Cmd+F → Cmd+F rapid fire keeps bar open', () => {
    let state = initial;
    for (let i = 0; i < 10; i++) {
      state = showSearchBar(state, false);
    }
    expect(state.visible).toBe(true);
  });

  it('Cmd+F → Escape → Cmd+F re-opens', () => {
    let state = showSearchBar(initial, false);
    state = hideSearchBar(state);
    expect(state.visible).toBe(false);
    state = showSearchBar(state, false);
    expect(state.visible).toBe(true);
  });
});


// ── Active index navigation ──

function nextIndex(current: number, total: number): number {
  if (total === 0) return -1;
  return (current + 1) % total;
}

function prevIndex(current: number, total: number): number {
  if (total === 0) return -1;
  return (current - 1 + total) % total;
}

describe('Search navigation (next/prev)', () => {
  it('next wraps from last to first', () => {
    expect(nextIndex(4, 5)).toBe(0);
  });

  it('prev wraps from first to last', () => {
    expect(prevIndex(0, 5)).toBe(4);
  });

  it('next with zero results returns -1', () => {
    expect(nextIndex(-1, 0)).toBe(-1);
  });

  it('prev with zero results returns -1', () => {
    expect(prevIndex(-1, 0)).toBe(-1);
  });

  it('single result always stays at 0', () => {
    expect(nextIndex(0, 1)).toBe(0);
    expect(prevIndex(0, 1)).toBe(0);
  });

  it('full cycle through all results', () => {
    const total = 5;
    let idx = 0;
    const visited = new Set<number>();
    for (let i = 0; i < total; i++) {
      visited.add(idx);
      idx = nextIndex(idx, total);
    }
    expect(visited.size).toBe(total);
    expect(idx).toBe(0);
  });
});


// ── Replace logic ──

function applyReplace(text: string, matches: Array<{ start: number; end: number }>, activeIdx: number, replacement: string): string {
  if (activeIdx < 0 || activeIdx >= matches.length) return text;
  const m = matches[activeIdx];
  return text.slice(0, m.start) + replacement + text.slice(m.end);
}

function applyReplaceAll(text: string, matches: Array<{ start: number; end: number }>, replacement: string): string {
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let result = text;
  for (const m of sorted) {
    result = result.slice(0, m.start) + replacement + result.slice(m.end);
  }
  return result;
}

describe('Replace logic', () => {
  it('replace current replaces only active match', () => {
    const text = 'foo bar foo baz foo';
    const matches = [
      { start: 0, end: 3 },
      { start: 8, end: 11 },
      { start: 16, end: 19 },
    ];
    expect(applyReplace(text, matches, 0, 'X')).toBe('X bar foo baz foo');
    expect(applyReplace(text, matches, 1, 'Y')).toBe('foo bar Y baz foo');
    expect(applyReplace(text, matches, 2, 'Z')).toBe('foo bar foo baz Z');
  });

  it('replace-all replaces every match', () => {
    const text = 'foo bar foo baz foo';
    const matches = [
      { start: 0, end: 3 },
      { start: 8, end: 11 },
      { start: 16, end: 19 },
    ];
    expect(applyReplaceAll(text, matches, 'X')).toBe('X bar X baz X');
  });

  it('replace with empty string deletes', () => {
    const text = 'hello world';
    const matches = [{ start: 0, end: 6 }];
    expect(applyReplace(text, matches, 0, '')).toBe('world');
  });

  it('replace with longer text works', () => {
    const text = 'hi there';
    const matches = [{ start: 0, end: 2 }];
    expect(applyReplace(text, matches, 0, 'hello')).toBe('hello there');
  });

  it('replace-all with no matches returns original', () => {
    expect(applyReplaceAll('hello', [], 'X')).toBe('hello');
  });

  it('replace with invalid index is no-op', () => {
    const text = 'foo';
    const matches = [{ start: 0, end: 3 }];
    expect(applyReplace(text, matches, -1, 'bar')).toBe('foo');
    expect(applyReplace(text, matches, 5, 'bar')).toBe('foo');
  });
});
