export interface VaultHeading {
  level: number;
  text: string;
  line: number;
}

export interface VaultFile {
  path: string;
  title: string;
  wikiLinks: string[];
  backlinks: string[];
  tags: string[];
  frontmatter: Record<string, unknown>;
  headings: VaultHeading[];
  parent?: string;
  children: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  backlinkCount: number;
  tags: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface FileSystemAdapter {
  readFile(path: string): Promise<string>;
  listFiles(dir: string, pattern?: string): Promise<string[]>;
  watchFiles?(
    dir: string,
    callback: (event: 'add' | 'change' | 'delete', path: string) => void,
  ): () => void;
}
