# @kivi/web-demo

Browser-based demo of the Kivi editor and vault.

A standalone web app showcasing the full feature set: WYSIWYG editing with live Markdown source, file navigation, backlinks panel, outline, breadcrumbs, vault search, knowledge graph visualization, find & replace, theme switching, and slash commands.

## Development

```bash
pnpm dev        # start Vite dev server on localhost:5173
pnpm build      # production build to dist/
```

## Testing

UI tests run via `agent-browser` against the dev server:

```bash
bash tests/ui/browser-test.sh
```
