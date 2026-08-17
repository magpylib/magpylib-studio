// A figure from a script the user ran, drawn where the script asked for it.
// Read only: there is no engine behind this panel and, by the time it draws,
// usually no script either.
const vscodeApi = acquireVsCodeApi();
const statusEl = document.getElementById("status");
const canvasEl = document.getElementById("canvas");

function plotTemplate() {
  const cls = document.body.className;
  const dark =
    /vscode-dark|vscode-high-contrast/.test(cls) &&
    !cls.includes("vscode-high-contrast-light");
  return dark ? "plotly_dark" : "plotly_white";
}

let current = null;

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

function drawn(payload) {
  current = payload;
  statusEl.textContent = payload.script;
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
  Plotly.react(
    canvasEl,
    figure.data || [],
    { ...(figure.layout || {}), template: plotTemplate() },
    { responsive: true },
  );
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "view") {
    drawn(message.payload);
  }
});

// The theme is the window's, and it changes under a panel that is already
// drawn. Plotly holds the colours it was given, so they have to be re-given.
new MutationObserver(() => {
  if (!current) return;
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
