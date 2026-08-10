// Selection and style editing live in the sidebar (Scene tree + Inspector);
// this panel is only the live 3D view.
const vscodeApi = acquireVsCodeApi();
const statusEl = document.getElementById("status");
const canvasEl = document.getElementById("canvas");
const animateEl = document.getElementById("animate");
const sceneGraphEl = document.getElementById("sceneGraph");
const fitEl = document.getElementById("fit");
const gizmoEl = document.getElementById("gizmo");
const gizmoLabelEl = document.getElementById("gizmoLabel");
const controlsEl = document.getElementById("controls");
const axesEl = document.getElementById("axes");
const axesLabelEl = document.getElementById("axesLabel");
let nextReqId = 1;
const pending = new Map();
let selectedId;
let patterned = new Set(); // sources whose copies would not follow an edit
let poseInFlight = false;
let pendingPose = null;
let dragging = null; // { objectId, keep } while a handle is held
let parametric = {}; // objectId -> which drag-written fields a variable decides

//: What each drag writes, which is what an expression deciding it loses to.
const DRAG_WRITES = {
  translate: "position",
  rotate: "orientation",
  scale: "shape",
  polarization: "polarization",
};

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const reqId = nextReqId++;
    pending.set(reqId, { resolve, reject });
    vscodeApi.postMessage({ type: "rpcRequest", reqId, method, params });
  });
}

/** Fitting and dragging belong to the scene graph; plotly has its own reset
 *  and nothing to drag. */
function showSceneGraphControls(shown) {
  fitEl.hidden = !shown;
  gizmoLabelEl.hidden = !shown;
  axesLabelEl.hidden = !shown;
  controlsEl.hidden = !shown;
}

function plotTemplate() {
  // VS Code stamps the theme kind on <body>; high-contrast-light is light.
  const cls = document.body.className;
  const dark =
    /vscode-dark|vscode-high-contrast/.test(cls) &&
    !cls.includes("vscode-high-contrast-light");
  return dark ? "plotly_dark" : "plotly_white";
}

async function refreshFigure() {
  // Preview: the same scene as buffers, drawn once and kept, rather than a
  // figure replaced on every edit. Plotly stays the default until this draws
  // everything the figure does.
  if (sceneGraphEl.checked) {
    if (!window.scene3d) {
      statusEl.textContent = "Scene graph unavailable (module failed to load)";
      return;
    }
    const payload = await rpc("get_scene", {});
    window.scene3d.render(canvasEl, payload); // owns its canvas; keeps the camera
    showSceneGraphControls(true);
    patterned = new Set(payload.patterned);
    parametric = payload.parametric || {};
    statusEl.textContent = `Ready — ${payload.meshes.length} meshes, ${payload.scatters.length} lines`;
    applyGizmo(); // the selection may have become (or stopped being) patterned
    showAxes();
    return;
  }
  const figure = await rpc("get_figure", {
    animation: animateEl.checked,
    template: plotTemplate(),
  });
  const layout = figure.layout || {};
  layout.uirevision = "magpylib-studio"; // hold camera across edits
  layout.autosize = true;
  layout.showlegend = false; // the Scene tree is the legend
  layout.margin = { l: 0, r: 0, t: 0, b: 0 };
  layout.paper_bgcolor = "rgba(0,0,0,0)"; // blend into the editor
  layout.scene = layout.scene || {};
  layout.scene.bgcolor = "rgba(0,0,0,0)";
  await Plotly.react(canvasEl, {
    data: figure.data,
    layout,
    frames: figure.frames || [],
    config: { responsive: true },
  });
  statusEl.textContent = "Ready";
}

/** Redraw for the newest state, never for a queue of stale ones.
 *
 * Refreshes arrive from everywhere -- an edit, a chat tool, a variable slider
 * being dragged -- and a big scene takes longer to rebuild than the debounce
 * that spaces them out. Without this they overlap, and two `get_scene` calls
 * in flight at once can be drawn in the order they come back rather than the
 * order they were asked for. Collapsed into one that runs after the current
 * redraw, the view always catches up to the newest state and never draws an
 * older one over it.
 */
let redrawing = false;
let redrawDue = false;
async function refreshPaced() {
  if (redrawing) {
    redrawDue = true;
    return;
  }
  redrawing = true;
  try {
    do {
      redrawDue = false;
      await refreshFigure();
    } while (redrawDue);
  } catch (err) {
    statusEl.textContent = String(err);
  } finally {
    redrawing = false;
  }
}

// Re-render when the user switches the VS Code color theme.
new MutationObserver(() => {
  refreshPaced();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

fitEl.addEventListener("click", () => {
  window.scene3d?.fitView();
});

// Clicking an object here selects it everywhere else: the host owns the
// selection, and answers with a 'select' message the highlight follows.
canvasEl.addEventListener("objectpick", (event) => {
  vscodeApi.postMessage({
    type: "selectObject",
    objectId: event.detail.objectId,
  });
});

// A drag is an edit like any other, so it goes to the host rather than
// straight down the RPC: only the host marks the scene dirty, refreshes the
// trees, and reports what the engine said.
//
// Mid-drag poses are paced by the round trip rather than by a timer: one is
// in flight at a time and the newest waiting pose wins, so the rate settles
// wherever the scene's cost puts it -- measured from 1.4 ms for two magnets
// to 180 ms for a thousand. Any fixed interval would be wrong at one end of
// that or the other, and a queue would only make the view lag further behind
// the pointer the longer the drag went on.
canvasEl.addEventListener("objecttransform", (event) => {
  if (event.detail.preview) {
    // Read out at pointer rate rather than at engine rate: the numbers are
    // already known here, and waiting for the round trip to show them would
    // make a fast drag on a heavy scene look like it had stopped responding.
    showPose(event.detail);
    pendingPose = event.detail;
    sendPose();
    return;
  }
  dragging = null;
  pendingPose = null; // the final pose supersedes anything still waiting
  vscodeApi.postMessage({ type: "transformObject", ...event.detail });
});

// Told at the start, so the edits the drag is about to make are grouped into
// one thing to undo, and so anything it will supersede can be said once --
// before the drag rather than after, which is when it stops being useful.
canvasEl.addEventListener("dragstart", (event) => {
  const { objectId, mode } = event.detail;
  // aiming polarization redraws the magnet's colours, so it keeps nothing
  dragging = { objectId, keep: mode === "polarization" ? null : objectId };
  vscodeApi.postMessage({
    type: "dragStart",
    objectId,
    field: DRAG_WRITES[mode],
    names: (parametric[objectId] || {})[DRAG_WRITES[mode]],
  });
});

/** How long building the scene may take before a drag stops waiting for it.
 *
 * Well under a frame at 60 Hz. Everything else a drag updates lives in
 * another webview and cannot slow the pointer down; this one runs here, so
 * it is the only thing that can make the gesture itself feel heavy. */
const REDRAW_BUDGET_MS = 8;

/** Redraw what the drag changed, except the object under the pointer.
 *
 * Moving a magnet moves more than the magnet: a field's arrows are computed
 * from it and have to be asked for again. This is the expensive half of the
 * round trip, so it runs *inside* the pacing loop rather than beside it --
 * the next pose is not sent until the scene it caused has been drawn, which
 * keeps a heavy scene sending fewer poses instead of falling behind.
 *
 * Pacing stops the work queueing up; it does not stop one slow redraw from
 * stuttering the drag it is meant to illustrate. So the first redraw of each
 * gesture is timed, and if building the scene costs more than a frame, the
 * rest of that drag goes without: the object under the pointer keeps up, the
 * field and the Inspector keep updating in their own webviews, and the scene
 * catches up when the drag ends. A big scene on a slow machine then loses
 * the thing that was never going to look right anyway, rather than the
 * smoothness of the gesture.
 */
async function redrawAroundDrag() {
  if (!sceneGraphEl.checked || !dragging || dragging.tooSlow) return;
  const payload = await rpc("get_scene", {});
  patterned = new Set(payload.patterned);
  // Timed around the render alone. The request before it is the engine's
  // time, not ours: it delays the next pose without blocking this one.
  const started = performance.now();
  window.scene3d?.render(canvasEl, payload, { keep: dragging.keep });
  dragging.tooSlow = performance.now() - started > REDRAW_BUDGET_MS;
}

/** The pose being dragged, in the status bar. It sits last in the bar, so a
 *  number growing a digit moves nothing but itself. */
function showPose(pose) {
  const numbers = (values) =>
    values.map((n) => (Math.abs(n) < 1e-12 ? "0" : Number(n.toPrecision(4)))).join(", ");
  const parts = [];
  if (pose.position) parts.push(`position ${numbers(pose.position)} m`);
  if (pose.orientation) parts.push(`rotation ${numbers(pose.orientation)}°`);
  if (pose.polarization) parts.push(`polarization ${numbers(pose.polarization)} T`);
  if (pose.shape) {
    const value = pose.shape.value;
    parts.push(`${pose.shape.attr} ${numbers([].concat(value))} m`);
  }
  statusEl.textContent = `${pose.objectId} — ${parts.join("   ")}`;
}

function sendPose() {
  if (poseInFlight || !pendingPose) return;
  poseInFlight = true;
  const pose = pendingPose;
  pendingPose = null;
  vscodeApi.postMessage({ type: "previewTransform", ...pose });
}

/** Show the handles, unless the selected object is one a drag cannot honour.
 *
 * A pattern's copies are drawn on their source's node, so the ring is one
 * object to click -- but an edit to the source is recorded after the
 * duplication that made the copies, so dragging it would move one magnet out
 * of the ring and leave the rest. Better to say so than to do it.
 */
function applyGizmo() {
  const blocked = patterned.has(selectedId);
  gizmoEl.disabled = blocked;
  const wanted = blocked ? "none" : gizmoEl.value;
  const inEffect = window.scene3d?.setGizmoMode(wanted);
  if (blocked) {
    statusEl.textContent = `${selectedId} is patterned — dragging it would leave its copies behind`;
  } else if (inEffect !== wanted) {
    // asked to resize something with no size to drag
    gizmoEl.value = inEffect;
    statusEl.textContent = selectedId
      ? `${selectedId} has no single dimension to drag — resize it in the Inspector`
      : "Select an object to resize";
  }
}

/** Show the axes the mode in force actually drags along.
 *
 * Each mode keeps its own choice rather than sharing one, because the right
 * answer differs -- positioning is world work, a polarization is stored in
 * the object's frame -- and a shared setting would silently be wrong for one
 * of them. Nothing is hidden by that, because the control always reads out
 * the mode it is showing. A resize has no choice at all: a dimension only
 * means anything along the object's own axes.
 */
function showAxes() {
  axesEl.value = window.scene3d?.spaceOf() || "world";
  axesEl.disabled = gizmoEl.value === "scale" || gizmoEl.disabled;
}

gizmoEl.addEventListener("change", () => {
  applyGizmo();
  showAxes();
});

axesEl.addEventListener("change", () => {
  window.scene3d?.setSpace(axesEl.value);
  showAxes();
});

// The shortcuts the rest of the 3D world uses. They stay out of the way of
// typing: the panel has no text input, but a <select> with focus does.
const GIZMO_KEYS = {
  w: "translate",
  e: "rotate",
  r: "scale",
  p: "polarization",
  q: "none",
};
const AXIS_VIEWS = { 1: [0, -1, 0], 3: [1, 0, 0], 7: [0, 0, 1] }; // front, right, top

window.addEventListener("keydown", (event) => {
  if (!sceneGraphEl.checked || event.target !== document.body) return;
  const key = event.key.toLowerCase();
  const scene3d = window.scene3d;
  if (GIZMO_KEYS[key]) {
    if (gizmoEl.disabled) return;
    gizmoEl.value = GIZMO_KEYS[key];
    applyGizmo();
  } else if ("xyz".includes(key)) {
    scene3d?.constrainAxis(key);
    statusEl.textContent = `Dragging along ${key.toUpperCase()} only — A for all axes`;
  } else if (key === "a") {
    scene3d?.constrainAxis(null);
    statusEl.textContent = "Dragging along all axes";
  } else if (key === "l") {
    const space = scene3d?.toggleSpace();
    showAxes();
    statusEl.textContent = `Handles follow the ${
      space === "local" ? "object's own" : "world"
    } axes`;
  } else if (key === "h") {
    // the host owns visibility and knows the current state; hidden objects
    // are not drawn, so showing one again is the Scene tree's job
    if (selectedId) vscodeApi.postMessage({ type: "toggleVisible", objectId: selectedId });
  } else if (key === "f") {
    scene3d?.fitView(selectedId); // undefined when nothing is selected: fits all
  } else if (event.key === "Home") {
    scene3d?.fitView();
  } else if (AXIS_VIEWS[event.key]) {
    scene3d?.axisView(...AXIS_VIEWS[event.key]);
  }
});

sceneGraphEl.addEventListener("change", () => {
  showSceneGraphControls(sceneGraphEl.checked);
  canvasEl.innerHTML = ""; // the two renderers do not share a canvas
  statusEl.textContent = "Loading…";
  refreshPaced();
});

animateEl.addEventListener("change", () => {
  statusEl.textContent = "Loading…";
  refreshPaced();
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "rpcResult" || message.type === "rpcError") {
    const entry = pending.get(message.reqId);
    if (!entry) return;
    pending.delete(message.reqId);
    if (message.type === "rpcResult") entry.resolve(message.result);
    else entry.reject(new Error(message.method + ": " + message.error));
  } else if (message.type === "previewDone") {
    redrawAroundDrag()
      .catch(() => {}) // a failed redraw must not end the drag
      .finally(() => {
        poseInFlight = false;
        sendPose(); // whatever the pointer reached while that one was away
      });
  } else if (message.type === "select") {
    selectedId = message.objectId;
    window.scene3d?.highlight(selectedId);
    applyGizmo();
  } else if (message.type === "refresh") {
    // Pushed by the host after any edit (inspector, chat tool, tree, a
    // variable slider being dragged) — the one that can arrive fastest.
    refreshPaced();
  }
});

window.addEventListener("resize", () => {
  // scene3d watches the canvas itself; Plotly needs telling
  if (!sceneGraphEl.checked && canvasEl.data) Plotly.Plots.resize(canvasEl);
});

// Ask for the selection that was already made: a panel opened (or restored)
// mid-session has missed every 'select' the host sent before it existed.
vscodeApi.postMessage({ type: "ready" });

refreshPaced();
