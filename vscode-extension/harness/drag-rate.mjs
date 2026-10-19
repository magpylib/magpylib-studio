/**
 * How many scenes a drag gets back a second in a real marimo: what a person
 * dragging a magnet sees, and the number that showed a drag loop doing one
 * thing at a time halving it once field lines were on (#46).
 *
 *   node harness/drag-rate.mjs [notebook] [--edit] [--seconds n]
 *
 * Starts `marimo run` (or `edit`) on the notebook -- the marimo demo unless
 * named -- with the python the checks use, opens it in headless Chrome on the
 * GPU, drags the demo's `Inner_magnet#3` the way the renderer reports a drag, and
 * counts the view's answers that carry a scene as they arrive over marimo's
 * websocket. Not a check: it prints numbers, and they are the machine's. Needs
 * marimo in that python, and Chrome or Chromium (set CHROME to name one).
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { enginePython } = require("./engine-python.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const TARGET = "Inner_magnet#3";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
};
const notebook = path.resolve(
  args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--seconds") ??
    path.join(REPO, "examples/marimo_demo.py"),
);
const mode = args.includes("--edit") ? "edit" : "run";
const seconds = Number(option("--seconds", 4));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fail(message) {
  console.error(`drag-rate: ${message}`);
  process.exit(1);
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : ["google-chrome", "google-chrome-stable", "chromium"];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    try {
      execFileSync("which", [candidate], { stdio: "ignore" });
      return candidate;
    } catch {
      // not on PATH
    }
  }
  return null;
}

const chromePath = findChrome();
if (!chromePath) fail("no Chrome or Chromium found; set CHROME to name one");
const python = enginePython();
if (!python) fail("no python here can import magpylib_studio");

const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drag-rate-"));
const server = spawn(
  python,
  [
    "-m",
    "marimo",
    mode,
    notebook,
    "--headless",
    `--port=${port}`,
    "--no-token",
  ],
  { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] },
);
let log = "";
server.stderr.on("data", (chunk) => (log += chunk));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  if (i > 120) {
    server.kill("SIGKILL");
    fail(`marimo never came up:\n${log}`);
  }
  try {
    if ((await fetch(base)).status < 500) break;
  } catch {
    // not listening yet
  }
  await wait(500);
}

const gpu = process.platform === "darwin" ? ["--use-angle=metal"] : [];
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${tmp}/chrome`,
    "--window-size=1500,1100",
    "--no-first-run",
    "--ignore-gpu-blocklist",
    ...gpu,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const devtools = await new Promise((resolve) => {
  let said = "";
  chrome.stderr.on("data", (chunk) => {
    said += chunk;
    const found = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said);
    if (found) resolve(found[1]);
  });
});
const target = await (
  await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, {
    method: "PUT",
  })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));

let id = 0;
const pending = new Map();
const scenes = []; // the view's answers that carry a scene: { t, size }
const errors = [];
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  } else if (m.method === "Network.webSocketFrameReceived") {
    const payload = m.params.response.payloadData;
    // an answer with a scene is tens of KB; one without, a few hundred bytes
    if (payload.includes('"rpc"') && payload.length > 20000) {
      scenes.push({ t: m.params.timestamp * 1000, size: payload.length });
    }
  } else if (m.method === "Runtime.exceptionThrown") {
    const { exception, text } = m.params.exceptionDetails;
    errors.push(exception?.description?.split("\n")[0] ?? text);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    pending.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) =>
  (
    await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
  ).result?.value;
// the view, wherever marimo put it: shadow roots opened up
const VIEW = `(() => {
  const walk = (root) => {
    const hit = root.querySelector?.(".magpy-scene-view");
    if (hit) return hit;
    for (const el of root.querySelectorAll?.("*") ?? []) {
      const deep = el.shadowRoot && walk(el.shadowRoot);
      if (deep) return deep;
    }
    return null;
  };
  return walk(document);
})()`;

try {
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.navigate", { url: base });
  for (
    let i = 0;
    !(await evaluate(`Boolean(${VIEW}?.querySelector("canvas"))`));
    i++
  ) {
    if (i > 120) {
      throw new Error(
        `the view never drew\n${errors.join("\n")}${log.slice(-1500)}`,
      );
    }
    await wait(500);
  }
  await wait(4000); // the cells after the view, and the first full scene
  await evaluate(`${VIEW}.scrollIntoView({ block: "center" })`);
  await wait(800);

  scenes.length = 0;
  // a pose every 4 ms, faster than any frame: the drag loop takes the newest
  const fired = await evaluate(`(async () => {
    const view = ${VIEW};
    const fire = (type, detail) => view.dispatchEvent(new CustomEvent(type, { detail }));
    const at = (i) => [{ objectId: "${TARGET}", position: [3e-5 * i, 0.025 + 3e-5 * i, 0] }];
    fire("dragstart", { objectIds: ["${TARGET}"], mode: "translate" });
    const t0 = performance.now();
    let i = 0;
    while (performance.now() - t0 < ${seconds * 1000}) {
      fire("objecttransform", { preview: true, edits: at(i++) });
      await new Promise((r) => setTimeout(r, 4));
    }
    fire("objecttransform", { preview: false, edits: at(i) });
    return i;
  })()`);
  await wait(1500);
  const during = scenes.filter((s) => s.t - scenes[0].t < seconds * 1000);
  const gaps = during
    .slice(1)
    .map((s, k) => s.t - during[k].t)
    .sort((a, b) => a - b);
  const middle = (list) => list[Math.floor(list.length / 2)];
  console.log(
    `${path.basename(notebook)} (${mode}): ${(during.length / seconds).toFixed(1)} scenes a second ` +
      `(${during.length} in ${seconds} s, from ${fired} poses), ` +
      `median gap ${middle(gaps)?.toFixed(1)} ms, ${Math.round((middle(during)?.size ?? 0) / 1000)} KB each`,
  );
  if (errors.length) console.log("page errors:", errors.slice(0, 5));
} catch (error) {
  console.error(`drag-rate: ${error.message}`);
  process.exitCode = 1;
} finally {
  chrome.kill("SIGKILL");
  server.kill("SIGINT");
  await wait(500);
  server.kill("SIGKILL");
  spawnSync("sh", [
    "-c",
    `lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null`,
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit();
