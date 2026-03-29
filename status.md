# Status

## Current Phase

Phase 3 — Performance, Polish & Comprehensive Testing (COMPLETE)

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

### Phase 3 — Performance, Polish & Comprehensive Testing

#### Performance
- **Debounced textarea→editor sync** (250ms) prevents full `parseMarkdown` + `setContent` on every keystroke
- **Vault rebuild optimization**: `updateFile()` defers `rebuildBacklinks`/`rebuildHierarchy` via 50ms debounce timer; auto-flushes on read APIs (`getBacklinks`, `getGraph`, `getTagIndex`)
- **Tag index uses `Set<string>`** instead of `Array.includes()` for O(1) dedup
- **Graph renderer**: Adaptive iteration cap `min(200, 60 + 2n)` and repulsion distance cutoff for large graphs
- **HiDPI fix**: Uses `devicePixelRatio` with `setTransform` reset (no compound scale bug)
- **Content store sync**: `SAMPLE_FILES` always updated on edit to prevent stale content on file switch

#### Editor Polish
- **Find & Replace UI bar** (Cmd/Ctrl+F): Input-driven search, match count, next/prev navigation, case-sensitive and regex toggles, replace one/all
- **Vault-wide search panel**: Debounced query input, result list with file navigation, toggle via toolbar button
- **Extended theme system**: Added `tagColor`, `selectionBg`, `focusRing`, `successColor`, `errorColor` tokens per theme; Nord `textMuted` improved for contrast
- **Hard-coded colors replaced**: `pre`, `.kivi-hashtag`, `.kivi-mermaid-source`, `.kivi-mermaid-error` all use CSS custom properties

#### UX Improvements
- **Graph overlay**: `role="dialog"` + `aria-modal="true"`, Escape to close, close button; `loadFile` scope bug fixed
- **Graph interaction**: Drag vs click separation (5px threshold), hover highlighting with outline ring, tooltip showing label/backlinks/tags
- **Slash menu**: Repositions on scroll/resize, ARIA `role="listbox"` + `role="option"`, filters by category too, `stopPropagation` for arrow keys
- **Sidebar toggle**: Collapse/expand button in toolbar with CSS class transition
- **Accessibility**: Focus rings on all interactive elements (`.toolbar-btn`, `.theme-picker`, `.file-item`, `.outline-item`, etc.), `type="button"` on toolbar buttons, `aria-pressed` for toggle states, `aria-label` on theme picker
- **Responsive layout**: Two breakpoints (900px, 640px) — sidebar shrinks, outline panel collapses, split view becomes single-column on mobile

#### Tests
- **Phase 2 editor integration tests**: 11 new round-trip tests (wiki-link, hashtag, ToC, mermaid, excalidraw, complex mixed doc)
- **Search extension unit tests**: 7 tests covering find, case-sensitive, regex, next/prev, invalid regex safety
- **Theme unit tests**: 12 tests covering `allThemes`, `getThemeColors`, `applyTheme` CSS vars, font options, cross-theme color difference
- **VS Code extension tests expanded**: Wiki-links fixture, tree view registration, outline heading detection, file system watcher create/delete resilience
- **Agent-browser UI tests**: 19 new Phase 2 test sections (P2-1 through P2-19) covering sidebar, file nav, wiki-links, hashtags, backlinks, outline, breadcrumbs, themes, graph view, slash commands, ToC, mermaid, excalidraw, find bar, vault search, sidebar toggle, accessibility, two-way sync

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
@kivi/editor-core:        101 tests passing  (+30 in Phase 3)
@kivi/vault:               33 tests passing
VS Code extension:         22 tests passing  (+6 in Phase 3)
Agent-browser UI tests:    ~70 Phase 1 + ~40 Phase 2 assertions
────────────────────────────────────────────
Total unit/integration:   195 tests passing  (was 181)
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
