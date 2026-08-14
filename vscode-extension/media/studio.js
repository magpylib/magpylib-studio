// Selection and style editing live in the sidebar (Scene tree + Inspector);
// this panel is only the live 3D view.
const vscodeApi = acquireVsCodeApi();
const statusEl = document.getElementById("status");
const canvasEl = document.getElementById("canvas");
const modeEditEl = document.getElementById("modeEdit");
const modeChartEl = document.getElementById("modeChart");

/** Whether the editable view is drawing.
 *
 * The two are named for what they let you do, not for the library behind
 * them: the chart's defining property, from here, is that it cannot be
 * picked or dragged. It stays on offer because it is the only way to answer
 * "is this drawing right?", which has had a real answer several times.
 */
function drawingScene() {
  return modeEditEl.classList.contains("on");
}

function setMode(editing) {
  if (editing === drawingScene()) return;
  show("");
  modeEditEl.classList.toggle("on", editing);
  modeChartEl.classList.toggle("on", !editing);
  showSceneGraphControls(editing);
  canvasEl.innerHTML = ""; // the two renderers do not share a canvas
  say("Loading…");
  refreshPaced();
}

modeEditEl.addEventListener("click", () => setMode(true));
modeChartEl.addEventListener("click", () => setMode(false));
const fitEl = document.getElementById("fit");
const playEl = document.getElementById("play");
const frameEl = document.getElementById("frame");
const gizmoEl = document.getElementById("gizmo");
const gizmoLabelEl = document.getElementById("gizmoLabel");
const controlsEl = document.getElementById("controls");
const axisEl = document.getElementById("axis");
const snapEl = document.getElementById("snap");
const projectionEl = document.getElementById("projection");
const selectionEl = document.getElementById("selection");
const readoutEl = document.getElementById("readout");
const axesEl = document.getElementById("axes");
const axesLabelEl = document.getElementById("axesLabel");
let nextReqId = 1;
const pending = new Map();
let selectedIds = []; // the sidebar shows the first; a drag carries all
let patterned = new Set(); // sources whose copies would not follow an edit
let poseInFlight = false;
let pendingPose = null;
let dragging = null; // { objectId, keep } while a handle is held
let parametric = {}; // objectId -> which drag-written fields a variable decides
let snapping = false;

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
  for (const el of [fitEl, axisEl, snapEl, projectionEl]) el.hidden = !shown;
  selectionEl.hidden = !shown || selectedIds.length < 2;
  if (!shown) {
    playEl.hidden = true; // put back by the next scene that has one
    frameEl.hidden = true;
  }
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
  if (drawingScene()) {
    if (!window.scene3d) {
      say("Scene graph unavailable (module failed to load)");
      return;
    }
    const payload = await rpc("get_scene", {});
    window.scene3d.render(canvasEl, payload); // owns its canvas; keeps the camera
    showSceneGraphControls(true);
    patterned = new Set(payload.patterned);
    parametric = payload.parametric || {};
    say(`Ready — ${payload.meshes.length} meshes, ${payload.scatters.length} lines`);
    applyGizmo(); // the selection may have become (or stopped being) patterned
    showAxes();
    // Whether there is anything to play is a question the paths answer; how
    // many frames there are is not. Magpylib composes the run, and past a
    // point it subsamples, so the count comes back with the first frame.
    const steps = window.scene3d.frameCount();
    playEl.hidden = steps < 2;
    frameEl.hidden = steps < 2;
    // A range to drag before anything has been fetched. The paths say how
    // many steps there are, which is what the scrubber is for; how many
    // frames magpylib actually composed only comes back with the first one,
    // and corrects this then.
    frameEl.max = String(Math.max(1, steps - 1));
    // At the end, because that is where the scene is: a path is drawn at its
    // last position, so a scrubber sitting at zero would be pointing at a
    // frame nothing on screen is showing.
    frameEl.value = frameEl.max;
    return;
  }
  // Plotly draws no handles and cannot be picked, so it has no animation
  // worth asking for either: the scene graph runs the paths now.
  const figure = await rpc("get_figure", { template: plotTemplate() });
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
  say("Read only — switch to Edit to pick and drag");
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
    say(String(err));
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

playEl.addEventListener("click", playPause);
frameEl.addEventListener("input", () => {
  if (playing) {
    playing = window.scene3d.setPlaying(false); // scrubbing takes over
    playEl.textContent = "\u25b6 Play";
  }
  showFrame(Number(frameEl.value));
});

/** Run the paths, or stop.
 *
 * The panel drives this rather than the renderer, because a frame is a
 * request: what a pose cannot express -- a sensor's arrows, read off the
 * field -- only python can say, and only per frame. The run is captured once
 * on the first frame asked for and served from there after, so the first
 * press is slow and the rest are not.
 */
let playing = false;
let frameInFlight = false;
let wantedFrame = 0;
let playStartedAt = 0;

function playPause() {
  if ((window.scene3d?.frameCount() ?? 1) < 2) {
    say("Nothing here has a path to play");
    return;
  }
  playing = window.scene3d.setPlaying(!playing);
  playEl.textContent = playing ? "\u23f8 Pause" : "\u25b6 Play";
  // pressing play at the end of the run starts it over rather than finishing
  // immediately, which is what the scrubber leaves it at
  if (playing && Number(frameEl.value) >= Number(frameEl.max)) {
    frameEl.value = "0";
  }
  if (playing) {
    say("Capturing the run\u2026"); // the first one is slow
    show("");
    playStartedAt = 0; // set from the first frame, once its timing is known
    showFrame(Number(frameEl.value));
  }
}

/** Draw one frame, and take the next from the clock.
 *
 * A run lasts what magpylib says it lasts -- `animation.time`, five seconds
 * by default -- however many steps it has, so the frame to show is whichever
 * one that many seconds is *up to* rather than simply the next one. A scene
 * whose frames are slow drops some and still finishes on time, which is what
 * an animation does; asking for every one in turn would instead stretch a
 * five second sweep into however long the engine took.
 */
async function showFrame(index) {
  // Latest wins, as everywhere else here: a scrub moves the slider far
  // faster than frames come back, and the one worth drawing is where the
  // pointer is now, not each place it passed through.
  wantedFrame = index;
  if (frameInFlight) return;
  frameInFlight = true;
  index = wantedFrame;
  let payload = null;
  try {
    payload = await rpc("get_scene", { frame: index });
    window.scene3d.renderFrame(payload);
    frameEl.max = String(payload.frames - 1);
    frameEl.value = String(payload.frame);
    show(
      `${playing ? "Playing" : "Frame"} ${String(payload.frame + 1).padStart(
        String(payload.frames).length,
      )} of ${payload.frames}`,
    );
  } catch (err) {
    playing = false;
    say(String(err));
  } finally {
    frameInFlight = false;
  }
  if (wantedFrame !== index) {
    showFrame(wantedFrame); // the pointer moved on while that one was away
    return;
  }
  if (!playing || !payload) return;

  const perFrame = (payload.duration * 1000) / payload.frames;
  if (!playStartedAt) playStartedAt = performance.now() - payload.frame * perFrame;
  const due = playStartedAt + (payload.frame + 1) * perFrame;
  setTimeout(
    () => {
      if (!playing) return;
      const elapsed = performance.now() - playStartedAt;
      showFrame(Math.floor(elapsed / perFrame) % payload.frames);
    },
    Math.max(0, due - performance.now()),
  );
}

// Clicking an object here selects it everywhere else: the host owns the
// selection, and answers with a 'select' message the highlight follows.
canvasEl.addEventListener("objectpick", (event) => {
  const { objectId, adding } = event.detail;
  if (adding) {
    // The sidebar shows one object, so the first of the set stays the one it
    // shows: adding to a selection here must not change what the Inspector
    // is looking at, or every extra click would move it.
    selectedIds = selectedIds.includes(objectId)
      ? selectedIds.filter((id) => id !== objectId)
      : [...selectedIds, objectId];
    window.scene3d?.highlight(selectedIds);
    showSelection();
    return;
  }
  vscodeApi.postMessage({ type: "selectObject", objectId });
});

/** How many are selected, since the sidebar can only show the one. */
function showSelection() {
  selectionEl.hidden = selectedIds.length < 2;
  selectionEl.textContent = `${selectedIds.length} selected`;
  selectionEl.title = "Dragging moves them together (\u2318 click to add)";
}

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
// A drag and a running path are two things moving the same object. The
// playback yields, since the pointer is the one being asked.
canvasEl.addEventListener("dragstart", (event) => {
  if (playing) playPause();
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
  if (!drawingScene() || !dragging || dragging.tooSlow) return;
  const payload = await rpc("get_scene", {});
  patterned = new Set(payload.patterned);
  // Timed around the render alone. The request before it is the engine's
  // time, not ours: it delays the next pose without blocking this one.
  const started = performance.now();
  window.scene3d?.render(canvasEl, payload, { keep: dragging.keep });
  dragging.tooSlow = performance.now() - started > REDRAW_BUDGET_MS;
}

/** The pose being dragged, over the view rather than in the bar.
 *
 * These change every pointer move, and the bar is also carrying progress and
 * errors and whether the scene loaded -- one line cannot do both. Here they
 * sit beside the thing they describe.
 */
function showPose(pose) {
  const edit = pose.edits[0];
  const extra = pose.edits.length > 1 ? `  (+${pose.edits.length - 1} more)` : "";
  // A fixed number of decimals, not significant figures. Significant figures
  // change the *length* of the string as a value crosses a scale -- 0.1 to
  // 0.09999 is four characters wider -- and at pointer rate that reads as a
  // twitch. The digits themselves are held to one width by the stylesheet.
  // Padded to a fixed width as well, so a sign appearing or a value crossing
  // ten does not shuffle everything after it either. The stylesheet keeps the
  // padding (`white-space: pre`), which also restores the wider gaps below.
  const numbers = (values, decimals, width) =>
    values
      .map((n) => (Math.abs(n) < 1e-12 ? 0 : n).toFixed(decimals).padStart(width))
      .join(", ");
  const parts = [];
  // a path reports every frame; the one it ends on is the one worth reading
  const last = (value) => (Array.isArray(value[0]) ? value[value.length - 1] : value);
  if (edit.position) parts.push(`position ${numbers(last(edit.position), 4, 9)} m`);
  if (edit.orientation) {
    parts.push(`rotation ${numbers(last(edit.orientation), 1, 6)}°`);
  }
  if (edit.polarization) {
    parts.push(`polarization ${numbers(edit.polarization, 4, 9)} T`);
  }
  if (edit.shape) {
    // a mesh's parameter is its whole vertex array: the factor is the
    // readable thing, not four hundred coordinates
    const value = edit.shape.value;
    parts.push(
      Array.isArray(value[0])
        ? `${edit.shape.attr} ×${numbers(edit.shape.scale, 3, 6)}`
        : `${edit.shape.attr} ${numbers([].concat(value), 4, 9)} m`,
    );
  }
  show(`${edit.objectId} — ${parts.join("   ")}${extra}`);
}

/** Say something in the bar. The full text goes in the tooltip too: the
 *  message is what gives up width when the panel is narrow, so what is on
 *  screen may be cut to an ellipsis. */
function say(text) {
  statusEl.textContent = text;
  statusEl.title = text;
}

/** Put something in the corner of the view, or take it away. */
function show(text) {
  readoutEl.hidden = !text;
  readoutEl.textContent = text || "";
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
  const blocked = selectedIds.some((id) => patterned.has(id));
  gizmoEl.disabled = blocked;
  const wanted = blocked ? "none" : gizmoEl.value;
  const inEffect = window.scene3d?.setGizmoMode(wanted);
  // The reason a control will not do something belongs on that control, not
  // in the one line the live numbers need: a sentence there is gone by the
  // next redraw anyway, and the tooltip is still there when it is wanted.
  if (blocked) {
    gizmoEl.title = `${selectedIds[0]} is patterned — dragging it would leave its copies behind`;
  } else if (inEffect !== wanted) {
    gizmoEl.value = inEffect; // asked to resize something with no size to drag
    gizmoEl.title = selectedIds[0]
      ? `${selectedIds[0]} has no single dimension to drag — resize it in the Inspector`
      : "Select an object first";
    notice(gizmoEl.title); // said once, where it fades, since a key was pressed
  } else {
    gizmoEl.title = "What a drag does (W, E, R, P, Q)";
  }
}

/** A passing remark, in VS Code's own status bar, which expires by itself
 *  rather than sitting on top of the numbers. */
function notice(text) {
  vscodeApi.postMessage({ type: "notice", text });
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

/** Restrict the handles to one axis, or free them, and show which on the
 *  button rather than announcing it. */
function constrain(axis) {
  window.scene3d?.constrainAxis(axis);
  axisEl.textContent = axis ? axis.toUpperCase() : "XYZ";
  axisEl.classList.toggle("on", Boolean(axis));
}

function toggleSnap() {
  const step = window.scene3d?.setSnapping(!snapping);
  snapping = step !== null && step !== undefined;
  snapEl.classList.toggle("on", snapping);
  snapEl.title = snapping
    ? `Snapping to ${Number(step.toPrecision(3))} m and 15\u00b0 (S)`
    : "Snap to round steps (S)";
}

function toggleProjection() {
  const kind = window.scene3d?.toggleProjection();
  projectionEl.textContent = kind === "parallel" ? "Parallel" : "Persp";
  projectionEl.classList.toggle("on", kind === "parallel");
}

axisEl.addEventListener("click", () => constrain(null));
snapEl.addEventListener("click", toggleSnap);
projectionEl.addEventListener("click", toggleProjection);

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
  if (!drawingScene() || event.target !== document.body) return;
  const key = event.key.toLowerCase();
  const scene3d = window.scene3d;
  if (GIZMO_KEYS[key]) {
    if (gizmoEl.disabled) return;
    gizmoEl.value = GIZMO_KEYS[key];
    applyGizmo();
  } else if ("xyz".includes(key)) {
    constrain(key);
  } else if (key === "a") {
    constrain(null);
  } else if (key === "l") {
    scene3d?.toggleSpace();
    showAxes();
  } else if (key === "h") {
    // the host owns visibility and knows the current state; hidden objects
    // are not drawn, so showing one again is the Scene tree's job
    if (selectedIds[0]) {
      vscodeApi.postMessage({
        type: event.shiftKey ? "isolateObject" : "toggleVisible",
        objectId: selectedIds[0],
      });
    }
  } else if (event.key === " ") {
    event.preventDefault(); // space would otherwise scroll or press a button
    playPause();
  } else if (key === "s") {
    toggleSnap();
  } else if (event.key === "5") {
    toggleProjection();
  } else if (event.key === "Tab") {
    // the panel has nothing else worth tabbing through, and walking the
    // scene is worth more here than moving focus between two dropdowns
    event.preventDefault();
    const next = scene3d?.nextObject(selectedIds[0]);
    if (next) vscodeApi.postMessage({ type: "selectObject", objectId: next });
  } else if (key === "f") {
    scene3d?.fitView(selectedIds[0]); // undefined when nothing is selected: fits all
  } else if (event.key === "Home") {
    scene3d?.fitView();
  } else if (AXIS_VIEWS[event.key]) {
    scene3d?.axisView(...AXIS_VIEWS[event.key]);
  }
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
    // a plain pick, or the Scene tree: one object, and the set restarts
    selectedIds = message.objectId ? [message.objectId] : [];
    window.scene3d?.highlight(selectedIds);
    applyGizmo();
    showSelection();
    show(""); // the last drag's numbers were about something else
  } else if (message.type === "refresh") {
    // Pushed by the host after any edit (inspector, chat tool, tree, a
    // variable slider being dragged) — the one that can arrive fastest.
    refreshPaced();
  }
});

window.addEventListener("resize", () => {
  // scene3d watches the canvas itself; Plotly needs telling
  if (!drawingScene() && canvasEl.data) Plotly.Plots.resize(canvasEl);
});

// Ask for the selection that was already made: a panel opened (or restored)
// mid-session has missed every 'select' the host sent before it existed.
vscodeApi.postMessage({ type: "ready" });

refreshPaced();
