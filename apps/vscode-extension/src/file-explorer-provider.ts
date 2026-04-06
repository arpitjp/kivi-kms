import * as vscode from 'vscode';
import * as path from 'path';
import { posix } from 'path';

type TreeNode = FileNode | FolderNode;

interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
  label: string;
  parent?: FolderNode;
}

interface FolderNode {
  kind: 'folder';
  uri: vscode.Uri;
  label: string;
  parent?: FolderNode;
}

export class FileExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private mdCache = new Map<string, boolean>();

  /** Map from file URI string → TreeNode for quick lookup / reveal */
  private nodesByUri = new Map<string, TreeNode>();

  refresh(): void {
    this.mdCache.clear();
    this.mdDirSet = null;
    this.mdDirSetPromise = null;
    this.nodesByUri.clear();
    this._onDidChangeTreeData.fire();
  }

  findNodeByUri(uri: vscode.Uri): TreeNode | undefined {
    return this.nodesByUri.get(uri.toString());
  }

  /**
   * Walk from workspace root down to the target URI, loading each tree level
   * along the way so parent folders get expanded and the node enters the cache.
   */
  async resolveNodeByPath(uri: vscode.Uri): Promise<TreeNode | undefined> {
    const cached = this.nodesByUri.get(uri.toString());
    if (cached) return cached;

    const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
    const wsRoot = wsFolder?.uri;
    if (!wsRoot) return undefined;

    const rel = posix.relative(wsRoot.path, uri.path);
    if (!rel || rel.startsWith('..')) return undefined;

    const segments = rel.split('/');

    // Load root level first
    await this.getChildren(undefined);

    // For multi-root workspaces, also expand the workspace folder node
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 1) {
      const rootNode = this.nodesByUri.get(wsRoot.toString());
      if (rootNode && rootNode.kind === 'folder') {
        await this.getChildren(rootNode);
      }
    }

    let parentNode: TreeNode | undefined;
    for (let i = 0; i < segments.length; i++) {
      const segUri = vscode.Uri.joinPath(wsRoot, ...segments.slice(0, i + 1));
      const node = this.nodesByUri.get(segUri.toString());
      if (!node) return undefined;

      if (i < segments.length - 1 && node.kind === 'folder') {
        await this.getChildren(node);
      }
      parentNode = node;
    }

    return parentNode;
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return element.parent;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.kind === 'folder'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    item.resourceUri = element.uri;

    if (element.kind === 'file') {
      item.command = {
        command: 'vscode.openWith',
        title: 'Open in Kivi',
        arguments: [element.uri, 'kivi.markdownEditor'],
      };
      item.contextValue = 'kiviFile';
    } else {
      item.contextValue = 'kiviFolder';
    }

    return item;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return [];

    // Root level
    if (!element) {
      if (folders.length === 1) {
        return this.loadDirectoryChildren(folders[0].uri, undefined);
      }
      // Multi-root: show workspace folders as top-level entries
      const nodes: TreeNode[] = [];
      for (const folder of folders) {
        const hasMarkdown = await this.containsMarkdown(folder.uri);
        if (hasMarkdown) {
          const node: FolderNode = { kind: 'folder', uri: folder.uri, label: folder.name };
          nodes.push(node);
          this.nodesByUri.set(folder.uri.toString(), node);
        }
      }
      return nodes;
    }

    if (element.kind === 'folder') {
      return this.loadDirectoryChildren(element.uri, element as FolderNode);
    }

    return [];
  }

  private async loadDirectoryChildren(searchDir: vscode.Uri, parent: FolderNode | undefined): Promise<TreeNode[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(searchDir);
      const nodes: TreeNode[] = [];

      const sorted = entries.sort((a, b) => {
        if (a[1] !== b[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });

      for (const [name, type] of sorted) {
        if (name.startsWith('.') || name === 'node_modules') continue;

        const uri = vscode.Uri.joinPath(searchDir, name);

        if (type === vscode.FileType.Directory) {
          const hasMarkdown = await this.containsMarkdown(uri);
          if (hasMarkdown) {
            const node: FolderNode = { kind: 'folder', uri, label: name, parent };
            nodes.push(node);
            this.nodesByUri.set(uri.toString(), node);
          }
        } else if (name.endsWith('.md') || name.endsWith('.markdown')) {
          const node: FileNode = {
            kind: 'file', uri,
            label: name.replace(/\.(md|markdown)$/, ''),
            parent,
          };
          nodes.push(node);
          this.nodesByUri.set(uri.toString(), node);
        }
      }

      return nodes;
    } catch {
      return [];
    }
  }

  private mdDirSet: Set<string> | null = null;
  private mdDirSetPromise: Promise<Set<string>> | null = null;

  private async getMdDirSet(): Promise<Set<string>> {
    if (this.mdDirSet) return this.mdDirSet;
    if (this.mdDirSetPromise) return this.mdDirSetPromise;

    this.mdDirSetPromise = (async () => {
      const dirs = new Set<string>();
      const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
      if (wsRoots.length === 0) return dirs;

      const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 5000);
      for (const uri of files) {
        let dir = path.dirname(uri.fsPath);
        const root = wsRoots.find(r => dir.startsWith(r));
        if (!root) continue;
        while (dir && dir.length >= root.length) {
          if (dirs.has(dir)) break;
          dirs.add(dir);
          const parentDir = path.dirname(dir);
          if (parentDir === dir) break;
          dir = parentDir;
        }
      }
      this.mdDirSet = dirs;
      this.mdDirSetPromise = null;
      return dirs;
    })();

    return this.mdDirSetPromise;
  }

  private async containsMarkdown(dir: vscode.Uri): Promise<boolean> {
    const key = dir.toString();
    const cached = this.mdCache.get(key);
    if (cached !== undefined) return cached;

    const dirs = await this.getMdDirSet();
    const result = dirs.has(dir.fsPath);
    this.mdCache.set(key, result);
    return result;
  }
}
