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
let nextReqId = 1;
const pending = new Map();
let selectedId;
let patterned = new Set(); // sources whose copies would not follow an edit
let poseInFlight = false;
let pendingPose = null;
let draggingId = null; // the object the pointer owns until it lets go

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
    statusEl.textContent = `Ready — ${payload.meshes.length} meshes, ${payload.scatters.length} lines`;
    applyGizmo(); // the selection may have become (or stopped being) patterned
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

// Re-render when the user switches the VS Code color theme.
new MutationObserver(() => {
  refreshFigure().catch((err) => {
    statusEl.textContent = String(err);
  });
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
    draggingId = event.detail.objectId;
    pendingPose = event.detail;
    sendPose();
    return;
  }
  draggingId = null;
  pendingPose = null; // the final pose supersedes anything still waiting
  vscodeApi.postMessage({ type: "transformObject", ...event.detail });
});

/** Redraw what the drag changed, except the object under the pointer.
 *
 * Moving a magnet moves more than the magnet: a field's arrows are computed
 * from it and have to be asked for again. This is the expensive half of the
 * round trip, so it runs *inside* the pacing loop rather than beside it --
 * the next pose is not sent until the scene it caused has been drawn, which
 * is what keeps a heavy scene sending fewer poses instead of falling behind.
 */
async function redrawAroundDrag() {
  if (!sceneGraphEl.checked || !draggingId) return;
  const payload = await rpc("get_scene", {});
  patterned = new Set(payload.patterned);
  window.scene3d?.render(canvasEl, payload, { keep: draggingId });
}

/** The pose being dragged, in the status bar. It sits last in the bar, so a
 *  number growing a digit moves nothing but itself. */
function showPose(pose) {
  const numbers = (values) =>
    values.map((n) => (Math.abs(n) < 1e-12 ? "0" : Number(n.toPrecision(4)))).join(", ");
  const parts = [];
  if (pose.position) parts.push(`position ${numbers(pose.position)} m`);
  if (pose.orientation) parts.push(`rotation ${numbers(pose.orientation)}°`);
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
  window.scene3d?.setGizmoMode(blocked ? "none" : gizmoEl.value);
  if (blocked) {
    statusEl.textContent = `${selectedId} is patterned — dragging it would leave its copies behind`;
  }
}

gizmoEl.addEventListener("change", applyGizmo);

// The shortcuts the rest of the 3D world uses. They stay out of the way of
// typing: the panel has no text input, but a <select> with focus does.
window.addEventListener("keydown", (event) => {
  if (!sceneGraphEl.checked || event.target !== document.body) return;
  const mode = { w: "translate", e: "rotate", q: "none" }[event.key.toLowerCase()];
  if (!mode || gizmoEl.disabled) return;
  gizmoEl.value = mode;
  applyGizmo();
});

sceneGraphEl.addEventListener("change", () => {
  showSceneGraphControls(sceneGraphEl.checked);
  canvasEl.innerHTML = ""; // the two renderers do not share a canvas
  statusEl.textContent = "Loading…";
  refreshFigure().catch((err) => {
    statusEl.textContent = String(err);
  });
});

animateEl.addEventListener("change", () => {
  statusEl.textContent = "Loading…";
  refreshFigure().catch((err) => {
    statusEl.textContent = String(err);
  });
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
    // Pushed by the host after any edit (inspector, chat tool, tree).
    refreshFigure().catch((err) => {
      statusEl.textContent = String(err);
    });
  }
});

window.addEventListener("resize", () => {
  // scene3d watches the canvas itself; Plotly needs telling
  if (!sceneGraphEl.checked && canvasEl.data) Plotly.Plots.resize(canvasEl);
});

// Ask for the selection that was already made: a panel opened (or restored)
// mid-session has missed every 'select' the host sent before it existed.
vscodeApi.postMessage({ type: "ready" });

refreshFigure().catch((err) => {
  statusEl.textContent = "Engine failed: " + err;
});
