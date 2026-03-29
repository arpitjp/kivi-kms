# @kivi/markdown-parser

Converts Markdown text into a ProseMirror document.

Uses `unified` + `remark` to parse Markdown into an mdast tree, then walks the tree to produce ProseMirror nodes. Supports GFM (tables, task lists, strikethrough), frontmatter, math (KaTeX), footnotes, wiki-links (`[[page]]`), and hashtags — preserving source metadata for lossless round-tripping.

## Usage

```ts
import { parseMarkdown } from '@kivi/markdown-parser';

const doc = parseMarkdown(schema, '# Hello\n\nSome **bold** text.');
```
