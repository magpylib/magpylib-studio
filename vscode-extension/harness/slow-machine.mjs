/**
 * A notebook as on a slow machine, to try by hand: what a drag feels like
 * where the view and the kernel have less to work with than a new laptop.
 *
 *   npm run slow-machine -- [notebook.py] [--edit] [--browser %] [--python %]
 *                           [--latency ms] [--no-gpu] [--port p]
 *   npm run slow-machine -- --url http://localhost:8888/lab -- jupyter lab --no-browser
 *
 * Starts `marimo run` (or `edit`) on the notebook -- the marimo demo unless
 * named -- with the python the checks use, or any other server given after
 * `--`, with the page it serves as `--url`. Opens that page in a Chrome
 * window of its own, with a panel in its bottom-left corner whose sliders
 * set, as you go -- the two speeds as a share of this machine's, 100% as it
 * is, 25% a machine a quarter as fast:
 *
 * - Browser: the page's CPU, throttled to that share -- what DevTools'
 *   Performance panel does, 25% its "4x slowdown" -- in every tab of the
 *   window.
 * - Python: the server and every process under it -- a marimo edit's or a
 *   Jupyter's kernels -- run that share of the time, stopped and continued
 *   in 20 ms slices, so their work takes as much longer.
 * - Latency: the page and the server a round trip of that many ms apart, as
 *   a kernel on another machine is: the page talks to them through a relay
 *   here that holds each message half of it, each way.
 * - GPU: on, or off as on a machine without one -- WebGL drawn by SwiftShader
 *   on the CPU. Chrome cannot switch it in a running window, so switching
 *   opens the window again; the server and its sessions stay.
 *
 * Beside each, what it comes to, measured once a second: how busy the page's
 * main thread is, its frames a second and its memory; the server's and its
 * kernels' CPU, in % of one core, and memory; a round trip from the page to
 * the server and back; and what draws the page's WebGL.
 *
 * Not a check, and nothing is measured: it is for hands. Close the window to
 * stop it all; the server's processes are let run again first. Needs Chrome
 * or Chromium (set CHROME to name one), and marimo in that python.
 */

import { execFileSync, spawn } from "node:child_process";
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
const SLICE_MS = 20; // how finely the server's processes are stopped and run

// What came after `--` is a server of the caller's; before it, ours.
const all = process.argv.slice(2);
const split = all.indexOf("--");
const args = split < 0 ? all : all.slice(0, split);
const command = split < 0 ? null : all.slice(split + 1);
const VALUED = ["--browser", "--python", "--latency", "--port", "--url"]; // take a value
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
};
// npm runs a script from the package; a path is the caller's, from where it was
const caller = process.env.INIT_CWD ?? process.cwd();
const named = args.find(
  (a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]),
);
// the two speeds in percent of this machine's, the latency in ms
const state = {
  browser: Number(option("--browser", 25)),
  python: Number(option("--python", 25)),
  latency: Number(option("--latency", 0)),
};
/** CDP's throttling rate for a share of the machine: 4 for 25%. */
const slowdown = (percent) => 100 / Math.min(Math.max(percent, 1), 100);

function fail(message) {
  console.error(`slow-machine: ${message}`);
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

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const chrome = findChrome();
if (!chrome) fail("no Chrome or Chromium found; set CHROME to name one");

// --- the server ---------------------------------------------------------------
let server;
let target; // the page the server serves
if (command?.length) {
  target = option("--url", null);
  if (!target) fail("a server after `--` needs --url, the page it serves");
  server = spawn(command[0], command.slice(1), {
    cwd: caller,
    stdio: "inherit",
  });
} else {
  const python = enginePython();
  if (!python) fail("no python here can import magpylib_studio");
  const notebook = named
    ? path.resolve(caller, named)
    : path.join(REPO, "examples/marimo_demo.py");
  const port = Number(option("--port", 0)) || (await freePort());
  const mode = args.includes("--edit") ? "edit" : "run";
  server = spawn(
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
    { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] },
  );
  target = `http://127.0.0.1:${port}`;
}
const upstream = new URL(target);
for (let i = 0; ; i++) {
  if (i > 300) fail(`${target} never answered`);
  try {
    if ((await fetch(target)).status < 500) break;
  } catch {
    // not listening yet
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// --- python: the server's processes, a share of the time -----------------------
/** The server and every process under it, as they are now. */
function tree() {
  const children = new Map();
  for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
  }).split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const walk = (pid) => {
    found.push(pid);
    for (const child of children.get(pid) ?? []) walk(child);
  };
  walk(server.pid);
  return found;
}
let pids = tree();
setInterval(() => (pids = tree()), 1000); // a kernel started since
let held = false;
const signal = (name) => {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // gone since
    }
  }
  held = name === "SIGSTOP";
};
setInterval(() => {
  if (state.python >= 100) {
    if (held) signal("SIGCONT");
    return;
  }
  signal("SIGCONT");
  setTimeout(() => signal("SIGSTOP"), (SLICE_MS * state.python) / 100);
}, SLICE_MS);

// --- latency: a relay that holds each message half the round trip, each way -----
/** `from`'s data on to `to`, each chunk `state.latency / 2` ms later, and in
 *  the order it came even as the latency changes. */
function delayed(from, to) {
  let last = 0;
  from.on("data", (chunk) => {
    const at = Math.max(performance.now() + state.latency / 2, last);
    last = at;
    const wait = at - performance.now();
    if (wait <= 0) to.write(chunk);
    else setTimeout(() => to.write(chunk), wait);
  });
  from.on("end", () =>
    setTimeout(() => to.end(), Math.max(last - performance.now(), 0)),
  );
  from.on("error", () => to.destroy());
}
const relay = net.createServer((socket) => {
  const onward = net.connect(Number(upstream.port) || 80, upstream.hostname);
  delayed(socket, onward);
  delayed(onward, socket);
});
const relayPort = await freePort();
await new Promise((resolve) => relay.listen(relayPort, "127.0.0.1", resolve));
const page = new URL(target);
page.hostname = "localhost";
page.port = String(relayPort);

// --- the browser: a window of its own, and the panel -------------------------------
const PANEL = `(() => {
  if (document.getElementById("slow-machine")) return;
  const box = document.createElement("div");
  box.id = "slow-machine";
  box.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;" +
    "background:rgba(24,24,27,.9);color:#eee;font:12px system-ui,sans-serif;" +
    "padding:8px 10px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.35);" +
    "display:grid;grid-template-columns:auto 120px 3.6em auto;gap:4px 8px;align-items:center";
  const measured = (key, title) =>
    '<span id="sm-' + key + 'm" title="' + title + '" style="opacity:.65;white-space:nowrap"></span>';
  const row = (key, label, min, max, step, title) =>
    '<label for="sm-' + key + '">' + label + '</label>' +
    '<input id="sm-' + key + '" type="range" min="' + min + '" max="' + max + '" step="' + step + '">' +
    '<span id="sm-' + key + 'v"></span>' + measured(key, title);
  box.innerHTML = '<b style="grid-column:1/-1">Slow machine</b>' +
    row("browser", "Browser", 5, 100, 5, "the page's main thread: the share of the time it is busy, its frames a second, its JavaScript memory") +
    row("python", "Python", 5, 100, 5, "the server and its kernels: CPU, in % of one core, and memory") +
    row("latency", "Latency", 0, 500, 10, "a request from the page to the server and back: the latency and the server's answer") +
    '<label for="sm-gpu">GPU</label><input id="sm-gpu" type="checkbox" style="justify-self:start">' +
    '<span></span>' + measured("gpu", "what draws the page's WebGL; switching reopens the window");
  document.body.append(box);
  const keys = ["browser", "python", "latency"];
  const input = (key) => box.querySelector("#sm-" + key);
  const text = (id, value) => (box.querySelector("#sm-" + id).textContent = value);
  const show = () => keys.forEach((key) =>
    text(key + "v", input(key).value + (key === "latency" ? " ms" : "%")));
  const tell = (asked) => window.slowMachine(JSON.stringify(asked));
  window.__slowMachineSet = (s) => {
    keys.forEach((key) => (input(key).value = s[key]));
    input("gpu").checked = s.gpu;
    show();
  };
  keys.forEach((key) => (input(key).oninput = () => {
    show();
    tell(Object.fromEntries(keys.map((k) => [k, +input(k).value])));
  }));
  input("gpu").onchange = () => tell({ gpu: input("gpu").checked });
  // what draws the page's WebGL
  const gl = document.createElement("canvas").getContext("webgl2");
  const info = gl && gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "no WebGL";
  text("gpum", /swiftshader/i.test(renderer) ? "SwiftShader, on the CPU"
    : (renderer.match(/Renderer: ([^,)]+)/) || [, renderer])[1]);
  // frames a second, as this page gets them
  let frames = 0, fps = null;
  const count = () => { frames += 1; requestAnimationFrame(count); };
  requestAnimationFrame(count);
  setInterval(() => { fps = frames; frames = 0; }, 1000);
  // a round trip to the server, every two seconds
  let trip = null;
  const ping = async () => {
    const started = performance.now();
    try { await fetch(location.origin + "/favicon.ico", { cache: "no-store" }); trip = performance.now() - started; } catch {}
    setTimeout(ping, 2000);
  };
  ping();
  window.__slowMachineStats = (s) => {
    if (s.browser) text("browserm", "busy " + Math.round(s.browser.busy) + "% · " +
      (fps ?? "–") + " fps · " + Math.round(s.browser.mb) + " MB");
    if (s.python) text("pythonm", "cpu " + Math.round(s.python.cpu) + "% · " + Math.round(s.python.mb) + " MB");
    if (trip !== null) text("latencym", "round trip " + Math.round(trip) + " ms");
  };
  tell({});
})();`;

/** Chrome's switches for a machine without a usable GPU: WebGL drawn by
 *  SwiftShader on the CPU, and the page composited there too. */
const NO_GPU = [
  "--disable-gpu",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "slow-machine-"));
let opened = null; // the open window: { browser, send, ask, pages }
let reopening = false;
state.gpu = !args.includes("--no-gpu");

function quit() {
  signal("SIGCONT");
  server.kill("SIGTERM");
  opened?.browser.kill("SIGTERM");
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
}
server.on("exit", (code) => {
  console.error(`slow-machine: the server stopped (${code})`);
  quit();
});
process.on("SIGINT", quit);
process.on("SIGTERM", quit);

/** Open the page in a window of its own, with the GPU or without, its
 *  pages throttled and given the panel. */
async function open() {
  const browser = spawn(
    chrome,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1400,950",
      ...(state.gpu ? [] : NO_GPU),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // closed by hand, it all stops; closed to switch the GPU, it opens again
  browser.on("exit", () => {
    if (!reopening) quit();
    reopening = false;
    open();
  });
  const devtools = await new Promise((resolve) => {
    let said = "";
    browser.stderr.on("data", (chunk) => {
      said += chunk;
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(said);
      if (found) resolve(found[1]);
    });
  });
  const socket = new WebSocket(devtools);
  await new Promise((resolve) => (socket.onopen = resolve));
  let id = 0;
  const answers = new Map(); // a request's id -> what takes its answer
  const send = (method, params = {}, sessionId) =>
    socket.send(JSON.stringify({ id: ++id, method, params, sessionId }));
  const ask = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      answers.set(++id, resolve);
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const pages = new Set(); // a session per page of the window
  const attached = new Set(); // and its target, attached once
  const tellAll = (expression) => {
    for (const session of pages)
      send("Runtime.evaluate", { expression }, session);
  };
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const { method, params, sessionId } = message;
    if (answers.has(message.id)) {
      answers.get(message.id)(message.result ?? null);
      answers.delete(message.id);
    } else if (
      method === "Target.attachedToTarget" &&
      params.targetInfo.type === "page"
    ) {
      // auto-attach and the attach below may both report a page
      if (attached.has(params.targetInfo.targetId)) {
        send("Target.detachFromTarget", { sessionId: params.sessionId });
        return;
      }
      attached.add(params.targetInfo.targetId);
      const session = params.sessionId;
      pages.add(session);
      send("Runtime.enable", {}, session);
      send("Runtime.addBinding", { name: "slowMachine" }, session);
      send("Page.enable", {}, session);
      send("Performance.enable", {}, session);
      const rate = slowdown(state.browser);
      send("Emulation.setCPUThrottlingRate", { rate }, session);
      send("Runtime.runIfWaitingForDebugger", {}, session);
      if (params.targetInfo.url === "about:blank") {
        send("Page.navigate", { url: page.href }, session);
      }
    } else if (method === "Target.detachedFromTarget") {
      pages.delete(params.sessionId);
    } else if (method === "Page.loadEventFired") {
      send("Runtime.evaluate", { expression: PANEL }, sessionId); // after every load
    } else if (
      method === "Runtime.bindingCalled" &&
      params.name === "slowMachine"
    ) {
      const asked = JSON.parse(params.payload);
      if ("gpu" in asked && asked.gpu !== state.gpu) {
        state.gpu = asked.gpu;
        console.log(
          `slow-machine: the GPU ${state.gpu ? "on" : "off"}, reopening`,
        );
        reopening = true;
        browser.kill("SIGTERM");
        return;
      }
      if (Object.keys(asked).length) {
        Object.assign(state, asked);
        for (const session of pages) {
          send(
            "Emulation.setCPUThrottlingRate",
            { rate: slowdown(state.browser) },
            session,
          );
        }
        console.log(
          `slow-machine: browser ${state.browser}%, python ${state.python}%, latency ${state.latency} ms`,
        );
      }
      tellAll(`window.__slowMachineSet?.(${JSON.stringify(state)})`); // every panel
    }
  };
  send("Target.setDiscoverTargets", { discover: true });
  send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  const listed = new URL("/json/list", devtools.replace("ws://", "http://"));
  for (const each of await (await fetch(listed)).json()) {
    if (each.type === "page") {
      send("Target.attachToTarget", { targetId: each.id, flatten: true });
    }
  }
  opened = { browser, send, ask, pages, tellAll };
}

// --- what is measured, once a second ------------------------------------------------
/** CPU seconds as `ps` says them: [dd-][hh:]mm:ss.ss. */
function cpuSeconds(time) {
  const [days, clock] = time.includes("-") ? time.split("-") : [0, time];
  const seconds = clock
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
  return Number(days) * 86400 + seconds;
}
/** The server's processes, together: CPU seconds so far, and memory in MB. */
function pythonUse() {
  let said;
  try {
    said = execFileSync("ps", ["-o", "time=,rss=", "-p", pids.join(",")], {
      encoding: "utf8",
    });
  } catch (error) {
    said = error.stdout ?? ""; // one gone since: the others still say
  }
  let cpu = 0;
  let kb = 0;
  for (const line of said.trim().split("\n")) {
    const [time, rss] = line.trim().split(/\s+/);
    if (!rss) continue;
    cpu += cpuSeconds(time);
    kb += Number(rss);
  }
  return { cpu, mb: kb / 1024 };
}
let lastPython = { at: performance.now(), ...pythonUse() };
const lastPage = new Map(); // a page's session -> its main thread's busy time then
setInterval(async () => {
  if (!opened) return;
  const at = performance.now();
  const used = pythonUse();
  const python = {
    cpu: ((used.cpu - lastPython.cpu) / ((at - lastPython.at) / 1000)) * 100,
    mb: used.mb,
  };
  lastPython = { at, ...used };
  for (const session of opened.pages) {
    const result = await opened.ask("Performance.getMetrics", {}, session);
    const metric = Object.fromEntries(
      (result?.metrics ?? []).map(({ name, value }) => [name, value]),
    );
    const was = lastPage.get(session);
    lastPage.set(session, { at, busy: metric.TaskDuration });
    const browser = was && {
      busy: ((metric.TaskDuration - was.busy) / ((at - was.at) / 1000)) * 100,
      mb: (metric.JSHeapUsedSize ?? 0) / 2 ** 20,
    };
    opened.send(
      "Runtime.evaluate",
      {
        expression: `window.__slowMachineStats?.(${JSON.stringify({ browser, python })})`,
      },
      session,
    );
  }
}, 1000);

await open();
console.log(
  `slow-machine: ${page.href} -- browser ${state.browser}%, python ${state.python}%, ` +
    `latency ${state.latency} ms, GPU ${state.gpu ? "on" : "off"}. Close the window to stop.`,
);
