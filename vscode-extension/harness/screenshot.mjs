/**
 * The README's screenshot, taken from the studio as it stands:
 *
 *   npm run screenshot                   -> ../docs/halbach.png
 *   node harness/screenshot.mjs out.png  -> anywhere else
 *
 * The studio is installed into a VS Code of its own -- the one the test runner
 * downloaded, with a fresh profile: dark theme, no AI features, no tips --
 * beside the driver in `screenshot-driver/`, which opens the Halbach example
 * and lays the window out. VS Code then renders its own window through its
 * DevTools protocol, so no screen-recording permission is needed and nothing
 * else on the screen can end up in the picture.
 *
 * 1800 x 1080 CSS pixels drawn at 4/3: a 2400 x 1440 PNG. With Pillow in the
 * engine's `.venv` it is reduced to 256 colours, about 320 KB instead of 830,
 * which the 3D view's shading survives without visible banding.
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== "darwin") {
  console.error("screenshot: macOS only, for now");
  process.exit(2);
}
const out = path.resolve(
  process.argv[2] ?? path.join(REPO, "docs", "halbach.png"),
);

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

/** The scene, written by the engine: the built-in Halbach example. */
function scene() {
  const file = path.join(work, "halbach.magpy.json");
  execFileSync(PYTHON, [
    "-c",
    `
import json, sys
from magpylib_studio.session import MagpylibStudioSession
s = MagpylibStudioSession()
s.load_example("halbach")
json.dump(s.to_dict(), open(sys.argv[1], "w"), indent=2)
`,
    file,
  ]);
  return file;
}

function profile() {
  fs.writeFileSync(
    path.join(user, "User", "settings.json"),
    JSON.stringify({
      "workbench.colorTheme": "Default Dark Modern",
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

/** One message to the window's DevTools endpoint, answered by id. */
async function devtools(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find(
    (target) => target.type === "page" && /workbench/.test(target.url),
  );
  if (!page) {
    throw new Error("no workbench window among the DevTools targets");
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
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
  return { send, close: () => socket.close() };
}

/** 256 colours when Pillow is there; the PNG as taken when it is not. */
function finish(raw) {
  const reduced = spawnSync(
    PYTHON,
    [
      "-c",
      `
import sys
from PIL import Image
image = Image.open(sys.argv[1]).convert("RGB")
image.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(sys.argv[2], optimize=True)
`,
      raw,
      out,
    ],
    { encoding: "utf8" },
  );
  if (reduced.status !== 0) {
    fs.copyFileSync(raw, out);
    console.log("no Pillow in .venv: written as taken");
  }
}

install();
profile();
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
  const window = await devtools(port);
  await window.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  // the webviews lay out again at the new size, and the 3D view redraws
  await wait(4000);
  const shot = await window.send("Page.captureScreenshot", { format: "png" });
  window.close();
  if (!shot.result) {
    throw new Error(`capture failed: ${JSON.stringify(shot.error)}`);
  }
  const raw = path.join(base, "raw.png");
  fs.writeFileSync(raw, Buffer.from(shot.result.data, "base64"));
  finish(raw);
  console.log(`screenshot: ${out}`);
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
