import * as vscode from 'vscode';

interface BacklinkItem {
  path: string;
  label: string;
}

export class BacklinksProvider implements vscode.TreeDataProvider<BacklinkItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BacklinkItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private wikiLinkIndex = new Map<string, Set<string>>();
  private fileLabels = new Map<string, string>();

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  updateIndex(filePath: string, content: string): void {
    this.removeFromIndex(filePath);

    const links = extractWikiLinks(content);
    const title = extractTitle(content, filePath);

    this.fileLabels.set(filePath, title);

    for (const link of links) {
      const normalized = link.toLowerCase();
      if (!this.wikiLinkIndex.has(normalized)) {
        this.wikiLinkIndex.set(normalized, new Set());
      }
      this.wikiLinkIndex.get(normalized)!.add(filePath);
    }

    this.refresh();
  }

  removeFromIndex(filePath: string): void {
    for (const [, sources] of this.wikiLinkIndex) {
      sources.delete(filePath);
    }
    this.fileLabels.delete(filePath);
  }

  getTreeItem(element: BacklinkItem): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label);
    item.tooltip = element.path;
    item.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(element.path)],
    };
    item.iconPath = new vscode.ThemeIcon('file');
    return item;
  }

  getChildren(): BacklinkItem[] {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return [];

    const currentPath = editor.document.uri.fsPath;
    const currentName = this.getBaseName(currentPath).toLowerCase();

    const backlinks: BacklinkItem[] = [];
    const seen = new Set<string>();

    for (const [target, sources] of this.wikiLinkIndex) {
      if (target === currentName || target === currentName.replace(/\.md$/, '')) {
        for (const sourcePath of sources) {
          if (sourcePath !== currentPath && !seen.has(sourcePath)) {
            seen.add(sourcePath);
            backlinks.push({
              path: sourcePath,
              label: this.fileLabels.get(sourcePath) || this.getBaseName(sourcePath),
            });
          }
        }
      }
    }

    return backlinks.sort((a, b) => a.label.localeCompare(b.label));
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
