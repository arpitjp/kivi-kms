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

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.kind === 'folder'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );

    if (element.kind === 'file') {
      item.command = {
        command: 'vscode.openWith',
        title: 'Open in Kivi',
        arguments: [element.uri, 'kivi.markdownEditor'],
      };
      item.iconPath = new vscode.ThemeIcon('markdown');
      item.contextValue = 'kiviFile';
    } else {
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'kiviFolder';
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
        if (a[1] !== b[1]) return b[1] - a[1]; // folders first
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
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && (name.endsWith('.md') || name.endsWith('.markdown'))) {
          return true;
        }
        if (type === vscode.FileType.Directory && !name.startsWith('.') && name !== 'node_modules') {
          const has = await this.containsMarkdown(vscode.Uri.joinPath(dir, name));
          if (has) return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  }
}
