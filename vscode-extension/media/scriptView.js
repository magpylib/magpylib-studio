// A figure from a script the user ran, drawn where the script asked for it.
// Read only: there is no engine behind this panel and, by the time it draws,
// usually no script either.
const vscodeApi = acquireVsCodeApi();
const statusEl = document.getElementById("status");
const canvasEl = document.getElementById("canvas");
const promoteEl = document.getElementById("promote");
const overlayEl = document.getElementById("overlay");
const rerunEl = document.getElementById("rerun");

// The studio can run the script again and own what it builds; it cannot be
// given this picture. So the offer only makes sense when the payload names a
// file -- a REPL or `python -c` reports `<interpreter>`, and there is nothing
// to open.
promoteEl.addEventListener("click", () => {
  vscodeApi.postMessage({ type: "openInStudio" });
});

// Only offered while the figure is out of date, which is when running it again
// is a thing someone wants rather than a button sitting there being ignored.
rerunEl.addEventListener("click", () => {
  vscodeApi.postMessage({ type: "rerun" });
});

function plotTemplate() {
  const cls = document.body.className;
  const dark =
    /vscode-dark|vscode-high-contrast/.test(cls) &&
    !cls.includes("vscode-high-contrast-light");
  return dark ? "plotly_dark" : "plotly_white";
}

let current = null;
//: which renderer is holding the canvas, so a payload that changes kind can
//: take it back cleanly
let drawing = null;

// A `widget` figure is the notebook widget's own state -- what
// `SceneWidget.write_html` saves -- and is drawn with the widget: the same
// legend, playback, tools and keys as a notebook cell. One model for the
// panel's life: a re-run of the script re-points it, as `update()` does a
// cell's, which keeps the camera where the user left it.
let widgetModel = null;
let widgetRun = []; // a run too big to carry as changes, every frame of it
let widgetCleanup = null; // what `render` hands back, to let its renderer go
let widgetLoad = 0; // which figure a load still on its way is for

/** A model the widget can be run against, held here: what anywidget hands a
 *  widget, answering for frames from the run the figure carries. */
function localModel(state) {
  const values = { ...state };
  const listeners = {};
  const emit = (event, value) =>
    (listeners[event] || []).forEach((listener) => listener(value));
  return {
    get: (key) => values[key],
    set(key, value) {
      values[key] = value;
      emit(`change:${key}`, value);
    },
    save_changes() {},
    on: (event, listener) => (listeners[event] ||= []).push(listener),
    off() {},
    send(message) {
      if (message.kind !== "frame" || !widgetRun.length) return;
      const at = Math.max(0, Math.min(message.index, widgetRun.length - 1));
      setTimeout(() =>
        emit("msg:custom", {
          kind: "frame",
          ...widgetRun[at],
          runId: message.runId,
        }),
      );
    },
  };
}

// The widget saves its picture as a download, which a webview does not have:
// the click would do nothing. It hands the file here instead, and the host
// asks where to put it. A picture is all it can save here -- with no python
// behind the panel, it offers no HTML export.
window.magpySave = (href, filename) => {
  if (href.startsWith("data:")) {
    vscodeApi.postMessage({ type: "saveFile", filename, dataUrl: href });
  }
};

/** The widget fills the panel; its height is the model's, so it follows. */
const fittedHeight = () => Math.max(240, canvasEl.clientHeight - 2);
const fitWidget = () => widgetModel?.set("height", fittedHeight());
new ResizeObserver(fitWidget).observe(canvasEl);

/** Each object's place in the legend -- its position and name at every level
 *  down -- by its id. The ids are the objects' own, from the process that
 *  drew them, so a re-run's are all new; the place is what carries over. */
function placesIn(tree, above = "", places = new Map()) {
  tree.forEach((node, i) => {
    const place = `${above}/${i}:${node.label}`;
    places.set(node.id, place);
    placesIn(node.children || [], place, places);
  });
  return places;
}

/** `ids` in the tree `before`, as the ids of the same places in `after`.
 *  One whose place is gone, or now holds something else, is dropped. */
function carried(ids, before, after) {
  const was = placesIn(before);
  const now = new Map([...placesIn(after)].map(([id, place]) => [place, id]));
  return ids.map((id) => now.get(was.get(id))).filter(Boolean);
}

async function drawWidget(body) {
  const load = ++widgetLoad;
  const state = body.state || {};
  if (widgetModel) {
    widgetRun = body.run || [];
    // A re-run: the script's new figure, in the view as the user left it.
    // What was set here -- theme, axes, what is hidden and picked -- was set
    // by the user, not the script, and stays. Everything before the payload:
    // the widget reads a new payload with the tree, run length and pace it
    // belongs to.
    const before = widgetModel.get("tree") || [];
    const after = state.tree || [];
    for (const key of ["hidden", "selected"]) {
      widgetModel.set(key, carried(widgetModel.get(key) || [], before, after));
    }
    for (const key of ["tree", "frames", "duration", "repeat"]) {
      widgetModel.set(key, state[key]);
    }
    widgetModel.set("payload", state.payload);
    return;
  }
  try {
    const widget = (await import(document.body.dataset.widget)).default;
    // Overtaken while it loaded: a newer figure is drawing, or the panel
    // has moved on to another kind.
    if (load !== widgetLoad) return;
    const model = localModel({ ...state, height: fittedHeight() });
    canvasEl.innerHTML = "";
    const el = document.createElement("div");
    canvasEl.append(el);
    widgetRun = body.run || [];
    widgetCleanup = widget.render({ model, el }) || null;
    widgetModel = model;
  } catch (error) {
    if (load !== widgetLoad) return;
    // Said, not swallowed: an empty panel tells nobody anything.
    canvasEl.innerHTML = "";
    const failed = document.createElement("p");
    failed.className = "failed";
    failed.textContent =
      "The view could not be drawn: " + (error?.message || String(error));
    canvasEl.append(failed);
  }
}

/** Let the widget go: its renderer back to the pool, its watchers and timers
 *  stopped, and any load of it still on its way dropped. */
function dropWidget() {
  widgetLoad += 1;
  widgetCleanup?.();
  widgetCleanup = null;
  widgetModel = null;
  widgetRun = [];
}

/** The scene graph is a module, and modules run after this script does — so a
 *  payload can arrive before there is anything to draw it with. `load` fires
 *  once every deferred module has executed. */
function whenScene3d(run) {
  if (window.scene3d) {
    run();
  } else {
    window.addEventListener("load", run, { once: true });
  }
}

function drawn(payload, stale) {
  current = payload;
  statusEl.textContent = payload.script;
  // Told rather than assumed: this page is rebuilt every time the tab comes
  // back, and what it missed while it was gone is the host's to remember.
  overlayEl.hidden = !stale;
  promoteEl.hidden = payload.script.startsWith("<");
  if (drawing && drawing !== payload.kind) {
    if (drawing === "widget") dropWidget();
    // The renderers do not share a canvas. Plotly keeps its state on the
    // element rather than in the DOM it drew, so emptying the element without
    // telling it leaves that state describing a plot that is gone; the scene
    // graph re-hangs its own canvas when it finds the host emptied.
    if (drawing === "plotly") Plotly.purge(canvasEl);
    canvasEl.innerHTML = "";
  }
  drawing = payload.kind;
  // what the stylesheet places the out-of-date badge by
  document.body.dataset.kind = payload.kind;
  if (payload.kind === "widget") {
    drawWidget(payload.body || {});
    return;
  }
  if (payload.kind === "scene") {
    // keepCamera is the whole point of addressing panels rather than
    // replacing them: a rerun of the script redraws this scene where the
    // user left the camera.
    whenScene3d(() => window.scene3d.render(canvasEl, payload.body || {}));
    return;
  }
  const figure = payload.body || {};
  // react, not newPlot: a rerun of the script arrives as a new payload for
  // this same panel, and reacting keeps the camera the user set on the last
  // one, the same way.
  Plotly.react(canvasEl, {
    data: figure.data || [],
    layout: {
      ...(figure.layout || {}),
      template: plotTemplate(),
      // What actually holds the camera across a rerun. `react` alone diffs
      // the figure and resets the view with it, so without this the panel
      // being addressed rather than replaced would buy nothing.
      uirevision: "magpylib-studio",
    },
    // An animated figure carries its steps here. Plotly draws the Play button
    // and the slider from `layout`, which arrives either way -- so dropping
    // the frames leaves controls that do nothing.
    frames: figure.frames || [],
    config: { responsive: true },
  });
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "view") {
    drawn(message.payload, message.stale);
  } else if (message.type === "stale" && current) {
    overlayEl.hidden = !message.stale;
  }
});

// The theme is the window's, and it changes under a panel that is already
// drawn. Plotly holds the colours it was given, so they have to be re-given.
new MutationObserver(() => {
  if (!current) return;
  // the widget watches the theme itself, as it does in a notebook
  if (current.kind === "widget") return;
  if (current.kind === "scene") {
    // The scene reads the editor background off the same CSS variable each
    // time it renders, so redrawing it is what picks the new theme up.
    whenScene3d(() => window.scene3d.render(canvasEl, current.body || {}));
  } else {
    Plotly.relayout(canvasEl, { template: plotTemplate() });
  }
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// Hidden panels here are torn down and rebuilt from the HTML rather than
// retained, so this runs again every time the tab comes back into view. The
// host answers with whatever it last had for this panel.
vscodeApi.postMessage({ type: "ready" });
