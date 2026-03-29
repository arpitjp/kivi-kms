import type { StyleHints } from '@kivi/shared-types';

export interface SerializeOptions {
  /** Default style hints when no original style is available */
  defaultStyle?: StyleHints;
  /** Whether to add a trailing newline */
  trailingNewline?: boolean;
}
