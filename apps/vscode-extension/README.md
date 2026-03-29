# Kivi — VS Code Extension

A VS Code custom editor for Markdown files, powered by the Kivi editor core.

Opens `.md` files in a WYSIWYG Tiptap editor inside a webview, with full theme sync to VS Code's colors and font settings. Includes sidebar tree views for file browsing, document outline, and backlinks.

## Features

- **Custom editor** — registers as an optional editor for `*.md` / `*.markdown` files
- **Theme sync** — reads VS Code CSS variables so the editor matches your color theme
- **Sidebar panels** — Files, Outline, and Backlinks tree views in the Kivi activity bar
- **File watcher** — picks up external changes to Markdown files automatically

## Development

```bash
pnpm dev        # watch mode (esbuild + webview Vite)
pnpm build      # production build
pnpm test       # integration tests via @vscode/test-electron
```
