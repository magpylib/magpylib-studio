/**
 * The JupyterLab scene tab, end to end, in a real JupyterLab and headless
 * Chrome:
 *
 *   JLAB_PYTHON=<python with jupyterlab and magpylib-studio[widget]> npm run check
 *
 * A scene file opens as the tab, its widget draws, an edit marks the tab
 * unsaved and Save writes it, the file changed on disk and Revert are one
 * undo step, the view follows the tab's height, and closing the tab stops its
 * kernel. The lab is a private one on a spare port, in a folder of its own,
 * with this folder's build as its only extra extension: nothing installed is
 * touched. Run `npm run build` first. Set CHROME to name a browser.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const PY = process.env.JLAB_PYTHON;
/** Chrome or Chromium: `CHROME`, else where each system keeps it. */
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
  return undefined;
}
const CHROME = findChrome();
if (!CHROME) {
  console.error(
    "check-lab: no Chrome or Chromium found; set CHROME to name one",
  );
  process.exit(2);
}
if (!PY) {
  console.error(
    "check-lab: set JLAB_PYTHON to a python with jupyterlab and magpylib-studio[widget]",
  );
  process.exit(2);
}
const NAME = JSON.parse(
  fs.readFileSync(path.join(EXT, "labextension", "package.json"), "utf8"),
).name;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mstudio-lab-"));
const root = path.join(base, "root");
const extensions = path.join(base, "extensions");
fs.mkdirSync(root);
fs.mkdirSync(extensions);
fs.symlinkSync(path.join(EXT, "labextension"), path.join(extensions, NAME));
const FILE = path.join(root, "halbach.magpy.json");
const python = (code) =>
  execFileSync(PY, ["-c", code], { encoding: "utf8" }).trim();
python(`
from magpylib_studio.examples.halbach_ring import halbach_ring
halbach_ring.build().save(${JSON.stringify(FILE)})`);
const nOnDisk = () =>
  python(`
from magpylib_studio.session import MagpylibStudioSession
s = MagpylibStudioSession(); s.load_scene(${JSON.stringify(FILE)})
print({v["name"]: v["value"] for v in s.get_variables()["variables"]}["n"])`);

const labPort = await freePort();
const lab = spawn(
  PY,
  [
    "-m",
    "jupyter",
    "lab",
    "--no-browser",
    `--port=${labPort}`,
    "--IdentityProvider.token=",
    "--ServerApp.disable_check_xsrf=True",
    "--LabApp.expose_app_in_browser=True",
    `--LabApp.extra_labextensions_path=${extensions}`,
    `--ServerApp.root_dir=${root}`,
  ],
  {
    stdio: "ignore",
    detached: true,
    // the default kernel runs `python` off the PATH: this one's, so that it
    // can import the package
    env: {
      ...process.env,
      PATH: `${path.dirname(PY)}${path.delimiter}${process.env.PATH}`,
    },
  },
);
const LAB = `http://127.0.0.1:${labPort}`;
const chromePort = await freePort();
const profile = path.join(base, "chrome");
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    "--window-size=1500,950",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "about:blank",
  ],
  { stdio: "ignore", detached: true },
);

let failures = 0;
const check = (what, ok, said = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${said ? `: ${said}` : ""}`);
  if (!ok) failures++;
};

async function until(test, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await test().catch(() => false)) return true;
    await wait(250);
  }
  return false;
}

try {
  if (
    !(await until(async () => (await fetch(`${LAB}/api/status`)).ok, 60000))
  ) {
    throw new Error("the lab never answered");
  }
  let page;
  await until(async () => {
    page = (
      await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json()
    ).find((t) => t.type === "page");
    return Boolean(page);
  }, 20000);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let next = 0;
  const pending = new Map();
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    pending.get(data.id)?.(data);
    pending.delete(data.id);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const answer = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (answer.result?.exceptionDetails) {
      throw new Error(answer.result.exceptionDetails.exception?.description);
    }
    return answer.result?.result?.value;
  };
  const TAB = `[...jupyterapp.shell.widgets("main")].find((w) => w.context?.path === "halbach.magpy.json")`;
  // the scene's name in the kernel is the file's own: `__view` here
  const FIND =
    '__view = [v for k, v in list(globals().items()) if k.startswith("__mstudio_") and not k.endswith("_comm")][-1]\n';
  const inKernel = (code) =>
    evaluate(`(async () => {
      const kernel = (${TAB}).context.sessionContext.session.kernel;
      let out = "";
      const future = kernel.requestExecute({ code: ${JSON.stringify(FIND + code)}, store_history: false });
      future.onIOPub = (m) => { if (m.header.msg_type === "stream") out += m.content.text; };
      await future.done;
      return out.trim();
    })()`);

  // a headless page has no focus, and JupyterLab's current tab follows focus
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Page.navigate", { url: `${LAB}/lab?reset` });
  await until(() => evaluate("!!window.jupyterapp"), 60000);
  await evaluate("jupyterapp.started.then(() => jupyterapp.restored)");
  check(
    "a scene file opens in the scene tab by default",
    (await evaluate(
      `jupyterapp.docRegistry.defaultWidgetFactory("halbach.magpy.json").name`,
    )) === "Magpylib Studio",
  );
  await evaluate(
    `jupyterapp.commands.execute("docmanager:open", { path: "halbach.magpy.json" }).then(() => true)`,
  );
  const drew = await until(
    () => evaluate(`!!(${TAB})?.node.querySelector("canvas")`),
    90000,
  );
  check(
    "the tab draws the scene",
    drew,
    drew
      ? ""
      : await evaluate(
          `(${TAB})?.content.node.innerText.slice(0, 900) ?? "no tab"`,
        ),
  );
  check(
    "opened, it is saved",
    (await evaluate(`(${TAB}).context.model.dirty`)) === false,
  );
  check(
    "no kernel is asked for",
    (await evaluate(`document.querySelectorAll(".jp-Dialog").length`)) === 0,
  );

  await inKernel('__view.variables = {"n": 8}');
  check(
    "an edit marks it unsaved",
    await until(() => evaluate(`(${TAB}).context.model.dirty`), 10000),
  );
  await evaluate(`(${TAB}).context.save()`);
  check("Save writes the edit", nOnDisk() === "8", `n = ${nOnDisk()} on disk`);
  check(
    "saved, it is clean",
    (await evaluate(`(${TAB}).context.model.dirty`)) === false,
  );
  await inKernel('__view.variables = {"n": 10}');
  await until(() => evaluate(`(${TAB}).context.model.dirty`), 10000);
  await inKernel("__view.undo()");
  check(
    "an edit undone back to the file is clean again",
    await until(
      async () => !(await evaluate(`(${TAB}).context.model.dirty`)),
      10000,
    ),
  );

  python(`
import json
from magpylib_studio.session import MagpylibStudioSession
s = MagpylibStudioSession(); s.load_scene(${JSON.stringify(FILE)})
s.set_variable("n", 16)
open(${JSON.stringify(FILE)}, "w").write(json.dumps(s.to_dict(), indent=2) + "\\n")`);
  await evaluate(`(${TAB}).context.revert()`);
  check(
    "the file changed on disk, Revert takes it in",
    await until(
      async () => (await inKernel('print(__view.variables["n"])')) === "16",
      10000,
    ),
  );
  check(
    "as one step to undo",
    (await inKernel('print(__view.undo(), __view.variables["n"])')) ===
      "True 8",
  );

  // a file of a newer studio is refused, and never written over
  const kept = fs.readFileSync(FILE, "utf8");
  fs.writeFileSync(
    FILE,
    JSON.stringify({ ...JSON.parse(kept), version: 99 }, null, 2) + "\n",
  );
  await evaluate(`(${TAB}).context.revert()`);
  const dialog = () =>
    evaluate(`document.querySelector(".jp-Dialog")?.innerText ?? ""`);
  check(
    "a file of a newer studio is refused, and said",
    await until(async () => /not taken in/.test(await dialog()), 10000),
  );
  await evaluate(
    `document.querySelector(".jp-Dialog .jp-mod-accept")?.click(), true`,
  );
  await inKernel('__view.variables = {"n": 6}');
  await wait(2000);
  check(
    "and the view is read only",
    (await inKernel("print(__view.editable)")) === "False",
  );
  check(
    "and an edit then writes nothing over it",
    /"version": 99/.test(await evaluate(`(${TAB}).context.model.toString()`)),
  );
  fs.writeFileSync(FILE, kept);
  await evaluate(`(${TAB}).context.revert()`);
  await until(
    async () => (await inKernel('print(__view.variables["n"])')) === "16",
    10000,
  );
  check(
    "a file it can read makes it editable again",
    (await inKernel("print(__view.editable)")) === "True",
  );

  // a second view of the file shows the same scene
  // New View for File, on the tab in front
  await evaluate(`jupyterapp.shell.activateById((${TAB}).id), true`);
  await evaluate(
    `jupyterapp.commands.execute("docmanager:clone").then(() => true, () => false)`,
  );
  const views = `[...jupyterapp.shell.widgets("main")].filter((w) => w.context?.path === "halbach.magpy.json")`;
  check(
    "a second view of the file draws the scene too",
    await until(
      () =>
        evaluate(
          `${views}.length === 2 && ${views}.every((w) => !!w.node.querySelector("canvas"))`,
        ),
      30000,
    ),
  );
  await evaluate(
    `(() => { const [, second] = ${views}; second.close(); return true; })()`,
  );
  await inKernel('__view.variables = {"n": 14}');
  check(
    "closed, the first view still keeps the file",
    await until(() => evaluate(`(${TAB}).context.model.dirty`), 10000),
  );

  // a restarted kernel draws the scene again
  await evaluate(
    `(${TAB}).context.sessionContext.restartKernel().then(() => true)`,
  );
  check(
    "a restarted kernel draws the scene again",
    (await until(
      async () => (await inKernel('print(__view.variables["n"])')) !== "",
      60000,
    )) &&
      (await until(
        () => evaluate(`!!(${TAB}).node.querySelector("canvas")`),
        30000,
      )),
  );
  check(
    "and keeps what the tab had unsaved",
    (await inKernel('print(__view.variables["n"])')) === "14" &&
      (await evaluate(`(${TAB}).context.model.dirty`)) === true,
  );

  // the toolbar names the kernel and picks another: the scene is made again
  check(
    "the toolbar names the scene's kernel",
    /Python/.test(await evaluate(`(${TAB}).toolbar.node.innerText`)),
  );
  await evaluate(
    `(${TAB}).context.sessionContext.changeKernel({ name: "python3" }).then(() => true)`,
  );
  check(
    "another kernel chosen draws the scene again, unsaved edits kept",
    (await until(
      async () => (await inKernel('print(__view.variables["n"])')) === "14",
      60000,
    )) && (await evaluate(`(${TAB}).context.model.dirty`)) === true,
  );

  // the view follows the tab's height: the window made shorter, the view is
  // as tall as the tab again, and not as tall as it was
  const tabHeight = () => evaluate(`(${TAB}).content.node.clientHeight`);
  const viewHeight = async () => Number(await inKernel("print(__view.height)"));
  const before = await viewHeight();
  const tabBefore = await tabHeight();
  // a headless window ignores its bounds: the page's viewport, and the resize
  // JupyterLab lays itself out on
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1500,
    height: 650,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(`window.dispatchEvent(new Event("resize")), true`);
  await until(async () => (await tabHeight()) < tabBefore, 5000);
  const followed = await until(
    async () =>
      (await viewHeight()) === Math.max(240, (await tabHeight()) - 12),
    10000,
  );
  const after = await viewHeight();
  check(
    "the view follows the tab's height",
    followed && after < before,
    `view ${before} then ${after}, tab ${await tabHeight()}`,
  );

  const kernels = async () =>
    (await (await fetch(`${LAB}/api/sessions`)).json()).filter(
      (s) => s.path === "halbach.magpy.json",
    ).length;
  check("open, the tab has its kernel", (await kernels()) === 1);
  await evaluate(
    `(() => { const t = ${TAB}; t.context.model.dirty = false; t.close(); return true; })()`,
  );
  check(
    "closed, its kernel stops",
    await until(async () => (await kernels()) === 0, 15000),
  );
  ws.close();
} catch (error) {
  check("the run", false, error.message);
} finally {
  for (const child of [chrome, lab]) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // gone already
    }
  }
  await wait(1500);
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    // a browser still writing its profile: the system's temp folder clears it
  }
}
console.log(
  failures
    ? `check-lab: ${failures} check(s) failed.`
    : "check-lab: all passed.",
);
process.exit(failures ? 1 : 0);
