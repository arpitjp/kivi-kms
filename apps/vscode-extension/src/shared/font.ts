/**
 * Pure font-size computation for the Kivi editor.
 * No dependency on VS Code APIs — usable in both extension host and webview.
 *
 * Only handles the kivi.appearance.fontSize override.
 * Zoom is handled separately via CSS zoom on editor containers.
 */
export function computeKiviFontSize(
  kiviFontSize: number,
): number | null {
  if (kiviFontSize > 0) return kiviFontSize;
  return null;
}

/**
 * Determine the toolbar context based on the ProseMirror node at the
 * current selection position.
 */
export type ToolbarContext = 'text' | 'image';

export function detectToolbarContext(nodeTypeName: string | undefined): ToolbarContext {
  if (nodeTypeName === 'image') return 'image';
  return 'text';
}
