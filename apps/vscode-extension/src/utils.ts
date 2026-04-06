import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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

export function getTabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  const input = tab?.input;
  if (input && typeof input === 'object' && 'uri' in input) {
    return (input as { uri: vscode.Uri }).uri;
  }
  return undefined;
}

export function getTabViewType(tab: vscode.Tab | undefined): string | undefined {
  const input = tab?.input;
  if (input && typeof input === 'object' && 'viewType' in input) {
    return (input as { viewType: string }).viewType;
  }
  return undefined;
}

export function getActiveMarkdownUri(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.fileName.endsWith('.md')) {
    return editor.document.uri;
  }
  const tabUri = getTabUri(vscode.window.tabGroups.activeTabGroup.activeTab);
  if (tabUri && (tabUri.fsPath.endsWith('.md') || tabUri.fsPath.endsWith('.markdown'))) {
    return tabUri;
  }
  return undefined;
}

// ── Workspace root detection ──
// Handles monorepos, submodules, and non-git workspaces robustly.
// Priority: VS Code workspace folder > .git ancestor > .vscode ancestor.
// Results are cached per-directory for the lifetime of the session.

const _rootCache = new Map<string, vscode.Uri | null>();

/**
 * Find the effective workspace root for a given file URI.
 * 1. vscode.workspace.getWorkspaceFolder — canonical for VS Code
 * 2. Walk up to find .git (handles submodules where .git is a file)
 * 3. Walk up to find .vscode as a last-resort project indicator
 * Returns null if none found (file is truly external).
 */
export function findEffectiveRoot(fileUri: vscode.Uri): vscode.Uri | null {
  const wsFolder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (wsFolder) return wsFolder.uri;

  const dir = path.dirname(fileUri.fsPath);
  const cached = _rootCache.get(dir);
  if (cached !== undefined) return cached;

  const result = walkUpForRoot(dir);
  _rootCache.set(dir, result);
  return result;
}

function walkUpForRoot(startDir: string): vscode.Uri | null {
  const root = path.parse(startDir).root;
  let dir = startDir;
  let vscodeDir: string | null = null;

  while (dir !== root) {
    // .git can be a directory (normal repo) or a file (submodule/worktree pointing to parent)
    const gitPath = path.join(dir, '.git');
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        return vscode.Uri.file(dir);
      }
    } catch { /* not found, keep walking */ }

    if (!vscodeDir) {
      const vscodePath = path.join(dir, '.vscode');
      try {
        if (fs.statSync(vscodePath).isDirectory()) {
          vscodeDir = dir;
        }
      } catch { /* not found */ }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return vscodeDir ? vscode.Uri.file(vscodeDir) : null;
}

/**
 * Determine whether a file URI is "inside" the effective workspace.
 * Uses findEffectiveRoot and also checks all VS Code workspace folders.
 */
export function isInsideWorkspace(fileUri: vscode.Uri): boolean {
  if (vscode.workspace.getWorkspaceFolder(fileUri)) return true;
  const root = findEffectiveRoot(fileUri);
  return root !== null;
}

/**
 * Get the best workspace root for a document — used to anchor relative path calculations.
 * Falls back to the first VS Code workspace folder if the document isn't in any.
 */
export function getWorkspaceRoot(docUri: vscode.Uri): vscode.Uri | undefined {
  return (
    vscode.workspace.getWorkspaceFolder(docUri)?.uri
    ?? findEffectiveRoot(docUri)
    ?? vscode.workspace.workspaceFolders?.[0]?.uri
    ?? undefined
  );
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
