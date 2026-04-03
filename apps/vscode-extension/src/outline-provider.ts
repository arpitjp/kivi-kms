import * as vscode from 'vscode';

export interface OutlineItem {
  label: string;
  rawText: string;
  level: number;
  line: number;
  children: OutlineItem[];
}

const headingIcons: Record<number, string> = {
  1: 'symbol-class',
  2: 'symbol-method',
  3: 'symbol-field',
  4: 'symbol-variable',
  5: 'symbol-constant',
  6: 'symbol-property',
};

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

  getTreeItem(element: OutlineItem): vscode.TreeItem {
    const hasChildren = element.children.length > 0;
    const item = new vscode.TreeItem(
      element.label,
      hasChildren
        ? (this.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
        : vscode.TreeItemCollapsibleState.None,
    );

    item.description = `L${element.line}`;
    item.tooltip = `H${element.level} — line ${element.line}`;
    item.command = {
      command: 'kivi.scrollToHeading',
      title: 'Go to heading',
      arguments: [element.label, element.line],
    };
    item.iconPath = new vscode.ThemeIcon(headingIcons[element.level] || 'symbol-key');
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
