import * as vscode from 'vscode';
import { KiviEditorProvider } from './editor-provider.js';
import { BacklinksProvider } from './backlinks-provider.js';
import { FileExplorerProvider } from './file-explorer-provider.js';
import { OutlineProvider } from './outline-provider.js';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(KiviEditorProvider.register(context));

  // File explorer sidebar
  const fileExplorerProvider = new FileExplorerProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kivi.files', fileExplorerProvider),
  );

  // Outline view
  const outlineProvider = new OutlineProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kivi.outline', outlineProvider),
  );

  const backlinksProvider = new BacklinksProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kivi.backlinks', backlinksProvider),
  );

  // Index all markdown files in workspace
  const indexWorkspace = async () => {
    const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
    for (const uri of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        backlinksProvider.updateIndex(uri.fsPath, doc.getText());
      } catch {
        // Skip files that can't be read
      }
    }
  };
  indexWorkspace();

  // Watch for file changes
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');
  context.subscriptions.push(
    watcher.onDidCreate(async (uri) => {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        backlinksProvider.updateIndex(uri.fsPath, doc.getText());
      } catch { /* skip */ }
    }),
    watcher.onDidChange(async (uri) => {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        backlinksProvider.updateIndex(uri.fsPath, doc.getText());
      } catch { /* skip */ }
    }),
    watcher.onDidDelete((uri) => {
      backlinksProvider.removeFromIndex(uri.fsPath);
      backlinksProvider.refresh();
      fileExplorerProvider.refresh();
    }),
    watcher,
  );

  // Refresh file explorer when files are created
  context.subscriptions.push(
    watcher.onDidCreate(() => fileExplorerProvider.refresh()),
  );

  // Refresh when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      backlinksProvider.refresh();
      outlineProvider.refresh();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        outlineProvider.refresh();
      }
    }),
  );
}

export function deactivate() {}
