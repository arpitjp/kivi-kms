/**
 * Source position information preserved from the original Markdown.
 * Maps directly to unist Position.
 */
export interface SourcePosition {
  start: { line: number; column: number; offset: number };
  end: { line: number; column: number; offset: number };
}

/**
 * Metadata attached to each top-level block to support
 * lossless round-trip serialization.
 */
export interface BlockMeta {
  /** Unique identifier for this block within the document */
  id: string;
  /** Position in the original Markdown source */
  sourcePosition: SourcePosition | null;
  /** The original Markdown source text for this block (verbatim slice) */
  originalSource: string | null;
  /** Whether this block has been modified since parse */
  dirty: boolean;
  /** Style hints extracted from the original source */
  styleHints: StyleHints;
}

/**
 * Style information extracted from the original Markdown source.
 * Used to match the user's style when re-serializing dirty blocks.
 */
export interface StyleHints {
  /** List marker: '-', '*', '+' for unordered; '.' or ')' for ordered delimiter */
  listMarker?: string;
  /** Heading style: 'atx' (#) or 'setext' (underline) */
  headingStyle?: 'atx' | 'setext';
  /** Emphasis character: '*' or '_' */
  emphasisMarker?: '*' | '_';
  /** Strong character: '**' or '__' */
  strongMarker?: '**' | '__';
  /** Code fence character: '`' or '~' */
  codeFenceChar?: '`' | '~';
  /** Code fence length (default 3) */
  codeFenceLength?: number;
  /** Blockquote marker style: '>' or '> ' */
  blockquoteMarker?: string;
  /** Indentation: 'tab' or number of spaces */
  indent?: 'tab' | number;
}

/**
 * Whitespace "gap" between two consecutive top-level blocks.
 * Preserved for minimal-diff output.
 */
export interface BlockGap {
  /** Index of the block before this gap */
  afterBlockIndex: number;
  /** The literal whitespace string between blocks */
  text: string;
}

/**
 * Source map that tracks the relationship between ProseMirror blocks
 * and the original Markdown source.
 */
export interface SourceMap {
  /** Original source text (full document) */
  source: string;
  /** Per-block metadata, keyed by block ID */
  blocks: Map<string, BlockMeta>;
  /** Gaps between blocks for whitespace preservation */
  gaps: BlockGap[];
  /** Content before the first block (e.g. leading whitespace) */
  preamble: string;
  /** Content after the last block (e.g. trailing newline) */
  postamble: string;
}

/**
 * The top-level document structure returned by the parser.
 * Contains the ProseMirror-compatible JSON document plus
 * all preservation metadata.
 */
export interface KiviDocument {
  /** ProseMirror document JSON (compatible with editor.setContent) */
  doc: Record<string, unknown>;
  /** Source map for round-trip preservation */
  sourceMap: SourceMap;
  /** Ordered list of block IDs matching doc top-level children */
  blockOrder: string[];
}
