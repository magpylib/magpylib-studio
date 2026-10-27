/**
 * The checks the test runner cannot make, made in VS Code itself:
 *
 *   node harness/check-window-life.mjs [reload] [crash] [memory]
 *
 * - reload: two scenes with unsaved edits, a file and an example, come back
 *   from a window reload unsaved and holding their edits;
 * - crash: VS Code killed a few seconds after an edit, the edit comes back on
 *   the next start -- by VS Code's own backup, or offered by the studio's;
 * - memory: what one scene tab and eight take, VS Code's processes and the
 *   engine's together.
 *
 * The studio is installed, copied into an extensions folder of its own, since
 * a window for extension development keeps no backups; beside it the driver
 * in `window-checks/`, which does what a person would and writes what it
 * finds. VS Code is the one the test runner downloaded, with a profile of its
 * own, opened on `sandbox/`, its engine the repo's `.venv` -- this checkout's,
 * named in the profile's settings as an installed studio's would be. Run
 * `npm run compile` first: the studio installed is `out/` as it stands.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(EXT, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8"));
const PYTHON = path.join(REPO, ".venv", "bin", "python");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== "darwin") {
  // ps, pkill and the downloaded VS Code's layout are macOS's here
  console.error("check-window-life: macOS only, for now");
  process.exit(2);
}

const asked = process.argv.slice(2);
const checks = asked.length ? asked : ["reload", "crash", "memory"];

function vscodeApp() {
  const root = path.join(EXT, ".vscode-test");
  const found = fs
    .readdirSync(root)
    .filter((name) => name.startsWith("vscode-darwin"))
    .sort()
    .pop();
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
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mwc-"));
const extensions = path.join(base, "x");
const results = path.join(base, "r");
fs.mkdirSync(results, { recursive: true });

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
    path.join(EXT, "harness", "window-checks"),
    path.join(extensions, "magpylib.window-check-driver-0.0.1"),
    { recursive: true },
  );
}

/** The scene files, written by the engine: the built-in examples. */
function scenes() {
  const files = path.join(base, "scenes");
  fs.mkdirSync(files);
  const roots = execFileSync(
    PYTHON,
    [
      "-c",
      `
import json, sys
from magpylib_studio.session import MagpylibStudioSession, EXAMPLES, UNLISTED_EXAMPLES
out = {}
# the gallery's, and the unlisted ones the checks below open
for name in [*EXAMPLES, *UNLISTED_EXAMPLES]:
    s = MagpylibStudioSession()
    s.load_example(name)
    path = f"{sys.argv[1]}/{name}.magpy.json"
    json.dump(s.to_dict(), open(path, "w"))
    out[name] = [path, s.to_dict()["objects"][0]["id"]]
print(json.dumps(out))
`,
      files,
    ],
    { encoding: "utf8" },
  );
  const examples = JSON.parse(roots);
  fs.copyFileSync(examples.halbach[0], path.join(files, "crash.magpy.json"));
  fs.copyFileSync(examples.halbach[0], path.join(files, "reload.magpy.json"));
  return {
    halbach: path.join(files, "reload.magpy.json"),
    crash: path.join(files, "crash.magpy.json"),
    memory: Object.values(examples).map(([file, root]) => ({
      path: file,
      root,
    })),
  };
}

function profile(name) {
  const user = path.join(base, name);
  fs.mkdirSync(path.join(user, "User"), { recursive: true });
  fs.writeFileSync(
    path.join(user, "User", "settings.json"),
    JSON.stringify({
      "files.hotExit": "onExit",
      "workbench.startupEditor": "none",
      "security.workspace.trust.enabled": false,
      "window.restoreWindows": "all",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "telemetry.telemetryLevel": "off",
      "workbench.editor.enablePreview": true,
      "magpylib-studio.pythonPath": PYTHON,
    }),
  );
  return user;
}

/** What `pid` and everything under it hold in memory, in MB, by kind. */
function memory(pid) {
  const rows = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
    encoding: "utf8",
  })
    .stdout.trim()
    .split("\n")
    .map((line) => {
      const [p, pp, rss, ...comm] = line.trim().split(/\s+/);
      return { pid: +p, ppid: +pp, rss: +rss, comm: comm.join(" ") };
    });
  const under = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!under.has(row.pid) && under.has(row.ppid)) {
        under.add(row.pid);
        grew = true;
      }
    }
  }
  const kinds = {};
  for (const row of rows.filter((r) => under.has(r.pid))) {
    const kind = /Renderer/.test(row.comm)
      ? "windows and views"
      : /Plugin/.test(row.comm)
        ? "extension host"
        : /python/i.test(row.comm)
          ? "engine"
          : "VS Code's other processes";
    kinds[kind] = (kinds[kind] ?? 0) + row.rss / 1024;
  }
  return kinds;
}

const total = (kinds) => Object.values(kinds).reduce((a, b) => a + b, 0);

/** One launch of VS Code in `phase`; resolves when it has gone. */
async function launch(user, phase, files) {
  fs.writeFileSync(
    path.join(results, "state.json"),
    JSON.stringify({ phase, files }),
  );
  const env = {
    ...process.env,
    WINDOW_CHECK_DIR: results,
    WINDOW_CHECK_PHASE: phase,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [
    path.join(REPO, "sandbox"),
    "--user-data-dir",
    user,
    "--extensions-dir",
    extensions,
    "--skip-welcome",
    "--skip-release-notes",
  ];
  const log = fs.openSync(path.join(results, `${phase}.log`), "a");
  const child = spawn(vscodeApp(), args, { env, stdio: ["ignore", log, log] });
  const started = Date.now();
  const marks = {};
  let ended = null;
  const watch = setInterval(() => {
    if (fs.existsSync(path.join(results, "crash-now")) && !ended) {
      ended = "killed";
      fs.rmSync(path.join(results, "crash-now"));
      spawnSync("pkill", ["-9", "-f", user]);
    }
    for (const line of lines()) {
      if (line.mark && !marks[line.mark]) {
        marks[line.mark] = { kinds: memory(child.pid), tabs: line.tabs };
      }
    }
    if (Date.now() - started > 180000 && !ended) {
      ended = "still running after 180 s, ended";
      spawnSync("pkill", ["-f", user]);
    }
  }, 300);
  await new Promise((resolve) => child.on("exit", resolve));
  clearInterval(watch);
  await wait(1500);
  if (spawnSync("pgrep", ["-f", user]).status === 0) {
    spawnSync("pkill", ["-9", "-f", user]);
  }
  return { ended, marks };
}

function lines() {
  try {
    return fs
      .readFileSync(path.join(results, "results.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

install();
const files = scenes();
const verdicts = [];

if (checks.includes("reload")) {
  const run = await launch(profile("u1"), "reload-1", files);
  if (run.ended)
    verdicts.push({ check: "reload", pass: false, detail: run.ended });
}
if (checks.includes("crash")) {
  const user = profile("u2");
  const first = await launch(user, "crash-1", files);
  if (first.ended !== "killed") {
    verdicts.push({
      check: "crash",
      pass: false,
      detail: `not killed: ${first.ended}`,
    });
  } else {
    await launch(user, "crash-2", files);
  }
}
if (checks.includes("memory")) {
  const { marks } = await launch(profile("u3"), "memory", files);
  if (marks.one && marks.eight) {
    const one = total(marks.one.kinds);
    const eight = total(marks.eight.kinds);
    const by = Object.keys(marks.eight.kinds)
      .map(
        (kind) =>
          `${kind} ${Math.round((marks.eight.kinds[kind] ?? 0) - (marks.one.kinds[kind] ?? 0))}`,
      )
      .join(", ");
    // the views' share is the tabs'; the rest of VS Code moves on its own
    const views =
      (marks.eight.kinds["windows and views"] ?? 0) -
      (marks.one.kinds["windows and views"] ?? 0);
    verdicts.push({
      check: "memory: one scene tab, then eight",
      pass: true,
      detail:
        `${Math.round(views / (marks.eight.tabs - 1))} MB a tab more in the views; ` +
        `${Math.round(one)} MB in all with one, ${Math.round(eight)} MB with ` +
        `${marks.eight.tabs} (${by} MB)`,
    });
  } else {
    verdicts.push({
      check: "memory",
      pass: false,
      detail: "the marks never came",
    });
  }
}

for (const line of lines()) {
  if (line.check) verdicts.push(line);
}
for (const { check, pass, detail } of verdicts) {
  console.log(`${pass ? "ok  " : "FAIL"}  ${check}: ${detail}`);
}
console.log(`\nlogs and results: ${results}`);
process.exit(verdicts.every((v) => v.pass) ? 0 : 1);
