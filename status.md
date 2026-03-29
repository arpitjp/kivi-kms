# Status

## Current Phase

Phase 1 — Core Markdown WYSIWYG Editor (COMPLETE)

## Completed

- **Monorepo scaffold**: pnpm workspaces + Turborepo, TypeScript strict mode, Vitest
- **Shared types** (`@kivi/shared-types`): KiviDocument, BlockMeta, SourceMap, StyleHints, EditorConfig, SerializerOptions
- **Markdown parser** (`@kivi/markdown-parser`): remark-parse pipeline with full position preservation, mdast-to-ProseMirror transformer, source range extraction, style hint detection
- **Markdown serializer** (`@kivi/markdown-serializer`): ProseMirror-to-mdast converter, remark-stringify output, block-level dirty serialization, style-preserving re-serialization
- **Editor core** (`@kivi/editor-core`): Tiptap-based editor with all CommonMark + GFM extensions
  - Headings, paragraphs, bold, italic, strikethrough, underline
  - Inline code, fenced code blocks (with language)
  - Ordered lists, unordered lists, task lists
  - Tables, blockquotes, horizontal rules
  - Links, images, hard breaks
  - Frontmatter, math blocks, math inline, footnotes (custom extensions)
  - In-document search with regex, case-sensitive, whole-word, replace/replace-all
  - Smart clipboard: Markdown detection heuristic, rich parse-and-insert via `parseMarkdown()`, Markdown-aware copy
  - **Real dirty tracking**: ProseMirror plugin tracks which top-level blocks are modified per transaction, feeds into serializer for minimal diffs
  - **KaTeX math rendering**: NodeView-based renderer for MathBlock and MathInline, with KaTeX integration (auto-detects `window.katex`), fallback to source display
  - **Floating toolbar**: Bold, italic, strikethrough, code, headings (H1–H3), lists (bullet, ordered, task), blockquote, code block, horizontal rule — with active-state highlighting
  - **Web Worker parsing**: Background `parseMarkdown()` via Web Worker for files > 100KB, with sync fallback for small files or unsupported environments
- **Round-trip preservation**: Lossless parse-serialize cycle verified with comprehensive tests
  - Preserves: whitespace, list markers, heading style, code fence style, emphasis style, inter-block gaps, preamble/postamble
  - Block-level dirty tracking: only modified blocks are re-serialized
  - Debounced update notifications (300ms) to avoid serializing on every keystroke
- **Web demo** (`@kivi/web-demo`): Vite app with split WYSIWYG / raw Markdown view, full toolbar
- **VS Code extension** (`kivi`): CustomTextEditorProvider with bundled Tiptap webview
  - Toolbar with formatting buttons and active-state indicators
  - **Search UI**: Floating search bar (Cmd+F) with case-sensitive, regex, whole-word toggles, next/prev navigation, replace/replace-all
  - **Incremental edits**: Diff-based document updates (finds minimal changed range instead of replacing entire document)
  - Theme/font sync via CSS variables
  - postMessage protocol for load/edit/externalChange
  - Complete CSS styling for all block types including math, frontmatter, footnotes, search highlights

## Technical Decisions

- **Tiptap + custom remark bridge** instead of `@tiptap/markdown` (which uses Marked and normalizes aggressively)
- **Block-level dirty serialization** for minimal diffs — clean blocks emit original source verbatim
- **Style hints** extracted on parse, used during re-serialization to match original formatting
- **Gap preservation** — whitespace between top-level blocks stored separately and emitted unchanged
- **`CustomTextEditorProvider`** for VS Code integration (text-backed document, native undo support)
- **Dirty tracker with explicit reset** — `setContent()` triggers transactions, so dirty state is reset after `loadMarkdown()` to start clean
- **Incremental diff algorithm** — finds first/last diverging character between old/new content, sends only the changed range to VS Code's WorkspaceEdit API
- **Happy-dom** for integration tests (jsdom v29 has ESM incompatibility with Node 18)

## Known Limitations

- Footnotes render as simple text blocks (no bidirectional navigation yet)
- Mermaid diagram rendering requires loading the mermaid library in the host environment
- No viewport virtualization for extremely large files (>10K lines)
- Multi-cursor not yet implemented

## Test Summary

```
@kivi/markdown-parser:     18 tests passing (unit)
@kivi/markdown-serializer: 17 tests passing (unit)
@kivi/editor-core:         71 tests passing
  - 28 e2e tests (5 fixture suites)
  - 13 integration tests (editor round-trip, dirty tracking)
  - 30 unit tests (clipboard, dirty-tracker, incremental-diff, worker)
────────────────────────────────────────────
Total:                    106 tests passing
```

## Future Work (Phase 2)

- Wiki-style links and backlinks
- Graph view (React Flow)
- Tag system with hierarchical tags
- Page hierarchy (parent/child)
- Sidebar tree view and navigation
- Slash commands (Notion-like)
- Image paste from clipboard with auto-storage
- Table of contents generation
- Outline view
- Theme and font customization
- Mermaid diagram rendering in editor
- Excalidraw embed support
