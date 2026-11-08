import * as vscode from 'vscode';

import { setTextFocus, tookTextFocus } from './textFocus';
import { noticeHtml, PackagePage, PackageView } from './packageView';
import { mediaUri, nonce as webviewNonce } from './webview';

const MUTATING = new Set([
  'apply_edit',
  'reset_style',
  'move',
  'rotate',
  'set_transform',
  'clear_path',
  'set_param',
  'edit_event',
]);

/**
 * Sidebar style inspector: schema-driven widgets for the selected object.
 * Widgets are generated in the webview from `get_schema` (enum -> dropdown,
 * format:color -> picker, bounded number -> slider, boolean -> tri-state) and
 * filled from `get_values` (resolved values shown; explicitly set paths get a
 * reset button). All edits go through the shared engine RPC router.
 *
 * The panel is the package's (`magpylib_studio/static/inspector.mjs`): the
 * notebook widget floats the same one, compact, beside its edit column, and
 * `media/inspector.mjs` mounts it here in full with its calls routed through
 * this provider.
 */
export class InspectorViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'magpylib-studio.inspectorView';

  private view: vscode.WebviewView | undefined;
  /** The scene the view shows, beside its title, and its key. */
  private scene: string | undefined;
  private sceneKey: string | undefined;
  private ready = false;
  /** The page, and which view drew it. */
  private page: PackagePage | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** `scene` is the key of the scene the page was drawn for, which the
     *  request goes to, and which an edit marks unsaved. */
    private readonly request: (
      method: string,
      params: Record<string, unknown> | undefined,
      scene: string | undefined,
    ) => Promise<unknown>,
    private readonly onMutation: (scene: string | undefined) => void,
    private readonly getSelection: () => string | undefined,
    /** The view the engine's package draws with, once an engine has said. */
    private readonly packageView: () => PackageView | undefined,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.description = this.scene;
    this.page = new PackagePage(() => webviewView.webview, this.extensionUri);
    this.draw();
    // Shown again, the page is loaded again from its HTML without a word to
    // this: the files it loads are those on disk now, which `packageView`
    // checks against the running engine's.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.draw();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (tookTextFocus(message, webviewView.webview)) {
        return;
      }
      if (message.type === 'ready') {
        this.ready = true;
        webviewView.webview.postMessage({ type: 'scene', key: this.sceneKey ?? null });
        this.select(this.getSelection());
        return;
      }
      if (message.type !== 'rpcRequest') {
        return;
      }
      const { reqId, method, params, scene } = message;
      try {
        const result = await this.request(method, params, scene ?? undefined);
        webviewView.webview.postMessage({ type: 'rpcResult', reqId, method, result });
        if (MUTATING.has(method)) {
          this.onMutation(scene ?? undefined);
        }
      } catch (err) {
        webviewView.webview.postMessage({
          type: 'rpcError',
          reqId,
          method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.page = undefined;
      this.ready = false;
      setTextFocus(false);
    });
  }

  select(objectId: string | undefined): void {
    if (this.view && this.ready) {
      this.view.webview.postMessage({ type: 'select', objectId });
    }
  }

  /** Show one construction step's own values above the object it acted on. */
  showOperation(eventId: string | undefined): void {
    if (this.view && this.ready) {
      this.view.webview.postMessage({ type: 'operation', eventId });
    }
  }

  /** External change (tree action, script tab, undo): re-pull values. */
  refresh(): void {
    if (this.view && this.ready) {
      this.view.webview.postMessage({ type: 'refresh' });
    }
  }

  /** Draw the page with the engine's view, unless it is drawn with it
   *  already: when the view is shown, and when the engine's view is another
   *  (an engine started, one in another interpreter, a package upgraded). */
  draw(): void {
    const webview = this.view?.webview;
    const packageView = this.packageView();
    if (!webview || !this.page || (packageView && this.page.shows(packageView))) {
      return;
    }
    this.ready = false;
    this.page.load(packageView, (view) =>
      view ? this.html(webview, view) : noticeHtml('What is selected shows here once the engine of its scene runs.'),
    );
  }

  private html(webview: vscode.Webview, packageView: PackageView): string {
    const nonce = webviewNonce();
    const styleUri = mediaUri(webview, this.extensionUri, 'inspector.css');
    const scriptUri = mediaUri(webview, this.extensionUri, 'inspector.mjs');
    // The panel itself is the engine's package's (`packageView`), with the
    // notebook widget's stylesheet, which dresses its rows.
    const panelUri = packageView.uri(webview, 'inspector.mjs');
    const widgetStyleUri = packageView.uri(webview, 'widget.css');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <link rel="stylesheet" href="${widgetStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body data-inspector="${panelUri}">
  <div id="panel"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /** The scene the view shows: named beside its title, and told to the page,
   *  whose requests then name it. */
  show(scene: { key: string; name: string } | undefined): void {
    this.scene = scene?.name;
    this.sceneKey = scene?.key;
    if (this.view) {
      this.view.description = scene?.name;
      if (this.ready) {
        this.view.webview.postMessage({ type: 'scene', key: scene?.key ?? null });
      }
    }
  }
}
