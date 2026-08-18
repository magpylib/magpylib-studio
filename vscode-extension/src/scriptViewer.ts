import { createHash } from 'crypto';

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
  /** The window's setting chose this backend, not the script. Absent on
   *  payloads from before it existed, which is the same as false. */
  claimed?: boolean;
  /** The interpreter that drew it, and the directory it ran in. */
  python?: string;
  cwd?: string;
  /** sha256 of the script's bytes as they were when it ran. Null for a REPL,
   *  absent on payloads written before this existed. */
  digest?: string | null;
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
/** Staleness is kept here rather than in the page because the page does not
 *  outlive being hidden: a panel in a background tab is torn down, so a message
 *  posted to it goes nowhere, and when it comes back it asks for its payload
 *  and would be told only what to draw. Whoever holds the state has to be the
 *  side that survives. */
interface View {
  panel: vscode.WebviewPanel;
  payload: ViewPayload;
  stale: boolean;
}

const views = new Map<string, View>();

/** Whether scripts run here are drawn here. One reader, so the fallback
 *  cannot drift from the contributed default. */
export function drawScriptsHere(): boolean {
  return vscode.workspace
    .getConfiguration('magpylib-studio')
    .get<boolean>('drawScriptsHere', true);
}

/** Write it where it is defined, not always globally.
 *
 *  `update(..., Global)` while a workspace value exists changes nothing the
 *  user can see -- the workspace value still wins -- so an offer to turn the
 *  behaviour off would report success and leave it on. */
export async function setDrawScriptsHere(value: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('magpylib-studio');
  const defined = config.inspect<boolean>('drawScriptsHere');
  let target = vscode.ConfigurationTarget.Global;
  if (defined?.workspaceFolderValue !== undefined) {
    target = vscode.ConfigurationTarget.WorkspaceFolder;
  } else if (defined?.workspaceValue !== undefined) {
    target = vscode.ConfigurationTarget.Workspace;
  }
  await config.update('drawScriptsHere', value, target);
}

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

/** A name for the tab: the script, and which of its `show()` calls this is.
 *
 *  With `stale`, the dot editors use for "not current". The tab is the only
 *  thing that shows while the panel is in a background group, which is exactly
 *  when a figure quietly stops matching its file. */
function panelTitle(payload: ViewPayload, stale = false): string {
  const base = payload.title
    ? payload.title
    : (() => {
        const name = payload.script.split(/[\\/]/).pop() || payload.script;
        return payload.index === 0 ? name : `${name} (${payload.index + 1})`;
      })();
  return stale ? `${base} •` : base;
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
  // VS Code's own icon font, so Re-run wears the same glyph as Run everywhere
  // else in the editor. The stylesheet names the font file beside it, which
  // resolves against this URI -- and `font-src` is already in the CSP.
  const codiconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      context.extensionUri,
      'node_modules',
      '@vscode',
      'codicons',
      'dist',
      'codicon.css',
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
  <link rel="stylesheet" href="${codiconUri}" />
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
  <div id="stage">
    <div id="canvas"></div>
    <div id="overlay" hidden>
      <span id="stale" title="The script has been saved since this figure was drawn">out of date</span>
      <button id="rerun" title="Runs the script again, with the interpreter and directory it ran in before">
        <i class="codicon codicon-run"></i>Re-run
      </button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Said once, ever: the first time a script's figure lands in a panel.
 *
 *  Drawing scripts here is on by default, so the first panel is something the
 *  user did not ask for and may not want -- and "why is show() opening a tab?"
 *  is best answered where it is asked rather than in a settings page nobody
 *  has opened. It never returns once dismissed, which is why the offer to turn
 *  it off is in the message rather than a pointer to where the switch lives.
 */
async function noticeOnce(
  context: vscode.ExtensionContext,
  payload: ViewPayload,
): Promise<void> {
  const SEEN = 'magpylib-studio.scriptDrawNoticeShown';
  // Only for a panel the *setting* produced. A script that asked for
  // `backend="studio"` was not surprised by this and turning the setting off
  // would not stop it -- offering that would be answering a question nobody
  // asked, and spending a notice that is shown once.
  if (context.globalState.get<boolean>(SEEN) || !payload.claimed) {
    return;
  }
  await context.globalState.update(SEEN, true);
  const off = 'Stop drawing scripts here';
  const settings = 'Settings';
  const choice = await vscode.window.showInformationMessage(
    'Magpylib Studio draws figures from scripts you run in this window. ' +
      'Scripts that choose their own backend are unaffected.',
    off,
    settings,
  );
  if (choice === off) {
    await setDrawScriptsHere(false);
    const undo = 'Undo';
    // The notice is shown once, so a misclick here would otherwise be answered
    // only by finding the setting. Cheaper to offer it back while the question
    // is still on screen.
    const second = await vscode.window.showInformationMessage(
      'Magpylib Studio: scripts use their own backend again. Terminals already ' +
        'open keep the old setting until they are restarted.',
      undo,
    );
    if (second === undo) {
      await setDrawScriptsHere(true);
    }
  } else if (choice === settings) {
    // Opens the settings editor filtered to this one, so the switch is in
    // front of the user rather than described to them. Answering the question
    // by writing the setting is one click; being shown where it lives is how
    // someone finds it again, or the others beside it.
    void vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'magpylib-studio.drawScriptsHere',
    );
  }
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
    // A payload is the script as it was when it ran, so one arriving is the
    // only thing that settles this.
    existing.stale = false;
    existing.panel.title = panelTitle(payload);
    void existing.panel.webview.postMessage({ type: 'view', payload, stale: false });
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
  views.set(key, { panel, payload, stale: false });
  panel.webview.html = html(context, panel.webview);
  void noticeOnce(context, payload);
  panel.webview.onDidReceiveMessage((message: { type?: string }) => {
    // The page asks when it is ready rather than being told when the panel is
    // created: a hidden panel is torn down and rebuilt from this HTML, and a
    // message posted to one that is still parsing goes nowhere.
    if (message.type === 'ready') {
      const current = views.get(key);
      if (current) {
        void current.panel.webview.postMessage({
          type: 'view',
          payload: current.payload,
          stale: current.stale,
        });
      }
    } else if (message.type === 'openInStudio') {
      void promote(key);
    } else if (message.type === 'rerun') {
      rerun(key);
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

/** Say, for each panel drawn from `uri`, whether it still matches the file.
 *
 *  Saving is not changing: an editor writes on every save, including one that
 *  altered nothing, and a panel that cries out of date each time is one nobody
 *  believes. So the file is hashed and compared with what the payload recorded
 *  -- which also means editing, saving, undoing and saving again clears the
 *  mark rather than leaving it stuck on a file that is back where it started.
 *
 *  Bytes, not the editor's text: the writer hashed the file, and decoding
 *  first would have the two disagree over a line ending rather than over code.
 */
async function restate(uri: vscode.Uri): Promise<void> {
  const drawn = [...views.values()].filter((v) => v.payload.script === uri.fsPath);
  if (!drawn.length) {
    return;
  }
  let digest: string | undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    digest = createHash('sha256').update(bytes).digest('hex');
  } catch {
    // Unreadable now: it was there when it drew, so something has changed.
    digest = undefined;
  }
  for (const view of drawn) {
    // No recorded digest means a payload from before this existed. Falling
    // back to "a save is a change" keeps those behaving as they used to.
    const recorded = view.payload.digest;
    const stale = recorded ? recorded !== digest : true;
    if (stale === view.stale) {
      continue;
    }
    view.stale = stale;
    view.panel.title = panelTitle(view.payload, stale);
    // The state, not a redraw: clearing the mark by re-sending the payload
    // would rebuild the figure to change one label.
    void view.panel.webview.postMessage({ type: 'stale', stale });
  }
}

/** The terminal re-runs go to. One, reused: a script re-run five times should
 *  not leave five terminals, and seeing the last run's output above this one is
 *  usually what you want when a figure did not change the way you expected. */
let runner: vscode.Terminal | undefined;

/** Run the script again, the way it was run before.
 *
 *  In a terminal rather than quietly in the background: it is what the user
 *  would have typed, its output is where output goes, and a script that asks a
 *  question or throws says so somewhere visible. The terminal is also what
 *  carries this window's address, so the figure comes back to this panel.
 *
 *  With the interpreter and directory recorded in the payload, not the ones the
 *  editor would guess. The package has to be importable in *that* interpreter,
 *  and a script that reads a file beside itself needs the directory it was
 *  started from.
 */
function rerun(key: string): void {
  const view = views.get(key);
  if (!view) {
    return;
  }
  const { script, python, cwd } = view.payload;
  if (!python) {
    // Written by a version that did not record it. Guessing an interpreter is
    // how a re-run silently draws nothing.
    void vscode.window.showWarningMessage(
      'Magpylib Studio: this figure does not say which interpreter drew it. ' +
        'Run the script again yourself.',
    );
    return;
  }
  if (!runner || runner.exitStatus !== undefined) {
    runner = vscode.window.createTerminal({ name: 'Magpylib Studio', cwd });
  }
  runner.show(true); // preserveFocus: the figure is what is being watched
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  // PowerShell needs the call operator before a quoted path; every other shell
  // this runs in is happy without it.
  const call = process.platform === 'win32' ? '& ' : '';
  runner.sendText(`${call}${quote(python)} ${quote(script)}`);
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
  // A panel is a rendering from a moment, and the file it came from goes on
  // being edited. Saving is the moment that is worth marking -- it is when the
  // two are known to disagree, and it costs one event rather than a watcher
  // per open panel. A file changed outside the editor is missed; the panel
  // then says nothing rather than something wrong.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      void restate(document.uri);
    }),
  );
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
