import * as vscode from 'vscode';

export function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export function getActiveMarkdownUri(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.fileName.endsWith('.md')) {
    return editor.document.uri;
  }
  const tabUri = (vscode.window.tabGroups.activeTabGroup.activeTab?.input as any)?.uri as vscode.Uri | undefined;
  if (tabUri && (tabUri.fsPath.endsWith('.md') || tabUri.fsPath.endsWith('.markdown'))) {
    return tabUri;
  }
  return undefined;
}
