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
let figure = null; // the package's figure (host.mjs `mountFigure`), once drawn
let widgetLoad = 0; // which figure a load still on its way is for

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
new ResizeObserver(() => figure?.resize(fittedHeight())).observe(canvasEl);

/** A `widget` figure, drawn by the package that drew it (`mountFigure`, in
 *  its host.mjs): the first one, or a re-run's in the view as it was left. */
async function drawWidget(body) {
  const load = ++widgetLoad;
  if (figure) {
    figure.show(body, fittedHeight());
    return;
  }
  try {
    const { mountFigure } = await import(document.body.dataset.host);
    // Overtaken while it loaded: a newer figure is drawing, or the panel
    // has moved on to another kind.
    if (load !== widgetLoad) return;
    canvasEl.innerHTML = "";
    const el = document.createElement("div");
    canvasEl.append(el);
    figure = mountFigure(el);
    figure.show(body, fittedHeight());
  } catch (error) {
    if (load !== widgetLoad) return;
    // Said, not swallowed: an empty panel tells nobody anything.
    figure = null;
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
  figure?.dispose();
  figure = null;
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
    // telling it leaves that state describing a plot that is gone.
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
  Plotly.relayout(canvasEl, { template: plotTemplate() });
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// Hidden panels here are torn down and rebuilt from the HTML rather than
// retained, so this runs again every time the tab comes back into view. The
// host answers with whatever it last had for this panel.
vscodeApi.postMessage({ type: "ready" });
