# Kivi Phase 2 — Manual Testing Checklist

## Setup

```bash
# Terminal 1: Start the web demo
pnpm --filter @kivi/web-demo dev

# Terminal 2: (optional) Build extension for VS Code testing
pnpm build
```

---

## Web Demo (`http://localhost:5173`)

### Layout & Sidebar
- [ ] Page loads with three panels: sidebar (left), editor+source (center), outline (right)
- [ ] Sidebar shows file list: welcome, features, getting-started
- [ ] Click each file — editor content switches, active file is highlighted
- [ ] "+" button creates a new file (prompts for name)
- [ ] Breadcrumb bar appears above the editor showing current file title

### Wiki-Links
- [ ] `[[features]]` in the welcome file renders as a styled dashed-underline link
- [ ] `[[welcome]]` in the features file renders similarly
- [ ] Wiki-links with aliases (`[[welcome|Kivi]]` in getting-started) show the alias text

### Backlinks
- [ ] Backlinks panel (bottom of sidebar) updates when switching files
- [ ] `welcome.md` should show backlinks from `features.md` and `getting-started.md`
- [ ] Clicking a backlink navigates to that file

### Hashtags
- [ ] `#editor`, `#markdown`, `#demo` in the welcome file render as green inline tokens
- [ ] `#tutorial`, `#getting-started` in the getting-started file render similarly
- [ ] Tags are distinct from surrounding text (different color, no `#` collision with headings)

### Outline Panel
- [ ] Right panel shows heading tree for the current file
- [ ] Headings are indented by level (H1 flush, H2 indented, etc.)
- [ ] Clicking a heading scrolls the editor to that heading
- [ ] Outline updates when you add/remove headings

### Slash Commands
- [ ] Place cursor at the start of an empty line, type `/`
- [ ] Floating popup appears with categorized items (Basic, Advanced, Insert)
- [ ] Arrow Up/Down navigates; highlighted item changes
- [ ] Typing after `/` filters items (e.g., `/head` shows only headings)
- [ ] Enter inserts the selected block; Escape dismisses
- [ ] Insert a Table of Contents via `/` → "Table of Contents"

### Table of Contents
- [ ] `[TOC]` block renders as a clickable heading list inside the editor
- [ ] Adding/removing headings updates the TOC block automatically
- [ ] Clicking a TOC entry scrolls to the heading
- [ ] Round-trips to `[TOC]` in the raw Markdown pane

### Theme System
- [ ] Theme picker dropdown appears at the end of the toolbar
- [ ] Switching to **Light** — background turns white, text turns dark
- [ ] Switching to **Sepia** — warm brownish tones
- [ ] Switching to **Nord** — blue-grey palette
- [ ] Switching back to **Dark** — original dark theme
- [ ] Refresh the page — theme persists (localStorage)

### Graph View
- [ ] Click the `◎` button in the toolbar
- [ ] Fullscreen graph overlay appears with nodes for each file
- [ ] Edges connect files that link to each other via wiki-links
- [ ] Nodes can be dragged
- [ ] Mouse wheel zooms in/out
- [ ] Click "✕" to close the graph
- [ ] Clicking a node navigates to that file (and closes the graph)

### Mermaid Diagrams
- [ ] In raw Markdown pane, paste a mermaid code block:
  ````
  ```mermaid
  graph TD
    A --> B
    B --> C
  ```
  ````
- [ ] Editor shows a rendered diagram (or source fallback if mermaid lib not loaded)
- [ ] Content round-trips correctly back to fenced code block

### Excalidraw Embeds
- [ ] In raw Markdown pane, paste:
  ````
  ```excalidraw
  {"elements": []}
  ```
  ````
- [ ] Editor shows an Excalidraw placeholder block
- [ ] "Edit JSON" button opens a prompt for editing the JSON data
- [ ] Content round-trips correctly

### Image Paste
- [ ] Copy an image to clipboard (e.g., screenshot)
- [ ] Paste into the editor
- [ ] Image appears inline (as a data URL)
- [ ] Raw Markdown shows `![pasted-....png](data:image/png;base64,...)`

### Two-Way Sync (Phase 1 regression check)
- [ ] Type in the WYSIWYG editor — raw Markdown updates
- [ ] Type in the raw Markdown pane — WYSIWYG updates
- [ ] Bold/italic via toolbar — `**`/`*` markers appear in raw pane
- [ ] Undo/redo works (Cmd+Z / Cmd+Shift+Z)

---

## VS Code Extension (F5 → Extension Development Host)

### Activation
- [ ] Kivi icon appears in the activity bar (left sidebar)
- [ ] Click it — shows three views: **Files**, **Outline**, **Backlinks**

### Custom Editor
- [ ] Open any `.md` file → right-click tab → "Reopen Editor With" → "Kivi Markdown Editor"
- [ ] File content renders correctly in the WYSIWYG editor
- [ ] Toolbar appears with formatting buttons
- [ ] Cmd+S saves the file to disk

### Sidebar Views
- [ ] **Files** view shows `.md` files in the workspace
- [ ] Clicking a file opens it in the Kivi editor
- [ ] **Outline** view shows headings for the active `.md` file
- [ ] **Backlinks** view shows files that link to the current file via wiki-links

### File Watcher
- [ ] Create a new `.md` file outside of VS Code (e.g., `touch test.md` in terminal)
- [ ] The Files view updates to show the new file
- [ ] Delete the file — it disappears from the Files view

---

## Quick Smoke Tests

- [ ] `pnpm test:unit` — all 165 tests pass
- [ ] `pnpm build` — all 7 targets build without errors
- [ ] No console errors in browser DevTools while using the web demo
