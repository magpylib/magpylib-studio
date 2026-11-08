// The studio's 3D view: the notebook widget, the same view, controls and keys
// as a notebook cell and the script panel (docs/decisions.md#0011-one-view), run against a
// model the package holds for a host (`magpylib_studio/static/host.mjs`,
// loaded from the engine's package: decision 0057) and an editor that goes
// through the extension host. What is here is what only this panel can do: its
// messages to the host, and the read-only chart.
//
// Through the host rather than straight to the engine, because an edit here is
// more than the edit: the host refreshes the Scene tree, the Inspector, the
// field view, the history and the script tab, marks the scene unsaved and
// writes the backup. So the view says what it did in the messages the host
// has always answered, and the host is left to do the rest.
import { watchTextFocus } from "./textFocus.mjs";

const vscodeApi = acquireVsCodeApi();
watchTextFocus((focused) =>
  vscodeApi.postMessage({ type: "textFocus", focused }),
);
const viewEl = document.getElementById("view");
const chartEl = document.getElementById("chart");
const modeEditEl = document.getElementById("modeEdit");
const modeChartEl = document.getElementById("modeChart");
const animateEl = document.getElementById("animate");
const statusEl = document.getElementById("status");

let nextReqId = 1;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const reqId = nextReqId++;
    pending.set(reqId, { resolve, reject });
    vscodeApi.postMessage({ type: "rpcRequest", reqId, method, params });
  });
}

/** Say something in the bar -- in the tooltip too, since the bar gives up its
 *  width first when the panel is narrow. */
function say(text) {
  statusEl.textContent = text;
  statusEl.title = text;
}

// --- what the package's view asks of this panel --------------------------------
let previewTaken = null; // settles the pose the host has not yet answered

const host = {
  rpc,
  say,
  select: (objectId) =>
    vscodeApi.postMessage({ type: "selectObject", objectId }),
  // One message, so one step to undo.
  setVisible: (hide, show) =>
    vscodeApi.postMessage({ type: "setVisible", hide, show }),
  setFieldLines: (on) => vscodeApi.postMessage({ type: "setFieldLines", on }),
  useVariant: (name) => vscodeApi.postMessage({ type: "useVariant", name }),
  editor: {
    // the host opens the undo group; the view's own readout says what a drag
    // takes away from a variable, so the host is not asked to say it again
    begin({ objectIds }) {
      vscodeApi.postMessage({ type: "dragStart", objectId: objectIds[0] });
      return Promise.resolve({ ok: true });
    },
    // the host answers with the scene the pose made, when the drag will draw
    // it: one trip through the host for a step, not one for the pose and
    // another for the scene
    preview: (edits, { scene = true } = {}) =>
      new Promise((resolve) => {
        previewTaken = resolve;
        vscodeApi.postMessage({ type: "previewTransform", edits, scene });
      }),
    // recorded and the group closed by the host, which says itself if the
    // engine refused it -- and redraws everything from what the engine has
    commit(edits, { define = false } = {}) {
      vscodeApi.postMessage({ type: "transformObjects", edits, define });
      return Promise.resolve({ ok: true });
    },
    // Esc in a drag: the host closes the group, then undoes it, in turn --
    // two messages could cross, and the undo find the group still open
    cancel() {
      vscodeApi.postMessage({ type: "cancelDrag" });
      return Promise.resolve({ ok: true });
    },
    // typed text as a number of `kind`, read by the engine as the sidebar's
    // boxes are read
    quantity: (text, kind) => rpc("quantity", { name: "", text, unit: kind }),
    scene: () => rpc("get_scene", {}),
    undo() {
      vscodeApi.postMessage({ type: "undo" });
      return Promise.resolve({ ok: true });
    },
    redo() {
      vscodeApi.postMessage({ type: "redo" });
      return Promise.resolve({ ok: true });
    },
    // VS Code runs its own keybinding on Cmd/Ctrl+Z here
    undoKeys: false,
  },
};

/** The package's view, once it has loaded; a pick told before is kept. */
let view = null;
let pickedEarly;

// --- keeping up with the engine ------------------------------------------------
/** Redraw for the newest state, never for a queue of stale ones: refreshes
 *  arrive from everywhere, and a big scene takes longer to rebuild than the
 *  gap between them. */
let redrawing = false;
let redrawDue = false;
async function refresh() {
  if (redrawing) {
    redrawDue = true;
    return;
  }
  redrawing = true;
  try {
    do {
      redrawDue = false;
      await (charting() ? drawChart() : drawScene());
    } while (redrawDue);
  } catch (error) {
    say(String(error.message || error));
  } finally {
    redrawing = false;
  }
}

async function drawScene() {
  if (!view) return; // not loaded: it said why
  await view.load(() => !charting()); // switched while the engine was answering
  if (!charting()) say("");
}

// --- the chart ----------------------------------------------------------------
// Read only, and the panel's rather than the widget's: Plotly draws the scene
// from a figure magpylib composes, which is still the one way to ask whether
// the scene graph draws it right.
const charting = () => modeChartEl.classList.contains("on");

function plotTemplate() {
  const cls = document.body.className;
  const dark =
    /vscode-dark|vscode-high-contrast/.test(cls) &&
    !cls.includes("vscode-high-contrast-light");
  return dark ? "plotly_dark" : "plotly_white";
}

async function drawChart() {
  const figure = await rpc("get_figure", {
    animation: animateEl.classList.contains("on"),
    template: plotTemplate(),
  });
  if (!charting()) return;
  const layout = figure.layout || {};
  layout.uirevision = "magpylib-studio"; // the camera held across edits
  layout.autosize = true;
  layout.showlegend = false; // the Scene tree is the legend
  layout.margin = { l: 0, r: 0, t: 0, b: 0 };
  layout.paper_bgcolor = "rgba(0,0,0,0)";
  layout.scene = { ...(layout.scene || {}), bgcolor: "rgba(0,0,0,0)" };
  await Plotly.react(chartEl, {
    data: figure.data,
    layout,
    frames: figure.frames || [],
    config: { responsive: true },
  });
  say(
    animateEl.classList.contains("on")
      ? "Read only — Plotly's own transport runs the paths"
      : "Read only — switch to Edit to pick and drag",
  );
}

function setMode(chart) {
  if (chart === charting()) return;
  modeEditEl.classList.toggle("on", !chart);
  modeChartEl.classList.toggle("on", chart);
  viewEl.hidden = chart;
  chartEl.hidden = !chart;
  animateEl.hidden = !chart;
  // Plotly keeps its state on the element: purged, or the next chart diffs
  // against one that is no longer there and draws nothing.
  if (!chart) Plotly.purge(chartEl);
  say("Loading…");
  refresh();
}

modeEditEl.addEventListener("click", () => setMode(false));
modeChartEl.addEventListener("click", () => setMode(true));
// Off by default: the frames are baked into the figure, which for the quiver
// example is 14 MB and a second of work, paid again on every redraw.
animateEl.addEventListener("click", () => {
  animateEl.classList.toggle("on");
  refresh();
});

// The chart holds the colours it was given; the widget follows the theme itself.
new MutationObserver(() => {
  if (charting()) refresh();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// --- the host -------------------------------------------------------------------
window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "rpcResult" || message.type === "rpcError") {
    const entry = pending.get(message.reqId);
    if (!entry) return;
    pending.delete(message.reqId);
    if (message.type === "rpcResult") entry.resolve(message.result);
    else entry.reject(new Error(message.method + ": " + message.error));
  } else if (message.type === "previewDone") {
    // the engine has the pose, and the scene it made when that was asked
    // for: the view redraws, then sends the next
    previewTaken?.(message.scene ? { scene: message.scene } : undefined);
    previewTaken = null;
  } else if (message.type === "select") {
    // the sidebar, or a pick told back
    if (view) view.select(message.objectId);
    else pickedEarly = message.objectId;
  } else if (message.type === "refresh") {
    // after any edit anywhere: the Inspector, the tree, a slider, a drag
    refresh();
  }
});

// The widget fills the panel; its height is the model's, so it follows.
new ResizeObserver(() => {
  if (view && !viewEl.hidden && viewEl.clientHeight) {
    view.resize(Math.max(240, viewEl.clientHeight - 2));
  }
}).observe(viewEl);

// Said, not swallowed: a view that did not load is an empty panel otherwise,
// with nothing to say why.
try {
  const { mountWidget } = await import(document.body.dataset.host);
  view = mountWidget(viewEl, host);
  if (viewEl.clientHeight) view.resize(Math.max(240, viewEl.clientHeight - 2));
  if (pickedEarly !== undefined) view.select(pickedEarly);
} catch (error) {
  const text = `The 3D view could not load: ${error?.message || error}`;
  say(text);
  vscodeApi.postMessage({ type: "notice", text });
}
// Ask for the selection already made: a panel opened (or restored) mid-session
// has missed every 'select' the host sent before it existed.
vscodeApi.postMessage({ type: "ready" });
refresh();
