import type { VaultFile, GraphNode, GraphEdge, FileSystemAdapter } from './types.js';
import { scanMarkdown } from './scanner.js';

export class Vault {
  readonly files = new Map<string, VaultFile>();
  private fsAdapter?: FileSystemAdapter;
  private stopWatcher?: () => void;

  constructor(adapter?: FileSystemAdapter) {
    this.fsAdapter = adapter;
  }

  addFile(path: string, content: string): VaultFile {
    const scan = scanMarkdown(content);
    const existing = this.files.get(path);

    const file: VaultFile = {
      path,
      title: scan.title || this.titleFromPath(path),
      wikiLinks: scan.wikiLinks,
      backlinks: existing?.backlinks ?? [],
      tags: scan.tags,
      frontmatter: scan.frontmatter,
      headings: scan.headings,
      parent: this.inferParent(path, scan.frontmatter),
      children: existing?.children ?? [],
    };

    this.files.set(path, file);
    this.rebuildBacklinks();
    this.rebuildHierarchy();
    return file;
  }

  updateFile(path: string, content: string): VaultFile {
    return this.addFile(path, content);
  }

  removeFile(path: string): void {
    this.files.delete(path);
    this.rebuildBacklinks();
    this.rebuildHierarchy();
  }

  getFile(path: string): VaultFile | undefined {
    return this.files.get(path);
  }

  getBacklinks(path: string): VaultFile[] {
    const file = this.files.get(path);
    if (!file) return [];
    return file.backlinks
      .map((p) => this.files.get(p))
      .filter((f): f is VaultFile => !!f);
  }

  getTagIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const [path, file] of this.files) {
      for (const tag of file.tags) {
        const parts = tag.split('/');
        // Index both the full tag and all parent segments
        for (let i = 1; i <= parts.length; i++) {
          const key = parts.slice(0, i).join('/');
          const list = index.get(key) ?? [];
          if (!list.includes(path)) list.push(path);
          index.set(key, list);
        }
      }
    }
    return index;
  }

  getGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const pathSet = new Set(this.files.keys());

    for (const [, file] of this.files) {
      nodes.push({
        id: file.path,
        label: file.title,
        backlinkCount: file.backlinks.length,
        tags: file.tags,
      });

      for (const link of file.wikiLinks) {
        const targetPath = this.resolveWikiLink(link);
        if (targetPath && pathSet.has(targetPath)) {
          edges.push({ source: file.path, target: targetPath });
        }
      }
    }

    return { nodes, edges };
  }

  search(query: string): VaultFile[] {
    const lower = query.toLowerCase();
    const results: VaultFile[] = [];

    for (const [, file] of this.files) {
      if (
        file.title.toLowerCase().includes(lower) ||
        file.path.toLowerCase().includes(lower) ||
        file.tags.some((t) => t.toLowerCase().includes(lower))
      ) {
        results.push(file);
      }
    }

    return results;
  }

  /** Load all markdown files from the file system adapter. */
  async loadFromFs(dir: string): Promise<void> {
    if (!this.fsAdapter) return;
    const paths = await this.fsAdapter.listFiles(dir, '**/*.md');
    for (const path of paths) {
      const content = await this.fsAdapter.readFile(path);
      this.addFile(path, content);
    }
  }

  /** Start watching for file changes. Returns a cleanup function. */
  watch(dir: string): () => void {
    if (!this.fsAdapter?.watchFiles) return () => {};

    this.stopWatcher = this.fsAdapter.watchFiles(dir, async (event, path) => {
      if (!path.endsWith('.md')) return;
      if (event === 'delete') {
        this.removeFile(path);
      } else {
        try {
          const content = await this.fsAdapter!.readFile(path);
          this.addFile(path, content);
        } catch {
          // File may have been deleted between event and read
        }
      }
    });

    return () => this.stopWatcher?.();
  }

  destroy(): void {
    this.stopWatcher?.();
    this.files.clear();
  }

  private resolveWikiLink(linkTarget: string): string | undefined {
    // Exact path match
    if (this.files.has(linkTarget)) return linkTarget;

    // Try with .md extension
    const withMd = linkTarget.endsWith('.md') ? linkTarget : `${linkTarget}.md`;
    if (this.files.has(withMd)) return withMd;

    // Basename match (Obsidian-style shortest path)
    const linkBase = linkTarget.split('/').pop()?.toLowerCase() ?? '';
    for (const path of this.files.keys()) {
      const fileBase = path.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() ?? '';
      if (fileBase === linkBase || fileBase === linkBase.replace(/\.md$/i, '')) {
        return path;
      }
    }

    return undefined;
  }

  private rebuildBacklinks(): void {
    // Clear all backlinks first
    for (const [, file] of this.files) {
      file.backlinks = [];
    }

    // Rebuild
    for (const [sourcePath, sourceFile] of this.files) {
      for (const link of sourceFile.wikiLinks) {
        const targetPath = this.resolveWikiLink(link);
        if (targetPath) {
          const targetFile = this.files.get(targetPath);
          if (targetFile && !targetFile.backlinks.includes(sourcePath)) {
            targetFile.backlinks.push(sourcePath);
          }
        }
      }
    }
  }

  private rebuildHierarchy(): void {
    // Clear children
    for (const [, file] of this.files) {
      file.children = [];
    }

    // Rebuild parent→children relationships
    for (const [path, file] of this.files) {
      if (file.parent) {
        const parentPath = this.resolveWikiLink(file.parent) ?? file.parent;
        const parentFile = this.files.get(parentPath);
        if (parentFile && !parentFile.children.includes(path)) {
          parentFile.children.push(path);
        }
      }
    }
  }

  private inferParent(
    path: string,
    frontmatter: Record<string, unknown>,
  ): string | undefined {
    if (typeof frontmatter.parent === 'string') {
      return frontmatter.parent;
    }
    // Infer from directory: parent is the index/readme of the parent folder
    const parts = path.split('/');
    if (parts.length <= 1) return undefined;
    const dir = parts.slice(0, -1).join('/');
    const candidates = [`${dir}/index.md`, `${dir}/README.md`];
    for (const c of candidates) {
      if (this.files.has(c) && c !== path) return c;
    }
    return undefined;
  }

  private titleFromPath(path: string): string {
    const parts = path.split('/');
    const filename = parts[parts.length - 1] || 'Untitled';
    return filename.replace(/\.md$/i, '');
  }
}
