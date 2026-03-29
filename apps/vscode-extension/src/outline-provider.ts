import * as vscode from 'vscode';

interface OutlineItem {
  label: string;
  level: number;
  line: number;
}

export class OutlineProvider implements vscode.TreeDataProvider<OutlineItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<OutlineItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private headings: OutlineItem[] = [];

  refresh(): void {
    this.parseActiveDocument();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: OutlineItem): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    const indent = '  '.repeat(Math.max(0, element.level - 1));
    item.label = `${indent}${'#'.repeat(element.level)} ${element.label}`;
    item.command = {
      command: 'revealLine',
      title: 'Go to heading',
      arguments: [{ lineNumber: element.line, at: 'center' }],
    };
    item.iconPath = new vscode.ThemeIcon('symbol-structure');
    return item;
  }

  getChildren(): OutlineItem[] {
    if (this.headings.length === 0) {
      this.parseActiveDocument();
    }
    return this.headings;
  }

  private parseActiveDocument(): void {
    this.headings = [];

    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;
    if (doc.languageId !== 'markdown' && !doc.fileName.endsWith('.md')) return;

    const text = doc.getText();
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
        this.headings.push({
          level: match[1].length,
          label: match[2].trim().replace(/\s+#+\s*$/, ''),
          line: i + 1,
        });
      }
    }
  }
}
