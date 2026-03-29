# @kivi/markdown-serializer

Converts a ProseMirror document back into Markdown text.

Walks the ProseMirror node tree and produces an mdast tree, then stringifies it via `remark-stringify`. Leverages source metadata stored during parsing to achieve lossless round-tripping — preserving the user's original formatting, whitespace, and syntax choices.

## Usage

```ts
import { serializeMarkdown } from '@kivi/markdown-serializer';

const markdown = serializeMarkdown(doc);
```
