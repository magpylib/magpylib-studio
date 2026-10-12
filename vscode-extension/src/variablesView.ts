import * as vscode from 'vscode';

import { setTextFocus, tookTextFocus } from './textFocus';
import { mediaUri, nonce as webviewNonce } from './webview';

/** Calls from this panel that change the scene, not just what it displays. */
const MUTATING = new Set([
  'set_variable',
  'set_variable_bounds',
  'set_variable_unit',
  'remove_variable',
  'restore_variable',
  'use_variant',
]);

export interface VariableBounds {
  /** Hard limits: the engine rejects a value outside them. */
  min?: number;
  max?: number;
  /** Soft limits: the range worth dragging through; outside stays legal. */
  soft_min?: number;
  soft_max?: number;
  /** This variable counts things, so only whole values are legal. */
  integer?: boolean;
  /** The values it may take, for a variable that is a choice rather than a
   *  quantity — a rotation axis, a mirror plane. Mutually exclusive with a
   *  range in practice: a name has no min. */
  options?: (string | number)[];
  /** What it measures — length, angle, field, current, dimensionless. Not a
   *  limit, and not part of the value, which stays SI: what the panel shows
   *  it in. */
  unit?: string;
}

/** How a view shows a value of a variable that says what it measures: in
 *  `symbol`, `scale` of them to one of the document's. */
export interface Shown {
  symbol: string;
  scale: number;
}

export interface Variable {
  name: string;
  /** As written: a number, or an "=expr" over the other variables. */
  expression: number | string;
  /** As resolved at the last build. */
  value: number | null;
  bounds?: VariableBounds;
  /** Present when the variable says what it measures. */
  shown?: Shown;
}

/** The range a slider should span: soft limits if given, else the hard ones. */
export function sliderRange(bounds?: VariableBounds): [number, number] | undefined {
  if (!bounds) {
    return undefined;
  }
  const low = bounds.soft_min ?? bounds.min;
  const high = bounds.soft_max ?? bounds.max;
  return low === undefined || high === undefined || low >= high
    ? undefined
    : [low, high];
}

/**
 * The scene's variables, as a webview rather than a tree.
 *
 * A TreeItem can hold a label and an icon and nothing else, and the point of
 * bounding a variable is to be able to *drag* it — so the panel that shows the
 * variables has to be one that can hold a slider. The cost is that per-row
 * actions are buttons in the row instead of a context menu; the view's title
 * bar still carries New Variable… and Sweep…
 *
 * The rows are the package's (`magpylib_studio/static/variables.mjs`): the
 * notebook widget floats the same panel over its view, and `media/variables.mjs`
 * mounts it here with its calls routed through this provider.
 */
export class VariablesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'magpylib-studio.variablesView';

  private view: vscode.WebviewView | undefined;
  /** The scene the view shows, beside its title, and its key. */
  private scene: string | undefined;
  private sceneKey: string | undefined;
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** `scene` is the key of the scene the page was drawn for, which the
     *  request goes to; the callbacks after it are told it too. */
    private readonly request: (
      method: string,
      params: Record<string, unknown> | undefined,
      scene: string | undefined,
    ) => Promise<unknown>,
    private readonly onAction: (action: string, name: string, scene: string | undefined) => void,
    private readonly onMutation: (scene: string | undefined) => void,
    /** A value the pointer is still on. Separate from `onMutation` because a
     *  gesture in progress wants the views that show it live and nothing
     *  else: the document is not settled until the thumb is released. */
    private readonly onPreview: (scene: string | undefined) => void,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.description = this.scene;
    this.ready = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (tookTextFocus(message, webviewView.webview)) {
        return;
      }
      if (message.type === 'ready') {
        this.ready = true;
        webviewView.webview.postMessage({ type: 'scene', key: this.sceneKey ?? null });
        this.refresh();
        webviewView.webview.postMessage({ type: 'help' });
        return;
      }
      if (message.type === 'action') {
        this.onAction(message.action, message.name, message.scene ?? undefined);
        return;
      }
      if (message.type !== 'rpcRequest') {
        return;
      }
      const { reqId, method, params, preview, scene } = message;
      try {
        const result = await this.request(method, params, scene ?? undefined);
        // Answering first is what paces a drag: the panel holds the next
        // value until this one is back, so a scene that is slow to rebuild
        // gets asked for fewer of them rather than falling further behind.
        webviewView.webview.postMessage({ type: 'rpcResult', reqId, method, result });
        // A call that found the scene already as asked -- a variant whose
        // values hold -- edited nothing, and marking the file unsaved for it
        // would be a lie.
        const unchanged = (result as { unchanged?: boolean } | null)?.unchanged === true;
        if (MUTATING.has(method) && !unchanged) {
          // Either way it moves everything written in terms of the variable —
          // which is the whole point, and none of it is on this panel. What
          // differs is how much of the studio is worth bringing with it.
          if (preview) {
            this.onPreview(scene ?? undefined);
          } else {
            this.onMutation(scene ?? undefined);
          }
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
      this.ready = false;
      setTextFocus(false);
    });
  }

  refresh(): void {
    if (this.view && this.ready) {
      this.view.webview.postMessage({ type: 'refresh' });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = webviewNonce();
    const styleUri = mediaUri(webview, this.extensionUri, 'variables.css');
    const scriptUri = mediaUri(webview, this.extensionUri, 'variables.mjs');
    // The panel itself is the package's, copied beside media/ by `npm run
    // compile` (harness/copy-widget.js) with the notebook widget's bundle,
    // whose stylesheet dresses its rows.
    const widgetDir = vscode.Uri.joinPath(this.extensionUri, 'widget');
    const panelUri = webview.asWebviewUri(vscode.Uri.joinPath(widgetDir, 'variables.mjs'));
    const widgetStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(widgetDir, 'widget.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <link rel="stylesheet" href="${widgetStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body data-variables="${panelUri}">
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
