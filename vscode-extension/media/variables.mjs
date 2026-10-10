// The Variables view: the package's own panel -- `magpylib_studio/static/
// variables.mjs`, copied to widget/ by `harness/copy-widget.js` beside the
// notebook widget's bundle -- mounted in a sidebar webview. The same rows the
// widget floats over its view (docs/plans/variables-in-widget.md); what
// differs is where the calls go. Here they go through the extension host, as
// every panel's do, so that an edit refreshes the 3D view, the Inspector, the
// field view, the history and the script tab, and marks the scene unsaved.
// `preview` rides along on a value the pointer is still on, which the host
// serves lightly: the views that show it live, and the bookkeeping at the
// release. What the host has dialogs for -- editing a variable's properties,
// removing it -- the panel asks for as actions, and the host does.
const vscodeApi = acquireVsCodeApi();
let nextReqId = 1;
const pending = new Map();

function rpc(method, params = {}, { preview = false } = {}) {
  return new Promise((resolve, reject) => {
    const reqId = nextReqId++;
    pending.set(reqId, { resolve, reject });
    vscodeApi.postMessage({
      type: "rpcRequest",
      reqId,
      method,
      params,
      preview,
    });
  });
}

const { createVariables } = await import(document.body.dataset.variables);
const panel = createVariables(document.getElementById("panel"), {
  rpc,
  actions: {
    edit: (name) =>
      vscodeApi.postMessage({ type: "action", action: "edit", name }),
    remove: (name) =>
      vscodeApi.postMessage({ type: "action", action: "remove", name }),
  },
  empty:
    "No variables yet. A named number any position, dimension or angle can " +
    "be written in terms of — change it once and the scene follows.",
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "rpcResult" || message.type === "rpcError") {
    const entry = pending.get(message.reqId);
    if (!entry) return;
    pending.delete(message.reqId);
    if (message.type === "rpcResult") entry.resolve(message.result);
    else entry.reject(new Error(message.method + ": " + message.error));
  } else if (message.type === "refresh") {
    panel.refresh();
  } else if (message.type === "help") {
    panel.help();
  } else {
    // A message the host sends and this end does not handle is a broken
    // contract, not a no-op: it is how "what can go in a value" stayed
    // empty. Say so where it can be seen.
    panel.say("unhandled message: " + message.type);
  }
});

vscodeApi.postMessage({ type: "ready" });
