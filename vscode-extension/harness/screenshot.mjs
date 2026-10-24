/**
 * The README's picture, taken from the studio as it stands:
 *
 *   npm run screenshot                   -> ../docs/halbach.png and .gif
 *   node harness/screenshot.mjs out.png  -> anywhere else, out.gif beside it
 *
 * The studio is installed into a VS Code of its own -- the one the test runner
 * downloaded, with a fresh profile: no AI features, no tips -- beside the
 * driver in `screenshot-driver/`, which opens the scene and lays the window
 * out. The scene is the Halbach design of `examples/marimo_demo.py` with its
 * field lines, as dense as its `density` goes (`screenshot.py scene`). VS Code
 * then renders its own window through its DevTools protocol, so no
 * screen-recording permission is needed and nothing else on the screen can end
 * up in the picture.
 *
 * The lines flow. The 3D view is handed the time it draws at, so the window is
 * taken at `FRAMES` even steps through one period of the flow, in VS Code's
 * dark theme and then in its light one. `screenshot.py join` cuts each pair
 * along a diagonal through the middle of the 3D view, light to its left: the
 * first is the PNG, 2400 x 1440 (1800 x 1080 CSS pixels at 4/3), and all of
 * them the GIF, smaller, which loops without a jump. Pillow comes from the
 * engine's `.venv`.
 *
 * Run `npm run compile` first: the studio installed is `out/` as it stands.
 * macOS only, like check:window. Takes about a minute and opens a window.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const REPO = path.resolve(EXT, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8"));
const PYTHON = path.join(REPO, ".venv", "bin", "python");
const WIDTH = 1800;
const HEIGHT = 1080;
const SCALE = 4 / 3;
const EXAMPLE = path.join(REPO, "examples", "marimo_demo.py");
const HELPER = path.join(HERE, "screenshot.py");
/** One period of the flow, `scene3d.mjs`'s FLOW_RATE of 0.8 pulses a second. */
const PERIOD_MS = 1250;
const FRAMES = 25;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== "darwin") {
  console.error("screenshot: macOS only, for now");
  process.exit(2);
}
const out = path.resolve(
  process.argv[2] ?? path.join(REPO, "docs", "halbach.png"),
);
const gif = out.replace(/\.png$/, "") + ".gif";

function vscodeApp() {
  const root = path.join(EXT, ".vscode-test");
  const found = fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .filter((name) => name.startsWith("vscode-darwin"))
        .sort()
        .pop()
    : undefined;
  if (!found) {
    throw new Error(
      "no VS Code in .vscode-test: run `npm test` once to download it",
    );
  }
  return path.join(
    root,
    found,
    "Visual Studio Code.app",
    "Contents",
    "MacOS",
    "Code",
  );
}

/** A short folder: VS Code's socket goes in the profile, and a long path fails. */
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mshot-"));
const extensions = path.join(base, "x");
const user = path.join(base, "u");
const results = path.join(base, "r");
// its name is the window's title
const work = path.join(base, "magnet-designs");
for (const dir of [extensions, path.join(user, "User"), results, work]) {
  fs.mkdirSync(dir, { recursive: true });
}

function install() {
  const studio = path.join(
    extensions,
    `${pkg.publisher}.${pkg.name}-${pkg.version}`,
  );
  fs.mkdirSync(studio, { recursive: true });
  for (const part of ["package.json", "media", "widget", "schemas"]) {
    fs.cpSync(path.join(EXT, part), path.join(studio, part), {
      recursive: true,
    });
  }
  fs.cpSync(path.join(EXT, "out"), path.join(studio, "out"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}out${path.sep}test`),
  });
  fs.symlinkSync(
    path.join(EXT, "node_modules"),
    path.join(studio, "node_modules"),
  );
  fs.cpSync(
    path.join(HERE, "screenshot-driver"),
    path.join(extensions, "magpylib.screenshot-driver-0.0.1"),
    { recursive: true },
  );
}

/** The scene, written by the engine: see `screenshot.py scene`. */
function scene() {
  const file = path.join(work, "halbach.magpy.json");
  execFileSync(PYTHON, [HELPER, "scene", file, EXAMPLE]);
  return file;
}

/** The settings; written again with the other theme, VS Code applies it live. */
function profile(theme) {
  fs.writeFileSync(
    path.join(user, "User", "settings.json"),
    JSON.stringify({
      "workbench.colorTheme": theme,
      "workbench.startupEditor": "none",
      "workbench.welcomePage.walkthroughs.openOnInstall": false,
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "workbench.tips.enabled": false,
      "workbench.layoutControl.enabled": false,
      "window.commandCenter": false,
      "chat.disableAIFeatures": true,
      "editor.minimap.enabled": false,
      "breadcrumbs.enabled": false,
      "security.workspace.trust.enabled": false,
      "extensions.ignoreRecommendations": true,
      "extensions.autoUpdate": false,
      "update.mode": "none",
      "telemetry.telemetryLevel": "off",
      "magpylib-studio.pythonPath": PYTHON,
    }),
  );
}

/** One message to a DevTools target, answered by id. */
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  let next = 0;
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    pending.get(data.id)?.(data);
    pending.delete(data.id);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  // the value of an expression, evaluated in the target's page
  const evaluate = async (expression) =>
    (
      await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    ).result?.result?.value;
  return { send, evaluate, close: () => socket.close() };
}

const targets = async (port) =>
  (await fetch(`http://127.0.0.1:${port}/json`)).json();

/** The window itself. */
async function workbench(port) {
  const page = (await targets(port)).find(
    (target) => target.type === "page" && /workbench/.test(target.url),
  );
  if (!page) {
    throw new Error("no workbench window among the DevTools targets");
  }
  return connect(page);
}

/** In a webview's frame: the window its content runs in, inside its host. */
const CONTENT = `(document.querySelector("iframe#active-frame")?.contentWindow ?? window)`;

/** Makes the content's `requestAnimationFrame` hand every frame the time in
 *  `shotClock.now`, so what the 3D view draws at a time is set from here. Once
 *  a page: a webview loaded again needs it again. */
const HOLD = `(() => {
  const view = ${CONTENT};
  if (!view.shotClock) {
    const ask = view.requestAnimationFrame.bind(view);
    view.shotClock = { now: view.performance.now() };
    view.requestAnimationFrame = (draw) => ask(() => draw(view.shotClock.now));
  }
  return view.shotClock.now;
})()`;

/** What a person would do in the 3D view before taking it, done through its
 *  own buttons: frame everything again at the window's new size, and hide
 *  the bore's arrows from the legend, so that only its field lines show. */
const DRESS = `(async () => {
  const view = ${CONTENT};
  const deep = (root, selector) => [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll("*")].flatMap((el) => (el.shadowRoot ? deep(el.shadowRoot, selector) : [])),
  ];
  const button = (name) =>
    deep(view.document, "button").find((b) => (b.title || b.getAttribute("aria-label") || "").startsWith(name));
  const pause = () => new Promise((resolve) => view.setTimeout(resolve, 600));
  const done = [];
  button("Legend")?.click();
  await pause();
  const row = deep(view.document, ".magpy-legend-row").find((r) => /^bore's pixels/.test(r.title));
  if (row) {
    row.querySelector(".magpy-legend-eye").click();
    done.push("pixels hidden");
  }
  await pause();
  button("Legend")?.click();
  button("Frame everything")?.click();
  if (button("Frame everything")) done.push("framed");
  await pause();
  return done;
})()`;

/** The 3D view's webview: of the webviews, the one with the largest canvas. */
async function sceneView(port) {
  let best = null;
  for (const target of await targets(port)) {
    if (target.type !== "iframe") continue;
    const frame = await connect(target);
    const area = await frame.evaluate(`(() => {
      const view = ${CONTENT};
      return Math.max(0, ...[...view.document.querySelectorAll("canvas")].map((c) => c.width * c.height));
    })()`);
    if (area > (best?.area ?? 0)) {
      best?.frame.close();
      best = { frame, area };
    } else {
      frame.close();
    }
  }
  if (!best) {
    throw new Error("no webview with a canvas among the DevTools targets");
  }
  return best.frame;
}

install();
profile("Default Dark Modern");
const file = scene();
const env = { ...process.env, SHOT_DIR: results, SHOT_SCENE: file };
delete env.ELECTRON_RUN_AS_NODE;
const port = 9300 + Math.floor(Math.random() * 500);
const child = spawn(
  vscodeApp(),
  [
    work,
    "--user-data-dir",
    user,
    "--extensions-dir",
    extensions,
    "--skip-welcome",
    "--skip-release-notes",
    `--remote-debugging-port=${port}`,
    // a window behind others is hidden to its pages, which then draw no
    // frames: the lines would not flow while someone works in front of it
    "--disable-backgrounding-occluded-windows",
  ],
  { env, stdio: "ignore", detached: true },
);
let failed = false;
try {
  const started = Date.now();
  while (!fs.existsSync(path.join(results, "ready"))) {
    if (Date.now() - started > 120_000) {
      throw new Error("the driver never said the window was ready");
    }
    await wait(500);
  }
  const window = await workbench(port);
  await window.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  // the webviews lay out again at the new size, and the 3D view redraws
  await wait(4000);
  const view = await sceneView(port);
  const dressed = await view.evaluate(DRESS);
  if (!dressed?.includes("pixels hidden") || !dressed.includes("framed")) {
    throw new Error(`the 3D view was not dressed: ${JSON.stringify(dressed)}`);
  }
  await wait(1500);
  // the cut goes through the middle of the 3D view: the largest webview
  const [x, y] = await window.evaluate(`(() => {
    const [r] = [...document.querySelectorAll("iframe")]
      .map((frame) => frame.getBoundingClientRect())
      .sort((a, b) => b.width * b.height - a.width * a.height);
    return [(r.x + r.width / 2) / ${WIDTH}, (r.y + r.height / 2) / ${HEIGHT}];
  })()`);
  // each theme's frames on a whole period of their own, later than any
  // time the view has drawn at, so its clock only goes forward
  let period = 0;
  const takeFrames = async (theme) => {
    const held = await view.evaluate(HOLD);
    if (held === undefined) {
      throw new Error("could not hold the 3D view's clock");
    }
    period = Math.max(period, Math.ceil((held + 5000) / PERIOD_MS));
    for (let k = 0; k < FRAMES; k++) {
      const now = (period + k / FRAMES) * PERIOD_MS;
      if ((await view.evaluate(`${CONTENT}.shotClock.now = ${now}`)) !== now) {
        throw new Error("the 3D view's clock was let go");
      }
      await wait(250);
      const shot = await window.send("Page.captureScreenshot", {
        format: "png",
      });
      if (!shot.result) {
        throw new Error(`capture failed: ${JSON.stringify(shot.error)}`);
      }
      fs.writeFileSync(
        path.join(base, `${theme}-${k}.png`),
        Buffer.from(shot.result.data, "base64"),
      );
    }
    period += 2;
  };
  await takeFrames("dark");
  // the workbench and the webviews take the theme, and the 3D view redraws
  profile("Default Light Modern");
  await wait(4000);
  await takeFrames("light");
  view.close();
  window.close();
  execFileSync(
    PYTHON,
    [HELPER, "join", base, FRAMES, x, y, out, gif].map(String),
  );
  console.log(`screenshot: ${out}, ${gif}`);
} catch (error) {
  failed = true;
  console.error(`screenshot: ${error.message}`);
  const log = path.join(results, "driver.log");
  if (fs.existsSync(log)) {
    console.error(fs.readFileSync(log, "utf8"));
  }
} finally {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
  spawnSync("pkill", ["-9", "-f", user]);
  await wait(1000);
  fs.rmSync(base, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
