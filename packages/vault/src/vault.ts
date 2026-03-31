import type { VaultFile, GraphNode, GraphEdge, GraphData, GraphFilter, FileSystemAdapter, EdgeType, NodeType } from './types.js';
import { scanMarkdown } from './scanner.js';

export class Vault {
  readonly files = new Map<string, VaultFile>();
  private fsAdapter?: FileSystemAdapter;
  private stopWatcher?: () => void;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private needsRebuild = false;

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
      markdownLinks: scan.markdownLinks,
      assetRefs: scan.assetRefs,
      backlinks: existing?.backlinks ?? [],
      tags: scan.tags,
      frontmatter: scan.frontmatter,
      headings: scan.headings,
      contentLength: content.length,
      parent: this.inferParent(path, scan.frontmatter),
      children: existing?.children ?? [],
    };

    this.files.set(path, file);
    this.basenameIndexDirty = true;
    this.rebuildBacklinks();
    this.rebuildHierarchy();
    this.needsRebuild = false;
    return file;
  }

  /**
   * Update a file's content. Defers index rebuild for performance
   * during rapid edits (e.g. per-keystroke). Call `flush()` or read
   * through `getBacklinks()`/`getGraph()` to force an immediate rebuild.
   */
  updateFile(path: string, content: string): VaultFile {
    const scan = scanMarkdown(content);
    const existing = this.files.get(path);

    const file: VaultFile = {
      path,
      title: scan.title || this.titleFromPath(path),
      wikiLinks: scan.wikiLinks,
      markdownLinks: scan.markdownLinks,
      assetRefs: scan.assetRefs,
      backlinks: existing?.backlinks ?? [],
      tags: scan.tags,
      frontmatter: scan.frontmatter,
      headings: scan.headings,
      contentLength: content.length,
      parent: this.inferParent(path, scan.frontmatter),
      children: existing?.children ?? [],
    };

    this.files.set(path, file);
    this.basenameIndexDirty = true;
    this.scheduleRebuild();
    return file;
  }

  removeFile(path: string): void {
    this.files.delete(path);
    this.basenameIndexDirty = true;
    this.rebuildBacklinks();
    this.rebuildHierarchy();
    this.needsRebuild = false;
  }

  /**
   * Rename/move a file and update all references (backlinks, parent fields, wiki-links)
   * pointing to it throughout the vault. Returns the updated content map for all
   * files that were modified (including the renamed file).
   */
  renameFile(oldPath: string, newPath: string): Map<string, string> {
    const updatedFiles = new Map<string, string>();
    const file = this.files.get(oldPath);
    if (!file) return updatedFiles;

    // Compute old basename for wiki-link matching
    const oldBase = oldPath.split('/').pop()?.replace(/\.md$/i, '') ?? '';
    const newBase = newPath.split('/').pop()?.replace(/\.md$/i, '') ?? '';

    // Move the file entry
    this.files.delete(oldPath);
    file.path = newPath;
    this.files.set(newPath, file);

    // Update all references in other files
    for (const [path, f] of this.files) {
      let changed = false;

      // Update wiki-links
      const newLinks = f.wikiLinks.map(link => {
        if (link === oldBase || link === oldPath || link === oldPath.replace(/\.md$/i, '')) {
          changed = true;
          return newBase;
        }
        return link;
      });
      if (changed) f.wikiLinks = newLinks;

      // Update parent reference
      if (f.parent === oldPath || f.parent === oldBase) {
        f.parent = newBase;
        changed = true;
      }

      if (changed) {
        updatedFiles.set(path, path); // signal that this file's references changed
      }
    }

    this.rebuildBacklinks();
    this.rebuildHierarchy();
    return updatedFiles;
  }

  /** Force immediate index rebuild (useful before reading backlinks/graph). */
  flush(): void {
    if (this.needsRebuild) {
      if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
      this.rebuildBacklinks();
      this.rebuildHierarchy();
      this.needsRebuild = false;
    }
  }

  private scheduleRebuild(): void {
    this.needsRebuild = true;
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (this.needsRebuild) {
        this.rebuildBacklinks();
        this.rebuildHierarchy();
        this.needsRebuild = false;
      }
    }, 50);
  }

  getFile(path: string): VaultFile | undefined {
    return this.files.get(path);
  }

  getBacklinks(path: string): VaultFile[] {
    this.flush();
    const file = this.files.get(path);
    if (!file) return [];
    return file.backlinks
      .map((p) => this.files.get(p))
      .filter((f): f is VaultFile => !!f);
  }

  getTagIndex(): Map<string, string[]> {
    this.flush();
    const sets = new Map<string, Set<string>>();
    for (const [path, file] of this.files) {
      for (const tag of file.tags) {
        const parts = tag.split('/');
        for (let i = 1; i <= parts.length; i++) {
          const key = parts.slice(0, i).join('/');
          let s = sets.get(key);
          if (!s) { s = new Set(); sets.set(key, s); }
          s.add(path);
        }
      }
    }
    const index = new Map<string, string[]>();
    for (const [key, s] of sets) {
      index.set(key, [...s]);
    }
    return index;
  }

  getGraph(filter?: Partial<GraphFilter>): GraphData {
    this.flush();
    const allNodes: GraphNode[] = [];
    const allEdges: GraphEdge[] = [];
    const pathSet = new Set(this.files.keys());
    const edgeSeen = new Set<string>();
    const nodeMap = new Map<string, GraphNode>();

    const addEdge = (e: GraphEdge) => {
      const key = `${e.source}\0${e.target}\0${e.type}`;
      if (edgeSeen.has(key)) return;
      edgeSeen.add(key);
      allEdges.push(e);
    };

    const ensureNode = (id: string, label: string, nodeType: NodeType): GraphNode => {
      let node = nodeMap.get(id);
      if (!node) {
        node = {
          id, label, nodeType,
          backlinkCount: 0, outgoingCount: 0, childCount: 0,
          tags: [], isOrphan: false,
        };
        nodeMap.set(id, node);
        allNodes.push(node);
      }
      return node;
    };

    // ── Note nodes ──
    for (const [path, file] of this.files) {
      const folder = this.folderOf(path);
      const totalOutgoing = file.wikiLinks.length + file.markdownLinks.length;
      const node = ensureNode(path, file.title, 'note');
      Object.assign(node, {
        backlinkCount: file.backlinks.length,
        outgoingCount: totalOutgoing,
        childCount: file.children.length,
        tags: file.tags,
        folder,
        parent: file.parent,
        isOrphan: file.backlinks.length === 0 && totalOutgoing === 0,
        headings: file.headings.map(h => ({ level: h.level, text: h.text })),
        contentLength: file.contentLength,
      });

      // Wiki-link edges
      for (const link of file.wikiLinks) {
        const targetPath = this.resolveWikiLink(link);
        if (targetPath && pathSet.has(targetPath)) {
          addEdge({ source: path, target: targetPath, type: 'link' });
        } else {
          // Unresolved link: create an unresolved node
          const unresolvedId = `unresolved:${link}`;
          ensureNode(unresolvedId, link, 'unresolved');
          addEdge({ source: path, target: unresolvedId, type: 'unresolved', reason: `[[${link}]] not found` });
        }
      }

      // Markdown-link edges
      for (const href of file.markdownLinks) {
        const targetPath = this.resolveMarkdownLink(path, href);
        if (targetPath && pathSet.has(targetPath)) {
          addEdge({ source: path, target: targetPath, type: 'link' });
        } else {
          const unresolvedId = `unresolved:${href}`;
          ensureNode(unresolvedId, href, 'unresolved');
          addEdge({ source: path, target: unresolvedId, type: 'unresolved', reason: `[link](${href}) not found` });
        }
      }

      // Asset-ref edges
      for (const asset of file.assetRefs) {
        const assetId = `asset:${asset}`;
        ensureNode(assetId, asset.split('/').pop() || asset, 'asset');
        addEdge({ source: path, target: assetId, type: 'asset-ref' });
      }

      // Parent → child edges
      if (file.parent) {
        const parentPath = this.resolveWikiLink(file.parent) ?? file.parent;
        if (pathSet.has(parentPath)) {
          addEdge({ source: parentPath, target: path, type: 'parent' });
        }
      }
    }

    // ── Tag nodes and tag-link edges ──
    const tagToPages = new Map<string, Set<string>>();
    for (const [path, file] of this.files) {
      for (const tag of file.tags) {
        const root = tag.split('/')[0];
        if (!root) continue;
        let set = tagToPages.get(root);
        if (!set) { set = new Set(); tagToPages.set(root, set); }
        set.add(path);

        // Tag node + tag-link edge
        const tagId = `tag:${root}`;
        const tagNode = ensureNode(tagId, `#${root}`, 'tag');
        tagNode.backlinkCount = (tagToPages.get(root)?.size ?? 0);
        addEdge({ source: path, target: tagId, type: 'tag-link' });
      }
    }

    // Shared-tag edges (between notes, capped)
    for (const [tag, pageSet] of tagToPages) {
      if (pageSet.size < 2 || pageSet.size > 30) continue;
      const pages = [...pageSet];
      for (let i = 0; i < pages.length; i++) {
        for (let j = i + 1; j < pages.length; j++) {
          addEdge({
            source: pages[i],
            target: pages[j],
            type: 'shared-tag',
            reason: `both share #${tag}`,
          });
        }
      }
    }

    // ── Folder nodes and folder-link edges ──
    const folderToPages = new Map<string, Set<string>>();
    for (const [path] of this.files) {
      const folder = this.folderOf(path);
      if (!folder) continue;
      let set = folderToPages.get(folder);
      if (!set) { set = new Set(); folderToPages.set(folder, set); }
      set.add(path);
    }
    for (const [folder, pageSet] of folderToPages) {
      const folderId = `folder:${folder}`;
      const folderNode = ensureNode(folderId, folder || '/', 'folder');
      folderNode.childCount = pageSet.size;

      for (const pagePath of pageSet) {
        addEdge({ source: pagePath, target: folderId, type: 'folder-link' });
      }

      // Shared-folder edges (cap at 20 to avoid clutter)
      if (pageSet.size >= 2 && pageSet.size <= 20) {
        const pages = [...pageSet];
        for (let i = 0; i < pages.length; i++) {
          for (let j = i + 1; j < pages.length; j++) {
            addEdge({
              source: pages[i],
              target: pages[j],
              type: 'shared-folder',
              reason: `both in ${folder}/`,
            });
          }
        }
      }
    }

    // ── Sibling edges (pages with the same parent) ──
    const parentToChildren = new Map<string, string[]>();
    for (const [path, file] of this.files) {
      if (file.parent) {
        const pp = this.resolveWikiLink(file.parent) ?? file.parent;
        const arr = parentToChildren.get(pp) || [];
        arr.push(path);
        parentToChildren.set(pp, arr);
      }
    }
    for (const [, siblings] of parentToChildren) {
      if (siblings.length < 2) continue;
      for (let i = 0; i < siblings.length; i++) {
        for (let j = i + 1; j < siblings.length; j++) {
          addEdge({
            source: siblings[i],
            target: siblings[j],
            type: 'sibling',
            reason: 'share the same parent page',
          });
        }
      }
    }

    // Update tag node counts after all notes have been processed
    for (const [tag, pageSet] of tagToPages) {
      const tagNode = nodeMap.get(`tag:${tag}`);
      if (tagNode) tagNode.backlinkCount = pageSet.size;
    }

    if (!filter) return { nodes: allNodes, edges: allEdges };
    return this.applyGraphFilter(allNodes, allEdges, filter);
  }

  private applyGraphFilter(
    nodes: GraphNode[],
    edges: GraphEdge[],
    filter: Partial<GraphFilter>,
  ): GraphData {
    const mode = filter.mode ?? 'global';
    const depth = filter.depth ?? 2;
    const query = (filter.query ?? '').toLowerCase();
    const edgeTypes = filter.edgeTypes ?? [];
    const nodeTypes = filter.nodeTypes ?? [];
    const tags = filter.tags ?? [];
    const folders = filter.folders ?? [];
    const orphansOnly = filter.orphansOnly ?? false;
    const minBacklinks = filter.minBacklinks ?? 0;
    const showUnresolved = filter.showUnresolved ?? true;
    const showAssets = filter.showAssets ?? false;
    const showTags = filter.showTags ?? true;
    const showFolders = filter.showFolders ?? false;

    let filteredEdges = edges;
    if (edgeTypes.length > 0) {
      const typeSet = new Set<EdgeType>(edgeTypes);
      filteredEdges = filteredEdges.filter(e => typeSet.has(e.type));
    }

    let nodeIds: Set<string> | null = null;

    if (mode === 'local' && filter.focusNode) {
      const adj = new Map<string, Set<string>>();
      for (const n of nodes) adj.set(n.id, new Set());
      for (const e of filteredEdges) {
        adj.get(e.source)?.add(e.target);
        adj.get(e.target)?.add(e.source);
      }
      nodeIds = new Set<string>();
      const queue: [string, number][] = [[filter.focusNode, 0]];
      nodeIds.add(filter.focusNode);
      let qi = 0;
      while (qi < queue.length) {
        const [cur, d] = queue[qi++];
        if (d >= depth) continue;
        for (const neighbor of adj.get(cur) || []) {
          if (!nodeIds.has(neighbor)) {
            nodeIds.add(neighbor);
            queue.push([neighbor, d + 1]);
          }
        }
      }
    }

    let filteredNodes = nodes;
    if (nodeIds) filteredNodes = filteredNodes.filter(n => nodeIds!.has(n.id));

    // ── Node type filtering ──
    if (nodeTypes.length > 0) {
      const typeSet = new Set(nodeTypes);
      filteredNodes = filteredNodes.filter(n => typeSet.has(n.nodeType));
    }

    // Hide unresolved / asset / tag / folder nodes based on toggle
    if (!showUnresolved) filteredNodes = filteredNodes.filter(n => n.nodeType !== 'unresolved');
    if (!showAssets) filteredNodes = filteredNodes.filter(n => n.nodeType !== 'asset');
    if (!showTags) filteredNodes = filteredNodes.filter(n => n.nodeType !== 'tag');
    if (!showFolders) filteredNodes = filteredNodes.filter(n => n.nodeType !== 'folder');

    if (query) {
      filteredNodes = filteredNodes.filter(n =>
        n.label.toLowerCase().includes(query) ||
        n.tags.some(t => t.toLowerCase().includes(query)) ||
        (n.folder && n.folder.toLowerCase().includes(query)),
      );
    }
    if (tags.length > 0) {
      filteredNodes = filteredNodes.filter(n =>
        n.nodeType !== 'note' || tags.some(t => n.tags.includes(t)),
      );
    }
    if (folders.length > 0) {
      filteredNodes = filteredNodes.filter(n =>
        n.nodeType !== 'note' || (n.folder && folders.some(f => n.folder!.startsWith(f))),
      );
    }
    if (orphansOnly) {
      filteredNodes = filteredNodes.filter(n => n.nodeType !== 'note' || n.isOrphan);
    }
    if (minBacklinks > 0) {
      filteredNodes = filteredNodes.filter(n => n.nodeType !== 'note' || n.backlinkCount >= minBacklinks);
    }

    const finalIds = new Set(filteredNodes.map(n => n.id));
    filteredEdges = filteredEdges.filter(e => finalIds.has(e.source) && finalIds.has(e.target));

    return { nodes: filteredNodes, edges: filteredEdges };
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

  /** Start watching for file changes. Returns a cleanup function. Stops any previous watcher. */
  watch(dir: string): () => void {
    if (!this.fsAdapter?.watchFiles) return () => {};

    this.stopWatcher?.();

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
    if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
    this.files.clear();
  }

  private folderOf(path: string): string {
    const parts = path.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  }

  private resolveMarkdownLink(fromPath: string, href: string): string | undefined {
    const cleanHref = href.split('#')[0].split('?')[0];
    if (!cleanHref) return undefined;

    // Try exact
    if (this.files.has(cleanHref)) return cleanHref;

    // Resolve relative to from file's directory
    const dir = this.folderOf(fromPath);
    const resolved = dir ? `${dir}/${cleanHref}` : cleanHref;
    if (this.files.has(resolved)) return resolved;

    // With .md
    const withMd = resolved.endsWith('.md') ? resolved : `${resolved}.md`;
    if (this.files.has(withMd)) return withMd;

    return undefined;
  }

  private basenameIndex = new Map<string, string>();
  private basenameIndexDirty = true;

  private ensureBasenameIndex(): void {
    if (!this.basenameIndexDirty) return;
    this.basenameIndex.clear();
    for (const path of this.files.keys()) {
      const base = path.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() ?? '';
      if (!this.basenameIndex.has(base)) {
        this.basenameIndex.set(base, path);
      }
    }
    this.basenameIndexDirty = false;
  }

  private resolveWikiLink(linkTarget: string): string | undefined {
    if (this.files.has(linkTarget)) return linkTarget;

    const withMd = linkTarget.endsWith('.md') ? linkTarget : `${linkTarget}.md`;
    if (this.files.has(withMd)) return withMd;

    this.ensureBasenameIndex();
    const linkBase = linkTarget.split('/').pop()?.toLowerCase().replace(/\.md$/i, '') ?? '';
    return this.basenameIndex.get(linkBase);
  }

  private rebuildBacklinks(): void {
    const backlinkSets = new Map<string, Set<string>>();
    for (const path of this.files.keys()) {
      backlinkSets.set(path, new Set());
    }

    for (const [sourcePath, sourceFile] of this.files) {
      for (const link of sourceFile.wikiLinks) {
        const targetPath = this.resolveWikiLink(link);
        if (targetPath) {
          backlinkSets.get(targetPath)?.add(sourcePath);
        }
      }
    }

    for (const [path, file] of this.files) {
      file.backlinks = [...(backlinkSets.get(path) ?? [])];
    }
  }

  private rebuildHierarchy(): void {
    const childSets = new Map<string, Set<string>>();
    for (const path of this.files.keys()) {
      childSets.set(path, new Set());
    }

    for (const [path, file] of this.files) {
      if (file.parent) {
        const parentPath = this.resolveWikiLink(file.parent) ?? file.parent;
        childSets.get(parentPath)?.add(path);
      }
    }

    for (const [path, file] of this.files) {
      file.children = [...(childSets.get(path) ?? [])];
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
