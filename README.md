# Kivi

A high-performance, WYSIWYG-first Markdown editor with lossless round-trip editing. Built as a reusable editor engine (`@kivi/editor-core`) and a VS Code / Cursor extension.

## Prerequisites

- **Node.js** >= 18 (20+ recommended)
- **pnpm** >= 9

## Quick Start

```bash
# Install all dependencies
pnpm install

# Build everything (packages + apps)
pnpm build
```

## Local Development

### Web Demo (fastest way to test the editor)

```bash
# Start the Vite dev server with hot-reload
pnpm --filter @kivi/web-demo dev
```

Opens at `http://localhost:5173`. The demo has a split view — WYSIWYG editor on the left, raw Markdown on the right — plus a formatting toolbar. Edits in either pane sync to the other in real time.

### VS Code / Cursor Extension

1. Build everything first:

   ```bash
   pnpm build
   ```

2. Open the project in VS Code / Cursor.

3. Press **F5** (or Run > Start Debugging). This launches an Extension Development Host window with the Kivi extension loaded.

4. In the new window, open any `.md` file. You'll see a prompt to "Reopen with Kivi Markdown Editor" (or right-click the file tab > Reopen Editor With > Kivi Markdown Editor).

The extension provides:
- Formatting toolbar (bold, italic, headings, lists, code, etc.)
- Search bar via **Cmd+F** / **Ctrl+F** (with regex, case-sensitive, whole-word, replace)
- Full round-trip fidelity — your original Markdown formatting is preserved

### Watch Mode (for developing packages)

```bash
# Watch the editor core for changes
pnpm --filter @kivi/editor-core dev

# In another terminal, run the web demo
pnpm --filter @kivi/web-demo dev
```

## Running Tests

```bash
# Run all tests across all packages
pnpm test

# Run tests for a specific package
pnpm --filter @kivi/markdown-parser test
pnpm --filter @kivi/markdown-serializer test
pnpm --filter @kivi/editor-core test

# Watch mode (re-runs on file changes)
pnpm --filter @kivi/editor-core test:watch
```

### What's tested

| Package | Tests | Coverage |
|---|---|---|
| `@kivi/markdown-parser` | 18 | Parsing, source positions, style hints, block extraction |
| `@kivi/markdown-serializer` | 17 | Round-trip serialization, gap/preamble preservation |
| `@kivi/editor-core` | 71 | E2E round-trips, dirty tracking, clipboard, incremental diff, web worker |
| **Total** | **106** | |

## Project Structure

```
kivi/
├── packages/
│   ├── shared-types/          # TypeScript interfaces (KiviDocument, SourceMap, etc.)
│   ├── markdown-parser/       # remark-based Markdown → ProseMirror JSON
│   ├── markdown-serializer/   # ProseMirror JSON → Markdown (minimal-diff)
│   └── editor-core/           # Tiptap editor + all extensions + tests
├── apps/
│   ├── web-demo/              # Vite-based browser demo
│   └── vscode-extension/      # VS Code / Cursor extension
├── turbo.json
├── pnpm-workspace.yaml
└── status.md                  # Detailed project status
```

## Manual Testing Checklist

Before moving to Phase 2, verify these in the **web demo** (`pnpm --filter @kivi/web-demo dev`):

- [ ] Type text — appears instantly, raw Markdown updates on the right
- [ ] Apply **bold**, *italic*, ~~strikethrough~~ via toolbar buttons
- [ ] Toggle heading levels (H1, H2, H3) via toolbar
- [ ] Create bullet, ordered, and task lists
- [ ] Add a code block and a blockquote
- [ ] Insert a horizontal rule
- [ ] Paste Markdown text from clipboard — should render as rich content
- [ ] Copy formatted text — paste into a text editor to verify it's Markdown
- [ ] Edit in the raw Markdown pane — WYSIWYG updates
- [ ] Load a large file (paste 1000+ lines of Markdown) — should remain responsive

In the **VS Code extension** (F5 → open `.md` file → Reopen with Kivi):

- [ ] File loads with correct formatting
- [ ] Edits show up, Cmd+S saves to disk
- [ ] Undo/Redo works (Cmd+Z / Cmd+Shift+Z)
- [ ] Cmd+F opens search bar, search + replace works
- [ ] Toolbar buttons toggle formatting correctly
- [ ] Close and reopen — content persists

## Architecture

- **ProseMirror** (via Tiptap) for the editing surface
- **remark** ecosystem for Markdown parsing and serialization
- **Custom preservation layer** stores original source text, positions, and style hints per block
- **Block-level dirty tracking** — only modified blocks are re-serialized, producing minimal diffs
- **Web Worker** for background parsing of large files (>100KB)
