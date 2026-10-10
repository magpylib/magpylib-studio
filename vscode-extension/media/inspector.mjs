// The Inspector: the package's own panel -- `magpylib_studio/static/
// inspector.mjs`, copied to widget/ by `harness/copy-widget.js` beside the
// notebook widget's bundle -- mounted in a sidebar webview, in full: header,
// step, parameters, pose, the style tree with its filter. The same panel the
// widget floats beside its edit column, compact (decision 0023); what
// differs is where the calls go.
// Here they go through the extension host, as every panel's do, so that an
// edit refreshes the 3D view, the tree, the field view, the history and the
// script tab, and marks the scene unsaved -- and so that a value naming a
// variable the scene lacks is asked about first, as the host does for every
// panel (`ensureVariablesDefined`).
const vscodeApi = acquireVsCodeApi();
let nextReqId = 1;
const pending = new Map();

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const reqId = nextReqId++;
    pending.set(reqId, { resolve, reject });
    vscodeApi.postMessage({ type: "rpcRequest", reqId, method, params });
  });
}

const { createInspector } = await import(document.body.dataset.inspector);
const panel = createInspector(document.getElementById("panel"), {
  rpc,
  empty: "Select an object in the Scene view.",
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
    panel.show(message.objectId);
  } else if (message.type === "operation") {
    panel.showStep(message.eventId);
  } else if (message.type === "refresh") {
    panel.refresh();
  } else {
    // Nothing else posts into this webview, so an unknown type means the
    // two ends disagree — visible beats silent.
    panel.say("unhandled message: " + message.type);
  }
});

vscodeApi.postMessage({ type: "ready" });
