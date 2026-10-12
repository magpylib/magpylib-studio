import * as assert from 'assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as vscode from 'vscode';

import {
  engineMismatch,
  evenRamp,
  incrementRamp,
  meaning,
  findRecoveryForTest,
  openScenesForTest,
  openScenesShownForTest,
  sceneFileState,
  sceneTreeForTest,
  showScenesForTest,
  splitTerms,
  stopEngineForTest,
} from '../extension';
import { bringToFront, frontScene, openScenes, SceneDocument } from '../scenes';
import {
  isObject,
  SceneNode,
  SceneObject,
  SceneOperation,
  SceneRoot,
  SceneTreeProvider,
} from '../sceneTree';

/** A tree of one scene, read from `objects` and `operations`, and its top
 *  rows. */
async function oneSceneTree(
  objects: SceneObject[],
  operations: SceneOperation[],
): Promise<{ tree: SceneTreeProvider; roots: SceneNode[] }> {
  const doc = new SceneDocument(vscode.Uri.file('/test.magpy.json'), () => {});
  const root: SceneRoot = { kind: 'scene', uri: doc.uri, doc };
  const tree = new SceneTreeProvider(
    vscode.Uri.file('/'),
    () => [root],
    () => true,
    async () => objects,
    async () => {},
    async () => operations,
    () => {},
    async () => {},
  );
  // one scene shown: its rows are the tree's top
  return { tree, roots: await tree.getChildren() };
}

/** A row's id, for a row that has one. */
const idOf = (node: SceneNode) => (node as SceneObject).id;

/**
 * End-to-end through the real vscode API: activation, the engine subprocess,
 * the RPC round trip, the virtual document and the script tab.
 *
 * These are the seams the Python suite cannot reach and the DOM harness only
 * approximates. What they deliberately do not cover is webview *content* — a
 * test cannot read into a webview, so the panels stay with the harness.
 */

const SCENE_JSON = vscode.Uri.parse('magpylib-studio:/scene.json');
const EXTENSION_ID = 'magpylib.magpylib-studio-vscode';

/** Commands that replace the scene ask about unsaved changes, which in a test
 *  host is a modal nothing will ever click. Saying so up front is what any
 *  non-interactive caller does. */
const DISCARD = { discardChanges: true };

/** to_dict, read the way any editor tab would read it. */
async function scene(): Promise<{
  version: number;
  generator: string;
  events: { op: string; target: string }[];
  objects: { id: string }[];
}> {
  const doc = await vscode.workspace.openTextDocument(SCENE_JSON);
  return JSON.parse(doc.getText());
}

/**
 * Read `scene.json` once it says what the test is waiting for.
 *
 * It is a virtual document, so VS Code serves it from cache until the
 * extension fires onDidChange — which it does on a 150 ms throttle, after the
 * command has already resolved. Waiting a fixed slice of time for that is
 * what this used to do, and it passed on a laptop and failed on CI, which is
 * the usual bargain. Polling for the state instead is both faster and not a
 * bet on how quick the machine is.
 */
async function sceneWhere(
  predicate: (doc: Awaited<ReturnType<typeof scene>>) => boolean,
  what: string,
  timeoutMs = 20000,
): Promise<Awaited<ReturnType<typeof scene>>> {
  const deadline = Date.now() + timeoutMs;
  let last = await scene();
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${what}; ` +
          `scene has ${last.objects.length} top-level objects`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = await scene();
  }
  return last;
}

/** Every id in the tree, nesting included. */
function ids(specs: { id: string; children?: unknown[] }[]): Set<string> {
  const found = new Set<string>();
  const walk = (list: { id: string; children?: unknown[] }[]) => {
    for (const spec of list) {
      found.add(spec.id);
      walk((spec.children ?? []) as { id: string; children?: unknown[] }[]);
    }
  };
  walk(specs);
  return found;
}

// A predicate has to tell the state it is waiting for apart from the one
// already there, or it returns instantly with the *previous* test's scene —
// which is not a hypothetical: "any object at all" did exactly that, and the
// test that captured a scene to compare against captured the wrong one.
const holding = (id: string) => (doc: { objects: { id: string }[] }) =>
  ids(doc.objects as { id: string }[]).has(id);
const without = (id: string) => (doc: { objects: { id: string }[] }) =>
  !ids(doc.objects as { id: string }[]).has(id);
const nothing = (doc: { objects: unknown[] }) => doc.objects.length === 0;

/** Same, for a file the extension writes on its own schedule. */
async function fileWhere(
  uri: vscode.Uri,
  predicate: (doc: Record<string, unknown>) => boolean,
  what: string,
  timeoutMs = 20000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const doc = await readJson(uri);
      if (predicate(doc)) {
        return doc;
      }
    } catch {
      // not written yet, or written half-way: try again
    }
    if (Date.now() > deadline) {
      let seen = '(unreadable)';
      try {
        seen = JSON.stringify(await readJson(uri)).slice(0, 400);
      } catch {
        // leave it as unreadable
      }
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; file holds ${seen}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A real wait, for the cases that assert something does NOT happen — there
 *  is no event to poll for, so the only honest option is to give it time. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load an example from a known-empty scene.
 *
 * Waiting for "the scene contains halbach" is not enough on its own: the
 * previous test leaves one loaded, so the predicate is already true and the
 * wait returns the *old* scene. That is not theoretical — it let a test write
 * a stale scene to its file and then delete an object the file did not
 * contain, which surfaced as an "unknown object id" popup and, worse, made
 * the assertion that the removal landed pass because the object had never
 * been there. Clearing first makes empty -> loaded a transition that can only
 * mean this call.
 */
async function loadExample(name: string, rootId: string) {
  await vscode.commands.executeCommand('magpylib-studio.newScene', DISCARD);
  await sceneWhere(nothing, 'the scene to clear');
  await vscode.commands.executeCommand('magpylib-studio.loadExample', name, DISCARD);
  return sceneWhere(holding(rootId), `the ${name} example to load`);
}

/** A scratch file that goes away with the test run. */
function tempScene(name: string): vscode.Uri {
  return vscode.Uri.file(join(mkdtempSync(join(tmpdir(), 'magpy-')), name));
}

async function readJson(uri: vscode.Uri): Promise<Record<string, unknown>> {
  return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
}

async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(value), 'utf8'));
}

/** Every error the extension raised at the user during the run. A test host
 *  flashes these past too fast to read, so they are recorded and checked. */
/**
 * Stand in for the prompts a command puts up, so a modal flow can run
 * unattended. The suite already does this for the message boxes; an import is
 * three more of them and cannot be driven any other way.
 */
function answering({
  open,
  save,
  pick,
  input,
}: {
  open?: vscode.Uri[];
  save?: vscode.Uri;
  pick?: (items: readonly vscode.QuickPickItem[]) => unknown;
  input?: string[];
}): { restore: () => void } {
  const window = vscode.window as unknown as Record<string, unknown>;
  const real = {
    showOpenDialog: window.showOpenDialog,
    showSaveDialog: window.showSaveDialog,
    showQuickPick: window.showQuickPick,
    showInputBox: window.showInputBox,
  };
  const boxes = [...(input ?? [])];
  window.showOpenDialog = async () => open;
  window.showSaveDialog = async () => save;
  window.showQuickPick = async (items: readonly vscode.QuickPickItem[]) =>
    pick ? pick(await items) : (await items)[0];
  window.showInputBox = async () => boxes.shift();
  return {
    restore: () => Object.assign(window, real),
  };
}

/** What a refused save of the script tab starts with. */
const NOT_APPLIED = /^Magpylib Studio: the script was not applied, and the scene is as it was/;
/** What a save asks when the scene moved on after the tab was written. */
const STALE = /^Magpylib Studio: the scene changed after the script tab was written/;
const APPLY_ANYWAY = 'Apply Anyway';

/**
 * Answer the messages of one kind a test expects, and hear what they said. A
 * message with no answer here goes on to the suite's spy, so one nobody
 * expected still fails the run.
 */
function answeringMessages(
  kind: 'showErrorMessage' | 'showWarningMessage',
  ...answers: [RegExp, string | undefined][]
): {
  said: string[];
  restore: () => void;
} {
  const window = vscode.window as unknown as Record<string, unknown>;
  const spied = window[kind] as (...a: unknown[]) => unknown;
  const said: string[] = [];
  window[kind] = async (message: string, ...rest: unknown[]) => {
    const found = answers.find(([pattern]) => pattern.test(message));
    if (!found) {
      return spied(message, ...rest);
    }
    said.push(message);
    return found[1];
  };
  return {
    said,
    restore: () => {
      window[kind] = spied;
    },
  };
}

/** Wait for something with no event of its own to wait on, such as a message
 *  having been said. */
async function until(predicate: () => boolean, what: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await pause(50);
  }
}

/** Close the script tab, which lets go of any text it holds: the next test
 *  to open it starts from the scene. */
async function closeScriptTab(tab: vscode.TextDocument) {
  await vscode.window.showTextDocument(tab);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

/** Poll an open document's text, the way sceneWhere polls the scene. */
async function textWhere(
  doc: vscode.TextDocument,
  predicate: (text: string) => boolean,
  what: string,
  timeoutMs = 20000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(doc.getText())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return doc.getText();
}

/**
 * Open the script tab, once it shows what the extension last wrote. The file
 * is written on the extension's schedule and the tab reloads from it on VS
 * Code's, so a tab left open by an earlier test can lag its file — and an edit
 * made then is an edit to a stale tab, which the reload it was racing turns
 * into a save conflict.
 */
async function openScriptTab(): Promise<vscode.TextDocument> {
  await vscode.commands.executeCommand('magpylib-studio.viewScript');
  const tab = vscode.window.activeTextEditor?.document;
  assert.ok(tab, "the scene's script tab did not open");
  assert.ok(tab.fileName.endsWith('.py'), `opened ${tab.fileName}, not a script`);
  const onDisk = async () =>
    Buffer.from(await vscode.workspace.fs.readFile(tab.uri)).toString('utf8');
  const deadline = Date.now() + 20000;
  while (tab.getText() !== (await onDisk())) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the script tab to show its file');
    }
    await pause(50);
  }
  return tab;
}

/** Edit the script tab the way a user would, and save it. */
async function editAndSave(tab: vscode.TextDocument, edit: (text: string) => string) {
  const edited = edit(tab.getText());
  assert.notStrictEqual(edited, tab.getText(), 'the edit changed nothing');
  const editor = await vscode.window.showTextDocument(tab);
  await editor.edit((builder) => {
    builder.replace(new vscode.Range(0, 0, tab.lineCount, 0), edited);
  });
  await tab.save();
}

/** A closed cube as a binary STL, in the file's own units — the shape of what
 *  a CAD tool hands over, header word and all. */
function binaryCubeStl(size: number): Buffer {
  const corners = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ].map((c) => c.map((v) => v * size));
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const triangles: number[][][] = [];
  for (const [a, b, c, d] of quads) {
    triangles.push([corners[a], corners[b], corners[c]]);
    triangles.push([corners[a], corners[c], corners[d]]);
  }
  const out = Buffer.alloc(84 + 50 * triangles.length);
  out.write('solid written by a test', 0);
  out.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, i) => {
    let at = 84 + 50 * i + 12; // past the normal, which magpylib recomputes
    for (const vertex of triangle) {
      for (const component of vertex) {
        out.writeFloatLE(component, at);
        at += 4;
      }
    }
  });
  return out;
}

const errorsShown: string[] = [];

suite('magpylib-studio', () => {
  suiteSetup(async function () {
    this.timeout(120000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} is not installed`);
    await extension.activate();

    for (const kind of ['showErrorMessage', 'showWarningMessage'] as const) {
      const real = vscode.window[kind];
      (vscode.window as unknown as Record<string, unknown>)[kind] = (
        message: string,
        ...rest: unknown[]
      ) => {
        errorsShown.push(`${kind === 'showErrorMessage' ? 'error' : 'warning'}: ${message}`);
        return (real as (...a: unknown[]) => unknown)(message, ...rest);
      };
    }
  });

  test('every declared command is registered', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
    const declared: string[] = extension.packageJSON.contributes.commands.map(
      (c: { command: string }) => c.command,
    );
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = declared.filter((c) => !registered.has(c));
    assert.deepStrictEqual(missing, [], 'declared but never registered');
  });

  test('Open Scenes shows itself once a second scene opens', async function () {
    this.timeout(60000);
    // First among the scene tests, so it starts with none open. One scene is
    // Objects alone, as one repository is Source Control's Changes alone;
    // a second brings the list, in the studio's side bar once it is shown.
    await vscode.commands.executeCommand('magpylib-studio.sceneView.focus');
    await vscode.commands.executeCommand('magpylib-studio.newScene', DISCARD);
    await sceneWhere(nothing, 'one scene open');
    await pause(500); // asserting that nothing happens
    assert.strictEqual(openScenesShownForTest(), false, 'Open Scenes showed for one scene');
    await vscode.commands.executeCommand('magpylib-studio.newScene', DISCARD);
    await until(() => openScenesShownForTest(), 'Open Scenes to show for two scenes');
  });

  test('the engine builds a scene and the virtual document shows it', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    const doc = await scene();
    // one magnet and one pattern step per ring, not twenty declared magnets
    assert.ok(doc.events.length > 0, 'the log is empty');
    assert.ok(
      doc.events.some((e) => e.op === 'duplicate_around'),
      'the halbach example should carry a circular pattern',
    );
    assert.ok(doc.objects.length > 0, 'nothing was built');
  });

  test('removing a patterned magnet takes its copies with it', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');

    // the tree hands the command an object; a test can hand it the same thing
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'r1',
      type: 'magnet.Cuboid',
      label: 'Magnet 1',
      parent: 'ring1',
      visible: true,
    });
    const after = await sceneWhere(without('r1'), 'the removal to land');

    const present = ids(after.objects as { id: string }[]);
    assert.ok(!present.has('r1'), 'the magnet is still in the document');
    assert.ok(present.has('r2'), 'the other ring should be untouched');
  });

  test('the script tab is the scene as a function, and saving it applies it', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    const tab = await openScriptTab();
    const rendered = tab.getText();
    assert.match(rendered, /^# The scene as a function\. Save to apply it/);
    assert.match(rendered, /regenerated from the\n# scene after a save/);
    assert.match(rendered, /^from magpylib_studio import .*\bscene$/m);
    assert.match(rendered, /^ {4}duplicate_around\(r1, n,/m, 'the pattern should be one call');

    // Edit radius and save: the document follows, as the edit and nothing
    // else. r1 still sits at `=radius` and the ring is still a pattern -- the
    // scene edited, not a new one run from the text.
    await editAndSave(
      tab,
      (text) =>
        text.replace('slider=(0.016, 0.04))] = 0.023,', 'slider=(0.016, 0.04))] = 0.0325,') +
        '# a note the tab will not keep\n',
    );
    type Step = { op: string; target: string; params?: { position?: unknown[] } };
    const radius = (d: unknown) => (d as { variables: Record<string, unknown> }).variables.radius;
    const after = await sceneWhere((d) => radius(d) === 0.0325, 'the saved radius to reach the scene');
    const steps = after.events as Step[];
    const r1 = steps.find((e) => e.op === 'create' && e.target === 'r1');
    assert.strictEqual(r1?.params?.position?.[0], '=radius', 'r1 lost its variable');
    assert.ok(
      steps.some((e) => e.op === 'duplicate_around' && e.target === 'r1'),
      'the ring is no longer a pattern',
    );
    // Regenerated from the scene: the note is gone, the number is not.
    await textWhere(
      tab,
      (text) => !text.includes('a note the tab') && text.includes('= 0.0325,'),
      'the tab to be regenerated from the scene',
    );

    // One step to undo.
    await vscode.commands.executeCommand('magpylib-studio.undo');
    await sceneWhere((d) => radius(d) === 0.023, 'undo to put the radius back');
  });

  test('a script that fails leaves the scene alone, and the tab keeps it', async function () {
    this.timeout(60000);
    const before = await loadExample('halbach', 'halbach');
    const tab = await openScriptTab();

    const refused = answeringMessages('showErrorMessage', [NOT_APPLIED, undefined]);
    try {
      await editAndSave(tab, (text) => text.replace('magpy.Collection(', 'magpy.Group('));
      await until(() => refused.said.length > 0, 'the save to be refused');
    } finally {
      refused.restore();
    }
    assert.match(refused.said[0], /line \d+: AttributeError: .*Group/);
    assert.deepStrictEqual(await scene(), before, 'a refused save changed the scene');

    // Held until it runs: an edit elsewhere does not write over it.
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'sensor',
      type: 'Sensor',
      label: 'Sensor',
      parent: null,
      visible: true,
    });
    await sceneWhere(without('sensor'), 'the removal to land');
    await pause(500); // a re-render would land after the scene, not before it
    assert.ok(tab.getText().includes('magpy.Group('), 'the tab lost the text it was holding');

    // Fixed and saved, it would run -- and put the sensor back, since the tab
    // was written before the removal. So the save asks, and a no keeps both
    // the scene and the text.
    const asked = answeringMessages('showWarningMessage', [STALE, undefined]);
    try {
      await editAndSave(tab, (text) => text.replace('magpy.Group(', 'magpy.Collection('));
      await until(() => asked.said.length > 0, 'the save to ask');
    } finally {
      asked.restore();
    }
    await pause(500); // an apply would land after the answer, not before it
    assert.ok(!ids((await scene()).objects).has('sensor'), 'a declined save applied');
    assert.ok(tab.getText().includes('magpy.Collection('), 'the tab lost the fixed text');

    // Asked again and told yes, it runs: the scene is what the tab says.
    const told = answeringMessages('showWarningMessage', [STALE, APPLY_ANYWAY]);
    try {
      await editAndSave(tab, (text) => text + '# applied knowingly\n');
      await sceneWhere(holding('sensor'), 'the fixed script to apply');
    } finally {
      told.restore();
    }
    assert.strictEqual(told.said.length, 1, 'the save should ask before undoing the removal');
  });

  test('each scene has a script tab of its own', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    const halbach = await openScriptTab();
    const refused = answeringMessages('showErrorMessage', [NOT_APPLIED, undefined]);
    try {
      await editAndSave(halbach, (text) => text.replace('magpy.Collection(', 'magpy.Group('));
      await until(() => refused.said.length > 0, 'the save to be refused');
    } finally {
      refused.restore();
    }

    // Another scene opened has its own tab; the halbach's keeps the text it
    // holds, written against the halbach and saved to apply there.
    await vscode.commands.executeCommand('magpylib-studio.loadExample', 'coil', DISCARD);
    await sceneWhere(holding('coil'), 'the coil example to load');
    const coil = await openScriptTab();
    assert.notStrictEqual(coil.uri.toString(), halbach.uri.toString(), 'the two scenes share a tab');
    await textWhere(coil, (text) => text.includes('coil = magpy.Collection('), "the coil's own script");
    await pause(300);
    assert.ok(halbach.getText().includes('magpy.Group('), "the halbach's tab lost its text");
    await closeScriptTab(coil);
    await closeScriptTab(halbach);
  });

  test('plain magpylib in the script tab is refused, not flattened', async function () {
    this.timeout(60000);
    const before = await loadExample('halbach', 'halbach');
    const tab = await openScriptTab();

    const refused = answeringMessages('showErrorMessage', [NOT_APPLIED, undefined]);
    try {
      await editAndSave(
        tab,
        () =>
          'import magpylib as magpy\n\n' +
          'cube = magpy.magnet.Cuboid(dimension=(0.01, 0.01, 0.01), polarization=(0, 0, 1))\n' +
          'magpy.show(cube)\n',
      );
      await until(() => refused.said.length > 0, 'the save to be refused');
    } finally {
      refused.restore();
    }
    assert.match(refused.said[0], /plain magpylib.*Open in Magpylib Studio/);
    assert.deepStrictEqual(await scene(), before, 'plain magpylib replaced the scene');
    await closeScriptTab(tab);
  });

  test('a scene exports as the scene function that builds it', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    const target = tempScene('halbach_build.py');
    const prompts = answering({ save: target });
    const window = vscode.window as unknown as Record<string, unknown>;
    const inform = window.showInformationMessage;
    window.showInformationMessage = async () => undefined; // "exported …, Open?"
    try {
      await vscode.commands.executeCommand('magpylib-studio.exportBuilderScript');
    } finally {
      prompts.restore();
      window.showInformationMessage = inform;
    }
    const text = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
    assert.match(text, /^from magpylib_studio import .*\bscene$/m);
    assert.match(text, /^ {4}duplicate_around\(r1, n,/m);
    // Code someone keeps: nothing regenerates it, so it does not say so.
    assert.doesNotMatch(text, /regenerated/);
  });

  test("a length is shown and typed in the scene's length unit", async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    type Doc = {
      model_unit?: string;
      variables: Record<string, unknown>;
      variable_bounds: Record<string, { unit?: string }>;
    };
    const doc = (d: unknown) => d as Doc;
    // as the Variables panel hands a row's variable to its commands
    const gap = {
      name: 'gap',
      expression: 0.015,
      value: 0.015,
      bounds: { min: 0, max: 0.06, soft_min: 0.01, soft_max: 0.03, unit: 'length' },
      shown: { symbol: 'm', scale: 1 },
    };

    // SI unless said otherwise: 20 mm is typed as such, and stored in metres.
    let prompts = answering({ input: ['20 mm'] });
    try {
      await vscode.commands.executeCommand('magpylib-studio.editVariable', gap);
    } finally {
      prompts.restore();
    }
    await sceneWhere((d) => doc(d).variables.gap === 0.02, 'gap typed as 20 mm to be 0.02 m');

    // Drawn in centimetres: the document's numbers stay metres.
    prompts = answering({ pick: (items) => items.find((i) => i.label === 'cm') });
    try {
      await vscode.commands.executeCommand('magpylib-studio.setLengthUnit');
    } finally {
      prompts.restore();
    }
    const drawn = await sceneWhere((d) => doc(d).model_unit === 'cm', 'the scene drawn in cm');
    assert.strictEqual(doc(drawn).variables.gap, 0.02);

    // What a variable measures, said in its properties.
    prompts = answering({
      pick: (items) =>
        items.find((i) => i.label === 'Unit') ?? items.find((i) => i.label === 'Dimensionless'),
    });
    try {
      await vscode.commands.executeCommand('magpylib-studio.setVariableBounds', {
        name: 'n',
        expression: 10,
        value: 10,
        bounds: { min: 2, max: 60, soft_min: 4, soft_max: 20, integer: true },
      });
    } finally {
      prompts.restore();
    }
    const said = await sceneWhere(
      (d) => doc(d).variable_bounds.n?.unit === 'dimensionless',
      'n to say it is dimensionless',
    );
    assert.deepStrictEqual(
      doc(said).variable_bounds.n,
      { min: 2, max: 60, soft_min: 4, soft_max: 20, integer: true, unit: 'dimensionless' },
      'saying what it measures changed its limits',
    );
  });

  test('New Variable asks what it holds, and reads its value in that unit', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    type Doc = {
      variables: Record<string, unknown>;
      variable_bounds: Record<string, Record<string, unknown>>;
    };
    const create = async (label: string, input: string[]) => {
      const prompts = answering({ input, pick: (items) => items.find((i) => i.label === label) });
      try {
        await vscode.commands.executeCommand('magpylib-studio.addVariable');
      } finally {
        prompts.restore();
      }
    };

    // A length, its value and its range typed with units.
    await create('Length', ['spacing', '15 mm', '10 mm, 30 mm']);
    const length = (await sceneWhere(
      (d) => (d as unknown as Doc).variable_bounds.spacing?.max !== undefined,
      'spacing to be created with its range',
    )) as unknown as Doc;
    assert.strictEqual(length.variables.spacing, 0.015);
    assert.deepStrictEqual(length.variable_bounds.spacing, {
      min: 0.01,
      max: 0.03,
      unit: 'length',
    });

    // A plain number, no range: as it always was.
    await create('Number', ['ratio', '2.5', '']);
    const plain = (await sceneWhere(
      (d) => (d as unknown as Doc).variables.ratio !== undefined,
      'ratio to be created',
    )) as unknown as Doc;
    assert.strictEqual(plain.variables.ratio, 2.5);
    assert.strictEqual(plain.variable_bounds.ratio, undefined);

    // A name that exists is refused: it would be overwritten, and its value
    // read in what the old one measured.
    const window = vscode.window as unknown as Record<string, unknown>;
    const real = window.showInputBox;
    let asked: vscode.InputBoxOptions | undefined;
    window.showInputBox = async (options: vscode.InputBoxOptions) => {
      asked = options;
      return undefined;
    };
    try {
      await vscode.commands.executeCommand('magpylib-studio.addVariable');
    } finally {
      window.showInputBox = real;
    }
    assert.match(String(await asked?.validateInput?.('gap')), /gap exists already/);
    assert.strictEqual(await asked?.validateInput?.('gap3'), undefined);
  });

  test('what a typed value means is said in the unit the scene holds it in', () => {
    assert.strictEqual(meaning(1, 'field').message, '= 1 T');
    assert.strictEqual(meaning(0.015, 'length').message, '= 0.015 m');
    assert.strictEqual(meaning(90, 'angle').message, '= 90°');
    assert.strictEqual(meaning(3000, 'current').message, '= 3000 A');
    assert.strictEqual(meaning(2, 'dimensionless').message, '= 2');
  });

  test('a variable typed into a length takes that unit from the start', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    // Position "0, 0, lift2", then lift2's value -- asked for as a length,
    // since a position is one, and typed in mm -- then no range.
    const prompts = answering({ input: ['0, 0, lift2', '12 mm', ''] });
    try {
      await vscode.commands.executeCommand('magpylib-studio.setPosition', {
        id: 'sensor',
        type: 'Sensor',
        label: 'Sensor',
        parent: null,
        visible: true,
      });
    } finally {
      prompts.restore();
    }
    type Doc = {
      variables: Record<string, unknown>;
      variable_bounds: Record<string, { unit?: string }>;
    };
    const after = (await sceneWhere(
      (d) => (d as unknown as Doc).variables.lift2 !== undefined,
      'lift2 to be created',
    )) as unknown as Doc;
    assert.strictEqual(after.variables.lift2, 0.012, '12 mm typed for a length is 0.012 m');
    assert.strictEqual(after.variable_bounds.lift2?.unit, 'length');
  });

  test('a box splits at commas, so a term may hold a unit or a formula', () => {
    assert.deepStrictEqual(splitTerms('0, 0, 5 mm'), ['0', '0', '5 mm']);
    assert.deepStrictEqual(splitTerms('0, 0, max(a, b)'), ['0', '0', 'max(a, b)']);
    assert.deepStrictEqual(splitTerms('0, 0, gap * 2'), ['0', '0', 'gap * 2']);
    // the sampled-curve editor's own example, which spaces used to split
    assert.deepStrictEqual(splitTerms('radius * cos(tau * turns * t)'), [
      'radius * cos(tau * turns * t)',
    ]);
    assert.deepStrictEqual(splitTerms('[1 2 3]'), ['1', '2', '3']); // as it always was
    assert.strictEqual(splitTerms('0, (1'), undefined);
  });

  test('the boxes show and read lengths in the scene\'s length unit', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    type Doc = {
      model_unit?: string;
      events: { target: string; op?: string; value?: unknown }[];
    };
    // Units... -> Length -> mm
    const units = answering({
      pick: (items) => items.find((i) => i.label === 'Length' || i.label === 'mm'),
    });
    try {
      await vscode.commands.executeCommand('magpylib-studio.setUnits');
    } finally {
      units.restore();
    }
    await sceneWhere((d) => (d as unknown as Doc).model_unit === 'mm', 'the scene in mm');

    // Set Position...: asked in mm, prefilled in mm; a bare number is mm, one
    // with a unit is in its own, and an expression is as written
    const window = vscode.window as unknown as Record<string, unknown>;
    const real = window.showInputBox;
    const asked: vscode.InputBoxOptions[] = [];
    window.showInputBox = async (options: vscode.InputBoxOptions) => {
      asked.push(options);
      return '10, 2 cm, radius';
    };
    try {
      await vscode.commands.executeCommand('magpylib-studio.setPosition', {
        id: 'sensor',
        type: 'Sensor',
        label: 'Sensor',
        parent: null,
        visible: true,
      });
    } finally {
      window.showInputBox = real;
    }
    assert.match(String(asked[0]?.prompt), /as x, y, z \(mm\)$/);
    assert.match(String(await asked[0]?.validateInput?.('0, 0, 5 kg')), /'kg' is not a unit of length/);
    const placed = (await sceneWhere(
      (d) =>
        (d as unknown as Doc).events.some((e) => e.target === 'sensor' && e.op === 'position'),
      'the sensor to be placed',
    )) as unknown as Doc;
    const position = placed.events.find((e) => e.target === 'sensor' && e.op === 'position');
    assert.deepStrictEqual(position?.value, [0.01, 0.02, '=radius']);
  });

  test('a field is shown and typed in the scene\'s field unit', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    type Doc = {
      field_unit?: string;
      variables: Record<string, unknown>;
      variable_bounds: Record<string, Record<string, unknown>>;
    };
    const units = answering({
      pick: (items) => items.find((i) => i.label === 'Field' || i.label === 'mT'),
    });
    try {
      await vscode.commands.executeCommand('magpylib-studio.setUnits');
    } finally {
      units.restore();
    }
    await sceneWhere((d) => (d as unknown as Doc).field_unit === 'mT', 'the scene in mT');

    // New Variable -> Field: a bare 800 is 800 mT, and no range
    const prompts = answering({
      input: ['bfield', '800', ''],
      pick: (items) => items.find((i) => i.label === 'Field'),
    });
    try {
      await vscode.commands.executeCommand('magpylib-studio.addVariable');
    } finally {
      prompts.restore();
    }
    const made = (await sceneWhere(
      (d) => (d as unknown as Doc).variables.bfield !== undefined,
      'bfield to be created',
    )) as unknown as Doc;
    assert.strictEqual(made.variables.bfield, 0.8);
    assert.deepStrictEqual(made.variable_bounds.bfield, { unit: 'field' });

    // its value and what it measures are one step: one undo takes both
    await vscode.commands.executeCommand('magpylib-studio.undo');
    const undone = (await sceneWhere(
      (d) => (d as unknown as Doc).variables.bfield === undefined,
      'bfield to be undone',
    )) as unknown as Doc;
    assert.strictEqual(undone.variable_bounds.bfield, undefined);
  });

  test('a scene saved to a file opens again as the same scene', async function () {
    this.timeout(60000);
    const before = await loadExample('halbach', 'halbach');

    // The save dialog cannot be driven from a test, so the file is written the
    // way Save writes it and opened through the real command — which is the
    // half that has somewhere to go wrong (reading, parsing, the engine).
    const file = tempScene(`round-trip.magpy.json`);
    await writeJson(file, before);

    await vscode.commands.executeCommand('magpylib-studio.newScene', DISCARD);
    await sceneWhere(nothing, 'the scene to clear');

    await vscode.commands.executeCommand('magpylib-studio.loadScene', file, DISCARD);
    const after = await sceneWhere(holding('halbach'), 'the file to open');
    assert.deepStrictEqual(after.events, before.events, 'the log came back different');
    assert.deepStrictEqual(after.objects, before.objects);
  });

  test('saving a scene that has a file writes to it without asking', async function () {
    this.timeout(60000);
    const fresh = await loadExample('halbach', 'halbach');
    const file = tempScene('save.magpy.json');
    await writeJson(file, fresh);
    await vscode.commands.executeCommand('magpylib-studio.newScene', DISCARD);
    await sceneWhere(nothing, 'the scene to clear');
    await vscode.commands.executeCommand('magpylib-studio.loadScene', file, DISCARD);
    await sceneWhere(holding('r2'), 'the file to open');

    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'r2',
      type: 'magnet.Cuboid',
      label: 'Magnet 2',
      parent: 'ring2',
      visible: true,
    });
    await sceneWhere(without('r2'), 'the removal to land');

    // No showSaveDialog here: the scene knows its file. If that ever regresses
    // this test hangs on a modal rather than failing, which is its own signal.
    await vscode.commands.executeCommand('magpylib-studio.saveScene');
    assert.deepStrictEqual(
      await readJson(file),
      await scene(),
      'the file on disk is not what the engine holds',
    );
  });

  test('a saved file says what format and what wrote it', async function () {
    this.timeout(60000);
    const file = tempScene('stamp.magpy.json');
    await writeJson(file, await loadExample('halbach', 'halbach'));
    await vscode.commands.executeCommand('magpylib-studio.loadScene', file, DISCARD);
    await vscode.commands.executeCommand('magpylib-studio.saveScene');

    const saved = await readJson(file);
    assert.strictEqual(typeof saved.version, 'number');
    assert.match(String(saved.generator), /^magpylib-studio /);
    // it reads first, so `head -2` on the file identifies it
    assert.deepStrictEqual(Object.keys(saved).slice(0, 2), ['version', 'generator']);
  });

  test('the scene knows its file, and says so when it drifts from it', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    // An example opens in an untitled tab of its own, with nothing unsaved:
    // no file, so Save asks where.
    assert.strictEqual(sceneFileState().file, undefined);
    assert.strictEqual(sceneFileState().dirty, false, 'an untouched example is marked unsaved');

    const file = tempScene('state.magpy.json');
    await writeJson(file, await scene());
    await vscode.commands.executeCommand('magpylib-studio.newScene', DISCARD);
    await sceneWhere(nothing, 'the scene to clear');
    await vscode.commands.executeCommand('magpylib-studio.loadScene', file, DISCARD);
    await sceneWhere(holding('r2'), 'the file to open');
    assert.strictEqual(sceneFileState().file, file.toString(), 'the file was not adopted');
    assert.strictEqual(sceneFileState().dirty, false, 'a freshly opened scene is not dirty');

    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'r2',
      type: 'magnet.Cuboid',
      label: 'Magnet 2',
      parent: 'ring2',
      visible: true,
    });
    await sceneWhere(without('r2'), 'the removal to land');
    assert.strictEqual(sceneFileState().dirty, true, 'an edit went unnoticed');

    await vscode.commands.executeCommand('magpylib-studio.saveScene');
    assert.strictEqual(sceneFileState().dirty, false, 'saving did not settle it');

    // Redrawing is not editing. Every surface refresh goes through the same
    // path as a real change, so it is one line's difference between "the
    // view is stale" and "your file is out of date" — and the second one
    // nags, and blocks opening anything else.
    await vscode.commands.executeCommand('magpylib-studio.refreshScene');
    await pause(500); // asserting that nothing happens; there is no event to await
    assert.strictEqual(sceneFileState().dirty, false, 'a refresh claimed an edit');
  });

  test('an example opens clean, in a preview tab the next one takes', async function () {
    this.timeout(60000);
    const tabOf = (uri: vscode.Uri) =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString());
    await loadExample('coil', 'coil');
    const coil = frontScene()!.uri;
    assert.ok(coil.path.endsWith('.magpy.json') && coil.path.includes('coil'), `the example's tab is named ${coil.path}`);
    assert.ok(tabOf(coil)?.isPreview, 'the example is not in a preview tab');
    // The next example takes its place, and asks nothing: it was untouched.
    await vscode.commands.executeCommand('magpylib-studio.loadExample', 'halbach', DISCARD);
    await sceneWhere(holding('halbach'), 'the next example to load');
    const halbach = frontScene()!.uri;
    await until(() => !tabOf(coil), 'the untouched example to make way');
    assert.ok(tabOf(halbach)?.isPreview, 'the next example is not in a preview tab');

    // An example is where a scene begins: nothing to undo, nothing unsaved.
    await vscode.commands.executeCommand('magpylib-studio.undo');
    await pause(300); // asserting that nothing happens
    assert.strictEqual(sceneFileState().dirty, false, 'undo found a step before the example');
    await sceneWhere(holding('halbach'), 'the example still there');

    // Untouched, it has no document of its own: a restarted engine is given
    // the example again.
    const told = answeringMessages('showWarningMessage', [/engine stopped and was started again/, undefined]);
    try {
      stopEngineForTest();
      await vscode.commands.executeCommand('magpylib-studio.refreshScene');
      await until(() => told.said.length > 0, 'the restart to be told');
      await frontScene()!.opening;
      const tree = sceneTreeForTest();
      assert.ok((await tree.getChildren()).map(idOf).includes('halbach'), 'the example did not come back');
    } finally {
      told.restore();
    }

    // The first edit pins it and marks it unsaved: from there it is backed
    // up like any scene.
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'r2', type: 'magnet.Cuboid', label: 'Magnet 2', parent: 'ring2', visible: true,
    });
    await sceneWhere(without('r2'), 'the edit to land');
    assert.strictEqual(sceneFileState().dirty, true, 'the edit went unnoticed');
    await until(() => tabOf(halbach)?.isPreview === false, 'the edited example to be pinned');
  });

  test('unsaved work is backed up where a reload can find it', async function () {
    this.timeout(60000);
    // The scene lives in a subprocess that dies with the window, so this file
    // is the only copy of anything unsaved. The reload that reads it back is a
    // manual check; that it is written, and correct, is not.
    await loadExample('coil', 'coil');
    // an untouched example has nothing unsaved: an edit, to have something
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'turn', type: 'current.Circle', label: 'turn', parent: 'coil', visible: true,
    });
    await sceneWhere(without('turn'), 'the edit to land');
    const backup = sceneFileState().backup;
    assert.ok(backup, 'no backup location');

    // Wait for the backup to be *written* with this scene; whether it is
    // faithful is the assertion below, not the thing being waited for — a
    // wait that is also the check can only ever time out when it fails.
    const saved = await fileWhere(
      vscode.Uri.parse(backup),
      (doc) => {
        const held = ids(doc.objects as { id: string }[]);
        return held.has('coil') && !held.has('turn');
      },
      'the backup to be written',
    );
    assert.deepStrictEqual(saved, await scene(), 'the backup is not the scene');

    // And it restores. This is what activation does with it after a reload,
    // minus the reload — so what stays unverified here is only whether
    // activation reaches for it, not whether reaching for it works.
    await vscode.commands.executeCommand('magpylib-studio.newScene', DISCARD);
    await sceneWhere(nothing, 'the scene to clear');

    await vscode.commands.executeCommand(
      'magpylib-studio.loadScene',
      vscode.Uri.parse(backup),
      DISCARD,
    );
    assert.deepStrictEqual(
      await sceneWhere(holding('coil'), 'the backup to open'),
      saved,
      'the backup did not come back',
    );
  });

  test('Restart Engine gives every scene back as it was', async function () {
    this.timeout(60000);
    // The way out of a call that never comes back: a new engine, given each
    // scene as it last settled, and said as a restart that was asked for.
    const file = tempScene('restart.magpy.json');
    await writeJson(file, await loadExample('coil', 'coil'));
    await vscode.commands.executeCommand('magpylib-studio.loadScene', file, DISCARD);
    await sceneWhere(holding('turn'), 'the file to open');
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'turn', type: 'current.Circle', label: 'turn', parent: 'coil', visible: true,
    });
    const edited = await sceneWhere(without('turn'), 'the removal to land');
    await fileWhere(
      vscode.Uri.parse(sceneFileState().backup!),
      (doc) => !ids(doc.objects as { id: string }[]).has('turn'),
      'the edit to settle',
    );
    const told = answeringMessages('showWarningMessage', [/the engine was restarted/, undefined]);
    try {
      await vscode.commands.executeCommand('magpylib-studio.restartEngine');
      await until(() => told.said.length > 0, 'the restart to be told');
      await vscode.commands.executeCommand('magpylib-studio.saveScene');
      assert.deepStrictEqual(await readJson(file), edited, 'the scene did not come back');
    } finally {
      told.restore();
    }
  });

  test('an engine that dies comes back holding the same scene', async function () {
    this.timeout(60000);
    // The subprocess owning every scene can go away without the window going
    // with it, and the replacement starts empty. Each scene is given back the
    // document it last settled on, a second after its last edit -- so an edit
    // not yet saved survives it.
    const before = await loadExample('coil', 'coil');
    const file = tempScene('crash.magpy.json');
    await writeJson(file, before);
    await vscode.commands.executeCommand('magpylib-studio.loadScene', file, DISCARD);
    await sceneWhere(holding('turn'), 'the file to open');
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'turn',
      type: 'current.Circle',
      label: 'turn',
      parent: 'coil',
      visible: true,
    });
    const edited = await sceneWhere(without('turn'), 'the removal to land');
    await fileWhere(
      vscode.Uri.parse(sceneFileState().backup!),
      (doc) => !ids(doc.objects as { id: string }[]).has('turn'),
      'the edit to settle',
    );

    const told = answeringMessages('showWarningMessage', [/engine stopped and was started again/, undefined]);
    try {
      stopEngineForTest();

      // Save, rather than read scene.json: a virtual document is served from
      // cache until something fires its change event, so reading it straight
      // after the crash would answer out of the cache and prove nothing. Save
      // goes to the engine for `to_dict`, which starts the replacement — and
      // that is the call that has to see the scene given back rather than an
      // empty one, since it is about to write the file.
      await vscode.commands.executeCommand('magpylib-studio.saveScene');
      assert.deepStrictEqual(
        await readJson(file),
        edited,
        'the scene did not survive the engine restarting',
      );
      await until(() => told.said.length > 0, 'the restart to be told');
    } finally {
      told.restore();
    }
  });

  test('an engine that dies on putting a scene back keeps that one out', async function () {
    this.timeout(90000);
    // Two scenes with unsaved edits. The restore of the first is made to look
    // as though it stopped the engine -- its name left on disk, as a restore
    // the engine died on leaves it -- so the next engine keeps it out, marked
    // lost and never saved, and gives the other back.
    const a = tempScene('restore-a.magpy.json');
    await writeJson(a, await loadExample('halbach', 'halbach'));
    const b = tempScene('restore-b.magpy.json');
    await writeJson(b, await loadExample('coil', 'coil'));
    await vscode.commands.executeCommand('magpylib-studio.loadScene', a);
    await sceneWhere(holding('halbach'), 'the first scene');
    const first = frontScene()!;
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'r2', type: 'magnet.Cuboid', label: 'Magnet 2', parent: 'ring2', visible: true,
    });
    await sceneWhere(without('r2'), 'an unsaved edit in the first');
    await vscode.commands.executeCommand('magpylib-studio.loadScene', b);
    await sceneWhere(holding('coil'), 'the second scene');
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'turn', type: 'current.Circle', label: 'turn', parent: 'coil', visible: true,
    });
    const edited = await sceneWhere(without('turn'), 'an unsaved edit in the second');
    await fileWhere(
      vscode.Uri.parse(sceneFileState().backup!),
      (doc) => !ids(doc.objects as { id: string }[]).has('turn'),
      'the edit to settle',
    );
    const dir = await findRecoveryForTest();
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(dir!, 'restoring'),
      Buffer.from(first.key, 'utf8'),
    );

    const told = answeringMessages('showWarningMessage', [/engine stopped and was started again/, undefined]);
    const lost = answeringMessages('showErrorMessage', [/could not be brought back/, undefined]);
    try {
      stopEngineForTest();
      await vscode.commands.executeCommand('magpylib-studio.saveScene');
      assert.deepStrictEqual(await readJson(b), edited, 'the second scene did not come back');
      await until(() => lost.said.some((m) => m.includes('restore-a')), 'the first to be named lost');
      assert.ok(first.lost && first.problem, 'the first is not marked lost');
      // shown empty, it is refused a save: its file keeps what it had
      await Promise.resolve(vscode.workspace.save(first.uri)).catch(() => undefined);
      const kept = ids((await readJson(a)).objects as { id: string }[]);
      assert.ok(kept.has('halbach') && kept.has('r2'), 'the lost scene was written over its file');
    } finally {
      told.restore();
      lost.restore();
    }
  });

  test('two scenes open side by side, each its own in the tree', async function () {
    this.timeout(60000);
    // Two tabs, two sessions: the tree lists both, each with its own rows,
    // and an edit lands in the scene in front and nowhere else.
    const halbach = tempScene('two-halbach.magpy.json');
    await writeJson(halbach, await loadExample('halbach', 'halbach'));
    const coil = tempScene('two-coil.magpy.json');
    await writeJson(coil, await loadExample('coil', 'coil'));
    await vscode.commands.executeCommand('magpylib-studio.loadScene', halbach);
    await vscode.commands.executeCommand('magpylib-studio.loadScene', coil);
    await sceneWhere(holding('coil'), 'the coil in front');

    // Open Scenes lists both; Objects shows the one picked -- the coil, in
    // front -- its objects at the top, and with both picked, each under its
    // own heading.
    const rows = openScenesForTest().getChildren();
    const named = (uri: vscode.Uri) =>
      rows.find((row) => row.uri.toString() === uri.toString()) as SceneRoot;
    assert.ok(named(halbach) && named(coil), 'both scenes are listed');
    const tree = sceneTreeForTest();
    assert.ok((await tree.getChildren()).map(idOf).includes('coil'), "the coil's objects at the top");
    showScenesForTest([named(halbach).doc!, named(coil).doc!]);
    const headings = (await tree.getChildren()) as SceneRoot[];
    const under = async (uri: vscode.Uri) =>
      (await tree.getChildren(headings.find((h) => h.uri.toString() === uri.toString()))).map(idOf);
    assert.ok((await under(halbach)).includes('halbach'), 'the halbach heading holds the halbach');
    assert.ok((await under(coil)).includes('coil'), 'and the coil heading the coil');

    // an edit in the scene in front, the coil: the halbach keeps its own
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'turn',
      type: 'current.Circle',
      label: 'turn',
      parent: 'coil',
      visible: true,
    });
    await sceneWhere(without('turn'), 'the removal to land in the coil');
    await vscode.commands.executeCommand('magpylib-studio.loadScene', halbach);
    await sceneWhere(holding('halbach'), 'the halbach in front again');
    const tab = (uri: vscode.Uri) =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find(
          (t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === uri.toString(),
        );
    assert.strictEqual(tab(coil)?.isDirty, true, 'the coil carries its edit');
    assert.strictEqual(tab(halbach)?.isDirty, false, 'the halbach was not touched');

    // Undo is each scene's own: in the halbach it finds nothing of the
    // coil's to take back, and in the coil it takes back the coil's edit.
    await vscode.commands.executeCommand('magpylib-studio.undo');
    await pause(300);
    assert.ok(
      ids((await scene()).objects).has('halbach'),
      'an undo in the halbach changed the halbach',
    );
    await vscode.commands.executeCommand('magpylib-studio.loadScene', coil);
    await sceneWhere(holding('coil'), 'the coil in front again');
    assert.ok(!ids((await scene()).objects).has('turn'), "the halbach's undo reached the coil");
    await vscode.commands.executeCommand('magpylib-studio.undo');
    await sceneWhere(holding('turn'), "the coil's undo to bring its turn back");

    // A copy taken in one scene pastes into another as a copy of the object,
    // its variables with it: an id alone means nothing there.
    await vscode.commands.executeCommand('magpylib-studio.loadScene', halbach);
    await sceneWhere(holding('halbach'), 'the halbach in front to copy from');
    await vscode.commands.executeCommand('magpylib-studio.copyObject', {
      id: 'r2',
      type: 'magnet.Cuboid',
      label: 'Magnet 2',
      parent: 'ring2',
      visible: true,
    });
    await vscode.commands.executeCommand('magpylib-studio.loadScene', coil);
    await sceneWhere(holding('coil'), 'the coil in front to paste into');
    await vscode.commands.executeCommand('magpylib-studio.pasteObject');
    const pasted = await sceneWhere(holding('r2'), "the halbach's magnet copied into the coil");
    const variables = (pasted as unknown as { variables: Record<string, unknown> }).variables;
    assert.strictEqual(variables.n, 10, 'its variables did not come with it');
    assert.strictEqual(tab(halbach)?.isDirty, false, 'copying from the halbach changed it');

    // Pasted onto its own scene's row, a copy lands at that scene's top level.
    // A group, since a pattern's source needs one to stand in (plan §5.1).
    await vscode.commands.executeCommand('magpylib-studio.loadScene', halbach);
    const halbachBefore = await sceneWhere(holding('halbach'), 'the halbach in front again');
    await vscode.commands.executeCommand('magpylib-studio.copyObject', {
      id: 'ring2',
      type: 'Collection',
      label: 'Ring 2',
      parent: 'halbach',
      visible: true,
    });
    await vscode.commands.executeCommand('magpylib-studio.pasteObject', named(halbach));
    await sceneWhere(
      (doc) => doc.objects.length === halbachBefore.objects.length + 1,
      'the copy to land at the top of the halbach',
    );

    // A command that asks first ends in the scene it began in, though another
    // came in front while it asked.
    const answers = answering({
      pick: (items) => items.find((item) => item.label === 'Collection'),
    });
    const window = vscode.window as unknown as Record<string, unknown>;
    window.showInputBox = async () => {
      await vscode.commands.executeCommand('magpylib-studio.loadScene', coil);
      await sceneWhere(holding('coil'), 'the coil to come in front mid-question');
      return 'late';
    };
    try {
      await vscode.commands.executeCommand('magpylib-studio.addObject');
    } finally {
      answers.restore();
    }
    assert.ok(!ids((await scene()).objects).has('late'), 'it landed in the coil, in front');
    await vscode.commands.executeCommand('magpylib-studio.loadScene', halbach);
    await sceneWhere(holding('late'), 'the group to land in the halbach, where it began');
  });

  test('a drag copies across scenes, and Cut and Paste moves', async function () {
    this.timeout(90000);
    const halbach = tempScene('across-halbach.magpy.json');
    await writeJson(halbach, await loadExample('halbach', 'halbach'));
    const coil = tempScene('across-coil.magpy.json');
    await writeJson(coil, await loadExample('coil', 'coil'));
    await vscode.commands.executeCommand('magpylib-studio.loadScene', halbach);
    await vscode.commands.executeCommand('magpylib-studio.loadScene', coil);
    await sceneWhere(holding('coil'), 'the coil in front');
    const doc = (uri: vscode.Uri) => openScenes().find((d) => d.uri.toString() === uri.toString())!;
    const tab = (uri: vscode.Uri) =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === uri.toString());
    const tree = sceneTreeForTest();
    // a scene's row in Open Scenes, which the tree takes as a scene's heading
    const heading = (uri: vscode.Uri) =>
      openScenesForTest()
        .getChildren()
        .find((r) => r.uri.toString() === uri.toString())!;
    const row = async (under: SceneNode, id: string): Promise<SceneObject | undefined> => {
      for (const child of await tree.getChildren(under)) {
        // a removed object's dimmed row, kept for its history, is not it
        if (isObject(child) && !child.absent) {
          const found = child.id === id ? child : await row(child, id);
          if (found) {
            return found;
          }
        }
      }
      return undefined;
    };

    // A drag onto the other scene's heading copies: that scene comes in
    // front holding the copy, and the dragged one stays where it was.
    const dragged = new vscode.DataTransfer();
    tree.handleDrag([(await row(heading(halbach), 'r2'))!], dragged);
    await tree.handleDrop(heading(coil), dragged);
    await sceneWhere(holding('r2'), 'the dragged magnet copied into the coil, in front');
    assert.strictEqual(frontScene(), doc(coil));
    assert.strictEqual(tab(halbach)?.isDirty, false, 'a drag across moved the magnet');

    // Cut in one scene and pasted in the other moves it; one undo where it
    // landed puts it back where it was.
    bringToFront(doc(halbach));
    await sceneWhere(holding('ring1'), 'the halbach in front to cut from');
    await vscode.commands.executeCommand('magpylib-studio.cutObject', {
      id: 'ring1', type: 'Collection', label: 'Ring 1', parent: 'halbach', visible: true,
    });
    bringToFront(doc(coil));
    await sceneWhere(holding('coil'), 'the coil in front to paste into');
    await vscode.commands.executeCommand('magpylib-studio.pasteObject', heading(coil));
    await sceneWhere(holding('ring1'), 'the ring moved into the coil');
    await until(() => tab(halbach)?.isDirty === true, 'the cut to leave the halbach');
    let halbachTop = await row(heading(halbach), 'ring1');
    assert.strictEqual(halbachTop, undefined, 'the ring stayed in the halbach');
    await vscode.commands.executeCommand('magpylib-studio.undo');
    await sceneWhere(without('ring1'), 'the undo to take the ring out of the coil');
    for (let i = 0; i < 40 && !halbachTop; i++) {
      await pause(100);
      sceneTreeForTest().refresh(doc(halbach));
      halbachTop = await row(heading(halbach), 'ring1');
    }
    assert.ok(halbachTop, 'the same undo did not put the ring back in the halbach');

    // A copy outlives its scene: taken, its tab closed, it still pastes.
    bringToFront(doc(halbach));
    await sceneWhere(holding('halbach'), 'the halbach in front to copy from');
    await vscode.commands.executeCommand('magpylib-studio.copyObject', {
      id: 'ring2', type: 'Collection', label: 'Ring 2', parent: 'halbach', visible: true,
    });
    await vscode.commands.executeCommand('magpylib-studio.saveScene');
    const closing = tab(halbach)!;
    await vscode.window.tabGroups.close(closing);
    await until(() => !openScenes().some((d) => d.uri.toString() === halbach.toString()), 'the halbach to close');
    bringToFront(doc(coil));
    await sceneWhere(holding('coil'), 'the coil in front to paste into');
    await vscode.commands.executeCommand('magpylib-studio.pasteObject', heading(coil));
    await sceneWhere(holding('ring2'), 'the ring copied from a closed scene');
  });

  test('a scene a crash left with unsaved changes is offered them back', async function () {
    this.timeout(60000);
    // A crash of VS Code brings a tab back as VS Code last saved its editor
    // state: from the file, without the edits made since. What is left of
    // them is the recovery copy written a second after each edit, which a
    // crash leaves where this one is put by hand.
    const saved = await loadExample('halbach', 'halbach');
    const file = tempScene('crashed.magpy.json');
    await writeJson(file, saved);
    await vscode.commands.executeCommand('magpylib-studio.loadScene', file);
    await sceneWhere(holding('r2'), 'the file to open');
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'r2',
      type: 'magnet.Cuboid',
      label: 'Magnet 2',
      parent: 'ring2',
      visible: true,
    });
    const edited = await sceneWhere(without('r2'), 'the edit the crash will lose');
    // the crash: the tab goes without its changes, and only the copy is left
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await sceneWhere(holding('r2'), 'the tab to go back to its file');
    const dir = await findRecoveryForTest();
    assert.ok(dir, 'no place for recovery copies');
    await writeJson(vscode.Uri.joinPath(dir, 'crashed-test.magpy.json'), edited);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(dir, 'crashed-test.from'),
      Buffer.from(file.toString(), 'utf8'),
    );
    await vscode.window.tabGroups.close(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === file.toString()),
    );
    await findRecoveryForTest();

    const offered = answeringMessages('showWarningMessage', [
      /had unsaved changes when VS Code last closed/,
      'Restore',
    ]);
    try {
      await vscode.commands.executeCommand('magpylib-studio.loadScene', file);
      await until(() => offered.said.length > 0, 'the changes to be offered');
      await sceneWhere(without('r2'), 'the changes to come back');
    } finally {
      offered.restore();
    }
    assert.strictEqual(sceneFileState().dirty, true, 'restored changes are unsaved ones');
  });

  test('a file changed on disk comes into its tab, one undo away', async function () {
    this.timeout(90000);
    const original = await loadExample('halbach', 'halbach');
    const file = tempScene('outside.magpy.json');
    await writeJson(file, original);
    await vscode.commands.executeCommand('magpylib-studio.loadScene', file);
    await sceneWhere(holding('r2'), 'the file to open');

    // Another writer -- git, an agent -- changes the file. A clean tab takes
    // it as one step, and stays clean: it holds what the file holds.
    const without2 = JSON.parse(JSON.stringify(original)) as typeof original;
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'r2', type: 'magnet.Cuboid', label: 'Magnet 2', parent: 'ring2', visible: true,
    });
    Object.assign(without2, await sceneWhere(without('r2'), 'an edit to write elsewhere'));
    await vscode.commands.executeCommand('magpylib-studio.undo');
    await sceneWhere(holding('r2'), 'the edit undone');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await pause(300);
    assert.strictEqual(sceneFileState().dirty, false);
    await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(without2), 'utf8'));
    await sceneWhere(without('r2'), "the file's version to come in");
    assert.strictEqual(sceneFileState().dirty, false, 'a tab holding the file is not unsaved');
    await vscode.commands.executeCommand('magpylib-studio.undo');
    await sceneWhere(holding('r2'), 'what the tab had, one undo away');

    // With unsaved changes it comes in all the same, and says where they went.
    const told = answeringMessages('showWarningMessage', [/does not read as a scene/, undefined]);
    const info = vscode.window.showInformationMessage;
    const said: string[] = [];
    (vscode.window as unknown as Record<string, unknown>).showInformationMessage = async (
      message: string,
    ) => {
      said.push(message);
      return undefined;
    };
    try {
      assert.strictEqual(sceneFileState().dirty, true, 'the undo is an unsaved change');
      await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(original), 'utf8'));
      await sceneWhere(holding('r2'), "the file's version again");
      await until(() => said.some((m) => /one undo away/.test(m)), 'the notice of the changes');

      // A file that does not read is not loaded, and a save asks first.
      await vscode.workspace.fs.writeFile(file, Buffer.from('<<<<<<< ours\n{}', 'utf8'));
      await until(() => told.said.length > 0, 'the file to be refused');
      assert.ok(ids((await scene()).objects).has('r2'), 'the tab kept its scene');
    } finally {
      told.restore();
      (vscode.window as unknown as Record<string, unknown>).showInformationMessage = info;
    }
    const asked = answeringMessages('showWarningMessage', [/changed on disk since/, 'Overwrite']);
    try {
      await vscode.commands.executeCommand('magpylib-studio.saveScene');
      assert.strictEqual(asked.said.length, 1, 'the save did not ask');
    } finally {
      asked.restore();
    }
    assert.ok(ids((await readJson(file)).objects as { id: string }[]).has('r2'), 'not written over');
  });

  test('a scene renamed in the Explorer keeps its unsaved changes and undo', async function () {
    this.timeout(60000);
    // VS Code reopens a renamed custom editor from the new file, its unsaved
    // edits dropped (plans/several-scenes.md §8): the scene is carried over.
    const file = tempScene('before-rename.magpy.json');
    await writeJson(file, await loadExample('halbach', 'halbach'));
    await vscode.commands.executeCommand('magpylib-studio.loadScene', file);
    await sceneWhere(holding('r2'), 'the file to open');
    await vscode.commands.executeCommand('magpylib-studio.removeObject', {
      id: 'r2', type: 'magnet.Cuboid', label: 'Magnet 2', parent: 'ring2', visible: true,
    });
    await sceneWhere(without('r2'), 'an unsaved edit');

    const renamed = vscode.Uri.joinPath(file, '..', 'after-rename.magpy.json');
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(file, renamed);
    assert.ok(await vscode.workspace.applyEdit(edit), 'the rename was refused');
    await until(() => sceneFileState().file === renamed.toString(), 'the renamed scene in front');
    await sceneWhere(without('r2'), 'the unsaved edit under the new name');
    await until(() => sceneFileState().dirty, 'the renamed tab marked unsaved');
    assert.ok(
      ids((await readJson(renamed)).objects as { id: string }[]).has('r2'),
      'the edit was saved, not carried',
    );
    await vscode.commands.executeCommand('magpylib-studio.undo');
    await sceneWhere(holding('r2'), 'its undo history carried with it');
  });

  test('variants are kept, renamed and deleted from the Variables view', async function () {
    this.timeout(60000);
    await loadExample('halbach', 'halbach');
    const named = (doc: unknown) =>
      Object.keys((doc as { variants?: Record<string, unknown> }).variants ?? {});

    let answers = answering({ input: ['wide'] });
    try {
      await vscode.commands.executeCommand('magpylib-studio.saveVariant');
    } finally {
      answers.restore();
    }
    await sceneWhere((doc) => named(doc).includes('wide'), 'the variant to be kept');

    answers = answering({
      pick: (items) => items.find((item) => item.label === 'wide'),
      input: ['broad'],
    });
    try {
      await vscode.commands.executeCommand('magpylib-studio.renameVariant');
    } finally {
      answers.restore();
    }
    await sceneWhere(
      (doc) => named(doc).includes('broad') && !named(doc).includes('wide'),
      'the variant renamed',
    );

    answers = answering({ pick: (items) => items.find((item) => item.label === 'broad') });
    const asked = answeringMessages('showWarningMessage', [/Delete the variant/, 'Delete']);
    try {
      await vscode.commands.executeCommand('magpylib-studio.removeVariant');
    } finally {
      answers.restore();
      asked.restore();
    }
    await sceneWhere((doc) => !named(doc).includes('broad'), 'the variant deleted');
    await vscode.commands.executeCommand('magpylib-studio.undo');
    await sceneWhere((doc) => named(doc).includes('broad'), 'one undo bringing it back');
  });

  test('Save As hands the scene over, its undo history with it', async function () {
    this.timeout(60000);
    // VS Code replaces the tab with one for the new file, a new document
    // (plans/several-scenes.md §8); the scene goes with it rather than being
    // read back from the file. Save As's native dialog cannot be answered
    // from a test; its simple one can, and accepted, takes the path offered:
    // the untitled scene's own, in a folder of the test's.
    const target = tempScene('save-as.magpy.json');
    const files = vscode.workspace.getConfiguration('files');
    await files.update('simpleDialog.enable', true, vscode.ConfigurationTarget.Global);
    // where the dialog starts: the test's folder, not the home folder
    await files.update(
      'dialog.defaultPath',
      vscode.Uri.joinPath(target, '..').fsPath,
      vscode.ConfigurationTarget.Global,
    );
    try {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        target.with({ scheme: 'untitled' }),
        'magpylibStudio.scene',
      );
      await sceneWhere(nothing, 'the untitled scene in front');
      const answers = answering({
        pick: (items) => items.find((item) => item.label === 'Collection'),
        input: ['group'],
      });
      try {
        await vscode.commands.executeCommand('magpylib-studio.addObject');
      } finally {
        answers.restore();
      }
      await sceneWhere(holding('group'), 'an edit to undo later');

      let saved = false;
      const saving = Promise.resolve(
        vscode.commands.executeCommand('magpylib-studio.saveSceneAs'),
      ).finally(() => (saved = true));
      // the dialog, holding its suggestion, accepted once it is up
      for (let i = 0; i < 20 && !saved; i++) {
        await pause(500);
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      }
      await saving;
      await until(() => sceneFileState().file === target.toString(), 'the tab to be the file');
      assert.ok(ids((await readJson(target)).objects as { id: string }[]).has('group'));
      await vscode.commands.executeCommand('magpylib-studio.undo');
      await sceneWhere(without('group'), 'the undo history carried to the file');
    } finally {
      await files.update('simpleDialog.enable', undefined, vscode.ConfigurationTarget.Global);
      await files.update('dialog.defaultPath', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('a scene from a newer version is refused, leaving the open one alone', async function () {
    this.timeout(60000);
    const intact = await loadExample('halbach', 'halbach');
    const open = frontScene()!;

    // It opens in a tab of its own, which says it could not be read and is
    // never written over: the empty scene it shows must not go over a file
    // a newer version wrote.
    const file = tempScene('from-the-future.magpy.json');
    await writeJson(file, { version: 99, events: [], objects: [] });
    await vscode.commands.executeCommand('magpylib-studio.loadScene', file, DISCARD);
    await until(
      () => errorsShown.some((m) => m.includes('could not open from-the-future')),
      'the refusal to be said',
    );
    const unreadable = frontScene()!;
    assert.notStrictEqual(unreadable, open, 'the file opened in a tab of its own');
    assert.match(String(unreadable.problem), /newer magpylib-studio/);
    // an edit, so that there is something to save
    const answers = answering({
      pick: (items) => items.find((item) => item.label === 'Collection'),
      input: ['group'],
    });
    try {
      await vscode.commands.executeCommand('magpylib-studio.addObject');
    } finally {
      answers.restore();
    }
    await sceneWhere(holding('group'), 'the edit to land');
    await vscode.workspace.save(unreadable.uri).then(undefined, () => undefined);
    assert.deepStrictEqual(
      await readJson(file),
      { version: 99, events: [], objects: [] },
      'a scene that could not be read was written over its file',
    );

    // and the scene that was open is as it was
    bringToFront(open);
    assert.deepStrictEqual(
      (await sceneWhere(holding('halbach'), 'the halbach in front again')).events,
      intact.events,
      'a document we cannot read changed the one we could',
    );
  });

  /**
   * The values below are what numpy prints, pasted in.
   *
   * A path built here is written back out as the numpy call that would make
   * it, but only where the call reproduces it to the last bit — so these two
   * functions are an implementation of numpy's arithmetic in another language,
   * and the only way to know they still agree is to pin what numpy actually
   * said. The tell is `0.020000000000000004`: the obvious spelling gives
   * exactly 0.02 there, which is a different number, and that difference
   * quietly cost almost every path its compact form.
   */
  test('an engine is refused unless it speaks the protocol this extension does', () => {
    // An engine from before several scenes does not know `version`, and would
    // take every request as its one scene's: refused, not used quietly.
    assert.match(
      String(engineMismatch(undefined, { type: 'MethodError', message: "unknown method 'version'" })),
      /before several scenes/,
    );
    assert.match(String(engineMismatch({})), /did not say which version/);
    assert.match(String(engineMismatch({ protocol: 1 })), /older than this extension needs/);
    assert.match(String(engineMismatch({ protocol: 3 })), /update the extension/);
    assert.strictEqual(engineMismatch({ protocol: 2 }), undefined, 'the engine of this repo is refused');
  });

  test('an even ramp is spaced the way the call that writes it spaces it', () => {
    assert.deepStrictEqual(evenRamp([0, 0, 0.1], 5), [
      [0, 0, 0],
      [0, 0, 0.020000000000000004],
      [0, 0, 0.04000000000000001],
      [0, 0, 0.06],
      [0, 0, 0.08000000000000002],
      [0, 0, 0.1],
    ]);
    // the other branch: no component of the step is zero
    assert.deepStrictEqual(evenRamp([1, 2, 3], 4), [
      [0, 0, 0],
      [0.25, 0.5, 0.75],
      [0.5, 1, 1.5],
      [0.75, 1.5, 2.25],
      [1, 2, 3],
    ]);
    // a spin is the same ramp with one number to a step
    assert.deepStrictEqual(
      evenRamp([360], 6).map(([a]) => a),
      [0, 60, 120, 180, 240, 300, 360],
    );
  });

  test('a ramp of increments is one multiply, and needs no such care', () => {
    assert.deepStrictEqual(incrementRamp([0, 0, 0.001], 5), [
      [0, 0, 0],
      [0, 0, 0.001],
      [0, 0, 0.002],
      [0, 0, 0.003],
      [0, 0, 0.004],
      [0, 0, 0.005],
    ]);
    assert.deepStrictEqual(
      incrementRamp([1.5], 4).map(([a]) => a),
      [0, 1.5, 3, 4.5, 6],
    );
  });

  test('every object opens on the steps that built it, in the scene or not', async () => {
    // The provider against canned data: what the tree does with a history is
    // its own logic, and driving the engine to produce one says nothing more
    // about it than saying it here does.
    const objects: SceneObject[] = [
      { id: 'ring', type: 'Collection', label: 'ring', parent: null, visible: true },
      { id: 'm', type: 'magnet.Cuboid', label: 'm', parent: 'ring', visible: true },
    ];
    const step = (
      id: string,
      target: string,
      op: string,
      extra: Partial<SceneOperation> = {},
    ): SceneOperation => ({
      kind: 'operation',
      index: Number(id.slice(1)) - 1,
      id,
      target,
      op,
      label: op,
      source: `${target}.${op}()`,
      ...extra,
    });
    const operations: SceneOperation[] = [
      step('e1', 'ring', 'create'),
      step('e2', 'm', 'create'),
      step('e3', 'm', 'rotate_from_angax'),
      step('e4', 'gone', 'create'),
      step('e5', 'gone', 'rotate_from_angax'),
      step('e6', 'gone', 'remove'),
      step('e7', 'stranded', 'rotate_from_angax', { error: 'targets unknown object' }),
      step('e8', 'later', 'create', { pending: true }),
    ];
    const { tree, roots } = await oneSceneTree(objects, operations);
    assert.deepStrictEqual(
      roots.map(idOf),
      ['ring', 'gone', 'stranded', 'later'],
      'the scene, then what it no longer has, in log order',
    );

    // the bug this all started from: a leaf with a history and no chevron
    const inRing = await tree.getChildren(roots[0]);
    assert.deepStrictEqual(inRing.map(idOf), [
      'e1',
      'm',
    ]);
    const magnet = inRing[1] as SceneObject;
    assert.strictEqual(
      tree.getTreeItem(magnet).collapsibleState,
      vscode.TreeItemCollapsibleState.Collapsed,
      'a magnet with steps has to be openable',
    );
    assert.deepStrictEqual(
      (await tree.getChildren(magnet)).map(idOf),
      ['e2', 'e3'],
    );
    assert.strictEqual(
      tree.getTreeItem(roots[0]).collapsibleState,
      vscode.TreeItemCollapsibleState.Expanded,
      'what holds objects still opens by itself',
    );

    // a deleted object keeps its story, including the step that deleted it —
    // which is the only way to put it back short of undo
    const [, gone, stranded, later] = roots as SceneObject[];
    assert.deepStrictEqual(
      [gone.absent, stranded.absent, later.absent],
      ['removed', 'not built', 'not applied'],
    );
    assert.deepStrictEqual(
      (await tree.getChildren(gone)).map(idOf),
      ['e4', 'e5', 'e6'],
    );
    const item = tree.getTreeItem(gone);
    assert.strictEqual(item.description, 'removed');
    assert.strictEqual(
      item.contextValue,
      'absentObject',
      'the object menus act on objects the scene has; this is the absence of one',
    );
  });

  test('a mesh row says what is wrong with the mesh', async () => {
    // The one thing about a mesh that a picture cannot show: an open body
    // draws exactly like a closed one and computes a field that is wrong in
    // sign as well as size. The row is where that has to be said, because it
    // is the only part of the mesh anyone reads before trusting a number.
    const objects: SceneObject[] = [
      {
        id: 'good',
        type: 'magnet.TriangularMesh',
        label: 'good',
        parent: null,
        visible: true,
        mesh: { open: false, faces: 12, vertices: 8, source: 'cube.stl · 12 faces' },
      },
      {
        id: 'bad',
        type: 'magnet.TriangularMesh',
        label: 'bad',
        parent: null,
        visible: true,
        mesh: { open: true, open_edges: 12, faces: 10, source: 'rotor.stl · 10 faces' },
      },
    ];
    const { tree, roots } = await oneSceneTree(objects, []);

    const good = tree.getTreeItem(roots[0] as SceneObject);
    assert.strictEqual(good.description, 'cube.stl · 12 faces', 'where it came from');

    const bad = tree.getTreeItem(roots[1] as SceneObject);
    assert.match(String(bad.description), /open at 12 edges/, 'and what is wrong');
    assert.strictEqual(
      (bad.iconPath as vscode.ThemeIcon).id,
      'warning',
      'a source whose field is wrong must not look like one whose field is right',
    );
  });

  test('importing a mesh file records the file, not the mesh', async function () {
    this.timeout(60000);
    // The flow nothing else reaches: a dialog, the question of what units the
    // file is in, and an object built from the answer. Driven by standing in
    // for the three prompts, which is the only way a modal runs unattended.
    await vscode.commands.executeCommand('magpylib-studio.newScene', DISCARD);
    await sceneWhere(nothing, 'the scene to clear');

    const stl = vscode.Uri.file(join(mkdtempSync(join(tmpdir(), 'magpy-')), 'part.stl'));
    await vscode.workspace.fs.writeFile(stl, Buffer.from(binaryCubeStl(10)));

    const answers = answering({
      open: [stl],
      // millimetres, then the id, then the polarization
      pick: (items) => items.find((i) => /Millimetres/.test(i.label)),
      input: ['rotor', '0, 0, 1.3'],
    });
    try {
      await vscode.commands.executeCommand('magpylib-studio.importMesh');
      const doc = await sceneWhere(holding('rotor'), 'the imported mesh');
      const created = doc.events.find((e) => e.op === 'create') as unknown as {
        params: { mesh_source: { from: string; path: string; scale: number; sha256: string } };
      };
      const source = created.params.mesh_source;

      assert.strictEqual(source.from, 'file');
      assert.match(source.path, /part\.stl$/);
      assert.strictEqual(source.scale, 0.001, 'millimetres, as answered');
      assert.strictEqual(source.sha256.length, 64, 'what the file held, recorded');
      assert.ok(
        !JSON.stringify(doc).includes('"vertices"'),
        'the document should name the file rather than copy it',
      );
    } finally {
      answers.restore();
    }
  });

  test('a mesh built from a formula survives being saved and opened', async function () {
    this.timeout(60000);
    // A superquadric is generated rather than read, so the document has no
    // file to point at — only the numbers that make the shape. This is the
    // round trip that says those numbers are the document.
    await loadExample('solid', 'magnet');
    const doc = await scene();
    const created = doc.events.find((e) => e.op === 'create') as unknown as {
      params: { mesh_source: { from: string } };
    };
    assert.strictEqual(created.params.mesh_source.from, 'superquadric');
    assert.ok(
      !JSON.stringify(doc).includes('"vertices"'),
      'a generated mesh is its formula, not the points it came out as',
    );

    // Written as Save writes it and opened through the real command. Save As
    // is VS Code's own now, whose dialog a test cannot answer.
    const file = tempScene('formula.magpy.json');
    await writeJson(file, doc);

    await vscode.commands.executeCommand('magpylib-studio.newScene', DISCARD);
    await sceneWhere(nothing, 'the scene to clear');
    await vscode.commands.executeCommand('magpylib-studio.loadScene', file, DISCARD);
    const reopened = await sceneWhere(holding('magnet'), 'the scene to open again');

    assert.deepStrictEqual(
      reopened.events,
      doc.events,
      'the same scene, spelled the same way',
    );
  });

  test('the run raised no errors at the user that it did not mean to', () => {
    // One is deliberate: opening a document from a newer version has to say
    // so. Anything else is the extension complaining about something a test
    // did wrong, which in a host window flashes past unread.
    // Two-sided on purpose: if the spy were not working, filtering an empty
    // list would pass and prove nothing. The refusal has to be in there.
    assert.ok(
      errorsShown.some((m) => /newer magpylib-studio/.test(m)),
      `the deliberate refusal was not recorded; saw ${JSON.stringify(errorsShown)}`,
    );
    // Logged, not just asserted: a notification in a test host flashes past
    // unread, and "what did it say at me" is the question you cannot answer
    // afterwards. One line here answers it for every future run.
    console.log(`      notifications raised: ${JSON.stringify(errorsShown)}`);
    const unexpected = errorsShown.filter((m) => !/newer magpylib-studio/.test(m));
    assert.deepStrictEqual(unexpected, [], 'unexpected notifications');
  });
});
