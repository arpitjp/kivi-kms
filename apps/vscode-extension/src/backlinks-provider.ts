import * as vscode from 'vscode';

type TreeNode = CategoryItem | BacklinkItem;

interface CategoryItem {
  kind: 'category';
  label: string;
  children: BacklinkItem[];
}

interface BacklinkItem {
  kind: 'backlink';
  path: string;
  label: string;
}

export class BacklinksProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private wikiLinkIndex = new Map<string, Set<string>>();
  private fileLabels = new Map<string, string>();
  private fileOutgoing = new Map<string, string[]>();

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Update index for a single file. Pass `silent: true` during bulk indexing
   * to avoid firing a tree refresh after every file.
   */
  updateIndex(filePath: string, content: string, silent = false): void {
    this.removeFromIndex(filePath);

    const links = extractWikiLinks(content);
    const title = extractTitle(content, filePath);

    this.fileLabels.set(filePath, title);
    this.fileOutgoing.set(filePath, links);

    for (const link of links) {
      const normalized = link.toLowerCase();
      if (!this.wikiLinkIndex.has(normalized)) {
        this.wikiLinkIndex.set(normalized, new Set());
      }
      this.wikiLinkIndex.get(normalized)!.add(filePath);
    }

    if (!silent) this.refresh();
  }

  removeFromIndex(filePath: string): void {
    for (const [, sources] of this.wikiLinkIndex) {
      sources.delete(filePath);
    }
    this.fileLabels.delete(filePath);
    this.fileOutgoing.delete(filePath);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(
        `${element.label} (${element.children.length})`,
        element.children.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon(
        element.label === 'Incoming' ? 'arrow-left' : 'arrow-right',
      );
      return item;
    }

    const item = new vscode.TreeItem(element.label);
    item.tooltip = element.path;
    item.description = this.getRelativePath(element.path);
    item.command = {
      command: 'vscode.openWith',
      title: 'Open in Kivi',
      arguments: [vscode.Uri.file(element.path), 'kivi.markdownEditor'],
    };
    item.iconPath = new vscode.ThemeIcon('file-text');
    return item;
  }

  private getRelativePath(filePath: string): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return '';
    const rel = filePath.replace(folder.uri.fsPath, '').replace(/^[\\/]/, '');
    const parts = rel.split(/[\\/]/);
    if (parts.length <= 1) return '';
    return parts.slice(0, -1).join('/');
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element && element.kind === 'category') {
      return element.children;
    }

    if (element) return [];

    let currentPath: string | undefined;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      currentPath = editor.document.uri.fsPath;
    } else {
      const tabUri = (vscode.window.tabGroups.activeTabGroup.activeTab?.input as any)?.uri as vscode.Uri | undefined;
      if (tabUri) currentPath = tabUri.fsPath;
    }
    if (!currentPath) return [];

    const currentName = this.getBaseName(currentPath).toLowerCase();
    const incoming = this.getIncoming(currentPath, currentName);
    const outgoing = this.getOutgoing(currentPath);

    return [
      { kind: 'category' as const, label: 'Incoming', children: incoming },
      { kind: 'category' as const, label: 'Outgoing', children: outgoing },
    ];
  }

  private getIncoming(currentPath: string, currentName: string): BacklinkItem[] {
    const backlinks: BacklinkItem[] = [];
    const seen = new Set<string>();

    for (const [target, sources] of this.wikiLinkIndex) {
      if (target === currentName || target === currentName.replace(/\.md$/, '')) {
        for (const sourcePath of sources) {
          if (sourcePath !== currentPath && !seen.has(sourcePath)) {
            seen.add(sourcePath);
            backlinks.push({
              kind: 'backlink',
              path: sourcePath,
              label: this.fileLabels.get(sourcePath) || this.getBaseName(sourcePath),
            });
          }
        }
      }
    }

    return backlinks.sort((a, b) => a.label.localeCompare(b.label));
  }

  private getOutgoing(currentPath: string): BacklinkItem[] {
    const links = this.fileOutgoing.get(currentPath) || [];
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || links.length === 0) return [];

    const results: BacklinkItem[] = [];
    const seen = new Set<string>();

    for (const link of links) {
      const normalized = link.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      let resolvedPath: string | undefined;
      for (const [path] of this.fileLabels) {
        const name = this.getBaseName(path).toLowerCase().replace(/\.md$/, '');
        if (name === normalized) {
          resolvedPath = path;
          break;
        }
      }

      results.push({
        kind: 'backlink',
        path: resolvedPath || '',
        label: this.fileLabels.get(resolvedPath || '') || link,
      });
    }

    return results.sort((a, b) => a.label.localeCompare(b.label));
  }

  private getBaseName(filePath: string): string {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }
}

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const HEADING_RE = /^#\s+(.+)$/m;

function extractWikiLinks(content: string): string[] {
  const links: string[] = [];
  let match: RegExpExecArray | null;
  WIKI_LINK_RE.lastIndex = 0;
  while ((match = WIKI_LINK_RE.exec(content)) !== null) {
    links.push(match[1].trim().toLowerCase().replace(/\.md$/, ''));
  }
  return links;
}

function extractTitle(content: string, filePath: string): string {
  const match = HEADING_RE.exec(content);
  if (match) return match[1].trim();
  const parts = filePath.split(/[\\/]/);
  return (parts[parts.length - 1] || '').replace(/\.md$/, '');
}
