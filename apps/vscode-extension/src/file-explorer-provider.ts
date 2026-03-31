import * as vscode from 'vscode';

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

  private async containsMarkdown(dir: vscode.Uri): Promise<boolean> {
    const key = dir.toString();
    const cached = this.mdCache.get(key);
    if (cached !== undefined) return cached;

    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && (name.endsWith('.md') || name.endsWith('.markdown'))) {
          this.mdCache.set(key, true);
          return true;
        }
      }
      // Only recurse into subdirectories after checking all files at this level
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory && !name.startsWith('.') && name !== 'node_modules') {
          const has = await this.containsMarkdown(vscode.Uri.joinPath(dir, name));
          if (has) {
            this.mdCache.set(key, true);
            return true;
          }
        }
      }
    } catch {
      // ignore
    }
    this.mdCache.set(key, false);
    return false;
  }
}
