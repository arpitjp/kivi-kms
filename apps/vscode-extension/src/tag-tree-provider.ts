import * as vscode from 'vscode';

type TagNode = TagBranch | TagLeaf;

interface TagBranch {
  kind: 'branch';
  label: string;
  fullTag: string;
  children: TagNode[];
  fileCount: number;
}

interface TagLeaf {
  kind: 'leaf';
  label: string;
  fullTag: string;
  files: string[];
}

export class TagTreeProvider implements vscode.TreeDataProvider<TagNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TagNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private tagIndex = new Map<string, Set<string>>();
  private rootNodes: TagNode[] = [];

  refresh(): void {
    this.rootNodes = this.buildTree();
    this._onDidChangeTreeData.fire();
  }

  updateIndex(filePath: string, tags: string[]): void {
    // Remove old entries for this file
    for (const [, files] of this.tagIndex) {
      files.delete(filePath);
    }
    // Add new entries
    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) { set = new Set(); this.tagIndex.set(tag, set); }
      set.add(filePath);
    }
    // Clean up empty tags
    for (const [tag, files] of this.tagIndex) {
      if (files.size === 0) this.tagIndex.delete(tag);
    }
  }

  removeFile(filePath: string): void {
    for (const [, files] of this.tagIndex) {
      files.delete(filePath);
    }
    for (const [tag, files] of this.tagIndex) {
      if (files.size === 0) this.tagIndex.delete(tag);
    }
  }

  getTreeItem(element: TagNode): vscode.TreeItem {
    if (element.kind === 'branch') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('tag');
      item.description = `${element.fileCount}`;
      item.contextValue = 'kiviTagBranch';
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('symbol-keyword');
    item.description = `${element.files.length} file${element.files.length === 1 ? '' : 's'}`;
    item.contextValue = 'kiviTagLeaf';
    item.command = {
      command: 'kivi.searchTag',
      title: 'Search tag',
      arguments: [element.fullTag],
    };
    return item;
  }

  getChildren(element?: TagNode): TagNode[] {
    if (!element) {
      if (this.rootNodes.length === 0) this.rootNodes = this.buildTree();
      return this.rootNodes;
    }
    if (element.kind === 'branch') return element.children;
    return [];
  }

  private buildTree(): TagNode[] {
    interface TrieNode {
      children: Map<string, TrieNode>;
      files: Set<string>;
    }

    const root: TrieNode = { children: new Map(), files: new Set() };

    for (const [tag, files] of this.tagIndex) {
      const parts = tag.split('/');
      let node = root;
      for (const part of parts) {
        let child = node.children.get(part);
        if (!child) { child = { children: new Map(), files: new Set() }; node.children.set(part, child); }
        node = child;
      }
      for (const f of files) node.files.add(f);
    }

    const convert = (trieNode: TrieNode, prefix: string): TagNode[] => {
      const result: TagNode[] = [];

      const sortedEntries = Array.from(trieNode.children.entries()).sort(([a], [b]) => a.localeCompare(b));

      for (const [label, child] of sortedEntries) {
        const fullTag = prefix ? `${prefix}/${label}` : label;
        const totalFiles = this.countFiles(child);

        if (child.children.size === 0) {
          result.push({
            kind: 'leaf',
            label,
            fullTag,
            files: Array.from(child.files),
          });
        } else if (child.files.size > 0 || child.children.size > 1) {
          result.push({
            kind: 'branch',
            label,
            fullTag,
            children: [
              ...(child.files.size > 0 ? [{
                kind: 'leaf' as const,
                label: `#${fullTag}`,
                fullTag,
                files: Array.from(child.files),
              }] : []),
              ...convert(child, fullTag),
            ],
            fileCount: totalFiles,
          });
        } else {
          // Single child branch: collapse into one node
          const subNodes = convert(child, fullTag);
          if (subNodes.length === 1 && subNodes[0].kind === 'leaf') {
            result.push({ ...subNodes[0], label: `${label}/${subNodes[0].label}` });
          } else {
            result.push({
              kind: 'branch',
              label,
              fullTag,
              children: subNodes,
              fileCount: totalFiles,
            });
          }
        }
      }

      return result;
    };

    return convert(root, '');
  }

  private countFiles(node: { children: Map<string, unknown>; files: Set<string> }): number {
    let count = node.files.size;
    for (const child of (node.children as Map<string, typeof node>).values()) {
      count += this.countFiles(child);
    }
    return count;
  }
}
