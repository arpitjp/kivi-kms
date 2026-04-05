import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface OutlineItem {
  label: string;
  rawText: string;
  level: number;
  line: number;
  children: OutlineItem[];
}

let _iconDir: string | null = null;

const HEADING_COLORS_DARK: Record<number, string> = {
  1: '#e06c75', // soft red
  2: '#61afef', // blue
  3: '#98c379', // green
  4: '#d19a66', // orange
  5: '#c678dd', // purple
  6: '#56b6c2', // cyan
};

const HEADING_COLORS_LIGHT: Record<number, string> = {
  1: '#c9384b', // red
  2: '#4078f2', // blue
  3: '#518c25', // green
  4: '#b76c1a', // orange
  5: '#9a40bd', // purple
  6: '#0f8a8a', // teal
};

function ensureHeadingIcons(context: vscode.ExtensionContext): string {
  if (_iconDir) return _iconDir;
  const dir = path.join(context.globalStorageUri.fsPath, 'heading-icons');

  const VERSION = '4';
  const marker = path.join(dir, `.version-${VERSION}`);
  if (fs.existsSync(marker)) {
    _iconDir = dir;
    return dir;
  }

  fs.mkdirSync(dir, { recursive: true });

  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.svg') || f.startsWith('.version-')) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
  }

  for (let lvl = 1; lvl <= 6; lvl++) {
    for (const theme of ['light', 'dark'] as const) {
      const fill = theme === 'dark' ? HEADING_COLORS_DARK[lvl] : HEADING_COLORS_LIGHT[lvl];
      const size = Math.max(10, 14 - lvl);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">`
        + `<text x="1" y="12" font-family="system-ui,sans-serif" font-size="${size}" font-weight="700" fill="${fill}">H${lvl}</text></svg>`;
      fs.writeFileSync(path.join(dir, `h${lvl}-${theme}.svg`), svg);
    }
  }
  fs.writeFileSync(marker, '');
  _iconDir = dir;
  return dir;
}

function headingIconPath(level: number, iconDir: string): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.file(path.join(iconDir, `h${level}-light.svg`)),
    dark: vscode.Uri.file(path.join(iconDir, `h${level}-dark.svg`)),
  };
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+#+\s*$/, '')
    .trim();
}

export function makeHeadingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export class OutlineProvider implements vscode.TreeDataProvider<OutlineItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<OutlineItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: OutlineItem[] = [];
  private allItems: OutlineItem[] = [];
  private collapsed = false;
  private iconDir: string | null = null;

  constructor(private context?: vscode.ExtensionContext) {
    if (context) {
      try { this.iconDir = ensureHeadingIcons(context); } catch { /* fallback to no icons */ }
    }
  }

  refresh(): void {
    this.collapsed = false;
    this.parseActiveDocument().then(() => {
      this._onDidChangeTreeData.fire();
    });
  }

  collapseAll(): void {
    this.collapsed = true;
    this._onDidChangeTreeData.fire();
  }

  expandAll(): void {
    this.collapsed = false;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: OutlineItem): vscode.TreeItem {
    const hasChildren = element.children.length > 0;
    const item = new vscode.TreeItem(
      element.label,
      hasChildren
        ? (this.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
        : vscode.TreeItemCollapsibleState.None,
    );

    item.tooltip = `H${element.level} — line ${element.line}`;
    item.command = {
      command: 'kivi.scrollToHeading',
      title: 'Go to heading',
      arguments: [element.label, element.line],
    };
    if (this.iconDir) {
      item.iconPath = headingIconPath(element.level, this.iconDir);
    }
    item.contextValue = 'kiviOutlineHeading';

    return item;
  }

  getChildren(element?: OutlineItem): Thenable<OutlineItem[]> | OutlineItem[] {
    if (!element) {
      if (this.roots.length === 0) {
        return this.parseActiveDocument().then(() => this.roots);
      }
      return this.roots;
    }
    return element.children;
  }

  getParent(element: OutlineItem): OutlineItem | undefined {
    return findParent(this.roots, element);
  }

  findByLabel(label: string): OutlineItem | undefined {
    const normalized = label.trim().toLowerCase();
    return this.allItems.find(
      (item) => item.label.trim().toLowerCase() === normalized,
    );
  }

  private async parseActiveDocument(): Promise<void> {
    this.roots = [];
    this.allItems = [];

    let text: string | undefined;

    const editor = vscode.window.activeTextEditor;
    if (editor && (editor.document.languageId === 'markdown' || editor.document.fileName.endsWith('.md'))) {
      text = editor.document.getText();
    } else {
      const tabUri = (vscode.window.tabGroups.activeTabGroup.activeTab?.input as any)?.uri as vscode.Uri | undefined;
      if (tabUri && (tabUri.fsPath.endsWith('.md') || tabUri.fsPath.endsWith('.markdown'))) {
        try {
          const doc = await vscode.workspace.openTextDocument(tabUri);
          text = doc.getText();
        } catch { /* file may not be accessible */ }
      }
    }

    if (!text) return;

    const flatHeadings: OutlineItem[] = [];
    const lines = text.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      const match = /^(#{1,6})\s+(.+)$/.exec(line);
      if (match) {
        const rawText = match[2].trim().replace(/\s+#+\s*$/, '');
        const label = stripMarkdownInline(rawText);
        if (!label) continue;
        flatHeadings.push({
          level: match[1].length,
          label,
          rawText,
          line: i + 1,
          children: [],
        });
      }
    }

    this.allItems = flatHeadings;
    this.roots = buildTree(flatHeadings);
  }
}

function findParent(roots: OutlineItem[], target: OutlineItem): OutlineItem | undefined {
  for (const root of roots) {
    if (root.children.includes(target)) return root;
    const found = findParent(root.children, target);
    if (found) return found;
  }
  return undefined;
}

function buildTree(headings: OutlineItem[]): OutlineItem[] {
  const roots: OutlineItem[] = [];
  const stack: OutlineItem[] = [];

  for (const h of headings) {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(h);
    } else {
      stack[stack.length - 1].children.push(h);
    }

    stack.push(h);
  }

  return roots;
}
