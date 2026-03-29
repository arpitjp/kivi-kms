import * as vscode from 'vscode';
import { KiviEditorProvider } from './editor-provider.js';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(KiviEditorProvider.register(context));
}

export function deactivate() {}
