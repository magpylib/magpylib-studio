/**
 * The notebook widget in a real browser, driven the way a person drives it.
 *
 *   node harness/check-widget-browser.mjs [--only <part of a check's name>]
 *
 * `check-widget.js` says the bundle was built from the sources in the tree;
 * nothing said the bundle *works*. What went wrong with it went wrong only in
 * a browser, and only in some: a theme that stayed light in VS Code's dark
 * notebooks, two views on a page that shared one renderer, full screen that
 * found no full-screen element because it asked before the view was on the
 * page. Each was found by hand. This asks again on every run:
 *
 * - the theme, in each notebook and docs theme the widget has to follow,
 *   simulated as that host dresses itself (`widget-pages/hosts.html`);
 * - the renderer pool, as Jupyter and marimo hand the widget its element
 *   (`widget-pages/pool.html`);
 * - the variables panel, against a fake kernel: offered with the handles,
 *   a slider drag asking the session in the panel's order and redrawing
 *   between, a dropdown committing once, a scene's variants a toggle each
 *   above the rows (`widget-pages/variables.html`);
 * - the object panel, against a fake kernel: the selection's parameters and
 *   pose, a value typed read through the engine, a bare name made at the
 *   value it replaces and said (`widget-pages/inspector.html`);
 * - a ring round the view while python is slow to answer, and not while it
 *   is quick (`widget-pages/busy.html`);
 * - a panel of its own, the variables and the object kinds against a fake
 *   model: the rows, a drag's previews and release, the rows read again when
 *   the view moves on, the selection followed (`widget-pages/own-panel.html`);
 * - a studio webview telling its host when a box that takes typing has the
 *   focus, for the undo keys to stand aside (`widget-pages/text-focus.html`);
 * - a saved page (`write_html`): its legend, the camera it was saved with,
 *   selecting and hiding from the legend, the picture tool, the view cube,
 *   full screen, and a run that plays with no python behind it;
 * - what a selection is drawn with: a shape's edges, its path apart.
 * - a current's flow: moving on screen, resting off it, gone when off; a
 *   saved page's field lines flowing too, and standing when it is off;
 * - a field line picking its sensor, but not a magnet's click through it;
 * - many magnets drawn as one batch, each still picked, hidden, faded,
 *   selected and dragged on its own, and played on a path (`many.html` and
 *   `many-run.html`, from `widget_scenes.py`), and as many sealed into one
 *   body, picked, outlined and hidden whole (`sealed.html`);
 * - a dragged sensor's late redraw kept under the handles;
 * - a drag's redraws paced by their cost, not stopped (`widget-pages/drag-pace.html`);
 * - a saved page's colour bar: a handle cuts the field's colours, and a
 *   double click puts them back; a typed value and an arrow key move one;
 *   one scale for two sensors on one colormap, by its switch.
 *
 * Needs Chrome or Chromium (set CHROME to name one), Node 22 or later for its
 * WebSocket, `npm ci` in vscode-extension/ for the three.js the panel's own
 * renderer loads, and a python with the widget's extra installed -- `pip
 * install -e ".[widget]"`. Missing any of them is a failure, not a skip: a
 * check that passes without having run is worse than none. WebGL runs on
 * SwiftShader, so no GPU is needed.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { enginePython } = require("./engine-python.js");

const HARNESS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HARNESS, "..", "..");
const STATIC = path.join(REPO, "magpylib_studio", "static");
const PAGES = path.join(HARNESS, "widget-pages");
const MEDIA = path.join(HARNESS, "..", "media");
const THREE = path.join(HARNESS, "..", "node_modules", "three");

function fail(message) {
  console.error(`check-widget-browser: ${message}`);
  process.exit(1);
}

// --------------------------------------------------------------- setting up

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "google-chrome",
          "google-chrome-stable",
          "chromium",
          "chromium-browser",
        ];
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

/** Headless Chrome, and the port its DevTools listen on. */
async function launch(chrome, profile) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    // WebGL with no GPU: SwiftShader, which Chrome no longer falls back to
    // unless asked.
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--window-size=1100,800",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  // Ubuntu's runners do not let an unprivileged process make the namespaces
  // Chrome's sandbox is built from. The pages here are this repo's own.
  if (process.platform === "linux") args.push("--no-sandbox");
  args.push("about:blank");
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const timer = setTimeout(
      () => reject(new Error("Chrome did not start within 30 s")),
      30_000,
    );
    // Read to the end whatever happens: a full pipe stops Chrome.
    proc.stderr.on("data", (chunk) => {
      if (said === null) return;
      said += chunk;
      const listening = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said);
      if (listening) {
        said = null;
        clearTimeout(timer);
        resolve(listening[1]);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}) before it listened:\n${said}`));
    });
  });
  return { port, proc };
}

/** This repo's files, over http: modules do not load from file://. */
function serve(out) {
  // three.js for the pages that load the panel's own renderer, from the copy
  // the panel loads it from. `widget/` is what `npm run compile` copies out
  // of the package's static files, and is served from where it is copied
  // from: a run needs no build.
  const roots = {
    static: STATIC,
    widget: STATIC,
    pages: PAGES,
    media: MEDIA,
    three: THREE,
    out,
  };
  const TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const [, root, ...rest] = decodeURIComponent(url.pathname).split("/");
    const base = roots[root];
    const file = base && path.join(base, ...rest);
    if (!file || !file.startsWith(base + path.sep) || !fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    response.writeHead(200, { "content-type": type });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

// ------------------------------------------------------------ a browser tab

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`'s value, or `otherwise` if it has not settled within `ms`. A
 *  page that locks up answers nothing -- the regression some of these checks
 *  exist to catch -- and a check waiting on it must fail, not wait. */
const within = (ms, promise, otherwise) => {
  // The timer is cleared once the check is done: left running, the last
  // check's kept the process alive for its full two minutes after the run
  // had finished -- half of every run, spent waiting.
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(otherwise), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

async function openTab(port) {
  const devtools = `http://127.0.0.1:${port}`;
  const target = await (
    await fetch(`${devtools}/json/new?about:blank`, { method: "PUT" })
  ).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const errors = [];
  let id = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === "Runtime.exceptionThrown") {
      const { exceptionDetails: details } = message.params;
      errors.push(
        details.exception?.description?.split("\n")[0] ?? details.text,
      );
    }
  };
  await new Promise((resolve) => (socket.onopen = resolve));

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (message) =>
        message.error
          ? reject(new Error(`${method}: ${message.error.message}`))
          : resolve(message.result),
      );
      socket.send(JSON.stringify({ id: n, method, params }));
    });
  await send("Runtime.enable");

  /** The value of `body`, run as an async function in the page. */
  async function evaluate(body) {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? "threw");
    }
    return result.value;
  }

  /** `body`'s value once it is truthy, or null if it never is. */
  async function until(body, ms = 10_000) {
    for (const end = Date.now() + ms; Date.now() < end; await wait(150)) {
      const value = await evaluate(body);
      if (value) return value;
    }
    return null;
  }

  async function navigate(url) {
    await send("Page.navigate", { url });
  }

  /** A real press and release: full screen wants a gesture, not a call. */
  async function click({ x, y }) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  }

  async function hover({ x, y }) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async function close() {
    socket.close();
    await within(
      5000,
      fetch(`${devtools}/json/close/${target.id}`).catch(() => {}),
    );
  }

  return { send, evaluate, until, navigate, click, hover, errors, close };
}

/** Page code: the middle of the element `selector` finds. */
const centreOf = (selector) => `
  const box = ${selector}.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };`;
/** Page code: the tool whose name starts with `name`. */
const tool = (name) =>
  `[...document.querySelectorAll(".magpy-icon")].find((b) => b.title.startsWith(${JSON.stringify(name)}))`;
const VIEW = `document.querySelector(".magpy-scene-view")`;
const WEARS = `document.querySelector(".magpy-scene").classList.contains("magpy-dark") ? "dark" : "light"`;
const row = (label) =>
  `[...document.querySelectorAll(".magpy-legend-row")].find((r) => r.querySelector(".magpy-legend-label").textContent === ${JSON.stringify(label)})`;

// -------------------------------------------------------------- the checks

let failures = 0;

/** Run `body`, which answers what is wrong -- nothing, when all is well. */
//: `--only <text>` runs the checks whose name holds it, and none of the rest:
//: the whole run takes minutes, and a change to one page wants one answer.
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;

async function check(name, body) {
  if (only && !name.includes(only)) return;
  let problem;
  try {
    problem = await within(
      120_000,
      body(),
      "did not finish within two minutes -- the page may have locked up",
    );
  } catch (error) {
    problem = error.message.split("\n")[0];
  }
  if (problem) failures++;
  console.log(
    `${problem ? "FAIL" : "ok  "}  ${name}${problem ? `: ${problem}` : ""}`,
  );
}

/** What went wrong in the page itself, if anything did. */
const thrown = (tab) =>
  tab.errors.length ? `the page threw: ${tab.errors.join(" | ")}` : null;

/** Each host, light, then dark, then light again. VS Code's theme need not be
 *  the system's, so the system is set the other way there: following it
 *  instead of VS Code would show. Sharing VS Code's forced-white output
 *  panel with other outputs, the widget matches the panel, not the theme. */
const HOSTS = [
  [
    "vscode&layout=alone",
    "VS Code notebook",
    { system: "opposite", backdrops: "painted" },
  ],
  [
    "vscode&layout=shared",
    "VS Code notebook, sharing its output",
    { alwaysLight: true, system: "opposite", backdrops: "white" },
  ],
  // A second view of the same widget is no company: both wear the theme.
  [
    "vscode&layout=twice",
    "VS Code notebook, the same view twice",
    { system: "opposite", backdrops: "painted" },
  ],
  ["pydata", "pydata-sphinx-theme"],
  ["furo", "furo"],
  ["jupyterbook", "Jupyter Book 2"],
  ["sphinx", "a docs theme on the system's setting", { flipsSystem: true }],
  ["jupyterlab", "JupyterLab"],
];

async function themes(port, base) {
  for (const [host, label, how = {}] of HOSTS) {
    await check(`theme in ${label}`, async () => {
      const tab = await openTab(port);
      const system = (dark) =>
        tab.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value: dark ? "dark" : "light" },
          ],
        });
      try {
        await system(how.system === "opposite");
        await tab.navigate(`${base}/pages/hosts.html?host=${host}`);
        if (
          !(await tab.until(
            `return window.ready && ${VIEW}?.querySelector("canvas")`,
          ))
        ) {
          return "the widget never drew";
        }
        const seen = [];
        for (const dark of [false, true, false]) {
          if (how.flipsSystem) await system(dark);
          else {
            if (how.system === "opposite") await system(!dark);
            await tab.evaluate(`window.flip(${dark})`);
          }
          const want = how.alwaysLight || !dark ? "light" : "dark";
          await wait(300);
          const wore = await tab.until(`return (${WEARS}) === "${want}"`, 3000);
          seen.push(wore ? want : `${await tab.evaluate(`return ${WEARS}`)}`);
          if (how.backdrops) {
            const wrong = await tab.evaluate(backdropsNot(how.backdrops));
            if (wrong) return `${want}: ${wrong}`;
          }
        }
        const expected = how.alwaysLight
          ? "light light light"
          : "light dark light";
        if (seen.join(" ") !== expected) return `wore ${seen.join(" -> ")}`;
        return thrown(tab);
      } finally {
        await tab.close();
      }
    });
  }
}

/** Page code: what is wrong with VS Code's white panels, if anything. Alone
 *  on them, the view paints every one to match itself -- one left white is
 *  a white rim round a dark view. Sharing them, it leaves them white for the
 *  controls that were drawn for white. */
const backdropsNot = (want) => `
  const view = getComputedStyle(${VIEW}).backgroundColor;
  const panels = [...document.querySelectorAll(".cell-output-ipywidget-background")];
  const off = panels
    .map((panel) => getComputedStyle(panel).backgroundColor)
    .filter((colour) => colour !== (${JSON.stringify(want)} === "painted" ? view : "rgb(255, 255, 255)"));
  return off.length ? "panels " + off.join(", ") + " where the view is " + view : null;`;

/** Sliders that arrive in the view's box after it has drawn -- Jupyter
 *  renders a box's children one by one -- make it company it could not have
 *  seen: it has to notice, go back to white, and give the panels back. */
async function lateCompany(port, base) {
  await check("VS Code notebook, sliders arriving after the view", async () => {
    const tab = await openTab(port);
    try {
      await tab.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "light" }],
      });
      await tab.navigate(`${base}/pages/hosts.html?host=vscode&layout=late`);
      if (
        !(await tab.until(
          `return window.ready && ${VIEW}?.querySelector("canvas")`,
        ))
      ) {
        return "the widget never drew";
      }
      await tab.evaluate("window.flip(true)");
      if (!(await tab.until(`return (${WEARS}) === "dark"`, 3000))) {
        return "alone in a dark VS Code, it never went dark";
      }
      const painted = await tab.evaluate(backdropsNot("painted"));
      if (painted) return `alone: ${painted}`;
      await tab.evaluate("window.arrive()");
      if (!(await tab.until(`return (${WEARS}) === "light"`, 3000))) {
        return "with sliders beside it, it stayed dark";
      }
      const white = await tab.until(
        `return !(${`(() => {${backdropsNot("white")}})()`})`,
        3000,
      );
      if (!white) return `shared: ${await tab.evaluate(backdropsNot("white"))}`;
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

/** The legend's first look, by the room the view has. The scene is a stack
 *  of two rings of four and a probe: twelve rows open in full, four with
 *  the rings folded, two with everything folded. */
/** A scene in centimetres, framed by the page itself: it fills the view.
 *
 * The first fit frames the axes with the objects, and comes before any frame
 * is drawn. Measured then, the axes' box was the unit cube a Box3Helper is
 * built as -- placed on its box only when a render calls for it -- so a scene
 * a few centimetres across opened as a speck in two metres of nothing. */
async function firstLook(port, base, expected) {
  await check("a scene in centimetres fills its first look", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/out/small.html`);
      const drawn = await tab.until(
        `return ${VIEW}?.querySelector("canvas") && window.scene3d?.cameraState()`,
        20_000,
      );
      if (!drawn) return "the page never drew";
      await wait(300);
      const camera = await tab.evaluate("return window.scene3d.cameraState()");
      const distance = Math.hypot(
        ...camera.position.map((p, i) => p - camera.target[i]),
      );
      // fitted, the camera stands about three spans off; framed round the
      // unit cube it stood nearly ninety away
      const spans = distance / expected.small_span;
      return spans < 5
        ? thrown(tab)
        : `the camera is ${spans.toFixed(0)} spans away`;
    } finally {
      await tab.close();
    }
  });
}

/** A current's wire flows by itself, in a run that is not playing: the view
 *  draws frame after frame while it is on screen, stops once it is scrolled
 *  away, and flows on when it is back. Its arrows are away while it flows;
 *  switched off, the pulses go and the arrows come back. Told apart by the
 *  picture: it changes between two snapshots only while the pulses move. */
async function flow(port, base) {
  await check("a current flows on screen, and rests off it", async () => {
    const tab = await openTab(port);
    const moves = `
      const before = window.scene3d.snapshot();
      await new Promise((done) => setTimeout(done, 400));
      return window.scene3d.snapshot() !== before;`;
    const away = (y) => `
      document.body.style.minHeight = "4000px";
      scrollTo(0, ${y});
      await new Promise((done) => setTimeout(done, 300));`;
    try {
      await tab.navigate(`${base}/out/ramp.html`);
      const drawn = await tab.until(
        `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size`,
        20_000,
      );
      if (!drawn) return "the page never drew";
      const shown = (mark) => `
        let count = 0;
        for (const node of window.scene3d.byObjectId.values()) {
          node.traverse((part) => (count += part.userData.${mark} && part.visible ? 1 : 0));
        }
        return count;`;
      const pulses = shown("flow");
      const arrows = shown("arrows");
      if (!(await tab.evaluate(pulses))) return "the coil's wire has no pulses";
      const offered = await tab.evaluate(
        `const b = [...document.querySelectorAll(".magpy-icon")].find((b) => b.title.startsWith("Flow")); return Boolean(b && !b.hidden);`,
      );
      if (!offered) return "no flow button beside a current";
      if (await tab.evaluate(arrows))
        return "its arrows showed beside the flow";
      if (!(await tab.evaluate(moves))) return "the pulses stood still";
      await tab.evaluate(away(3000));
      if (await tab.evaluate(moves)) return "it kept drawing off screen";
      await tab.evaluate(away(0));
      if (!(await tab.evaluate(moves)))
        return "it did not flow on, back on screen";
      await tab.evaluate("window.scene3d.setFlow(false)");
      if (await tab.evaluate(pulses)) return "switched off, the pulses stayed";
      if (!(await tab.evaluate(arrows))) {
        return "switched off, no arrows came back";
      }
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

/** A saved page draws a sensor's field lines (#45): the page integrates them
 *  itself, from the field on the grid it carries -- no python behind it. A
 *  line part is the one with an empty box, kept out of what the view frames.
 *  They flow, with no current in the scene to offer the flow button but
 *  them; switched off, they stay, standing. */
async function savedLines(port, base) {
  await check("a saved page draws field lines that flow", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/out/lines.html`);
      const drawn = await tab.until(
        `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size`,
        20_000,
      );
      if (!drawn) return "the page never drew";
      const segments = await tab.evaluate(`
        let count = 0;
        for (const node of window.scene3d.byObjectId.values()) {
          node.traverse((part) => {
            const box = part.geometry?.boundingBox;
            if (part.isLineSegments2 && box?.isEmpty()) {
              count += part.geometry.attributes.instanceStart.count;
            }
          });
        }
        return count;
      `);
      if (!(segments > 100)) return `${segments} line segments drawn`;
      const moves = `
        const before = window.scene3d.snapshot();
        await new Promise((done) => setTimeout(done, 400));
        return window.scene3d.snapshot() !== before;`;
      const offered = await tab.evaluate(
        `const b = [...document.querySelectorAll(".magpy-icon")].find((b) => b.title.startsWith("Flow")); return Boolean(b && !b.hidden);`,
      );
      if (!offered) return "no flow button beside the field lines";
      if (!(await tab.evaluate(moves))) return "the field lines stood still";
      await tab.evaluate("window.scene3d.setFlow(false)");
      if (await tab.evaluate(moves)) return "switched off, they still moved";
      const still = await tab.evaluate(`
        let count = 0;
        for (const node of window.scene3d.byObjectId.values()) {
          node.traverse((part) => (count += part.userData.field && part.visible ? 1 : 0));
        }
        return count;`);
      return still ? thrown(tab) : "switched off, the field lines went";
    } finally {
      await tab.close();
    }
  });
}

/** A sensor whose pixels are hidden is its field lines, and a click on one
 *  picks it -- but not where a magnet is behind the line: the magnet takes
 *  that click, as it would from a faded object. */
async function linesPick(port, base) {
  await check(
    "a field line picks its sensor, and not over a magnet",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/out/lines.html`);
        const drawn = await tab.until(
          `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size`,
          20_000,
        );
        if (!drawn) return "the page never drew";
        // a point on a line with the cube behind it, and one with the cube
        // nowhere along the ray
        const spots = await tab.evaluate(`
        const s = window.scene3d;
        s.setHidden(["plane/pixels", "plane/axes"]);
        const node = s.byObjectId.get("plane");
        const camera = node.parent.children.find((c) => c.isTransformControlsRoot).controls.camera;
        const rect = ${VIEW}.querySelector("canvas").getBoundingClientRect();
        const page = (p) => {
          const q = p.clone().project(camera);
          return { x: rect.left + ((q.x + 1) / 2) * rect.width, y: rect.top + ((1 - q.y) / 2) * rect.height };
        };
        const eye = camera.position;
        // the cube as drawn, in whatever unit the page draws in
        const cube = [...s.byObjectId.keys()].find((id) => id !== "plane");
        let box = null;
        s.byObjectId.get(cube).traverse((part) => {
          if (!part.isMesh) return;
          part.geometry.computeBoundingBox();
          const each = part.geometry.boundingBox.clone().applyMatrix4(part.matrixWorld);
          box = box ? box.union(each) : each;
        });
        const middle = box.getCenter(eye.clone());
        const half = box.getSize(eye.clone()).multiplyScalar(0.5);
        // where the ray from the eye through p meets the cube, grown by
        // \`grow\`: [in, out], 1 being p, or null where it misses
        const through = (p, grow) => {
          let near = -Infinity, far = Infinity;
          for (const axis of ["x", "y", "z"]) {
            const d = p[axis] - eye[axis];
            const lo = middle[axis] - grow * half[axis] - eye[axis];
            const hi = middle[axis] + grow * half[axis] - eye[axis];
            near = Math.max(near, Math.min(lo / d, hi / d));
            far = Math.min(far, Math.max(lo / d, hi / d));
          }
          return near <= far && far > 0 ? [near, far] : null;
        };
        let over = null, clear = null;
        node.traverse((part) => {
          if (!part.userData.field) return;
          const start = part.geometry.attributes.instanceStart;
          for (let i = 0; i < start.count; i++) {
            const p = node.position.clone().fromBufferAttribute(start, i).applyMatrix4(part.matrixWorld);
            const at = page(p);
            // inside the view, away from its edges and the tools over them
            const inside =
              Math.abs(at.x - (rect.left + rect.width / 2)) < rect.width / 3 &&
              Math.abs(at.y - (rect.top + rect.height / 2)) < rect.height / 3;
            if (!inside) continue;
            if (!over && through(p, 1)?.[0] > 1.05) over = at;
            // clear of the cube by half its size again, for the click's reach
            if (!clear && !through(p, 1.5)) clear = at;
          }
        });
        const host = ${VIEW}.querySelector("canvas").parentElement;
        window.picked = [];
        host.addEventListener("objectpick", (e) => window.picked.push(e.detail.objectId));
        return { over, clear, cube };`);
        if (!spots.over || !spots.clear) {
          return `no line to click: ${JSON.stringify(spots)}`;
        }
        const picks = async (at) => {
          await tab.click(at);
          return tab.evaluate("return window.picked.splice(0)[0] ?? 'nothing'");
        };
        const clear = await picks(spots.clear);
        if (clear !== "plane") return `a click on a field line picked ${clear}`;
        const over = await picks(spots.over);
        if (over !== spots.cube) {
          return `a click on the cube, through a line, picked ${over}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** A hundred magnets, enough to be drawn as one batch: each one's own traces
 *  kept on the layer the camera skips, and still what a click picks; one
 *  hidden goes from the picture, and one faded or selected is drawn apart. */
async function manyMagnets(port, base) {
  await check("many magnets drawn as one, each still its own", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/out/many.html`);
      const drawn = await tab.until(
        `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size >= 100`,
        20_000,
      );
      if (!drawn) return "the page never drew";
      // per magnet, whether its traces are batched: on the layer the camera
      // skips (mask 2), not the one it draws (1)
      const batched = (ids) => `(${JSON.stringify(ids)}).map((id) =>
        window.scene3d.byObjectId.get(id).children.some((p) => p.isMesh && p.layers.mask === 2))`;
      const front = await tab.evaluate(`
        const s = window.scene3d;
        const ids = [...s.byObjectId.keys()];
        const camera = s.byObjectId.get(ids[0]).parent.children
          .find((c) => c.isTransformControlsRoot).controls.camera;
        const rect = ${VIEW}.querySelector("canvas").getBoundingClientRect();
        const centre = (id) => {
          const node = s.byObjectId.get(id);
          node.updateWorldMatrix(true, true);
          const mesh = node.children.find((p) => p.isMesh);
          if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
          return mesh.geometry.boundingSphere.center.clone().applyMatrix4(mesh.matrixWorld);
        };
        // the cube nearest the eye: nothing stands in front of its middle
        const id = ids.reduce((a, b) =>
          centre(a).distanceTo(camera.position) <= centre(b).distanceTo(camera.position) ? a : b);
        const q = centre(id).project(camera);
        const at = { x: rect.left + ((q.x + 1) / 2) * rect.width, y: rect.top + ((1 - q.y) / 2) * rect.height };
        const host = ${VIEW}.querySelector("canvas").parentElement;
        window.picked = [];
        host.addEventListener("objectpick", (e) => window.picked.push(e.detail.objectId));
        // the colour drawn there, from a copy of the view
        window.colourAt = (point) => {
          const copy = s.still();
          const scale = copy.width / rect.width;
          const pixel = copy.getContext("2d").getImageData(
            Math.round((point.x - rect.left) * scale), Math.round((point.y - rect.top) * scale), 1, 1).data;
          return [...pixel].slice(0, 3).join(",");
        };
        return { id, at, others: ids.filter((each) => each !== id).slice(0, 2), all: ids.length };`);
      const before = await tab.evaluate(
        `return ${batched([front.id, ...front.others])}`,
      );
      if (!before.every(Boolean))
        return `not batched: ${JSON.stringify(before)}`;
      await tab.click(front.at);
      const picked = await tab.evaluate(
        "return window.picked.splice(0)[0] ?? 'nothing'",
      );
      if (picked !== front.id) return `a click on ${front.id} picked ${picked}`;
      const shown = await tab.evaluate(
        `return colourAt(${JSON.stringify(front.at)})`,
      );
      await tab.evaluate(
        `window.scene3d.setHidden([${JSON.stringify(front.id)}])`,
      );
      const hidden = await tab.evaluate(
        `return colourAt(${JSON.stringify(front.at)})`,
      );
      if (hidden === shown)
        return `hidden, ${front.id} is still drawn (${shown})`;
      await tab.evaluate(`window.scene3d.setHidden([])`);
      const back = await tab.evaluate(
        `return colourAt(${JSON.stringify(front.at)})`,
      );
      if (back !== shown)
        return `shown again, ${front.id} draws ${back}, not ${shown}`;
      // faded, drawn on its own, see-through; selected, kept in its batch
      const [faded] = front.others;
      await tab.evaluate(`
        window.scene3d.setFades({ ${JSON.stringify(faded)}: 0.3 });
        window.scene3d.highlight([${JSON.stringify(front.id)}]);
        window.scene3d.still();`);
      const kept = await tab.evaluate(`return ${batched([faded, front.id])}`);
      if (kept[0] || !kept[1]) {
        return `batched, faded and selected: ${JSON.stringify(kept)}`;
      }
      // and moved by its node, as the handles move it: the batch follows
      const follows = await tab.evaluate(`
        const s = window.scene3d;
        const node = s.byObjectId.get(${JSON.stringify(front.id)});
        const trace = node.children.find((p) => p.isMesh);
        node.position.x += 3 * trace.geometry.boundingSphere.radius;
        s.still();
        trace.updateWorldMatrix(true, false);
        let root = node;
        while (root.parent) root = root.parent;
        const batches = [];
        root.traverse((c) => c.isBatchedMesh && batches.push(c));
        // a batch holds its matrices in single precision
        const near = (m) => m.elements.every((e, k) =>
          Math.abs(e - trace.matrixWorld.elements[k]) <= 1e-6 * (1 + Math.abs(e)));
        const at = new trace.matrixWorld.constructor();
        return batches.some((batch) => {
          for (let i = 0; i < batch.maxInstanceCount; i++) {
            try {
              if (near(batch.getMatrixAt(i, at))) return true;
            } catch {} // an instance deleted
          }
          return false;
        });`);
      if (!follows) return "moved by its node, the batch left it where it was";
      // drawn again from its payload: one batch of the hundred, not the old
      // one left drawn under the new
      const again = await tab.evaluate(`
        const text = document.getElementById("magpy-scene").textContent.trim();
        const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
        const unzipped = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        const payload = JSON.parse(await new Response(unzipped).text()).state.payload;
        const s = window.scene3d;
        s.render(${VIEW}.querySelector("canvas").parentElement, payload, { keepCamera: true });
        s.still();
        const node = s.byObjectId.get(${JSON.stringify(front.id)});
        let root = node;
        while (root.parent) root = root.parent;
        const batches = [];
        root.traverse((c) => c.isBatchedMesh && batches.push(c));
        return batches.map((batch) => batch.instanceCount);`);
      if (again.length !== 1 || again[0] !== 100) {
        return `drawn again, batches of ${JSON.stringify(again)} magnets`;
      }
      const rebuilt = await tab.evaluate(`return ${batched([front.id])}`);
      if (!rebuilt[0]) return "drawn again, its new traces are drawn apart";
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

/** Page code, on `overlap.html`: its shapes by label, where a point of
 *  the scene is on the page, and the colour the view draws there. */
const CUBES = `
  const s = window.scene3d;
  const nodes = [...s.byObjectId.values()];
  const camera = nodes[0].parent.children
    .find((c) => c.isTransformControlsRoot).controls.camera;
  const rect = ${VIEW}.querySelector("canvas").getBoundingClientRect();
  window.viewRect = rect;
  window.cubes = Object.fromEntries(nodes.map((node) => {
    const mesh = node.children.find((c) => c.isMesh && c.userData.trace);
    return [mesh.name.split(" ")[0], { node, mesh }];
  }));
  window.boxOf = ({ mesh }) => {
    mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  };
  window.onPage = (point) => {
    const q = point.clone().project(camera);
    return { x: rect.left + ((q.x + 1) / 2) * rect.width, y: rect.top + ((1 - q.y) / 2) * rect.height };
  };
  window.colourAt = (point) => {
    const copy = s.still();
    const scale = copy.width / rect.width;
    return [...copy.getContext("2d").getImageData(
      Math.round((point.x - rect.left) * scale), Math.round((point.y - rect.top) * scale), 1, 1).data].slice(0, 3).join(",");
  };
  // the view's pixels in a box round \`r\` on the page, \`pad\` beyond it
  window.pixelsAround = (r, pad) => {
    const copy = s.still();
    const scale = copy.width / rect.width;
    const x = Math.round((r.left - pad - rect.left) * scale);
    const y = Math.round((r.top - pad - rect.top) * scale);
    const w = Math.round((r.right - r.left + 2 * pad) * scale);
    const h = Math.round((r.bottom - r.top + 2 * pad) * scale);
    return copy.getContext("2d").getImageData(x, y, w, h).data;
  };
  window.faintOn = (name) => {
    let n = 0;
    cubes[name].node.traverse((o) => {
      if (o.userData.mark && o.material.uniforms.channel.value.y === 1) n++;
    });
    return n;
  };
  return Object.keys(cubes).sort().join();`;

/** What the pointer is on is marked faintly, round it and only while it is;
 *  two cubes that overlap are shaded where they interpenetrate. */
async function marks(port, base) {
  const open = async (tab) => {
    await tab.navigate(`${base}/out/overlap.html`);
    const drawn = await tab.until(
      `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size === 5`,
      20_000,
    );
    return drawn && (await tab.evaluate(CUBES)) === "a,b,clear,t,u";
  };
  await check("the pointer marks what it is on, faintly", async () => {
    const tab = await openTab(port);
    try {
      if (!(await open(tab))) return "the page never drew its five shapes";
      const at = await tab.evaluate(`
        const box = boxOf(cubes.clear);
        const centre = onPage(box.getCenter(box.min.clone()));
        // just right of the cube on screen, where a glow round it falls
        const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => onPage(box.min.clone().set(
          i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)));
        const xs = corners.map((c) => c.x);
        const ys = corners.map((c) => c.y);
        window.around = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
        window.before = pixelsAround(around, 8);
        const away = { x: viewRect.left + 12, y: viewRect.bottom - 12 };
        return { centre, away };`);
      await tab.hover(at.centre);
      await wait(400);
      const on = await tab.evaluate(
        "return { clear: faintOn('clear'), others: faintOn('a') + faintOn('b') }",
      );
      if (!on.clear) return "nothing marks the cube under the pointer";
      if (on.others) return `${on.others} marks on the cubes not under it`;
      // drawn round it, not only listed: pixels about the cube have changed
      const changed = await tab.evaluate(`
        const after = pixelsAround(around, 8);
        let n = 0;
        for (let i = 0; i < after.length; i += 4) {
          if (Math.abs(after[i] - before[i]) + Math.abs(after[i + 1] - before[i + 1]) + Math.abs(after[i + 2] - before[i + 2]) > 6) n++;
        }
        return n;`);
      if (changed < 20)
        return `${changed} pixels round the cube change with its mark`;
      await tab.hover(at.away);
      await wait(300);
      const left = await tab.evaluate("return faintOn('clear')");
      if (left) return "the mark stays once the pointer has left";
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
  await check(
    "overlapping solids are shaded where they interpenetrate",
    async () => {
      const tab = await openTab(port);
      try {
        if (!(await open(tab))) return "the page never drew its five shapes";
        // two cubes, and a cube in a tetrahedron's corner -- outside its
        // box's middle, which a convex solid's inside was once taken from
        const region = await tab.evaluate(`
          const hatched = (...names) => {
            const found = [];
            for (const name of names) {
              cubes[name].node.traverse((o) => { if (o.userData.region && o.material.uniforms?.period) found.push(o); });
            }
            return found;
          };
          const regions = hatched("a", "b");
          const count = regions.length + hatched("t", "u").length;
          if (regions.length !== 1 || count !== 2) return { count };
          const [shading] = regions;
          shading.updateWorldMatrix(true, false);
          shading.geometry.computeBoundingBox();
          const got = shading.geometry.boundingBox.clone().applyMatrix4(shading.matrixWorld);
          const want = boxOf(cubes.a).intersect(boxOf(cubes.b));
          const size = want.getSize(want.min.clone()).length();
          const off = Math.max(got.min.distanceTo(want.min), got.max.distanceTo(want.max)) / size;
          const middle = onPage(want.getCenter(want.min.clone()));
          const shaded = colourAt(middle);
          shading.visible = false;
          const bare = colourAt(middle);
          shading.visible = true;
          return { count, off, shaded, bare };`);
        if (region.count !== 2) return `${region.count} shaded regions, not 2`;
        if (region.off > 1e-3) {
          return `the shading is ${region.off} of its size off the cubes' shared box`;
        }
        if (region.shaded === region.bare) {
          return `the shading draws nothing: ${region.bare} either way`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** A hundred cubes sealed into one body, as a meshed magnet's cells are: one
 *  node, which a click on any cell picks, marked once round every cell
 *  rather than once each, and gone from the picture when hidden. */
async function sealedBody(port, base) {
  await check(
    "a sealed body is picked, outlined and hidden whole",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/out/sealed.html`);
        const drawn = await tab.until(
          `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size`,
          20_000,
        );
        if (!drawn) return "the page never drew";
        const front = await tab.evaluate(`
        const s = window.scene3d;
        const ids = [...s.byObjectId.keys()];
        const node = s.byObjectId.get(ids[0]);
        const camera = node.parent.children
          .find((c) => c.isTransformControlsRoot).controls.camera;
        const rect = ${VIEW}.querySelector("canvas").getBoundingClientRect();
        const cells = node.children.filter((p) => p.isMesh);
        const centre = (mesh) => {
          if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
          mesh.updateWorldMatrix(true, false);
          return mesh.geometry.boundingSphere.center.clone().applyMatrix4(mesh.matrixWorld);
        };
        // the cell nearest the eye: nothing stands in front of its middle
        const near = cells.reduce((a, b) =>
          centre(a).distanceTo(camera.position) <= centre(b).distanceTo(camera.position) ? a : b);
        const q = centre(near).project(camera);
        const at = { x: rect.left + ((q.x + 1) / 2) * rect.width, y: rect.top + ((1 - q.y) / 2) * rect.height };
        const host = ${VIEW}.querySelector("canvas").parentElement;
        window.picked = [];
        host.addEventListener("objectpick", (e) => window.picked.push(e.detail.objectId));
        window.colourAt = (point) => {
          const copy = s.still();
          const scale = copy.width / rect.width;
          return [...copy.getContext("2d").getImageData(
            Math.round((point.x - rect.left) * scale), Math.round((point.y - rect.top) * scale), 1, 1).data].slice(0, 3).join(",");
        };
        return { id: ids[0], nodes: ids.length, cells: cells.length, at };`);
        if (front.nodes !== 1 || front.cells !== 100) {
          return `${front.nodes} nodes, ${front.cells} cells on the first`;
        }
        // one row, what it is made of counted
        const rows = await tab.evaluate(
          `return [...document.querySelectorAll(".magpy-legend-row")].map((r) =>
          [r.querySelector(".magpy-legend-label").textContent, r.querySelector(".magpy-legend-count")?.textContent || ""]);`,
        );
        if (JSON.stringify(rows) !== '[["body","100"]]') {
          return `the legend lists ${JSON.stringify(rows)}`;
        }
        await tab.click(front.at);
        const picked = await tab.evaluate(
          "return window.picked.splice(0)[0] ?? 'nothing'",
        );
        if (picked !== front.id) return `a click on a cell picked ${picked}`;
        const marks = await tab.evaluate(`
        const s = window.scene3d;
        s.highlight([${JSON.stringify(front.id)}]);
        s.still();
        let n = 0;
        s.byObjectId.get(${JSON.stringify(front.id)}).traverse((o) => {
          if (o.userData.outline) n++;
        });
        return n;`);
        // one mark round all hundred
        if (marks !== 1) return `marked by ${marks} parts, not 1`;
        const shown = await tab.evaluate(
          `return colourAt(${JSON.stringify(front.at)})`,
        );
        await tab.evaluate(
          `window.scene3d.highlight([]); window.scene3d.setHidden([${JSON.stringify(front.id)}])`,
        );
        const hidden = await tab.evaluate(
          `return colourAt(${JSON.stringify(front.at)})`,
        );
        if (hidden === shown) return `hidden, it is still drawn (${shown})`;
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** A dipole's arrow keeps its size on screen, as the handles keep theirs,
 *  with the camera four times nearer it or four times farther: measured in
 *  the picture, by its magenta, top to bottom. */
async function glyphs(port, base) {
  await check(
    "a dipole keeps its size on screen, zoomed in or out",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/out/glyphs.html`);
        const drawn = await tab.until(
          `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size`,
          20_000,
        );
        if (!drawn) return "the page never drew";
        const tall = await tab.evaluate(`
        const s = window.scene3d;
        const fitted = s.cameraState();
        const arrow = [...s.byObjectId.values()]
          .flatMap((node) => node.children)
          .find((part) => part.userData.glyph);
        if (!arrow) return null;
        arrow.updateWorldMatrix(true, false);
        const at = arrow.userData.glyph.anchor.clone()
          .applyMatrix4(arrow.matrixWorld).toArray();
        const back = fitted.position.map((p, i) => p - fitted.target[i]);
        const magenta = () => {
          const copy = s.still();
          const { data, width, height } = copy
            .getContext("2d").getImageData(0, 0, copy.width, copy.height);
          let top = height;
          let bottom = -1;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const i = 4 * (y * width + x);
              if (data[i] > 120 && data[i + 2] > 120 && data[i + 1] < 90) {
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
              }
            }
          }
          return bottom - top + 1;
        };
        return [1, 0.25, 4].map((k) => {
          s.setCamera({
            ...fitted,
            target: at,
            position: at.map((p, i) => p + k * back[i]),
          });
          return magenta();
        });`);
        if (!tall) return "no glyph among what is drawn";
        const [fitted, near, far] = tall;
        if (!(fitted > 10)) return `the arrow is ${fitted} pixels tall`;
        for (const [how, pixels] of [
          ["four times nearer", near],
          ["four times farther", far],
        ]) {
          const ratio = pixels / fitted;
          if (ratio < 0.85 || ratio > 1.18) {
            return `${how}, the arrow is ${pixels} pixels tall, not ${fitted}`;
          }
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** A hundred magnets and one on a path, played as motion: the moving one
 *  stays in the batch, which draws it at the step shown -- gone from where
 *  it was, there where it is. */
async function manyRun(port, base) {
  await check("a run among many magnets plays in the batch", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/out/many-run.html`);
      const drawn = await tab.until(
        `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size >= 101`,
        20_000,
      );
      if (!drawn) return "the page never drew";
      const seen = await tab.evaluate(`
        const s = window.scene3d;
        const ids = [...s.byObjectId.keys()];
        const camera = s.byObjectId.get(ids[0]).parent.children
          .find((c) => c.isTransformControlsRoot).controls.camera;
        const rect = ${VIEW}.querySelector("canvas").getBoundingClientRect();
        const traceOf = (id) => s.byObjectId.get(id).children.find((p) => p.isMesh);
        const centre = (trace) => {
          if (!trace.geometry.boundingSphere) trace.geometry.computeBoundingSphere();
          trace.updateWorldMatrix(true, false);
          return trace.geometry.boundingSphere.center.clone().applyMatrix4(trace.matrixWorld);
        };
        // the one above the others: the traveller, looked at in its north
        // half, as grey at its middle as the page round it
        const id = ids.reduce((a, b) => (centre(traceOf(a)).z >= centre(traceOf(b)).z ? a : b));
        const trace = traceOf(id);
        const north = () => centre(trace).add({ x: 0, y: 0, z: 0.0015 });
        const page = (p) => {
          const q = p.clone().project(camera);
          return { x: rect.left + ((q.x + 1) / 2) * rect.width, y: rect.top + ((1 - q.y) / 2) * rect.height };
        };
        const colourAt = (point) => {
          const copy = s.still();
          const scale = copy.width / rect.width;
          return [...copy.getContext("2d").getImageData(
            Math.round((point.x - rect.left) * scale), Math.round((point.y - rect.top) * scale), 1, 1).data].slice(0, 3).join(",");
        };
        const last = 9; // its ten steps
        s.poseFrame(last);
        const there = page(north());
        const thereLast = colourAt(there);
        s.poseFrame(0);
        const here = page(north());
        const hereFirst = colourAt(here), thereFirst = colourAt(there);
        s.poseFrame(last);
        const hereLast = colourAt(here);
        return { batched: trace.layers.mask === 2, left: thereFirst !== thereLast, came: hereFirst !== hereLast };`);
      if (!seen.batched) return "the moving magnet is not batched";
      if (!seen.left) return "at the first step, it is still drawn at its last";
      if (!seen.came) return "at the first step, it is not drawn where it is";
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

/** A dragged sensor redrawn from an answer a round trip old -- the pose the
 *  engine had when it was asked -- stays where the handles hold it: its
 *  pixels carried from that pose to the node's, not drawn back at it, which
 *  on a slow kernel threw them back toward where the drag began. */
async function heldReading(port, base) {
  await check(
    "a dragged sensor's late redraw stays under the handles",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/out/lines.html`);
        const drawn = await tab.until(
          `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size`,
          20_000,
        );
        if (!drawn) return "the page never drew";
        const where = await tab.evaluate(`
        const text = document.getElementById("magpy-scene").textContent.trim();
        const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
        const unzipped = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        const payload = JSON.parse(await new Response(unzipped).text()).state.payload;
        const s = window.scene3d;
        const first = () => {
          let at = null;
          s.byObjectId.get("plane").traverse((part) => {
            if (at || !part.isInstancedMesh) return;
            part.updateWorldMatrix(true, false);
            const m = new part.matrixWorld.constructor();
            part.getMatrixAt(0, m);
            at = m.premultiply(part.matrixWorld).elements[12];
          });
          return at;
        };
        const node = s.byObjectId.get("plane");
        node.position.x += 0.01; // the handles carry it 10 mm, as a drag does
        node.updateMatrixWorld(true);
        const moved = first();
        const host = document.querySelector("canvas").parentElement;
        s.render(host, payload, { keepCamera: true, keep: ["plane"] });
        return { moved, redrawn: first() };`);
        if (Math.abs(where.redrawn - where.moved) > 1e-6) {
          return `the redraw put the pixels at x = ${where.redrawn}, not ${where.moved}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** Two sensors on one colormap, each coloured over what it reads: the
 *  arrows under their colour bar go from one's bar to the other's, and the
 *  switch gives them one scale -- the bar says both, and the far one,
 *  reading a weaker field, takes the darker colours of the scale they now
 *  share, unless the near one is hidden. Again, and each has its own. */
async function sharedScale(port, base) {
  await check(
    "one colour scale for two sensors, by the bar's switch",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/out/shared.html`);
        const drawn = await tab.until(
          `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size`,
          20_000,
        );
        if (!drawn) return "the page never drew";
        const far = `
        let colour = null;
        for (const [id, node] of window.scene3d.byObjectId) {
          if (!id.includes("far")) continue;
          node.traverse((p) => {
            // every pixel's: the weakest may be at the foot of either scale
            if (!colour && p.isInstancedMesh && p.instanceColor) {
              colour = Array.from(p.instanceColor.array, (v) => v.toFixed(3)).join();
            }
          });
        }
        return colour;`;
        const name = `return document.querySelector(".magpy-colorbar-name")?.textContent;`;
        const own = await tab.evaluate(far);
        if (!own) return "no colours on the far sensor's pixels";
        // the arrows under the bar go from one sensor's bar to the other's
        const first = await tab.evaluate(name);
        const cycle = `document.querySelector(".magpy-colorbar-next").click(); return 1`;
        await tab.evaluate(cycle);
        if ((await tab.evaluate(name)) === first) {
          return `the arrows left the bar on "${first}"`;
        }
        await tab.evaluate(cycle);
        if ((await tab.evaluate(name)) !== first) {
          return "the arrows did not come back to the first sensor";
        }
        const flip = `
        const share = document.querySelector(".magpy-colorbar-share");
        if (!share || share.hidden) return false;
        share.click();
        await new Promise((done) => setTimeout(done, 100));
        return true;`;
        if (!(await tab.evaluate(flip))) return "no switch under the bar";
        if (!(await tab.evaluate(name))?.startsWith("2 sensors")) {
          return `the bar says "${await tab.evaluate(name)}", not both sensors`;
        }
        if ((await tab.evaluate(far)) === own) {
          return "on one scale, the far sensor kept the colours of its own";
        }
        // the scale is what is on screen reads: the near one hidden, the far
        // one is alone on it, in its own colours
        const eye = `${row("near")}.querySelector(".magpy-legend-eye").click(); return 1`;
        await tab.evaluate(eye);
        await wait(100);
        if ((await tab.evaluate(far)) !== own) {
          return "the near sensor hidden, the far one kept a scale shared with it";
        }
        await tab.evaluate(eye);
        await wait(100);
        await tab.evaluate(flip);
        if ((await tab.evaluate(far)) !== own) {
          return "switched back, the far sensor did not take its own scale again";
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** A session's payload draws its run's last step, with what no frame
 *  carries: the field lines, the pixels in the colour bar's colours. The
 *  view opens there, the counter saying so; the bar steps aside from the
 *  other steps, which are magpylib's frames in its colours; and back at the
 *  last step the payload is drawn once -- it was drawn, asked for that step
 *  again, and drawn, for as long as the page was open. */
async function colorBarAside(port, base) {
  await check(
    "a run's last step is its payload's, drawn once, with the colour bar",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/out/colour-run.html`);
        const ready = await tab.until(
          `return ${VIEW}?.querySelector("canvas") && window.scene3d`,
          20_000,
        );
        if (!ready) return "the page never drew";
        const counter = `return document.querySelector(".magpy-scene-counter").textContent`;
        const barShown = `return !document.querySelector(".magpy-colorbar")?.hidden`;
        const scrubTo = async (step) => {
          await tab.evaluate(
            `const s = document.querySelector(".magpy-scene-scrub"); s.value = ${step}; s.dispatchEvent(new Event("input")); return 1`,
          );
          await wait(300);
          return tab.evaluate(barShown);
        };
        const opened = await tab.evaluate(counter);
        if (opened !== "10 / 10") return `the counter opens at ${opened}`;
        if (!(await tab.evaluate(barShown)))
          return "no colour bar at the start";
        if (await scrubTo(5)) return "the colour bar stayed at step 6";
        await tab.evaluate(`
          const api = window.scene3d;
          window.drawn = 0;
          for (const name of ["render", "renderFrame"]) {
            const was = api[name];
            api[name] = (...args) => (window.drawn++, was(...args));
          }
          return 1`);
        if (!(await scrubTo(9)))
          return "the colour bar did not come back at the last step";
        await wait(1000);
        const drawn = await tab.evaluate("return window.drawn");
        if (drawn > 2) return `the last step was drawn ${drawn} times in 1.3 s`;
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** A drag's redraws, paced by their cost (drag.mjs): ones that cost most
 *  of a frame keep coming through the drag, at a third of its time or less
 *  -- a machine a quarter as fast as a laptop's drew none after the third
 *  once they crossed 8 ms -- and only ones that freeze the gesture stop. */
async function dragPace(port, base) {
  await check("a drag keeps redrawing at what its redraws cost", async () => {
    const drawn = {};
    for (const cost of [12, 150]) {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/drag-pace.html?cost=${cost}`);
        drawn[cost] = await tab.until("return window.result", 10_000);
        if (!drawn[cost]) return `the ${cost} ms drag never finished`;
      } finally {
        await tab.close();
      }
    }
    const { renders, share } = drawn[12];
    if (renders < 12) return `12 ms redraws: ${renders} in a 1.5 s drag`;
    if (share > 0.45) return `12 ms redraws took ${Math.round(share * 100)}%`;
    if (drawn[150].renders > 3) {
      return `150 ms redraws went on: ${drawn[150].renders} of them`;
    }
    return null;
  });
}

/** A saved page's colour bar, for the sensor the field colours: the top
 *  handle dragged halfway down cuts the range, and the pixels take the
 *  colours stretched over the cut, and a double click on the bar puts them
 *  back as they were; a press on the uncut bar cuts it there. A value typed
 *  into its top end is the cut's, and an arrow key on its foot's handle
 *  moves that a step. */
async function colorBar(port, base) {
  await check("a saved page's colour bar cuts the colours", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/out/lines.html`);
      const drawn = await tab.until(
        `return ${VIEW}?.querySelector("canvas") && window.scene3d?.byObjectId.size`,
        20_000,
      );
      if (!drawn) return "the page never drew";
      const bar = await tab.evaluate(`
        const b = document.querySelector(".magpy-colorbar");
        if (!b || b.hidden) return null;
        const r = b.querySelector(".magpy-colorbar-track").getBoundingClientRect();
        return { x: r.x + r.width / 2, top: r.top, bottom: r.bottom };`);
      if (!bar) return "no colour bar beside a sensor the field colours";
      const colours = `
        const out = [];
        window.scene3d.byObjectId.get("plane").traverse((p) => {
          if (p.isInstancedMesh && p.instanceColor && !out.length) {
            out.push(...Array.from(p.instanceColor.array, (v) => v.toFixed(3)));
          }
        });
        return out.join(",");`;
      const before = await tab.evaluate(colours);
      // from the top down: a share of the bar, its high end at 0
      const y = (f) => bar.top + 1 + f * (bar.bottom - bar.top - 2);
      const mouse = (type, at, clickCount = 1) =>
        tab.send("Input.dispatchMouseEvent", {
          type,
          x: bar.x,
          y: y(at),
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount,
        });
      await tab.hover({ x: bar.x, y: y(0) });
      await mouse("mousePressed", 0);
      for (const at of [0.1, 0.2, 0.3, 0.4, 0.5]) {
        await mouse("mouseMoved", at);
      }
      await mouse("mouseReleased", 0.5);
      if ((await tab.evaluate(colours)) === before) {
        return "the cut left the pixels' colours as they were";
      }
      // a double click, inside the cut: on its band, which a press drags
      for (const clickCount of [1, 2]) {
        await mouse("mousePressed", 0.8, clickCount);
        await mouse("mouseReleased", 0.8, clickCount);
      }
      if ((await tab.evaluate(colours)) !== before) {
        return "a double click did not take the cut away";
      }
      // a press on the bar with no cut brings the nearer handle there
      await mouse("mousePressed", 0.25);
      await mouse("mouseReleased", 0.25);
      if ((await tab.evaluate(colours)) === before) {
        return "a press on the uncut bar brought no handle to it";
      }
      // typed: the top end's value, clicked, takes a field in the bar's unit
      const handles = `document.querySelectorAll(".magpy-colorbar-handle")`;
      const end = await tab.evaluate(`
        const e = document.querySelector(".magpy-colorbar-end");
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, most: parseFloat(e.textContent) };`);
      await tab.click(end);
      const want = Number((end.most * 0.9).toPrecision(3));
      const typed = await tab.evaluate(`
        const box = document.activeElement;
        if (!box?.classList.contains("magpy-colorbar-input")) return "no box to type in";
        box.value = "${want}";
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        // the widget's color_range hands it back to the bar after this task
        await new Promise((done) => setTimeout(done, 50));
        const now = parseFloat(${handles}[0].getAttribute("aria-valuetext"));
        return Math.abs(now - ${want}) < 1e-9 ? "" : "the top handle is at " + now + ", not ${want}";`);
      if (typed) return typed;
      // the keys: a step up on the foot's handle
      const stepped = await tab.evaluate(`
        const foot = ${handles}[1];
        const was = foot.getAttribute("aria-valuetext");
        foot.focus();
        foot.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        await new Promise((done) => setTimeout(done, 50));
        return foot.getAttribute("aria-valuetext") === was ? "an arrow key did not move the handle" : "";`);
      if (stepped) return stepped;
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

async function room(port, base, expected) {
  const all = expected.rows;
  const rings = ["stack", "upper", "lower", "probe"];
  const cases = [
    ["a wide view shows the whole legend", "width=1000&height=420", all],
    ["a narrow view folds the rings", "width=480&height=360", rings],
    [
      "a view drawn before it is on the page still decides",
      "width=480&height=360&detached",
      rings,
    ],
    [
      "a view too small for any of it starts closed",
      "width=220&height=110",
      null,
    ],
    [
      "a scene that grows from one object still gets its first look",
      "width=1000&height=420&grow",
      all,
    ],
  ];
  for (const [label, query, want] of cases) {
    await check(label, async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/room.html?${query}`);
        const result = await tab.until("return window.result");
        if (!result) return "never finished";
        if (want === null) {
          return result.open
            ? `open, showing ${result.rows.join(", ")}`
            : thrown(tab);
        }
        if (!result.open) return "closed";
        if (rounded(result.rows) !== rounded(want)) {
          return `showed ${result.rows.join(", ")}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    });
  }
}

/** A page that refuses the renderer: said in the view, not an empty stage. */
async function blocked(port, base) {
  await check(
    "a page that refuses the renderer says so in the view",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/blocked.html`);
        const result = await tab.until("return window.result");
        if (!result) return "never finished";
        if (!result.said?.includes("could not load")) {
          return `said ${JSON.stringify(result.said)}`;
        }
        return thrown(tab); // an unhandled rejection would show here
      } finally {
        await tab.close();
      }
    },
  );
}

/** Page code: where the drawn things are, as one number -- which moves as a
 *  run goes from step to step, whether the step was drawn afresh or posed. */
const WHERE = `
  let sum = 0;
  for (const node of window.scene3d.byObjectId.values()) {
    node.traverse((o) => {
      if (!o.geometry) return;
      const a = o.geometry.attributes.position.array;
      let total = 0, n = 0;
      for (let i = 0; i < a.length; i += 3) {
        if (Number.isFinite(a[i])) { total += a[i]; n++; }
      }
      sum += (n ? total / n : 0) + o.position.x;
    });
  }
  return Math.round(sum * 1e6) / 1e6;`;

/** Page code: what the drawn things are like, as one number -- which any
 *  change of a step shows in: a vertex that moves, a trace posed elsewhere
 *  or turned. */
const SHAPE = `
  let sum = 0;
  for (const node of window.scene3d.byObjectId.values()) {
    node.traverse((o) => {
      if (o.geometry) {
        const a = o.geometry.attributes.position.array;
        for (let i = 0; i < a.length; i++) {
          if (Number.isFinite(a[i])) sum += Math.abs(a[i]);
        }
      }
      sum += Math.abs(o.position.x) + Math.abs(o.position.y) + Math.abs(o.position.z);
      sum += Math.abs(o.quaternion.x) + Math.abs(o.quaternion.y) + Math.abs(o.quaternion.z);
    });
  }
  return Math.round(sum * 1e6) / 1e6;`;

/** A redraw -- a theme that changed -- must not take a paused run back to
 *  its first step while the counter still names the one it was on. */
async function themeMidRun(port, base) {
  await check("a theme switch keeps the step a run is on", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/out/run.html`);
      const ready = await tab.until(
        `const t = document.querySelector(".magpy-scene-transport"); return t && !t.hidden && ${VIEW}.querySelector("canvas")`,
        20_000,
      );
      if (!ready) return "no transport";
      const scrubTo = async (step) => {
        await tab.evaluate(
          `const s = document.querySelector(".magpy-scene-scrub"); s.value = ${step}; s.dispatchEvent(new Event("input")); return 1`,
        );
        await tab.until(
          `return document.querySelector(".magpy-scene-counter").textContent.startsWith("${step + 1} /")`,
          5000,
        );
        await wait(300);
        return tab.evaluate(WHERE);
      };
      const first = await scrubTo(0);
      const before = await scrubTo(10);
      if (before === first) return "scrubbing did not move the scene";
      await tab.evaluate(`${tool("Theme")}.click()`);
      await wait(800);
      const after = await tab.evaluate(WHERE);
      const counter = await tab.evaluate(
        `return document.querySelector(".magpy-scene-counter").textContent`,
      );
      if (!counter.startsWith("11 /")) return `the counter says ${counter}`;
      if (after === first) return "the picture went back to the first step";
      if (after !== before) return "the picture moved";
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

/** A frame of one run, answered after the view has moved to another, must
 *  neither land on the new scene nor stop it playing. */
async function staleFrame(port, base) {
  await check(
    "a late frame of the last run leaves the new one playing",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/stale-frame.html`);
        const result = await tab.until("return window.result", 15_000);
        if (!result) return "never finished";
        if (!result.moved) return "scrubbing the new run moves nothing";
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** A run whose steps take longer to pose than they last -- a long path, a
 *  big scene -- must still let the page paint, and a repeating one must not
 *  lock it up. Posing is slowed here, by busy-waiting, to make it so. */
async function slowPosing(port, base) {
  await check(
    "a run slower to pose than to play still lets the page paint",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/out/run.html`);
        const ready = await tab.until(
          `const t = document.querySelector(".magpy-scene-transport"); return t && !t.hidden && ${VIEW}.querySelector("canvas")`,
          20_000,
        );
        if (!ready) return "no transport";
        await tab.evaluate(`
        const pose = window.scene3d.poseFrame;
        window.scene3d.poseFrame = (i) => {
          const until = performance.now() + 250; // longer than a step lasts
          while (performance.now() < until) {}
          pose(i);
        };
        window.painted = 0;
        const count = () => { window.painted++; requestAnimationFrame(count); };
        requestAnimationFrame(count);
        // after this call has answered: a run that never yields would
        // otherwise never let it, and the check could not say so itself
        setTimeout(() => ${tool("Play the path")}.click(), 0);
        return 1;`);
        await wait(2500);
        const verdict = await within(
          7500,
          tab.evaluate(
            `return [window.painted, parseInt(document.querySelector(".magpy-scene-counter").textContent)]`,
          ),
          "froze",
        );
        if (verdict === "froze") return "the page stopped answering";
        const [painted, step] = verdict;
        if (painted < 3) return `painted ${painted} times in 2.5 s`;
        if (step < 3) return `stuck at step ${step}`;
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** No kernel to serve a run's frames: the view says so, stops, and shows
 *  the step it is really on. */
async function silent(port, base) {
  await check("a run nobody serves says so, and stops", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/pages/silent.html`);
      const result = await tab.until("return window.result", 15_000);
      if (!result) return "never finished";
      if (!result.said?.includes("No answer from Python")) {
        return `said ${JSON.stringify(result.said)}`;
      }
      if (result.playing) return "still says it is playing";
      if (result.step !== "0") return `the slider says step ${result.step}`;
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

/** A studio webview says when a box that takes typing has the focus, and
 *  when it stops having it -- to another element, to its row being redrawn
 *  under it, to the rest of VS Code -- so the studio's Cmd/Ctrl+Z binding
 *  stands aside for the box's own undo (media/textFocus.mjs). */
async function textFocus(port, base) {
  await check(
    "a webview says when a box that takes typing has the focus",
    async () => {
      const tab = await openTab(port);
      try {
        // a tab in the background gets no focus events: act as the one in front
        await tab.send("Emulation.setFocusEmulationEnabled", { enabled: true });
        await tab.navigate(`${base}/pages/text-focus.html`);
        const result = await tab.until("return window.result", 10_000);
        if (!result) return "never finished";
        const told = [
          "true", // a box
          "true", // a number box: still a box
          "true,false", // a slider
          "true,false", // a read-only box
          "true,false", // a button
          "true,false,true", // a row's box
          "true,false,true,false", // the row redrawn
          "true,false,true,false,true", // a box again
          "true,false,true,false,true,false", // the window left
          "true,false,true,false,true,false,true", // the window back
          "true,false,true,false,true,false,true,false", // the box left
        ];
        const wrong = result.filter(([, said], i) => said !== told[i]);
        if (wrong.length) {
          return wrong
            .map(([step, said]) => `after ${step}: told [${said}]`)
            .join("; ");
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** The panel a script draws into, with its own script: the widget drawn
 *  from the figure the `studio` backend wrote, legend and playback and all,
 *  and re-pointed, not drawn again, when the script runs again. */
async function panel(port, base, expected) {
  await check(
    "a script's figure in the panel is the widget, and plays",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/panel.html`);
        const result = await tab.until("return window.result", 20_000);
        if (!result) return "never finished";
        if (result.rows.join() !== expected.rows.join()) {
          return `the legend showed ${result.rows.join(", ")}`;
        }
        if (result.step < 3) return `stuck at step ${result.step}`;
        if (result.views !== 1) return `${result.views} views after a re-run`;
        const [before, after, room] = result.widths;
        if (after !== before || after > room) {
          return `the figure is ${before} then ${after} px wide in a ${room} px panel`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
  await check(
    "a re-run in the panel keeps what the user hid and the theme they chose",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/panel.html`);
        const result = await tab.until("return window.result", 20_000);
        if (!result) return "never finished";
        const [hidden, after] = result.hidden;
        if (!hidden.length) return "hiding a row hid nothing";
        if (after.join() !== hidden.join()) {
          return `hid ${hidden.join(", ")}; after the re-run, ${after.join(", ") || "nothing"}`;
        }
        if (!result.theme.startsWith("Theme: light")) {
          return `the theme button says ${result.theme}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
  await check(
    "a picture taken in the panel is handed to VS Code to save",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/panel.html`);
        const result = await tab.until("return window.result", 20_000);
        if (!result) return "never finished";
        if (!result.saved) return "nothing was handed over";
        if (!result.saved.png || !result.saved.filename.endsWith(".png")) {
          return `handed ${JSON.stringify(result.saved)}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
  await check(
    "an out-of-date panel's badge sits above the widget, not on its legend",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/panel.html`);
        const result = await tab.until("return window.result", 20_000);
        if (!result) return "never finished";
        const { shown, below, overflow } = result.stale;
        if (!shown) return "no badge";
        if (below < 0) return `the badge covers the widget by ${-below} px`;
        if (overflow > 0) return `the widget runs ${overflow} px off the panel`;
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
  await check("a panel that cannot load the widget says so", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/pages/panel.html?missing`);
      const result = await tab.until("return window.result", 20_000);
      if (!result) return "never finished";
      if (!result.failed?.startsWith("The view could not be drawn")) {
        return `the panel says ${JSON.stringify(result.failed)}`;
      }
      return null;
    } finally {
      await tab.close();
    }
  });
}

/** The panel's renderer, mid-drag: a held sensor that draws its own reading
 *  is redrawn from the scene on the node the handles are on, and any other
 *  held object is left exactly as the drag carried it. */
async function heldReadings(port, base) {
  await check(
    "a sensor dragged in the panel shows what it reads where it is",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/held-reading.html`);
        const result = await tab.until("return window.result", 20_000);
        if (!result) return "never finished";
        const { sensor, magnet, partial } = result;
        if (!sensor.sameNode) return "the dragged sensor's node was replaced";
        if (!sensor.redrawn)
          return "the dragged sensor's arrows were not redrawn";
        if (!sensor.moved)
          return "the redrawn arrows are not where the engine put them";
        if (!magnet.sameNode || !magnet.untouched) {
          return "a dragged magnet was redrawn, which would end its drag";
        }
        // a drag's later step draws only what it moves
        if (!partial.stillKept) return "a magnet standing by was redrawn";
        if (!partial.magnetRedrawn || !partial.fieldRedrawn) {
          return `what the step moved was not redrawn: ${JSON.stringify(partial)}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** The studio panel: the notebook widget, run by the panel's own
 *  studioView.mjs against a stub of VS Code. What it tells the host is what
 *  the old panel told it -- a pick, a drag's start, one pose in flight with
 *  the newest waiting and the newest scene drawn, the release -- and
 *  hiding goes to the host as an edit, Cmd+Z is left to VS Code's keybinding,
 *  a refresh asks the engine again, the field lines' eye is an edit too, and
 *  Chart mode draws the chart. */
async function studioDrag(port, base) {
  let seen = null;
  const page = async () => {
    if (seen) return seen;
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/pages/studio-drag.html`);
      const result = await tab.until("return window.result", 30_000);
      seen = { result, problem: result ? thrown(tab) : "never finished" };
      return seen;
    } finally {
      await tab.close();
    }
  };
  const said = (messages) =>
    messages
      .map((m) => m.type + (m.method ? `:${m.method}` : "") + (m.x ?? ""))
      .join(" ");

  await check(
    "a drag in the studio panel says what it did, in order",
    async () => {
      const { result, problem } = await page();
      if (!result) return problem;
      const { dragged, kept } = result;
      const shown = said(dragged);
      if (dragged[0]?.type !== "dragStart" || dragged[0].objectId !== "probe") {
        return `it began: ${shown}`;
      }
      const xs = dragged
        .filter((m) => m.type === "previewTransform")
        .map((m) => m.x);
      if (xs.join() !== "1,10,11,15") {
        return `previews at ${xs.join(", ")}, not 1, 10, 11, 15: ${shown}`;
      }
      // one pose in flight: each answered before the next is sent, and the
      // engine's answer to the last drawn before the release
      for (let i = 1; i < dragged.length; i++) {
        if (dragged[i].type !== "previewTransform") continue;
        const since = dragged
          .slice(0, i)
          .map((m) => m.type)
          .lastIndexOf("previewTransform");
        if (since < 0) continue;
        if (!dragged.slice(since + 1, i).some((m) => m.type === "answered")) {
          return `two previews in flight at once: ${shown}`;
        }
      }
      const types = dragged.map((m) => m.type);
      if (!types.slice(types.lastIndexOf("answered")).includes("redraw")) {
        return `the last answer was not drawn: ${shown}`;
      }
      // one trip a step: the pose asks for the scene, which comes back with
      // the answer, and the view never asks for it on its own
      const previews = dragged.filter((m) => m.type === "previewTransform");
      if (previews.some((m) => m.scene !== true)) {
        return `a preview did not ask for the scene: ${shown}`;
      }
      if (dragged.some((m) => m.method === "get_scene")) {
        return `the view asked for the scene mid-drag: ${shown}`;
      }
      const last = dragged
        .filter((m) => m.type !== "redraw" && m.type !== "answered")
        .at(-1);
      if (last?.type !== "transformObjects" || last.x !== 16) {
        return `it ended: ${shown}`;
      }
      if (!kept.length || kept.some((keep) => keep?.join() !== "probe")) {
        return `the redraws kept ${JSON.stringify(kept)}`;
      }
      return problem;
    },
  );
  await check(
    "the studio panel tells the sidebar, and hides as an edit",
    async () => {
      const { result, problem } = await page();
      if (!result) return problem;
      const { editing, picked, keyed, isolated, refreshed, lined, chart } =
        result;
      if (!editing) return "the panel shows no editing column";
      const picks = picked.filter((m) => m.type === "selectObject");
      if (picks.length !== 1 || picks[0].objectId !== "probe") {
        return `a pick told the host: ${said(picked)}`;
      }
      const hid = keyed.find((m) => m.type === "setVisible");
      if (hid?.hide?.join() !== "probe" || hid.show?.length) {
        return `H told the host: ${said(keyed)}`;
      }
      const told = isolated.filter((m) => m.type === "setVisible");
      if (
        told.length !== 1 ||
        told[0].hide?.join() !== "magnet" ||
        told[0].show?.join() !== "probe"
      ) {
        return `shift+H on the hidden probe told the host: ${said(isolated)}`;
      }
      const undos = keyed.filter((m) => m.type === "undo").length;
      if (undos !== 1) {
        return `${undos} undos for Cmd+Z and the button -- Cmd+Z is VS Code's: ${said(keyed)}`;
      }
      const switched = lined.filter((m) => m.type === "setFieldLines");
      if (switched.length !== 1 || switched[0].on !== true) {
        return `the field lines' eye told the host: ${said(lined)}`;
      }
      const asked = refreshed.map((m) => m.method);
      if (!asked.includes("get_scene") || !asked.includes("object_tree")) {
        return `a refresh asked for ${asked.join(", ")}`;
      }
      if (!chart.drawn || !chart.viewHidden) {
        return `Chart mode: ${JSON.stringify(chart)}`;
      }
      return problem;
    },
  );
}

/** The pencil: a read-only view of named objects offers one, and pressing
 *  it saves `editable` for python and brings the edit bar out; a saved page
 *  and a view of nothing offer none. W on a view that offers the pencil is
 *  the pencil, and comes up moving; elsewhere it does nothing. A view drawn
 *  in millimetres keeps looking at what it looked at when the session's
 *  scene comes in metres. A press python cannot answer with a session is put
 *  back, and the view says why. */
async function pencil(port, base) {
  await check("the pencil puts a read-only view into editing", async () => {
    const tab = await openTab(port);
    try {
      for (const [query, offered] of [
        ["", true],
        ["?standalone", false],
        ["?empty", false],
        ["?never", false],
        ["?millimetres", true],
        ["?refused", true],
      ]) {
        const page = query || "a plain view";
        await tab.navigate(`${base}/pages/pencil.html${query}`);
        const result = await tab.until("return window.result", 20_000);
        if (!result) return `${page}: never finished`;
        const { before, after, again, byKey, saved, notice } = result;
        if (before.pencil !== offered) {
          return `${page} ${offered ? "offered no pencil" : "offered a pencil"}`;
        }
        if (before.bar) return `${page}: the edit bar was out before a press`;
        if (query === "?refused") {
          // python could not make the session: the pencil back up, and why
          if (after.bar || after.pressed !== "false") {
            return `${page}: ${JSON.stringify(after)}`;
          }
          if (!notice.startsWith("Not editable — ")) {
            return `${page}: it said ${JSON.stringify(notice)}`;
          }
          continue;
        }
        if (!offered) {
          if (saved.length || byKey.bar) return `${page}: W did something`;
          continue;
        }
        if (!after.bar || !after.pencil || after.pressed !== "true") {
          return `after the press: ${JSON.stringify(after)}`;
        }
        if (!notice.includes("Editing"))
          return `it said ${JSON.stringify(notice)}`;
        if (again.bar || again.pressed !== "false") {
          return `pressed again: ${JSON.stringify(again)}`;
        }
        if (!byKey.bar || byKey.pressed !== "true" || byKey.moving !== "true") {
          return `W on the read-only view: ${JSON.stringify(byKey)}`;
        }
        if (saved.join() !== "true,false,true") {
          return `the presses saved ${saved.join()}`;
        }
        // the same magnet, in metres: the camera follows it, and stands
        // where it stood a thousandth as far out
        const [was, now] = result.cameras.map(({ position, target }) =>
          Math.hypot(...position.map((p, i) => p - target[i])),
        );
        const shrunk = query === "?millimetres" ? 1e-3 : 1;
        if (Math.abs(now / was / shrunk - 1) > 0.01) {
          return `${page}: the camera went from ${was} to ${now} away`;
        }
      }
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

/** The variables panel: an editable view of a scene with variables offers
 *  it among its tools, and not a saved page or a view with its handles away.
 *  Open, it lists a row per variable with the control its bounds call for;
 *  a slider drag asks the session as the studio's Variables view does --
 *  the undo group opened, previews with the scene redrawn between, the
 *  release committed once, the group closed, the rows read back -- and a
 *  dropdown commits its choice once. The handles put away take it along. A
 *  scene's variants are a toggle each above the rows, or a dropdown when
 *  they are many, saying which one the values are in; one press asks the
 *  session once, and the rows are read back. */
async function variablesPanel(port, base) {
  await check("the variables panel edits through the session", async () => {
    const tab = await openTab(port);
    try {
      for (const [query, offered] of [
        ["?standalone", false],
        ["?readonly", false],
        ["", true],
      ]) {
        const page = query || "an editable view";
        await tab.navigate(`${base}/pages/variables.html${query}`);
        const result = await tab.until("return window.result", 20_000);
        if (!result) return `${page}: never finished`;
        if (result.offered !== offered) {
          return `${page} ${offered ? "offered no variables" : "offered variables"}`;
        }
        if (!offered) continue;
        const { rows, drag, redrawn, chose, afterPencil, variantRow } = result;
        if (variantRow)
          return "a scene with no variants offered a dropdown of them";
        const names = rows.map((r) => r.name.split(" ")[0]).join();
        if (names !== "n,r,axis,free,half") return `the rows were ${names}`;
        const by = (name) => rows.find((r) => r.name.split(" ")[0] === name);
        if (!by("n").slider) return "n, a count with a range, has no slider";
        if (!by("axis").select) return "axis, a choice, has no dropdown";
        if (by("free").slider || by("free").select) {
          return "free, with no range, got a control";
        }
        if (by("half").slider || by("half").select || !by("half").expression) {
          return `half, an expression, was ${JSON.stringify(by("half"))}`;
        }
        const said = drag.join(" ");
        if (drag[0] !== "begin_interaction") return `the drag began: ${said}`;
        const sets = drag.filter((d) => d.startsWith("set_variable"));
        if (sets.at(-1) !== "set_variable=16") {
          return `the release committed ${sets.at(-1)}: ${said}`;
        }
        if (!sets.slice(0, -1).every((s) => s.startsWith("set_variable*"))) {
          return `a value under the pointer was no preview: ${said}`;
        }
        if (!redrawn) return `nothing redrawn between the values: ${said}`;
        const closed = drag.indexOf("end_interaction");
        if (closed < 0 || closed < drag.indexOf("set_variable=16")) {
          return `the group closed before the release: ${said}`;
        }
        if (!drag.slice(closed).includes("get_variables")) {
          return `the rows were not read back after the release: ${said}`;
        }
        if (JSON.stringify(chose) !== JSON.stringify([["axis", "x", false]])) {
          return `the dropdown sent ${JSON.stringify(chose)}`;
        }
        if (afterPencil.button || afterPencil.panel) {
          return `the panel stayed when the handles went away: ${JSON.stringify(afterPencil)}`;
        }
      }
      // a variable a step took over: one restore in the dock's title line,
      // none in the rows, and the restoring one step to undo
      await tab.navigate(`${base}/pages/variables.html?taken`);
      const taken = await tab.until("return window.result", 20_000);
      if (!taken) return "?taken: never finished";
      if (!taken.restore?.inHead || taken.restore.inRows) {
        return `the restore was ${JSON.stringify(taken.restore)}`;
      }
      if (JSON.stringify(taken.restored) !== JSON.stringify(["r"])) {
        return `restore sent ${JSON.stringify(taken.restored)}`;
      }
      const grouped = taken.grouped;
      if (
        grouped[0] !== "begin_interaction" ||
        !grouped.includes("end_interaction")
      ) {
        return `restore was not one step: ${grouped.join(" ")}`;
      }
      // variants: a toggle each above the rows while they are few, none
      // pressed to start; one press asks the session once, settled, and the
      // rows are read back; a press on the pressed one asks nothing
      await tab.navigate(`${base}/pages/variables.html?variants`);
      const few = (await tab.until("return window.result", 20_000))?.variants;
      if (!few) return "?variants: never finished";
      if (!few.shown) return "the variants were not offered";
      if (few.toggles.join() !== "compact,wide" || few.dropdown.length) {
        return `two variants were ${JSON.stringify(few)}`;
      }
      if (few.before.length) return `${few.before} was pressed to start`;
      if (JSON.stringify(few.used) !== JSON.stringify([["wide", false]])) {
        return `the toggle sent ${JSON.stringify(few.used)}`;
      }
      if (!few.readBack) return "the rows were not read back after a press";
      if (few.after.join() !== "wide" || few.n !== "16") {
        return `after wide, ${few.after} was pressed and n was ${few.n}`;
      }
      if (few.pressedAgain) return "a press on the pressed variant asked again";
      if (few.disabled.length) return `${few.disabled} was offered as unusable`;
      // one the scene cannot use as it stands: shown, not offered, and a
      // press on it asks nothing
      await tab.navigate(`${base}/pages/variables.html?variants&broken`);
      const broken = (await tab.until("return window.result", 20_000))
        ?.variants;
      if (!broken) return "?broken: never finished";
      if (broken.disabled.join() !== "wide") {
        return `the unusable variants were ${broken.disabled.join() || "none"}`;
      }
      if (broken.used.length || broken.n !== "10") {
        return `a press on an unusable variant sent ${JSON.stringify(broken.used)}`;
      }
      // many: a dropdown instead, saying the values are in none
      await tab.navigate(`${base}/pages/variables.html?many`);
      const many = (await tab.until("return window.result", 20_000))?.variants;
      if (!many) return "?many: never finished";
      if (many.toggles.length || many.dropdown.length !== 7) {
        return `six variants were ${JSON.stringify(many)}`;
      }
      if (many.before !== "—")
        return `the values were said to be in ${many.before}`;
      if (JSON.stringify(many.used) !== JSON.stringify([["n16", false]])) {
        return `the dropdown sent ${JSON.stringify(many.used)}`;
      }
      if (many.after !== "n16" || many.n !== "16") {
        return `after n16, the dropdown said ${many.after} and n ${many.n}`;
      }
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

/** The object panel: toggled from the column, it shows the selection's
 *  parameters and pose and follows the selection; a typed value is read
 *  through the engine and set with `define`, a bare name is set as an
 *  expression and what the engine made is said; the style tree is folded
 *  and unread until opened, then a colour set goes through the engine;
 *  opening it closes the variables panel, and the handles put away take it
 *  along. The dock it opens in is a column beside the view, named for the
 *  panel, with the readout put away; a 480px view has it as a sheet below,
 *  the view keeping its height and the widget growing by the sheet. */
async function objectPanel(port, base) {
  await check(
    "the object panel edits the selection through the session",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/inspector.html`);
        const result = await tab.until("return window.result", 20_000);
        if (!result) return "never finished";
        const {
          offered,
          header,
          rows,
          poseTitle,
          oneAtATime,
          typed,
          named,
          notice,
          afterPencil,
          style,
          layout,
        } = result;
        if (!offered) return "no object toggle with the handles out";
        if (header !== "m") return `the header said ${JSON.stringify(header)}`;
        for (const name of ["dimension", "polarization"]) {
          if (!rows.includes(name))
            return `no row for ${name}: ${rows.join(", ")}`;
        }
        if (poseTitle !== "pose (m, °)")
          return `the pose said ${JSON.stringify(poseTitle)}`;
        if (!oneAtATime) return "the variables panel stayed open beside it";
        const call = (c) => `${c.method}(${JSON.stringify(c.params)})`;
        if (
          typed?.method !== "set_param" ||
          typed.params.name !== "dimension" ||
          typed.params.value[0] !== 12 ||
          typed.params.define !== true
        ) {
          return `a typed value sent ${typed ? call(typed) : "nothing"}`;
        }
        if (
          named?.method !== "set_transform" ||
          named.params.position?.[0] !== "=reach" ||
          named.params.define !== true
        ) {
          return `a bare name sent ${named ? call(named) : "nothing"}`;
        }
        if (!notice.includes("reach made"))
          return `it said ${JSON.stringify(notice)}`;
        if (!style?.folded) return "the style tree was open unasked";
        if (!style.lazy) return "the style tree was read before it was opened";
        for (const name of ["color", "opacity", "label"]) {
          if (!style.rows.includes(name))
            return `no style row for ${name}: ${style.rows.join(", ")}`;
        }
        if (
          style.edit?.method !== "apply_edit" ||
          style.edit.params.path !== "color" ||
          style.edit.params.value !== "#ff0000"
        ) {
          return `a colour set sent ${style.edit ? call(style.edit) : "nothing"}`;
        }
        if (style.resetAll?.before)
          return "a reset was offered with only the label set";
        if (!style.resetAll?.shown)
          return "the title line offered no reset for the colour set";
        if (JSON.stringify(style.reset) !== JSON.stringify(["color"])) {
          return `the reset sent ${JSON.stringify(style.reset)}`;
        }
        if (
          style.resetGrouped[0] !== "begin_interaction" ||
          !style.resetGrouped.includes("end_interaction")
        ) {
          return `the reset was not one step: ${style.resetGrouped.join(" ")}`;
        }
        if (afterPencil.button || afterPencil.panel) {
          return `the panel stayed when the handles went away: ${JSON.stringify(afterPencil)}`;
        }
        if (layout?.narrow || !layout?.beside) {
          return `the dock was not a column beside the view: ${JSON.stringify(layout)}`;
        }
        if (layout.title !== "Object")
          return `the dock said ${JSON.stringify(layout.title)}`;
        if (layout.readout) return "the readout stayed under the object panel";
        if (layout.viewHeight !== layout.height) {
          return `the view did not keep its height beside the column: ${layout.viewHeight} of ${layout.height}`;
        }
        // a narrow view: the sheet below, within the cell's height
        await tab.navigate(`${base}/pages/inspector.html?narrow`);
        const sheet = (await tab.until("return window.result", 20_000))?.layout;
        if (!sheet) return "narrow: never finished";
        if (!sheet.narrow || !sheet.below) {
          return `a 480px view had no sheet below it: ${JSON.stringify(sheet)}`;
        }
        if (
          sheet.viewHeight !== sheet.height ||
          sheet.widgetHeight <= sheet.height
        ) {
          return `the sheet did not grow the widget under a whole view: ${JSON.stringify(sheet)}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** A property the parts of a sealed collection differ in, as the engine
 *  says (`mixed`): its field shows no value, and says why. */
async function objectPanelMixed(port, base) {
  await check("a sealed collection's mixed style says so", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/pages/inspector.html?mixed`);
      const result = await tab.until("return window.result", 20_000);
      if (!result) return "never finished";
      const { opacity } = result.style;
      if (opacity?.placeholder !== "mixed" || opacity.value !== "") {
        return `the opacity field showed ${JSON.stringify(opacity)}`;
      }
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

/** While python is slow to answer, a ring of current runs round the view --
 *  drawn and turning in a shadow root, where marimo draws a widget; a quick
 *  answer -- a drag's, at pointer rate -- never shows it. A slider or
 *  a drag answered a little too slowly to keep up falls behind the pointer,
 *  and rings once, until it catches up. */
async function busyRing(port, base) {
  await check(
    "a slow answer rings the view, a quick one does not",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/busy.html`);
        const result = await tab.until("return window.result", 20_000);
        if (!result) return "never finished";
        const { exists, quick, early, waiting, answeredAfter, behind, late } =
          result;
        if (!exists) return "no ring";
        if (quick) return "a quick answer showed the ring";
        if (early) return "the ring came on before the answer was late";
        if (!waiting) return "a slow answer did not show the ring";
        if (!result.painted) return "the ring was on and drew nothing";
        if (!result.turns) return "the ring was on and stood still";
        if (answeredAfter > 1600)
          return `the ring stayed on ${answeredAfter} ms`;
        for (const [gesture, flips] of Object.entries(behind)) {
          if (flips !== "on,off")
            return `a ${gesture} behind the pointer rang ${flips || "never"}`;
        }
        if (!late.said.startsWith("No answer from Python"))
          return `python busy past 4 s: it said ${JSON.stringify(late.said)}`;
        if (!late.waiting) return "the ring went out when the view said so";
        const left = Object.entries(late.after).filter(([, on]) => on);
        if (left.length)
          return `after the late answer: ${JSON.stringify(Object.fromEntries(left))}`;
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** A panel of its own (`ScenePanel`): the variables kind lists the rows,
 *  sends a slider's values under the pointer as previews and the release as
 *  the edit, and reads the rows again when the view's revision moves; the
 *  object kind shows the selection and follows it. */
async function panelWidget(port, base) {
  await check("a panel of its own edits through the view", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/pages/own-panel.html`);
      const result = await tab.until("return window.result", 20_000);
      if (!result) return "variables: never finished";
      if (result.title !== "Variables")
        return `the title said ${JSON.stringify(result.title)}`;
      if (result.rows.join() !== "n,r,axis,free,half")
        return `the rows were ${result.rows.join()}`;
      const said = result.drag.join(" ");
      if (result.drag.at(-1) !== "=14")
        return `the release committed ${result.drag.at(-1)}: ${said}`;
      if (!result.drag.slice(0, -1).every((d) => d.startsWith("*"))) {
        return `a value under the pointer was no preview: ${said}`;
      }
      if (!result.reread)
        return "the rows were not read again when the view moved on";
      await tab.navigate(`${base}/pages/own-panel.html?object`);
      const object = await tab.until("return window.result", 20_000);
      if (!object) return "object: never finished";
      if (object.title !== "Object")
        return `the object title said ${JSON.stringify(object.title)}`;
      if (!object.rows.includes("dimension"))
        return `no dimension row: ${object.rows.join(", ")}`;
      if (object.followed !== "ring")
        return `the panel showed ${JSON.stringify(object.followed)} after the selection moved`;
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

/** An editable view against a fake kernel: a drag goes to the session
 *  as the studio's panel sends one -- the undo group opened, each pose
 *  recorded with the scene redrawn between, the release, the group closed --
 *  the keys pick the handles and undo, and a kernel that never answers is
 *  said rather than waited on. */
async function editing(port, base) {
  const run = async (query) => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/pages/edit.html${query}`);
      const result = await tab.until("return window.result", 20_000);
      return { result, problem: result ? thrown(tab) : "never finished" };
    } finally {
      await tab.close();
    }
  };
  for (const [query, name] of [
    ["", "a studio's view edits through its kernel"],
    ["?editor", "a studio's view edits through a host's own editor"],
  ]) {
    await editsThrough(query, name);
  }
  async function editsThrough(query, name) {
    await check(name, async () => {
      const { result, problem } = await run(query);
      if (!result) return problem;
      const { buttons } = result;
      // the edits, in order: a read on the way -- the readout asking what a
      // typed value means -- is not one of them
      const asked = result.asked.filter((a) => a.method !== "quantity");
      const said = asked.map((a) => a.method + (a.x ?? "")).join(" ");
      if (!buttons.shown) return "no editing buttons";
      if (buttons.turned !== "true" || buttons.moved !== "true") {
        return `E and W left the buttons at ${buttons.turned}, ${buttons.moved}`;
      }
      if (!buttons.local.includes("object's own (L")) {
        return `L left the axes button saying ${buttons.local}`;
      }
      if (!buttons.world.includes("world's (L")) {
        return `L again left the axes button saying ${buttons.world}`;
      }
      if (!buttons.refused.notice?.includes("no single size")) {
        return `resizing a sensor said ${JSON.stringify(buttons.refused.notice)}`;
      }
      if (buttons.resizing !== "true") return "R did not resize the magnet";
      if (asked[0]?.method !== "begin_interaction") return `it began: ${said}`;
      // the drag, its release and an undo -- then the value typed in the
      // readout, sent as a release of its own
      const typed = asked.findIndex(
        (a) => a.method === "apply_edits" && a.x === 0.5,
      );
      if (typed < 0)
        return `a value typed in the readout was not sent: ${said}`;
      const drag = asked.slice(0, typed);
      const poses = drag
        .filter((a) => a.method === "apply_edits")
        .map((a) => a.x);
      if (poses[0] !== 1 || poses.at(-1) !== 6 || poses.length > 4) {
        return `poses at ${poses.join(", ")}: ${said}`;
      }
      // the scene asked for, in a preview's own answer or in a message of
      // its own: the kernel editor spares the message, a host's own asks
      if (!drag.some((a) => a.method === "get_scene" || a.scene)) {
        return `nothing redrawn around the drag: ${said}`;
      }
      const tail = drag.slice(-3).map((a) => a.method + (a.x ?? ""));
      if (tail.join() !== "apply_edits6,end_interaction,undo") {
        return `it ended: ${said}`;
      }
      const { readout, keys } = result;
      if (readout.head !== "probe · position" || readout.boxes !== 3) {
        return `the readout showed ${JSON.stringify(readout)}`;
      }
      if (readout.typedIn !== "true") {
        return "E typed into the readout changed the handles";
      }
      if (!keys.includes("W · E · R · P") || !keys.includes("⌘Z")) {
        return `the key list said ${JSON.stringify(keys.slice(0, 80))}`;
      }
      const { probeAlone, magnetAlone, everything } = result.isolating;
      if (
        probeAlone.join() !== "magnet" ||
        magnetAlone.join() !== "probe" ||
        everything.length
      ) {
        return `shift+H hid ${JSON.stringify(result.isolating)}`;
      }
      if (asked.some((a) => a.method.startsWith("kernel:"))) {
        return `a host's editor was passed over for the kernel: ${said}`;
      }
      const reset = asked.some((a) => a.method === "reset");
      if (!query && !reset) return `the revert button sent nothing: ${said}`;
      if (query && reset) return "a host's editor without a reset was sent one";
      return problem;
    });
  }
  await check(
    "a value typed in the readout is sent once, and Escape sends nothing",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/edit.html?typing`);
        if (!(await tab.until("return window.ready", 20_000))) {
          return "never ready";
        }
        const BOXES = `document.querySelectorAll(".magpy-scene-readout input")`;
        const shown = await tab.evaluate(`return ${BOXES}[0]?.value`);
        if (shown === undefined) return "no readout";
        /** Typed as a person types it: the keys are the browser's own. */
        const type = async (text, key) => {
          await tab.evaluate(
            `const box = ${BOXES}[0]; box.focus(); box.select();`,
          );
          await tab.send("Input.insertText", { text });
          const code = { Enter: 13, Escape: 27 }[key];
          await tab.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code: key,
            windowsVirtualKeyCode: code,
            ...(key === "Enter" ? { text: "\r" } : {}),
          });
          await tab.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code: key,
            windowsVirtualKeyCode: code,
          });
          await wait(300);
        };
        await type("0.5", "Enter");
        await type("0.7", "Escape");
        const sent = await tab.evaluate(
          `return window.asked.filter((a) => a.method === "apply_edits").map((a) => a.position)`,
        );
        if (sent.map((position) => position[0]).join() !== "0.5") {
          return `the readout sent ${JSON.stringify(sent)}`;
        }
        // y was left alone: sent as the scene has it, not as the box shows it
        if (sent[0][1] !== 0.00012345) {
          return `typing x sent y as ${sent[0][1]}`;
        }
        const after = await tab.evaluate(`return ${BOXES}[0].value`);
        if (after !== shown) {
          return `Escape left the box at ${after}, not the ${shown} the scene says`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
  await check(
    "a studio's view says when no kernel answers an edit",
    async () => {
      const { result, problem } = await run("?silent");
      if (!result) return problem;
      if (!result.notice?.startsWith("No answer from Python for this edit")) {
        return `it said ${JSON.stringify(result.notice)}`;
      }
      return problem;
    },
  );
}

/** Page code: what marks the selection, by what it is hung on -- a shape's
 *  mark, a path's line and markers in the accent colour, or markers that
 *  are not a path's, which may be coloured by the field -- and how far the
 *  parts on shapes reach, in scene units. */
const OUTLINED = `
  const found = { shapes: 0, shapeSpan: 0, paths: 0, markers: 0 };
  for (const node of window.scene3d.byObjectId.values()) {
    node.traverse((part) => {
      if (!part.userData.outline) return;
      const on = part.parent;
      if (on.isMesh) {
        found.shapes++;
        part.updateMatrixWorld(true);
        part.geometry.computeBoundingBox();
        const box = part.geometry.boundingBox.clone().applyMatrix4(part.matrixWorld);
        const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
        found.shapeSpan = Math.max(found.shapeSpan, span);
      } else if (on.parent?.userData.path) {
        found.paths++;
      } else if (part.isPoints) {
        found.markers++;
      }
    });
  }
  return found;`;

/** A selection marks the object and draws its path apart. A box round all
 *  that was drawn for an object went round its path too: a ring of magnets
 *  on an orbit came out as a cage of boxes the size of the ring. */
async function selection(port, base) {
  await check(
    "a selection outlines the shape and draws its path apart",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/out/mix.html`);
        const ready = await tab.until(
          `return ${VIEW}?.querySelector("canvas") && document.querySelectorAll(".magpy-legend-row").length && window.scene3d`,
          20_000,
        );
        if (!ready) return "the page never drew";
        const pick = async (label) => {
          await tab.evaluate(
            `${row(label)}.querySelector(".magpy-legend-label").click()`,
          );
          await wait(300);
          return tab.evaluate(OUTLINED);
        };
        const scrubTo = async (step) => {
          await tab.evaluate(
            `const s = document.querySelector(".magpy-scene-scrub"); s.value = ${step}; s.dispatchEvent(new Event("input")); return 1`,
          );
          await wait(500);
          return tab.evaluate(OUTLINED);
        };

        // twelve unit cubes on an orbit of radius 3: edges no wider than a
        // cube, and twelve paths in the accent colour
        const ring = await pick("ring");
        if (!ring.shapes) return "nothing outlines the magnets";
        if (ring.shapeSpan > 2)
          return `an outline ${ring.shapeSpan} across, for unit cubes`;
        if (ring.paths < 12) return `${ring.paths} parts mark the twelve paths`;
        if (ring.markers)
          return `${ring.markers} markers recoloured that are no path's`;

        // carried along a run, and not piled up by it
        const later = await scrubTo(15);
        if (later.shapes !== ring.shapes || later.paths !== ring.paths) {
          return `at step 15 ${JSON.stringify(later)}, from ${JSON.stringify(ring)}`;
        }
        if (later.shapeSpan > 2)
          return `at step 15 an outline ${later.shapeSpan} across`;

        // a probe whose pixels show the field: its body and its path are
        // marked, its pixels -- coloured by what they read -- are not
        const probe = await pick("probe");
        if (!probe.shapes || !probe.paths)
          return `the probe: ${JSON.stringify(probe)}`;
        if (probe.markers)
          return `${probe.markers} parts recolour the probe's pixels`;
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );

  await check(
    "a selected collection outlines the copies its patterns made",
    async () => {
      const tab = await openTab(port);
      try {
        // twelve magnets: a row of four tiles, the row three times over --
        // the copies drawn on the nodes of the collections that were patterned
        await tab.navigate(`${base}/pages/outline.html#array`);
        if (!(await tab.until("return window.shown", 20_000))) {
          return "never drew";
        }
        await wait(300);
        const found = await tab.evaluate(OUTLINED);
        const magnets = found.shapes; // one mark each
        return magnets === 12
          ? thrown(tab)
          : `${magnets} of the twelve magnets outlined`;
      } finally {
        await tab.close();
      }
    },
  );

  await check("the legend counts a pattern's copies", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/pages/outline.html#array`);
      if (!(await tab.until("return window.shown", 20_000))) {
        return "never drew";
      }
      // Twelve magnets drawn, one listed: the tile's row says how many it
      // stands for, and the collection holding it all counts twelve.
      const counts = await tab.evaluate(
        `const rows = [...document.querySelectorAll(".magpy-legend-row")];
         return rows.map((r) => [r.querySelector(".magpy-legend-label").textContent, r.querySelector(".magpy-legend-count")?.textContent || ""]);`,
      );
      const top = counts[0];
      const sources = counts.filter(([, count]) => count.startsWith("×"));
      if (top[1] !== "12") return `the top row counts ${JSON.stringify(top)}`;
      return sources.length
        ? null
        : `no row says what its pattern makes: ${JSON.stringify(counts)}`;
    } finally {
      await tab.close();
    }
  });

  await check(
    "a path stays where the edit leaves it while its object is dragged",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/outline.html?scene=pathed#mover`);
        if (!(await tab.until("return window.shown", 20_000))) {
          return "never drew";
        }
        // Turned where it stands, the magnet keeps its path where it is;
        // moved, the path goes with it; resized, the path keeps its size.
        const wrong = [];
        for (const [mode, act, want] of [
          ["rotate", "node.rotateZ(0.6)", "still"],
          ["translate", "node.position.x += 0.01", "carried"],
          ["scale", "node.scale.set(2, 1, 1)", "still"],
        ]) {
          await wait(400); // the redraw after the last one's release
          const got = await tab.evaluate(DRAGGED(mode, act));
          if (!got[want]) wrong.push(`${mode}: ${JSON.stringify(got)}`);
        }
        return wrong.length ? wrong.join("; ") : thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );

  await check(
    "a drag on the stand-in ends where it went, redrawn before the release",
    async () => {
      // The sensor's pixels and the wire's vertices spread about their
      // centroids, x doubled; the aim turns.
      const cases = [
        ["probe", "scale", "proxy.scale.set(2, 1, 1)"],
        ["wire", "scale", "proxy.scale.set(2, 1, 1)"],
        ["aimed", "polarization", "proxy.rotateX(0.5)"],
      ];
      const want = {
        probe: [
          [
            [-0.01, 0, 0],
            [0.03, 0, 0],
          ],
          [
            [-0.01, 0.01, 0],
            [0.03, 0.01, 0],
          ],
        ],
        wire: [
          [-0.04 / 3, 0, 0],
          [0.08 / 3, 0, 0],
          [0.08 / 3, 0.01, 0],
        ],
      };
      const near = (a, b) =>
        Array.isArray(a)
          ? Array.isArray(b) &&
            a.length === b.length &&
            a.every((each, i) => near(each, b[i]))
          : Math.abs(a - b) < 1e-9;
      const wrong = [];
      for (const [objectId, mode, act] of cases) {
        const tab = await openTab(port);
        try {
          await tab.navigate(
            `${base}/pages/outline.html?scene=standin#${objectId}`,
          );
          if (!(await tab.until("return window.shown", 20_000))) {
            wrong.push(`${objectId}: never drew`);
            continue;
          }
          const held = await tab.evaluate(STOOD_IN(objectId, mode, act));
          if (held) {
            wrong.push(`${objectId}: ${held}`);
            continue;
          }
          // the preview's answer, then the scene drawn again round the drag
          const redrawn = await tab.until(
            `return window.scene3d.byObjectId.get(${JSON.stringify(objectId)}) !== window.held.node`,
            5_000,
          );
          if (!redrawn) {
            wrong.push(`${objectId}: no redraw came before the release`);
            continue;
          }
          await wait(100);
          const sent = await tab.evaluate(`
            window.held.controls.dragging = false;
            return window.posted.filter((m) => m.type === "transformObjects").map((m) => m.edits);`);
          const edit = sent.at(-1)?.[0];
          if (!edit) {
            wrong.push(`${objectId}: the release sent nothing`);
          } else if (
            mode === "polarization"
              ? !edit.polarization
              : !near(edit.shape?.value, want[objectId]) || edit.position
          ) {
            wrong.push(`${objectId}: the release sent ${JSON.stringify(edit)}`);
          }
          const problem = thrown(tab);
          if (problem) wrong.push(`${objectId}: ${problem}`);
        } finally {
          await tab.close();
        }
      }
      return wrong.length ? wrong.join("; ") : null;
    },
  );

  await check("a shape's grips each change their own number", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/pages/outline.html?scene=standin`);
      if (!(await tab.until("return window.shown", 20_000))) {
        return "never drew";
      }
      // Each shape's numbers, and per grip: the number it moves, which way
      // when pulled out along its handle -- a segment's inner radius in and
      // its start angle back, everything else up -- and whether the shape's
      // middle moves with it, as a face moved alone moves it. The last is
      // the box's first face again, with ⌥: both faces, the middle still.
      const shapes = {
        arc: {
          before: [0.01, 0.02, 0.01, 0, 90],
          grips: [
            [0, -1],
            [1, 1],
            [2, 1, "moves"],
            [2, 1, "moves"],
            [3, -1],
            [4, 1],
          ],
        },
        can: {
          before: [0.01, 0.01],
          grips: [
            [0, 1],
            [1, 1, "moves"],
            [1, 1, "moves"],
          ],
        },
        ball: { before: [0.01], grips: [[0, 1]] },
        loop: { before: [0.01], grips: [[0, 1]] },
        box: {
          before: [0.01, 0.01, 0.01],
          grips: [0, 0, 1, 1, 2, 2].map((k) => [k, 1, "moves"]),
        },
      };
      const mouse = (type, [x, y], buttons, modifiers = 0) =>
        tab.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          buttons,
          modifiers,
          clickCount: 1,
        });
      const wrong = [];
      const runs = Object.entries(shapes).flatMap(([objectId, shape]) =>
        shape.grips.map((grip, index) => [
          objectId,
          shape.before,
          index,
          grip,
          0,
        ]),
      );
      // ⌥ is modifier 1
      runs.push(["box", shapes.box.before, 0, [0, 1], 1]);
      for (const [objectId, before, index, [k, goes, moves], alt] of runs) {
        await wait(400); // the redraw after the last one's release
        const spots = await tab.evaluate(GRIP_SPOTS(objectId));
        if (!spots?.[index]) {
          wrong.push(`${objectId}: no grip ${index}`);
          continue;
        }
        const { from, to } = spots[index];
        await mouse("mouseMoved", from, 0, alt);
        await mouse("mousePressed", from, 1, alt);
        for (let step = 1; step <= 6; step++) {
          const along = (n) => from[n] + ((to[n] - from[n]) * step) / 6;
          await mouse("mouseMoved", [along(0), along(1)], 1, alt);
          await wait(30);
        }
        await mouse("mouseReleased", to, 0, alt);
        await wait(200);
        const sent = await tab.evaluate(
          `return window.posted.filter((m) => m.type === "transformObjects").map((m) => m.edits)`,
        );
        const edit = sent.at(-1)?.[0];
        // a diameter goes back as the one number it is
        const value =
          edit?.objectId === objectId ? edit.shape?.value : undefined;
        const moved = []
          .concat(value ?? [])
          .map((v, n) => Math.sign(Math.round((v - before[n]) * 1e9)));
        const want = before.map((_, n) => (n === k ? goes : 0));
        const shifted = Boolean(edit?.position);
        // and the box's face opposite the one dragged stays where it was:
        // its faces go +x, -x, +y, ... and it sits at (0, 0.05, 0)
        let stayed = true;
        if (objectId === "box" && shifted && value) {
          const side = index % 2 ? 1 : -1; // the face opposite's
          const start = [0, 0.05, 0][k] + (side * before[k]) / 2;
          stayed =
            Math.abs(edit.position[k] + (side * value[k]) / 2 - start) < 1e-9;
        }
        if (
          moved.join() !== want.join() ||
          shifted !== Boolean(moves) ||
          !stayed
        ) {
          wrong.push(
            `${objectId} grip ${index}${alt ? " with ⌥" : ""} sent ${JSON.stringify(edit)}`,
          );
        }
      }
      return wrong.length ? wrong.join("; ") : thrown(tab);
    } finally {
      await tab.close();
    }
  });

  await check("a flat shape's resize has no handle across it", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/pages/outline.html?scene=standin`);
      if (!(await tab.until("return window.shown", 20_000))) {
        return "never drew";
      }
      // the wire and the pixel grid lie in their own xy; the tetrahedron
      // has depth along all three
      const want = { wire: "x,y", probe: "x,y", tet: "x,y,z" };
      const wrong = [];
      for (const [objectId, axes] of Object.entries(want)) {
        const shown = await tab.evaluate(`
          window.scene3d.highlight([${JSON.stringify(objectId)}]);
          window.scene3d.setGizmoMode("scale");
          const node = window.scene3d.byObjectId.get(${JSON.stringify(objectId)});
          const controls = node.parent.children.find((c) => c.isTransformControlsRoot).controls;
          return ["x", "y", "z"].filter((a) => controls["show" + a.toUpperCase()]).join();`);
        if (shown !== axes) wrong.push(`${objectId} shows ${shown}`);
      }
      return wrong.length ? wrong.join("; ") : thrown(tab);
    } finally {
      await tab.close();
    }
  });

  await check(
    "a point pointed at moves alone, and ⌘-clicked ones together",
    async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/outline.html?scene=standin#tet`);
        if (!(await tab.until("return window.shown", 20_000))) {
          return "never drew";
        }
        const dot = await tab.evaluate(DOT_SPOT("tet", 1));
        if (!dot) return "no dots on the tetrahedron";
        const mouse = (type, [x, y], buttons) =>
          tab.send("Input.dispatchMouseEvent", {
            type,
            x,
            y,
            button: type === "mouseMoved" && !buttons ? "none" : "left",
            buttons,
            clickCount: 1,
          });
        const handles = `
        const node = window.scene3d.byObjectId.get("tet");
        const controls = node.parent.children.find((c) => c.isTransformControlsRoot).controls;
        return [controls.mode, controls.object?.userData.indices?.join() ?? null];`;
        // pointed at, the dot gets the move handles
        await mouse("mouseMoved", dot, 0);
        await wait(200);
        const on = await tab.evaluate(handles);
        if (on.join() !== "translate,1") {
          return `pointed at, the handles are ${JSON.stringify(on)}`;
        }
        // pressed on the dot and dragged: that point, freely
        await mouse("mousePressed", dot, 1);
        for (let step = 1; step <= 6; step++) {
          await mouse("mouseMoved", [dot[0] + step * 6, dot[1] - step * 3], 1);
          await wait(30);
        }
        await mouse("mouseReleased", [dot[0] + 36, dot[1] - 18], 0);
        await wait(300);
        const sent = await tab.evaluate(
          `return window.posted.filter((m) => m.type === "transformObjects").map((m) => m.edits)`,
        );
        const value = sent.at(-1)?.[0]?.shape?.value;
        const before = [
          [0, 0, 0],
          [0.01, 0, 0],
          [0, 0.01, 0],
          [0, 0, 0.01],
        ];
        const moved = value?.map((p, i) =>
          p.some((v, n) => Math.abs(v - before[i][n]) > 1e-9),
        );
        if (moved?.join() !== "false,true,false,false") {
          return `the drag sent ${JSON.stringify(value)}`;
        }
        // away from both, the handles go back to the whole shape
        await wait(400);
        await mouse("mouseMoved", [dot[0] - 300, dot[1] + 200], 0);
        await wait(200);
        const off = await tab.evaluate(handles);
        if (off[0] !== "scale")
          return `away, the handles are ${JSON.stringify(off)}`;

        // ⌘-clicked, two points are held together, the handles on their
        // middle, and a drag of them moves both by the same offset. The
        // last drag moved point 1, so the dots are found again.
        await wait(400);
        const metaClick = async (spot) => {
          for (const [type, buttons] of [
            ["mousePressed", 1],
            ["mouseReleased", 0],
          ]) {
            await tab.send("Input.dispatchMouseEvent", {
              type,
              x: spot[0],
              y: spot[1],
              button: "left",
              buttons,
              modifiers: 4, // ⌘
              clickCount: 1,
            });
          }
          await wait(150);
        };
        await metaClick(await tab.evaluate(DOT_SPOT("tet", 2)));
        await metaClick(await tab.evaluate(DOT_SPOT("tet", 3)));
        const both = await tab.evaluate(`
          const node = window.scene3d.byObjectId.get("tet");
          const controls = node.parent.children.find((c) => c.isTransformControlsRoot).controls;
          const handle = controls.object;
          const held = handle?.userData.indices ?? [];
          if (held.join() !== "2,3" || controls.mode !== "translate") {
            return "the handles hold " + JSON.stringify(held) + " in " + controls.mode;
          }
          controls.dragging = true;
          handle.position.x += 0.004;
          handle.updateMatrixWorld(true);
          controls.dispatchEvent({ type: "objectChange" });
          controls.dragging = false;
          return null;`);
        if (both) return both;
        await wait(200);
        const together = await tab.evaluate(
          `return window.posted.filter((m) => m.type === "transformObjects").map((m) => m.edits).at(-1)?.[0]?.shape?.value`,
        );
        const shifted = together?.map((p, i) =>
          Math.round((p[0] - before[i][0]) * 1e6),
        );
        if (shifted?.slice(2).join() !== "4000,4000") {
          return `the two points moved by ${JSON.stringify(shifted)}`;
        }

        // a sensor's pixel the same way, its grid's rows kept
        const pixel = await tab.evaluate(DOT_SPOT("probe", 3));
        if (!pixel) return "no dots on the sensor's pixels";
        await mouse("mouseMoved", pixel, 0);
        await wait(200);
        const onPixel = await tab.evaluate(`
          const node = window.scene3d.byObjectId.get("probe");
          const controls = node.parent.children.find((c) => c.isTransformControlsRoot).controls;
          const handle = controls.object;
          if (handle?.userData.indices?.join() !== "3") return "the handles are not on pixel 3";
          controls.dragging = true;
          handle.position.x += 0.004;
          handle.updateMatrixWorld(true);
          controls.dispatchEvent({ type: "objectChange" });
          controls.dragging = false;
          return null;`);
        if (onPixel) return onPixel;
        await wait(200);
        const grid = await tab.evaluate(
          `return window.posted.filter((m) => m.type === "transformObjects").map((m) => m.edits).at(-1)?.[0]?.shape?.value`,
        );
        const wantGrid = [
          [
            [0, 0, 0],
            [0.02, 0, 0],
          ],
          [
            [0, 0.01, 0],
            [0.024, 0.01, 0],
          ],
        ];
        const sameGrid = (a, b) =>
          Array.isArray(b)
            ? Array.isArray(a) &&
              a.length === b.length &&
              a.every((each, i) => sameGrid(each, b[i]))
            : Math.abs(a - b) < 1e-9;
        if (!sameGrid(grid, wantGrid)) {
          return `the pixel drag sent ${JSON.stringify(grid)}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** The mouse in `tab`, as a person drives it: a move, a press, a release,
 *  with modifiers -- 1 ⌥, 4 ⌘, 8 ⇧. */
const mouseIn =
  (tab) =>
  (type, [x, y], buttons = 0, modifiers = 0) =>
    tab.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" && !buttons ? "none" : "left",
      buttons,
      modifiers,
      clickCount: 1,
    });

/** The edits the view last committed, as the studio panel's host got them. */
const LAST_COMMIT = `return window.posted.filter((m) => m.type === "transformObjects").map((m) => m.edits).at(-1)?.[0]`;

/** Page code: the handles' controls, and what they are on. */
const HANDLES = `
  const node = window.scene3d.byObjectId.get("box");
  const controls = node.parent.children.find((c) => c.isTransformControlsRoot).controls;`;

/** Page code: a key pressed in the view. */
const KEY = (key) => `
  document.querySelector(".magpy-scene-stage").dispatchEvent(
    new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }));`;

/** Page code: where on the page a point of the world is drawn. */
const PAGE_OF = (point) => `
  const node = window.scene3d.byObjectId.get("box");
  const camera = node.parent.children.find((c) => c.isTransformControlsRoot).controls.camera;
  const rect = document.querySelector("#view canvas").getBoundingClientRect();
  const p = node.position.clone().set(...${JSON.stringify(point)}).project(camera);
  return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height];`;

async function editingPoints(port, base) {
  const near = (a, b) =>
    Array.isArray(b)
      ? Array.isArray(a) &&
        a.length === b.length &&
        a.every((each, i) => near(each, b[i]))
      : Math.abs(a - b) < 1e-9;
  const opened = async () => {
    const tab = await openTab(port);
    await tab.navigate(`${base}/pages/outline.html?scene=standin`);
    if (!(await tab.until("return window.shown", 20_000))) {
      await tab.close();
      return null;
    }
    return tab;
  };

  await check(
    "⇧ lands a point, a face and an object on the next one",
    async () => {
      const tab = await opened();
      if (!tab) return "never drew";
      try {
        const mouse = mouseIn(tab);
        // The box is a 10 mm cube at (0, 50, 0) mm, the tetrahedron's corners
        // at (50, 50, 0) mm and 10 mm out along each axis from there.
        // A point picked up, let go 0.3 mm off the box's corner: on it.
        const dot = await tab.evaluate(DOT_SPOT("tet", 1));
        await mouse("mouseMoved", dot, 0, 8);
        await wait(200);
        const point = await tab.evaluate(`${HANDLES}
        const handle = controls.object;
        if (handle?.userData.indices?.join() !== "1") return "the handles are not on point 1";
        controls.dragging = true;
        handle.position.set(0.0053, 0.055, 0.005);
        handle.updateMatrixWorld(true);
        controls.dispatchEvent({ type: "objectChange" });
        controls.dragging = false;
        return null;`);
        if (point) return point;
        await wait(200);
        const corner = (await tab.evaluate(LAST_COMMIT))?.shape?.value?.[1];
        if (!near(corner, [-0.045, 0.005, 0.005])) {
          return `the point landed at ${JSON.stringify(corner)}`;
        }

        // The box's +x face dragged with ⇧ to 0.4 mm short of the
        // tetrahedron: it stops touching it, its -x face where it was.
        await mouse("mouseMoved", [5, 5], 0); // away, and ⇧ let go
        await wait(400);
        const spots = await tab.evaluate(GRIP_SPOTS("box"));
        // the handle is held by its cube, out past the face: aim the face
        const out = await tab.evaluate(`
          const grips = window.scene3d.byObjectId.get("box").parent.getObjectByName("grips");
          const grip = grips.children.find((g) => g.userData.grip === 0);
          return grip.localToWorld(grip.position.clone().set(0, 0.54, 0)).x - 0.005;`);
        const to = await tab.evaluate(PAGE_OF([0.0496 + out, 0.05, 0]));
        const { from } = spots[0];
        await mouse("mouseMoved", from, 0, 8);
        await mouse("mousePressed", from, 1, 8);
        for (let step = 1; step <= 8; step++) {
          const along = (k) => from[k] + ((to[k] - from[k]) * step) / 8;
          await mouse("mouseMoved", [along(0), along(1)], 1, 8);
          await wait(30);
        }
        await mouse("mouseReleased", to, 0, 8);
        await wait(300);
        const face = await tab.evaluate(LAST_COMMIT);
        if (!near(face?.shape?.value, [0.055, 0.01, 0.01])) {
          return `the face stopped at ${JSON.stringify(face)}`;
        }
        if (!near(face.position, [0.0225, 0.05, 0])) {
          return `the box moved to ${JSON.stringify(face.position)}`;
        }

        // The box moved with ⇧ to 0.3 mm off a corner of the tetrahedron's:
        // its own corner lands on it.
        await mouse("mouseMoved", [5, 5], 0, 8);
        await wait(400);
        const moved = await tab.evaluate(`
        window.scene3d.highlight(["box"]);
        window.scene3d.setGizmoMode("translate");
        ${HANDLES}
        if (controls.object !== node) return "the handles are not on the box";
        controls.dragging = true;
        node.position.add(node.position.clone().set(0.0447, -0.005, 0.005));
        node.updateMatrixWorld(true);
        controls.dispatchEvent({ type: "objectChange" });
        controls.dragging = false;
        return null;`);
        if (moved) return moved;
        await wait(200);
        const landed = (await tab.evaluate(LAST_COMMIT))?.position;
        if (!near(landed, [0.045, 0.045, 0.005])) {
          return `the box landed at ${JSON.stringify(landed)}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );

  await check(
    "a wire gains a point at a ghost and loses one to Delete",
    async () => {
      const tab = await opened();
      if (!tab) return "never drew";
      try {
        const mouse = mouseIn(tab);
        // the wire: (0, 0, 0), (20, 0, 0), (20, 10, 0) mm
        await tab.evaluate(DOT_SPOT("wire", 0));
        const ghost = await tab.evaluate(`
        const dots = window.scene3d.byObjectId.get("wire").parent.getObjectByName("dots");
        const ghost = dots.children.find((d) => d.visible && d.userData.ghost === 1);
        const camera = dots.parent.children.find((c) => c.isTransformControlsRoot).controls.camera;
        const rect = document.querySelector("#view canvas").getBoundingClientRect();
        const p = ghost.getWorldPosition(ghost.position.clone()).project(camera);
        return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height];`);
        await mouse("mouseMoved", ghost, 0);
        await mouse("mousePressed", ghost, 1);
        await mouse("mouseReleased", ghost, 0);
        await wait(300);
        const inserted = (await tab.evaluate(LAST_COMMIT))?.shape?.value;
        const four = [
          [0, 0, 0],
          [0.01, 0, 0],
          [0.02, 0, 0],
          [0.02, 0.01, 0],
        ];
        if (!near(inserted, four)) {
          return `the ghost put in ${JSON.stringify(inserted)}`;
        }
        // the engine here does not take it, so the wire has its three still
        const dot = await tab.evaluate(DOT_SPOT("wire", 1));
        await mouse("mouseMoved", dot, 0);
        await wait(200);
        await tab.evaluate(KEY("Delete"));
        await wait(300);
        const deleted = (await tab.evaluate(LAST_COMMIT))?.shape?.value;
        if (
          !near(deleted, [
            [0, 0, 0],
            [0.02, 0.01, 0],
          ])
        ) {
          return `Delete left ${JSON.stringify(deleted)}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );

  await check(
    "picked points turn together, a box picks them, Esc takes a drag back",
    async () => {
      const tab = await opened();
      if (!tab) return "never drew";
      try {
        const mouse = mouseIn(tab);
        const pick = async (index) => {
          const dot = await tab.evaluate(DOT_SPOT("tet", index));
          await mouse("mouseMoved", dot, 0, 4);
          await mouse("mousePressed", dot, 1, 4);
          await mouse("mouseReleased", dot, 0, 4);
          await wait(150);
        };
        // ⌘ on corners 1 and 2, then E: they turn about their middle
        await pick(1);
        await pick(2);
        await tab.evaluate(KEY("e"));
        await wait(100);
        const turned = await tab.evaluate(`${HANDLES}
          const handle = controls.object;
          if (handle?.userData.indices?.join() !== "1,2" || controls.mode !== "rotate") {
            return "E left the handles " + controls.mode + " on " + handle?.userData.indices;
          }
          controls.dragging = true;
          handle.rotateZ(Math.PI / 2);
          handle.updateMatrixWorld(true);
          controls.dispatchEvent({ type: "objectChange" });
          controls.dragging = false;
          return null;`);
        if (turned) return turned;
        await wait(200);
        const value = (await tab.evaluate(LAST_COMMIT))?.shape?.value;
        if (
          !near(value?.slice(1, 3), [
            [0.01, 0.01, 0],
            [0, 0, 0],
          ])
        ) {
          return `the turn sent ${JSON.stringify(value)}`;
        }
        // put back, then a box drawn with ⌥ round corner 3 picks it
        await pick(1);
        await pick(2);
        await mouse("mouseMoved", [5, 5], 0);
        await wait(300);
        const dot = await tab.evaluate(DOT_SPOT("tet", 3));
        const corner = (dx, dy) => [dot[0] + dx, dot[1] + dy];
        await mouse("mouseMoved", corner(-14, -14), 0, 1);
        await mouse("mousePressed", corner(-14, -14), 1, 1);
        await mouse("mouseMoved", corner(0, 0), 1, 1);
        await mouse("mouseMoved", corner(14, 14), 1, 1);
        await mouse("mouseReleased", corner(14, 14), 0, 1);
        await wait(200);
        const boxed = await tab.evaluate(`${HANDLES}
          return controls.object?.userData.indices?.join() ?? null;`);
        if (boxed !== "3") return `the box picked ${boxed}`;
        // and a drag of it, Esc mid-way: taken back, not committed
        const before = await tab.evaluate(
          `return window.posted.filter((m) => m.type === "transformObjects").length`,
        );
        await tab.evaluate(`${HANDLES}
          const handle = controls.object;
          controls.dragging = true;
          handle.position.x += 0.003;
          handle.updateMatrixWorld(true);
          controls.dispatchEvent({ type: "objectChange" });`);
        await wait(200);
        await tab.evaluate(KEY("Escape"));
        await wait(200);
        const after = await tab.evaluate(
          `return [window.posted.filter((m) => m.type === "transformObjects").length, window.posted.some((m) => m.type === "cancelDrag")]`,
        );
        if (after[0] !== before || !after[1]) {
          return `Esc: ${after[0] - before} committed, cancelled ${after[1]}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    },
  );
}

/** Page code: `objectId` selected and resized, where its point `index`'s dot
 *  is on the page. */
const DOT_SPOT = (objectId, index) => `
  window.scene3d.highlight([${JSON.stringify(objectId)}]);
  window.scene3d.setGizmoMode("scale");
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const node = window.scene3d.byObjectId.get(${JSON.stringify(objectId)});
  const camera = node.parent.children.find((c) => c.isTransformControlsRoot).controls.camera;
  const dots = node.parent.getObjectByName("dots");
  if (!dots?.visible) return null;
  dots.updateMatrixWorld(true);
  const rect = document.querySelector("#view canvas").getBoundingClientRect();
  const p = dots.children[${index}].getWorldPosition(dots.position.clone()).project(camera);
  return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height];`;

/** Page code: `objectId` selected and resized, its grips each as where its
 *  cube is on the page and a point further out along its handle. */
const GRIP_SPOTS = (objectId) => `
  window.scene3d.highlight([${JSON.stringify(objectId)}]);
  window.scene3d.setGizmoMode("scale");
  // a frame, which is when the grips take their size on screen
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const node = window.scene3d.byObjectId.get(${JSON.stringify(objectId)});
  const camera = node.parent.children.find((c) => c.isTransformControlsRoot).controls.camera;
  const grips = node.parent.getObjectByName("grips");
  if (!grips?.visible) return null;
  grips.updateMatrixWorld(true);
  const rect = document.querySelector("#view canvas").getBoundingClientRect();
  const Vector3 = grips.position.constructor;
  const onPage = (local) => {
    const p = local.clone().applyMatrix4(grips.matrixWorld).project(camera);
    return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height];
  };
  const spots = {};
  for (const grip of grips.children) {
    if (grip.userData.grip === undefined || !grip.visible) continue;
    const at = (y) => onPage(grips.worldToLocal(grip.localToWorld(new Vector3(0, y, 0))));
    spots[grip.userData.grip] = { from: at(0.54), to: at(2) };
  }
  return spots;`;

/** Page code: take hold of `objectId`'s handles in `mode`, which must be on
 *  the stand-in, and `act` on it as the pointer would, the drag left held;
 *  say what is wrong, if anything. */
const STOOD_IN = (objectId, mode, act) => `
  window.scene3d.setGizmoMode(${JSON.stringify(mode)});
  const node = window.scene3d.byObjectId.get(${JSON.stringify(objectId)});
  const controls = node.parent.children.find((c) => c.isTransformControlsRoot).controls;
  const proxy = controls.object;
  if (!proxy || proxy === node) return "the handles are not on the stand-in";
  window.held = { node, controls };
  controls.dragging = true;
  ${act};
  proxy.updateMatrixWorld(true);
  controls.dispatchEvent({ type: "objectChange" });
  return null;`;

/** Page code: drag the magnet on a path through the handles' own events --
 *  `act` moving its node in between, as the pointer would -- and say whether
 *  its path stayed `still` or was `carried` with the node. */
const DRAGGED = (mode, act) => `
  window.scene3d.setGizmoMode(${JSON.stringify(mode)});
  const node = window.scene3d.byObjectId.get("mover");
  const controls = node.parent.children.find((c) => c.isTransformControlsRoot).controls;
  const path = node.children.find((c) => c.userData.path);
  path.updateWorldMatrix(true, false);
  const before = path.matrixWorld.clone();
  const from = node.matrixWorld.clone();
  controls.dispatchEvent({ type: "dragging-changed", value: true });
  ${act};
  node.updateMatrixWorld(true);
  controls.dispatchEvent({ type: "objectChange" });
  path.updateWorldMatrix(true, false);
  const after = path.matrixWorld.clone();
  const motion = node.matrixWorld.clone().multiply(from.clone().invert());
  controls.dispatchEvent({ type: "dragging-changed", value: false });
  const same = (a, b) => a.elements.every((v, i) => Math.abs(v - b.elements[i]) < 1e-9);
  return { still: same(after, before), carried: same(after, motion.multiply(before)) };`;

async function collection(port, base) {
  await check("a collection's own handles move it whole", async () => {
    const tab = await openTab(port);
    try {
      await tab.navigate(`${base}/pages/collection.html`);
      if (!(await tab.until("return window.ready", 20_000))) {
        return "never ready";
      }
      const selected = () => tab.evaluate(`return page.model.get("selected")`);
      const press = (key) =>
        tab.evaluate(`document.querySelector(".magpy-scene-stage")
          .dispatchEvent(new KeyboardEvent("keydown", { key: "${key}", bubbles: true }))`);

      // C, from a magnet picked in the view: the collection holding it; and
      // again, at the top, nothing further
      await tab.evaluate(`page.model.set("selected", ["left"])`);
      await press("c");
      const up = await selected();
      await press("c");
      const top = await selected();
      if (up.join() !== "pair" || top.join() !== "pair") {
        return `C went from left to ${up}, then to ${top}`;
      }

      // the legend's row selects the collection itself
      await tab.evaluate(`page.model.set("selected", [])`);
      await tab.evaluate(
        `${row("pair")}.querySelector(".magpy-legend-label").click()`,
      );
      await wait(200);
      const clicked = await selected();
      if (clicked.join() !== "pair") return `its row selected ${clicked}`;
      const on = await tab.evaluate(`return page.on()`);
      if (on !== "pair") return `the handles are on ${on}`;

      // a real drag of its handles: what it holds goes with it, through the
      // redraws around the drag, and the session is told of the pair alone
      const at = await tab.evaluate(`return page.handlesAt()`);
      const mouse = (type, x, buttons = 1) =>
        tab.send("Input.dispatchMouseEvent", {
          type,
          x,
          y: at.y,
          button: "left",
          buttons,
          clickCount: 1,
        });
      await mouse("mouseMoved", at.x, 0);
      await mouse("mousePressed", at.x);
      for (let step = 1; step <= 6; step++) {
        await mouse("mouseMoved", at.x + step * 15);
        await wait(60);
      }
      await wait(300);
      const midway = await tab.evaluate(
        `return [page.carriedBy("left"), page.carriedBy("right")]`,
      );
      await mouse("mouseReleased", at.x + 90, 0);
      await wait(400);
      if (midway.join() !== "pair,pair") {
        return `mid-drag, left and right hung on ${midway}`;
      }
      const after = await tab.evaluate(`return page.carriedBy("left")`);
      if (after !== null) return `after the drag, left still hangs on ${after}`;
      const edits = await tab.evaluate(
        `return page.asked.filter((a) => a.method === "apply_edits").map((a) => a.edits)`,
      );
      if (!edits.length) return "the drag sent nothing";
      const ids = [...new Set(edits.flat().map((edit) => edit.objectId))];
      if (ids.join() !== "pair") return `the drag edited ${ids}`;
      if (!edits.at(-1)[0].position) {
        return `the release sent ${JSON.stringify(edits.at(-1))}`;
      }
      return thrown(tab);
    } finally {
      await tab.close();
    }
  });
}

async function pool(port, base) {
  const cases = {
    detached: [
      "two views rendered before they are on the page are two views",
      (r) => r.first && r.second,
    ],
    reused: [
      "a view taken off the page untorn leaves a renderer for the next",
      (r) => r.next,
    ],
    stale: [
      "a view taken off the page does not steer the renderer it gave up",
      (r) => r.visible,
    ],
    projection: [
      "a renderer handed on starts the next view in perspective",
      (r) =>
        r.was === "parallel" &&
        r.now === "perspective" &&
        r.pressed === "false",
    ],
    idle: [
      "a view left alone draws nothing",
      (r) => r.drawn > 0 && r.idle === 0,
    ],
    cap: [
      "past eight views the least wanted rest, and wake when reached for",
      (r) =>
        r.renderers === 8 &&
        r.canvases === 8 &&
        r.inSightLive &&
        r.woke &&
        r.after === 8 &&
        r.pictures >= 1,
      (r) => r.backAs === "perspective",
    ],
    boxed: [
      "a box of views drawn off the page keeps to eight renderers",
      (r) => r.renderers === 8 && r.canvases === 8 && r.shown,
      // on a white page in a dark system: the views waiting for a renderer
      // are dressed for the page too, not left on the system's guess
      (r) => r.light,
    ],
    rerun: [
      "a cell run again draws its scene once, on the page",
      (r) => r.renders.length === 1 && r.renders[0],
    ],
  };
  for (const [name, [label, ...holds]] of Object.entries(cases)) {
    await check(label, async () => {
      const tab = await openTab(port);
      try {
        await tab.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        await tab.navigate(`${base}/pages/pool.html?case=${name}`);
        const result = await tab.until("return window.result");
        if (!result) return "never finished";
        if (!holds.every((hold) => hold(result))) {
          return `drew ${JSON.stringify(result)}`;
        }
        return thrown(tab);
      } finally {
        await tab.close();
      }
    });
  }
}

const rounded = (value) =>
  JSON.stringify(value, (_, v) =>
    typeof v === "number" ? Math.round(v * 1000) / 1000 : v,
  );

async function savedView(port, base, out, expected) {
  const tab = await openTab(port);
  const downloads = path.join(out, "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  await tab.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
  });
  await tab.navigate(`${base}/out/still.html`);
  const drawn = await tab.until(
    `return ${VIEW}?.querySelector("canvas") && document.querySelectorAll(".magpy-legend-row").length && window.scene3d`,
    20_000,
  );

  await check("a saved view lists its objects as they nest", async () => {
    if (!drawn) return "the page never drew";
    const rows = await tab.evaluate(
      `return [...document.querySelectorAll(".magpy-legend-row .magpy-legend-label")].map((l) => l.textContent)`,
    );
    return rounded(rows) === rounded(expected.rows)
      ? null
      : `rows ${rows.join(", ")}`;
  });

  await check("a leaf keeps a group's slot, with a dot in it", async () => {
    // A top-level leaf after a nested branch: its name starts where the
    // group's does, and the caret's slot is not blank, or the row reads as a
    // stray of the branch above.
    const measured = await tab.evaluate(
      `const left = (r) => r.querySelector(".magpy-legend-label").getBoundingClientRect().left;
       const dot = ${row("probe")}.querySelector(".magpy-legend-caret.leaf");
       const style = getComputedStyle(dot);
       return {
         stack: left(${row("stack")}),
         probe: left(${row("probe")}),
         width: dot.getBoundingClientRect().width,
         drawn: style.backgroundColor !== "rgba(0, 0, 0, 0)" && parseFloat(style.opacity) > 0,
       };`,
    );
    if (Math.abs(measured.stack - measured.probe) > 0.5) {
      return `the probe's name starts at ${measured.probe}, the stack's at ${measured.stack}`;
    }
    return measured.width > 0 && measured.drawn
      ? null
      : `the leaf's slot is ${JSON.stringify(measured)}`;
  });

  await check("a saved view opens where it was looking", async () => {
    await wait(300);
    const camera = await tab.evaluate("return window.scene3d.cameraState()");
    if (rounded(camera) !== rounded(expected.camera)) {
      return `camera ${rounded(camera)}`;
    }
    const pressed = await tab.evaluate(
      `return ${tool("Orthographic")}.getAttribute("aria-pressed")`,
    );
    return pressed === "true"
      ? null
      : "the projection button does not say parallel";
  });

  await check("a legend row selects what it holds", async () => {
    await tab.evaluate(
      `${row("upper")}.querySelector(".magpy-legend-label").click()`,
    );
    const selected = await tab.until(
      `const on = [...document.querySelectorAll(".magpy-legend-row.selected")].map((r) => r.querySelector(".magpy-legend-label").textContent); return on.length && on`,
      3000,
    );
    const want = ["upper", "upper 0", "upper 1", "upper 2", "upper 3"];
    return rounded(selected) === rounded(want) ? null : `selected ${selected}`;
  });

  await check(
    "the eye slid fades a row, and a click goes through what is faded",
    async () => {
      const was = await tab.evaluate("return window.scene3d.cameraState()");
      const slide = async ({ x, y }, dx) => {
        const mouse = (type, at, buttons) =>
          tab.send("Input.dispatchMouseEvent", {
            type,
            x: at,
            y,
            button: "left",
            buttons,
            clickCount: 1,
          });
        await mouse("mousePressed", x, 1);
        for (let step = 1; step <= 10; step++) {
          await mouse("mouseMoved", x + (dx * step) / 10, 1);
        }
        await mouse("mouseReleased", x + dx, 0);
        await wait(300);
      };
      const picked = async (at) => {
        await tab.click(at);
        await wait(300);
        return tab.evaluate(
          `return [...document.querySelectorAll(".magpy-legend-row.selected")].map((r) => r.querySelector(".magpy-legend-label").textContent).join()`,
        );
      };
      const eye = `${row("upper")}.querySelector(".magpy-legend-eye")`;
      try {
        // Looking straight down, parallel, ten units to the view's height:
        // each upper magnet stands over a lower one, and "upper 0" is three
        // units right of the middle.
        const at = await tab.evaluate(`
          window.scene3d.setCamera({ projection: "parallel", position: [0, 0, 20],
            target: [0, 0, 0], up: [0, 1, 0], zoom: 1, height: 10, near: -80, far: 400 });
          const box = ${VIEW}.querySelector("canvas").getBoundingClientRect();
          return { x: box.x + box.width / 2 + (3 * box.height) / 10, y: box.y + box.height / 2 };`);
        await wait(300);
        const whole = await picked(at);
        if (whole !== "upper 0") return `a click on upper 0 picked "${whole}"`;

        await slide(await tab.evaluate(centreOf(eye)), -50);
        const state = await tab.evaluate(
          `return { classes: ${row("upper")}.className, level: ${eye}.style.getPropertyValue("--fade") }`,
        );
        if (!state.classes.includes("faded") || state.level !== "0.5") {
          return `slid half way, the row is ${JSON.stringify(state)}`;
        }
        // the release of a slide is a click too, and not one that hides
        if (state.classes.includes("off")) return "the slide hid the row";
        const through = await picked(at);
        return through === "lower 0"
          ? null
          : `with upper faded, the click picked "${through}"`;
      } finally {
        await slide(await tab.evaluate(centreOf(eye)), 80); // whole again
        await tab.evaluate(`window.scene3d.setCamera(${JSON.stringify(was)})`);
      }
    },
  );

  await check("the eye hides what a row holds", async () => {
    await tab.evaluate(
      `${row("lower")}.querySelector(".magpy-legend-eye").click()`,
    );
    const off = await tab.until(
      `const off = [...document.querySelectorAll(".magpy-legend-row.off")].map((r) => r.querySelector(".magpy-legend-label").textContent); return off.length && off`,
      3000,
    );
    const want = ["lower", "lower 0", "lower 1", "lower 2", "lower 3"];
    return rounded(off) === rounded(want) ? null : `hidden ${off}`;
  });

  await check(
    "⌥ on an eye shows only that row, again puts it back, slid fades the rest",
    async () => {
      const eye = `${row("upper")}.querySelector(".magpy-legend-eye")`;
      const mouse = (type, x, y, buttons) =>
        tab.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          buttons,
          clickCount: 1,
          modifiers: 1, // alt
        });
      const rows = (cls) =>
        tab.evaluate(
          `return [...document.querySelectorAll(".magpy-legend-row.${cls}")].map((r) => r.querySelector(".magpy-legend-label").textContent).join()`,
        );
      const upper = ["upper", "upper 0", "upper 1", "upper 2", "upper 3"];
      const all = await tab.evaluate(
        `return [...document.querySelectorAll(".magpy-legend-row")].map((r) => r.querySelector(".magpy-legend-label").textContent)`,
      );
      const before = await rows("off"); // what the eye's check hid
      const { x, y } = await tab.evaluate(centreOf(eye));
      const click = async () => {
        await mouse("mousePressed", x, y, 1);
        await mouse("mouseReleased", x, y, 0);
        await wait(300);
      };
      await click();
      const only = await rows("off");
      // all but upper -- and "stack", which holds it, and is shown in part
      const rest = all
        .filter((label) => !upper.includes(label) && label !== "stack")
        .join();
      if (only !== rest) return `⌥-clicked, hidden: ${only}`;
      await click();
      const back = await rows("off");
      if (back !== before) return `⌥-clicked again, hidden: ${back}`;
      await mouse("mousePressed", x, y, 1);
      for (let step = 1; step <= 10; step++) {
        await mouse("mouseMoved", x - (50 * step) / 10, y, 1);
      }
      await mouse("mouseReleased", x - 50, y, 0);
      await wait(300);
      const faded = await rows("faded");
      const shown = all.filter((label) => !upper.includes(label));
      if (faded !== shown.join()) return `⌥-slid, faded: ${faded}`;
      if (upper.some((label) => faded.split(",").includes(label))) {
        return "⌥-slid, the row itself faded";
      }
      await mouse("mousePressed", x, y, 1); // on the eye again, rightwards
      for (let step = 1; step <= 10; step++) {
        await mouse("mouseMoved", x + (60 * step) / 10, y, 1);
      }
      await mouse("mouseReleased", x + 60, y, 0);
      await wait(300);
      const whole = await rows("faded");
      return whole ? `slid back, still faded: ${whole}` : null;
    },
  );

  await check("the picture tool saves the view as a PNG", async () => {
    await tab.hover(await tab.evaluate(centreOf(VIEW)));
    await wait(300);
    await tab.click(
      await tab.evaluate(centreOf(tool("Save the view as a PNG"))),
    );
    let file = null;
    for (let i = 0; i < 40 && !file; i++, await wait(250)) {
      file = fs.readdirSync(downloads).find((name) => name.endsWith(".png"));
    }
    if (!file) return "nothing was downloaded";
    const png = fs.readFileSync(path.join(downloads, file));
    const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
    const canvas = await tab.evaluate(
      `const c = ${VIEW}.querySelector("canvas"); return [c.width, c.height]`,
    );
    if (rounded(size) !== rounded(canvas)) {
      return `${size.join("x")} saved, the view is ${canvas.join("x")}`;
    }
    // Decoded by the browser: a picture of nothing is one colour.
    const colours = await tab.evaluate(`
      const image = new Image();
      image.src = "data:image/png;base64,${png.toString("base64")}";
      await image.decode();
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height;
      const g = c.getContext("2d");
      g.drawImage(image, 0, 0);
      const data = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4 * 31) {
        seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
      return seen.size;`);
    return colours > 20 ? null : `the picture has ${colours} colours`;
  });

  await check(
    "the view cube turns the view, and stays out of the picture",
    async () => {
      // the cube is the default, and what the checks after expect
      await tab.hover(await tab.evaluate(centreOf(VIEW)));
      await wait(300);
      return await cubeTurnsTheView();
    },
  );

  async function cubeTurnsTheView() {
    // The middle of the corner grown, which is inside it at rest too. The
    // saved camera looks from -y and a little above, so what is there is the
    // middle of the -y face. The cube comes up as the pointer reaches the
    // corner, and the view turns over a few frames.
    const cube = await tab.evaluate(`
      const box = ${VIEW}.querySelector("canvas").getBoundingClientRect();
      return { x: box.right - 8 - 56, y: box.bottom - 8 - 56 };`);
    await tab.hover(cube);
    await wait(400);
    await tab.click(cube);
    await wait(700);
    const { position, target } = await tab.evaluate(
      "return window.scene3d.cameraState()",
    );
    const looking = position.map((at, axis) => at - target[axis]);
    const along = looking.map((part) => part / Math.hypot(...looking));
    if (rounded(along) !== rounded([0, -1, 0])) {
      return `the -y face looks along ${rounded(along)}`;
    }
    // In the picture the corner is not drawn: one colour, the background's,
    // where it is on screen at rest; more than one across the middle of the
    // foot, where the bar is, low beside it.
    const seen = await tab.evaluate(`
      const image = new Image();
      image.src = window.scene3d.snapshot();
      await image.decode();
      const canvas = ${VIEW}.querySelector("canvas");
      const scale = image.width / canvas.clientWidth;
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height;
      const g = c.getContext("2d");
      g.drawImage(image, 0, 0);
      const colours = (left, top, width, height) => {
        const data = g.getImageData(
          left * scale, top * scale, width * scale, height * scale,
        ).data;
        const seen = new Set();
        for (let i = 0; i < data.length; i += 4) {
          seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
        return seen.size;
      };
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      return {
        cube: colours(w - 92, h - 92, 84, 84),
        bar: colours(w / 2 - 68, h - 49, 136, 30),
      };`);
    if (seen.cube > 1) {
      return `the picture shows the cube (${seen.cube} colours)`;
    }
    return seen.bar > 1 ? null : "the picture has no scale bar";
  }

  await check("full screen takes the screen and gives it back", async () => {
    const inCell = await tab.evaluate(`return ${VIEW}.clientHeight`);
    await tab.hover(await tab.evaluate(centreOf(VIEW)));
    await wait(300);
    await tab.click(await tab.evaluate(centreOf(tool("Full screen"))));
    const full = await tab.until(
      `return document.querySelector(".magpy-scene").classList.contains("magpy-fullscreen") && [${VIEW}.clientHeight, innerHeight]`,
      5000,
    );
    if (!full) return "never went full screen";
    if (Math.abs(full[0] - full[1]) > 60) {
      return `the view is ${full[0]}px of a ${full[1]}px screen`;
    }
    await tab.hover(await tab.evaluate(centreOf(VIEW)));
    await wait(300);
    await tab.click(await tab.evaluate(centreOf(tool("Leave full screen"))));
    // The saved page sizes the view to the window, and the window itself
    // changes size on the way out: the height is the one it settles at.
    const back = await tab.until(
      `return !document.fullscreenElement && ${VIEW}.clientHeight === ${inCell}`,
      5000,
    );
    if (!back) {
      const height = await tab.evaluate(`return ${VIEW}.clientHeight`);
      return `back at ${height}px, from ${inCell}px`;
    }
    return thrown(tab);
  });
  await tab.close();

  const RUNS = {
    run: "a saved run that only moves plays from its poses",
    morph: "a saved run that changes shape plays from the changes it carries",
    mix: "a saved run that moves and changes plays, posed and carried",
    ramp: "a saved run in which nothing drawn moves still plays",
    served: "a saved run too big to carry plays from its frames",
  };
  for (const [page, label] of Object.entries(RUNS)) {
    await check(label, async () => {
      const run = await openTab(port);
      try {
        await run.navigate(`${base}/out/${page}.html`);
        const ready = await run.until(
          `const t = document.querySelector(".magpy-scene-transport"); return t && !t.hidden && ${VIEW}.querySelector("canvas")`,
          20_000,
        );
        if (!ready) return "no transport to play it with";
        await run.evaluate(`${tool("Play the path")}.click()`);
        const step = await run.until(
          `const n = parseInt(document.querySelector(".magpy-scene-counter").textContent); return n >= 5 && n`,
          10_000,
        );
        if (!step) {
          return `stuck at ${await run.evaluate(`return document.querySelector(".magpy-scene-counter").textContent`)}`;
        }
        // and what is drawn changes with the step -- posed, carried or
        // served alike -- except where nothing drawn moves at all
        if (page !== "ramp") {
          await run.evaluate(`${tool("Pause")}?.click(); return 1`);
          const at = async (step) => {
            await run.evaluate(
              `const s = document.querySelector(".magpy-scene-scrub"); s.value = ${step}; s.dispatchEvent(new Event("input")); return 1`,
            );
            await wait(700);
            return run.evaluate(SHAPE);
          };
          if ((await at("0")) === (await at("s.max"))) {
            return "the picture is the same at the first and last step";
          }
        }
        return thrown(run);
      } finally {
        await run.close();
      }
    });
  }
}

// ------------------------------------------------------------------- main

if (typeof WebSocket === "undefined") {
  fail(
    `needs Node 22 or later, for its WebSocket (this is ${process.version})`,
  );
}
const chrome = findChrome();
if (!chrome) fail("no Chrome or Chromium found; set CHROME to name one");
const python = enginePython();
if (!python) fail("no python here can import magpylib_studio");
if (!fs.existsSync(THREE)) {
  fail("three.js is missing: run 'npm ci' in vscode-extension/ first");
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), "magpy-widget-"));
try {
  execFileSync(python, [path.join(HARNESS, "widget_scenes.py"), out], {
    stdio: ["ignore", "ignore", "pipe"],
  });
} catch (error) {
  fail(`could not write the scenes:\n${error.stderr}`);
}
const expected = JSON.parse(
  fs.readFileSync(path.join(out, "expected.json"), "utf8"),
);

const server = await serve(out);
const base = `http://127.0.0.1:${server.address().port}`;
const profile = path.join(out, "chrome");
const browser = await launch(chrome, profile).catch((error) =>
  fail(error.message),
);
// However the checks go, the run ends: a locked-up page must not hold a CI
// job until its own time limit.
setTimeout(() => {
  browser.proc.kill("SIGKILL");
  fail("gave up after ten minutes; a page may have locked up.");
}, 600_000).unref();
try {
  await themes(browser.port, base);
  await lateCompany(browser.port, base);
  await pool(browser.port, base);
  await room(browser.port, base, expected);
  await blocked(browser.port, base);
  await themeMidRun(browser.port, base);
  await staleFrame(browser.port, base);
  await silent(browser.port, base);
  await textFocus(browser.port, base);
  await panel(browser.port, base, expected);
  await heldReadings(browser.port, base);
  await studioDrag(browser.port, base);
  await editing(browser.port, base);
  await pencil(browser.port, base);
  await variablesPanel(browser.port, base);
  await objectPanel(browser.port, base);
  await objectPanelMixed(browser.port, base);
  await busyRing(browser.port, base);
  await panelWidget(browser.port, base);
  await collection(browser.port, base);
  await selection(browser.port, base);
  await editingPoints(browser.port, base);
  await savedView(browser.port, base, out, expected);
  await firstLook(browser.port, base, expected);
  await savedLines(browser.port, base);
  await linesPick(browser.port, base);
  await manyMagnets(browser.port, base);
  await manyRun(browser.port, base);
  await sealedBody(browser.port, base);
  await glyphs(browser.port, base);
  await marks(browser.port, base);
  await heldReading(browser.port, base);
  await dragPace(browser.port, base);
  await colorBar(browser.port, base);
  await sharedScale(browser.port, base);
  await colorBarAside(browser.port, base);
  await flow(browser.port, base);
  await slowPosing(browser.port, base); // last: a frozen page could stall the rest
} finally {
  browser.proc.kill("SIGKILL"); // a renderer that is locked up ignores less
  server.close();
  await wait(300);
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 3 });
}

if (failures) fail(`${failures} check(s) failed.`);
console.log("check-widget-browser: the widget works in a browser.");
