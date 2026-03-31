import { Extension } from '@tiptap/core';

/**
 * Inline code input UX — now a no-op shell.
 *
 * All inline code behavior is handled by Tiptap's built-in Code extension
 * (from StarterKit), which uses the input rule `text` → inline code mark.
 *
 * Selection-based code wrapping (select text, press `) is handled by
 * SmartTypography.
 *
 * This extension is kept as an empty shell so that any code importing
 * `InlineCodeInput` continues to work without changes.
 */
export const InlineCodeInput = Extension.create({
  name: 'kiviInlineCodeInput',
});
