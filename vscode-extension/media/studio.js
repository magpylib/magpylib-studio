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
    statusEl.textContent = `Ready — ${payload.meshes.length} meshes, ${payload.scatters.length} lines`;
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

// A finished drag is an edit like any other, so it goes to the host rather
// than straight down the RPC: only the host marks the scene dirty, refreshes
// the trees, and reports what the engine said.
canvasEl.addEventListener("objecttransform", (event) => {
  vscodeApi.postMessage({ type: "transformObject", ...event.detail });
});

const setGizmo = (mode) => {
  gizmoEl.value = mode;
  window.scene3d?.setGizmoMode(mode);
};

gizmoEl.addEventListener("change", () => setGizmo(gizmoEl.value));

// The shortcuts the rest of the 3D world uses. They stay out of the way of
// typing: the panel has no text input, but a <select> with focus does.
window.addEventListener("keydown", (event) => {
  if (!sceneGraphEl.checked || event.target !== document.body) return;
  const mode = { w: "translate", e: "rotate", q: "none" }[event.key.toLowerCase()];
  if (mode) setGizmo(mode);
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
  } else if (message.type === "select") {
    window.scene3d?.highlight(message.objectId);
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
