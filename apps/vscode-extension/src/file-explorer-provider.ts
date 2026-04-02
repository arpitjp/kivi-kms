import * as vscode from 'vscode';
import * as path from 'path';

type TreeNode = FileNode | FolderNode;

interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
  label: string;
}

interface FolderNode {
  kind: 'folder';
  uri: vscode.Uri;
  label: string;
}

export class FileExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private mdCache = new Map<string, boolean>();

  refresh(): void {
    this.mdCache.clear();
    this.mdDirSet = null;
    this.mdDirSetPromise = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.kind === 'folder'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    if (element.kind === 'file') {
      item.command = {
        command: 'vscode.openWith',
        title: 'Open in Kivi',
        arguments: [element.uri, 'kivi.markdownEditor'],
      };
      item.iconPath = new vscode.ThemeIcon('file-text');
      item.contextValue = 'kiviFile';
      item.description = '.md';
      item.resourceUri = element.uri;
    } else {
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'kiviFolder';
      item.resourceUri = element.uri;
    }

    return item;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!vscode.workspace.workspaceFolders?.length) return [];

    const searchDir = element?.kind === 'folder'
      ? element.uri
      : vscode.workspace.workspaceFolders[0].uri;

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
            nodes.push({ kind: 'folder', uri, label: name });
          }
        } else if (name.endsWith('.md') || name.endsWith('.markdown')) {
          nodes.push({ kind: 'file', uri, label: name.replace(/\.(md|markdown)$/, '') });
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
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsRoot) return dirs;

      const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 5000);
      for (const uri of files) {
        let dir = path.dirname(uri.fsPath);
        while (dir && dir.length >= wsRoot.length) {
          if (dirs.has(dir)) break;
          dirs.add(dir);
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
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
