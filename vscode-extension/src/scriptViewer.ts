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

/** Where scripts run from this window leave their figures.
 *
 *  Per window, which workspace storage already is. A window with no folder
 *  open has none and falls back to global storage, which every other
 *  folder-less window shares -- so a script run in one would draw panels in
 *  both, and whichever swept first would delete the other's payloads before
 *  they were read. The session id separates them; it changes across a reload,
 *  which is also when the stamp is re-applied. */
function viewsUri(context: vscode.ExtensionContext): vscode.Uri {
  if (context.storageUri) {
    return vscode.Uri.joinPath(context.storageUri, VIEWS_SUBDIR);
  }
  return vscode.Uri.joinPath(
    context.globalStorageUri,
    VIEWS_SUBDIR,
    vscode.env.sessionId,
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
  // The same logo the activity bar and the panel tabs carry. The activity bar
  // masks it to a monochrome silhouette; as an <img> here it keeps its own
  // colours, which is what makes the button read as "the studio" at a glance.
  const logoUri = mediaUri(webview, context.extensionUri, 'magnet.svg');
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
  <div id="bar">
    <span id="status">Waiting for a figure…</span>
    <button id="promote" hidden title="Runs this script again in the studio, which takes its objects">
      <img src="${logoUri}" alt="" />Open in Magpylib Studio
    </button>
  </div>
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
    } else if (message.type === 'openInStudio') {
      void promote(key);
    }
  });
  panel.onDidDispose(() => {
    views.delete(key);
  });
}

/** Hand the studio the script this panel was drawn from.
 *
 *  The picture cannot be promoted — a payload is a rendering, and the objects
 *  it was made from are in a process that has exited. What can be promoted is
 *  the script, which the studio already knows how to run and introspect. So
 *  the studio's scene is what the script produces *now*, which is why the
 *  button says "open the script" rather than "edit this".
 */
async function promote(key: string): Promise<void> {
  const view = views.get(key);
  if (!view) {
    return;
  }
  const { script } = view.payload;
  const uri = vscode.Uri.file(script);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    // A script run from a temp file, or one edited away since it drew. The
    // panel keeps its figure; there is simply nothing to re-run.
    void vscode.window.showWarningMessage(
      `Magpylib Studio: cannot open ${script} — it is not there any more.`,
    );
    return;
  }
  // Which of the script's show() calls this panel is. The studio re-runs the
  // script and captures one scene per call, in the same order, so the index
  // that addressed this panel usually picks the scene it was drawn from.
  //
  // Usually, because the two count different things: this counts figures this
  // package wrote, the import counts magpylib show() calls it could read. A
  // script that also draws a plain plotly figure under `draw_here()`, or one
  // the importer skips, pushes them apart. Recoverable rather than prevented --
  // "Magpylib Studio: Switch Imported Scene…" picks another.
  await vscode.commands.executeCommand(
    'magpylib-studio.openScriptInStudio',
    uri,
    view.payload.index,
  );
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
  void watch(context).catch((err: unknown) => {
    // Without this the failure is total and silent: no watcher, no panels, and
    // a script that goes on writing payloads nothing will ever read.
    say(`script views are not running: ${err instanceof Error ? err.message : err}`);
    void vscode.window.showWarningMessage(
      'Magpylib Studio: figures from scripts cannot be watched for — see the ' +
        '"Magpylib Studio Views" output for why.',
    );
  });
}

async function watch(context: vscode.ExtensionContext): Promise<void> {
  const arrived = (uri: vscode.Uri): void => {
    void read(uri).then((payload) => {
      if (payload) {
        draw(context, uri.path, payload);
      }
    });
  };
  {
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
  }
}
