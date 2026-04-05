import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The raw editor uses a transparent <textarea> overlaid on a visible <pre>
 * backdrop. Both must have identical font/layout properties for the caret
 * position to match the rendered text. This test parses the CSS source and
 * verifies that any property declared in the textarea rule also appears with
 * the same value in the backdrop rule, for the subset of properties that
 * affect text layout.
 */

const LAYOUT_PROPERTIES = [
  'font-family',
  'font-size',
  'line-height',
  'white-space',
  'word-wrap',
  'overflow-wrap',
  'tab-size',
  'overflow-x',
];

function extractRuleBlock(css: string, selectorSubstring: string): string {
  const idx = css.indexOf(selectorSubstring);
  if (idx === -1) throw new Error(`Selector "${selectorSubstring}" not found in CSS`);
  const openBrace = css.indexOf('{', idx + selectorSubstring.length - 1);
  if (openBrace === -1) throw new Error(`No opening brace after "${selectorSubstring}"`);
  let depth = 1;
  let i = openBrace + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(openBrace + 1, i - 1);
}

function parseDeclarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = block.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('//')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();
    if (val.endsWith(';')) val = val.slice(0, -1).trim();
    map.set(prop, val);
  }
  return map;
}

describe('raw editor CSS consistency', () => {
  const cssPath = resolve(__dirname, '../../src/webview/styles.css');
  const css = readFileSync(cssPath, 'utf-8');

  const textareaBlock = extractRuleBlock(css, '#kivi-raw-editor,\n');
  const backdropBlock = extractRuleBlock(css, '\n.kivi-raw-backdrop {');

  const textareaProps = parseDeclarations(textareaBlock);
  const backdropProps = parseDeclarations(backdropBlock);

  for (const prop of LAYOUT_PROPERTIES) {
    it(`"${prop}" matches between textarea and backdrop`, () => {
      const taVal = textareaProps.get(prop);
      const bdVal = backdropProps.get(prop);
      if (!taVal && !bdVal) return; // neither declares it — OK
      expect(taVal).toBeDefined();
      expect(bdVal).toBeDefined();
      expect(taVal).toBe(bdVal);
    });
  }

  it('padding values match between textarea and backdrop', () => {
    const taPad = textareaProps.get('padding');
    const bdPad = backdropProps.get('padding');
    expect(taPad).toBeDefined();
    expect(bdPad).toBeDefined();
    expect(taPad).toBe(bdPad);
  });
});
