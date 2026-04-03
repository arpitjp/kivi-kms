import * as vscode from 'vscode';
import * as path from 'path';

type AssetNode = AssetCategory | AssetItem;

interface AssetCategory {
  kind: 'category';
  label: string;
  icon: string;
  children: AssetItem[];
}

interface AssetItem {
  kind: 'asset';
  label: string;
  description: string;
  filePath: string;
  /** Line in the referencing markdown file where this asset first appears */
  referenceLine?: number;
  referenceFile?: string;
}

const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);
const DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv']);

function classifyAsset(ext: string): { category: string; icon: string } {
  if (IMG_EXTS.has(ext)) return { category: 'Images', icon: 'file-media' };
  if (VIDEO_EXTS.has(ext)) return { category: 'Videos', icon: 'play-circle' };
  if (DOC_EXTS.has(ext)) return { category: 'Documents', icon: 'file-pdf' };
  return { category: 'Other', icon: 'file-binary' };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class AssetsProvider implements vscode.TreeDataProvider<AssetNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AssetNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private categories: AssetCategory[] = [];
  private scanning = false;

  refresh(): void {
    this.scan().then(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: AssetNode): vscode.TreeItem {
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(
        `${element.label} (${element.children.length})`,
        element.children.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon(element.icon);
      return item;
    }

    const item = new vscode.TreeItem(element.label);
    item.description = element.description;
    item.tooltip = element.filePath;
    item.iconPath = new vscode.ThemeIcon(this.getFileIcon(element.filePath));

    item.command = {
      command: 'kivi.assetNavigate',
      title: 'Open asset',
      arguments: [element.filePath, element.referenceFile, element.referenceLine],
    };

    return item;
  }

  getChildren(element?: AssetNode): AssetNode[] | Thenable<AssetNode[]> {
    if (!element) {
      if (this.categories.length === 0 && !this.scanning) {
        return this.scan().then(() => this.categories);
      }
      return this.categories;
    }
    if (element.kind === 'category') return element.children;
    return [];
  }

  private getFileIcon(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return classifyAsset(ext).icon;
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

    const config = vscode.workspace.getConfiguration('kivi');
    const assetsFolder = config.get<string>('folders.assets', 'assets');

    const groups = new Map<string, AssetItem[]>();

    try {
      const assetFiles = await vscode.workspace.findFiles(`${assetsFolder}/**`, '**/node_modules/**', 5000);

      // Build a quick lookup: asset basename → first markdown reference
      const assetRefMap = new Map<string, { file: string; line: number }>();
      try {
        const mdFiles = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 2000);
        const decoder = new TextDecoder();
        for (const mdUri of mdFiles) {
          try {
            const content = decoder.decode(await vscode.workspace.fs.readFile(mdUri));
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              for (const assetUri of assetFiles) {
                const basename = path.basename(assetUri.fsPath);
                if (lines[i].includes(basename) && !assetRefMap.has(assetUri.fsPath)) {
                  assetRefMap.set(assetUri.fsPath, { file: mdUri.fsPath, line: i + 1 });
                }
              }
            }
          } catch { continue; }
        }
      } catch { /* ok */ }

      for (const uri of assetFiles) {
        const ext = path.extname(uri.fsPath).toLowerCase();
        const { category } = classifyAsset(ext);

        let sizeStr = '';
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          sizeStr = humanSize(stat.size);
        } catch { /* ok */ }

        const ref = assetRefMap.get(uri.fsPath);

        const item: AssetItem = {
          kind: 'asset',
          label: path.basename(uri.fsPath),
          description: sizeStr,
          filePath: uri.fsPath,
          referenceFile: ref?.file,
          referenceLine: ref?.line,
        };

        if (!groups.has(category)) groups.set(category, []);
        groups.get(category)!.push(item);
      }
    } catch { /* scan failed */ }

    const order = ['Images', 'Videos', 'Documents', 'Other'];
    const iconMap: Record<string, string> = {
      Images: 'file-media',
      Videos: 'play-circle',
      Documents: 'file-pdf',
      Other: 'file-binary',
    };

    this.categories = order
      .filter(cat => groups.has(cat))
      .map(cat => ({
        kind: 'category' as const,
        label: cat,
        icon: iconMap[cat] || 'file',
        children: groups.get(cat)!.sort((a, b) => a.label.localeCompare(b.label)),
      }));

    this.scanning = false;
  }
}
