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
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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
  const inKernel = (code) =>
    evaluate(`(async () => {
      const kernel = (${TAB}).context.sessionContext.session.kernel;
      let out = "";
      const future = kernel.requestExecute({ code: ${JSON.stringify(code)}, store_history: false });
      future.onIOPub = (m) => { if (m.header.msg_type === "stream") out += m.content.text; };
      await future.done;
      return out.trim();
    })()`);

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

  await inKernel('__mstudio.variables = {"n": 8}');
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
      async () => (await inKernel('print(__mstudio.variables["n"])')) === "16",
      10000,
    ),
  );
  check(
    "as one step to undo",
    (await inKernel('print(__mstudio.undo(), __mstudio.variables["n"])')) ===
      "True 8",
  );

  // the view follows the tab's height: the window made shorter, the view is
  // as tall as the tab again, and not as tall as it was
  const tabHeight = () => evaluate(`(${TAB}).content.node.clientHeight`);
  const viewHeight = async () =>
    Number(await inKernel("print(__mstudio.height)"));
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
