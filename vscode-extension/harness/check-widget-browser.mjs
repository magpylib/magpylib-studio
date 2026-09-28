/**
 * The notebook widget in a real browser, driven the way a person drives it.
 *
 *   node harness/check-widget-browser.mjs
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
 * - a saved page (`write_html`): its legend, the camera it was saved with,
 *   selecting and hiding from the legend, the picture tool, full screen, and
 *   a run that plays with no python behind it.
 *
 * Needs Chrome or Chromium (set CHROME to name one), Node 22 or later for its
 * WebSocket, and a python with the widget's extra installed -- `pip install
 * -e ".[widget]"` -- and magpylib's display-backend API. Missing any of them
 * is a failure, not a skip: a check that passes without having run is worse
 * than none. WebGL runs on SwiftShader, so no GPU is needed.
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
  const roots = { static: STATIC, pages: PAGES, media: MEDIA, out };
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
const within = (ms, promise, otherwise) =>
  Promise.race([promise, wait(ms).then(() => otherwise)]);

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
async function check(name, body) {
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
  };
  for (const [name, [label, holds]] of Object.entries(cases)) {
    await check(label, async () => {
      const tab = await openTab(port);
      try {
        await tab.navigate(`${base}/pages/pool.html?case=${name}`);
        const result = await tab.until("return window.result");
        if (!result) return "never finished";
        if (!holds(result)) return `drew ${JSON.stringify(result)}`;
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
  await panel(browser.port, base, expected);
  await savedView(browser.port, base, out, expected);
  await slowPosing(browser.port, base); // last: a frozen page could stall the rest
} finally {
  browser.proc.kill("SIGKILL"); // a renderer that is locked up ignores less
  server.close();
  await wait(300);
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 3 });
}

if (failures) fail(`${failures} check(s) failed.`);
console.log("check-widget-browser: the widget works in a browser.");
