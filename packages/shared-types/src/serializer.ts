import type { StyleHints } from './document.js';

/**
 * Options for the Markdown serializer.
 */
export interface SerializerOptions {
  /** Whether to apply auto-fixes to dirty blocks */
  autoFix?: boolean;
  /** Specific auto-fix behaviors */
  fixes?: FixConfig;
  /** Default style hints to use when no original style is available */
  defaultStyle?: StyleHints;
  /** Whether to add a trailing newline */
  trailingNewline?: boolean;
}

/**
 * Configuration for optional auto-fix behaviors.
 * Each fix is scoped to the affected block only.
 */
export interface FixConfig {
  /** Fix broken ordered list numbering (e.g. 1, 1, 1 -> 1, 2, 3) */
  fixOrderedListNumbering?: boolean;
  /** Normalize inconsistent checkbox spacing */
  normalizeCheckboxSpacing?: boolean;
  /** Normalize malformed table formatting */
  normalizeTableFormatting?: boolean;
}
