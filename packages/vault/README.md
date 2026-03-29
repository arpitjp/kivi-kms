# @kivi/vault

In-memory knowledge graph and file index for personal knowledge management.

Indexes Markdown files and extracts wiki-links, backlinks, tags, frontmatter, and page hierarchy. Provides a searchable vault with graph data for visualization.

- **Backlinks** — automatically tracks which files reference each other via `[[wiki-links]]`
- **Tags** — collects `#hashtags` across all files into a tag index
- **Hierarchy** — infers parent/child relationships from folder structure and frontmatter
- **Graph** — generates node/edge data for force-directed graph rendering
- **Search** — title, path, and tag search across the vault
- **File watching** — optional `watch()` integration via a pluggable filesystem adapter

## Usage

```ts
import { Vault } from '@kivi/vault';

const vault = new Vault();
vault.addFile('notes/hello.md', '# Hello\n\nLinks to [[world]].');
vault.getBacklinks('world.md'); // → [{ path: 'notes/hello.md', ... }]
```
