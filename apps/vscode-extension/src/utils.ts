import * as vscode from 'vscode';
import * as path from 'path';

export { computeKiviFontSize, detectToolbarContext } from './shared/font.js';
export type { ToolbarContext } from './shared/font.js';

export function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export function getActiveMarkdownUri(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.fileName.endsWith('.md')) {
    return editor.document.uri;
  }
  const tabUri = (vscode.window.tabGroups.activeTabGroup.activeTab?.input as any)?.uri as vscode.Uri | undefined;
  if (tabUri && (tabUri.fsPath.endsWith('.md') || tabUri.fsPath.endsWith('.markdown'))) {
    return tabUri;
  }
  return undefined;
}

/**
 * Resolve the assets/pages folder URI relative to the current document's directory.
 * E.g. document at /workspace/docs/notes/readme.md with subfolder "assets"
 * → /workspace/docs/notes/assets/
 */
export function resolveDocRelativeFolder(documentUri: vscode.Uri, subfolder: string): vscode.Uri {
  const docDir = vscode.Uri.joinPath(documentUri, '..');
  return vscode.Uri.joinPath(docDir, subfolder);
}

/**
 * Compute a relative path from the document's directory to a target file URI.
 * Returns a POSIX-style relative path suitable for markdown references.
 * E.g. document at /workspace/docs/readme.md, target at /workspace/docs/assets/img.png
 * → "assets/img.png"
 */
export function computeRelativePathFromDoc(documentUri: vscode.Uri, targetUri: vscode.Uri): string {
  const docDir = path.dirname(documentUri.fsPath);
  const rel = path.relative(docDir, targetUri.fsPath).replace(/\\/g, '/');
  return rel;
}
