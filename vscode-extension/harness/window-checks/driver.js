/**
 * Drives the studio through what the test runner cannot: a window reload, a
 * crash of VS Code, eight scene tabs. Loaded beside the installed studio by
 * `harness/check-window-life.mjs`, one phase per launch (WINDOW_CHECK_PHASE,
 * or the phase a reload left in WINDOW_CHECK_DIR/state.json), and silent in
 * any window that did not ask for it.
 *
 * What it finds goes to WINDOW_CHECK_DIR/results.jsonl, a line each, read by
 * the launcher. It answers the studio's own prompts through the studio's own
 * API object: each extension has one, so patching this one's would not reach
 * the studio's calls.
 */
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const vscode = require("vscode");

const STUDIO = "magpylib.magpylib-studio-vscode";
const VIEW = "magpylibStudio.scene";
const dir = process.env.WINDOW_CHECK_DIR;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  } catch {
    return { phase: process.env.WINDOW_CHECK_PHASE };
  }
}

function writeState(state) {
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
}

function say(entry) {
  fs.appendFileSync(
    path.join(dir, "results.jsonl"),
    JSON.stringify({ at: Date.now(), ...entry }) + "\n",
  );
}

async function until(predicate, what, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    }
    await pause(200);
  }
}

/** The scene in front, as the studio's virtual document has it. */
async function front() {
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.parse("magpylib-studio:/scene.json"),
  );
  try {
    return JSON.parse(doc.getText());
  } catch {
    return { objects: [] };
  }
}

function ids(objects, into = new Set()) {
  for (const spec of objects || []) {
    into.add(spec.id);
    ids(spec.children, into);
  }
  return into;
}

const sceneTabs = () =>
  vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === VIEW,
    );

const tabOf = (uri) =>
  sceneTabs().find((tab) => tab.input.uri.toString() === uri.toString());

async function open(uri, root) {
  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW, {
    preview: false,
  });
  return until(
    async () => ids((await front()).objects).has(root),
    `${root} in front`,
  );
}

async function remove(node) {
  await vscode.commands.executeCommand("magpylib-studio.removeObject", {
    visible: true,
    ...node,
  });
  await until(
    async () => !ids((await front()).objects).has(node.id),
    `${node.id} removed`,
  );
}

const R2 = {
  id: "r2",
  type: "magnet.Cuboid",
  label: "Magnet 2",
  parent: "ring2",
};
const TURN = {
  id: "turn",
  type: "current.Circle",
  label: "Turn",
  parent: "coil",
};

const phases = {
  /** Two scenes with unsaved edits, a file and an example, then a reload. */
  async "reload-1"(state) {
    const file = vscode.Uri.file(state.files.halbach);
    await open(file, "halbach");
    await remove(R2);
    await vscode.commands.executeCommand("magpylib-studio.loadExample", "coil");
    await until(
      async () => ids((await front()).objects).has("coil"),
      "the coil example",
    );
    await remove(TURN);
    const example = sceneTabs().find(
      (tab) => tab.input.uri.scheme === "untitled",
    ).input.uri;
    await until(
      () => tabOf(file)?.isDirty && tabOf(example)?.isDirty,
      "both tabs unsaved",
    );
    await pause(3000); // VS Code backs up shortly after an edit
    writeState({ ...state, phase: "reload-2", example: example.toString() });
    say({ step: "reloading with two unsaved scenes" });
    // cancelled as the window goes, which is the reload happening
    await vscode.commands.executeCommand("workbench.action.reloadWindow").then(
      () => undefined,
      () => undefined,
    );
  },

  /** Both back, unsaved, holding their edits. */
  async "reload-2"(state) {
    const file = vscode.Uri.file(state.files.halbach);
    const example = vscode.Uri.parse(state.example);
    await until(() => sceneTabs().length >= 2, "the two scene tabs back");
    const back = [
      [file, "halbach", "r2"],
      [example, "coil", "turn"],
    ];
    for (const [uri, root, removed] of back) {
      const dirty = tabOf(uri)?.isDirty;
      await open(uri, root);
      const holds = ids((await front()).objects);
      say({
        check: `reload: ${uri.path.split("/").pop()}`,
        pass: Boolean(dirty) && holds.has(root) && !holds.has(removed),
        detail: `tab ${dirty ? "unsaved" : "clean"}, ${holds.has(removed) ? `${removed} back` : `${removed} still removed`}`,
      });
    }
    writeState({ ...state, phase: "done" });
    await vscode.commands.executeCommand("workbench.action.quit");
  },

  /** An unsaved edit, then VS Code killed a few seconds later. */
  async "crash-1"(state) {
    const file = vscode.Uri.file(state.files.crash);
    await open(file, "halbach");
    await remove(R2);
    await until(() => tabOf(file)?.isDirty, "the tab unsaved");
    await pause(4000); // the studio's copy settles a second after the edit
    say({ step: "asking to be killed" });
    fs.writeFileSync(path.join(dir, "crash-now"), "");
    await pause(60000);
  },

  /** The edit back: by VS Code's own backup, or offered by the studio. */
  async "crash-2"(state, offers) {
    const file = vscode.Uri.file(state.files.crash);
    await until(() => tabOf(file), "the scene's tab back", 20000).catch(
      () => undefined,
    );
    await open(file, "halbach");
    let holds = ids((await front()).objects);
    try {
      await until(
        async () => {
          holds = ids((await front()).objects);
          return !holds.has("r2");
        },
        "the edit back",
        15000,
      );
    } catch {
      // said below
    }
    say({
      check: "crash: an unsaved edit after VS Code was killed",
      pass: !holds.has("r2"),
      detail: offers.length
        ? `the studio offered it back ("${offers[0].slice(0, 80)}…"), ${holds.has("r2") ? "but Restore did not put it back" : "and Restore put it back"}`
        : holds.has("r2")
          ? "lost: neither VS Code nor the studio brought it back"
          : "VS Code's own backup brought it back",
    });
    await vscode.commands.executeCommand("workbench.action.quit");
  },

  /** One scene, then eight: the launcher reads the memory at each mark. */
  async memory(state) {
    const [first, ...rest] = state.files.memory;
    await open(vscode.Uri.file(first.path), first.root);
    await pause(6000);
    say({ mark: "one" });
    await pause(3000);
    for (const { path: file, root } of rest) {
      await open(vscode.Uri.file(file), root);
      await pause(1500); // its view drawn while it is in front
    }
    await pause(6000);
    say({ mark: "eight", tabs: sceneTabs().length });
    await pause(3000);
    await vscode.commands.executeCommand("workbench.action.quit");
  },
};

exports.activate = async function activate() {
  if (!dir) {
    return;
  }
  const state = readState();
  const phase = phases[state.phase];
  if (!phase) {
    return;
  }
  const studio = vscode.extensions.getExtension(STUDIO);
  // the studio's own API object, so its prompts can be answered
  const studioApi = createRequire(
    path.join(studio.extensionPath, "out", "extension.js"),
  )("vscode");
  const offers = [];
  const warn = studioApi.window.showWarningMessage.bind(studioApi.window);
  studioApi.window.showWarningMessage = (message, ...rest) => {
    if (/had unsaved changes when VS Code last closed/.test(String(message))) {
      offers.push(String(message));
      say({ step: "offered", message: String(message) });
      return Promise.resolve(/Restore them/.test(message) ? "Restore" : "Open");
    }
    return warn(message, ...rest);
  };
  try {
    await studio.activate();
    say({ step: `phase ${state.phase}` });
    await phase(state, offers);
  } catch (error) {
    say({
      check: `phase ${state.phase}`,
      pass: false,
      detail: String(error?.message || error),
    });
    await vscode.commands.executeCommand("workbench.action.quit");
  }
};
