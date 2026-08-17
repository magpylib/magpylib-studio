import * as vscode from 'vscode';

import { mediaUri, nonce as webviewNonce } from './webview';

/**
 * Figures from scripts the user runs, drawn in this window.
 *
 * The studio's own panels are fed by the engine, which the extension owns and
 * can ask for anything. A script is the other way round: it is started by the
 * user, it owns its objects, and it exits. So it pushes rather than being
 * polled — it leaves a figure in the directory this window stamped on its
 * terminals (`MAGPYLIB_STUDIO_DROP`), and this watches for it.
 *
 * One panel per `show()` call in the script, addressed by the file the payload
 * arrives in. The Python side names that file from the script and the call's
 * position in it, so a rerun writes over the same files and the panels update
 * where they are, keeping the camera the user had just set.
 */

/** Must match `VIEWS_SUBDIR` in magpylib_studio/viewer.py. */
const VIEWS_SUBDIR = 'views';

/** Must match `PAYLOAD_VERSION` there. Refuse what we cannot read whole. */
const PAYLOAD_VERSION = 1;

const PANEL_TYPE = 'magpylibScriptView';

interface ViewPayload {
  version: number;
  kind: string;
  script: string;
  index: number;
  title: string | null;
  written: number;
  body: unknown;
}

/** The panel for each payload file, and the last thing it was sent.
 *
 *  The payload is kept because these panels do not retain their context when
 *  hidden — a plotly scene per script per run is a lot to hold on to — so a
 *  panel that comes back into view rebuilds from its HTML, says `ready`, and
 *  is told again what to draw. */
const views = new Map<string, { panel: vscode.WebviewPanel; payload: ViewPayload }>();

let log: vscode.OutputChannel | undefined;

function say(message: string): void {
  log ??= vscode.window.createOutputChannel('Magpylib Studio Views');
  log.appendLine(message);
}

/** Where scripts run from this window leave their figures. */
function viewsUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(
    context.storageUri ?? context.globalStorageUri,
    VIEWS_SUBDIR,
  );
}

/** A name for the tab: the script, and which of its `show()` calls this is. */
function panelTitle(payload: ViewPayload): string {
  if (payload.title) {
    return payload.title;
  }
  const name = payload.script.split(/[\\/]/).pop() || payload.script;
  return payload.index === 0 ? name : `${name} (${payload.index + 1})`;
}

function html(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = webviewNonce();
  const styleUri = mediaUri(webview, context.extensionUri, 'scriptView.css');
  const scriptUri = mediaUri(webview, context.extensionUri, 'scriptView.js');
  const plotlyUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      context.extensionUri,
      'node_modules',
      'plotly.js-dist-min',
      'plotly.min.js',
    ),
  );
  const scene3dUri = mediaUri(webview, context.extensionUri, 'scene3d.mjs');
  // Same mapping as the studio's own panel: three ships ESM only and its
  // addons import the bare name, so the specifiers are mapped rather than
  // rewritten.
  const threeUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      context.extensionUri,
      'node_modules',
      'three',
      'build',
      'three.module.min.js',
    ),
  );
  const threeAddonsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'three', 'examples', 'jsm'),
  );
  const importMap = JSON.stringify({
    imports: { three: `${threeUri}`, 'three/addons/': `${threeAddonsUri}/` },
  });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Magpylib View</title>
  <link rel="stylesheet" href="${styleUri}" />
  <script nonce="${nonce}" src="${plotlyUri}"></script>
  <script type="importmap" nonce="${nonce}">${importMap}</script>
  <script type="module" nonce="${nonce}" src="${scene3dUri}"></script>
</head>
<body>
  <div id="status">Waiting for a figure…</div>
  <div id="canvas"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Show `payload`, in the panel that file already owns or in a new one. */
function draw(
  context: vscode.ExtensionContext,
  key: string,
  payload: ViewPayload,
): void {
  const existing = views.get(key);
  if (existing) {
    existing.payload = payload;
    existing.panel.title = panelTitle(payload);
    void existing.panel.webview.postMessage({ type: 'view', payload });
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    PANEL_TYPE,
    panelTitle(payload),
    // Beside and unfocused: the script was run from an editor the user is
    // still typing in, and a figure appearing is not a reason to take the
    // cursor away from it.
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, localResourceRoots: [context.extensionUri] },
  );
  views.set(key, { panel, payload });
  panel.webview.html = html(context, panel.webview);
  panel.webview.onDidReceiveMessage((message: { type?: string }) => {
    // The page asks when it is ready rather than being told when the panel is
    // created: a hidden panel is torn down and rebuilt from this HTML, and a
    // message posted to one that is still parsing goes nowhere.
    if (message.type === 'ready') {
      const current = views.get(key);
      if (current) {
        void current.panel.webview.postMessage({ type: 'view', payload: current.payload });
      }
    }
  });
  panel.onDidDispose(() => {
    views.delete(key);
  });
}

async function read(uri: vscode.Uri): Promise<ViewPayload | undefined> {
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (err) {
    // The file can be gone by the time we get here — a rerun replaces it, and
    // a run that crashed mid-write leaves nothing to read.
    say(`could not read ${uri.fsPath}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
  let payload: ViewPayload;
  try {
    payload = JSON.parse(text) as ViewPayload;
  } catch (err) {
    say(`not a figure: ${uri.fsPath}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
  if (payload.version !== PAYLOAD_VERSION) {
    say(
      `ignoring ${uri.fsPath}: payload version ${payload.version}, ` +
        `this extension reads ${PAYLOAD_VERSION}. Update the extension or ` +
        'the magpylib-studio package so the two agree.',
    );
    return undefined;
  }
  if (payload.kind !== 'plotly' && payload.kind !== 'scene') {
    say(`ignoring ${uri.fsPath}: unknown figure kind ${payload.kind}`);
    return undefined;
  }
  return payload;
}

/** Watch this window's drop directory, and draw what arrives in it. */
export function activateScriptViewer(context: vscode.ExtensionContext): void {
  const arrived = (uri: vscode.Uri): void => {
    void read(uri).then((payload) => {
      if (payload) {
        draw(context, uri.path, payload);
      }
    });
  };
  void (async () => {
    const dir = viewsUri(context);
    await vscode.workspace.fs.createDirectory(dir);
    // Payloads left by earlier sessions describe panels that no longer exist:
    // no serializer is registered for these, so VS Code closes them on reload.
    // Clearing also stops a directory that only ever grows — one file per
    // show() call per script, forever — from doing so.
    //
    // Before the watcher, not after: a payload written in between would
    // otherwise be drawn and then deleted underneath its own panel.
    for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
      if (type === vscode.FileType.File) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
      }
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, '*.json'),
    );
    watcher.onDidCreate(arrived);
    watcher.onDidChange(arrived);
    context.subscriptions.push(watcher);
  })();
}
