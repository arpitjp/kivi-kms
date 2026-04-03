import * as vscode from 'vscode';
import * as path from 'path';

type IssueNode = IssueCategoryItem | IssueItem;

interface IssueCategoryItem {
  kind: 'category';
  label: string;
  icon: string;
  children: IssueItem[];
}

interface IssueItem {
  kind: 'issue';
  label: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  filePath: string;
  line?: number;
}

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

export class IssuesProvider implements vscode.TreeDataProvider<IssueNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<IssueNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private categories: IssueCategoryItem[] = [];
  private scanning = false;

  refresh(): void {
    this.scan().then(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: IssueNode): vscode.TreeItem {
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(
        `${element.label} (${element.children.length})`,
        element.children.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon(element.icon);
      return item;
    }

    const item = new vscode.TreeItem(element.label);
    item.description = element.description;
    item.tooltip = `${element.filePath}${element.line ? `:${element.line}` : ''}`;

    const iconMap = { error: 'error', warning: 'warning', info: 'info' };
    item.iconPath = new vscode.ThemeIcon(iconMap[element.severity]);

    if (element.filePath) {
      item.command = {
        command: 'kivi.issueNavigate',
        title: 'Go to issue',
        arguments: [element.filePath, element.line],
      };
    }

    return item;
  }

  getChildren(element?: IssueNode): IssueNode[] | Thenable<IssueNode[]> {
    if (!element) {
      if (this.categories.length === 0 && !this.scanning) {
        return this.scan().then(() => this.categories);
      }
      return this.categories;
    }
    if (element.kind === 'category') return element.children;
    return [];
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.categories = [];
      this.scanning = false;
      return;
    }

    const brokenLinks: IssueItem[] = [];
    const orphanAssets: IssueItem[] = [];

    try {
      const mdFiles = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 2000);
      const decoder = new TextDecoder();

      const allMdNames = new Set<string>();
      for (const uri of mdFiles) {
        const basename = path.basename(uri.fsPath, '.md').toLowerCase();
        allMdNames.add(basename);
      }

      const referencedAssets = new Set<string>();

      for (const uri of mdFiles) {
        let content: string;
        try {
          content = decoder.decode(await vscode.workspace.fs.readFile(uri));
        } catch { continue; }

        const relPath = vscode.workspace.asRelativePath(uri, false);
        const lines = content.split('\n');
        let inFence = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/^```/.test(line.trimStart())) { inFence = !inFence; continue; }
          if (inFence) continue;

          // Check wiki links
          WIKI_LINK_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = WIKI_LINK_RE.exec(line)) !== null) {
            const target = m[1].trim().toLowerCase().replace(/\.md$/, '');
            if (target.includes('#')) continue;
            if (!allMdNames.has(target)) {
              brokenLinks.push({
                kind: 'issue',
                label: `[[${m[1].trim()}]]`,
                description: relPath,
                severity: 'error',
                filePath: uri.fsPath,
                line: i + 1,
              });
            }
          }

          // Collect asset references from images and markdown links
          IMG_RE.lastIndex = 0;
          while ((m = IMG_RE.exec(line)) !== null) {
            const href = m[2].trim();
            if (!href.startsWith('http') && !href.startsWith('data:')) {
              const resolved = path.resolve(path.dirname(uri.fsPath), href);
              referencedAssets.add(resolved);
            }
          }

          MD_LINK_RE.lastIndex = 0;
          while ((m = MD_LINK_RE.exec(line)) !== null) {
            const href = m[2].trim();
            if (!href.startsWith('http') && !href.startsWith('#') && !href.startsWith('data:')) {
              const resolved = path.resolve(path.dirname(uri.fsPath), href);
              referencedAssets.add(resolved);
            }
          }
        }
      }

      // Find orphan assets
      const config = vscode.workspace.getConfiguration('kivi');
      const assetsFolder = config.get<string>('folders.assets', 'assets');
      const assetsGlob = `${assetsFolder}/**`;

      try {
        const assetFiles = await vscode.workspace.findFiles(assetsGlob, '**/node_modules/**', 5000);
        for (const assetUri of assetFiles) {
          if (!referencedAssets.has(assetUri.fsPath)) {
            const relAsset = vscode.workspace.asRelativePath(assetUri, false);
            const ext = path.extname(assetUri.fsPath).toLowerCase();
            const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext);
            const isVideo = ['.mp4', '.webm', '.mov', '.avi'].includes(ext);

            orphanAssets.push({
              kind: 'issue',
              label: path.basename(assetUri.fsPath),
              description: isImage ? 'Unreferenced image' : isVideo ? 'Unreferenced video' : 'Unreferenced file',
              severity: 'warning',
              filePath: assetUri.fsPath,
            });
          }
        }
      } catch { /* assets folder may not exist */ }

    } catch { /* scan failed */ }

    this.categories = [
      { kind: 'category', label: 'Broken Links', icon: 'link', children: brokenLinks },
      { kind: 'category', label: 'Orphan Assets', icon: 'file-media', children: orphanAssets },
    ];
    this.scanning = false;
  }
}
