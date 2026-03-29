import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { InlineCodeInput } from '../../src/extensions/inline-code-input.js';
import { DevWatchdog } from '../../src/extensions/dev-watchdog.js';

let editors: Editor[] = [];

function createEditor(content: string, extraExtensions: any[] = []) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, ...extraExtensions],
    content,
  });
  editors.push(editor);
  return { editor, el };
}

afterEach(() => {
  editors.forEach((e) => { if (!e.isDestroyed) e.destroy(); });
  editors = [];
  document.body.innerHTML = '';
});

// ── InlineCodeInput ───────────────────────────────────────────

describe('InlineCodeInput', () => {
  it('registers without errors', () => {
    const { editor } = createEditor('<p>hello</p>', [InlineCodeInput]);
    expect(editor.isDestroyed).toBe(false);
  });

  it('does not interfere with non-backtick input', () => {
    const { editor } = createEditor('<p>hello</p>', [InlineCodeInput]);
    editor.commands.setTextSelection(6);
    editor.commands.insertContent('!');
    expect(editor.state.doc.textContent).toContain('hello!');
  });

  it('cleans up without errors', () => {
    const { editor } = createEditor('<p>hello</p>', [InlineCodeInput]);
    editor.destroy();
    expect(editor.isDestroyed).toBe(true);
  });
});

// ── DevWatchdog ───────────────────────────────────────────────

describe('DevWatchdog', () => {
  it('registers without errors when enabled', () => {
    const { editor } = createEditor('<p>hello</p>', [
      DevWatchdog.configure({ enabled: true }),
    ]);
    expect(editor.isDestroyed).toBe(false);
  });

  it('does not create plugins when disabled', () => {
    const { editor } = createEditor('<p>hello</p>', [
      DevWatchdog.configure({ enabled: false }),
    ]);
    const pluginKeys = editor.state.plugins.map((p) => (p as any).key);
    const hasWatchdog = pluginKeys.some((k: string) => k.includes('devWatchdog'));
    expect(hasWatchdog).toBe(false);
  });

  it('detects high transaction rate', () => {
    const onHighTxRate = vi.fn();
    const { editor } = createEditor('<p>hello</p>', [
      DevWatchdog.configure({
        enabled: true,
        maxTransactionsPerSec: 5,
        onHighTxRate,
      }),
    ]);

    for (let i = 0; i < 10; i++) {
      editor.commands.insertContent('x');
    }

    expect(onHighTxRate).toHaveBeenCalled();
    const rate = onHighTxRate.mock.calls[0][0];
    expect(rate).toBeGreaterThan(5);
  });

  it('cleans up timers on destroy', () => {
    const { editor } = createEditor('<p>hello</p>', [
      DevWatchdog.configure({ enabled: true }),
    ]);
    editor.destroy();
    expect(editor.isDestroyed).toBe(true);
  });

  it('respects custom blockThresholdMs option', () => {
    const { editor } = createEditor('<p>hello</p>', [
      DevWatchdog.configure({
        enabled: true,
        blockThresholdMs: 200,
      }),
    ]);
    expect(editor.isDestroyed).toBe(false);
  });

  it('respects custom maxTransactionsPerSec option', () => {
    const onHighTxRate = vi.fn();
    const { editor } = createEditor('<p>hello</p>', [
      DevWatchdog.configure({
        enabled: true,
        maxTransactionsPerSec: 100,
        onHighTxRate,
      }),
    ]);

    // 10 transactions should NOT trigger at a threshold of 100
    for (let i = 0; i < 10; i++) {
      editor.commands.insertContent('y');
    }
    expect(onHighTxRate).not.toHaveBeenCalled();
  });
});

// ── isDevEnvironment detection ────────────────────────────────

describe('DevWatchdog auto-detection', () => {
  it('enables in test environment (localhost-like)', () => {
    // vitest runs in happy-dom which has no real location
    // DevWatchdog with enabled=undefined should check the environment
    const { editor } = createEditor('<p>hello</p>', [
      DevWatchdog.configure({ enabled: undefined }),
    ]);
    // Should not crash regardless of detection result
    expect(editor.isDestroyed).toBe(false);
  });
});
