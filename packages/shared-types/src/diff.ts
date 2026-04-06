/**
 * Compute the minimal diff range between two strings.
 * Returns the shared prefix end, old/new suffix boundaries, and the replacement text.
 * Used by the VS Code extension for incremental document edits.
 */
export function computeMinimalDiff(
  oldText: string,
  newText: string,
): { start: number; oldEnd: number; newEnd: number; replacement: string } {
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
    start++;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  return {
    start,
    oldEnd,
    newEnd,
    replacement: newText.slice(start, newEnd),
  };
}
