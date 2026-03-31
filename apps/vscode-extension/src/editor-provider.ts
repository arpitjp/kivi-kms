import * as vscode from 'vscode';
import { scanMarkdown } from '@kivi/vault';
import { getNonce } from './utils.js';

export interface KiviSettings {
  editorBackground: string;
  codeBlockBackground: string;
  accentColor: string;
  textColor: string;
  headingColor: string;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  customCSS: string;
  showToolbar: boolean;
  zoom: number;
  // VS Code native editor settings (forwarded so webview can match)
  vscodeEditorFontSize: number;
  vscodeEditorFontFamily: string;
  vscodeEditorWordWrap: string;
}

function readKiviSettings(): KiviSettings {
  const cfg = vscode.workspace.getConfiguration('kivi');
  const editorCfg = vscode.workspace.getConfiguration('editor');
  return {
    editorBackground: cfg.get<string>('appearance.editorBackground', ''),
    codeBlockBackground: cfg.get<string>('appearance.codeBlockBackground', ''),
    accentColor: cfg.get<string>('appearance.accentColor', ''),
    textColor: cfg.get<string>('appearance.textColor', ''),
    headingColor: cfg.get<string>('appearance.headingColor', ''),
    fontSize: cfg.get<number>('appearance.fontSize', 0),
    fontFamily: cfg.get<string>('appearance.fontFamily', ''),
    lineHeight: cfg.get<number>('appearance.lineHeight', 0),
    customCSS: cfg.get<string>('appearance.customCSS', ''),
    showToolbar: cfg.get<boolean>('ui.showToolbar', true),
    zoom: cfg.get<number>('appearance.zoom', 100),
    vscodeEditorFontSize: editorCfg.get<number>('fontSize', 14),
    vscodeEditorFontFamily: editorCfg.get<string>('fontFamily', ''),
    vscodeEditorWordWrap: editorCfg.get<string>('wordWrap', 'on'),
  };
}

export class KiviEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'kivi.markdownEditor';

  /** Tracks all active webview panels keyed by document URI, for commands/focus. */
  private static activePanels = new Map<string, vscode.WebviewPanel>();

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      KiviEditorProvider.viewType,
      new KiviEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      },
    );
  }

  /** Get the panel for a document URI (if any). Used by commands. */
  static getPanelForUri(uri: string): vscode.WebviewPanel | undefined {
    return KiviEditorProvider.activePanels.get(uri);
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const docUriStr = document.uri.toString();

    // Track this panel
    KiviEditorProvider.activePanels.set(docUriStr, webviewPanel);

    // Webview options — include workspace folder for image/asset previews
    const roots: vscode.Uri[] = [
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      vscode.Uri.joinPath(this.context.extensionUri, 'images'),
    ];
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (wsFolder) roots.push(wsFolder.uri);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: roots,
    };

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    // ── State tracking ──

    let isWebviewReady = false;
    let pendingContent: string | null = document.getText();
    let lastKnownContent = document.getText();
    // Counter-based own-edit tracking (handles rapid edits better than a boolean)
    let pendingOwnEdits = 0;

    const disposables: vscode.Disposable[] = [];

    // ── Message sending helpers ──

    const postMessage = (msg: Record<string, unknown>) => {
      if (isWebviewReady) {
        webviewPanel.webview.postMessage(msg);
      }
    };

    const sendContent = (content: string) => {
      if (isWebviewReady) {
        postMessage({ type: 'load', content });
      } else {
        pendingContent = content;
      }
    };

    const sendSettings = () => {
      postMessage({ type: 'settings', settings: readKiviSettings() });
    };

    // ── Document change tracking ──

    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== docUriStr) return;
        if (e.contentChanges.length === 0) return;

        const currentText = document.getText();

        // Skip own edits via counter
        if (pendingOwnEdits > 0) {
          pendingOwnEdits--;
          lastKnownContent = currentText;
          return;
        }

        // External change
        if (currentText !== lastKnownContent) {
          lastKnownContent = currentText;
          sendContent(lastKnownContent);
        }
      }),
    );

    // ── Configuration changes ──

    disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kivi') || e.affectsConfiguration('editor.fontSize') ||
            e.affectsConfiguration('editor.fontFamily') || e.affectsConfiguration('editor.wordWrap')) {
          sendSettings();
        }
      }),
    );

    // ── File save: tell webview to flush pending edits ──

    disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.toString() === docUriStr) {
          postMessage({ type: 'flushEdits' });
        }
      }),
    );

    // ── File delete: notify webview ──

    disposables.push(
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          if (uri.toString() === docUriStr) {
            postMessage({ type: 'fileDeleted' });
          }
        }
      }),
    );

    // ── File rename: notify webview of new name ──

    disposables.push(
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          if (oldUri.toString() === docUriStr) {
            const newRelPath = vscode.workspace.asRelativePath(newUri, false);
            postMessage({ type: 'fileRenamed', newPath: newRelPath });
          }
        }
      }),
    );

    // ── Panel visibility / focus ──

    disposables.push(
      webviewPanel.onDidChangeViewState(() => {
        if (webviewPanel.active) {
          vscode.commands.executeCommand('setContext', 'kivi.editorFocused', true);
          // Re-send file info for sidebars that track active editor
          postMessage({ type: 'focus' });
        } else {
          vscode.commands.executeCommand('setContext', 'kivi.editorFocused', false);
        }
      }),
    );

    // ── Cleanup ──

    webviewPanel.onDidDispose(() => {
      KiviEditorProvider.activePanels.delete(docUriStr);
      vscode.commands.executeCommand('setContext', 'kivi.editorFocused', false);
      for (const d of disposables) d.dispose();
    });

    // ── Message handler ──

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          isWebviewReady = true;

          // Send document metadata
          const relPath = vscode.workspace.asRelativePath(document.uri, false);
          postMessage({
            type: 'init',
            filePath: relPath,
            fileName: relPath.split('/').pop()?.replace(/\.md$/, '') || '',
            isReadonly: document.isUntitled,
          });

          sendSettings();

          if (pendingContent !== null) {
            postMessage({ type: 'load', content: pendingContent });
            lastKnownContent = pendingContent;
            pendingContent = null;
          }
          break;
        }

        case 'openGraph': {
          vscode.commands.executeCommand('kivi.openGraph');
          break;
        }

        case 'edit': {
          if (typeof msg.content !== 'string') break;
          const newContent = msg.content as string;
          if (newContent === lastKnownContent) break;

          const edit = new vscode.WorkspaceEdit();
          const oldText = lastKnownContent;
          const newText = newContent;

          // Find minimal diff range
          let start = 0;
          while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
            start++;
          }
          let oldEnd = oldText.length;
          let newEnd = newText.length;
          while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
            oldEnd--;
            newEnd--;
          }

          const range = new vscode.Range(
            document.positionAt(start),
            document.positionAt(oldEnd),
          );
          const replacement = newText.slice(start, newEnd);

          edit.replace(document.uri, range, replacement);
          pendingOwnEdits++;
          lastKnownContent = newContent;
          const applied = await vscode.workspace.applyEdit(edit);
          if (!applied) pendingOwnEdits--;
          break;
        }

        case 'resolveLink': {
          const linkData = msg.link as { kind: string; target: string; alias?: string } | undefined;
          const resolveId = msg.id as number | undefined;
          if (!linkData || resolveId === undefined) break;

          const result = await this.resolveLink(linkData, document, webviewPanel.webview);
          postMessage({ type: 'linkResolved', id: resolveId, data: result });
          break;
        }

        case 'navigateLink': {
          const navLink = msg.link as { kind: string; target: string; alias?: string } | undefined;
          if (!navLink) break;
          await this.navigateToLink(navLink, document);
          break;
        }

        case 'revealInExplorer': {
          vscode.commands.executeCommand('revealInExplorer', document.uri);
          break;
        }

        case 'scrollToLine': {
          const line = msg.line as number | undefined;
          if (typeof line === 'number') {
            postMessage({ type: 'scrollToLine', line });
          }
          break;
        }

        case 'getOutline': {
          const text = document.getText();
          const headings: { level: number; text: string; line: number }[] = [];
          const lines = text.split('\n');
          let inCodeBlock = false;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trimStart().startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
            if (inCodeBlock) continue;
            const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
            if (m) {
              headings.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
            }
          }
          postMessage({ type: 'outline', headings });
          break;
        }

        case 'createChildPage': {
          const pageName = msg.name as string | undefined;
          if (!pageName || !wsFolder) break;

          const cfg = vscode.workspace.getConfiguration('kivi');
          const pagesFolder = cfg.get<string>('folders.pages', 'pages');
          const folderUri = vscode.Uri.joinPath(wsFolder.uri, pagesFolder);

          try { await vscode.workspace.fs.stat(folderUri); } catch {
            await vscode.workspace.fs.createDirectory(folderUri);
          }

          const safeName = pageName.replace(/[<>:"/\\|?*]/g, '').trim();
          const fileName = safeName.endsWith('.md') ? safeName : `${safeName}.md`;
          const fileUri = vscode.Uri.joinPath(folderUri, fileName);

          try {
            await vscode.workspace.fs.stat(fileUri);
            vscode.window.showInformationMessage(`Page "${fileName}" already exists.`);
          } catch {
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(`# ${safeName.replace(/\.md$/, '')}\n\n`));
          }

          vscode.commands.executeCommand('vscode.openWith', fileUri, KiviEditorProvider.viewType);
          const relPath = vscode.workspace.asRelativePath(fileUri, false);
          postMessage({ type: 'childPageCreated', path: relPath, name: safeName.replace(/\.md$/, '') });
          break;
        }

        case 'storeImage': {
          if (!wsFolder) break;
          const imageData = msg.data as string | undefined;
          const imageName = msg.name as string | undefined;
          if (!imageData || !imageName) break;

          const cfg = vscode.workspace.getConfiguration('kivi');
          const assetsFolder = cfg.get<string>('folders.assets', 'assets');
          const folderUri = vscode.Uri.joinPath(wsFolder.uri, assetsFolder);

          try { await vscode.workspace.fs.stat(folderUri); } catch {
            await vscode.workspace.fs.createDirectory(folderUri);
          }

          const safeName = imageName.replace(/[<>:"/\\|?*]/g, '').trim();
          const fileUri = vscode.Uri.joinPath(folderUri, safeName);

          const base64 = imageData.replace(/^data:[^;]+;base64,/, '');
          const bytes = Buffer.from(base64, 'base64');
          await vscode.workspace.fs.writeFile(fileUri, bytes);

          const relPath = vscode.workspace.asRelativePath(fileUri, false);
          postMessage({ type: 'imageStored', path: relPath, name: safeName });
          break;
        }
      }
    });
  }

  // ── Link resolution ──

  private async resolveLink(
    link: { kind: string; target: string; alias?: string },
    currentDoc: vscode.TextDocument,
    webview: vscode.Webview,
  ): Promise<Record<string, unknown> | null> {
    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return null;

      const kind = link.kind;
      const target = link.target;

      if (kind === 'tag') {
        const tagFiles = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 100);
        const decoder = new TextDecoder();
        const matchingNotes: string[] = [];
        // Process in small batches, stop as soon as we have enough
        const TAG_BATCH = 8;
        for (let i = 0; i < tagFiles.length && matchingNotes.length < 10; i += TAG_BATCH) {
          const batch = tagFiles.slice(i, i + TAG_BATCH);
          await Promise.all(batch.map(async (uri) => {
            if (matchingNotes.length >= 10) return;
            try {
              const bytes = await vscode.workspace.fs.readFile(uri);
              const content = decoder.decode(bytes);
              if (content.includes(`#${target}`) || content.includes(`- ${target}`)) {
                const scan = scanMarkdown(content);
                if (scan.tags.some(t => t === target || t.startsWith(`${target}/`))) {
                  matchingNotes.push(scan.title || vscode.workspace.asRelativePath(uri, false));
                }
              }
            } catch { /* skip */ }
          }));
        }
        return {
          kind: 'tag',
          target,
          title: `#${target}`,
          noteCount: matchingNotes.length,
          exampleNotes: matchingNotes.slice(0, 5),
          exists: true,
        };
      }

      if (kind === 'external-url') {
        let domain = '';
        try { domain = new URL(target).hostname; } catch { /* */ }
        return {
          kind: 'external-url',
          target,
          title: link.alias || target,
          domain,
          exists: true,
        };
      }

      if (kind === 'heading-ref') {
        const headingId = target.replace(/^#/, '');
        const docContent = currentDoc.getText();
        const lines = docContent.split('\n');
        let headingText = '';
        let snippetLines: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const match = /^#{1,6}\s+(.+)/.exec(line);
          if (match) {
            const slug = match[1].trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
            if (slug === headingId.toLowerCase() || match[1].trim().toLowerCase() === headingId.toLowerCase()) {
              headingText = match[1].trim();
              snippetLines = lines.slice(i + 1, i + 5).filter(l => l.trim());
              break;
            }
          }
        }
        if (headingText) {
          return {
            kind: 'heading-ref', target, title: headingText,
            snippet: snippetLines.join('\n').slice(0, 200), exists: true,
          };
        }
        return { kind: 'heading-ref', target, title: target, exists: false };
      }

      if (['image', 'video', 'audio', 'pdf', 'code-file'].includes(kind)) {
        const resolved = this.resolveRelativePath(target, currentDoc);
        if (!resolved) return { kind, target, title: target.split('/').pop() || target, exists: false };

        try {
          const stat = await vscode.workspace.fs.stat(resolved);
          const result: Record<string, unknown> = {
            kind, target,
            title: target.split('/').pop() || target,
            exists: true, fileSize: stat.size,
          };

          if (kind === 'image') {
            result.thumbnailUrl = webview.asWebviewUri(resolved).toString();
          }
          if (kind === 'code-file') {
            const ext = target.split('.').pop()?.toLowerCase() || '';
            const langMap: Record<string, string> = {
              ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
              py: 'Python', rb: 'Ruby', rs: 'Rust', go: 'Go', java: 'Java',
              c: 'C', cpp: 'C++', cs: 'C#', swift: 'Swift', kt: 'Kotlin',
              sh: 'Shell', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
              html: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL', md: 'Markdown',
            };
            result.language = langMap[ext] || ext;
            if (stat.size < 50000) {
              try {
                const bytes = await vscode.workspace.fs.readFile(resolved);
                result.snippet = new TextDecoder().decode(bytes).split('\n').slice(0, 6).join('\n');
              } catch { /* */ }
            }
          }
          return result;
        } catch {
          return { kind, target, title: target.split('/').pop() || target, exists: false };
        }
      }

      if (kind === 'footnote') {
        const docContent = currentDoc.getText();
        const fnRe = new RegExp(`^\\[\\^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]:\\s*(.+)`, 'm');
        const match = fnRe.exec(docContent);
        if (match) {
          return { kind: 'footnote', target, title: `Footnote: ${target}`, snippet: match[1].trim(), exists: true };
        }
        return { kind: 'footnote', target, title: `[^${target}]`, exists: false };
      }

      // Wiki-link or markdown-link
      const resolvedUri = await this.resolveNoteLink(target, currentDoc, folder);
      if (!resolvedUri) {
        return { kind: kind || 'unresolved', target, title: link.alias || target, exists: false };
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(resolvedUri);
        const content = new TextDecoder().decode(bytes);
        const scan = scanMarkdown(content);
        const stat = await vscode.workspace.fs.stat(resolvedUri);

        const snippetLines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
        const snippet = snippetLines.slice(0, 4).join('\n').slice(0, 250);

        return {
          kind: kind || 'wiki-link', target,
          title: scan.title || target, snippet,
          tags: scan.tags.slice(0, 6),
          headings: scan.headings.slice(0, 10).map(h => ({ level: h.level, text: h.text })),
          modified: new Date(stat.mtime).toLocaleDateString(),
          exists: true, fileSize: stat.size,
        };
      } catch {
        return { kind: kind || 'unresolved', target, title: link.alias || target, exists: false };
      }
    } catch {
      return null;
    }
  }

  // ── Navigation ──

  private async navigateToLink(
    link: { kind: string; target: string; alias?: string },
    currentDoc: vscode.TextDocument,
  ): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    if (link.kind === 'external-url') {
      vscode.env.openExternal(vscode.Uri.parse(link.target));
      return;
    }

    if (link.kind === 'tag') {
      vscode.commands.executeCommand('workbench.action.findInFiles', {
        query: `#${link.target}`, triggerSearch: true, isRegex: false,
      });
      return;
    }

    if (link.kind === 'heading-ref') {
      const headingId = link.target.replace(/^#/, '');
      const docContent = currentDoc.getText();
      const lines = docContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = /^#{1,6}\s+(.+)/.exec(lines[i]);
        if (match) {
          const slug = match[1].trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
          if (slug === headingId.toLowerCase() || match[1].trim().toLowerCase() === headingId.toLowerCase()) {
            // Tell webview to scroll to this heading
            const panel = KiviEditorProvider.activePanels.get(currentDoc.uri.toString());
            panel?.webview.postMessage({ type: 'scrollToHeading', heading: match[1].trim(), line: i });
            return;
          }
        }
      }
      return;
    }

    // Resolve to file
    const resolvedUri = await this.resolveNoteLink(link.target, currentDoc, folder);
    if (resolvedUri) {
      try {
        await vscode.workspace.fs.stat(resolvedUri);
        vscode.commands.executeCommand('vscode.openWith', resolvedUri, KiviEditorProvider.viewType);
      } catch {
        // File doesn't exist — offer to create
        const answer = await vscode.window.showInformationMessage(
          `"${link.target}" does not exist. Create it?`,
          'Create', 'Cancel',
        );
        if (answer === 'Create') {
          await vscode.workspace.fs.writeFile(resolvedUri, new TextEncoder().encode(`# ${link.target}\n\n`));
          vscode.commands.executeCommand('vscode.openWith', resolvedUri, KiviEditorProvider.viewType);
        }
      }
    } else {
      const assetUri = this.resolveRelativePath(link.target, currentDoc);
      if (assetUri) {
        vscode.commands.executeCommand('vscode.open', assetUri);
      } else {
        vscode.window.showInformationMessage(`Could not resolve: ${link.target}`);
      }
    }
  }

  // ── Path resolution ──

  /** Resolve a wiki-link or markdown-link target to a .md file URI.
   *  Tries: workspace-root exact, case-insensitive search, relative path.
   */
  private async resolveNoteLink(
    target: string,
    currentDoc: vscode.TextDocument,
    folder: vscode.WorkspaceFolder,
  ): Promise<vscode.Uri | null> {
    const cleaned = target.replace(/#.*$/, '').replace(/\?.*$/, '').trim();
    if (!cleaned) return null;

    const name = cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`;

    // Try workspace root
    const rootUri = vscode.Uri.joinPath(folder.uri, name);
    try {
      await vscode.workspace.fs.stat(rootUri);
      return rootUri;
    } catch { /* continue */ }

    // Try relative to current file
    const currentDir = vscode.Uri.joinPath(currentDoc.uri, '..');
    const relUri = vscode.Uri.joinPath(currentDir, name);
    try {
      await vscode.workspace.fs.stat(relUri);
      return relUri;
    } catch { /* continue */ }

    // Case-insensitive: search for matching file name
    const baseName = name.split('/').pop() || name;
    const results = await vscode.workspace.findFiles(`**/${baseName}`, '**/node_modules/**', 1);
    if (results.length > 0) return results[0];

    // Fall back to workspace root (for creating new files)
    return rootUri;
  }

  private resolveRelativePath(target: string, currentDoc: vscode.TextDocument): vscode.Uri | null {
    if (!target) return null;
    const currentDir = vscode.Uri.joinPath(currentDoc.uri, '..');
    return vscode.Uri.joinPath(currentDir, target);
  }

  // ── HTML ──

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.css'),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Kivi</title>
</head>
<body>
  <div id="editor"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

