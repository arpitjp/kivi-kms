import type { KiviDocument, SourcePosition, StyleHints } from '@kivi/shared-types';

export interface ParseOptions {
  /** Enable GFM extensions (tables, task lists, strikethrough, autolinks) */
  gfm?: boolean;
  /** Enable frontmatter parsing */
  frontmatter?: boolean;
  /** Enable math parsing */
  math?: boolean;
  /** Enable wiki-link parsing ([[page]] and [[page|alias]]) */
  wikiLinks?: boolean;
}

export interface ParseResult extends KiviDocument {}

/**
 * Internal representation of a parsed block with its metadata.
 */
export interface ParsedBlock {
  id: string;
  pmNode: Record<string, unknown>;
  sourcePosition: SourcePosition | null;
  originalSource: string | null;
  styleHints: StyleHints;
}
