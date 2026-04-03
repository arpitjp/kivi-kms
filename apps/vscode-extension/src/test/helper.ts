import * as vscode from 'vscode';
import * as path from 'path';

export const FIXTURES_DIR = path.resolve(__dirname, '..', '..', '..', 'test-fixtures');

export function getFixturePath(filename: string): string {
  return path.join(FIXTURES_DIR, filename);
}

export async function openMarkdownFile(filename: string): Promise<vscode.TextDocument> {
  const uri = vscode.Uri.file(getFixturePath(filename));
  const doc = await vscode.workspace.openTextDocument(uri);
  return doc;
}

export async function openWithCustomEditor(filename: string): Promise<vscode.TextDocument> {
  const uri = vscode.Uri.file(getFixturePath(filename));
  await vscode.commands.executeCommand(
    'vscode.openWith',
    uri,
    'kivi.markdownEditor',
  );
  await sleep(2000);
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === uri.fsPath,
  );
  if (!doc) throw new Error(`Document not found: ${filename}`);
  return doc;
}

export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(300);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
