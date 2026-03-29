# Status

## Current Phase

Phase 2 — Knowledge Management & Advanced Editor Features (COMPLETE)

## Completed

### Phase 1 — Core Markdown WYSIWYG Editor

- **Monorepo scaffold**: pnpm workspaces + Turborepo, TypeScript strict mode, Vitest
- **Shared types** (`@kivi/shared-types`): KiviDocument, BlockMeta, SourceMap, StyleHints, EditorConfig, ThemeColors
- **Markdown parser** (`@kivi/markdown-parser`): remark-parse pipeline with wiki-link, math, frontmatter support; position preservation; mdast-to-ProseMirror transformer
- **Markdown serializer** (`@kivi/markdown-serializer`): ProseMirror-to-mdast converter with custom handlers for wiki-links, mermaid, excalidraw, ToC
- **Editor core** (`@kivi/editor-core`): Tiptap-based editor with all CommonMark + GFM + PKM extensions
- **Round-trip preservation**: Lossless parse-serialize cycle with block-level dirty tracking
- **Web demo** (`@kivi/web-demo`): Vite app with split view, toolbar, search
- **VS Code extension** (`kivi`): CustomTextEditorProvider with incremental edits, theme sync

### Phase 2 — Knowledge Management & Advanced Editor

#### Sub-phase 2A: Wiki-Links, Backlinks & Tags
- **Wiki-Link Extension**: `[[page-name]]` and `[[page-name|alias]]` with parser/serializer support via `remark-wiki-link`
- **`@kivi/vault` Package**: In-memory file index with backlinks, tags, hierarchy, graph data, search; lightweight markdown scanner
- **HashTag Extension**: `#tag-name` inline nodes with input rules and hierarchical tag support
- **Platform Integration**: VS Code backlinks TreeDataProvider + file watcher; web demo file browser + backlinks panel

#### Sub-phase 2B: Navigation
- **Sidebar Tree View**: VS Code TreeDataProvider for markdown files; web demo collapsible file list
- **Outline View**: Heading tree for active document; VS Code sidebar + web demo right panel
- **Table of Contents**: `[TOC]` / `[[toc]]` marker → reactive NodeView with clickable heading links

#### Sub-phase 2C: Editor UX
- **Slash Commands**: `/` trigger → floating popup with categorized items, keyboard navigation, type-to-filter
- **Image Paste**: Clipboard image detection, `ImageStorageAdapter` interface, data URL default adapter
- **Theme System**: 4 themes (dark, light, sepia, nord) via CSS custom properties; font customization; localStorage persistence

#### Sub-phase 2D: Visualization
- **Mermaid Diagrams**: `mermaidBlock` extension with lazy-loaded rendering, click-to-edit source
- **Excalidraw Embeds**: `excalidrawBlock` extension storing JSON data, code block syntax in markdown
- **Graph View**: Canvas-based force-directed graph renderer in `@kivi/vault`; web demo fullscreen overlay

#### Sub-phase 2E: Page Hierarchy & Polish
- **Page Hierarchy**: Parent/child inference from folder structure + `parent:` frontmatter; breadcrumb navigation
- **Tests**: 165 unit/integration tests + 16 VS Code integration tests = 181 total
- **README & Status**: Updated documentation

## Technical Decisions

- **Tiptap + custom remark bridge** instead of `@tiptap/markdown` (which uses Marked and normalizes aggressively)
- **Block-level dirty serialization** for minimal diffs — clean blocks emit original source verbatim
- **`@kivi/vault` is a separate package** with no editor dependency — keeps indexing testable and reusable
- **Wiki-links use `remark-wiki-link`** (Obsidian-compatible syntax with `|` alias divider)
- **Slash commands live in `editor-core`** so both platforms get them for free
- **Canvas-based graph renderer** avoids adding d3/React as dependencies
- **Mermaid/Excalidraw use NodeView pattern** (same as MathBlock) — code block in markdown, rendered widget in editor
- **Image storage is adapter-based** — different implementations for VS Code (workspace files) and web (data URLs)
- **Themes are CSS custom properties** — works naturally with VS Code's CSS variable bridging
- **Incremental diff algorithm** — finds first/last diverging character, sends only changed range to VS Code

## Known Limitations

- Footnotes render as simple text blocks (no bidirectional navigation yet)
- Mermaid rendering requires the mermaid library available (lazy-loaded via dynamic import)
- Excalidraw uses JSON editing (full React-based Excalidraw canvas would require React dependency)
- No viewport virtualization for extremely large files (>10K lines)
- Multi-cursor not yet implemented

## Test Summary

```
@kivi/markdown-parser:     32 tests passing
@kivi/markdown-serializer: 29 tests passing
@kivi/editor-core:         71 tests passing
@kivi/vault:               33 tests passing
VS Code extension:         16 tests passing
────────────────────────────────────────────
Total:                    181 tests passing
```

## New Packages (Phase 2)

| Package | Purpose |
|---|---|
| `@kivi/vault` | Knowledge layer — file index, backlinks, tags, graph, scanner |

## New Extensions (Phase 2)

| Extension | File | Description |
|---|---|---|
| WikiLink | `wiki-link.ts` | `[[page]]` mark with click navigation |
| HashTag | `hashtag.ts` | `#tag` inline node with input rule |
| TocBlock | `toc.ts` | `[TOC]` reactive heading list |
| SlashCommands | `slash-commands.ts` | `/` command palette with keyboard nav |
| MermaidBlock | `mermaid.ts` | Live mermaid diagram rendering |
| ExcalidrawBlock | `excalidraw.ts` | Excalidraw JSON embed |
