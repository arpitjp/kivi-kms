import * as assert from 'assert';
import { computeKiviFontSize, detectToolbarContext } from '../shared/font.js';

suite('computeKiviFontSize', () => {
  test('returns null when fontSize=0 (use VS Code defaults)', () => {
    assert.strictEqual(computeKiviFontSize(0), null);
  });

  test('returns fontSize when set', () => {
    assert.strictEqual(computeKiviFontSize(16), 16);
  });

  test('returns small fontSize', () => {
    assert.strictEqual(computeKiviFontSize(8), 8);
  });

  test('returns large fontSize', () => {
    assert.strictEqual(computeKiviFontSize(72), 72);
  });

  test('returns null for negative fontSize', () => {
    assert.strictEqual(computeKiviFontSize(-1), null);
  });

  test('returns fontSize=12', () => {
    assert.strictEqual(computeKiviFontSize(12), 12);
  });

  test('returns fontSize=24', () => {
    assert.strictEqual(computeKiviFontSize(24), 24);
  });
});

suite('detectToolbarContext', () => {
  test('returns "image" for image node', () => {
    assert.strictEqual(detectToolbarContext('image'), 'image');
  });

  test('returns "text" for paragraph node', () => {
    assert.strictEqual(detectToolbarContext('paragraph'), 'text');
  });

  test('returns "text" for heading node', () => {
    assert.strictEqual(detectToolbarContext('heading'), 'text');
  });

  test('returns "text" for table node', () => {
    assert.strictEqual(detectToolbarContext('table'), 'text');
  });

  test('returns "text" for tableCell node', () => {
    assert.strictEqual(detectToolbarContext('tableCell'), 'text');
  });

  test('returns "text" for codeBlock node', () => {
    assert.strictEqual(detectToolbarContext('codeBlock'), 'text');
  });

  test('returns "text" for bulletList node', () => {
    assert.strictEqual(detectToolbarContext('bulletList'), 'text');
  });

  test('returns "text" for blockquote node', () => {
    assert.strictEqual(detectToolbarContext('blockquote'), 'text');
  });

  test('returns "text" for undefined (no node at position)', () => {
    assert.strictEqual(detectToolbarContext(undefined), 'text');
  });

  test('returns "text" for horizontalRule node', () => {
    assert.strictEqual(detectToolbarContext('horizontalRule'), 'text');
  });
});
