import * as vscode from 'vscode';

interface OutlineItem {
  label: string;
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

export class OutlineProvider implements vscode.TreeDataProvider<OutlineItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<OutlineItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: OutlineItem[] = [];

  refresh(): void {
    this.parseActiveDocument().then(() => {
      this._onDidChangeTreeData.fire();
    });
  }

  getTreeItem(element: OutlineItem): vscode.TreeItem {
    const hasChildren = element.children.length > 0;
    const item = new vscode.TreeItem(
      element.label,
      hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );

    item.description = `H${element.level}`;
    // Use a custom command that works for both text editors and custom webview editors
    item.command = {
      command: 'kivi.scrollToHeading',
      title: 'Go to heading',
      arguments: [element.label, element.line],
    };
    item.iconPath = new vscode.ThemeIcon(headingIcons[element.level] || 'symbol-key');

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

  private async parseActiveDocument(): Promise<void> {
    this.roots = [];

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
        flatHeadings.push({
          level: match[1].length,
          label: match[2].trim().replace(/\s+#+\s*$/, ''),
          line: i + 1,
          children: [],
        });
      }
    }

    this.roots = buildTree(flatHeadings);
  }
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
