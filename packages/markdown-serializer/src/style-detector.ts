import type { StyleHints } from '@kivi/shared-types';

/**
 * Detect style hints from a raw Markdown source string.
 * Used when we need to infer style from existing content
 * that wasn't parsed with position tracking.
 */
export function detectStyle(source: string): StyleHints {
  const hints: StyleHints = {};

  const lines = source.split('\n');

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (!hints.headingStyle && trimmed.startsWith('#')) {
      hints.headingStyle = 'atx';
    }

    if (!hints.listMarker) {
      if (trimmed.startsWith('- ')) hints.listMarker = '-';
      else if (trimmed.startsWith('* ')) hints.listMarker = '*';
      else if (trimmed.startsWith('+ ')) hints.listMarker = '+';
    }

    if (!hints.codeFenceChar) {
      if (trimmed.startsWith('```')) {
        hints.codeFenceChar = '`';
        const match = trimmed.match(/^(`+)/);
        hints.codeFenceLength = match ? match[1].length : 3;
      } else if (trimmed.startsWith('~~~')) {
        hints.codeFenceChar = '~';
        const match = trimmed.match(/^(~+)/);
        hints.codeFenceLength = match ? match[1].length : 3;
      }
    }

    if (!hints.blockquoteMarker && trimmed.startsWith('>')) {
      hints.blockquoteMarker = trimmed.startsWith('> ') ? '> ' : '>';
    }
  }

  const emphMatch = source.match(/(?<![*_])([*_])(?![*_])\S/);
  if (emphMatch) {
    hints.emphasisMarker = emphMatch[1] as '*' | '_';
  }

  const strongMatch = source.match(/(\*\*|__)(?!\s)/);
  if (strongMatch) {
    hints.strongMarker = strongMatch[1] as '**' | '__';
  }

  return hints;
}
