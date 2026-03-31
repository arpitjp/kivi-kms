export interface VaultHeading {
  level: number;
  text: string;
  line: number;
}

export interface VaultFile {
  path: string;
  title: string;
  wikiLinks: string[];
  markdownLinks: string[];
  assetRefs: string[];
  backlinks: string[];
  tags: string[];
  frontmatter: Record<string, unknown>;
  headings: VaultHeading[];
  contentLength?: number;
  parent?: string;
  children: string[];
}

// ── Graph types ──────────────────────────────────────────────

export type NodeType =
  | 'note'
  | 'tag'
  | 'folder'
  | 'unresolved'
  | 'asset';

export type EdgeType =
  | 'link'           // wiki-link or markdown link
  | 'backlink'       // reverse of link (for explicit display)
  | 'parent'         // parent → child hierarchy
  | 'shared-tag'     // two pages share the same tag
  | 'sibling'        // same parent
  | 'shared-folder'  // two pages in the same folder
  | 'tag-link'       // note → tag node
  | 'folder-link'    // note → folder node
  | 'unresolved'     // note → unresolved link target
  | 'asset-ref';     // note → asset (image, pdf, etc.)

export interface GraphNode {
  id: string;
  label: string;
  nodeType: NodeType;
  backlinkCount: number;
  outgoingCount: number;
  childCount: number;
  tags: string[];
  folder?: string;
  parent?: string;
  isOrphan: boolean;
  headings?: { level: number; text: string }[];
  contentLength?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  /** Human-readable explanation, e.g. "both share #performance" */
  reason?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type GraphMode = 'local' | 'global';

export interface GraphFilter {
  mode: GraphMode;
  focusNode?: string;
  /** Max hops from focus node (local mode) */
  depth: number;
  /** Only show these edge types (empty = all) */
  edgeTypes: EdgeType[];
  /** Only show these node types (empty = all) */
  nodeTypes: NodeType[];
  /** Text query to filter nodes */
  query: string;
  /** Only show nodes with these tags */
  tags: string[];
  /** Only show nodes in these folders */
  folders: string[];
  /** Only show orphan pages */
  orphansOnly: boolean;
  /** Min backlink count filter */
  minBacklinks?: number;
  /** Show unresolved links */
  showUnresolved?: boolean;
  /** Show asset nodes */
  showAssets?: boolean;
  /** Show tag nodes */
  showTags?: boolean;
  /** Show folder nodes */
  showFolders?: boolean;
}

export interface FileSystemAdapter {
  readFile(path: string): Promise<string>;
  listFiles(dir: string, pattern?: string): Promise<string[]>;
  watchFiles?(
    dir: string,
    callback: (event: 'add' | 'change' | 'delete', path: string) => void,
  ): () => void;
}
