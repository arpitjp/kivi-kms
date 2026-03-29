/**
 * Configuration for the Kivi editor instance.
 */
export interface EditorConfig {
  /** DOM element to mount the editor into */
  element: HTMLElement;
  /** Initial Markdown content (optional) */
  content?: string;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Placeholder text when the document is empty */
  placeholder?: string;
  /** Enable auto-focus on mount */
  autoFocus?: boolean | 'start' | 'end';
  /** Custom CSS class for the editor root */
  editorClass?: string;
  /** Theme name */
  theme?: 'dark' | 'light' | 'sepia' | 'nord';
  /** Font family override */
  fontFamily?: string;
  /** Font size in pixels */
  fontSize?: number;
  /** Line height multiplier */
  lineHeight?: number;
  /** Callback for "New Page" slash command */
  onCreatePage?: () => void;
}

export type KiviTheme = 'dark' | 'light' | 'sepia' | 'nord';

export interface ThemeColors {
  bg: string;
  bgSurface: string;
  bgEditor: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentHover: string;
}

/**
 * Callback types for editor events.
 */
export type EditorUpdateCallback = (info: {
  markdown: string;
  isEmpty: boolean;
}) => void;

export type EditorSelectionCallback = (info: {
  from: number;
  to: number;
  empty: boolean;
}) => void;

/**
 * Search options for in-document search.
 */
export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

/**
 * Result of a search operation.
 */
export interface SearchResult {
  from: number;
  to: number;
  matchText: string;
}
