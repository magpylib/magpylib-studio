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

function drawn(payload) {
  current = payload;
  const figure = payload.body || {};
  statusEl.textContent = payload.script;
  // react, not newPlot: a rerun of the script arrives as a new payload for
  // this same panel, and reacting keeps the camera the user set on the last
  // one. That is the reason the panel is addressed rather than replaced.
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
  if (current) {
    Plotly.relayout(canvasEl, { template: plotTemplate() });
  }
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// Hidden panels here are torn down and rebuilt from the HTML rather than
// retained, so this runs again every time the tab comes back into view. The
// host answers with whatever it last had for this panel.
vscodeApi.postMessage({ type: "ready" });
