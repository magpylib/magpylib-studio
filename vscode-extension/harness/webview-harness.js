/**
 * Runs a webview's own script against the real engine, outside VS Code.
 *
 *   node harness/webview-harness.js inspector [example]
 *
 * tsc and ESLint read the webview scripts now that they are files in media/,
 * and check-webview-scripts.js keeps them there — but neither of those runs
 * one. A panel that parses can still render nothing, in a window nobody can
 * debug from here. This loads the compiled provider, takes the HTML it would
 * hand VS Code, and executes the script under a DOM shim with its rpc bridged
 * to a real `python -m magpylib_studio`. It then prints the DOM as text,
 * which is as close as this repo gets to seeing the panel.
 *
 * The shim implements what the panels actually use and nothing more, so a
 * missing member is a finding, not a gap to paper over.
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const { enginePython } = require("./engine-python");

const EXT = path.join(__dirname, "..");
const REPO = path.join(EXT, "..");

// --------------------------------------------------------------- DOM shim
class ClassList {
  constructor(el) {
    this.el = el;
  }
  add(...names) {
    this.el.className = [
      ...new Set([...this.el.className.split(" "), ...names]),
    ]
      .filter(Boolean)
      .join(" ");
  }
  remove(name) {
    this.el.className = this.el.className
      .split(" ")
      .filter((n) => n && n !== name)
      .join(" ");
  }
  toggle(name, on) {
    if (on === false || (on === undefined && this.contains(name)))
      this.remove(name);
    else this.add(name);
  }
  contains(name) {
    return this.el.className.split(" ").includes(name);
  }
}

class El {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.childNodes = [];
    this.style = {};
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this.text = "";
    this.value = "";
    this.dataset = {};
  }
  get textContent() {
    return this.text + this.childNodes.map((c) => c.textContent ?? "").join("");
  }
  set textContent(v) {
    this.text = String(v ?? "");
    this.childNodes = [];
  }
  set innerHTML(v) {
    if (v !== "") throw new Error("shim: innerHTML only supports clearing");
    this.text = "";
    this.childNodes = [];
  }
  append(...nodes) {
    for (const n of nodes) this.childNodes.push(n);
  }
  appendChild(node) {
    this.childNodes.push(node);
    return node;
  }
  remove() {}
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type) {
    for (const fn of this.listeners.get(type) ?? []) fn({ target: this });
  }
  /** Every element under here, self included. */
  all() {
    return [this, ...this.childNodes.flatMap((c) => (c.all ? c.all() : [c]))];
  }
  /** Enough selector support for what the panels ask: "tag", ".class",
   *  "tag[attr]". Anything richer should fail loudly rather than silently
   *  match nothing. */
  querySelectorAll(selector) {
    const m = /^([a-z]*)(?:\.([\w-]+))?(?:\[(\w+)\])?$/.exec(selector);
    if (!m) throw new Error(`shim: unsupported selector ${selector}`);
    const [, tag, cls, attr] = m;
    return this.all().filter(
      (el) =>
        el !== this &&
        el instanceof El &&
        (!tag || el.tagName === tag) &&
        (!cls || el.classList.contains(cls)) &&
        (!attr || el[attr]),
    );
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class TextNode {
  constructor(text) {
    this.textContent = text;
  }
}

const roots = new Map();
const document = {
  createElement: (tag) => new El(tag),
  createTextNode: (t) => new TextNode(t),
  getElementById: (id) => roots.get(id),
};
for (const id of [
  "header",
  "step",
  "props",
  "transform",
  "params",
  "empty",
  "status",
  "filter",
]) {
  const el = new El("div");
  el.id = id;
  roots.set(id, el);
}

class Option {
  constructor(label, value) {
    this.label = label;
    this.value = value;
    this.textContent = label;
  }
}

const windowListeners = [];
const messagesToHost = [];
const globals = {
  document,
  Option,
  window: {
    addEventListener: (type, fn) =>
      type === "message" && windowListeners.push(fn),
  },
  acquireVsCodeApi: () => ({ postMessage: (m) => messagesToHost.push(m) }),
  console,
  Promise,
  setTimeout,
  clearTimeout,
  // The variables panel holds a drag to one value per frame; a run here has
  // no frames, so the next turn of the loop is the closest honest stand-in.
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  JSON,
  Object,
  Array,
  Math,
  Number,
  String,
  Boolean,
  Error,
  Map,
  Set,
  isNaN,
  parseFloat,
  parseInt,
};

// ------------------------------------------------------------ vscode shim
const uri = (fsPath) => ({
  fsPath,
  path: fsPath,
  toString: () => `file://${fsPath}`,
});
let capturedHtml = "";
const vscode = {
  Uri: { file: uri, joinPath: (b, ...p) => uri(path.join(b.fsPath, ...p)) },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
  },
  ThemeIcon: class {},
  ThemeColor: class {},
  MarkdownString: class {},
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Disposable: class {},
};
const load = Module._load;
Module._load = (request, parent, isMain) =>
  request === "vscode" ? vscode : load.apply(Module, [request, parent, isMain]);

// ----------------------------------------------------------- engine bridge
function startEngine() {
  const python = enginePython();
  if (!python) {
    throw new Error("no python here can import magpylib_studio");
  }
  const proc = spawn(python, ["-m", "magpylib_studio"], { cwd: REPO });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter((l) => l.trim())) {
      const response = JSON.parse(line);
      const entry = pending.get(response.id);
      if (!entry) continue;
      pending.delete(response.id);
      if (response.error) entry.reject(new Error(response.error.message));
      else entry.resolve(response.result);
    }
  });
  proc.stderr.on("data", (c) => process.stderr.write(`[engine] ${c}`));
  return {
    proc,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin.write(
          JSON.stringify({ id, method, params: params ?? {} }) + "\n",
        );
      });
    },
  };
}

// ------------------------------------------------------------------ output
function dump(el, depth = 0, out = []) {
  if (!(el instanceof El)) {
    // text nodes and <option>s: whatever they read as, one line
    const text = String(el.textContent ?? el.label ?? "").trim();
    if (text) out.push("  ".repeat(depth) + JSON.stringify(text));
    return out;
  }
  const own = el.text.trim();
  const attrs = [
    el.className && `.${el.className.split(" ").join(".")}`,
    el.type && `[${el.type}]`,
    el.value !== undefined &&
      el.value !== "" &&
      `= ${JSON.stringify(el.value)}`,
    el.hidden && "(hidden)",
    el.style.display === "none" && "(display:none)",
  ]
    .filter(Boolean)
    .join(" ");
  out.push(
    `${"  ".repeat(depth)}<${el.tagName}> ${attrs} ${own ? JSON.stringify(own) : ""}`.trimEnd(),
  );
  for (const child of el.childNodes) dump(child, depth + 1, out);
  return out;
}

// ------------------------------------------------------------------- mount
const PANELS = (request) => ({
  inspector: {
    elementIds: ["header", "step", "params", "transform", "props", "status"],
    build: () => {
      const { InspectorViewProvider } = require(
        path.join(EXT, "out", "inspectorView.js"),
      );
      return new InspectorViewProvider(
        uri(EXT),
        request,
        () => {},
        () => undefined,
      );
    },
  },
  variables: {
    elementIds: ["list", "empty", "help", "helpBody", "status"],
    build: () => {
      const { VariablesViewProvider } = require(
        path.join(EXT, "out", "variablesView.js"),
      );
      return new VariablesViewProvider(
        uri(EXT),
        request,
        () => {},
        () => {},
        () => {},
      );
    },
  },
});

/**
 * Run a panel's own script against `engine`, and hand back what a caller needs
 * to drive it: the elements it rendered into, a pump that lets the round trips
 * land, and every message it sent the host, in order.
 *
 * `overrides` replaces globals the script reads. A check that has to decide
 * when a frame happens passes its own requestAnimationFrame, which is the
 * only way to tell "one value per frame" from "one value, eventually".
 */
async function mount(which, engine, overrides = {}) {
  const request = (method, params) => engine.request(method, params);
  const panel = PANELS(request)[which];
  if (!panel) {
    throw new Error(
      `no harness for ${which}; try ${Object.keys(PANELS(request)).join(" or ")}`,
    );
  }
  for (const id of panel.elementIds) {
    if (!roots.has(id)) {
      const el = new El("div");
      el.id = id;
      roots.set(id, el);
    }
  }
  const provider = panel.build();

  // Capture the HTML the provider would hand VS Code, and wire the webview's
  // rpc to the engine, exactly as resolveWebviewView does.
  let onMessage;
  const webview = {
    options: {},
    cspSource: "vscode-resource://harness",
    asWebviewUri: (u) => `webview://${path.basename(u.fsPath)}`,
    set html(value) {
      capturedHtml = value;
    },
    get html() {
      return capturedHtml;
    },
    onDidReceiveMessage: (fn) => {
      onMessage = fn;
      return { dispose() {} };
    },
    postMessage: (message) => {
      for (const fn of windowListeners) fn({ data: message });
      return Promise.resolve(true);
    },
  };
  provider.resolveWebviewView({
    webview,
    onDidDispose: () => ({ dispose() {} }),
  });

  // The panel's real script, from the file the webview would load: the HTML
  // only names it now, which is the point of moving it out of the source.
  const named = /<script[^>]*src="[^"]*\/(\w+\.js)"/.exec(capturedHtml);
  if (!named) {
    throw new Error(`${which}: its HTML loads no script`);
  }
  const script = fs.readFileSync(path.join(EXT, "media", named[1]), "utf8");

  Object.assign(globals, overrides);
  const names = Object.keys(globals);
  // eslint-disable-next-line no-new-func
  new Function(...names, script)(...names.map((n) => globals[n]));

  /** Hand the host what the panel has said, the way VS Code would, keeping a
   *  copy: what a gesture sends, and in what order, is the thing worth
   *  checking about a gesture. */
  const sent = [];
  const deliver = async () => {
    for (const message of messagesToHost.splice(0)) {
      sent.push(message);
      await onMessage(message);
    }
  };
  // The script posts { type: 'ready' } on load.
  await deliver();

  /** Let the rpc round trips settle; each one is a real subprocess call. */
  const settle = async (rounds = 40, delay = 25) => {
    for (let i = 0; i < rounds; i++) {
      await new Promise((r) => setTimeout(r, delay));
      await deliver();
    }
  };
  return { panel, provider, webview, roots, settle, sent };
}

// -------------------------------------------------------------------- main
async function main() {
  const which = process.argv[2] ?? "inspector";
  const example = process.argv[3];
  const engine = startEngine();

  if (example) {
    await engine.request("load_example", { name: example });
  }

  const { panel, webview, settle } = await mount(which, engine);

  const show = (title) => {
    console.log(`\n=== ${title} ===`);
    for (const id of panel.elementIds) {
      const body = dump(roots.get(id));
      console.log(`--- #${id} (${body.length} nodes)`);
      // Generous: a dump that stops before the row you are looking at sends
      // you hunting for a bug that is only off the bottom of the screen.
      console.log(body.slice(0, 200).join("\n"));
    }
  };

  if (which === "variables") {
    // Nothing to select: the panel loads itself from the scene's variables,
    // and the host asks it for the expression help on ready.
    await settle();
    show(example ? `${example} variables` : "variables");
  } else {
    const objects = await engine.request("list_objects");
    for (const target of [
      objects.find((o) => !o.derived),
      objects.find((o) => o.derived),
    ].filter(Boolean)) {
      await webview.postMessage({ type: "select", objectId: target.id });
      await settle();
      show(
        `${target.id}${target.derived ? ` (copy of ${target.derived})` : ""}`,
      );
    }
    // One construction step of each kind: the step form is the other half of
    // this panel, and it is the half that renders a document's own values.
    const { events } = await engine.request("get_events");
    const doc = await engine.request("to_dict");
    const fields = (id) =>
      Object.keys((doc.events || []).find((e) => e.id === id) ?? {}).length;
    // The richest event of each kind, so a "create" with no parameters does
    // not stand in for every other one.
    const richest = new Map();
    for (const event of events) {
      const best = richest.get(event.op);
      if (!best || fields(event.id) > fields(best.id))
        richest.set(event.op, event);
    }
    for (const event of richest.values()) {
      await webview.postMessage({ type: "operation", eventId: event.id });
      await settle();
      show(`step ${event.op} — ${event.label}`);
    }
  }

  engine.proc.kill();
  process.exit(0);
}

module.exports = { mount, startEngine, El };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
