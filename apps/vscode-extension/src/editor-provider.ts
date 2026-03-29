import * as vscode from 'vscode';

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
  showLineNumbers: boolean;
}

function readKiviSettings(): KiviSettings {
  const cfg = vscode.workspace.getConfiguration('kivi');
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
    showLineNumbers: cfg.get<boolean>('ui.showLineNumbers', false),
  };
}

export class KiviEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'kivi.markdownEditor';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      KiviEditorProvider.viewType,
      new KiviEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.context.extensionUri, 'images'),
      ],
    };

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    let isWebviewReady = false;
    let pendingContent: string | null = document.getText();
    let lastKnownContent = document.getText();

    const sendContent = (content: string) => {
      if (isWebviewReady) {
        webviewPanel.webview.postMessage({ type: 'load', content });
      } else {
        pendingContent = content;
      }
    };

    const sendSettings = () => {
      const settings = readKiviSettings();
      webviewPanel.webview.postMessage({ type: 'settings', settings });
    };

    let suppressNextChange = false;

    const changeDocSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (suppressNextChange) {
        suppressNextChange = false;
        lastKnownContent = document.getText();
        return;
      }
      lastKnownContent = document.getText();
      sendContent(lastKnownContent);
    });

    const configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kivi')) {
        sendSettings();
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocSubscription.dispose();
      configSubscription.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          isWebviewReady = true;
          sendSettings();
          if (pendingContent !== null) {
            webviewPanel.webview.postMessage({ type: 'load', content: pendingContent });
            lastKnownContent = pendingContent;
            pendingContent = null;
          }
          break;

        case 'edit': {
          if (typeof msg.content !== 'string') break;
          const newContent = msg.content;

          if (newContent === lastKnownContent) break;

          const edit = new vscode.WorkspaceEdit();

          const oldText = lastKnownContent;
          const newText = newContent;

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
          suppressNextChange = true;
          lastKnownContent = newContent;
          await vscode.workspace.applyEdit(edit);
          break;
        }
      }
    });
  }

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
    content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
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

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
