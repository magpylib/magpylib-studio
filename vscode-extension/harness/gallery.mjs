/**
 * The example gallery's pictures, drawn by the studio itself:
 *
 *   npm run gallery            -> media/gallery/NAME-light.webp, NAME-dark.webp
 *   npm run gallery -- rings   -> those of the examples named only
 *
 * Every example the gallery offers, as it loads, saved as a page and dressed
 * as a picture (`gallery.py`), is opened in headless Chrome and taken at
 * 400 x 300 CSS pixels, twice that in pixels, in each theme: 4:3, as every
 * example picture in magpylib's docs is, so these sit among them. The field
 * lines flow, so each page is handed one fixed time to draw at: the same scene
 * makes the same picture, and a run that changed nothing changes no file.
 *
 * Run it after changing an example or how the view draws one, and commit the
 * pictures. They are plain files so that anything else showing the examples
 * -- the docs -- can use the same ones.
 *
 * Needs Chrome or Chromium (set CHROME to name one) and a python with the
 * widget's extra installed. WebGL runs on SwiftShader, so no GPU is needed.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { enginePython } = require("./engine-python.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "media", "gallery");
const WIDTH = 400;
const HEIGHT = 300; // gallery.py's HEIGHT
/** The time every frame is drawn at: a third of the way through a pulse of
 *  the field lines' flow (`scene3d.mjs` runs 0.8 a second). */
const AT = 400;
/** Long enough for a page to unpack, build its scene and draw it. */
const SETTLE_MS = 2500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    "--no-first-run",
    "--no-default-browser-check",
  ];
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

/** The tab Chrome opened, as one message at a time answered by id. */
async function tab(port) {
  const page = (
    await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  ).find((target) => target.type === "page");
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

const python = enginePython();
if (!python) {
  console.error("gallery: no python here can import the engine");
  process.exit(1);
}
const chrome = findChrome();
if (!chrome) {
  console.error("gallery: no Chrome or Chromium found; set CHROME to name one");
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "magpy-gallery-"));
const listed = JSON.parse(
  execFileSync(python, [path.join(HERE, "gallery.py"), work], {
    encoding: "utf8",
  }),
);
const asked = process.argv.slice(2);
const names = asked.length
  ? listed.filter((name) => asked.includes(name))
  : listed;
fs.mkdirSync(OUT, { recursive: true });

const { port, proc } = await launch(chrome, path.join(work, "chrome"));
try {
  const page = await tab(port);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `{
      const ask = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (draw) => ask(() => draw(${AT}));
    }`,
  });
  for (const name of names) {
    for (const theme of ["light", "dark"]) {
      await page.send("Page.navigate", {
        url: `file://${path.join(work, `${name}-${theme}.html`)}`,
      });
      await wait(SETTLE_MS);
      const shot = await page.send("Page.captureScreenshot", {
        format: "webp",
        quality: 85,
      });
      const file = path.join(OUT, `${name}-${theme}.webp`);
      fs.writeFileSync(file, Buffer.from(shot.result.data, "base64"));
      console.log(
        `wrote media/gallery/${path.basename(file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`,
      );
    }
  }
  page.close();
} finally {
  proc.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
