# @kivi/editor-core

The main WYSIWYG Markdown editor built on Tiptap/ProseMirror.

Provides the `KiviEditor` class that wraps Tiptap with Kivi's Markdown parser and serializer, plus a suite of custom extensions:

- **Formatting** — floating toolbar, slash commands
- **Knowledge management** — wiki-links, hashtags, table of contents
- **Rich blocks** — math (KaTeX), Mermaid diagrams, Excalidraw sketches
- **Editing tools** — find & replace, smart clipboard (Markdown detection, image paste)
- **Performance** — block-level dirty tracking, web worker parsing, incremental diffing
- **Theming** — four built-in themes (dark, light, sepia, nord) with CSS custom properties

## Usage

```ts
import { createKiviEditor } from '@kivi/editor-core';

const editor = createKiviEditor({ element: document.getElementById('editor')! });
editor.loadMarkdown('# Hello world');
```
