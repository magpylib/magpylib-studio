// The studio's 3D view: the notebook widget, the same view, controls and keys
// as a notebook cell and the script panel (docs/one-view.md), run against a
// model this panel holds and an editor that goes through the extension host.
//
// Through the host rather than straight to the engine, because an edit here is
// more than the edit: the host refreshes the Scene tree, the Inspector, the
// field view, the history and the script tab, marks the scene unsaved and
// writes the backup. So the view says what it did in the messages the host
// has always answered, and the host is left to do the rest.
const vscodeApi = acquireVsCodeApi();
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

// --- the model the widget runs against ---------------------------------------
// What anywidget hands a widget, held here. What the view sets and saves is
// the user's: a selection is told to the sidebar, and hiding is an edit in the
// studio -- saved and undoable -- so it is told to the host as one. What the
// host says is taken in without being told back.
const values = {
  payload: {},
  tree: [],
  selected: [],
  hidden: [],
  axes: true,
  theme: "auto",
  height: 400,
  frames: 1,
  duration: 5,
  repeat: false,
  editable: true,
  standalone: true, // no kernel to write an HTML export
  revision: 0,
  last_edit: {},
};
const listeners = {};
const emit = (event, value) =>
  (listeners[event] || []).forEach((listener) => listener(value));
/** Set what the host says, as a change the view hears but does not send. */
function take(key, value) {
  values[key] = value;
  emit(`change:${key}`, value);
}
const told = { selected: [], hidden: [] }; // what the host last heard from here
let inSidebar = null; // the object the sidebar shows

let previewTaken = null; // settles the pose the host has not yet answered
const model = {
  get: (key) => values[key],
  set: (key, value) => {
    values[key] = value;
    emit(`change:${key}`, value);
  },
  save_changes: tell,
  on: (event, listener) => (listeners[event] ||= []).push(listener),
  off() {},
  send(message) {
    if (message.kind === "frame") serveFrame(message);
  },
  // the Scene tree is the studio's legend; the widget's is a button away
  legendStartsClosed: true,
  // Tab walks the scene's objects, as it did in this panel
  tabWalks: true,
  editor: {
    // the host opens the undo group; the view's own readout says what a drag
    // takes away from a variable, so the host is not asked to say it again
    begin({ objectIds }) {
      vscodeApi.postMessage({ type: "dragStart", objectId: objectIds[0] });
      return Promise.resolve({ ok: true });
    },
    preview: (edits) =>
      new Promise((resolve) => {
        previewTaken = resolve;
        vscodeApi.postMessage({ type: "previewTransform", edits });
      }),
    // recorded and the group closed by the host, which says itself if the
    // engine refused it -- and redraws everything from what the engine has
    commit(edits) {
      vscodeApi.postMessage({ type: "transformObjects", edits });
      return Promise.resolve({ ok: true });
    },
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

/** What the view saved, told to whoever it is for. */
function tell() {
  const selected = values.selected || [];
  if (selected.join() !== told.selected.join()) {
    told.selected = selected;
    // The sidebar shows one object. A new first object is a pick to tell it;
    // adding to a selection keeps the one it shows.
    if (selected.length && selected[0] !== inSidebar) {
      inSidebar = selected[0];
      vscodeApi.postMessage({ type: "selectObject", objectId: inSidebar });
    }
  }
  const hidden = new Set(values.hidden || []);
  const was = new Set(told.hidden);
  const hide = [...hidden].filter((id) => !was.has(id));
  const show = [...was].filter((id) => !hidden.has(id));
  told.hidden = [...hidden];
  if (hide.length) {
    vscodeApi.postMessage({
      type: "setVisible",
      objectIds: hide,
      visible: false,
    });
  }
  if (show.length) {
    vscodeApi.postMessage({
      type: "setVisible",
      objectIds: show,
      visible: true,
    });
  }
}

/** A step of the run, asked of the engine as the view asks it of a kernel. */
async function serveFrame({ index, runId }) {
  try {
    const frame = await rpc("get_scene", { frame: index });
    if (frame.duration) values.duration = frame.duration;
    emit("msg:custom", { kind: "frame", ...frame, runId });
  } catch (error) {
    say(String(error.message || error));
  }
}

/** How many steps the paths have: what the transport is drawn for, until the
 *  first frame says how many magpylib composed. */
function framesOf(payload) {
  const steps = Object.values(payload.paths || {}).map(
    (path) => path.position.length,
  );
  return Math.max(1, ...steps);
}

function hiddenIn(tree, into = []) {
  for (const node of tree) {
    if (node.visible === false) into.push(node.id);
    hiddenIn(node.children || [], into);
  }
  return into;
}

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
  let payload;
  let tree;
  try {
    [payload, tree] = await Promise.all([
      rpc("get_scene", {}),
      rpc("object_tree", {}),
    ]);
  } catch (error) {
    // The engine cannot draw a scene graph -- an older magpylib, most likely,
    // without the display-backend API. The chart is what the panel drew before
    // any of this, so it falls back to that and says why.
    setMode(true);
    const text = String(error.message || error);
    say(text);
    vscodeApi.postMessage({ type: "notice", text });
    return;
  }
  if (charting()) return; // switched while the engine was answering
  const hidden = hiddenIn(tree);
  told.hidden = hidden;
  take("tree", tree);
  take("hidden", hidden);
  take("frames", framesOf(payload));
  take("payload", payload);
  say("");
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
    // the engine has the pose: the view redraws, then sends the next
    previewTaken?.();
    previewTaken = null;
  } else if (message.type === "select") {
    // the sidebar, or a pick told back: one object, and the set restarts
    inSidebar = message.objectId || null;
    const selected = inSidebar ? [inSidebar] : [];
    told.selected = selected;
    take("selected", selected);
  } else if (message.type === "refresh") {
    // after any edit anywhere: the Inspector, a chat tool, a slider, a drag
    refresh();
  }
});

// The widget fills the panel; its height is the model's, so it follows.
new ResizeObserver(() => {
  if (!viewEl.hidden && viewEl.clientHeight) {
    take("height", Math.max(240, viewEl.clientHeight - 2));
  }
}).observe(viewEl);

// Said, not swallowed: a view that did not load is an empty panel otherwise,
// with nothing to say why.
try {
  const widget = (await import(document.body.dataset.widget)).default;
  widget.render({ model, el: viewEl });
} catch (error) {
  const text = `The 3D view could not load: ${error?.message || error}`;
  say(text);
  vscodeApi.postMessage({ type: "notice", text });
}
// Ask for the selection already made: a panel opened (or restored) mid-session
// has missed every 'select' the host sent before it existed.
vscodeApi.postMessage({ type: "ready" });
refresh();
