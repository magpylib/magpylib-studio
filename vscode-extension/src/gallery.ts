import * as vscode from 'vscode';
import { mediaUri, nonce } from './webview';

/** An example as the engine lists it (`list_examples`). */
export interface Example {
  name: string;
  label: string;
  description: string;
}

let panel: vscode.WebviewPanel | undefined;

/**
 * The example gallery: every built-in scene as a card, with its picture --
 * drawn by the studio itself, `npm run gallery`, into `media/gallery/` -- its
 * name and what it shows. One tab, brought forward when asked for again. A
 * card opens its example in a tab of its own (`open`), and the gallery stays
 * behind it for the next.
 */
export function showGallery(
  context: vscode.ExtensionContext,
  examples: () => Promise<Example[]>,
  open: (name: string) => void,
): void {
  if (panel) {
    panel.reveal();
    return;
  }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const shown = vscode.window.createWebviewPanel(
    'magpylibStudio.gallery',
    'Example Gallery',
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [media] },
  );
  panel = shown;
  shown.iconPath = {
    light: vscode.Uri.joinPath(media, 'magnet.svg'),
    dark: vscode.Uri.joinPath(media, 'magnet-dark.svg'),
  };
  const webview = shown.webview;
  webview.html = html(context, webview);
  webview.onDidReceiveMessage(async (message: { type?: string; name?: unknown }) => {
    // The page asks when it is ready rather than being told when the panel
    // is made: a message posted to one still parsing goes nowhere.
    if (message.type === 'ready') {
      let listed: Example[] = [];
      let error: string | undefined;
      try {
        listed = await examples();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      void webview.postMessage({
        type: 'examples',
        error,
        examples: listed.map((example) => ({
          ...example,
          light: picture(context, webview, example.name, 'light'),
          dark: picture(context, webview, example.name, 'dark'),
        })),
      });
    } else if (message.type === 'open' && typeof message.name === 'string') {
      open(message.name);
    }
  });
  shown.onDidDispose(() => {
    panel = undefined;
  });
}

/** An example's picture in one theme; one never drawn shows as a blank
 *  card, which the page dresses. */
function picture(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  name: string,
  theme: 'light' | 'dark',
): string {
  return mediaUri(webview, context.extensionUri, 'gallery', `${name}-${theme}.webp`).toString();
}

function html(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const token = nonce();
  const styleUri = mediaUri(webview, context.extensionUri, 'gallery.css');
  const scriptUri = mediaUri(webview, context.extensionUri, 'gallery.mjs');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${token}' ${webview.cspSource};" />
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <main>
    <h1>Examples</h1>
    <div id="gallery" role="list"></div>
  </main>
  <script type="module" nonce="${token}" src="${scriptUri}"></script>
</body>
</html>`;
}
