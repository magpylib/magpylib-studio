/**
 * A panel of the editor as a widget of its own, for a host that lays things
 * out: `view.panel("variables")` or `view.panel("object")` in python, placed
 * beside the view by the notebook -- an ipywidgets box, a marimo column, a
 * sidecar. The same modules the view docks (`variables.mjs`, `inspector.mjs`)
 * against the view's own session, through the view: every call goes to
 * python under this widget's model and is answered there, and the view draws
 * and tells the notebook as it does for its own panels (decision 0025). The
 * view's revision, selection and theme reach this widget as traits.
 */
import { createInspector } from "./inspector.mjs";
import { wear } from "./theme.mjs";
import { createVariables } from "./variables.mjs";

/** What a call says when python does not answer it. */
const NO_ANSWER = "No answer from python: is the kernel running?";

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function render({ model, el }) {
  el.classList.add("magpy-panel");
  const kind = model.get("kind");
  // the dock's dress: a title line, then the rows
  const dock = element("div", "magpy-scene-dock");
  const head = element("div", "magpy-scene-dock-head");
  const title = element(
    "span",
    "magpy-scene-dock-title",
    kind === "object" ? "Object" : "Variables",
  );
  const actions = element("span", "magpy-scene-dock-actions");
  head.append(title, actions);
  const body = element(
    "div",
    kind === "object" ? "magpy-scene-inspector" : "magpy-scene-variables",
  );
  const notice = element("div", "magpy-panel-notice");
  dock.append(head, body, notice);
  el.append(dock);

  // --- calls to python, as the view makes them ------------------------
  const caller = Math.random().toString(36).slice(2, 10);
  let nextCall = 0;
  const calls = new Map(); // id -> { timer, settle }
  function call(method, params = {}, { preview = false } = {}) {
    return new Promise((resolve, reject) => {
      const id = `${caller}:${++nextCall}`;
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error(NO_ANSWER));
      }, 4000);
      calls.set(id, {
        timer,
        settle(message) {
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        },
      });
      // `preview` marks a value the pointer is still on: python applies it
      // and redraws the view, and the notebook is told at the release.
      model.send({
        kind: "rpc",
        id,
        method,
        params,
        ...(preview ? { preview: true } : {}),
      });
    });
  }
  const onMessage = (message) => {
    if (message.kind !== "rpc") return;
    const pending = calls.get(message.id);
    if (!pending) return; // given up on already
    calls.delete(message.id);
    clearTimeout(pending.timer);
    pending.settle(message);
  };
  model.on("msg:custom", onMessage);

  const say = (text) => {
    notice.textContent = text;
  };

  let panel;
  if (kind === "object") {
    panel = createInspector(body, {
      rpc: (method, params) => call(method, params),
      onEdited: (result) => {
        if (result?.defined?.length) {
          say(`${result.defined.join(", ")} made, at the value it replaces`);
        }
      },
      compact: true,
      empty: "Select an object in the view: its parameters and pose come here.",
      head: actions,
    });
    const follow = () => {
      say("");
      panel.show((model.get("selected") || [])[0]);
    };
    model.on("change:selected", follow);
    model.on("change:revision", () => panel.refresh());
    follow();
  } else {
    panel = createVariables(body, {
      rpc: (method, params, { preview = false } = {}) =>
        call(method, params, { preview }),
      onPreview: () => {}, // python redraws the view itself
      empty: "No variables: a scene function's parameters are its variables.",
      compact: true,
      head: actions,
    });
    model.on("change:revision", () => panel.refresh());
    panel.refresh();
  }

  // --- the theme: the view's choice, worn as the view wears it ----------
  const dress = () => wear(el, model.get("theme") || "auto");
  dress();
  model.on("change:theme", dress);
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  darkQuery.addEventListener("change", dress);
  const themeWatch = new MutationObserver(dress);
  for (const node of [document.documentElement, document.body]) {
    if (node) themeWatch.observe(node, { attributes: true });
  }
  const placing = new ResizeObserver(dress);
  placing.observe(el);

  return () => {
    model.off("msg:custom", onMessage);
    darkQuery.removeEventListener("change", dress);
    themeWatch.disconnect();
    placing.disconnect();
    for (const { timer } of calls.values()) clearTimeout(timer);
  };
}

export default { render };
