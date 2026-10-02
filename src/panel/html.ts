import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** HTML with a CSP and a nonce. Only one script, the one carrying the nonce, is allowed. */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, boot: Record<string, unknown>): string {
  const nonce = randomBytes(16).toString('base64');
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'index.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'index.css'));
  // Worker for syntax highlighting. Its origin differs from the webview, so fetch its body and start it from a blob:
  const worker = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'syntax', 'worker.js'));
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `connect-src ${webview.cspSource}`,
    'worker-src blob:',
  ].join('; ');
  // Embedding JSON as is would let </script> close the tag, so escape <
  const json = JSON.stringify({ ...boot, syntaxWorker: worker.toString() }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Twigline</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems":true}'>
<div id="root"></div>
<script type="application/json" id="twigline-boot">${json}</script>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
