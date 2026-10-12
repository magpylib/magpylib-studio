import { AsyncLocalStorage } from 'async_hooks';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PythonExtension } from '@vscode/python-extension';
import { EngineClient, EngineError } from './engineClient';
import { HistoryEntry, HistoryTreeProvider } from './historyView';
import {
  addScene,
  bringToFront,
  frontScene,
  newSessionName,
  onDidChangeFront,
  onDidChangeScenes,
  openScenes,
  removeScene,
  SCENE_VIEW_TYPE,
  SceneDocument,
  sceneFor,
  sceneOfNode,
} from './scenes';
import { setTextFocus, tookTextFocus, undoTyping } from './textFocus';
import { mediaUri, nonce as webviewNonce } from './webview';
import { Shown, Variable, VariableBounds, VariablesViewProvider } from './variablesView';
import { InspectorViewProvider } from './inspectorView';
import {
  activateScriptViewer,
  drawScriptsHere,
  setDrawScriptsHere,
} from './scriptViewer';
import {
  iconFor,
  isObject,
  isOperation,
  meshFault,
  MeshStatus,
  SceneNode,
  SceneObject,
  SceneOperation,
  SceneRoot,
  OpenScenesProvider,
  SceneTreeProvider,
} from './sceneTree';

let engine: EngineClient | undefined;
let fieldPanel: vscode.WebviewPanel | undefined;
/** The scene the field panel belongs to: the one it was opened for. */
let fieldScene: SceneDocument | undefined;
let selectedObjectId: string | undefined;
let sceneTree: SceneTreeProvider | undefined;
let sceneTreeView: vscode.TreeView<SceneNode> | undefined;
/** Open Scenes: the list of open scenes above Objects. */
let openScenesList: OpenScenesProvider | undefined;
/** The scenes Objects shows: those picked in Open Scenes. */
let shownScenes = new Set<SceneDocument>();
/** What Copy or Cut took, and from which scene: an id means nothing in another. */
let clipboard: { id: string; cut: boolean; scene: SceneDocument | undefined } | undefined;
let historyTree: HistoryTreeProvider | undefined;
let variablesTree: VariablesViewProvider | undefined;
let inspector: InspectorViewProvider | undefined;
let engineOutput: vscode.OutputChannel | undefined;
let sceneDocEmitter: vscode.EventEmitter<vscode.Uri> | undefined;

// Read-only virtual document generated from the scene. Nothing in the UI
// opens it today — Save writes the same JSON to a real file, which is what a
// user wants it for — but it is how the integration tests read the live
// document out of the engine, through the same API an editor tab would.
const SCENE_JSON_URI = vscode.Uri.parse('magpylib-studio:/scene.json');

// The script tab, unlike scene.json, is editable — the scene as a function, applied on a
// deliberate save — so it is a real file (a content provider has no write
// side) kept in extension storage: scratch space, not something to litter the
// user's workspace with.
// Being a real file, VS Code restores its tab across a window reload, which is
// why the path is fixed at activation and the restored tab re-rendered: see
// adoptRestoredScriptTab. (That is also why the extension activates on
// startup — a tab it owns is on screen before the user asks for anything.)
/** Re-render a scene's script tab -- the scene in front's when none is named;
 *  set during activation. Each scene has its own (see scriptFileOf). */
let refreshScript: ((doc?: SceneDocument) => void) | undefined;

/** What the script tab says before the code: what it is, and what a save does
 *  to it, said where it happens rather than in a notification. */
const SCRIPT_TAB_HEADER = [
  '# The scene as a function. Save to apply it: the scene becomes what the',
  '# function builds, as one step to undo. The tab is regenerated from the',
  '# scene after a save, so a helper or a loop written here comes back as the',
  '# steps it made, and comments go. Code to keep belongs in a file of its own:',
  '# Magpylib Studio: Export as Scene Script...',
  '',
].join('\n');

/** An edit of a scene, told to VS Code, which marks the scene's tab unsaved
 *  and backs it up. Fired once per edit: see broadcastMutation. */
const sceneEdited = new vscode.EventEmitter<
  vscode.CustomDocumentContentChangeEvent<SceneDocument>
>();
/** Where each open scene's recovery copy is written, in extension storage:
 *  set at activation. VS Code's own backups miss the edits since it last
 *  saved its editor state, about a minute (plans/several-scenes.md §8). */
let recoveryDir: vscode.Uri | undefined;
/** The pending settle of each scene with an edit not yet settled. */
const settleTimers = new Map<SceneDocument, ReturnType<typeof setTimeout>>();
/** Before scenes were tabs, the one scene the workspace last had and whether
 *  it had unsaved changes: opened once as a tab by an upgraded extension,
 *  then forgotten. */
const SCENE_STATE_KEY = 'magpylib-studio.scene';
/** Remembered globally (not per workspace): whether the getting-started
 *  walkthrough has already been shown, so it opens once per install. */
const TOUR_SHOWN_KEY = 'magpylib-studio.tourShown';
/** The extension VS Code associates with the studio, and what Save proposes.
 *  Doubled rather than a bare `.magpy`: the file stays JSON to git, to schema
 *  validation and to every editor, while still being a name we can claim. */
const SCENE_EXTENSION = '.magpy.json';

/** What a command that replaces the scene should do about unsaved changes.
 *  Absent means "ask", which is what a person picking the menu item wants;
 *  a caller that is not a person says so. */
type Discard = { discardChanges?: boolean };

/** What sort of value a variable holds, which decides whether it gets a
 *  slider, a whole-number slider, or a dropdown. */
type VariableKind = 'number' | 'whole' | 'choice';

/** One wording per kind, so the menu that reports which one a variable is and
 *  the picker that changes it cannot drift apart. */
const KIND_LABEL: Record<VariableKind, string> = {
  number: 'Number',
  whole: 'Whole number',
  choice: 'One of a few choices',
};

/** What a variable may measure (`docs/decisions.md#0008-units-are-metadata`), as the picker offers it.
 *  The value stays SI whichever it is; the unit is how it is shown and read. */
const UNIT_KINDS: {
  unit: string | null;
  label: string;
  detail: string;
  /** The unit the scene holds it in. */
  si: string;
  /** What a value typed with a unit looks like, and a range typed so. */
  example: string;
  range: string;
  /** What variables of this kind are, to recognise one by. */
  such: string;
}[] = [
  {
    unit: 'length',
    label: 'Length',
    detail: "metres, or the scene's length unit",
    si: 'm',
    example: '15 mm, 2 cm',
    range: '10 mm, 30 mm',
    such: 'a gap, a radius, a pitch',
  },
  {
    unit: 'angle',
    label: 'Angle',
    detail: 'degrees, as magpylib turns',
    si: '°',
    example: '1.57 rad',
    range: '-1.57 rad, 1.57 rad',
    such: 'a tilt, a stagger',
  },
  {
    unit: 'field',
    label: 'Field',
    detail: 'tesla: a polarization, a flux density',
    si: 'T',
    example: '800 mT',
    range: '500 mT, 1.4 T',
    such: 'a polarization, a flux density',
  },
  {
    unit: 'current',
    label: 'Current',
    detail: 'amperes',
    si: 'A',
    example: '2 kA',
    range: '0, 2 kA',
    such: 'a coil current',
  },
  {
    unit: 'dimensionless',
    label: 'Dimensionless',
    detail: 'a pure number',
    si: '',
    example: '',
    range: '0, 10',
    such: 'a ratio, a factor',
  },
  {
    unit: null,
    label: 'No unit',
    detail: 'shown as the bare number it is',
    si: '',
    example: '',
    range: '0, 10',
    such: '',
  },
];

/** The rule a value box states under itself: "a field, in T unless you type
 *  a unit". Empty for a variable that measures nothing. */
function unitRule(unit?: string | null, symbol?: string): string {
  const kind = UNIT_KINDS.find((u) => u.unit === unit);
  if (!kind?.example) {
    return '';
  }
  const article = /^[aeiou]/i.test(kind.label) ? 'an' : 'a';
  const shownIn = kind.unit === 'angle' ? 'degrees' : symbol || kind.si;
  return `${article} ${kind.label.toLowerCase()}, in ${shownIn} unless you type a unit`;
}

/** What a value box shows inside itself until something is typed: a bare
 *  number, one with a unit, an expression -- "e.g. 1.2   or   800 mT   or
 *  an expression like b * 2". A bare number is in the unit it is shown in,
 *  so a length's example follows the scene's length unit and a field's its
 *  field unit. */
function valueExamples(unit?: string | null, symbol?: string): string {
  const LENGTH: Record<string, [string, string]> = {
    m: ['0.015', '15 mm'],
    cm: ['1.5', '15 mm'],
    mm: ['15', '2 cm'],
    µm: ['15000', '15 mm'],
  };
  const FIELD: Record<string, [string, string]> = {
    T: ['1.2', '800 mT'],
    mT: ['800', '1.2 T'],
    µT: ['50', '1.2 T'],
  };
  const EXAMPLES: Record<string, [string, string]> = {
    length: LENGTH[symbol ?? 'm'] ?? LENGTH.m,
    angle: ['90', '1.57 rad'],
    field: FIELD[symbol ?? 'T'] ?? FIELD.T,
    current: ['3', '2 kA'],
  };
  const [bare, typed] = EXAMPLES[unit ?? ''] ?? ['2.5', ''];
  return ['e.g. ' + bare, typed, 'an expression like b * 2'].filter(Boolean).join('   or   ');
}

/** "min, max" as a range of this kind is typed, for a placeholder. */
function rangeHint(unit?: string | null, symbol?: string): string {
  const kind = UNIT_KINDS.find((u) => u.unit === unit);
  return kind?.example
    ? `min, max in ${kind.unit === 'angle' ? 'degrees' : symbol || kind.si}, or with units: ${kind.range}`
    : 'min, max — e.g. 0, 10';
}

/** What a typed value means, said under the box as it is typed: `1` for a
 *  field is 1 T, `15 mm` for a length is 0.015 m -- the number the scene
 *  will hold, in the unit it holds it in. */
export function meaning(
  value: number,
  unit?: string | null,
): vscode.InputBoxValidationMessage {
  const si = UNIT_KINDS.find((u) => u.unit === unit)?.si ?? '';
  return {
    message: `= ${inUnit(value)}${si ? (si === '°' ? si : ` ${si}`) : ''}`,
    severity: vscode.InputBoxValidationSeverity.Info,
  };
}

/** The length units a scene may be shown in; its numbers stay metres. */
const LENGTH_UNITS = ['m', 'cm', 'mm', 'µm'];

/** The units a field may be shown in; its numbers stay tesla. */
const FIELD_UNITS = ['T', 'mT', 'µT'];

/** "0 … 10", "from 0", "up to 10" — or undefined when neither end is set.
 *  With `shown`, the ends in the unit the variable is shown in: "10 … 30 mm". */
function rangeLabel(low?: number, high?: number, shown?: Shown): string | undefined {
  const as = (value: number) => inUnit(value, shown);
  const unit = shown?.symbol ? ` ${shown.symbol}` : '';
  if (low !== undefined && high !== undefined) {
    return `${as(low)} … ${as(high)}${unit}`;
  }
  if (low !== undefined) {
    return `from ${as(low)}${unit}`;
  }
  return high === undefined ? undefined : `up to ${as(high)}${unit}`;
}

/** A number as a variable is shown: 0.015 is "15" for one shown in mm. Six
 *  significant figures, so 0.0234 shown in mm is 23.4 and not 23.400000000000002. */
function inUnit(value: number, shown?: Shown): string {
  const scaled = shown ? value * shown.scale : value;
  return Number.isInteger(scaled) ? String(scaled) : String(Number(scaled.toPrecision(6)));
}

/** A number, then perhaps a unit and nothing else — `15`, `15 mm`, `1.5cm`,
 *  `-90°` — which the engine reads (`quantity`). `2*gap` is an expression. */
const QUANTITY = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*[A-Za-zµμ°]*\s*$/;

/** "x, y, z" -> ["x","y","z"], keeping numbers as numbers so a choice between
 *  4, 8 and 16 stays a choice between numbers. */
function parseChoices(text: string): (string | number)[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (Number.isFinite(Number(part)) ? Number(part) : part));
}

/**
 * Object types offered by "Add Object…", with ready-to-build defaults.
 *
 * `detail` says what the thing is and what it is reached for, not what its
 * defaults are: every default is shown again a moment later, prefilled in the
 * box that asks for it, so spending the menu's one line of prose on them says
 * nothing the next screen does not. Lowercase, like every other menu here.
 *
 * `type` is shown too, as the dimmed half of the row, because it is the name
 * the script will use and the one a magpylib user already knows — "Current
 * loop" is friendlier than `current.Circle` but nobody can search for it.
 *
 * `rows` constrains a parameter that is a list of points, which is asked for
 * in an editor rather than a box. How many are allowed cannot be read off the
 * default — four corners and three vertices look alike from here — and the
 * engine's refusal comes too late to be useful, after the whole creation.
 */
const OBJECT_TEMPLATES: {
  label: string;
  type: string;
  detail: string;
  params: Record<string, unknown>;
  rows?: Record<string, { noun: string; min: number; max?: number }>;
  /** Picked from this menu, handled by a command of its own: some objects
   *  are not made by filling in their constructor's arguments. */
  command?: string;
}[] = [
  {
    label: 'Cuboid magnet',
    type: 'magnet.Cuboid',
    detail: 'rectangular block — the bar magnet, and what most arrays are built from',
    params: { polarization: [0, 0, 1], dimension: [1, 1, 1] },
  },
  {
    label: 'Cylinder magnet',
    type: 'magnet.Cylinder',
    detail: 'round bar or disc — rod and disc magnets, axial or diametral',
    params: { polarization: [0, 0, 1], dimension: [1, 1] },
  },
  {
    label: 'Cylinder segment magnet',
    type: 'magnet.CylinderSegment',
    detail: 'a wedge of a ring — arc magnets, rotor and stator poles',
    params: { polarization: [0, 0, 1], dimension: [1, 2, 1, 0, 90] },
  },
  {
    label: 'Sphere magnet',
    type: 'magnet.Sphere',
    detail: 'a ball — joysticks and angle sensors; turning it moves only the poles',
    params: { polarization: [0, 0, 1], diameter: 1 },
  },
  {
    label: 'Tetrahedron magnet',
    type: 'magnet.Tetrahedron',
    detail: 'four corners you place yourself — stack them to fill any shape',
    params: {
      polarization: [0, 0, 1],
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    },
    rows: { vertices: { noun: 'corners', min: 4, max: 4 } },
  },
  {
    label: 'Current loop',
    type: 'current.Circle',
    detail: 'one circular turn of wire — pattern it along an axis for a solenoid',
    params: { current: 1000, diameter: 2 },
  },
  {
    label: 'Current polyline',
    type: 'current.Polyline',
    detail: 'wire through a list of points — PCB traces, busbars, any bent path',
    params: {
      current: 1000,
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
    },
    rows: { vertices: { noun: 'vertices', min: 2 } },
  },
  {
    label: 'Dipole',
    type: 'misc.Dipole',
    detail: 'a point source — for a magnet too small or too far to model as a shape',
    params: { moment: [0, 0, 100] },
  },
  {
    label: 'Sensor',
    type: 'Sensor',
    detail: 'where the field is read — B and H at a point, or over a pixel grid',
    params: {},
  },
  {
    label: 'Triangular mesh',
    type: 'magnet.TriangularMesh',
    detail: 'a magnet shaped like a CAD part — from a mesh file, or a point cloud',
    params: {},
    // Not a set of parameters anybody types: a file dialog and the question of
    // what units the file is in are a flow of their own. One row, because one
    // magpylib class is one thing to add — which of the two ways to make it is
    // the first question that flow asks, not a second thing in this list.
    command: 'magpylib-studio.addMesh',
  },
  {
    label: 'Collection',
    type: 'Collection',
    detail: 'a group that moves, rotates and sums its field as one',
    params: {},
  },
];

/** Units an imported mesh might be drawn in, and what they are in metres.
 *
 *  A mesh file carries no units at all — the one thing every format leaves
 *  out — so this is a question that has to be asked rather than detected.
 *  Millimetres lead because that is what a CAD export is, and because the
 *  alternative failure is silent: a 10 mm part read as metres is a magnet ten
 *  metres wide, which still computes a field, still draws, and is wrong by a
 *  factor of a thousand in every number that comes off it. */
const MESH_UNITS: { label: string; scale: number; detail?: string }[] = [
  { label: 'Millimetres', scale: 0.001, detail: 'what almost every CAD export is in' },
  { label: 'Centimetres', scale: 0.01 },
  { label: 'Metres', scale: 1, detail: 'the file is already in SI' },
  { label: 'Inches', scale: 0.0254 },
];

/** Superellipsoid settings worth starting from, named by the shape they are.
 *
 *  `plan` rounds the solid seen from above — square through circular to a
 *  diamond — and `profile` rounds it seen from the side, flat-topped through
 *  domed. Three of these reproduce a magpylib primitive exactly, which is
 *  both the reassurance that the mesh path is right and the explanation of
 *  what the two numbers do; the rest are the shapes magpylib has no class
 *  for, which is why anyone would reach for this. */
const SUPERQUADRIC_SHAPES: {
  label: string;
  id: string;
  plan: number;
  profile: number;
  detail: string;
}[] = [
  {
    label: 'Rounded block',
    id: 'block',
    plan: 0.35,
    profile: 0.35,
    detail: 'a magnet with its edges taken off — no magpylib class for it',
  },
  {
    label: 'Block',
    id: 'block',
    plan: 0.05,
    profile: 0.05,
    detail: 'square corners: the same field as magnet.Cuboid',
  },
  {
    label: 'Cylinder',
    id: 'disc',
    plan: 1,
    profile: 0.05,
    detail: 'round in plan, flat on top: the same field as magnet.Cylinder',
  },
  {
    label: 'Sphere',
    id: 'ball',
    plan: 1,
    profile: 1,
    detail: 'the same field as magnet.Sphere',
  },
  {
    label: 'Rounded disc',
    id: 'pill',
    plan: 1,
    profile: 0.4,
    detail: 'a disc with a rounded rim — a pot magnet',
  },
  {
    label: 'Diamond',
    id: 'diamond',
    plan: 2,
    profile: 2,
    detail: 'an octahedron; past 2 the faces pinch inward',
  },
];

/** A file name -> an id that is a legal Python name, since the script export
 *  binds the object to it: `Rotor v2.stl` cannot be `Rotor v2`. */
function idFromFileName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '');
  return stem.replace(/\W/g, '_').replace(/^(?=\d)/, 'm_').toLowerCase() || 'mesh';
}

/** `24.5 × 12 × 8 mm`, for a size that has to be recognised at a glance. */
function sizeInMillimetres(extent: number[], scale: number): string {
  return `${extent.map((e) => +(e * scale * 1000).toPrecision(4)).join(' × ')} mm`;
}

/**
 * Say what an import found, once, at the moment it happened.
 *
 * The tree row carries this too, but a row is somewhere you look and an
 * import is something you did. An open mesh computes a field that is wrong in
 * sign as well as in size, and learning that later, from an icon, is learning
 * it after the number has been believed.
 */
function reportMeshImport(name: string, status: MeshStatus, faces?: number): void {
  const fault = meshFault(status);
  if (fault) {
    vscode.window.showWarningMessage(
      `Magpylib Studio: ${name} is ${fault}. It is in the scene and magpylib ` +
        `computes a field for it, but that field is not to be trusted — the ` +
        `inside-outside test it rests on needs a closed body.`,
    );
    return;
  }
  vscode.window.setStatusBarMessage(
    status.flipped
      ? `Magpylib Studio: ${name} imported — ${faces ?? '?'} faces, ` +
          `${status.flipped} turned around to point outward`
      : `Magpylib Studio: ${name} imported — ${faces ?? '?'} faces, closed`,
    5000,
  );
}

/**
 * The poses of an evenly spaced ramp, arithmetic-for-arithmetic as numpy's
 * `linspace` computes them.
 *
 * `to_script` writes such a path as the one call that makes it, but only
 * where the call reproduces it *exactly* — a path that merely looks evenly
 * spaced is not one, and the document, not the script, is what the scene is
 * built from. So the spacing has to be derived the way numpy derives it,
 * down to which multiply happens first. `(c * i) / steps` is the obvious
 * spelling and disagrees in the last bit for almost every displacement that
 * is not a clean 1 — which is why the export was quietly writing a hundred
 * triples out in full for anything but the prompt's own default.
 *
 * numpy divides first and scales by the index, except where any component of
 * that step is zero, where it scales the total by the index fraction instead
 * (`any_step_zero`, numpy/_core/function_base.py). Both branches are here
 * because both are ordinary: `0, 0, 1` takes the second one.
 */
export function evenRamp(total: number[], steps: number): number[][] {
  const step = total.map((c) => c / steps);
  const anyStepZero = step.some((s) => s === 0);
  const poses = Array.from({ length: steps + 1 }, (_, i) =>
    anyStepZero ? total.map((c) => (i / steps) * c) : step.map((s) => s * i),
  );
  poses[steps] = [...total]; // numpy assigns the endpoint rather than deriving it
  return poses;
}

/**
 * The poses of a ramp of increments: `i * step`, which is exactly what the
 * `np.arange(n)[:, None] * step` the script writes computes.
 *
 * Unlike an even spread this needs no care to stay reproducible — one multiply
 * by a whole number is the same multiply in every language that has doubles,
 * so what is typed here is what numpy makes of it, bit for bit.
 */
export function incrementRamp(step: number[], steps: number): number[][] {
  return Array.from({ length: steps + 1 }, (_, i) => step.map((s) => s * i));
}

/** How a transform is applied: once, or spread over an animation path. */
type PathChoice =
  | { kind: 'scalar' }
  | { kind: 'linspace' | 'arange'; steps: number }
  | { kind: 'custom' }
  | { kind: 'formula' };

/**
 * Ask whether a transform applies once or builds an animation path, and if a
 * path, which way of describing one. For a path, also the number of steps and
 * magpylib's `start` (passed through verbatim: "auto" appends the new path, an
 * index applies from there).
 *
 * The two even kinds make the same sort of ramp from opposite ends — a total
 * to divide up, or an increment to repeat — and which one was used is not a
 * formatting preference: the script says whichever it was, because a quarter
 * of the time both calls describe the identical points and only the choice
 * tells them apart.
 */
async function askPathKind(title: string): Promise<PathChoice | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      // `how`, not `kind`: a QuickPickItem's own `kind` is what makes it a
      // separator, and setting it to a string of ours makes the item vanish.
      { label: 'Scalar', detail: 'apply once', how: 'scalar' as const },
      {
        label: 'Path — even spread',
        detail: 'a total, divided into equal steps · np.linspace',
        how: 'linspace' as const,
      },
      {
        label: 'Path — by increment',
        detail: 'one step, repeated · np.arange',
        how: 'arange' as const,
      },
      {
        label: 'Path — custom points',
        detail: 'every step typed out, in an editor',
        how: 'custom' as const,
      },
      {
        label: 'Path — formula',
        detail: 'a curve in t, sampled · stays parametric, count included',
        how: 'formula' as const,
      },
    ],
    { placeHolder: `${title}: applied how?` },
  );
  if (!pick) {
    return undefined;
  }
  if (pick.how === 'scalar' || pick.how === 'custom' || pick.how === 'formula') {
    return { kind: pick.how };
  }
  const stepText = await vscode.window.showInputBox({
    prompt: 'Number of path steps',
    value: '20',
    validateInput: (v) =>
      Number.isInteger(Number(v)) && Number(v) >= 1
        ? undefined
        : 'A whole number of steps, 1 or more',
  });
  return stepText ? { kind: pick.how, steps: Number(stepText) } : undefined;
}

/** A run of points stated as the curve that draws it: what the engine calls
 *  a sampled value, and what `expressions.SAMPLED` names in the document. */
interface SampledRun {
  sampled: { count: number | string; of: (number | string)[] | number | string };
}

/**
 * Ask for a run of points as a formula in `t` rather than as the points.
 *
 * Two prompts and an editor: how many points, then one line per axis. The
 * count comes first and on its own because it is the one part that is not a
 * formula in `t` — and because it may be an expression itself, which is the
 * whole reason this exists rather than a list of typed-out rows.
 *
 * The axes go in the same editor as typed-out points, for the same reason:
 * three formulas with `cos` in them do not fit an input box, and an editor
 * brings paste and undo. One line per axis instead of one line per point,
 * which the header says and the count check enforces.
 */
async function askSampledRun(
  context: vscode.ExtensionContext,
  name: string,
  subject: string,
  header: string[],
  example: string[],
): Promise<SampledRun | undefined> {
  const count = await vscode.window.showInputBox({
    prompt: 'Number of points — a number, or an expression over the variables',
    value: '41',
    validateInput: (v) => {
      const terms = parseTerms(v);
      if (!terms || terms.length !== 1) {
        return 'One number or expression, e.g. 41 or per_turn * turns + 1';
      }
      const only = terms[0];
      return typeof only === 'number' && (!Number.isInteger(only) || only < 2)
        ? 'At least 2 points, and a whole number of them'
        : undefined;
    },
  });
  if (count === undefined || !count.trim()) {
    return undefined;
  }
  const axes = await askPointRows(context, {
    name,
    subject,
    noun: 'lines, one an axis',
    header,
    example,
    // One formula to a line, so a line is one value however long it reads:
    // `radius * cos(tau * turns * t)` is a single term, and commas inside
    // its brackets are the function's, not the row's.
    width: 1,
    min: example.length,
    max: example.length,
  });
  if (!axes) {
    return undefined;
  }
  await closePointEditor(context, name);
  const of = axes.map(([term]) => term);
  return { sampled: { count: parseTerms(count)![0], of: of.length === 1 ? of[0] : of } };
}

/** What a document of typed-out points is being collected for. */
interface PointRowsRequest {
  /** File basename, so the tab has a name and can be found again to close. */
  name: string;
  /** How a wrong count names the thing: "A path", "A current polyline". */
  subject: string;
  /** What one row is: "steps", "vertices". */
  noun: string;
  /** The explanatory comment block; the count rule is appended to it. */
  header: string[];
  /** Starter rows, which for a new object are its defaults. */
  example: string[];
  /** Values to a row: 3 for a point, 1 for an angle. */
  width: number;
  min: number;
  max?: number;
  /** What a row's numbers measure, read in the unit the scene shows it in:
   *  "length", "angle". Without it they are read as they are. */
  unit?: string;
}

/** "at least two vertices", "exactly four vertices" — said once, so the
 *  header that promises it and the save that enforces it cannot disagree. */
function rowRule(request: PointRowsRequest): string {
  const { min, max, noun } = request;
  return `${min === max ? 'exactly' : 'at least'} ${min} ${noun}`;
}

/**
 * Collect a list of points by opening it as a document, one to a line.
 *
 * A quick-pick chain cannot ask for twenty points and an input box cannot hold
 * them legibly. An editor can, and it brings undo, paste and multiple cursors
 * with it — which is most of what typing out a list of points by hand needs.
 * The Inspector reached the same conclusion for editing an existing one; this
 * is the same idea for the ones that do not exist yet.
 *
 * It is backed by a real file in the extension's storage rather than by an
 * untitled buffer, because saving an untitled buffer opens a file dialog: the
 * gesture that means "apply this" would ask the user where to put a file they
 * never asked to have. Here Ctrl+S applies and closing cancels, which is what
 * the header says it does.
 *
 * A line that does not parse is not a reason to throw the rest away — it is
 * reported by number and the document stays open, so saving again after a fix
 * is the whole correction.
 */
/** Where the scratch document for one of these lives. One function, so the
 *  editor closed afterwards is exactly the one that was opened. */
function pointsUri(context: vscode.ExtensionContext, name: string): vscode.Uri {
  const dir = context.storageUri ?? context.globalStorageUri;
  return vscode.Uri.joinPath(dir, `${name}.points.txt`);
}

async function askPointRows(
  context: vscode.ExtensionContext,
  request: PointRowsRequest,
): Promise<(number | string)[][] | undefined> {
  const { name, width, min, max } = request;
  await vscode.workspace.fs.createDirectory(
    context.storageUri ?? context.globalStorageUri,
  );
  const uri = pointsUri(context, name);
  // The count rule and the save/cancel promise are the helper's own, so it
  // writes them: a caller repeating them is a caller that can contradict them.
  const header = [
    ...request.header,
    `${request.subject} needs ${rowRule(request)}.`,
    'Save to apply. Close without saving to cancel.',
  ];
  const template = [
    ...header.map((line) => (line ? `# ${line}` : '#')),
    '',
    ...request.example,
    '',
  ];
  await vscode.workspace.fs.writeFile(uri, Buffer.from(template.join('\n'), 'utf8'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
    preview: false,
  });

  return new Promise((resolve) => {
    const listeners: vscode.Disposable[] = [];
    const finish = (points: (number | string)[][] | undefined) => {
      listeners.forEach((l) => l.dispose());
      resolve(points);
    };
    listeners.push(
      vscode.workspace.onDidSaveTextDocument(async (saved) => {
        if (saved.uri.toString() !== uri.toString()) {
          return;
        }
        const points: (number | string)[][] = [];
        const shape = (line: string) =>
          `is not ${width} value${width === 1 ? '' : 's'} — "${line}"`;
        for (const [n, raw] of saved.getText().split('\n').entries()) {
          const line = raw.split('#')[0].trim();
          if (!line) {
            continue;
          }
          const point = request.unit
            ? await readTerms(context, line, width, request.unit, shape(line))
            : (parseVector(line, width) ?? shape(line));
          if (typeof point === 'string') {
            vscode.window.showErrorMessage(
              `Magpylib Studio: line ${n + 1} ${point.startsWith('is not') ? point : `— ${point}`}. ` +
                'Fix it and save again.',
            );
            return; // stay open: the document is the thing being corrected
          }
          points.push(point);
        }
        if (points.length < min || (max !== undefined && points.length > max)) {
          vscode.window.showErrorMessage(
            `Magpylib Studio: ${request.subject.toLowerCase()} needs ` +
              `${rowRule(request)}; there ${points.length === 1 ? 'is' : 'are'} ` +
              `${points.length}. Fix it and save again.`,
          );
          return;
        }
        finish(points);
      }),
      vscode.workspace.onDidCloseTextDocument((closed) => {
        if (closed.uri.toString() === uri.toString()) {
          finish(undefined); // closed without saving: cancelled
        }
      }),
    );
  });
}

/** Close the scratch document points were typed into, once they are read.
 *
 * Matched on the whole uri, not on the end of it: `cube-move.points.txt` is
 * the tail of `mycube-move.points.txt`, so a suffix test closed a second
 * object's editor along with the first — which cancels the prompt still
 * waiting on it and takes whatever was typed there with it.
 */
async function closePointEditor(context: vscode.ExtensionContext, name: string) {
  const wanted = pointsUri(context, name).toString();
  const open = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === wanted,
    );
  await vscode.window.tabGroups.close(open);
}

/**
 * Where a new path goes relative to the one the object already has —
 * magpylib's `start`, asked as the question a person actually has.
 *
 * There are two of those, and `auto` is neither. Since a path built here
 * carries its own first pose — the one where nothing has moved yet — `auto`
 * appends that pose after the one the object is already at, and every
 * animation begins on a repeated frame: 7 poses where 6 were meant, or 10
 * where 9 were. It was the default, the first row and one keystroke away,
 * and the way out of it was to pick "index…" and then type the 0 that should
 * have been on offer to begin with.
 *
 * So the two real answers are named and `auto` is not among them. It stays
 * the engine's default, because it is right for the paths that come from
 * elsewhere: a hand-written script's path has no leading pose to collide
 * with, and appending is exactly what it means.
 *
 * Returns {start: index}, or undefined if the user escaped.
 */
async function askStart(
  context: vscode.ExtensionContext,
  objectId: string,
): Promise<{ start: number } | undefined> {
  const { path_length: length } = (await (await getEngine(context)).request(
    'get_transform',
    { object_id: objectId },
  )) as { path_length: number };
  // Nothing to ask yet: with no path behind it, "start over" and "continue"
  // are the same instruction, and offering the choice would be inventing a
  // decision to make the user take.
  if (length <= 1) {
    return { start: 0 };
  }
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'Start over',
        detail: `the new path replaces the ${length} poses this object has`,
        index: 0,
        custom: false,
      },
      {
        label: 'Continue',
        detail: `carries on from the last of those ${length}, without repeating it`,
        index: -1,
        custom: false,
      },
      {
        label: 'Index…',
        detail: 'apply from some other path index instead',
        index: 0,
        custom: true,
      },
    ],
    { placeHolder: 'Where does this path start?' },
  );
  if (!pick) {
    return undefined;
  }
  if (!pick.custom) {
    return { start: pick.index };
  }
  const indexText = await vscode.window.showInputBox({
    prompt: 'start — path index (negative counts from the end)',
    value: '0',
    validateInput: (v) => (Number.isInteger(Number(v)) ? undefined : 'A whole number'),
  });
  return indexText === undefined || indexText === ''
    ? undefined
    : { start: Number(indexText) };
}

/** Calls whose params carry values a user typed, so may name new variables. */
const MUTATING_WITH_VALUES = new Set([
  'set_param',
  'set_transform',
  'move',
  'rotate',
  'add_object',
  'duplicate_around',
  // a step's own values are typed the same way, so naming a variable in one
  // has to create it the same way too
  'edit_event',
]);

/** What the Add Object prompts say about a parameter after its unit, which
 *  the engine says (`get_units`). A parameter asked for in an editor is not
 *  here: its header says the same thing with room to say it. */
const PARAM_HINTS: Record<string, string> = {
  polarization: ', as Jx, Jy, Jz',
  dimension: ' — Cuboid a,b,c · Cylinder d,h · Segment r1,r2,h,phi1,phi2',
  moment: ', as mx, my, mz',
};

/** The units of the parameters no unit setting covers, said as they are. */
const PARAM_SI: Record<string, string> = { moment: 'A·m²', magnetization: 'A/m' };

/** A length unit in words, for an editor's header: "x, y, z in millimetres". */
const LENGTH_WORDS: Record<string, string> = {
  m: 'metres',
  cm: 'centimetres',
  mm: 'millimetres',
  µm: 'micrometres',
};

/** Rotation axis: a named axis or a free vector. */
async function askRotationAxis(): Promise<string | (number | string)[] | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'x', detail: 'rotate about the x axis' },
      { label: 'y', detail: 'rotate about the y axis' },
      { label: 'z', detail: 'rotate about the z axis' },
      { label: 'Custom vector…', detail: 'any direction, e.g. 1, 1, 0' },
    ],
    { placeHolder: 'Rotation axis' },
  );
  if (!pick) {
    return undefined;
  }
  if (!pick.label.startsWith('Custom')) {
    return pick.label;
  }
  const text = await vscode.window.showInputBox({
    prompt: 'Axis direction as x, y, z',
    value: '1, 1, 0',
    validateInput: (v) =>
      parseVector(v, 3)?.some((n) => n !== 0)
        ? undefined
        : 'Three numbers, not all zero',
  });
  return text ? parseVector(text, 3) : undefined;
}

/** Rotation anchor: spin in place, orbit the origin, or orbit a point. */
async function askRotationAnchor(context: vscode.ExtensionContext): Promise<
  { value: number | (number | string)[] | undefined } | undefined
> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Itself', detail: 'spin in place, position unchanged' },
      { label: 'Scene origin', detail: 'orbit (0, 0, 0)' },
      { label: 'Custom point…', detail: 'orbit any point' },
    ],
    { placeHolder: 'Rotate around…' },
  );
  if (!pick) {
    return undefined;
  }
  if (pick.label === 'Itself') {
    return { value: undefined };
  }
  if (pick.label === 'Scene origin') {
    return { value: 0 };
  }
  const length = (await unitView(context)).shown.length;
  const anchor = await askTerms(
    context,
    { prompt: `Anchor point as x, y, z${inUnits(length)}`, value: '0, 0, 0' },
    3,
    length,
    'Three numbers, e.g. 0, 0, 1',
  );
  return anchor ? { value: anchor } : undefined;
}

/**
 * One typed field -> a document value: a number where it is one, otherwise an
 * expression over the scene's variables. The `=` marker the document uses is
 * added here, so users type `gap*2` and never learn the notation.
 */
function asDocumentValue(text: string): number | string {
  const trimmed = text.trim();
  const asNumber = Number(trimmed);
  return Number.isFinite(asNumber) && trimmed !== '' ? asNumber : `=${trimmed}`;
}

/**
 * The terms typed into one box, e.g. `0, 0, gap`. Bracket characters are
 * stripped, and terms are split at commas outside parentheses, so `0, 0,
 * max(a, b)` is three and `radius * cos(tau * t)` is one. With no comma,
 * spaces separate only numbers -- `1 2 3`, as it always did -- because a
 * space is also what sits inside `gap * 2` and between `5` and `mm`.
 */
export function splitTerms(text: string): string[] | undefined {
  const terms: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text.replace(/[[\]]/g, ' ')) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return undefined;
    if (depth === 0 && ch === ',') {
      terms.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (depth !== 0) return undefined;
  terms.push(current.trim());
  const pieces = terms.length === 1 ? terms[0].split(/\s+/).filter(Boolean) : [];
  if (pieces.length > 1 && pieces.every((piece) => Number.isFinite(Number(piece)))) {
    return pieces;
  }
  const kept = terms.filter(Boolean);
  return kept.length ? kept : undefined;
}

/** A box's terms as document values, where no unit applies: numbers, and
 *  expressions marked with `=`. */
function parseTerms(text: string): (number | string)[] | undefined {
  return splitTerms(text)?.map(asDocumentValue);
}

/** How a value of one kind is shown and typed in the scene: a length in mm
 *  at scale 1000, say (`get_units`). */
type ShownUnit = Shown & { unit: string };

/** The units the scene is shown in: each kind's, and given an object type,
 *  each of its parameters' -- a list where the components differ. */
interface UnitView {
  model_unit: string;
  field_unit: string;
  shown: Record<string, ShownUnit>;
  params?: Record<string, ShownUnit | ShownUnit[]>;
}

async function unitView(context: vscode.ExtensionContext, type?: string): Promise<UnitView> {
  return (await getEngine(context)).request<UnitView>('get_units', type ? { type } : {});
}

/** The unit a box reads a bare number in, for its prompt: " (mm)", " (mm, °)"
 *  for a segment's dimension, or `fallback` where no setting covers it. */
function inUnits(shown?: ShownUnit | ShownUnit[], fallback = ''): string {
  const all = Array.isArray(shown) ? shown : shown ? [shown] : [];
  const symbols = [...new Set(all.map((s) => s.symbol).filter(Boolean))];
  const said = symbols.join(', ') || fallback;
  return said ? ` (${said})` : '';
}

/** Document values as a box shows them, in the unit it reads them in: 0.0234
 *  is "23.4" in mm. An expression is as written, without its `=`. */
function shownText(values: unknown[], shown?: ShownUnit | ShownUnit[]): string {
  return values
    .map((value, i) => {
      const unit = Array.isArray(shown) ? shown[i] : shown;
      if (typeof value === 'number') {
        return String(Number((value * (unit?.scale ?? 1)).toPrecision(12)));
      }
      return typeof value === 'string' && value.startsWith('=') ? value.slice(1) : String(value);
    })
    .join(', ');
}

/**
 * The terms typed into a box as document values, read by the engine
 * (`read_values`): a bare number in the unit the scene shows `unit` in,
 * `5 mm` in its own, anything else an expression -- so `0, 0, 5` is 5 mm in
 * a scene shown in mm, exactly. `count` terms, or `shape`, the box's own
 * complaint; a unit that is not one of `unit`'s is the engine's.
 */
async function readTerms(
  context: vscode.ExtensionContext,
  text: string,
  count: number | undefined,
  unit: ShownUnit | ShownUnit[] | string | undefined,
  shape: string,
): Promise<(number | string)[] | string> {
  const terms = splitTerms(text);
  if (!terms || (count !== undefined && terms.length !== count)) {
    return shape;
  }
  const kind = Array.isArray(unit)
    ? unit.map((u) => u.unit)
    : typeof unit === 'string'
      ? unit
      : (unit?.unit ?? null);
  const read = await (await getEngine(context)).request<{
    ok: boolean;
    values?: (number | string)[];
    error?: string;
  }>('read_values', { terms, unit: kind });
  return read.ok ? read.values! : read.error!;
}

/**
 * An input box for `count` terms in a unit: checked by the engine as it is
 * typed, and once accepted, the values it read. Undefined if escaped. `check`
 * refuses what reads but does not fit -- an axis of zeros, say.
 */
async function askTerms(
  context: vscode.ExtensionContext,
  options: vscode.InputBoxOptions,
  count: number | undefined,
  unit: ShownUnit | ShownUnit[] | string | undefined,
  shape: string,
  check?: (values: (number | string)[]) => string | undefined,
): Promise<(number | string)[] | undefined> {
  const read = async (text: string) => {
    const values = await readTerms(context, text, count, unit, shape);
    return typeof values === 'string' ? values : (check?.(values) ?? values);
  };
  const text = await vscode.window.showInputBox({
    ...options,
    validateInput: async (v) => {
      const values = await read(v);
      return typeof values === 'string' ? values : undefined;
    },
  });
  if (text === undefined) {
    return undefined;
  }
  const values = await read(text);
  return typeof values === 'string' ? undefined : values;
}

/** Parse "1, 2, gap" into `count` numbers-or-expressions, else undefined. */
function parseVector(text: string, count: number): (number | string)[] | undefined {
  const parts = parseTerms(text);
  return parts?.length === count ? parts : undefined;
}

/** Repo root in the dev layout (vscode-extension/ inside the repo). */
function repoRoot(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, '..');
}

let cachedPython: string | undefined;

/**
 * Run a command and wait for it, without stopping everything else.
 *
 * Every one of these used to be `spawnSync`. The extension host is one
 * thread shared by every extension in the window, so a synchronous `pip
 * install` froze all of them — Git, the language servers, the notification
 * this very function reports progress into — for as long as the install
 * took, which on the "Install the Engine" path is the first minute a new
 * user spends with the extension.
 */
function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args);
    } catch (err) {
      // spawn throws synchronously for an invalid command, rather than
      // emitting 'error' — a missing interpreter must not take the host down.
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        stdout,
        stderr,
        error: timedOut ? `timed out after ${timeoutMs / 1000} s` : undefined,
      });
    });
  });
}

/** First interpreter that can actually import the engine. A workspace .venv
 *  without magpylib-studio installed must not shadow a working one. */
async function findPython(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  if (cachedPython) {
    return cachedPython;
  }
  const configured = vscode.workspace
    .getConfiguration('magpylib-studio')
    .get<string>('pythonPath');
  const candidates: string[] = configured ? [configured] : [];
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const venvs = folders.map((folder) => path.join(folder, '.venv'));
  // The repo's own, for a development window working in the repo: one opened
  // on a folder elsewhere is a machine without it, as a user's is.
  const root = repoRoot(context);
  const inRepo = (folder: string) => {
    const relative = path.relative(root, folder);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  if (folders.some(inRepo)) {
    venvs.push(path.join(root, '.venv'));
  }
  for (const venv of venvs) {
    for (const python of [
      path.join(venv, 'bin', 'python'),
      path.join(venv, 'Scripts', 'python.exe'),
    ]) {
      if (fs.existsSync(python)) {
        candidates.push(python);
      }
    }
  }
  candidates.push('python3');
  for (const python of candidates) {
    const probe = await run(python, ['-c', 'import magpylib_studio'], 20000);
    if (probe.ok) {
      cachedPython = python;
      return python;
    }
    engineOutput?.appendLine(
      `[skipping ${python}: cannot import magpylib_studio]`,
    );
  }
  return undefined;
}

/** Last resort only, when neither ms-python.python nor uv found anything
 *  usable: a python3 command able to actually bootstrap a venv, resolved
 *  the way a real terminal would rather than however GUI-launched VS
 *  Code's own PATH happens to look. On macOS/Linux a GUI launch does not
 *  source ~/.zprofile or
 *  ~/.zshrc, so a plain PATH lookup finds macOS's bundled /usr/bin/python3
 *  (3.9, an SSL stack too old to fetch anything from PyPI) instead of
 *  whatever the user actually has via Homebrew/pyenv/etc. — a login shell
 *  resolves it the way Terminal.app would. Windows does not have that
 *  failure mode (its PATH is a persistent env var GUI processes inherit
 *  correctly) but frequently has no `python3` at all, only `python` or the
 *  `py` launcher, so this branches instead of shelling out to a login
 *  shell that would not help. Returns a command *prefix* (`py` needs `-3`
 *  before anything else) rather than a single path. */
async function resolvePythonCommand(): Promise<string[]> {
  if (process.platform === 'win32') {
    for (const candidate of [['python'], ['py', '-3']]) {
      const probe = await run(candidate[0], [...candidate.slice(1), '--version'], 10000);
      if (probe.ok) {
        return candidate;
      }
    }
    return ['python'];
  }
  const shell = process.env.SHELL || '/bin/zsh';
  const result = await run(shell, ['-lc', 'command -v python3'], 10000);
  const resolved = result.ok ? result.stdout.trim() : '';
  return [resolved || 'python3'];
}

/** Kept in sync with pyproject.toml's `requires-python`. A found interpreter
 *  that does not meet this is not a maybe — pip will refuse it with a
 *  message ("no matching distribution") that reads like a network failure,
 *  not a version one, so this is checked explicitly instead of trusting
 *  pip's error text to explain itself. */
const PYTHON_FLOOR = '3.11';

function pythonInstallTip(): string {
  switch (process.platform) {
    case 'darwin':
      return '"brew install python3", or python.org';
    case 'win32':
      return 'python.org, or the Microsoft Store';
    default:
      return 'your package manager (e.g. "apt install python3.11"), or python.org';
  }
}

async function checkPythonVersion(
  pythonExe: string,
): Promise<{ ok: boolean; version?: string }> {
  const probe = await run(
    pythonExe,
    ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
    10000,
  );
  if (!probe.ok) {
    return { ok: false };
  }
  const version = probe.stdout.trim();
  const [major, minor] = version.split('.').map(Number);
  const [floorMajor, floorMinor] = PYTHON_FLOOR.split('.').map(Number);
  const ok = major > floorMajor || (major === floorMajor && minor >= floorMinor);
  return { ok, version };
}

/** The "no interpreter found" error's one-click fix, tried in order:
 *
 *  1. Whatever ms-python.python already has resolved for this workspace
 *     (the same interpreter its status bar shows) — that extension already
 *     solved cross-platform interpreter discovery; reinventing it with our
 *     own PATH probing is exactly how this feature's first version shipped
 *     with a bug (bare `python3` resolving to whatever a GUI-launched VS
 *     Code's minimal PATH happens to contain).
 *  2. `uv`, if installed — it fetches a matching Python itself on demand,
 *     so unlike PATH probing it does not depend on anything already being
 *     installed, and it is what this very repo's own setup already uses.
 *  3. A login-shell-resolved `python3` (or `python`/`py` on Windows) as a
 *     last resort, version-checked before use rather than trusted blindly —
 *     a fresh machine can genuinely have nothing newer than an OS-bundled
 *     Python outside of tool-managed venvs, which is a real state to
 *     report clearly rather than let pip's own error text stand in for.
 *
 *  getEngine() has ~40 call sites, many of which can fire near-simultaneously
 *  on activation, so more than one "no interpreter" dialog can be on screen
 *  at once — this guards against two clicks racing two installs into the
 *  same venv by sharing one in-flight run instead of starting a second. */
let installEnginePromise: Promise<void> | undefined;
async function installEngine(): Promise<void> {
  if (installEnginePromise) {
    return installEnginePromise;
  }
  installEnginePromise = installEngineNow().finally(() => {
    installEnginePromise = undefined;
  });
  return installEnginePromise;
}

async function installEngineNow(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage(
      'Magpylib Studio: open a folder first, so the engine has somewhere ' +
        'to install to.',
    );
    return;
  }

  let pythonExe: string | undefined;
  try {
    const pythonApi = await PythonExtension.api();
    const active = pythonApi.environments.getActiveEnvironmentPath(folder.uri);
    const resolved = await pythonApi.environments.resolveEnvironment(active);
    const candidate = resolved?.executable.uri?.fsPath;
    if (candidate && (await checkPythonVersion(candidate)).ok) {
      pythonExe = candidate;
    }
  } catch {
    // ms-python.python not installed, or nothing suitable resolved — fall through
  }
  const usingExisting = Boolean(pythonExe);

  // Installing into an interpreter someone else chose is not the same act as
  // making a .venv of our own: it may be a system Python, and "install the
  // engine" is not consent to change one. Name it and ask.
  if (usingExisting) {
    const go = await vscode.window.showInformationMessage(
      `Magpylib Studio: install the engine into ${pythonExe}?`,
      {
        modal: true,
        detail:
          'That is the interpreter the Python extension has selected for ' +
          'this workspace. "Use a .venv instead" leaves it untouched and ' +
          'makes one in the workspace folder.',
      },
      'Install There',
      'Use a .venv instead',
    );
    if (!go) {
      return;
    }
    if (go === 'Use a .venv instead') {
      pythonExe = undefined;
    }
  }
  const intoSelected = Boolean(pythonExe);

  const venvDir = path.join(folder.uri.fsPath, '.venv');
  const venvPython =
    process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python');
  pythonExe ??= venvPython;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Magpylib Studio: installing the engine',
        cancellable: false,
      },
      async (progress) => {
        const hasUv =
          !intoSelected && (await run('uv', ['--version'], 10000)).ok;
        if (hasUv) {
          progress.report({ message: `fetching Python ${PYTHON_FLOOR} via uv…` });
          const venvResult = await run(
            'uv',
            // --seed: uv venv omits pip by default (it expects `uv pip`
            // instead), which would otherwise make the shared `python -m
            // pip install` step below fail with "No module named pip".
            ['venv', '--python', PYTHON_FLOOR, '--seed', venvDir],
            120000,
          );
          if (!venvResult.ok) {
            throw new Error(
              venvResult.stderr.trim() || venvResult.error || 'uv venv failed',
            );
          }
        } else if (!intoSelected) {
          progress.report({ message: 'creating .venv…' });
          const [pythonCmd, ...pythonPrefixArgs] = await resolvePythonCommand();
          const venvResult = await run(
            pythonCmd,
            [...pythonPrefixArgs, '-m', 'venv', venvDir],
            60000,
          );
          if (venvResult.error?.includes('ENOENT')) {
            // nothing to run: no Python at all, as on a new machine
            throw new Error(
              `no Python found. Install Python ${PYTHON_FLOOR} or newer ` +
                `(${pythonInstallTip()}) and try again — or install uv ` +
                '(astral.sh/uv), which this button will use automatically.',
            );
          }
          if (!venvResult.ok) {
            throw new Error(
              venvResult.stderr.trim() ||
                venvResult.error ||
                'could not create a virtual environment',
            );
          }
          const check = await checkPythonVersion(venvPython);
          if (!check.ok) {
            throw new Error(
              `found Python ${check.version ?? '(unknown)'}, but magpylib-studio ` +
                `needs ${PYTHON_FLOOR} or newer. Install a newer Python ` +
                `(${pythonInstallTip()}) and try again — or install uv ` +
                '(astral.sh/uv), which this button will use automatically.',
            );
          }
        }
        progress.report({ message: 'pip install magpylib-studio…' });
        const pipResult = await run(
          pythonExe!,
          // --upgrade: an engine too old to serve is installed already
          ['-m', 'pip', 'install', '--upgrade', 'magpylib-studio'],
          180000,
        );
        if (!pipResult.ok) {
          throw new Error(
            pipResult.stderr.trim() || pipResult.error || 'pip install failed',
          );
        }
      },
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Magpylib Studio: could not install the engine — ` +
        `${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  await vscode.workspace
    .getConfiguration('magpylib-studio')
    .update('pythonPath', pythonExe, vscode.ConfigurationTarget.Workspace);
  cachedPython = undefined; // re-probe: the freshly configured path wins next
  refusedEngine = undefined;
  refreshSurfaces();

  vscode.window
    .showInformationMessage('Magpylib Studio: engine installed.', 'Open Scene View')
    .then((choice) => {
      if (choice) {
        void vscode.commands.executeCommand('magpylib-studio.openStudio');
      }
    });
}

/** A way to the engine for one scene: each request carries its session. */
export interface SceneEngine {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** Where requests go with no scene open: a scene that is never shown nor
 *  saved, so that the side bar reads an empty one rather than an error, and
 *  a list of examples needs no tab. Edits are never sent here: see
 *  `ensureFrontScene`. */
const scratch = new SceneDocument(vscode.Uri.parse('magpylib-studio:/no-scene'), () => {});

/** The engine as seen by `doc`: its session opened first if this engine has
 *  not opened it yet -- the first request, or the first since an engine
 *  restarted, which takes every scene with it and is given each one back
 *  from the last document it settled on. */
function engineFor(context: vscode.ExtensionContext, doc: SceneDocument): SceneEngine {
  return {
    request: async <T = unknown>(method: string, params?: Record<string, unknown>) => {
      const client = await getRawEngine(context);
      await openSession(client, doc);
      return client.request<T>(method, params, doc.session);
    },
  };
}

/** The scene a running command acts on: the row it was run from, or the
 *  scene in front when it started -- none, when no scene was open. Kept
 *  through every await of the command, so that one asking questions first
 *  ends in the scene it began in, whatever came in front meanwhile. A scene
 *  the command itself opens or brings in front becomes its scene (see the
 *  onDidChangeFront listener); one the person clicks meanwhile does not. */
const commandScene = new AsyncLocalStorage<{ scene: SceneDocument | undefined }>();

/** Put `doc` in front, and make it the running command's scene: a scene the
 *  command opened, or the row it acts on. Said outright rather than left to
 *  the front changing, which it does not when VS Code put the tab in front
 *  first. */
function actOn(doc: SceneDocument): void {
  bringToFront(doc);
  const box = commandScene.getStore();
  if (box) {
    box.scene = doc;
  }
}

/** The scene to act on now: the running command's, else the one in front.
 *  A command whose scene was closed under it stops there. */
function actingScene(): SceneDocument | undefined {
  const box = commandScene.getStore();
  if (!box) {
    return frontScene();
  }
  if (box.scene && !openScenes().includes(box.scene)) {
    throw new Error(`${box.scene.name} was closed meanwhile, so nothing was done`);
  }
  return box.scene;
}

/** The open scene keyed `key`, as a side view names the scene it was drawn
 *  for; with no key, the scene in front. A key whose scene has closed names
 *  nothing to act on. */
function sceneForKey(key: string | undefined): SceneDocument | undefined {
  if (key === undefined) {
    return frontScene();
  }
  const doc = openScenes().find((open) => open.key === key);
  if (!doc) {
    throw new Error('the scene this view was showing has been closed');
  }
  return doc;
}

/** Run `work` acting on the scene keyed `key` (see sceneForKey), as a command
 *  acts on the scene it began in. */
function inScene<T>(key: string | undefined, work: () => T): T {
  return commandScene.run({ scene: sceneForKey(key) }, work);
}

/** The engine for the scene acted on: a running command's, else the scene in
 *  front, as every view of one scene speaks to it. */
function getEngine(context: vscode.ExtensionContext): Promise<SceneEngine> {
  try {
    return Promise.resolve(engineFor(context, actingScene() ?? scratch));
  } catch (err) {
    return Promise.reject(err);
  }
}

/** Scenes go back into a restarted engine one at a time, the one going back
 *  named on disk while it does: a scene whose restore stops the engine too is
 *  known when the next one starts, and skipped (plans/several-scenes.md §4). */
let restoreChain: Promise<void> = Promise.resolve();

function restoringMarker(): vscode.Uri | undefined {
  return recoveryDir && vscode.Uri.joinPath(recoveryDir, 'restoring');
}

function openSession(client: EngineClient, doc: SceneDocument): Promise<void> {
  if (doc.engine === client && doc.opening) {
    return doc.opening;
  }
  const again = doc.engine !== undefined && doc !== scratch;
  doc.session = again ? newSessionName() : doc.session; // a name is used once, in any engine
  doc.engine = client;
  if (!again) {
    doc.opening = loadSession(client, doc, false);
  } else {
    const restore = () => restoreSession(client, doc);
    doc.opening = restoreChain = restoreChain.then(restore, restore);
  }
  return doc.opening;
}

/** Back into a restarted engine, named on disk while it goes. The name stays
 *  when the engine dies on it, and is read when the next one starts. */
async function restoreSession(client: EngineClient, doc: SceneDocument): Promise<void> {
  if (!client.isRunning) {
    throw new Error('the engine stopped');
  }
  const marker = restoringMarker();
  if (marker && !doc.lost) {
    await vscode.workspace.fs.createDirectory(recoveryDir!);
    await vscode.workspace.fs.writeFile(marker, Buffer.from(doc.key, 'utf8'));
  }
  await loadSession(client, doc, true);
  if (marker) {
    await vscode.workspace.fs.delete(marker).then(undefined, () => {});
  }
}

async function loadSession(client: EngineClient, doc: SceneDocument, again: boolean) {
  // A lost scene opens empty: putting it back stopped the engine before.
  const scene = doc.lost ? undefined : doc.lastDocument;
  const example = doc.lost || scene !== undefined ? undefined : doc.example;
  const result = await client.request<{ ok: boolean; error?: string }>('open_session', {
    session: doc.session,
    ...(scene !== undefined ? { scene } : {}),
    ...(example !== undefined ? { example } : {}),
    base_dir: doc.baseDir ?? null,
  });
  if (!result.ok) {
    // Opened empty, so the tab and the side bar work, and marked: a scene
    // that could not be read is never saved, or the empty one would go over
    // the file it could not read.
    doc.problem = result.error ?? 'unreadable';
    doc.lastDocument = undefined;
    doc.example = undefined;
    await client.request('open_session', { session: doc.session, base_dir: doc.baseDir ?? null });
    void vscode.window.showErrorMessage(
      `Magpylib Studio: could not open ${doc.name} -- ${doc.problem}. ` +
        'It is shown empty, and will not be saved over.',
    );
  } else if (again) {
    for (const panel of doc.panels) {
      void panel.webview.postMessage({ type: 'refresh' });
    }
    sceneTree?.refresh(doc);
    refreshSurfaces();
  }
}

/** The scene whose restore the last engine died on, if it died on one:
 *  marked lost, kept out of the next engine. */
async function markStoppedRestore(): Promise<SceneDocument | undefined> {
  const marker = restoringMarker();
  if (!marker) {
    return undefined;
  }
  const key = await vscode.workspace.fs.readFile(marker).then(
    (bytes) => Buffer.from(bytes).toString('utf8').trim(),
    () => undefined,
  );
  await vscode.workspace.fs.delete(marker).then(undefined, () => {});
  const doc = key ? openScenes().find((open) => open.key === key) : undefined;
  if (doc) {
    doc.lost = true;
    doc.problem = 'putting it back into the restarted engine stopped the engine';
  }
  return doc;
}

/** Say what an engine restart did to the open scenes, once. */
function tellRestart(context: vscode.ExtensionContext, lost: SceneDocument | undefined): void {
  const back = openScenes().filter((doc) => doc !== lost);
  if (back.length) {
    void vscode.window.showWarningMessage(
      `Magpylib Studio: the engine stopped and was started again. ` +
        `${back.map((doc) => doc.name).join(', ')} came back as each was a second ` +
        'after its last edit, without its undo history.',
    );
  }
  if (lost) {
    const again = 'Try Again';
    const json = 'Open as JSON';
    void vscode.window
      .showErrorMessage(
        `Magpylib Studio: ${lost.name} could not be brought back: putting it into the ` +
          'restarted engine stopped the engine. Its tab keeps its last backup, and ' +
          'is not saved over.',
        again,
        json,
      )
      .then(async (choice) => {
        if (choice === again) {
          lost.lost = false;
          lost.problem = undefined;
          lost.opening = undefined;
          lost.engine = {}; // not this engine: the next request puts it back
          await engineFor(context, lost).request('get_variables').catch(() => undefined);
          refreshSurfaces();
        } else if (choice === json) {
          const document = await vscode.workspace.openTextDocument({
            language: 'json',
            content: JSON.stringify(lost.lastDocument ?? {}, null, 2),
          });
          await vscode.window.showTextDocument(document);
        }
      });
  }
}

/** The engine protocols this extension speaks: 2 is a session per scene
 *  (`rpc.PROTOCOL`). An engine outside the range is refused: one from before
 *  sessions ignores their names and would serve every tab from one scene,
 *  without a word, and a newer one may speak what this does not know. */
const ENGINE_PROTOCOL = { min: 2, max: 2 };

/** Why the engine that answered `version` so cannot serve this extension, or
 *  undefined when it can. `error` is what the request raised instead. */
export function engineMismatch(
  answer: { protocol?: unknown } | undefined,
  error?: { type?: string; message?: string },
): string | undefined {
  if (error) {
    return error.type === 'MethodError'
      ? 'it is from before several scenes, and would serve every tab from one scene'
      : `it did not say which version it is (${error.message ?? 'no answer'})`;
  }
  const protocol = answer?.protocol;
  if (typeof protocol !== 'number') {
    return 'it did not say which version it is';
  }
  if (protocol < ENGINE_PROTOCOL.min) {
    return `it speaks protocol ${protocol}, older than this extension needs (${ENGINE_PROTOCOL.min})`;
  }
  if (protocol > ENGINE_PROTOCOL.max) {
    return `it is newer than this extension (protocol ${protocol}); update the extension`;
  }
  return undefined;
}

/** The interpreter whose engine was refused, and why: not started again until
 *  the interpreter changes or the engine is installed anew, so that one
 *  refusal is said once rather than on every request. */
let refusedEngine: { python: string; reason: string } | undefined;

/** One start at a time. Finding an interpreter is asynchronous now, so two
 *  callers arriving in that window would otherwise each spawn an engine —
 *  and the second would silently become the one holding the scene, leaving
 *  the first running with nobody listening to it. */
let startingEngine: Promise<EngineClient> | undefined;

function getRawEngine(context: vscode.ExtensionContext): Promise<EngineClient> {
  if (engine?.isRunning) {
    return Promise.resolve(engine);
  }
  // There was one and it is gone -- crashed, or restarted onto another
  // interpreter -- so it took every scene with it. Each is put back, one at a
  // time, save the one whose restore the last engine died on.
  const restarted = engine !== undefined;
  startingEngine ??= (async () => {
    const lost = restarted ? await markStoppedRestore() : undefined;
    const client = await startEngine(context);
    if (restarted) {
      for (const doc of openScenes()) {
        void openSession(client, doc).catch(() => {});
      }
      tellRestart(context, lost);
    }
    return client;
  })().finally(() => {
    startingEngine = undefined;
  });
  return startingEngine;
}

async function startEngine(context: vscode.ExtensionContext): Promise<EngineClient> {
  if (!engineOutput) {
    engineOutput = vscode.window.createOutputChannel('Magpylib Studio Engine');
    context.subscriptions.push(engineOutput);
  }
  const pythonPath = await findPython(context);
  if (!pythonPath) {
    vscode.window
      .showErrorMessage(
        'Magpylib Studio: no Python interpreter with the magpylib-studio ' +
          'engine found. Set "magpylib-studio.pythonPath" to an interpreter ' +
          'where the engine package is installed, or install it now.',
        'Install the Engine',
        'Open Settings',
      )
      .then((choice) => {
        if (choice === 'Install the Engine') {
          void installEngine();
        } else if (choice === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'magpylib-studio.pythonPath',
          );
        }
      });
    throw new Error('no usable Python interpreter for the engine');
  }
  if (refusedEngine?.python === pythonPath) {
    throw new Error(`the engine in ${pythonPath} was refused: ${refusedEngine.reason}`);
  }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? repoRoot(context);
  engineOutput.appendLine(`[starting engine: ${pythonPath}]`);
  const client = new EngineClient(pythonPath, cwd);
  let stderrTail = '';
  client.onStderr = (text) => {
    engineOutput?.append(text);
    stderrTail = (stderrTail + text).slice(-400);
  };
  client.onExit = (code) => {
    engineOutput?.appendLine(`\n[engine exited with code ${code}]`);
    // `engine` is left pointing at it: getEngine replaces an engine that is
    // no longer running, and that is also where the scene it was holding is
    // put back. Clearing it here would hide from that check the one fact it
    // needs — that there was a previous engine at all.
    if (code !== 0 && !client.wasDisposed) {
      cachedPython = undefined; // re-probe interpreters on the next attempt
      const lastLine = stderrTail.trim().split('\n').pop() ?? '';
      vscode.window
        .showErrorMessage(
          `Magpylib Studio engine crashed (exit ${code})` +
            (lastLine ? `: ${lastLine}` : ''),
          'Show Output',
        )
        .then((choice) => {
          if (choice) {
            engineOutput?.show();
          }
        });
    }
  };
  // Asked before anything else: an engine that cannot serve several scenes
  // must not be handed one. A process that died on starting has said so
  // through onExit, and its error is passed on as it is.
  const said = await client.request<{ protocol?: unknown }>('version').then(
    (answer) => ({ answer, error: undefined }),
    (error: unknown) => {
      if (!(error instanceof EngineError)) {
        throw error;
      }
      return { answer: undefined, error: error.rpcError };
    },
  );
  const mismatch = engineMismatch(said.answer, said.error);
  if (mismatch) {
    client.dispose();
    refusedEngine = { python: pythonPath, reason: mismatch };
    engineOutput.appendLine(`[engine refused: ${mismatch}]`);
    const newer = mismatch.includes('newer than this extension');
    void vscode.window
      .showErrorMessage(
        `Magpylib Studio: the engine in ${pythonPath} cannot be used: ${mismatch}.`,
        ...(newer ? [] : ['Install the Engine', 'Open Settings']),
      )
      .then((choice) => {
        if (choice === 'Install the Engine') {
          void installEngine();
        } else if (choice === 'Open Settings') {
          void vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'magpylib-studio.pythonPath',
          );
        }
      });
    throw new Error(`the engine in ${pythonPath} was refused: ${mismatch}`);
  }
  engine = client;
  return client;
}

/** The tree item a keyboard shortcut should act on (menus pass it directly).
 *  Steps are selectable too, but the object shortcuts do not apply to them. */
function treeSelection(): SceneObject | undefined {
  const selected = sceneTreeView?.selection[0];
  if (!isObject(selected)) {
    return undefined;
  }
  // a key pressed on a row acts on that row's scene
  if (selected.scene) {
    actOn(selected.scene);
  }
  return selected;
}

/** The magpylib logo for a tab: on a dark theme the version without its
 *  white outline, which shows there as a halo. */
function logoUri(context: vscode.ExtensionContext): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(context.extensionUri, 'media', 'magnet.svg'),
    dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'magnet-dark.svg'),
  };
}

/** Route webview 'rpcRequest' messages to the engine, for the scene `scene`
 *  says: a scene's own tab is drawn for that scene, the field panel for the
 *  one in front. */
function wireRpcRouter(webview: vscode.Webview, scene: () => Promise<SceneEngine>): void {
  webview.onDidReceiveMessage(async (message) => {
    if (message.type !== 'rpcRequest') {
      return;
    }
    const { reqId, method, params } = message;
    try {
      const result = await (await scene()).request(method, params);
      webview.postMessage({ type: 'rpcResult', reqId, method, result });
    } catch (err) {
      webview.postMessage({
        type: 'rpcError',
        reqId,
        method,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** Panel type ids. Keep them: keybinding when-clauses and the serializers
 *  registered at activation both match on these. */
const STUDIO_PANEL = 'magpylibStudio';
const FIELD_PANEL = 'magpylibField';

/** The exception the webview guide allows: what would be lost is the camera
 *  the user has just spent time positioning, and a plotly scene is expensive
 *  to rebuild. getState/setState cannot cheaply carry it. */
const PANEL_OPTIONS = (context: vscode.ExtensionContext) => ({
  enableScripts: true,
  retainContextWhenHidden: true,
  localResourceRoots: [context.extensionUri],
});

/** What a scene's view sends when a person acts in it. */
const ACTS = new Set([
  'selectObject',
  'transformObjects',
  'previewTransform',
  'setVisible',
  'undo',
  'redo',
  'dragStart',
]);

/** Fill in a scene's tab: the studio's view, drawn for that scene. */
function adoptScenePanel(
  context: vscode.ExtensionContext,
  doc: SceneDocument,
  panel: vscode.WebviewPanel,
): void {
  doc.panels.add(panel);
  panel.iconPath = logoUri(context); // tabs render icons in full colour
  panel.webview.options = PANEL_OPTIONS(context);
  panel.webview.html = createWebviewHtml(context, panel.webview);
  wireRpcRouter(panel.webview, () => Promise.resolve(engineFor(context, doc)));
  panel.webview.onDidReceiveMessage((message) => {
    if (tookTextFocus(message, panel.webview)) {
      return;
    }
    // What a person does in the view, they do to its scene, which the act
    // puts in front. Only that: a tab behind keeps asking the engine for what
    // it draws, and that must not move the side bar to it.
    if (ACTS.has(message.type)) {
      bringToFront(doc);
    }
    if (message.type === 'selectObject') {
      // a pick in the 3D view is the same act as clicking the Scene tree
      selectObjectInStudio(context, message.objectId);
    } else if (message.type === 'transformObjects') {
      void transformFromPanel(context, message);
    } else if (message.type === 'previewTransform') {
      void transformFromPanel(context, message, panel);
    } else if (message.type === 'setVisible') {
      void setVisibleFromPanel(context, message.hide, message.show);
    } else if (message.type === 'undo' || message.type === 'redo') {
      // the view's buttons: the same commands the keys and the tree run
      void vscode.commands.executeCommand(`magpylib-studio.${message.type}`);
    } else if (message.type === 'notice') {
      // Passing remarks go where VS Code puts them, and expire on their own.
      // The panel's own line is for the numbers a drag is changing, which are
      // still changing after any of these has stopped being news.
      vscode.window.setStatusBarMessage(`Magpylib Studio: ${message.text}`, 5000);
    } else if (message.type === 'dragStart') {
      void beginDragFromPanel(context);
    } else if (message.type === 'ready') {
      panel.webview.postMessage({ type: 'select', objectId: doc.selected });
    }
  });
  if (panel.active) {
    bringToFront(doc);
  }
  panel.onDidChangeViewState((event) => {
    if (event.webviewPanel.active) {
      bringToFront(doc);
    }
  });
  panel.onDidDispose(() => {
    doc.panels.delete(panel);
    setTextFocus(false);
  });
}

/** The tabs of the scene in front, to tell what the side bar did. */
function postToFrontScene(message: unknown): void {
  for (const panel of frontScene()?.panels ?? []) {
    void panel.webview.postMessage(message);
  }
}

/** Show the scene in front, or a new one when none is open. */
async function showFrontScene(): Promise<void> {
  const doc = frontScene();
  if (!doc) {
    await vscode.commands.executeCommand('magpylib-studio.newScene');
    return;
  }
  const [panel] = doc.panels;
  if (panel) {
    panel.reveal(panel.viewColumn);
  } else {
    await vscode.commands.executeCommand('vscode.openWith', doc.uri, SCENE_VIEW_TYPE);
  }
}

/** The Field panel says when its script is listening, and until it does a
 *  message meant for it waits here. The Sweep command posts one in the same
 *  tick the panel is created, which is well before there is anything on the
 *  other end to receive it — the sidebar views have always had this
 *  handshake, and this is the panel that needs it. */
let fieldReady = false;
let pendingFieldMessage: unknown | undefined;

function postToFieldPanel(message: unknown): void {
  if (fieldPanel && fieldReady) {
    void fieldPanel.webview.postMessage(message);
  } else {
    pendingFieldMessage = message;
  }
}

function adoptFieldPanel(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
): void {
  fieldPanel = panel;
  fieldReady = false;
  panel.iconPath = logoUri(context);
  panel.webview.options = PANEL_OPTIONS(context);
  panel.webview.html = createFieldViewHtml(context, panel.webview);
  // its own scene; one brought back by a reload is the scene in front's
  fieldScene ??= frontScene();
  nameFieldPanel();
  wireRpcRouter(panel.webview, () => {
    fieldScene ??= frontScene();
    return Promise.resolve(engineFor(context, fieldScene ?? scratch));
  });
  panel.webview.onDidReceiveMessage((message) => {
    if (tookTextFocus(message, panel.webview) || message.type !== 'ready') {
      return;
    }
    fieldReady = true;
    const waiting = pendingFieldMessage;
    pendingFieldMessage = undefined;
    if (waiting) {
      void panel.webview.postMessage(waiting);
    }
  });
  panel.onDidDispose(() => {
    fieldPanel = undefined;
    fieldScene = undefined;
    fieldReady = false;
    setTextFocus(false);
    // Whatever was waiting was for this panel. Keeping it would deliver a
    // sweep to whichever panel is opened next, whenever that is.
    pendingFieldMessage = undefined;
  });
}

/** The field panel's title names its scene. */
function nameFieldPanel(): void {
  if (fieldPanel) {
    fieldPanel.title = fieldScene ? `Field: ${fieldScene.name}` : 'Magpylib Field';
  }
}

/** Refresh the field panel when `doc` is its scene. */
function refreshField(doc: SceneDocument | undefined): void {
  if (fieldPanel && doc && doc === fieldScene) {
    void fieldPanel.webview.postMessage({ type: 'refresh' });
  }
}

/** The field panel, for the scene a command acts on. Opened for another
 *  scene, it moves there and drops a sweep made for the first. */
function openFieldPanel(context: vscode.ExtensionContext): void {
  const scene = actingScene();
  if (fieldPanel) {
    if (scene && scene !== fieldScene) {
      fieldScene = scene;
      nameFieldPanel();
      pendingFieldMessage = undefined;
      postToFieldPanel({ type: 'newScene' });
    }
    fieldPanel.reveal(undefined, true);
    return;
  }
  fieldScene = scene;
  adoptFieldPanel(
    context,
    vscode.window.createWebviewPanel(
      FIELD_PANEL,
      'Magpylib Field',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      PANEL_OPTIONS(context),
    ),
  );
}

/** Apply a gizmo drag from the 3D view, as it happens and when it ends.
 *
 * A drag is an edit, so it goes through the engine and the event log like
 * every other one -- undo, the history, and the exported script all get it
 * for free. It arrives as the pose reached rather than the change made,
 * which is what lets the engine replace the trailing op in place: a drag of
 * any length is two events, not two per frame.
 *
 * While the drag is running, the surfaces that show something the picture
 * cannot are brought up to date: the Inspector's numbers and the field. The
 * 3D view is not, because it is already showing the new pose -- it moved the
 * mesh itself -- and asking for the scene back would re-serialise every
 * object in it to move one, which is three quarters of the round trip and
 * the only part that grows with the size of the scene. That redraw and the
 * trees wait for the drag to end.
 */
interface Edit {
  objectId: string;
  position?: number[] | number[][];
  orientation?: number[] | number[][];
  shape?: { attr: string; value: number | number[] | number[][] };
  polarization?: number[];
}

async function transformFromPanel(
  context: vscode.ExtensionContext,
  message: { edits: Edit[]; define?: boolean },
  previewFor?: vscode.WebviewPanel,
): Promise<void> {
  try {
    const engine = await getEngine(context);
    // The engine turns the view's edits into its own calls, as it does for
    // any other view of a session: several objects dragged together are one
    // step to undo, since the gesture was one thing the user did. `define`:
    // a variable's name typed in the readout that the scene lacks is made
    // at the value it replaces, as the Inspector asks to make one.
    const result = (await engine.request('apply_edits', {
      edits: message.edits,
      ...(message.define ? { define: true } : {}),
    })) as {
      ok: boolean;
      error?: string;
      defined?: string[];
    };
    if (result.ok && result.defined?.length && !previewFor) {
      vscode.window.setStatusBarMessage(
        `Magpylib Studio: ${result.defined.join(', ')} made, at the value it replaces`,
        4000,
      );
    }
    // Only the final pose reports: the same refusal sixty times over during
    // one drag is sixty notifications about one mistake.
    if (result.ok === false && !previewFor) {
      vscode.window.showErrorMessage(`Magpylib Studio: ${result.error}`);
    }
  } catch (err) {
    if (!previewFor) {
      vscode.window.showErrorMessage(
        `Magpylib Studio: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  if (previewFor) {
    finishPreview(previewFor);
    return;
  }
  // A refused drag still leaves the view showing where the object was dragged
  // to, and only a redraw from the model puts it back.
  await finishDrag(context);
}

/** Open a drag: group what it is about to do.
 *
 * A drag sets a pose every frame so the field and the scene keep up with the
 * pointer, and each of those is a real edit -- without this the undo stack
 * takes one entry per frame and a gesture made once becomes a hundred things
 * to undo. What the drag takes over from a variable, the view's own readout
 * says, before the drag rather than after it.
 */
async function beginDragFromPanel(context: vscode.ExtensionContext): Promise<void> {
  try {
    await (await getEngine(context)).request('begin_interaction');
  } catch {
    // the drag still works; it just undoes a frame at a time
  }
}

/** Close the drag, then bring every surface back in sync. */
async function finishDrag(context: vscode.ExtensionContext): Promise<void> {
  try {
    await (await getEngine(context)).request('end_interaction');
  } catch {
    // a group left open is closed by the next gesture that begins
  }
  broadcastMutation();
}

/** Show or hide objects, from the view: its eye, H, or shift-H.
 *
 * Visibility is the document's here, not the view's -- saved, and undone like
 * any edit -- so the view says what it wants and the engine records it, as one
 * step however many objects it covers: shift-H hides everything else, and may
 * show the one selected, in one keystroke, and one undo puts it all back. A
 * hidden object is not drawn; the legend and the Scene tree still list it, to
 * be shown again from either.
 */
async function setVisibleFromPanel(
  context: vscode.ExtensionContext,
  hide: string[] = [],
  show: string[] = [],
): Promise<void> {
  if (!Array.isArray(hide) || !Array.isArray(show) || !(hide.length || show.length)) {
    return;
  }
  try {
    const engine = await getEngine(context);
    await engine.request('batch', {
      operations: [
        ...hide.map((objectId) => ({
          method: 'set_visible',
          params: { object_id: objectId, visible: false },
        })),
        ...show.map((objectId) => ({
          method: 'set_visible',
          params: { object_id: objectId, visible: true },
        })),
      ],
    });
    if (hide.length) {
      const which = hide.length > 3 ? `${hide.length} objects` : hide.join(', ');
      vscode.window.setStatusBarMessage(
        `Magpylib Studio: ${which} hidden — show again from the legend or the Scene tree`,
        5000,
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Magpylib Studio: ${err instanceof Error ? err.message : err}`,
    );
  }
  broadcastMutation();
}

/** The surfaces a gesture keeps live: what the user is watching while they
 *  drag, and nothing else.
 *
 *  Unpaced here on purpose. The rate is set where the cost is -- by whatever
 *  is holding the gesture, which sends one value per frame at most and waits
 *  for the round trip before the next -- so a light scene runs at the screen's
 *  rate and a heavy one at the rebuild's. Everything fed here collapses its
 *  own redraws to the newest state on top of that, so an extra pass costs a
 *  request rather than a queue. Any interval imposed at this end would be a
 *  cap on the first case and dead weight on the second.
 *
 *  What is left out is the point: the tree, the history, the script view and
 *  scene.json are bookkeeping. Refreshing them per frame spends the engine on
 *  answers nobody is looking at, and it is the same engine the view is
 *  waiting on. They are brought up to date when the gesture ends and
 *  broadcastMutation runs. */
function refreshLiveSurfaces(): void {
  inspector?.refresh();
  // The field is the whole point of dragging a magnet somewhere, and the one
  // thing on screen that cannot be worked out from the picture. It paces
  // itself: a recompute that outlasts the next pose is left to finish and the
  // newest pose is taken up after it.
  refreshField(frontScene());
}

/** Bring the cheap surfaces up to date mid-drag, and let the next pose go. */
function finishPreview(panel: vscode.WebviewPanel): void {
  try {
    refreshLiveSurfaces();
  } finally {
    // Answering is what paces the drag: the panel holds the next pose until
    // this one is back, so a slow scene sends fewer of them rather than
    // falling further behind. Unconditional, because a preview that fails to
    // answer does not slow the drag down -- it ends it, silently, and every
    // remaining pose waits for a reply that is never coming.
    panel.webview.postMessage({ type: 'previewDone' });
  }
}

function selectObjectInStudio(context: vscode.ExtensionContext, objectId: string): void {
  selectedObjectId = objectId;
  const doc = frontScene();
  if (doc) {
    doc.selected = objectId;
  }
  inspector?.select(objectId);
  const [panel] = doc?.panels ?? [];
  if (panel) {
    panel.webview.postMessage({ type: 'select', objectId });
    panel.reveal(panel.viewColumn, true); // keep focus in the sidebar
  } else if (doc) {
    void showFrontScene(); // its 'ready' asks for the selection itself
  }
}

/** Show which file the scene is, and whether it has unsaved changes.
 *
 * The tree view's description is the only title bar the studio has — there is
 * no editor tab to carry the name and the dirty dot, so the "•" convention is
 * borrowed rather than invented.
 */
function showSceneFile(): void {
  const doc = frontScene();
  // each scene's row carries its name and its dot
  sceneTree?.refresh();
  openScenesList?.refresh();
  void vscode.commands.executeCommand(
    'setContext',
    'magpylib-studio.sceneFile',
    doc !== undefined && !doc.untitled,
  );
  void vscode.commands.executeCommand(
    'setContext',
    'magpylib-studio.sceneDirty',
    doc?.dirty ?? false,
  );
}

function basename(uri: vscode.Uri): string {
  return uri.path.split('/').pop() || uri.path;
}

/** Where `doc`'s recovery copy is written: a scene document, which opens as
 *  any other, with the scene it is a copy of named beside it. */
function recoveryFile(doc: SceneDocument): vscode.Uri | undefined {
  return recoveryDir && vscode.Uri.joinPath(recoveryDir, `${doc.key}.magpy.json`);
}

function recoveryOrigin(doc: SceneDocument): vscode.Uri | undefined {
  return recoveryDir && vscode.Uri.joinPath(recoveryDir, `${doc.key}.from`);
}

/** Take the document a scene settled on a second after its last edit: what a
 *  restarted engine is given back, written as the scene's recovery copy.
 *  Slower than the redraw on purpose: a redraw has to feel instant, this only
 *  has to beat the next crash. */
function scheduleSettle(context: vscode.ExtensionContext, doc: SceneDocument): void {
  clearTimeout(settleTimers.get(doc));
  settleTimers.set(
    doc,
    setTimeout(() => {
      settleTimers.delete(doc);
      void settle(context, doc);
    }, 1000),
  );
}

async function settle(context: vscode.ExtensionContext, doc: SceneDocument): Promise<void> {
  if (doc.problem || !openScenes().includes(doc)) {
    return;
  }
  try {
    doc.lastDocument = await engineFor(context, doc).request('to_dict');
    const file = recoveryFile(doc);
    if (file && doc.dirty) {
      await vscode.workspace.fs.createDirectory(recoveryDir!);
      await vscode.workspace.fs.writeFile(
        file,
        Buffer.from(JSON.stringify(doc.lastDocument, null, 2) + '\n', 'utf8'),
      );
      await vscode.workspace.fs.writeFile(
        recoveryOrigin(doc)!,
        Buffer.from(doc.uri.toString() + '\n', 'utf8'),
      );
    }
  } catch (err) {
    // A copy that cannot be written must not interrupt editing; the next
    // edit tries again. Said all the same: a copy that never lands is
    // invisible exactly until it is needed.
    engineOutput?.appendLine(
      `[recovery copy of ${doc.name} not written: ${err instanceof Error ? err.message : err}]`,
    );
  }
}

/** Recovery copies an earlier run left behind, found at activation before
 *  this run has edited anything: what a crash of VS Code kept of each scene,
 *  keyed by the scene's uri. */
const leftBehind = new Map<string, { copy: vscode.Uri; origin: vscode.Uri; saved: number }>();
/** Settles once the copies are found: an opening scene waits for it. */
let leftBehindFound: Promise<void> = Promise.resolve();

async function findLeftBehind(): Promise<void> {
  leftBehind.clear();
  if (!recoveryDir) {
    return;
  }
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(recoveryDir);
  } catch {
    return; // none written yet
  }
  for (const [name] of entries) {
    if (!name.endsWith('.from')) {
      continue;
    }
    const origin = vscode.Uri.joinPath(recoveryDir, name);
    const copy = vscode.Uri.joinPath(recoveryDir, name.replace(/\.from$/, '.magpy.json'));
    try {
      const uri = Buffer.from(await vscode.workspace.fs.readFile(origin)).toString('utf8').trim();
      const saved = (await vscode.workspace.fs.stat(copy)).mtime;
      const earlier = leftBehind.get(uri);
      if (!earlier || earlier.saved < saved) {
        if (earlier) {
          discardCopy(earlier);
        }
        leftBehind.set(uri, { copy, origin, saved });
      } else {
        discardCopy({ copy, origin });
      }
    } catch {
      discardCopy({ copy, origin }); // half a pair: nothing to offer
    }
  }
}

function discardCopy(left: { copy: vscode.Uri; origin: vscode.Uri }): void {
  for (const file of [left.copy, left.origin]) {
    void vscode.workspace.fs.delete(file).then(undefined, () => {});
  }
}

/** A scene saved, reverted or closed has no unsaved work to recover. */
function dropRecovery(doc: SceneDocument): void {
  clearTimeout(settleTimers.get(doc));
  settleTimers.delete(doc);
  for (const file of [recoveryFile(doc), recoveryOrigin(doc)]) {
    if (file) {
      void vscode.workspace.fs.delete(file).then(undefined, () => {});
    }
  }
}

/** How long a burst of edits may collapse into one pass. Measured from the
 *  first edit still waiting to be shown, so it is also the longest any
 *  surface stays stale while edits keep coming. */
const REFRESH_WINDOW_MS = 150;

/** Bring every surface back in sync with the engine. Throttled so a burst —
 *  a batch applied one operation at a time, a run of edits in quick
 *  succession — costs one pass per window rather than one each. Says nothing about the
 *  scene having *changed*: see broadcastMutation; redrawing and editing are
 *  not the same event, and conflating them would put an unsaved-changes mark
 *  on a Refresh.
 *
 *  Nothing anyone is holding comes through here. A gesture runs on
 *  refreshLiveSurfaces, paced by the hand and the scene rather than by a
 *  clock; this is for edits that arrive on their own, where collapsing them
 *  is what stops the tree and the script view from taking the engine's pipe
 *  away from the view.
 *
 *  The window runs from the first edit still waiting rather than the last to
 *  arrive, so a chain of edits shows the scene being built instead of nothing
 *  until it stops. As a trailing debounce this starved outright: every edit
 *  pushed the timer out, and a long enough chain drew once, at the end. */
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function refreshSurfaces(): void {
  if (refreshTimer !== undefined) {
    return; // a pass is already due inside the window; this edit rides on it
  }
  // For the scene in front, whichever command scheduled it: a timer keeps
  // the context it was set in, and a command's scene riding on it would be
  // drawn in front of the one there now.
  refreshTimer = commandScene.exit(() => setTimeout(() => {
    refreshTimer = undefined;
    postToFrontScene({ type: 'refresh' });
    refreshField(frontScene());
    const front = frontScene();
    if (front) {
      sceneTree?.refresh(front); // its rows, and no other scene's
    }
    historyTree?.refresh();
    variablesTree?.refresh();
    inspector?.refresh();
    refreshScript?.();
    sceneDocEmitter?.fire(SCENE_JSON_URI);
  }, REFRESH_WINDOW_MS));
}

/** An edit happened somewhere (inspector, tree action, panel, script tab):
 *  the scene in front now differs from its file, and every surface is stale.
 *  Every path that changes a scene ends up here, which makes it the one place
 *  that can tell VS Code the scene's tab is unsaved -- once per edit, so that
 *  an edit made while a save was writing is not lost to the save clearing the
 *  mark (plans/several-scenes.md §8). */
function broadcastMutation(): void {
  // the scene the edit went to: a command's own, or the one in front
  const box = commandScene.getStore();
  const doc = box ? box.scene : frontScene();
  if (doc && openScenes().includes(doc)) {
    doc.revision += 1;
    if (!doc.dirty) {
      doc.dirty = true;
      showSceneFile();
      // edited, so backed up: VS Code brings it back from now on
      rememberExample(doc.uri, undefined);
    }
    sceneEdited.fire({ document: doc });
    if (activeContext) {
      scheduleSettle(activeContext, doc);
    }
    if (doc !== frontScene()) {
      // edited behind: its own tab and rows, the views being on another
      for (const panel of doc.panels) {
        void panel.webview.postMessage({ type: 'refresh' });
      }
      sceneTree?.refresh(doc);
      refreshField(doc);
      refreshScript?.(doc);
    }
  }
  refreshSurfaces();
}

/** Set at activation, for the module-level functions that need it. */
let activeContext: vscode.ExtensionContext | undefined;

/** The example each untouched example tab holds, by its untitled name. Such a
 *  tab is clean, so VS Code keeps no backup of it and a reload brings it back
 *  empty: it is filled again from here. */
const EXAMPLE_TABS = 'magpylib-studio.exampleTabs';

function rememberedExample(uri: vscode.Uri): string | undefined {
  return activeContext?.workspaceState.get<Record<string, string>>(EXAMPLE_TABS, {})[uri.toString()];
}

/** Remember `uri` as holding `example`, or forget it, when undefined. */
function rememberExample(uri: vscode.Uri, example: string | undefined): void {
  const tabs = { ...activeContext?.workspaceState.get<Record<string, string>>(EXAMPLE_TABS, {}) };
  if (tabs[uri.toString()] === example) {
    return;
  }
  if (example === undefined) {
    delete tabs[uri.toString()];
  } else {
    tabs[uri.toString()] = example;
  }
  void activeContext?.workspaceState.update(EXAMPLE_TABS, tabs);
}

export function activate(context: vscode.ExtensionContext): void {
  activeContext = context;
  /** Every command of the studio: one run from a row of the tree, its menu
   *  or its buttons, acts on the row's scene, which it puts in front first. */
  const registerCommand = <A extends unknown[]>(
    id: string,
    handler: (...args: A) => unknown,
  ): vscode.Disposable =>
    vscode.commands.registerCommand(id, (...args: A) => {
      const row = sceneOfNode(args[0]);
      if (row) {
        bringToFront(row);
      }
      const scene = row ?? commandScene.getStore()?.scene ?? frontScene();
      return commandScene.run({ scene }, () => handler(...args));
    });
  // Tell a script run from this window's terminals where to leave a payload,
  // so `show()` can draw into *this* window rather than guessing at one. The
  // address only, never a backend name: `pytest` in the same terminal is
  // stamped identically to a human run, and nothing the stamp can see tells
  // them apart (docs/decisions.md#0014-the-window-stamp-says-where-never-whether). A stamp that selected the
  // backend would change what every test suite in this window drew with.
  const drop = (context.storageUri ?? context.globalStorageUri).fsPath;
  context.environmentVariableCollection.description =
    'Magpylib Studio: tells a script run here which window to draw in';
  context.environmentVariableCollection.replace('MAGPYLIB_STUDIO_DROP', drop);
  // The address says where; this says whether. Kept as a second variable so
  // the two stay separable: the address is always safe to carry, choosing a
  // backend for every script in the window is not -- it is on by default, and
  // `echo $MAGPYLIB_STUDIO_BACKEND` is then the whole explanation for why
  // figures are going somewhere new.
  const stampBackend = () => {
    if (drawScriptsHere()) {
      context.environmentVariableCollection.replace(
        'MAGPYLIB_STUDIO_BACKEND',
        'studio',
      );
    } else {
      context.environmentVariableCollection.delete('MAGPYLIB_STUDIO_BACKEND');
    }
  };
  stampBackend();
  context.subscriptions.push(
    // Terminals already open keep what they were given -- VS Code marks them
    // as wanting a relaunch, which is the only honest thing to show.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('magpylib-studio.drawScriptsHere')) {
        stampBackend();
      }
    }),
  );
  activateScriptViewer(context);

  /** The rows of the tree: every scene open in a tab, in the order they
   *  opened, then the tabs VS Code has not loaded yet. A scene in a diff, or
   *  from git, is not one being edited, and is left out. */
  const sceneRoots = (): SceneRoot[] => {
    const roots = new Map<string, SceneRoot>();
    for (const doc of [...openScenes()].sort((a, b) => a.openedAt - b.openedAt)) {
      if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') {
        const [panel] = doc.panels;
        roots.set(doc.uri.toString(), {
          kind: 'scene',
          uri: doc.uri,
          doc,
          column: panel?.viewColumn,
        });
      }
    }
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputCustom &&
          input.viewType === SCENE_VIEW_TYPE &&
          !roots.has(input.uri.toString())
        ) {
          roots.set(input.uri.toString(), {
            kind: 'scene',
            uri: input.uri,
            column: group.viewColumn,
          });
        }
      }
    }
    return [...roots.values()];
  };

  /** Whether any scene is open in a tab, for the title bar's Close All. */
  const showScenesOpen = () =>
    void vscode.commands.executeCommand(
      'setContext',
      'magpylib-studio.scenesOpen',
      sceneRoots().length > 0,
    );

  /** Open a scene's tab where it is, the focus left in the side bar. */
  const loadSceneTab = (root: SceneRoot) =>
    vscode.commands.executeCommand('vscode.openWith', root.uri, SCENE_VIEW_TYPE, {
      viewColumn: root.column,
      preserveFocus: true,
      preview: false,
    });

  /** The scenes Objects shows: those picked in Open Scenes, and with none
   *  picked -- the one picked closed -- the scene in front. */
  const shownRoots = (): SceneRoot[] => {
    const roots = sceneRoots();
    for (const doc of [...shownScenes]) {
      if (!openScenes().includes(doc)) {
        shownScenes.delete(doc);
      }
    }
    const shown = roots.filter((root) => root.doc && shownScenes.has(root.doc));
    if (shown.length) {
      return shown;
    }
    const front = frontScene();
    return roots.filter((root) => root.doc && root.doc === front);
  };

  const tree = new SceneTreeProvider(
    context.extensionUri,
    shownRoots,
    (doc) => doc === frontScene(),
    async (doc) => {
      try {
        return await engineFor(context, doc).request<SceneObject[]>('list_objects');
      } catch (err) {
        engineOutput?.appendLine(`scene view: ${err instanceof Error ? err.message : err}`);
        return [];
      }
    },
    async (doc, id, parent) => {
      bringToFront(doc);
      await mutateFromTree('move_object', { object_id: id, parent });
    },
    async (doc) => {
      try {
        const { events, rollback } = await engineFor(context, doc).request<{
          events: Omit<SceneOperation, 'kind'>[];
          rollback: number | null;
        }>('get_events');
        // the engine owns this state — any edit returns to the end of the
        // history — so it is read back rather than tracked
        const rolledBack = rollback !== null;
        if (doc.rolledBack !== rolledBack) {
          doc.rolledBack = rolledBack;
          setTimeout(() => sceneTree?.refresh(), 0); // the row's own button
        }
        if (doc === frontScene()) {
          void vscode.commands.executeCommand(
            'setContext', 'magpylib-studio.rolledBack', rolledBack,
          );
        }
        return events.map((event) => ({ ...event, kind: 'operation' as const }));
      } catch {
        return [];
      }
    },
    (root) => void loadSceneTab(root),
  );
  sceneTree = tree;

  const history = new HistoryTreeProvider(async () => {
    try {
      return await (await getEngine(context)).request<{
        entries: HistoryEntry[];
        current: number;
      }>('get_history');
    } catch {
      return { entries: [], current: 0 };
    }
  });
  historyTree = history;

  const variables = new VariablesViewProvider(
    context.extensionUri,
    // each request to the scene the panel was drawn for
    (method, params, scene) =>
      inScene(scene, async () => (await getEngine(context)).request(method, params)),
    (action, name, scene) => {
      void inScene(scene, async () => {
        const found = (
          await (await getEngine(context)).request<{ variables: Variable[] }>('get_variables')
        ).variables.find((v) => v.name === name);
        if (!found) {
          return;
        }
        // `restore` the panel does itself, as a call: it is one.
        if (action === 'edit') {
          await editVariableProperties(found);
        } else if (action === 'remove') {
          await mutateFromTree('remove_variable', { name });
        }
      });
    },
    (scene) => inScene(scene, () => broadcastMutation()),
    (scene) => {
      // Told directly rather than through the debounce that serves ordinary
      // edits: a variable can move anything in the scene, and unlike a gizmo
      // drag there is no pose reply for the view to redraw from. The panel
      // collapses what it cannot keep up with, so this cannot outrun it.
      for (const panel of sceneForKey(scene)?.panels ?? []) {
        void panel.webview.postMessage({ type: 'refresh' });
      }
      refreshLiveSurfaces();
    },
  );
  variablesTree = variables;

  inspector = new InspectorViewProvider(
    context.extensionUri,
    // each request to the scene the panel was drawn for
    (method, params, scene) => inScene(scene, async () => {
      // A bare name in a parameter or a pose is the engine's to make: the
      // panel sends `define`, and the engine makes the name at the value it
      // replaces, in the same step (decision 0023). A step's own values still
      // go through the ask here, since `edit_event` takes no `define`, and a
      // webview cannot raise an input box of its own.
      if (params && MUTATING_WITH_VALUES.has(method) && !params.define) {
        if (!(await ensureVariablesDefined(Object.values(params), { method, params }))) {
          return { ok: false, error: 'cancelled' };
        }
      }
      const result = (await (await getEngine(context)).request(method, params)) as {
        ok?: boolean;
        defined?: string[];
      };
      if (result?.ok && result.defined?.length) {
        vscode.window.setStatusBarMessage(
          `Magpylib Studio: ${result.defined.join(', ')} made, at the value it replaces`,
          4000,
        );
      }
      return result;
    }),
    (scene) => inScene(scene, () => {
      // Every field here writes to the scene, so this is an edit like any
      // other: it went to the 3D view and the tree and nowhere else, which
      // left the field panel showing a magnet that had moved, the history and
      // the script view a step behind, and — the one that matters — the
      // unsaved-changes mark unset and the crash backup unwritten. Nothing on
      // this panel streams while it is dragged (its slider writes to the box
      // beside it and applies on release), so the ordinary window is right.
      broadcastMutation();
    }),
    () => selectedObjectId,
  );

  /** One of the scene's variants, picked; none when it has none. */
  const pickVariant = async (placeHolder: string): Promise<string | undefined> => {
    const { variants, variant } = await (await getEngine(context)).request<{
      variants?: Record<string, Record<string, unknown>>;
      variant?: string | null;
    }>('get_variables');
    const names = Object.keys(variants ?? {});
    if (!names.length) {
      void vscode.window.showInformationMessage(
        'Magpylib Studio: this scene has no variants yet. Save as Variant… keeps ' +
          "the variables' values under a name.",
      );
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      names.map((name) => ({
        label: name,
        description: name === variant ? 'in use' : undefined,
        detail: Object.entries(variants![name])
          .map(([k, v]) => `${k} = ${v}`)
          .join(', '),
      })),
      { placeHolder },
    );
    return pick?.label;
  };

  /** Undo/redo: refresh on success; a quiet status message when empty. */
  const undoRedo = async (method: 'undo' | 'redo') => {
    try {
      const result = (await (await getEngine(context)).request(method)) as {
        ok: boolean;
        error?: string;
      };
      if (result.ok) {
        broadcastMutation();
      } else {
        vscode.window.setStatusBarMessage(`Magpylib Studio: ${result.error}`, 2000);
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Magpylib Studio: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  /** Scene candidates captured by the last script import (one per show()
   *  call in the script, plus "all script objects" when that differs). */
  let importedScenes: string[] = [];

  const switchImportedScene = async () => {
    if (importedScenes.length < 2) {
      vscode.window.showInformationMessage(
        'Magpylib Studio: no alternative scenes from the last script import.',
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(importedScenes, {
      placeHolder: 'Scene to load (one per show() call in the script)',
    });
    if (pick === undefined) {
      return;
    }
    if (await mutateFromTree('load_captured', { scene: importedScenes.indexOf(pick) })) {
      followNewScene();
    }
    void showFrontScene();
  };

  /** Run a user script through the engine importer and show the result. */
  /** `scene` names which of the script's `show()` calls to land on, for a
   *  caller that already knows -- a script view is one particular call, and
   *  arriving on a different scene with a prompt to go looking for yours is a
   *  poor answer to having clicked on it. */
  const importScript = async (uri: vscode.Uri, scene?: number) => {
    // What arrives opens a tab of its own rather than replacing the scene in
    // front (plans/several-scenes.md §5).
    if (!(await newSceneTab())) {
      return;
    }
    try {
      const result = (await (await getEngine(context)).request('load_script', {
        path: uri.fsPath,
      })) as { ok: boolean; error?: string; warnings?: string[]; scenes?: string[] };
      if (!result.ok) {
        vscode.window.showErrorMessage(`Magpylib Studio import failed: ${result.error}`);
        return;
      }
      importedScenes = result.scenes ?? [];
      followNewScene();
      if (result.warnings?.length) {
        vscode.window.showWarningMessage(
          `Magpylib Studio import: ${result.warnings.join('; ')}`,
        );
      }
      broadcastMutation();
      void showFrontScene();
      // The studio is its sidebar as much as its panel: the tree, the
      // inspector, the variables and the history are where an imported scene
      // is actually worked on. Leaving the container closed makes an import
      // look like it only drew a picture. This is the same act as clicking the
      // logo in the activity bar, and VS Code registers `<viewId>.focus` for
      // every contributed view, so no command of our own is needed.
      void vscode.commands.executeCommand('magpylib-studio.sceneView.focus');
      if (scene !== undefined) {
        // Asked for by a caller that already knows which one it wants, so the
        // prompt below is not for them -- including for scene 0, which the
        // import has just loaded and which is a choice like any other.
        if (scene > 0 && scene < importedScenes.length) {
          await mutateFromTree('load_captured', { scene });
        }
        return;
      }
      if (importedScenes.length > 1) {
        const choice = await vscode.window.showInformationMessage(
          `Magpylib Studio: imported "${importedScenes[0]}" — the script has ${importedScenes.length} scene candidates.`,
          'Switch Scene…',
        );
        if (choice) {
          await switchImportedScene();
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Magpylib Studio: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  /**
   * Offered wherever a variable is born, because a range given at that moment
   * is what makes it draggable, and hunting for a second command later is how
   * a slider never gets used. Enter skips it. Only the allowed range is asked
   * for: the slider falls back to it, and Set Bounds… covers the soft range
   * for when the two differ.
   */
  const askAllowedRange = async (
    name: string,
    whole = false,
    unit?: { unit: string | null; symbol: string },
  ) => {
    const symbol = unit?.symbol ?? '';
    // in the variable's unit, read by the engine: `10, 30` for a length shown
    // in mm is 10 mm to 30 mm
    const readPair = async (v: string): Promise<[number | null, number | null] | string> => {
      const parts = v.split(',');
      if (parts.length !== 2) {
        return 'min, max';
      }
      const ends: (number | null)[] = [];
      for (const part of parts) {
        if (!part.trim()) {
          ends.push(null);
          continue;
        }
        const read = await readQuantity(name, part);
        if (!read || read.error || read.value === undefined) {
          return read?.error ?? 'min, max — numbers';
        }
        ends.push(read.value);
      }
      return ends as [number | null, number | null];
    };
    const text = await vscode.window.showInputBox({
      prompt:
        `Allowed range for ${name}${symbol ? ` (${symbol})` : ''} — optional, ` +
        'and gives it a slider',
      placeHolder: `${rangeHint(unit?.unit, symbol)}. Enter to skip`,
      validateInput: async (v) => {
        if (v.trim() === '') {
          return undefined;
        }
        const read = await readPair(v);
        return typeof read === 'string' ? read : undefined;
      },
    });
    const read = text && text.trim() ? await readPair(text) : undefined;
    const pair = read && typeof read !== 'string' ? read : undefined;
    // `whole` is a fact about the variable, so it is recorded even when the
    // range is skipped — otherwise a count only becomes a count if you also
    // felt like bounding it.
    if (pair || whole) {
      await mutateFromTree('set_variable_bounds', {
        name,
        min: pair ? pair[0] : undefined,
        max: pair ? pair[1] : undefined,
        integer: whole,
      });
    }
  };

  /**
   * Set a variable from an input box. A plain number stays a number; anything
   * else is stored as an expression, so the user types `gap*2` rather than
   * remembering the document's `=` marker.
   */
  /**
   * Validation that teaches: the engine says why a value is not an
   * expression, as it is typed, rather than after it is rejected. Names are
   * not checked here — one that does not exist yet is offered for creation.
   */
  const checkExpression = async (text: string): Promise<string | undefined> => {
    if (!text.trim()) {
      return 'A number, or an expression';
    }
    if (Number.isFinite(Number(text.trim()))) {
      return undefined;
    }
    const result = (await (await getEngine(context)).request('check_expression', {
      text,
    })) as { ok: boolean; error?: string };
    return result.ok ? undefined : result.error;
  };

  /**
   * What text typed for a variable means, when it is a number and perhaps a
   * unit: the engine reads it (`quantity`), so `15` is 15 mm for a length
   * shown in mm and the units live in one place. Undefined for an expression,
   * which is stored as written.
   */
  const readQuantity = async (
    name: string,
    text: string,
    unit?: string,
  ): Promise<{ value?: number; error?: string } | undefined> => {
    if (!QUANTITY.test(text)) {
      return undefined;
    }
    const read = await (await getEngine(context)).request<{
      ok: boolean;
      value?: number;
      error?: string;
    }>('quantity', { name, text, ...(unit ? { unit } : {}) });
    return read.ok ? { value: read.value } : { error: read.error };
  };

  /**
   * The box a variable's value is typed into. Inside it, until something is
   * typed, examples: a bare number, one with a unit, an expression. Under it,
   * the rule: "a field, in T unless you type a unit". And as it is typed,
   * what the value means in the unit the scene holds it in (`= 0.001 T`).
   * `lead` names the variable: "a", or "a is a new variable".
   */
  const valueBox = async (
    name: string,
    unit: string | null | undefined,
    symbol: string | undefined,
    lead: string,
    value?: string,
  ): Promise<vscode.InputBoxOptions> => {
    const rule = unitRule(unit, symbol);
    return {
      prompt: `${lead} — ${rule || 'a number or an expression'}`,
      value,
      placeHolder: valueExamples(unit, symbol),
      validateInput: async (v) => {
        const read = await readQuantity(name, v, unit ?? undefined);
        if (read?.error) {
          return read.error;
        }
        return read?.value !== undefined && unit
          ? meaning(read.value, unit)
          : checkExpression(v);
      },
    };
  };

  const editVariable = async (variable: Variable, prompt?: string): Promise<boolean> => {
    // Same rule as the panel: only a leading '=' means an expression. A
    // name-valued variable is a string that is simply its own value. A number
    // is shown in the variable's unit, as the panel shows it.
    const isNumber = typeof variable.expression === 'number';
    const current =
      typeof variable.expression === 'string' && variable.expression.startsWith('=')
        ? variable.expression.slice(1)
        : isNumber
          ? inUnit(variable.expression as number, variable.shown) +
            (variable.shown?.symbol ? ` ${variable.shown.symbol}` : '')
          : String(variable.expression);
    const unit = variable.bounds?.unit;
    const text = await vscode.window.showInputBox(
      await valueBox(
        variable.name,
        unit,
        variable.shown?.symbol,
        prompt ?? variable.name,
        current,
      ),
    );
    if (text === undefined) {
      return false;
    }
    const read = await readQuantity(variable.name, text, unit);
    return mutateFromTree('set_variable', {
      name: variable.name,
      value: read?.value ?? asDocumentValue(text),
    });
  };

  /**
   * A new name for a variable. Only the name is asked for: the engine rewrites
   * every expression that refers to it, so nothing else has to be repointed by
   * hand and the scene comes out drawing exactly what it drew.
   */
  const renameVariable = async (variable: Variable): Promise<boolean> => {
    const name = await vscode.window.showInputBox({
      prompt: `Rename ${variable.name} — everything written in terms of it follows`,
      value: variable.name,
      validateInput: (v) =>
        /^[A-Za-z_]\w*$/.test(v)
          ? undefined
          : 'Letters, digits, underscores; must not start with a digit.',
    });
    if (!name || name === variable.name) {
      return false;
    }
    return mutateFromTree('rename_variable', { old: variable.name, new: name });
  };

  /**
   * What sort of thing a variable is. Not a formatting preference: a count of
   * 7.3 is meaningless rather than imprecise, and an axis is a name that no
   * range describes and no slider can offer.
   */
  const askVariableKind = async (
    name: string,
    bounds: Variable['bounds'] = {},
  ): Promise<VariableKind | undefined> => {
    const current: VariableKind = bounds?.options
      ? 'choice'
      : bounds?.integer
        ? 'whole'
        : 'number';
    // `kind` is spoken for on a QuickPickItem — VS Code uses it for
    // separators — so the payload travels as `is`.
    const items: { label: string; detail: string; is: VariableKind }[] = [
      {
        label: KIND_LABEL.number,
        detail: 'a length, an angle, a field — gets a slider',
        is: 'number',
      },
      {
        label: KIND_LABEL.whole,
        detail: 'it counts things — magnets, turns, copies',
        is: 'whole',
      },
      {
        label: KIND_LABEL.choice,
        detail: 'an axis (x, y, z) or a plane (xy, xz, yz) — gets a dropdown',
        is: 'choice',
      },
    ];
    // the one it already is, first, so re-opening this does not look like a
    // fresh decision
    items.sort((a, b) => Number(b.is === current) - Number(a.is === current));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${name} — what kind of value is it?`,
    });
    return picked?.is;
  };

  /**
   * The engine replaces a variable's limits wholesale, so changing one of them
   * means sending the others back unchanged. A key left undefined is a key the
   * request does not carry, which is how a limit gets cleared.
   */
  const applyBounds = async (variable: Variable, changes: VariableBounds) => {
    const merged = { ...(variable.bounds ?? {}), ...changes };
    return mutateFromTree('set_variable_bounds', {
      name: variable.name,
      min: merged.min,
      max: merged.max,
      soft_min: merged.soft_min,
      soft_max: merged.soft_max,
      integer: merged.integer,
      options: merged.options,
    });
  };

  /** One range, hard or soft, with the other left where it is. */
  const askRange = async (variable: Variable, which: 'hard' | 'soft') => {
    const bounds = variable.bounds ?? {};
    const [low, high] =
      which === 'hard'
        ? [bounds.min, bounds.max]
        : [bounds.soft_min, bounds.soft_max];
    // Shown and typed in the variable's unit, as the panel shows it; each end
    // read by the engine, so `10, 30` is millimetres for a length shown in mm
    // and `1, 3 cm` says so outright.
    const shown = variable.shown;
    const end = (value?: number) => (value === undefined ? '' : inUnit(value, shown));
    const readEnds = async (v: string): Promise<[number | null, number | null] | string> => {
      const parts = v.split(',');
      if (parts.length !== 2) {
        return 'min, max';
      }
      const ends: (number | null)[] = [];
      for (const part of parts) {
        if (!part.trim()) {
          ends.push(null);
          continue;
        }
        const read = await readQuantity(variable.name, part);
        if (!read || read.error || read.value === undefined) {
          return read?.error ?? 'min, max — numbers';
        }
        ends.push(read.value);
      }
      return ends as [number | null, number | null];
    };
    const text = await vscode.window.showInputBox({
      prompt:
        (which === 'hard'
          ? `${variable.name} — allowed range: a value outside it is refused`
          : `${variable.name} — slider range: the span worth dragging through`) +
        (shown?.symbol ? ` (${shown.symbol})` : ''),
      value: low !== undefined || high !== undefined ? `${end(low)}, ${end(high)}` : '',
      placeHolder:
        which === 'hard'
          ? `${rangeHint(bounds.unit, shown?.symbol)}. Empty for no limit`
          : `${rangeHint(bounds.unit, shown?.symbol)} — empty to drag ${rangeLabel(bounds.min, bounds.max, shown) ?? 'the allowed range, which is not set either'}`,
      validateInput: async (v) => {
        if (v.trim() === '') {
          return undefined;
        }
        const ends = await readEnds(v);
        return typeof ends === 'string' ? ends : undefined;
      },
    });
    if (text === undefined) {
      return;
    }
    const read = text.trim() === '' ? [null, null] : await readEnds(text);
    if (typeof read === 'string') {
      return; // validated above; nothing to apply
    }
    const [lo, hi] = read;
    // null is an end left empty, and an absent key is what clears one
    const ends = { low: lo ?? undefined, high: hi ?? undefined };
    if (which === 'soft') {
      await applyBounds(variable, { soft_min: ends.low, soft_max: ends.high });
      return;
    }
    // A soft range only marks the interesting part of the allowed one, so
    // narrowing the allowed range takes it along. The engine refuses the pair
    // outright, and "soft_max is outside max" is not an answer to give someone
    // who typed a smaller maximum and never mentioned the slider.
    const clamp = (value?: number) =>
      value === undefined
        ? undefined
        : Math.min(Math.max(value, ends.low ?? value), ends.high ?? value);
    await applyBounds(variable, {
      min: ends.low,
      max: ends.high,
      soft_min: clamp(bounds.soft_min),
      soft_max: clamp(bounds.soft_max),
    });
  };

  /** The values a choice variable may take. They replace a range rather than
   *  joining one: a name is not on a scale, so no slider applies to it. */
  const askOptions = async (variable: Variable) => {
    const text = await vscode.window.showInputBox({
      prompt: `${variable.name} — the values it may take`,
      value: (variable.bounds?.options ?? []).join(', '),
      placeHolder: 'comma-separated — e.g. x, y, z',
      validateInput: (v) =>
        parseChoices(v).length ? undefined : 'at least one value, comma-separated',
    });
    if (text === undefined) {
      return;
    }
    await mutateFromTree('set_variable_bounds', {
      name: variable.name,
      options: parseChoices(text),
    });
  };

  /**
   * Everything about a variable except its value: one pick, then the one box
   * it names.
   *
   * The limits were a wizard — what kind of value it is, then the allowed
   * range, then the slider range — which is the right shape while a variable
   * is being born and the wrong one every time after, when moving a single
   * limit meant answering all three questions again. The name is here too
   * rather than on a button of its own: it is an edit like the others, and the
   * row it would sit in is as wide as a sidebar. Each entry says what it
   * currently holds, so the menu also answers "what is this variable?" without
   * changing anything.
   */
  const editVariableProperties = async (variable: Variable) => {
    const bounds = variable.bounds ?? {};
    const options = bounds.options?.length ? bounds.options : undefined;
    const kind: VariableKind = options ? 'choice' : bounds.integer ? 'whole' : 'number';
    type Change = 'name' | 'hard' | 'soft' | 'options' | 'kind' | 'unit' | 'clear';
    const items: (vscode.QuickPickItem & { is: Change })[] = [
      {
        label: 'Name',
        description: variable.name,
        detail: 'Everything written in terms of it is rewritten to follow',
        is: 'name',
      },
    ];
    items.push(
      ...(options
        ? [
            {
              label: 'Values it may take',
              description: options.join(', '),
              detail: 'The dropdown this variable offers instead of a slider',
              is: 'options' as const,
            },
          ]
        : [
            {
              label: 'Allowed range',
              description: rangeLabel(bounds.min, bounds.max, variable.shown) ?? 'not set',
              detail: 'A value outside it is refused, however it was arrived at',
              is: 'hard' as const,
            },
            {
              label: 'Slider range',
              description:
                rangeLabel(bounds.soft_min, bounds.soft_max, variable.shown) ??
                'the allowed range',
              detail: 'Only the span dragging covers — a value outside stays legal',
              is: 'soft' as const,
            },
          ]),
    );
    items.push({
      label: 'Kind',
      description: KIND_LABEL[kind],
      detail: 'A quantity, something it counts, or one of a few names',
      is: 'kind',
    });
    if (!options) {
      const unit = UNIT_KINDS.find((u) => u.unit === (bounds.unit ?? null));
      items.push({
        label: 'Unit',
        description:
          (unit?.label ?? bounds.unit ?? 'No unit') +
          (variable.shown?.symbol ? `, shown in ${variable.shown.symbol}` : ''),
        detail: 'What it measures: shown and typed in that unit, while the value stays SI',
        is: 'unit',
      });
    }
    // a unit is not a limit, and clearing keeps it
    if (Object.keys(bounds).some((key) => key !== 'unit')) {
      items.push({
        label: 'Clear limits',
        detail: 'Nothing refused, no slider, no dropdown',
        is: 'clear',
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${variable.name} — what should change?`,
    });
    if (!picked) {
      return;
    }
    if (picked.is === 'name') {
      await renameVariable(variable);
      return;
    }
    if (picked.is === 'hard' || picked.is === 'soft') {
      await askRange(variable, picked.is);
      return;
    }
    if (picked.is === 'options') {
      await askOptions(variable);
      return;
    }
    if (picked.is === 'unit') {
      const chosen = await vscode.window.showQuickPick(
        UNIT_KINDS.map((u) => ({
          ...u,
          description: u.unit === (bounds.unit ?? null) ? 'current' : undefined,
        })),
        { placeHolder: `${variable.name} — what does it measure?` },
      );
      if (chosen && chosen.unit !== (bounds.unit ?? null)) {
        await mutateFromTree('set_variable_unit', { name: variable.name, unit: chosen.unit });
      }
      return;
    }
    if (picked.is === 'clear') {
      await mutateFromTree('set_variable_bounds', { name: variable.name });
      return;
    }
    const chosen = await askVariableKind(variable.name, bounds);
    if (!chosen || chosen === kind) {
      return;
    }
    if (chosen === 'choice') {
      await askOptions(variable);
      return;
    }
    // number <-> whole number: only what it counts changes, and whatever range
    // it already had still describes it
    await applyBounds(variable, { integer: chosen === 'whole', options: undefined });
  };

  /**
   * A history edit reports what it broke rather than refusing, so the result
   * needs saying out loud — silently leaving red entries behind would be the
   * one way this feature could mislead.
   */
  const applyLogEdit = async (method: string, params: Record<string, unknown>) => {
    const result = (await (await getEngine(context)).request(method, params)) as {
      ok: boolean;
      error?: string;
      broken?: { source: string; error: string }[];
    };
    if (!result.ok) {
      vscode.window.showErrorMessage(`Magpylib Studio: ${result.error}`);
    } else if (result.broken?.length) {
      const [first] = result.broken;
      vscode.window.showWarningMessage(
        `Magpylib Studio: ${result.broken.length} later ` +
          `${result.broken.length === 1 ? 'entry' : 'entries'} no longer ` +
          `${result.broken.length === 1 ? 'applies' : 'apply'} — ` +
          `${first.source} (${first.error}). Undo to put it back.`,
      );
    }
    broadcastMutation();
  };

  /**
   * A pattern, in the CAD sense: one step standing for N copies. Which kind
   * is asked first, because "around" and "along" are the same idea about a
   * different thing, and a grid is just "along" done twice.
   */
  const patternObject = async (obj: SceneObject) => {
    const kind = await vscode.window.showQuickPick(
      [
        {
          label: 'Around an axis',
          detail: 'evenly spaced about an axis — a ring, a rotor, a Halbach array',
          pattern: 'around',
        },
        {
          label: 'Along a direction',
          detail: 'evenly spaced in a line; pattern the group again for a grid',
          pattern: 'along',
        },
        {
          label: 'Mirrored',
          detail: 'one reflected copy — the polarization reflects as physics has it',
          pattern: 'mirror',
        },
      ],
      { placeHolder: `Pattern "${obj.label}"` },
    );
    if (!kind) {
      return;
    }
    if (kind.pattern === 'around') {
      await duplicateAround(obj);
    } else if (kind.pattern === 'along') {
      await duplicateAlong(obj);
    } else {
      await mirrorObject(obj);
    }
  };

  /** One reflected copy — see session.mirror for why it is not a sign flip. */
  const mirrorObject = async (obj: SceneObject) => {
    const plane = await vscode.window.showQuickPick(
      [
        { label: 'xy', detail: 'reflect through the xy plane (normal z)' },
        { label: 'xz', detail: 'reflect through the xz plane (normal y)' },
        { label: 'yz', detail: 'reflect through the yz plane (normal x)' },
      ],
      { placeHolder: `Mirror "${obj.label}" in which plane?` },
    );
    if (!plane) {
      return;
    }
    const length = (await unitView(context)).shown.length;
    const anchor = await askTerms(
      context,
      {
        prompt: `Point the plane passes through as x, y, z${inUnits(length)}`,
        value: '0, 0, 0',
      },
      3,
      length,
      'Three numbers or expressions',
    );
    if (!anchor) {
      return;
    }
    await mutateFromTree('mirror', { object_id: obj.id, plane: plane.label, anchor });
  };

  /** "N of these in a row" — see session.duplicate_along. */
  const duplicateAlong = async (obj: SceneObject) => {
    const count = await vscode.window.showInputBox({
      prompt: `Copies of "${obj.label}" in the row, counting the original`,
      value: '4',
      validateInput: (v) =>
        Number(v) >= 2 || /^[A-Za-z_]/.test(v.trim())
          ? undefined
          : 'A count of 2 or more, or a variable name',
    });
    if (!count) {
      return;
    }
    const length = (await unitView(context)).shown.length;
    const step = await askTerms(
      context,
      {
        prompt: `Step between copies as dx, dy, dz${inUnits(length)}`,
        value: shownText([2, 0, 0], length),
        placeHolder: 'numbers or expressions, e.g. pitch, 0, 0',
      },
      3,
      length,
      'Three numbers or expressions',
    );
    if (!step) {
      return;
    }
    await mutateFromTree('duplicate_along', {
      object_id: obj.id,
      count: asDocumentValue(count),
      step,
    });
  };

  /** "N of these around an axis" as one event — see session.duplicate_around. */
  const duplicateAround = async (obj: SceneObject) => {
    const count = await vscode.window.showInputBox({
      prompt: `Copies of "${obj.label}" around the axis, counting the original`,
      value: '6',
      validateInput: (v) =>
        Number(v) >= 2 || /^[A-Za-z_]/.test(v.trim())
          ? undefined
          : 'A count of 2 or more, or a variable name',
    });
    if (!count) {
      return;
    }
    const axis = await askRotationAxis();
    if (axis === undefined) {
      return;
    }
    const spin = await vscode.window.showQuickPick(
      [
        { label: 'Orbit only', detail: 'each copy keeps its orientation', spin: 0 },
        {
          label: 'Orbit and spin (Halbach)',
          detail: 'each copy also turns by one step in place',
          spin: 1,
        },
      ],
      { placeHolder: 'How should the copies be oriented?' },
    );
    if (!spin) {
      return;
    }
    await mutateFromTree('duplicate_around', {
      object_id: obj.id,
      count: asDocumentValue(count),
      axis,
      anchor: [0, 0, 0],
      // one step per copy, expressed against the count so it follows it
      spin: spin.spin ? `=360/(${count.trim()})` : 0,
    });
  };

  /** Sweep a variable and show the field against it in the Field panel. */
  const sweepVariable = async () => {
    const { variables: available } = await (await getEngine(context)).request<{
      variables: Variable[];
    }>('get_variables');
    if (!available.length) {
      vscode.window.showInformationMessage(
        'Magpylib Studio: define a variable first — a sweep varies one.',
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      available.map((v) => ({
        label: v.name,
        detail:
          typeof v.value === 'number'
            ? `currently ${inUnit(v.value, v.shown)}${v.shown?.symbol ? ` ${v.shown.symbol}` : ''}`
            : `currently ${v.value}`,
        v,
      })),
      { placeHolder: 'Variable to sweep' },
    );
    if (!pick) {
      return;
    }
    // In the variable's unit, as the panel shows it: from and to are read by
    // the engine, so `10, 30, 20` sweeps a length shown in mm from 10 to 30 mm.
    const shown = pick.v.shown;
    const now = typeof pick.v.value === 'number' ? pick.v.value : 0;
    const readSweep = async (v: string): Promise<[number, number, number] | string> => {
      const parts = v.split(',');
      if (parts.length !== 3) {
        return 'Three numbers: from, to, steps';
      }
      const ends: number[] = [];
      for (const part of parts.slice(0, 2)) {
        const read = await readQuantity(pick.v.name, part);
        if (!read || read.error || read.value === undefined) {
          return read?.error ?? 'Three numbers: from, to, steps';
        }
        ends.push(read.value);
      }
      const steps = Number(parts[2].trim());
      return Number.isFinite(steps) ? [ends[0], ends[1], steps] : 'steps is a number';
    };
    const range = await vscode.window.showInputBox({
      prompt:
        `Values for ${pick.label} — from, to, steps` +
        (shown?.symbol ? ` (${shown.symbol})` : ''),
      value: `${inUnit(now, shown)}, ${inUnit(now * 2 || 1 / (shown?.scale ?? 1), shown)}, 20`,
      validateInput: async (v) => {
        const read = await readSweep(v);
        return typeof read === 'string' ? read : undefined;
      },
    });
    if (!range) {
      return;
    }
    const read = await readSweep(range);
    if (typeof read === 'string') {
      return;
    }
    const [from, to, steps] = read;
    const count = Math.max(2, Math.round(steps));
    const values = Array.from(
      { length: count },
      (_, i) => from + ((to - from) * i) / (count - 1),
    );
    openFieldPanel(context);
    postToFieldPanel({ type: 'sweep', variable: pick.label, values });
  };

    /**
   * Writing `a*2` into a field is a clear way to say "and let me set `a`",
   * but the document cannot build until `a` exists — so ask for it here,
   * before the value is stored, rather than reporting a failure after.
   * A definition may itself introduce names (`a = b*2`), hence the loop.
   * Returns false if the user backed out, meaning: abandon the whole edit.
   */
  const ensureVariablesDefined = async (
    values: unknown,
    call?: { method: string; params: Record<string, unknown> },
  ): Promise<boolean> => {
    const engine = await getEngine(context);
    const { unknown } = await engine.request<{ unknown: string[] }>('unknown_variables', {
      values,
    });
    // What the box it was typed into measures: `gap` typed as a position is a
    // length, shown and read in the scene's length unit from the start rather than once someone
    // finds Variable Properties.
    const { units: measured } = unknown.length && call
      ? await engine.request<{ units: Record<string, { unit: string; symbol: string }> }>(
          'field_units',
          call,
        )
      : { units: {} as Record<string, { unit: string; symbol: string }> };
    for (const name of unknown) {
      const unit = measured[name];
      // A definition naming something that does not exist yet is rejected by
      // the engine, so stay on this one until it takes or the user gives up.
      for (;;) {
        const text = await vscode.window.showInputBox(
          await valueBox(
            name,
            unit?.unit,
            unit?.symbol,
            `${name} is a new variable`,
          ),
        );
        if (text === undefined) {
          return false;
        }
        const read = await readQuantity(name, text, unit?.unit);
        // what it measures in the same step as its value: one undo takes both
        const result = (await engine.request('set_variable', {
          name,
          value: read?.value ?? asDocumentValue(text),
          ...(unit ? { unit: unit.unit } : {}),
        })) as { ok: boolean; error?: string };
        if (result.ok) {
          await askAllowedRange(name, false, unit); // as the explicit flow
          break;
        }
        const retry = await vscode.window.showErrorMessage(
          `Magpylib Studio: ${result.error}`,
          'Try again',
        );
        if (retry !== 'Try again') {
          return false;
        }
      }
    }
    variablesTree?.refresh();
    return true;
  };

  /** Run a mutating engine call from the tree UI, surface failures, refresh.
   *
   * `checkVariables: false` is for a call that carries a whole document
   * rather than something typed into a box: a scene brings its own
   * variables, so scanning it for undefined ones would ask the user to
   * define the very names it is about to load.
   */
  const mutateFromTree = async (
    method: string,
    params: Record<string, unknown>,
    { checkVariables = true } = {},
  ): Promise<boolean> => {
    // An edit with no scene open starts one: Add Object on an empty side bar
    // means "in a new scene", not "nowhere".
    if (!actingScene() && !(await newSceneTab())) {
      return false;
    }
    // whatever was typed may name variables that do not exist yet
    if (
      checkVariables &&
      !(await ensureVariablesDefined(Object.values(params), { method, params }))
    ) {
      return false;
    }
    let ok = false;
    try {
      const result = (await (await getEngine(context)).request(method, params)) as {
        ok: boolean;
        error?: string;
        inserted_at?: number;
      };
      ok = result.ok;
      if (!result.ok) {
        vscode.window.showErrorMessage(`Magpylib Studio: ${result.error}`);
      } else if (result.inserted_at !== undefined) {
        // it went into the middle of the history, not the end — worth saying,
        // because the scene on screen is a preview and looks like the whole
        vscode.window.setStatusBarMessage(
          `Magpylib Studio: inserted at step ${result.inserted_at + 1} of the history`,
          3000,
        );
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Magpylib Studio: ${err instanceof Error ? err.message : err}`,
      );
    }
    broadcastMutation();
    return ok;
  };

  sceneDocEmitter = new vscode.EventEmitter<vscode.Uri>();
  const sceneDocProvider: vscode.TextDocumentContentProvider = {
    onDidChange: sceneDocEmitter.event,
    // the scene in front: VS Code asks inside whatever fired the change
    provideTextDocumentContent: async () =>
      JSON.stringify(await engineFor(context, frontScene() ?? scratch).request('to_dict'), null, 2),
  };

  // Fixed at activation rather than when the tab is first opened. VS Code
  // restores that tab across a window reload, and until the extension knows
  // the path it owns nothing: the restored tab keeps showing whichever scene
  // was open last, and neither refreshing nor save-to-apply reaches it.
  const scriptDir = context.storageUri ?? context.globalStorageUri;
  const scriptsDir = vscode.Uri.joinPath(scriptDir, 'scripts');

  /** A scene's script tab: named after the scene, in a folder keyed by where
   *  the scene is, so that two `ring.magpy.json` from different folders never
   *  share one, and a reload finds each again. */
  const scriptFileOf = (doc: SceneDocument) =>
    vscode.Uri.joinPath(
      scriptsDir,
      createHash('sha1').update(doc.uri.toString()).digest('hex').slice(0, 12),
      doc.name.replace(/\.magpy\.json$/, '') + '.py',
    );
  const isScriptFile = (uri: vscode.Uri) =>
    uri.scheme === 'file' && uri.fsPath.startsWith(scriptsDir.fsPath + path.sep);
  /** The open scene whose script tab `uri` is. */
  const sceneOfScript = (uri: vscode.Uri) =>
    openScenes().find((doc) => scriptFileOf(doc).fsPath === uri.fsPath);
  /** The scene acted on, or in front, without stopping on a closed one. */
  const sceneNow = () => {
    try {
      return actingScene();
    } catch {
      return frontScene();
    }
  };

  const exists = async (u: vscode.Uri) => {
    try {
      await vscode.workspace.fs.stat(u);
      return true;
    } catch {
      return false;
    }
  };

  /** The open editor for `doc`'s script tab, if one is open. */
  const scriptDocOf = (doc: SceneDocument) => {
    const file = scriptFileOf(doc);
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file.fsPath);
  };

  /**
   * Write the scene's script into the tab. Edits are never clobbered:
   * a scene change while the user is mid-edit leaves their text alone, unsaved
   * or held (see scriptHeld). `force` re-renders anyway — used when opening
   * the tab, and after a save the engine applied, where the scene is by
   * definition the truth and the tab is regenerated from it.
   */
  const writeScriptFile = async (doc: SceneDocument, force = false) => {
    const file = scriptFileOf(doc);
    const open = scriptDocOf(doc);
    if (!open && !force) {
      return; // no tab to keep in sync; opening one renders it fresh
    }
    if (!force && (open?.isDirty || doc.script.held)) {
      return;
    }
    const builder = await engineFor(context, doc).request<string>('to_builder_script');
    const text = SCRIPT_TAB_HEADER + builder;
    // Identical: don't churn the editor (it would move the cursor). What we
    // last wrote is only a safe stand-in for the file while the file is still
    // there — storage gets cleaned up, and openTextDocument would then fail.
    doc.script.rendered = text;
    if (text === doc.script.onDisk && (await exists(file))) {
      return;
    }
    doc.script.onDisk = text;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'));
    await vscode.workspace.fs.writeFile(file, Buffer.from(text, 'utf8'));
  };
  /** The tab could not be rendered or applied for a reason of the engine's
   *  own -- it died, or answered with an error -- which is said where engine
   *  trouble is said, not left as an unhandled rejection. */
  const reportScriptTabError = (err: unknown) => {
    engineOutput?.appendLine(`script tab: ${err instanceof Error ? err.message : err}`);
  };
  refreshScript = (doc?: SceneDocument) => {
    const target = doc ?? frontScene();
    if (target) {
      writeScriptFile(target).catch(reportScriptTabError);
    }
  };

  /**
   * The scene was replaced as a whole: opened, emptied, an example, an
   * import. Text the tab holds was written against the scene before, and a
   * save would put that one back over this one, so the tab lets go of it and
   * follows. Unsaved text is still never written over.
   */
  const followNewScene = (doc: SceneDocument | undefined = sceneNow()) => {
    if (doc?.script.held) {
      doc.script.held = false;
      refreshScript?.(doc);
    }
  };

  /** Before scenes were tabs, the one scene's script was `scene.py`; a tab of
   *  it VS Code brings back belongs to no scene now, and goes unless it holds
   *  unsaved text. */
  const closeOneSceneScriptTab = async () => {
    const old = vscode.Uri.joinPath(scriptDir, 'scene.py');
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.fsPath === old.fsPath &&
          !tab.isDirty,
      );
    if (tabs.length) {
      await vscode.window.tabGroups.close(tabs);
    }
  };

  /**
   * Re-render the script tab VS Code restored for `doc` from the previous
   * window, once its scene is open. The file holds the scene as it was then;
   * without this the tab reads as an older scene until closed and reopened.
   */
  const adoptRestoredScriptTab = async (doc: SceneDocument) => {
    const file = scriptFileOf(doc);
    const restored = vscode.window.tabGroups.all.some((group) =>
      group.tabs.some(
        (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === file.fsPath,
      ),
    );
    if (!restored) {
      return;
    }
    try {
      // A restored tab in a background group has no loaded document yet; open
      // it (no editor is shown) so its dirty state is knowable.
      const text = await vscode.workspace.openTextDocument(file);
      await writeScriptFile(doc, !text.isDirty); // hot exit may hold unsaved edits
    } catch (err) {
      engineOutput?.appendLine(`script tab: ${err instanceof Error ? err.message : err}`);
    }
  };

  /**
   * Saving the script tab applies it: the engine runs the scene function and
   * the scene it builds replaces this one, as one undo step (`docs/roadmap.md`
   * R1). Nothing is read back — the code is executed through the operations
   * the panel uses — and the function is lossless, so a number edited here comes
   * back as that number with every variable and pattern intact. That is what
   * plain magpylib could not do, and why #12 took apply-on-save away
   * (`docs/direction.md` §5.1); the engine refuses plain magpylib for the same
   * reason. A refused script stays in the tab, held, to be fixed and saved
   * again; an applied one is regenerated from the scene it made.
   */
  const applyScriptFile = (doc: vscode.TextDocument) => {
    const scene = sceneOfScript(doc.uri);
    if (!scene) {
      void vscode.window.showWarningMessage(
        "Magpylib Studio: this script tab's scene is not open, or has a new name; " +
          'open the scene and its script again to apply it.',
      );
      return Promise.resolve();
    }
    // everything below acts on the tab's own scene, whichever is in front
    return commandScene.run({ scene }, () => applyScriptTo(scene, doc));
  };

  const applyScriptTo = async (scene: SceneDocument, doc: vscode.TextDocument) => {
    // The file is the user's text now, not ours. Left stale, it could still
    // match the scene's rendering, and putting that back would be skipped as
    // a write that changes nothing (44c9529).
    scene.script.onDisk = doc.getText();
    // Written against a scene that has moved on since -- a drag in the panel,
    // an agent's edit, an undo, while this text sat unsaved or held -- the
    // tab would put that scene back, undoing whatever moved it, and nothing
    // about the text says so. Not knowing what it was written against (a tab
    // a reload restored with its unsaved text) is the same question.
    const now =
      SCRIPT_TAB_HEADER +
      (await (await getEngine(context)).request<string>('to_builder_script'));
    if (now !== scene.script.rendered && doc.getText() !== now) {
      const apply = 'Apply Anyway';
      const choice = await vscode.window.showWarningMessage(
        'Magpylib Studio: the scene changed after the script tab was written, so ' +
          'applying the tab would undo those changes. Apply it anyway?',
        { modal: true },
        apply,
      );
      if (choice !== apply) {
        scene.script.held = true; // kept, to carry over by hand or to apply later
        return;
      }
    }
    let result: {
      ok: boolean;
      error?: string;
      line?: number;
      unchanged?: boolean;
      warnings?: string[];
    };
    try {
      result = await (await getEngine(context)).request('apply_builder_script', {
        path: doc.uri.fsPath,
      });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!result.ok) {
      scene.script.held = true;
      const goTo = 'Go to Line';
      void vscode.window
        .showErrorMessage(
          `Magpylib Studio: the script was not applied, and the scene is as it was — ${result.error}`,
          ...(result.line ? [goTo] : []),
        )
        .then(async (choice) => {
          if (choice === goTo && result.line) {
            const at = new vscode.Position(result.line - 1, 0);
            // By its file: the tab may have been closed while the message
            // stood, and a closed document cannot be shown again.
            await vscode.window.showTextDocument(doc.uri, {
              selection: new vscode.Selection(at, at),
            });
          }
        });
      return;
    }
    scene.script.held = false;
    if (!result.unchanged) {
      broadcastMutation();
    }
    await writeScriptFile(scene, true);
    if (result.warnings?.length) {
      void vscode.window.showWarningMessage(
        `Magpylib Studio: script applied — ${result.warnings.join('; ')}`,
      );
    } else {
      vscode.window.setStatusBarMessage(
        result.unchanged
          ? 'Magpylib Studio: the script builds the scene as it is'
          : 'Magpylib Studio: scene updated from the script',
        3000,
      );
    }
  };

  /**
   * Export, not save: neither script is what Save writes, and neither becomes
   * the scene's file. Plain magpylib is for anyone, studio or not, and carries
   * no slider bounds and no hidden flags. The scene script is for whoever
   * keeps the scene as code: it builds the same document, variables and
   * patterns included, and unlike the script tab nothing regenerates it.
   */
  const exportScript = async (kind: 'magpylib' | 'builder') => {
    const front = actingScene();
    const folder = front?.baseDir
      ? vscode.Uri.file(front.baseDir)
      : vscode.workspace.workspaceFolders?.[0]?.uri;
    const name = front ? front.name.replace(/\.magpy\.json$/, '') : 'scene';
    // Beside the scene and sorted next to it, without taking the plain
    // export's name: a folder may well hold both.
    const file = kind === 'builder' ? `${name}_build.py` : `${name}.py`;
    const target = await vscode.window.showSaveDialog({
      filters: { 'Python script': ['py'] },
      defaultUri: folder && vscode.Uri.joinPath(folder, file),
      saveLabel: kind === 'builder' ? 'Export Scene Script' : 'Export Script',
    });
    if (!target) {
      return;
    }
    const engine = await getEngine(context);
    const script =
      kind === 'builder'
        ? await engine.request<string>('to_builder_script')
        : (await engine.request<string>('to_script')) + '\n';
    await vscode.workspace.fs.writeFile(target, Buffer.from(script, 'utf8'));
    const open = await vscode.window.showInformationMessage(
      `Magpylib Studio: exported ${basename(target)}`,
      'Open',
    );
    if (open === 'Open') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    }
  };

  recoveryDir = vscode.Uri.joinPath(scriptDir, 'recovery');
  leftBehindFound = findLeftBehind();

  /** The scene `uri` once VS Code has opened its document. */
  const sceneOpened = async (uri: vscode.Uri): Promise<SceneDocument | undefined> => {
    for (let i = 0; i < 40; i++) {
      const doc = sceneFor(uri);
      if (doc) {
        return doc;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  };

  /** Open `uri` in its tab, or bring its tab forward, and put it in front.
   *  Where the scene in front is, rather than wherever the focus happens to
   *  be: the script tab beside the scenes stays in sight. */
  const openSceneTab = async (uri: vscode.Uri, preview = false): Promise<SceneDocument | undefined> => {
    const [beside] = frontScene()?.panels ?? [];
    await vscode.commands.executeCommand('vscode.openWith', uri, SCENE_VIEW_TYPE, {
      preview,
      viewColumn: beside?.viewColumn ?? vscode.ViewColumn.One,
    });
    const doc = await sceneOpened(uri);
    if (doc) {
      actOn(doc);
    }
    return doc;
  };

  /** A name for a new untitled scene, free among the open scenes and the
   *  files: `Untitled-1`, or an example's own name. It is named in the
   *  workspace folder, where its first save then starts rather than at the
   *  root of the disk (plans/several-scenes.md §8). */
  const untitledScene = async (stem?: string): Promise<vscode.Uri> => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const taken = new Set(openScenes().map((doc) => doc.name));
    for (let n = 1; ; n++) {
      const name = `${stem && n === 1 ? stem : `${stem ?? 'Untitled'}-${n}`}${SCENE_EXTENSION}`;
      const uri = folder
        ? vscode.Uri.joinPath(folder, name).with({ scheme: 'untitled' })
        : vscode.Uri.parse(`untitled:${name}`);
      if (!taken.has(name) && !(folder && (await exists(vscode.Uri.joinPath(folder, name))))) {
        return uri;
      }
    }
  };

  /** A new untitled scene in a tab of its own, in front. */
  const newSceneTab = async (): Promise<SceneDocument | undefined> => {
    const uri = await untitledScene();
    rememberExample(uri, undefined); // a tab of that name long closed held one
    return openSceneTab(uri);
  };

  /** An example in a preview tab, in front: clean, so the next example takes
   *  its place without asking, and pinned by its first edit, which VS Code
   *  does for a tab that has unsaved changes. The same example, untouched,
   *  is brought forward rather than opened twice. */
  const exampleTab = async (example: string): Promise<SceneDocument | undefined> => {
    const open = openScenes().find((doc) => doc.example === example && !doc.dirty && doc.untitled);
    if (open) {
      return openSceneTab(open.uri, true);
    }
    const uri = await untitledScene(example);
    rememberExample(uri, example);
    return openSceneTab(uri, true);
  };

  /** What VS Code is about to open for Save As's destination: the session of
   *  the scene saved there, which the new document adopts instead of reading
   *  the file -- its undo, its selection. */
  const handovers = new Map<
    string,
    {
      doc: SceneDocument;
      timer: ReturnType<typeof setTimeout>;
      text?: string;
      /** A rename's: the scene arrives with its unsaved changes, which VS
       *  Code drops from the tab it opens for the new name. */
      dirty?: boolean;
    }
  >();

  /** Hand `doc`'s session to the document VS Code is about to open at `to`:
   *  for Save As, which wrote the file there, and for a rename or a move in
   *  the Explorer. Nothing adopting it within ten seconds -- saved under a
   *  name the studio does not open, a rename that failed -- lets it go. */
  const handOver = (
    doc: SceneDocument,
    to: vscode.Uri,
    carried: { text?: string; dirty?: boolean },
  ) => {
    doc.handedOver = true;
    const key = to.toString();
    clearTimeout(handovers.get(key)?.timer);
    handovers.set(key, {
      doc,
      ...carried,
      timer: setTimeout(() => {
        handovers.delete(key);
        doc.handedOver = false;
        if (!openScenes().includes(doc)) {
          closeSession(doc);
        }
      }, 10_000),
    });
  };

  const closeSession = (doc: SceneDocument) => {
    if (engine?.isRunning && doc.engine === engine) {
      engine.request('close_session', { session: doc.session }).catch(() => {});
    }
  };

  const disposeScene = (doc: SceneDocument) => {
    doc.watcher?.dispose();
    // its script tab goes with it, unless it holds unsaved text
    const script = scriptFileOf(doc);
    const scriptTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.fsPath === script.fsPath &&
          !tab.isDirty,
      );
    if (scriptTabs.length && !doc.handedOver) {
      void vscode.window.tabGroups.close(scriptTabs);
    }
    if (doc === fieldScene) {
      fieldPanel?.dispose(); // its scene is gone
    }
    removeScene(doc);
    dropRecovery(doc);
    if (!doc.handedOver) {
      closeSession(doc);
    }
    // Closed, unless its tab is still there: a window shutting down keeps it,
    // and fills it again on the next start.
    const kept = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .some((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === doc.uri.toString());
    if (doc.example && !kept) {
      rememberExample(doc.uri, undefined);
    }
  };

  /** The scene's document, written to `target`. A scene that could not be
   *  read is shown empty, and that empty scene must not go over the file. */
  const writeScene = async (doc: SceneDocument, target: vscode.Uri) => {
    if (doc.problem) {
      throw new Error(`${doc.name} could not be read (${doc.problem}), so it is not written`);
    }
    const scene = await engineFor(context, doc).request('to_dict');
    const text = JSON.stringify(scene, null, 2) + '\n';
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    doc.lastDocument = scene;
    if (target.toString() === doc.uri.toString()) {
      doc.diskText = text;
      doc.diskNote = undefined;
    }
    return text;
  };

  /** The file's text now, or undefined when it is not there. */
  const readText = (uri: vscode.Uri) =>
    vscode.workspace.fs.readFile(uri).then(
      (bytes) => Buffer.from(bytes).toString('utf8'),
      () => undefined,
    );

  /** Redraw what shows `doc` without marking it edited: the file's version
   *  taken in, which is what the file holds. */
  const redrawScene = (doc: SceneDocument) => {
    for (const panel of doc.panels) {
      void panel.webview.postMessage({ type: 'refresh' });
    }
    sceneTree?.refresh(doc);
    followNewScene(doc);
    if (doc === frontScene()) {
      refreshSurfaces();
    }
  };

  /**
   * The file of `doc`, changed elsewhere -- git, another editor, an agent --
   * comes in as one undo step named "changed on disk", unsaved edits or not
   * (decided): what the tab had is one undo away, and a notice says so when
   * it was unsaved. A write of this tab's own, or a burst that ends where it
   * began, is nothing. A file that does not read is not loaded, and the row
   * says so; Save then asks before writing over it.
   */
  const takeFromDisk = async (doc: SceneDocument, { asked = false } = {}) => {
    const text = await readText(doc.uri);
    if (text === undefined) {
      doc.diskNote = 'deleted on disk';
      sceneTree?.refresh();
      return;
    }
    if (text === doc.diskText && !asked) {
      if (doc.diskNote) {
        doc.diskNote = undefined; // back as it was
        sceneTree?.refresh();
      }
      return;
    }
    let scene: unknown;
    try {
      scene = JSON.parse(text);
    } catch (err) {
      doc.diskNote = 'changed on disk, not loaded';
      sceneTree?.refresh();
      const answer = await vscode.window.showWarningMessage(
        `Magpylib Studio: ${doc.name} changed on disk and does not read as a scene ` +
          `(${err instanceof Error ? err.message : err}), so it was not loaded. The ` +
          'scene in the tab is as it was; saving asks before writing over the file.',
        'Load Again',
        'Open as Text',
      );
      if (answer === 'Load Again') {
        await takeFromDisk(doc, { asked: true });
      } else if (answer === 'Open as Text') {
        await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
      }
      return;
    }
    const engine = engineFor(context, doc);
    const now = await engine.request('to_dict');
    if (JSON.stringify(now, null, 2) + '\n' === text) {
      doc.diskText = text; // the same scene, written another way round
      doc.diskNote = undefined;
      sceneTree?.refresh();
      return;
    }
    const result = await engine.request<{ ok: boolean; error?: string }>('replace_scene', {
      scene,
      base_dir: doc.baseDir ?? null,
      label: 'changed on disk',
    });
    if (!result.ok) {
      doc.diskNote = 'changed on disk, not loaded';
      sceneTree?.refresh();
      void vscode.window.showWarningMessage(
        `Magpylib Studio: ${doc.name} changed on disk and was not loaded -- ${result.error}. ` +
          'Saving asks before writing over the file.',
      );
      return;
    }
    doc.diskText = text;
    doc.diskNote = undefined;
    doc.lastDocument = scene;
    redrawScene(doc);
    if (doc.dirty) {
      void vscode.window.showInformationMessage(
        `Magpylib Studio: ${doc.name} changed on disk, and the tab now shows the file's ` +
          'version. Your unsaved changes are one undo away.',
      );
    } else {
      vscode.window.setStatusBarMessage(
        `Magpylib Studio: ${doc.name} changed on disk; the tab shows the new version`,
        4000,
      );
    }
  };

  /** Watch `doc`'s file. A burst of events -- git deletes then creates --
   *  settles before the file is read. */
  const watchFile = (doc: SceneDocument) => {
    if (doc.uri.scheme !== 'file') {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(doc.uri.fsPath)), doc.name),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void takeFromDisk(doc).catch(() => {}), 300);
    };
    watcher.onDidChange(soon);
    watcher.onDidCreate(soon);
    watcher.onDidDelete(soon);
    doc.watcher = new vscode.Disposable(() => {
      clearTimeout(timer);
      watcher.dispose();
    });
  };

  /** Before a save writes over the file: unchanged since this tab read or
   *  wrote it, it goes ahead; changed, the person says what wins. */
  const checkBeforeSave = async (doc: SceneDocument) => {
    const text = await readText(doc.uri);
    if (text === undefined || doc.diskText === undefined || text === doc.diskText) {
      return;
    }
    const overwrite = 'Overwrite';
    const load = "Load the File's Version";
    const compare = 'Compare';
    const answer = await vscode.window.showWarningMessage(
      `${doc.name} changed on disk since this tab read or wrote it.`,
      {
        modal: true,
        detail:
          "Overwrite writes the tab's scene over it. Load the File's Version puts " +
          "the file's in the tab, the tab's one undo away.",
      },
      overwrite,
      load,
      compare,
    );
    if (answer === overwrite) {
      return;
    }
    if (answer === load) {
      await takeFromDisk(doc, { asked: true });
    } else if (answer === compare) {
      const scene = await engineFor(context, doc).request('to_dict');
      const mine = vscode.Uri.joinPath(scriptDir, 'compare', doc.name);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(scriptDir, 'compare'));
      await vscode.workspace.fs.writeFile(
        mine,
        Buffer.from(JSON.stringify(scene, null, 2) + '\n', 'utf8'),
      );
      await vscode.commands.executeCommand(
        'vscode.diff',
        doc.uri,
        mine,
        `${doc.name}: on disk ↔ in the tab`,
      );
    }
    throw new vscode.CancellationError(); // not saved: the person is deciding
  };

  /** A save has written what the scene held at `revision`. VS Code clears the
   *  dot as the save returns, whatever came meanwhile: an edit that did is
   *  told again, so its tab stays marked. */
  const saved = (doc: SceneDocument, revision: number) => {
    if (doc.revision === revision) {
      doc.dirty = false;
      dropRecovery(doc);
    } else {
      setTimeout(() => sceneEdited.fire({ document: doc }), 0);
    }
    showSceneFile();
  };

  /** Put a recovery copy into the scene it is a copy of, as one step to undo,
   *  and let the copy go. */
  const restoreCopy = async (
    doc: SceneDocument,
    left: { copy: vscode.Uri; origin: vscode.Uri },
  ) => {
    const scene = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(left.copy)).toString('utf8'));
    const restored = await inScene(doc.key, () =>
      mutateFromTree(
        'replace_scene',
        { scene, base_dir: doc.baseDir ?? null },
        { checkVariables: false },
      ),
    );
    if (restored) {
      discardCopy(left);
    }
  };

  /** A scene opened without the changes it had when VS Code last closed
   *  without saving them -- its tab came back from the file, VS Code's
   *  editor state being older than the edits (plans/several-scenes.md §8). */
  const offerRecovery = async (
    doc: SceneDocument,
    left: { copy: vscode.Uri; origin: vscode.Uri; saved: number },
  ) => {
    const when = new Date(left.saved).toLocaleString();
    const answer = await vscode.window.showWarningMessage(
      `Magpylib Studio: ${doc.name} had unsaved changes when VS Code last closed ` +
        `(${when}), which it did not bring back. Restore them?`,
      'Restore',
      'Discard',
    );
    if (answer === 'Restore') {
      await restoreCopy(doc, left);
    } else if (answer === 'Discard') {
      discardCopy(left);
    }
  };

  /**
   * After an extension-host restart VS Code leaves the scene tabs open but
   * hands none of them to this extension host (plans/several-scenes.md §8),
   * and they are dead: a tab shown in its group with no scene a moment later
   * is closed and opened again, its unsaved work offered back from its
   * recovery copy. A tab behind another loads only when shown, so only the
   * one in front of its group is looked at -- now, and as each is shown.
   */
  const reviveDeadTabs = () => {
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.activeTab;
      const input = tab?.input;
      if (
        !tab ||
        !(input instanceof vscode.TabInputCustom) ||
        input.viewType !== SCENE_VIEW_TYPE ||
        sceneFor(input.uri)
      ) {
        continue;
      }
      const revive = async () => {
        if (sceneFor(input.uri) || !group.tabs.includes(tab) || group.activeTab !== tab) {
          return; // it loaded, or it went
        }
        engineOutput?.appendLine(`[reopening ${input.uri.toString()}: its tab had no scene]`);
        const column = group.viewColumn;
        await vscode.window.tabGroups.close(tab, true);
        await vscode.commands.executeCommand('vscode.openWith', input.uri, SCENE_VIEW_TYPE, {
          viewColumn: column,
          preserveFocus: true,
          preview: false,
        });
      };
      // longer than a scene takes to open, the engine starting included
      setTimeout(() => void revive(), 3000);
    }
  };

  /** The copies no tab claims, once the window has restored its tabs: scenes
   *  opened since VS Code last saved its editor state, so it does not know
   *  them at all. Offered together, once. */
  const offerLeftBehind = async () => {
    await leftBehindFound;
    const open = new Set(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => (tab.input instanceof vscode.TabInputCustom ? tab.input.uri.toString() : '')),
    );
    const unclaimed = [...leftBehind].filter(([uri]) => !open.has(uri));
    if (!unclaimed.length) {
      return;
    }
    const names = unclaimed.map(([uri]) => vscode.Uri.parse(uri).path.split('/').pop());
    const answer = await vscode.window.showWarningMessage(
      `Magpylib Studio: ${names.join(', ')} had unsaved changes when VS Code last ` +
        'closed, and their tabs did not come back. Open them with those changes?',
      'Open',
      'Discard',
    );
    for (const [uri, left] of unclaimed) {
      leftBehind.delete(uri);
      if (answer === 'Discard') {
        discardCopy(left);
      } else if (answer === 'Open') {
        const origin = vscode.Uri.parse(uri);
        const doc =
          origin.scheme === 'file' && (await exists(origin))
            ? await openSceneTab(origin)
            : await newSceneTab();
        if (doc) {
          await restoreCopy(doc, left);
        }
      }
    }
  };

  const sceneEditor: vscode.CustomEditorProvider<SceneDocument> = {
    onDidChangeCustomDocument: sceneEdited.event,
    async openCustomDocument(uri, opening) {
      const handed = handovers.get(uri.toString());
      if (handed) {
        handovers.delete(uri.toString());
        clearTimeout(handed.timer);
        const doc = new SceneDocument(uri, disposeScene);
        doc.session = handed.doc.session;
        doc.engine = handed.doc.engine;
        doc.opening = handed.doc.opening;
        doc.lastDocument = handed.doc.lastDocument;
        doc.selected = handed.doc.selected;
        doc.diskText = handed.text;
        addScene(doc);
        watchFile(doc);
        // Moved to another folder, its relative mesh paths still mean the
        // same files from the new one -- a change to the scene, saved like
        // any other. The unsaved changes a rename brought are told to VS
        // Code again, which opened the new name clean.
        const before = handed.doc.baseDir;
        let changed = handed.dirty ?? false;
        if (before !== doc.baseDir && uri.scheme === 'file') {
          const moved = await engineFor(context, doc)
            .request<{ ok: boolean; rebased?: number }>('set_base_dir', {
              path: doc.baseDir ?? null,
              rebase: true,
            })
            .catch(() => ({ ok: false, rebased: 0 }));
          changed ||= (moved.rebased ?? 0) > 0;
        }
        if (changed) {
          doc.dirty = true;
          setTimeout(() => {
            sceneEdited.fire({ document: doc });
            scheduleSettle(context, doc);
            showSceneFile();
          }, 0);
        }
        return doc;
      }
      const doc = new SceneDocument(uri, disposeScene);
      try {
        let bytes: Uint8Array | undefined;
        if (opening.backupId) {
          bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(opening.backupId));
          doc.dirty = true;
        } else if (opening.untitledDocumentData?.byteLength) {
          bytes = opening.untitledDocumentData;
          doc.dirty = true;
        } else if (uri.scheme !== 'untitled') {
          bytes = await vscode.workspace.fs.readFile(uri);
          doc.diskText = Buffer.from(bytes).toString('utf8');
        } else {
          // an example, just picked or untouched since: clean, so no backup
          doc.example = rememberedExample(uri);
        }
        if (doc.diskText === undefined && uri.scheme === 'file') {
          // restored from a backup: the file is what its edits were made on
          doc.diskText = await readText(uri);
        }
        if (bytes?.byteLength) {
          doc.lastDocument = JSON.parse(Buffer.from(bytes).toString('utf8'));
        }
      } catch (err) {
        doc.problem = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Magpylib Studio: could not read ${doc.name} -- ${doc.problem}. ` +
            'It is shown empty, and will not be saved over.',
        );
      }
      addScene(doc);
      watchFile(doc);
      try {
        // Opened now, so the tab's first draw finds its scene there.
        await openSession(await getRawEngine(context), doc);
        void adoptRestoredScriptTab(doc);
      } catch {
        // No engine: starting one has said why, and the scene opens with it.
      }
      await leftBehindFound;
      const left = leftBehind.get(uri.toString());
      if (left) {
        leftBehind.delete(uri.toString());
        const savedSince =
          uri.scheme === 'file' &&
          (await vscode.workspace.fs.stat(uri).then(
            (stat) => stat.mtime >= left.saved,
            () => false,
          ));
        if (opening.backupId || opening.untitledDocumentData?.byteLength || savedSince) {
          discardCopy(left); // VS Code brought the work back itself, or it was saved after
        } else {
          setTimeout(() => void offerRecovery(doc, left), 300);
        }
      }
      return doc;
    },
    async resolveCustomEditor(doc, panel) {
      adoptScenePanel(context, doc, panel);
    },
    async saveCustomDocument(doc) {
      await checkBeforeSave(doc);
      const revision = doc.revision;
      await writeScene(doc, doc.uri);
      saved(doc, revision);
    },
    async saveCustomDocumentAs(doc, destination) {
      // Written with its mesh paths already meaning the new folder, and put
      // back if the write fails: a save that did not happen leaves the scene
      // as it was.
      const scene = engineFor(context, doc);
      const folder = path.dirname(destination.fsPath);
      const moving = doc.baseDir !== folder;
      if (moving) {
        await scene.request('set_base_dir', { path: folder, rebase: true });
      }
      let text: string;
      try {
        text = await writeScene(doc, destination);
      } catch (err) {
        if (moving) {
          await scene.request('set_base_dir', { path: doc.baseDir ?? null, rebase: true });
        }
        throw err;
      }
      handOver(doc, destination, { text });
    },
    async revertCustomDocument(doc) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString('utf8');
      const scene = JSON.parse(text);
      // One step to undo: what the tab had is one undo away.
      const result = await engineFor(context, doc).request<{ ok: boolean; error?: string }>(
        'replace_scene',
        { scene, base_dir: doc.baseDir ?? null },
      );
      if (!result.ok) {
        throw new Error(result.error);
      }
      doc.problem = undefined;
      doc.lastDocument = scene;
      doc.diskText = text;
      doc.diskNote = undefined;
      doc.dirty = false;
      dropRecovery(doc);
      for (const panel of doc.panels) {
        void panel.webview.postMessage({ type: 'refresh' });
      }
      followNewScene(doc);
      if (doc === frontScene()) {
        showSceneFile();
        refreshSurfaces();
      }
    },
    async backupCustomDocument(doc, { destination }) {
      await writeScene(doc, destination);
      return {
        id: destination.toString(),
        delete: () => {
          void vscode.workspace.fs.delete(destination).then(undefined, () => {});
        },
      };
    },
  };

  /** The Undo view, which names the scene its history is of. */
  const historyView = vscode.window.createTreeView('magpylib-studio.historyView', {
    treeDataProvider: history,
  });
  const openList = new OpenScenesProvider(
    context.extensionUri,
    sceneRoots,
    (doc) => doc === frontScene(),
    (doc) => shownRoots().some((root) => root.doc === doc),
  );
  openScenesList = openList;
  const openScenesView = vscode.window.createTreeView('magpylib-studio.openScenesView', {
    treeDataProvider: openList,
    canSelectMany: true,
  });
  /** Objects says which scene it shows, or how many. */
  const describeObjects = () => {
    const shown = shownRoots();
    if (sceneTreeView) {
      sceneTreeView.description =
        shown.length === 1 ? shown[0].uri.path.split('/').pop() : shown.length ? `${shown.length} scenes` : undefined;
    }
  };
  // What is picked in Open Scenes is what Objects shows. The scene in front
  // stays in front when it is among them; else the last one picked comes.
  openScenesView.onDidChangeSelection((event) => {
    for (const root of event.selection) {
      if (!root.doc) {
        void loadSceneTab(root);
      }
    }
    const picked = event.selection
      .map((root) => root.doc)
      .filter((doc): doc is SceneDocument => doc !== undefined);
    if (!picked.length) {
      return;
    }
    shownScenes = new Set(picked);
    const front = frontScene();
    if (!front || !shownScenes.has(front)) {
      bringToFront(picked[picked.length - 1]);
    }
    describeObjects();
    tree.refresh();
    openList.refresh(); // which logos are in colour
  });
  /** A scene brought in front that is not shown -- its tab clicked -- is
   *  picked, alone, as clicking it in Open Scenes would. */
  const pickFront = (doc: SceneDocument | undefined) => {
    if (doc && !shownScenes.has(doc)) {
      shownScenes = new Set([doc]);
      const row = openList.rowOf(doc);
      if (row && openScenesView.visible) {
        void openScenesView.reveal(row, { select: true, focus: false });
      }
    }
    describeObjects();
    openList.refresh();
  };

  sceneTreeView = vscode.window.createTreeView('magpylib-studio.sceneView', {
    treeDataProvider: tree,
    showCollapseAll: true,
    dragAndDropController: tree,
  });
  showSceneFile();

  context.subscriptions.push(
    sceneTreeView,
    sceneDocEmitter,
    // A reload brings the tabs back, and without these VS Code has no way to
    // put anything in them: the scene and the script tab both come back, and
    // the 3D view coming back empty is the odd one out.
    // A scene is a tab of its own now: the one 3D panel an older version left
    // open is closed, and its scene opened as a tab (upgradeRememberedScene).
    vscode.window.registerWebviewPanelSerializer(STUDIO_PANEL, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        panel.dispose();
      },
    }),
    vscode.window.registerCustomEditorProvider(SCENE_VIEW_TYPE, sceneEditor, {
      // Only here does a custom editor take it (plans/several-scenes.md §8).
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    // Renamed or moved in the Explorer: the open scene goes with its file,
    // unsaved changes and undo and all (plans/several-scenes.md §4).
    vscode.workspace.onWillRenameFiles((event) => {
      for (const { oldUri, newUri } of event.files) {
        for (const doc of openScenes()) {
          const from = oldUri.toString();
          const at = doc.uri.toString();
          const to =
            at === from
              ? newUri
              : at.startsWith(from + '/')
                ? vscode.Uri.parse(newUri.toString() + at.slice(from.length))
                : undefined;
          if (to) {
            handOver(doc, to, { text: doc.diskText, dirty: doc.dirty });
          }
        }
      }
    }),
    // A scene opened or closed, or a tab moved: the tree's scene rows, and
    // whether there is any scene to close.
    openScenesView,
    onDidChangeScenes(() => {
      tree.refresh();
      openList.refresh();
      describeObjects();
      showScenesOpen();
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      tree.refresh();
      openList.refresh();
      showScenesOpen();
      reviveDeadTabs();
    }),
    // Every view of one scene shows the scene in front.
    onDidChangeFront((doc) => {
      // Brought in front by a running command itself -- a scene it opened, a
      // row it read -- that scene is the command's from here.
      const box = commandScene.getStore();
      if (box && doc) {
        box.scene = doc;
      }
      pickFront(doc);
      // The views below the tree show the scene in front, and say which.
      const shown = doc && { key: doc.key, name: doc.name };
      variablesTree?.show(shown);
      inspector?.show(shown);
      historyView.description = doc?.name;
      selectedObjectId = doc?.selected;
      inspector?.select(selectedObjectId);
      showSceneFile();
      refreshSurfaces();
    }),
    vscode.window.registerWebviewPanelSerializer(FIELD_PANEL, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        adoptFieldPanel(context, panel);
      },
    }),
    // The interpreter is a setting, so changing it has to mean something
    // without a reload. The engine is restarted rather than left running on
    // the old one — and the restart goes through the same backup the crash
    // path uses, so the scene survives being moved to another interpreter.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('magpylib-studio.pythonPath')) {
        return;
      }
      cachedPython = undefined;
      refusedEngine = undefined;
      if (engine?.isRunning) {
        vscode.window.setStatusBarMessage(
          'Magpylib Studio: restarting the engine on the new interpreter',
          3000,
        );
        engine.dispose();
        refreshSurfaces(); // asks for the scene, which starts the new one
      }
    }),
    // No retainContextWhenHidden: the guide calls it a last resort for good
    // reason (it keeps the whole webview running), and neither sidebar view
    // needs it — both rebuild from the engine the moment they report ready.
    vscode.window.registerWebviewViewProvider(InspectorViewProvider.viewId, inspector),
    historyView,
    vscode.window.registerWebviewViewProvider(VariablesViewProvider.viewId, variables),
    registerCommand('magpylib-studio.setUnits', async () => {
      // One button for both: what lengths are shown in, and what fields are.
      const { model_unit: length, field_unit: field } = await (
        await getEngine(context)
      ).request<{ model_unit: string; field_unit: string }>('get_units');
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: 'Length',
            description: length,
            detail: 'positions, sizes, length variables — and what a CAD export writes',
            command: 'magpylib-studio.setLengthUnit',
          },
          {
            label: 'Field',
            description: field,
            detail: 'polarizations, field variables, the field plots',
            command: 'magpylib-studio.setFieldUnit',
          },
        ],
        { placeHolder: 'Units the scene is shown in — its numbers stay SI' },
      );
      if (pick) {
        await vscode.commands.executeCommand(pick.command);
      }
    }),
    registerCommand('magpylib-studio.setFieldUnit', async () => {
      // What a field is shown in; the document's numbers stay tesla.
      const { field_unit: current } = await (
        await getEngine(context)
      ).request<{ field_unit: string }>('get_units');
      const pick = await vscode.window.showQuickPick(
        FIELD_UNITS.map((unit) => ({
          label: unit,
          description: unit === current ? 'current' : undefined,
        })),
        { placeHolder: 'Show fields in — the scene stays in tesla' },
      );
      if (pick && pick.label !== current) {
        await mutateFromTree('set_field_unit', { unit: pick.label });
      }
    }),
    registerCommand('magpylib-studio.setLengthUnit', async () => {
      // What lengths are shown in, and what an export to a CAD or FEM tool
      // writes. The document's numbers stay metres either way.
      const { model_unit: current } = await (
        await getEngine(context)
      ).request<{ model_unit: string }>('get_variables');
      const pick = await vscode.window.showQuickPick(
        LENGTH_UNITS.map((unit) => ({
          label: unit,
          description: unit === current ? 'current' : undefined,
        })),
        { placeHolder: 'Show lengths in — the scene stays in metres' },
      );
      if (pick && pick.label !== current) {
        await mutateFromTree('set_model_unit', { unit: pick.label });
      }
    }),
    registerCommand('magpylib-studio.addVariable', async () => {
      const {
        model_unit: lengthUnit,
        field_unit: fieldUnit,
        variables: existing,
      } = await (await getEngine(context)).request<{
        model_unit: string;
        field_unit: string;
        variables: Variable[];
      }>('get_variables');
      // what a bare number of each kind is read in
      const shownIn = (unit: string | null) =>
        unit === 'length' ? lengthUnit : unit === 'field' ? fieldUnit : undefined;
      // a name that exists would be overwritten, and its value read in what
      // the old one measured
      const taken = new Set(existing.map((v) => v.name));
      const name = await vscode.window.showInputBox({
        prompt: 'Variable name',
        placeHolder: 'letters, digits, underscores — e.g. gap, n, radius',
        validateInput: (v) =>
          !/^[A-Za-z_]\w*$/.test(v)
            ? 'Letters, digits, underscores; must not start with a digit.'
            : taken.has(v)
              ? `${v} exists already — Edit Variable changes it`
              : undefined,
      });
      if (!name) {
        return;
      }
      // Asked here rather than left for Variable Properties afterwards: what
      // a variable *is* is part of creating it -- a choice cannot even be
      // given a first value without its options, and a length is read in
      // metres, or in the unit typed, from the first value on.
      const measures = UNIT_KINDS.filter((u) => u.unit && u.unit !== 'dimensionless').map(
        (u) => ({
          label: u.label,
          description: `in ${u.unit === 'angle' ? 'degrees' : (shownIn(u.unit) ?? u.si)}`,
          detail: `${u.such} — or type a unit: ${u.example}`,
          is: 'number' as VariableKind,
          unit: u.unit,
          symbol: shownIn(u.unit) ?? u.si,
        }),
      );
      const picked = await vscode.window.showQuickPick(
        [
          ...measures,
          {
            label: KIND_LABEL.number,
            description: 'no unit',
            detail: 'a ratio, a factor — gets a slider',
            is: 'number' as VariableKind,
            unit: null,
            symbol: '',
          },
          {
            label: KIND_LABEL.whole,
            description: 'no unit',
            detail: 'it counts things — magnets, turns, copies',
            is: 'whole' as VariableKind,
            unit: null,
            symbol: '',
          },
          {
            label: KIND_LABEL.choice,
            detail: 'an axis (x, y, z) or a plane (xy, xz, yz) — gets a dropdown',
            is: 'choice' as VariableKind,
            unit: null,
            symbol: '',
          },
        ],
        { placeHolder: `${name} — what does it hold?` },
      );
      if (!picked) {
        return;
      }
      const kind = picked.is;
      if (kind === 'choice') {
        const text = await vscode.window.showInputBox({
          prompt: `${name} — the values it may take`,
          placeHolder: 'comma-separated — e.g. x, y, z',
          validateInput: (v) =>
            parseChoices(v).length ? undefined : 'at least one value, comma-separated',
        });
        if (text === undefined) {
          return;
        }
        const options = parseChoices(text);
        // The first option is the value: a choice variable with no value is
        // not a useful intermediate state, and the engine would refuse one
        // outside its own options anyway.
        if (await mutateFromTree('set_variable', { name, value: options[0] })) {
          await mutateFromTree('set_variable_bounds', { name, options });
        }
        return;
      }
      const text = await vscode.window.showInputBox(
        await valueBox(name, picked.unit, picked.symbol, name),
      );
      if (text === undefined) {
        return;
      }
      const read = await readQuantity(name, text, picked.unit ?? undefined);
      // what it measures in the same step as its value: one undo takes both
      if (
        !(await mutateFromTree('set_variable', {
          name,
          value: read?.value ?? asDocumentValue(text),
          ...(picked.unit ? { unit: picked.unit } : {}),
        }))
      ) {
        return;
      }
      await askAllowedRange(
        name,
        kind === 'whole',
        picked.unit ? { unit: picked.unit, symbol: picked.symbol } : undefined,
      );
    }),
    registerCommand(
      'magpylib-studio.editVariable',
      async (variable: Variable) => editVariable(variable),
    ),
    registerCommand(
      'magpylib-studio.renameVariable',
      async (variable: Variable) => renameVariable(variable),
    ),
    registerCommand(
      'magpylib-studio.removeVariable',
      async (variable: Variable) => {
        await mutateFromTree('remove_variable', { name: variable.name });
      },
    ),
    registerCommand(
      'magpylib-studio.setVariableBounds',
      async (variable: Variable) => editVariableProperties(variable),
    ),
    registerCommand(
      'magpylib-studio.duplicateAround',
      async (obj: SceneObject) => patternObject(obj),
    ),
    registerCommand(
      'magpylib-studio.selectOperation',
      (operation: SceneOperation) => {
        // selecting a step shows the object it acted on, so the 3D view and
        // the Inspector follow the history as you walk it
        selectObjectInStudio(context, operation.target);
        inspector?.showOperation(operation.id);
      },
    ),
    registerCommand(
      'magpylib-studio.editOperation',
      async (operation: SceneOperation) => {
        // Same as selecting it, but says where the values are: a step's
        // fields appear in the Inspector, and nothing about a tree row
        // suggests looking at another panel.
        selectObjectInStudio(context, operation.target);
        inspector?.showOperation(operation.id);
        await vscode.commands.executeCommand(
          `${InspectorViewProvider.viewId}.focus`,
        );
      },
    ),
    registerCommand(
      'magpylib-studio.operationEarlier',
      async (operation: SceneOperation) =>
        applyLogEdit('move_event', {
          event_id: operation.id,
          index: Math.max(0, operation.index - 1),
        }),
    ),
    registerCommand(
      'magpylib-studio.operationLater',
      async (operation: SceneOperation) =>
        applyLogEdit('move_event', {
          event_id: operation.id,
          index: operation.index + 1,
        }),
    ),
    registerCommand(
      'magpylib-studio.removeOperation',
      async (operation: SceneOperation) =>
        applyLogEdit('remove_event', { event_id: operation.id }),
    ),
    registerCommand(
      'magpylib-studio.rollbackTo',
      async (operation: SceneOperation) => {
        // "up to and including this step", which is what pointing at a step
        // means; the bar in a CAD tree sits below the feature it stops after
        await (await getEngine(context)).request('set_rollback', {
          index: operation.index + 1,
        });
        // A view of the document, not a change to it — the log is untouched,
        // so this leaves a saved scene saved.
        refreshSurfaces();
      },
    ),
    registerCommand('magpylib-studio.rollbackClear', async () => {
      await (await getEngine(context)).request('set_rollback', {});
      refreshSurfaces();
    }),
    registerCommand('magpylib-studio.sweep', async () => sweepVariable()),
    registerCommand(
      'magpylib-studio.gotoHistory',
      async (entry: HistoryEntry) => {
        const result = (await (await getEngine(context)).request('goto_history', {
          index: entry.index,
        })) as { ok: boolean; error?: string };
        if (!result.ok) {
          vscode.window.showErrorMessage(`Magpylib Studio: ${result.error}`);
        }
        broadcastMutation();
      },
    ),
    vscode.workspace.registerTextDocumentContentProvider('magpylib-studio', sceneDocProvider),
    registerCommand('magpylib-studio.viewScript', async () => {
      const scene = actingScene() ?? (await newSceneTab());
      if (!scene) {
        return;
      }
      const file = scriptFileOf(scene);
      // Reuse the group it is already in, the way the Studio and Field panels
      // reveal themselves. `Beside` is relative to whatever is focused, so
      // running this from the script's own column opens another one each time.
      const open = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs.map((tab) => ({ group, tab })))
        .find(
          ({ tab }) =>
            tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === file.fsPath,
        );
      // A tab still on screen keeps the text it holds; closing it let go of
      // that text, and opening one again starts from the scene.
      if (!open) {
        scene.script.held = false;
      }
      // never over edits
      await writeScriptFile(scene, !scriptDocOf(scene)?.isDirty && !scene.script.held);
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc, {
        viewColumn: open?.group.viewColumn ?? vscode.ViewColumn.Beside,
        preview: false,
      });
    }),
    vscode.workspace.onWillSaveTextDocument((e) => {
      const scene = isScriptFile(e.document.uri) ? sceneOfScript(e.document.uri) : undefined;
      if (scene) {
        scene.script.saveReason = e.reason;
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!isScriptFile(doc.uri)) {
        return;
      }
      const scene = sceneOfScript(doc.uri);
      const reason = scene?.script.saveReason;
      if (scene) {
        scene.script.saveReason = undefined;
      }
      // Only a deliberate save applies. files.autoSave saves between
      // keystrokes on a delay, or when focus leaves the tab or the window, and
      // running half-written code would be at best an error and at worst a
      // scene it never meant. The text is held instead, so a scene change
      // meanwhile does not write over it, and Cmd+S applies it.
      if (
        reason === vscode.TextDocumentSaveReason.AfterDelay ||
        reason === vscode.TextDocumentSaveReason.FocusOut
      ) {
        if (scene) {
          scene.script.held ||= doc.getText() !== scene.script.onDisk;
          scene.script.onDisk = doc.getText();
        }
        return;
      }
      await applyScriptFile(doc).catch(reportScriptTabError);
    }),
    // The scene in front, through VS Code's own Save and Save As: the side
    // bar's buttons and keys act on it wherever the focus is.
    registerCommand('magpylib-studio.saveScene', async () => {
      const doc = actingScene();
      return doc ? (await vscode.workspace.save(doc.uri)) !== undefined : false;
    }),
    registerCommand('magpylib-studio.saveSceneAs', async () => {
      const doc = actingScene();
      return doc ? (await vscode.workspace.saveAs(doc.uri)) !== undefined : false;
    }),
    registerCommand('magpylib-studio.exportScript', () =>
      exportScript('magpylib'),
    ),
    registerCommand('magpylib-studio.exportBuilderScript', () =>
      exportScript('builder'),
    ),
    // A new scene, an opened one: a tab each, the others left as they are.
    // `options` is what a caller passed when a new scene replaced the open
    // one; nothing is replaced now, so there is nothing to discard.
    registerCommand('magpylib-studio.newScene', async (_options?: Discard) => {
      await newSceneTab();
    }),
    /** Close every scene's tab and nothing else; VS Code asks once about the
     *  unsaved ones. */
    registerCommand('magpylib-studio.closeAllScenes', async () => {
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === SCENE_VIEW_TYPE,
        );
      await vscode.window.tabGroups.close(tabs);
    }),
    /** Close the scene in front: its tab, which asks about unsaved changes. */
    registerCommand('magpylib-studio.closeScene', async () => {
      const doc = actingScene();
      if (!doc) {
        return;
      }
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) =>
            tab.input instanceof vscode.TabInputCustom &&
            tab.input.uri.toString() === doc.uri.toString(),
        );
      await vscode.window.tabGroups.close(tabs);
    }),
    registerCommand('magpylib-studio.revertScene', async () => {
      const doc = actingScene();
      if (!doc || doc.untitled) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Discard changes and reload ${doc.name}?`,
        { modal: true, detail: 'The changes stay one undo away.' },
        'Revert',
      );
      if (answer !== 'Revert') {
        return;
      }
      // VS Code's own Revert, on the scene's tab, so its dot clears with it.
      const [panel] = doc.panels;
      if (panel) {
        panel.reveal(panel.viewColumn, false);
      } else {
        await vscode.commands.executeCommand('vscode.openWith', doc.uri, SCENE_VIEW_TYPE);
      }
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }),
    registerCommand(
      'magpylib-studio.loadScene',
      async (uri?: unknown, _options?: Discard) => {
        // A button in the tree's title bar is handed the row that is
        // selected, which is not a file to open: only a Uri is one.
        const target =
          (uri instanceof vscode.Uri ? uri : undefined) ??
          (
            await vscode.window.showOpenDialog({
              filters: { 'Magpylib scene': ['magpy.json', 'json'] },
              canSelectMany: false,
              defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
              openLabel: 'Open Scene',
            })
          )?.[0];
        if (target) {
          await openSceneTab(target);
        }
      },
    ),
    registerCommand(
      'magpylib-studio.importScript',
      async (_options?: Discard) => {
        const picks = await vscode.window.showOpenDialog({
          filters: { 'Python script': ['py'] },
          canSelectMany: false,
        });
        if (picks?.length) {
          await importScript(picks[0]);
        }
      },
    ),
    registerCommand(
      'magpylib-studio.openScriptInStudio',
      async (uri?: vscode.Uri, scene?: number) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (target) {
          await importScript(target, scene);
        }
      },
    ),
    registerCommand('magpylib-studio.switchScene', switchImportedScene),
    // The switch, reachable by search rather than only from a notice that is
    // shown once and then never again. Declining it has to be a door, not a
    // one-way valve.
    registerCommand(
      'magpylib-studio.toggleDrawScriptsHere',
      async () => {
        const on = !drawScriptsHere();
        await setDrawScriptsHere(on);
        void vscode.window.showInformationMessage(
          on
            ? 'Magpylib Studio draws scripts run in this window. Terminals ' +
                'already open need restarting first.'
            : 'Magpylib Studio: scripts use their own backend again. Terminals ' +
                'already open keep the old setting until restarted.',
        );
      },
    ),
    registerCommand('magpylib-studio.openStudio', () =>
      showFrontScene(),
    ),
    registerCommand('magpylib-studio.openFieldView', () =>
      openFieldPanel(context),
    ),
    // Variants, from the Variables view: named sets of the variables' values
    // in the scene the view shows (decision 0026). The panel switches them;
    // these keep, rename and drop them.
    registerCommand('magpylib-studio.saveVariant', async () => {
      const { variants } = await (await getEngine(context)).request<{
        variants?: Record<string, unknown>;
      }>('get_variables');
      const name = (
        await vscode.window.showInputBox({
          prompt: "Name for the variables' values as they are now",
          placeHolder: 'e.g. compact',
          validateInput: (v) => (v.trim() ? undefined : 'A variant needs a name'),
        })
      )?.trim();
      if (!name) {
        return;
      }
      if (variants && name in variants) {
        const replace = 'Replace';
        const answer = await vscode.window.showWarningMessage(
          `There is already a variant "${name}".`,
          { modal: true, detail: "Replace its values with the variables' values now?" },
          replace,
        );
        if (answer !== replace) {
          return;
        }
      }
      if (await mutateFromTree('save_variant', { name }, { checkVariables: false })) {
        vscode.window.setStatusBarMessage(`Magpylib Studio: saved variant "${name}"`, 3000);
      }
    }),
    registerCommand('magpylib-studio.saveOverVariant', async () => {
      const { variant } = await (await getEngine(context)).request<{ variant?: string | null }>(
        'get_variables',
      );
      if (!variant) {
        void vscode.window.showInformationMessage(
          'Magpylib Studio: no variant is in use: the values match none. Save as ' +
            'Variant… keeps them under a new name.',
        );
        return;
      }
      if (await mutateFromTree('save_variant', { name: variant }, { checkVariables: false })) {
        vscode.window.setStatusBarMessage(`Magpylib Studio: saved over "${variant}"`, 3000);
      }
    }),
    registerCommand('magpylib-studio.renameVariant', async () => {
      const old = await pickVariant('Variant to rename');
      if (!old) {
        return;
      }
      const name = (
        await vscode.window.showInputBox({
          prompt: `New name for "${old}"`,
          value: old,
          validateInput: (v) => (v.trim() ? undefined : 'A variant needs a name'),
        })
      )?.trim();
      if (name && name !== old) {
        await mutateFromTree('rename_variant', { old, new: name }, { checkVariables: false });
      }
    }),
    registerCommand('magpylib-studio.removeVariant', async () => {
      const name = await pickVariant('Variant to delete');
      if (!name) {
        return;
      }
      const remove = 'Delete';
      const answer = await vscode.window.showWarningMessage(
        `Delete the variant "${name}"?`,
        { modal: true, detail: 'The variables keep the values they have. Undo brings it back.' },
        remove,
      );
      if (answer === remove) {
        await mutateFromTree('remove_variant', { name }, { checkVariables: false });
      }
    }),
    registerCommand('magpylib-studio.undo', () => undoRedo('undo')),
    registerCommand('magpylib-studio.redo', () => undoRedo('redo')),
    registerCommand('magpylib-studio.undoTyping', () => undoTyping('undo')),
    registerCommand('magpylib-studio.redoTyping', () => undoTyping('redo')),
    // A redraw, not an edit: the scene is unchanged, so this must not mark it
    // as having unsaved changes.
    registerCommand('magpylib-studio.refreshScene', () =>
      refreshSurfaces(),
    ),
    // The name may be passed in — from a keybinding, a task, or a test —
    // in which case there is nothing to ask.
    registerCommand(
      'magpylib-studio.loadExample',
      async (name?: unknown, _options?: Discard) => {
        // as for Open Scene: a row handed over by the title bar is no name
        let chosen = typeof name === 'string' ? name : undefined;
        if (!chosen) {
          const { examples } = await (await getEngine(context)).request<{
            examples: { name: string; label: string; description: string }[];
          }>('list_examples');
          // Each leans on a different feature, so the description is the point
          // of the list — it is what tells you the tool can do that at all.
          const pick = await vscode.window.showQuickPick(
            examples.map((e) => ({ label: e.label, detail: e.description, e })),
            { placeHolder: 'Example scene to load' },
          );
          if (!pick) {
            return;
          }
          chosen = pick.e.name;
        }
        // In a tab of its own, opened on the example: nothing to undo, and
        // nothing unsaved until it is edited.
        followNewScene(await exampleTab(chosen));
      },
    ),
    registerCommand('magpylib-studio.selectObject', (objectId: string, node?: SceneObject) => {
      // a row of the tree passes itself after the id: its scene comes in front
      const scene = sceneOfNode(node);
      if (scene) {
        actOn(scene);
      }
      selectObjectInStudio(context, objectId);
    }),
    /** A saved scene's file, from its row: VS Code's own commands, given
     *  the file rather than the row. */
    registerCommand('magpylib-studio.revealSceneInExplorer', (root?: SceneRoot) =>
      root ? vscode.commands.executeCommand('revealInExplorer', root.uri) : undefined,
    ),
    registerCommand('magpylib-studio.revealSceneInOS', (root?: SceneRoot) =>
      root ? vscode.commands.executeCommand('revealFileInOS', root.uri) : undefined,
    ),
    registerCommand('magpylib-studio.revealSceneInFileManager', (root?: SceneRoot) =>
      root ? vscode.commands.executeCommand('revealFileInOS', root.uri) : undefined,
    ),
    registerCommand('magpylib-studio.copyScenePath', async (root?: SceneRoot) => {
      if (root) {
        await vscode.env.clipboard.writeText(root.uri.fsPath);
      }
    }),
    /** A scene's row: its tab shown, the focus left in the side bar. */
    registerCommand('magpylib-studio.showScene', async (root?: SceneRoot) => {
      if (!root) {
        return;
      }
      if (root.doc) {
        actOn(root.doc);
        const [panel] = root.doc.panels;
        if (panel) {
          panel.reveal(panel.viewColumn, true);
          return;
        }
      }
      await loadSceneTab(root);
    }),
    registerCommand(
      'magpylib-studio.removeObject',
      (node?: SceneNode) => {
        // Also on a `created` row, where removing has two meanings and both
        // are offered: "Remove Step" drops the create, so the object never
        // existed and the steps that needed it are flagged as broken, while
        // this deletes it as a step of its own — recorded, like every other
        // thing that happened to the scene, and undone by dropping that step.
        const target =
          node && isOperation(node)
            ? node.target
            : isObject(node)
              ? node.id
              : treeSelection()?.id;
        return target
          ? mutateFromTree('remove_object', { object_id: target })
          : undefined;
      },
    ),
    registerCommand('magpylib-studio.resetStyle', (obj: SceneObject) =>
      mutateFromTree('reset_style', { object_id: obj.id }),
    ),
    registerCommand('magpylib-studio.moveTo', async (obj: SceneObject) => {
      const objects = await (await getEngine(context)).request<SceneObject[]>('list_objects');
      const subtree = new Set([obj.id]); // no moving into itself/descendants
      for (let grew = true; grew; ) {
        grew = false;
        for (const o of objects) {
          if (o.parent && subtree.has(o.parent) && !subtree.has(o.id)) {
            subtree.add(o.id);
            grew = true;
          }
        }
      }
      const targets: { label: string; parent: string | null }[] = [];
      if (obj.parent !== null) {
        targets.push({ label: '(scene root)', parent: null });
      }
      for (const o of objects) {
        if (o.type === 'Collection' && !subtree.has(o.id) && o.id !== obj.parent) {
          targets.push({ label: `${o.label} (${o.id})`, parent: o.id });
        }
      }
      if (!targets.length) {
        vscode.window.showInformationMessage('Magpylib Studio: nowhere to move this to.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        targets.map((t) => t.label),
        { placeHolder: `Move "${obj.label}" to…` },
      );
      if (pick === undefined) {
        return;
      }
      const parent = targets.find((t) => t.label === pick)?.parent ?? null;
      await mutateFromTree('move_object', { object_id: obj.id, parent });
    }),
    registerCommand(
      'magpylib-studio.addObject',
      async (obj?: SceneObject) => {
        const pick = await vscode.window.showQuickPick(
          // same glyph the tree will show it as, so the menu and the scene
          // name the thing the same way
          OBJECT_TEMPLATES.map((t) => ({
            label: t.label,
            description: t.type,
            detail: t.detail,
            iconPath: iconFor(t.type, context.extensionUri),
            t,
          })),
          // matching the description is what makes the magpylib names
          // findable: "Current loop" is the friendlier label, but a person
          // who knows the library types "Circle"
          { placeHolder: 'Object to add', matchOnDescription: true },
        );
        if (!pick) {
          return;
        }
        if (pick.t.command) {
          // Its own flow — a file dialog, or an editor full of points — but
          // reached from the menu where someone went looking for it.
          await vscode.commands.executeCommand(pick.t.command, obj);
          return;
        }
        const suggestion = pick.t.type.split('.').pop()!.toLowerCase();
        const id = await vscode.window.showInputBox({
          prompt: `Id for the new ${pick.label.toLowerCase()}`,
          value: suggestion,
          validateInput: (v) =>
            /^[A-Za-z_]\w*$/.test(v)
              ? undefined
              : 'Letters, digits, underscores; must not start with a digit.',
        });
        if (!id) {
          return;
        }
        // Let the user set each parameter, prefilled with the default, in the
        // unit the scene shows it in.
        const view = await unitView(context, pick.t.type);
        const lengthWord = LENGTH_WORDS[view.model_unit] ?? view.model_unit;
        const values: Record<string, unknown> = { ...pick.t.params };
        for (const [name, def] of Object.entries(pick.t.params)) {
          const shown = view.params?.[name];
          // A list of points is asked for in an editor, one to a line, the
          // same way a custom path is. It used to be a single box holding a
          // flat run of numbers reshaped by counting in threes — nine of them
          // for the polyline's default, forty-five for a real PCB trace, and
          // a miscount by one silently shifted every vertex after it.
          const template = def as number[] | number[][];
          if (Array.isArray(template) && Array.isArray(template[0])) {
            const shape = template as number[][];
            const rule = pick.t.rows?.[name] ?? { noun: name, min: 2 };
            // A fixed count of points is a shape — four corners are four
            // corners — so only the open-ended ones are worth a curve.
            const how =
              rule.max === undefined
                ? await vscode.window.showQuickPick(
                    [
                      {
                        label: `Type the ${rule.noun}`,
                        detail: 'a point to a line, in an editor',
                        formula: false,
                      },
                      {
                        label: 'Sample a formula',
                        detail: `a curve in t · how many ${rule.noun} is a variable too`,
                        formula: true,
                      },
                    ],
                    { placeHolder: `${pick.label} — ${name}` },
                  )
                : { formula: false };
            if (!how) {
              return;
            }
            if (how.formula) {
              const run = await askSampledRun(
                context,
                `${id}-${name}`,
                `A ${pick.label.toLowerCase()}`,
                [
                  'One line per axis — x, y, z as formulas in t, which runs',
                  `0 to 1 along the curve, in the ${pick.label.toLowerCase()}'s`,
                  'own frame.',
                  '',
                  'Numbers or expressions over the variables and t:',
                  '  radius * cos(tau * turns * t)',
                ],
                [
                  'radius * cos(tau * turns * t)',
                  'radius * sin(tau * turns * t)',
                  'height * t - height / 2',
                ],
              );
              if (!run) {
                return;
              }
              values[name] = run;
              continue;
            }
            const points = await askPointRows(context, {
              name: `${id}-${name}`,
              subject: `A ${pick.label.toLowerCase()}`,
              noun: rule.noun,
              header: [
                `One point per line — x, y, z in ${lengthWord}, in the`,
                `${pick.label.toLowerCase()}'s own frame, in order.`,
                '',
                'Numbers, with a unit if you like, or expressions: 0, 0, 5 mm or 0, 0, gap',
              ],
              example: shape.map((row) => shownText(row, shown)),
              width: shape[0].length,
              min: rule.min,
              max: rule.max,
              unit: Array.isArray(shown) ? undefined : shown?.unit,
            });
            if (!points) {
              return; // cancelled: abandon the whole creation, as escape does
            }
            await closePointEditor(context, `${id}-${name}`);
            values[name] = points;
            continue;
          }
          const isScalar = typeof def === 'number';
          const read = await askTerms(
            context,
            {
              prompt: `${pick.label} — ${name}${inUnits(shown, PARAM_SI[name])}${PARAM_HINTS[name] ?? ''}`,
              value: shownText(isScalar ? [def] : (def as unknown[]), shown),
            },
            isScalar ? 1 : undefined,
            shown,
            isScalar ? 'A number, or an expression' : 'Numbers or expressions, e.g. 0, 0, gap',
          );
          if (read === undefined) {
            return; // escaped: abandon the whole creation
          }
          values[name] = isScalar ? read[0] : read;
        }
        const params: Record<string, unknown> = {
          object_id: id,
          type: pick.t.type,
          params: values,
          style: { label: pick.label },
        };
        if (obj?.type === 'Collection') {
          params.parent = obj.id; // right-clicked a group: create inside it
        }
        // only if it was actually created: selecting an id that does not
        // exist leaves the Inspector showing an error about it
        if (await mutateFromTree('add_object', params)) {
          selectObjectInStudio(context, id); // show it in the Inspector
        }
      },
    ),
    registerCommand(
      'magpylib-studio.addMesh',
      async (obj?: SceneObject) => {
        // Which of the two ways to make a mesh, asked where the difference
        // is a difference between shapes rather than between menu entries.
        // Both flows are commands of their own as well, for the palette.
        const source = await vscode.window.showQuickPick(
          [
            {
              label: 'From a mesh file',
              detail: 'an STL, OBJ or PLY — the part as it was drawn',
              command: 'magpylib-studio.importMesh',
            },
            {
              label: 'From a point cloud',
              detail: 'the convex hull of points you type — no file behind it',
              command: 'magpylib-studio.meshFromPoints',
            },
            {
              label: 'From a formula',
              detail: 'a superellipsoid: block, cylinder, sphere and between',
              command: 'magpylib-studio.meshFromFormula',
            },
          ],
          { placeHolder: 'Triangular mesh — where does its shape come from?' },
        );
        if (!source) {
          return;
        }
        await vscode.commands.executeCommand(source.command, obj);
      },
    ),
    registerCommand(
      'magpylib-studio.importMesh',
      async (obj?: SceneObject) => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Import Mesh',
          // STL is read by the engine itself; everything else goes through
          // pyvista, which the engine says so about when it is not installed
          // rather than leaving the format out of the dialog.
          filters: {
            Meshes: ['stl', 'obj', 'ply', 'vtk', 'vtp', 'vtu'],
            'All files': ['*'],
          },
          defaultUri: actingScene()?.baseDir
            ? vscode.Uri.file(actingScene()!.baseDir!)
            : vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (!picked?.length) {
          return;
        }
        const file = picked[0];
        const engine = await getEngine(context);
        // Read before adding: what is in the file decides the next two
        // questions, and a file that cannot be read should say so here rather
        // than as a broken object in the tree.
        const report = (await engine.request('inspect_mesh', {
          source: { from: 'file', path: file.fsPath },
        })) as {
          ok: boolean;
          error?: string;
          faces?: number;
          vertices?: number;
          extent?: number[];
          sha256?: string;
          status?: MeshStatus;
        };
        if (!report.ok) {
          vscode.window.showErrorMessage(`Magpylib Studio: ${report.error}`);
          return;
        }
        const extent = report.extent ?? [0, 0, 0];
        const unit = await vscode.window.showQuickPick(
          MESH_UNITS.map((u) => ({
            label: u.label,
            // The size the choice produces, so the right one is the one that
            // looks like the part — not an arithmetic problem to do in your
            // head against a number in unknown units.
            description: `→ ${sizeInMillimetres(extent, u.scale)}`,
            detail: u.detail,
            u,
          })),
          {
            placeHolder:
              `${basename(file)} — ${report.faces} faces, ` +
              `${extent.map((e) => +e.toPrecision(4)).join(' × ')} as written. ` +
              `What is it drawn in?`,
          },
        );
        if (!unit) {
          return;
        }
        const id = await vscode.window.showInputBox({
          prompt: `Id for the mesh from ${basename(file)}`,
          value: idFromFileName(basename(file)),
          validateInput: (v) =>
            /^[A-Za-z_]\w*$/.test(v)
              ? undefined
              : 'Letters, digits, underscores; must not start with a digit.',
        });
        if (!id) {
          return;
        }
        const field = (await unitView(context)).shown.field;
        const polarization = await askTerms(
          context,
          {
            prompt: `Polarization of "${id}" as x, y, z${inUnits(field)}`,
            value: shownText([0, 0, 1], field),
          },
          3,
          field,
          `Three numbers, e.g. ${shownText([0, 0, 1.3], field)}`,
        );
        if (polarization === undefined) {
          return;
        }
        // Relative to the document wherever it can be: a scene and the part it
        // was built from usually travel together, and an absolute path is
        // right on exactly one machine. `..` means the file is outside the
        // document's folder, where relative buys nothing and reads worse.
        const base =
          actingScene()?.baseDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const relative = base ? path.relative(base, file.fsPath) : '';
        const stored = relative && !relative.startsWith('..') ? relative : file.fsPath;
        const params: Record<string, unknown> = {
          object_id: id,
          type: 'magnet.TriangularMesh',
          params: {
            mesh_source: {
              from: 'file',
              path: stored,
              scale: unit.u.scale,
              ...(report.sha256 ? { sha256: report.sha256 } : {}),
            },
            polarization,
          },
          style: { label: basename(file) },
        };
        if (obj?.type === 'Collection') {
          params.parent = obj.id; // right-clicked a group: import into it
        }
        if (await mutateFromTree('add_object', params)) {
          selectObjectInStudio(context, id);
          reportMeshImport(basename(file), report.status ?? {}, report.faces);
        }
      },
    ),
    registerCommand(
      'magpylib-studio.meshFromPoints',
      async (obj?: SceneObject) => {
        const id = await vscode.window.showInputBox({
          prompt: 'Id for the new mesh',
          value: 'hull',
          validateInput: (v) =>
            /^[A-Za-z_]\w*$/.test(v)
              ? undefined
              : 'Letters, digits, underscores; must not start with a digit.',
        });
        if (!id) {
          return;
        }
        const length = (await unitView(context)).shown.length;
        const points = await askPointRows(context, {
          name: `${id}-points`,
          subject: 'A mesh',
          noun: 'points',
          header: [
            `One point per line — x, y, z in ${LENGTH_WORDS[length.symbol] ?? length.symbol}.`,
            'The magnet is the convex hull of them, so a point inside the',
            'shape the others make changes nothing.',
            '',
            'Numbers, with a unit if you like, or expressions: 0, 0, 5 mm or 0, 0, gap',
          ],
          example: [
            [0, 0, 0],
            [0.01, 0, 0],
            [0, 0.01, 0],
            [0, 0, 0.01],
          ].map((row) => shownText(row, length)),
          width: 3,
          min: 4, // fewer than four is a plane, and a plane has no hull
          unit: 'length',
        });
        if (!points) {
          return;
        }
        await closePointEditor(context, `${id}-points`);
        const field = (await unitView(context)).shown.field;
        const polarization = await askTerms(
          context,
          {
            prompt: `Polarization of "${id}" as x, y, z${inUnits(field)}`,
            value: shownText([0, 0, 1], field),
          },
          3,
          field,
          `Three numbers, e.g. ${shownText([0, 0, 1.3], field)}`,
        );
        if (polarization === undefined) {
          return;
        }
        const params: Record<string, unknown> = {
          object_id: id,
          type: 'magnet.TriangularMesh',
          params: {
            mesh_source: { from: 'hull', points },
            polarization,
          },
          style: { label: 'Mesh' },
        };
        if (obj?.type === 'Collection') {
          params.parent = obj.id;
        }
        if (await mutateFromTree('add_object', params)) {
          selectObjectInStudio(context, id);
        }
      },
    ),
    registerCommand(
      'magpylib-studio.meshFromFormula',
      async (obj?: SceneObject) => {
        // The presets are the documentation. Two exponents is not a thing
        // anyone has intuition about until they have seen which shapes they
        // land on, so the menu names the shapes and fills in the numbers —
        // and leaves them on the object, where they are sliders.
        const shape = await vscode.window.showQuickPick(
          SUPERQUADRIC_SHAPES.map((preset) => ({
            label: preset.label,
            description: `plan ${preset.plan}, profile ${preset.profile}`,
            detail: preset.detail,
            preset,
          })),
          { placeHolder: 'Superellipsoid — which shape to start from?' },
        );
        if (!shape) {
          return;
        }
        const id = await vscode.window.showInputBox({
          prompt: 'Id for the new mesh',
          value: shape.preset.id,
          validateInput: (v) =>
            /^[A-Za-z_]\w*$/.test(v)
              ? undefined
              : 'Letters, digits, underscores; must not start with a digit.',
        });
        if (!id) {
          return;
        }
        const length = (await unitView(context)).shown.length;
        const size = await askTerms(
          context,
          {
            prompt: `Size of "${id}" as width, depth, height${inUnits(length)}`,
            value: shownText([0.02, 0.02, 0.01], length),
          },
          3,
          length,
          `Three numbers, e.g. ${shownText([0.02, 0.02, 0.01], length)}`,
        );
        if (size === undefined) {
          return;
        }
        const field = (await unitView(context)).shown.field;
        const polarization = await askTerms(
          context,
          {
            prompt: `Polarization of "${id}" as x, y, z${inUnits(field)}`,
            value: shownText([0, 0, 1], field),
          },
          3,
          field,
          `Three numbers, e.g. ${shownText([0, 0, 1.3], field)}`,
        );
        if (polarization === undefined) {
          return;
        }
        const params: Record<string, unknown> = {
          object_id: id,
          type: 'magnet.TriangularMesh',
          params: {
            mesh_source: {
              from: 'superquadric',
              size,
              // (pole to pole, around), the order the formula takes them in
              roundness: [shape.preset.profile, shape.preset.plan],
              around: 48,
              across: 24,
            },
            polarization,
          },
          style: { label: shape.preset.label },
        };
        if (obj?.type === 'Collection') {
          params.parent = obj.id;
        }
        if (await mutateFromTree('add_object', params)) {
          selectObjectInStudio(context, id);
        }
      },
    ),
    registerCommand(
      'magpylib-studio.setPosition',
      async (obj: SceneObject) => {
        const current = (await (await getEngine(context)).request('get_transform', {
          object_id: obj.id,
        })) as { position: number[]; written_position?: unknown[] };
        const length = (await unitView(context)).shown.length;
        const position = await askTerms(
          context,
          {
            prompt: `Position of "${obj.label}" as x, y, z${inUnits(length)}`,
            value: shownText(current.written_position ?? current.position, length),
          },
          3,
          length,
          'Three numbers or expressions, e.g. 0, 0, 1.5',
        );
        if (position) {
          await mutateFromTree('set_transform', { object_id: obj.id, position });
        }
      },
    ),
    registerCommand(
      'magpylib-studio.moveBy',
      async (obj: SceneObject) => {
        const kind = await askPathKind(`Move "${obj.label}"`);
        if (!kind) {
          return;
        }
        const length = (await unitView(context)).shown.length;
        let displacement: unknown;
        if (kind.kind === 'formula') {
          const run = await askSampledRun(
            context,
            `${obj.id}-move`,
            'A path formula',
            [
              'One line per axis — dx, dy, dz as formulas in t, which runs',
              `0 to 1 along the path. Relative to where "${obj.label}" is now,`,
              'so all three should come to zero at t = 0.',
              '',
              'Numbers or expressions over the variables and t:',
              '  radius * (cos(tau * t) - 1)',
            ],
            ['radius * (cos(tau * t) - 1)', 'radius * sin(tau * t)', 'height * t'],
          );
          if (!run) {
            return;
          }
          displacement = run;
        } else if (kind.kind === 'custom') {
          // The one kind that keeps expressions: nothing here is divided or
          // scaled, so `0, 0, gap` goes in as written and stays tied to the
          // variable it names.
          const points = await askPointRows(context, {
            name: `${obj.id}-move`,
            subject: 'A path',
            noun: 'steps',
            header: [
              `One displacement per line — dx, dy, dz in ${LENGTH_WORDS[length.symbol] ?? length.symbol},`,
              `relative to where "${obj.label}" is now.`,
              '',
              'Numbers, with a unit if you like, or expressions: 0, 0, 5 mm or 0, 0, gap',
            ],
            example: [
              [0, 0, 0],
              [0, 0, 0.5],
              [0, 0, 1],
            ].map((row) => shownText(row, length)),
            width: 3,
            min: 2,
            unit: 'length',
          });
          if (!points) {
            return;
          }
          await closePointEditor(context, `${obj.id}-move`);
          displacement = points;
        } else {
          const total = kind.kind === 'linspace';
          const unit = inUnits(length);
          const d = await askTerms(
            context,
            {
              prompt:
                kind.kind === 'scalar'
                  ? `Displacement dx, dy, dz${unit}`
                  : total
                    ? `Total displacement dx, dy, dz${unit} — over ${kind.steps} steps`
                    : `Displacement per step dx, dy, dz${unit} — ${kind.steps} of them`,
              value: shownText(kind.kind === 'arange' ? [0, 0, 0.05] : [0, 0, 1], length),
            },
            3,
            length,
            'Three numbers or expressions, e.g. 0, 0, gap',
          );
          if (!d) {
            return;
          }
          // A path is arithmetic on what was typed, which needs numbers; a
          // single symbolic displacement is fine and stays tied to its
          // variables. Custom points, above, are neither.
          const numeric = d.filter((c) => typeof c === 'number') as number[];
          if (kind.kind !== 'scalar' && numeric.length !== d.length) {
            vscode.window.showErrorMessage(
              'Magpylib Studio: an even path needs numbers, not expressions — ' +
                'use custom points to keep a variable.',
            );
            return;
          }
          // A path of `steps` movements is steps + 1 poses, and the first of
          // them is where the object already is. Leaving it out — which is what
          // this did — meant the animation never showed the starting position,
          // and made the path one that no single call describes: `move` would
          // export as a wall of literal triples, because the only exact
          // spelling of "evenly spaced but missing its origin" is a sliced
          // linspace. Including it costs one pose and gains both.
          displacement =
            kind.kind === 'scalar'
              ? d
              : total
                ? evenRamp(numeric, kind.steps)
                : incrementRamp(numeric, kind.steps);
        }
        let startArg: { start?: number } = {};
        if (kind.kind !== 'scalar') {
          const chosen = await askStart(context, obj.id);
          if (!chosen) {
            return;
          }
          startArg = chosen;
        }
        await mutateFromTree('move', {
          object_id: obj.id,
          displacement,
          // recorded so the script writes the call that was actually used;
          // the points alone cannot say which
          ...(kind.kind === 'arange' ? { spacing: 'arange' } : {}),
          ...startArg,
        });
      },
    ),
    registerCommand(
      'magpylib-studio.rotateBy',
      async (obj: SceneObject) => {
        const kind = await askPathKind(`Rotate "${obj.label}"`);
        if (!kind) {
          return;
        }
        const axis = await askRotationAxis();
        if (axis === undefined) {
          return;
        }
        const anchor = await askRotationAnchor(context);
        if (anchor === undefined) {
          return;
        }
        let angle: unknown;
        if (kind.kind === 'formula') {
          const run = await askSampledRun(
            context,
            `${obj.id}-rotate`,
            'A turn formula',
            [
              'The angle in degrees as a formula in t, which runs 0 to 1 over',
              `the path — relative to how "${obj.label}" is turned now, so it`,
              'should come to zero at t = 0.',
              '',
              'Numbers or expressions over the variables and t:',
              '  360 * turns * t',
            ],
            ['360 * t'],
          );
          if (!run) {
            return;
          }
          angle = run;
        } else if (kind.kind === 'custom') {
          const points = await askPointRows(context, {
            name: `${obj.id}-rotate`,
            subject: 'A path',
            noun: 'steps',
            header: [
              `One angle per line, in degrees, relative to how "${obj.label}"`,
              'is turned now.',
              '',
              'Numbers or expressions: 90, 180, 1.57 rad, turn',
            ],
            example: ['0', '45', '90'],
            width: 1,
            min: 2,
            unit: 'angle',
          });
          if (!points) {
            return;
          }
          await closePointEditor(context, `${obj.id}-rotate`);
          angle = points.map(([a]) => a); // one value to a line, not a triple
        } else {
          const total = kind.kind === 'linspace';
          // degrees, or `1.57 rad` as the engine reads it
          const read = await askTerms(
            context,
            {
              prompt:
                kind.kind === 'scalar'
                  ? 'Angle in degrees'
                  : total
                    ? `Total degrees — over ${kind.steps} steps (360 = full turn)`
                    : `Degrees per step — ${kind.steps} of them`,
              value: kind.kind === 'scalar' ? '45' : total ? '360' : '10',
            },
            1,
            'angle',
            'A number, e.g. 45',
            ([angle]) => (typeof angle === 'number' ? undefined : 'A number, e.g. 45'),
          );
          if (!read) {
            return;
          }
          const typed = read[0] as number;
          // Same as Move By…: the turn starts from where the object is, so the
          // path carries its own zero and exports as the call that makes it.
          angle =
            kind.kind === 'scalar'
              ? typed
              : (total
                  ? evenRamp([typed], kind.steps)
                  : incrementRamp([typed], kind.steps)
                ).map(([a]) => a);
        }
        let startArg: { start?: number } = {};
        if (kind.kind !== 'scalar') {
          const chosen = await askStart(context, obj.id);
          if (!chosen) {
            return;
          }
          startArg = chosen;
        }
        await mutateFromTree('rotate', {
          object_id: obj.id,
          angle,
          axis,
          ...(anchor.value !== undefined ? { anchor: anchor.value } : {}),
          ...(kind.kind === 'arange' ? { spacing: 'arange' } : {}),
          ...startArg,
        });
      },
    ),
    registerCommand('magpylib-studio.clearPath', (obj: SceneObject) =>
      mutateFromTree('clear_path', { object_id: obj.id }),
    ),
    registerCommand(
      'magpylib-studio.pixelGrid',
      async (obj?: SceneObject) => {
        const target = obj ?? treeSelection();
        if (!target) {
          return;
        }
        const plane = await vscode.window.showQuickPick(['xy', 'xz', 'yz'], {
          placeHolder: `Pixel grid plane for "${target.label}" (in its own frame)`,
        });
        if (!plane) {
          return;
        }
        const length = (await unitView(context)).shown.length;
        const readSize = async (v: string) => {
          if (v.trim() === '') {
            return undefined;
          }
          const read = await readTerms(context, v, 1, length, 'A positive number, or blank');
          return typeof read === 'string'
            ? read
            : typeof read[0] === 'number' && read[0] > 0
              ? read[0]
              : 'A positive number, or blank';
        };
        const sizeText = await vscode.window.showInputBox({
          // No fixed default: a scene is written at whatever scale the object
          // is, and 4 m of measuring plane over a 25 mm magnet is one pixel.
          // Blank hands the choice to the engine, which sizes it off the scene.
          prompt: `Grid size${inUnits(length)} — the plane spans ± half of this`,
          placeHolder: 'blank fits the scene',
          validateInput: async (v) => {
            const size = await readSize(v);
            return typeof size === 'string' ? size : undefined;
          },
        });
        if (sizeText === undefined) {
          return;
        }
        const size = await readSize(sizeText);
        if (typeof size === 'string') {
          return;
        }
        const resText = await vscode.window.showInputBox({
          prompt: 'Pixels per side',
          value: '30',
          validateInput: (v) =>
            Number.isInteger(Number(v)) && Number(v) >= 2 ? undefined : 'At least 2',
        });
        if (!resText) {
          return;
        }
        await mutateFromTree('set_pixel_grid', {
          object_id: target.id,
          plane,
          ...(size === undefined ? {} : { size }),
          resolution: Number(resText),
        });
        openFieldPanel(context); // the map is the point of making a grid
      },
    ),
    registerCommand(
      'magpylib-studio.toggleVisibility',
      (obj: SceneObject) =>
        mutateFromTree('set_visible', { object_id: obj.id, visible: !obj.visible }),
    ),
    registerCommand('magpylib-studio.copyObject', (obj?: SceneObject) => {
      const target = obj ?? treeSelection();
      if (target) {
        clipboard = { id: target.id, cut: false, scene: actingScene() };
        void vscode.commands.executeCommand('setContext', 'magpylib-studio.canPaste', true);
        vscode.window.setStatusBarMessage(
          `Magpylib Studio: copied "${target.label}"`,
          2000,
        );
      }
    }),
    registerCommand('magpylib-studio.cutObject', (obj?: SceneObject) => {
      const target = obj ?? treeSelection();
      if (target) {
        clipboard = { id: target.id, cut: true, scene: actingScene() };
        void vscode.commands.executeCommand('setContext', 'magpylib-studio.canPaste', true);
        vscode.window.setStatusBarMessage(`Magpylib Studio: cut "${target.label}"`, 2000);
      }
    }),
    registerCommand(
      'magpylib-studio.pasteObject',
      async (obj?: SceneNode) => {
        if (!clipboard) {
          vscode.window.setStatusBarMessage('Magpylib Studio: nothing to paste', 2000);
          return;
        }
        // The row pasted onto, whose scene came in front with it. A scene's
        // own row means its top level.
        const target = isObject(obj) ? obj : obj ? undefined : treeSelection();
        // An id names an object in its own scene only: pasted into another it
        // would copy, or for a Cut move, whatever that scene has under the
        // same id. Copying across scenes is its own step (plan §5.1).
        if (clipboard.scene !== actingScene()) {
          vscode.window.showInformationMessage(
            `Magpylib Studio: "${clipboard.id}" was copied from ` +
              `${clipboard.scene?.name ?? 'a scene now closed'}; pasting into ` +
              'another scene is not possible yet. Paste it into its own scene.',
          );
          return;
        }
        // Paste into a collection when one is targeted, else at the scene root.
        const parent =
          target?.type === 'Collection' ? target.id : (target?.parent ?? null);
        if (clipboard.cut) {
          await mutateFromTree('move_object', {
            object_id: clipboard.id,
            parent,
          });
          clipboard = undefined; // a cut object can only land once
          void vscode.commands.executeCommand('setContext', 'magpylib-studio.canPaste', false);
        } else {
          await mutateFromTree('copy_object', { object_id: clipboard.id, parent });
        }
      },
    ),
    registerCommand(
      'magpylib-studio.renameObject',
      async (obj?: SceneObject) => {
        const target = obj ?? treeSelection();
        if (!target) {
          return;
        }
        const label = await vscode.window.showInputBox({
          prompt: `Name for "${target.id}"`,
          value: target.label,
          validateInput: (v) => (v.trim() ? undefined : 'The name cannot be empty'),
        });
        if (label && label !== target.label) {
          await mutateFromTree('apply_edit', {
            object_id: target.id,
            path: 'label',
            value: label,
          });
        }
      },
    ),
    registerCommand(
      'magpylib-studio.newCollection',
      async (obj?: SceneObject) => {
        const id = await vscode.window.showInputBox({
          prompt: 'Id for the new collection',
          placeHolder: 'letters, digits, underscores — e.g. ring, rotor',
          validateInput: (v) =>
            /^[A-Za-z_]\w*$/.test(v)
              ? undefined
              : 'Letters, digits, underscores; must not start with a digit.',
        });
        if (!id) {
          return;
        }
        const params: Record<string, unknown> = { object_id: id, type: 'Collection' };
        if (obj?.type === 'Collection') {
          params.parent = obj.id; // context-menu on a collection: create inside
        }
        await mutateFromTree('add_object', params);
      },
    ),
    new vscode.Disposable(() => {
      engine?.dispose();
      engine = undefined;
    }),
  );
  /**
   * Before scenes were tabs, a workspace remembered its one scene, and kept a
   * backup of its unsaved changes. Opened once as a tab -- marked unsaved,
   * with those changes, when it had some -- then forgotten: from here on VS
   * Code brings the tabs back.
   */
  const upgradeRememberedScene = async () => {
    const remembered = context.workspaceState.get<{ file?: string; dirty?: boolean }>(
      SCENE_STATE_KEY,
    );
    if (!remembered) {
      return;
    }
    await context.workspaceState.update(SCENE_STATE_KEY, undefined);
    const backup = vscode.Uri.joinPath(scriptDir, 'backup.magpy.json');
    const file = remembered.file ? vscode.Uri.parse(remembered.file) : undefined;
    let doc = file ? sceneFor(file) : undefined;
    if (!doc && file && (await exists(file))) {
      doc = await openSceneTab(file);
    }
    if (remembered.dirty && (await exists(backup))) {
      doc ??= await newSceneTab();
      try {
        const scene = JSON.parse(
          Buffer.from(await vscode.workspace.fs.readFile(backup)).toString('utf8'),
        );
        if (doc) {
          await mutateFromTree(
            'replace_scene',
            { scene, base_dir: doc.baseDir ?? null },
            { checkVariables: false },
          );
        }
      } catch (err) {
        engineOutput?.appendLine(
          `[the last unsaved changes could not be read: ${err instanceof Error ? err.message : err}]`,
        );
      }
    }
    void vscode.workspace.fs.delete(backup).then(undefined, () => {});
  };

  void closeOneSceneScriptTab();
  void upgradeRememberedScene();
  // after the window has brought its tabs back, and their scenes opened
  setTimeout(() => void offerLeftBehind(), 4000);
  setTimeout(reviveDeadTabs, 3000);

  // First activation on this machine, any workspace: open the walkthrough
  // once. Global rather than per-workspace state — a returning user opening
  // a second project should not see it again.
  if (!context.globalState.get(TOUR_SHOWN_KEY)) {
    void context.globalState.update(TOUR_SHOWN_KEY, true);
    void vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      `${context.extension.id}#gettingStarted`,
      false,
    );
  }
}

export async function deactivate(): Promise<void> {
  // VS Code backs up what is unsaved before it shuts the extension down; a
  // recovery copy still pending is for a crash, which this is not.
  for (const timer of settleTimers.values()) {
    clearTimeout(timer);
  }
  settleTimers.clear();
  engine?.dispose();
  engine = undefined;
}

/**
 * Which file the scene is, whether it differs from it, and where the crash
 * backup goes — the state that survives a window reload.
 *
 * Exported for the integration tests: a test cannot reload the window, so it
 * checks that what a reload would read back is being written correctly. The
 * reload itself stays a manual check.
 */
/**
 * Kill the engine the way a crash does.
 *
 * Exported for the integration tests, for the same reason as the state above:
 * the scene lives in a subprocess, and "the subprocess died" is a state the
 * extension has to survive but no command can ask for. What happens next —
 * a new process, handed the backup before anyone else gets to speak to it —
 * is then observable through the ordinary API.
 */
export function stopEngineForTest(): void {
  engine?.dispose();
}

export function sceneFileState(): {
  file: string | undefined;
  dirty: boolean;
  backup: string | undefined;
} {
  const doc = frontScene();
  return {
    file: doc && !doc.untitled ? doc.uri.toString() : undefined,
    dirty: doc?.dirty ?? false,
    backup: doc && recoveryFile(doc)?.toString(),
  };
}

export function createWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): string {
  const nonce = webviewNonce();
  const styleUri = mediaUri(webview, context.extensionUri, 'studioView.css');
  const scriptUri = mediaUri(webview, context.extensionUri, 'studioView.mjs');
  const plotlyUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      context.extensionUri,
      'node_modules',
      'plotly.js-dist-min',
      'plotly.min.js',
    ),
  );
  // The notebook widget draws the scene: the same view, controls and keys as
  // a notebook cell and the script panel. It is the package's, copied beside
  // media/ by `npm run compile` (harness/copy-widget.js), and loads its
  // renderer from a blob -- hence `blob:` below.
  const widgetDir = vscode.Uri.joinPath(context.extensionUri, 'widget');
  const widgetUri = webview.asWebviewUri(vscode.Uri.joinPath(widgetDir, 'widget.js'));
  const widgetStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(widgetDir, 'widget.css'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} blob:; font-src ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Magpylib Studio</title>
  <link rel="stylesheet" href="${widgetStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
  <script nonce="${nonce}" src="${plotlyUri}"></script>
</head>
<body data-widget="${widgetUri}">
  <div id="view"></div>
  <div id="chart" hidden></div>
  <div id="bar">
    <span id="mode">
      <button id="modeEdit" type="button" class="on"
        title="The scene, to pick and drag">Edit</button
      ><button id="modeChart" type="button"
        title="A Plotly chart of the scene: read only">Chart</button>
    </span>
    <button id="animate" type="button" hidden
      title="Bake the paths into the chart, with Plotly's own transport">Animate</button>
    <span id="status">Starting…</span>
  </div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function createFieldViewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): string {
  const nonce = webviewNonce();
  const fieldStyleUri = mediaUri(webview, context.extensionUri, 'field.css');
  const fieldScriptUri = mediaUri(webview, context.extensionUri, 'field.js');
  const textFocusUri = mediaUri(webview, context.extensionUri, 'textFocus.mjs');
  const plotlyUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      context.extensionUri,
      'node_modules',
      'plotly.js-dist-min',
      'plotly.min.js',
    ),
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Magpylib Field</title>
  <link rel="stylesheet" href="${fieldStyleUri}" />
  <script nonce="${nonce}" src="${plotlyUri}"></script>
</head>
<body data-text-focus="${textFocusUri}">
  <div id="canvas"></div>
  <div id="statusbar">
    <label>
      <select id="mode">
        <option value="path">Along sensor path</option>
        <option value="map">Plane map</option>
        <option value="sweep">Against a variable</option>
      </select>
    </label>
    <span class="path-only">
      <label>Output
        <select id="output">
          <option>B</option><option>Bx</option><option>By</option><option>Bz</option>
          <option>Bxy</option>
          <option>H</option><option>Hx</option><option>Hy</option><option>Hz</option>
          <option>J</option><option>Jx</option><option>Jy</option><option>Jz</option>
          <option>M</option><option>Mx</option><option>My</option><option>Mz</option>
        </select>
      </label>
      <label><input type="checkbox" id="animate" /> Animate path</label>
    </span>
    <span class="map-only" hidden>
      <label>
        <select id="source"><option value="">on a plane</option></select>
      </label>
    </span>
    <span class="plane-only" hidden>
      <label>Plane
        <select id="plane">
          <option>xy</option><option>xz</option><option>yz</option>
        </select>
      </label>
      <label>at <input type="number" id="offset" step="any" value="0" /> m</label>
      <label>
        <select id="component">
          <option value="magnitude">magnitude</option>
          <option value="x">x</option><option value="y">y</option>
          <option value="z">z</option>
        </select>
      </label>
      <label>of
        <select id="quantity">
          <option>B</option><option>H</option>
          <option>J</option><option>M</option>
        </select>
      </label>
      <label><input type="checkbox" id="log" checked /> log</label>
      <label>res <input type="number" id="resolution" min="5" max="200" value="50" /></label>
    </span>
    <span class="map-only" hidden>
      <label>
        <select id="mapComponent">
          <option value="magnitude">magnitude</option>
          <option value="x">x</option><option value="y">y</option>
          <option value="z">z</option>
        </select>
      </label>
      <label>of
        <select id="mapQuantity">
          <option>B</option><option>H</option>
          <option>J</option><option>M</option>
        </select>
      </label>
    </span>
    <span class="sweep-only" hidden>
      <label>
        <select id="sweepComponent">
          <option value="magnitude">magnitude</option>
          <option value="x">x</option><option value="y">y</option>
          <option value="z">z</option>
        </select>
      </label>
      <label>of
        <select id="sweepField">
          <option>B</option><option>H</option>
          <option>J</option><option>M</option>
        </select>
      </label>
      <span id="sweepRange"></span>
    </span>
    <span id="status">Loading…</span>
  </div>
  <script nonce="${nonce}" src="${fieldScriptUri}"></script>
</body>
</html>`;
}

/** The Scenes tree, for the integration tests to read its rows. */
export function sceneTreeForTest(): SceneTreeProvider {
  return sceneTree!;
}

/** Look again for recovery copies, as activation does, for the integration
 *  tests: a test cannot crash VS Code, so it leaves a copy where a crash
 *  would, and opens the scene. */
export async function findRecoveryForTest(): Promise<vscode.Uri | undefined> {
  await (leftBehindFound = findLeftBehind());
  return recoveryDir;
}

/** Show `docs` in Objects, as picking them in Open Scenes does, for the
 *  integration tests. */
export function showScenesForTest(docs: SceneDocument[]): void {
  shownScenes = new Set(docs);
  sceneTree?.refresh();
}

/** Open Scenes, for the integration tests to read its rows. */
export function openScenesForTest(): OpenScenesProvider {
  return openScenesList!;
}
