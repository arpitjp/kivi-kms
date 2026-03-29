import * as vscode from 'vscode';

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

    webviewPanel.onDidDispose(() => {
      changeDocSubscription.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          isWebviewReady = true;
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

          // Compute targeted diff: find the first and last differing characters
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
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
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
