/**
 * The studio's 3D view, in a notebook cell.
 *
 * The renderer is the one the VS Code panel uses -- `vscode-extension/media/
 * scene3d.mjs`, bundled in by `tools/build-widget.sh`. Being used from here
 * cost that file two lines: its API object is exported as well as put on
 * `window`, and it reads its three theme colours off the element it was hung
 * in rather than off `document.body`. This file is the host it was already
 * written to be dropped into: it makes an element, hands it a payload, and
 * reads the events the view dispatches back.
 *
 * ## Why the renderer arrives as a *string*
 *
 * anywidget imports a widget's module afresh for each widget, from a blob of
 * its own, so a renderer imported here would come once per widget: a copy of
 * three.js apiece, and a WebGL renderer apiece. A page gets about sixteen
 * WebGL contexts, past which the browser drops the oldest and its view goes
 * blank. So the bundled `scene3d.mjs` arrives as text and is imported from a
 * blob once a page (`shared`), and each view is a `createScene3d()` of it:
 * every view on the page draws with the one renderer that module holds.
 */
import rendererSource from "../../build/renderer.txt";
import { watchDrags } from "./drag.mjs";
import { createColorBar } from "./colorbar.mjs";
import { createGrid, MOST_PANES } from "./grid.mjs";
import { createLegend, drawnIn, partsIn } from "./legend.mjs";
import { createInspector } from "./inspector.mjs";
import { HOME, MARK } from "./mark.mjs";
import {
  declaredTheme,
  nearestBackdrop,
  soleBackdrops,
  surroundings,
} from "./theme.mjs";
import { QUANTITY, createVariables } from "./variables.mjs";

/** What the views of this build share on the page: the renderer's module,
 *  imported once -- see "Why the renderer arrives as a string" above. Keyed
 *  by the build (`WIDGET_BUILD` is stamped in by `tools/build-widget.sh`): a
 *  notebook can hold the output of an older one, whose views need not answer
 *  to this one's calls. */
const shared = (globalThis[
  Symbol.for(`magpylib-studio.widget/${WIDGET_BUILD}`)
] ??= { renderer: null, views: new Set() });

/** Let go of the views whose element has left the page: a cell re-run in
 *  marimo takes its view away without tearing it down, and what that view
 *  drew would stay on the shared renderer for good. One that comes back --
 *  JupyterLab takes cells far out of sight off the page, and puts them back
 *  as they are scrolled to -- is drawn again (`release`). Only views that
 *  have drawn are held here, and a view draws only once it is on the page:
 *  Jupyter renders a widget before attaching it, and a view not yet attached
 *  is not one that has gone. */
function sweep() {
  for (const held of [...shared.views]) {
    if (!held.view.isConnected) held.release();
  }
}

/** The renderer's module, imported the first time a view asks. A failed
 *  import is not kept: the next draw tries again, rather than failing on the
 *  same rejected promise. */
function loadRenderer() {
  if (shared.renderer) return shared.renderer;
  const url = URL.createObjectURL(
    new Blob([rendererSource], { type: "text/javascript" }),
  );
  shared.renderer = import(url).finally(() => URL.revokeObjectURL(url));
  shared.renderer.catch(() => (shared.renderer = null));
  return shared.renderer;
}

function pressed(el, on) {
  el.classList.toggle("on", on);
  el.setAttribute("aria-pressed", String(on));
}

/** Line icons on a 16-unit grid, stroked in the text's colour so they follow
 *  the notebook's theme. */
const ICONS = {
  legend: '<path d="M2.5 3.5h7M4.5 3.5V12M4.5 8h2M4.5 12h2M8.5 8h5M8.5 12h5"/>',
  axes:
    '<path d="M4 13.5V2.5M2.5 4 4 2.5 5.5 4"/>' +
    '<path d="M4 13.5h9.5M12 12l1.5 1.5-1.5 1.5"/><path d="M4 13.5 8.5 9"/>',
  cube:
    '<path d="M10.5 1.75l3.25 1.75v3.5l-3.25 1.75-3.25-1.75v-3.5z"/>' +
    '<path d="M7.25 3.5l3.25 1.75 3.25-1.75M10.5 5.25v3.5"/>' +
    '<path d="M2 11.5v2h7v-2"/>',
  fit:
    '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/>' +
    '<rect x="5.5" y="5.5" width="5" height="5" rx="1"/>',
  projection:
    '<path d="M8 1.75l5.5 3v6.5L8 14.25l-5.5-3v-6.5z"/>' +
    '<path d="M2.5 4.75 8 7.75l5.5-3M8 7.75v6.5"/>',
  expand: '<path d="M9.5 2H14v4.5M14 2 9.5 6.5M6.5 14H2V9.5M2 14l4.5-4.5"/>',
  shrink: '<path d="M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14"/>',
  download: '<path d="M8 2v8M4.75 6.75 8 10l3.25-3.25M2.5 11.5V14h11v-2.5"/>',
  picture:
    '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.75l1.25-1.5h3L10.75 4h1.75' +
    'A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>' +
    '<circle cx="8" cy="8.25" r="2.5"/>',
  auto:
    '<circle cx="8" cy="8" r="5.5"/>' +
    '<path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none"/>',
  light:
    '<circle cx="8" cy="8" r="2.75"/>' +
    '<path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06' +
    'M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06"/>',
  dark: '<path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z"/>',
  play: '<path d="M5 3.25v9.5L12.5 8z" fill="currentColor" stroke="none"/>',
  move:
    '<path d="M8 1.5v13M1.5 8h13M6 3.5l2-2 2 2M6 12.5l2 2 2-2' +
    'M3.5 6l-2 2 2 2M12.5 6l2 2-2 2"/>',
  turn: '<path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13 2v3h-3"/>',
  resize:
    '<rect x="2.5" y="6.5" width="7" height="7" rx="1"/>' +
    '<path d="M9 2.5h4.5V7M13.5 2.5 9.5 6.5"/>',
  aim:
    '<circle cx="8" cy="8" r="5.5"/>' +
    '<path d="M8 11V5M5.75 7.25 8 5l2.25 2.25"/>',
  world:
    '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11' +
    "M8 2.5c1.9 1.6 2.6 3.6 2.6 5.5S9.9 11.9 8 13.5" +
    'M8 2.5C6.1 4.1 5.4 6.1 5.4 8s.7 3.9 2.6 5.5"/>',
  local:
    '<path d="M3.5 12.5 13 8.5M3.5 12.5 7 3"/>' +
    '<circle cx="3.5" cy="12.5" r="1"/>',
  keys:
    '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/>' +
    '<path d="M4 6.75h1M7.5 6.75h1M11 6.75h1M4.5 9.5h7"/>',
  object:
    '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/>' +
    '<path d="M5 6h6M5 8.5h6M5 11h4"/>',
  undo: '<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/>',
  redo: '<path d="M10.5 3l3 3-3 3"/><path d="M13.5 6h-7a4 4 0 0 0 0 8H9"/>',
  edit: '<path d="M11.5 2.5l2 2-8 8h-2v-2z"/><path d="M10 4l2 2"/>',
  revert: '<path d="M2.5 3v3.5H6"/><path d="M3.2 6.5a5 5 0 1 1-.5 3.5"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9" stroke-width="2"/>',
  // a bar magnet's field, three lines a side, traced and stretched to a
  // streamlines, a flux: pulses run along them once as a cue, as the view
  // runs them along a current (`.magpy-flow-pulse` in widget.css)
  flow:
    '<path d="M3 4.5c3-1.8 5.5 1.8 11.5 0" stroke-width="1.4"/>' +
    '<path class="magpy-flow-pulse" style="--at: 10" d="M3 4.5c3-1.8 5.5 1.8 11.5 0" ' +
    'stroke-width="2.6" pathLength="100" stroke-dasharray="16 84"/>' +
    '<path d="M1.5 8c3.5-2 6.5 2 13 0" stroke-width="1.4"/>' +
    '<path class="magpy-flow-pulse" style="--at: 30" d="M1.5 8c3.5-2 6.5 2 13 0" ' +
    'stroke-width="2.6" pathLength="100" stroke-dasharray="16 84"/>' +
    '<path d="M2.5 11.5c3-1.8 5.5 1.8 10 0" stroke-width="1.4"/>' +
    '<path class="magpy-flow-pulse" style="--at: 18" d="M2.5 11.5c3-1.8 5.5 1.8 10 0" ' +
    'stroke-width="2.6" pathLength="100" stroke-dasharray="16 84"/>',
  // every variant beside the scene, and back to the scene alone
  tile:
    '<rect x="2" y="2" width="5" height="5" rx="1"/>' +
    '<rect x="9" y="2" width="5" height="5" rx="1"/>' +
    '<rect x="2" y="9" width="5" height="5" rx="1"/>' +
    '<rect x="9" y="9" width="5" height="5" rx="1"/>',
  // the panes stacked back into one, closed: VS Code's "close all" mark
  untile:
    '<rect x="4.5" y="4.5" width="9.5" height="9.5" rx="1.2"/>' +
    '<path d="M2 11.5V3a1 1 0 0 1 1-1h8.5"/>' +
    '<path d="M7.25 7.25l4 4M11.25 7.25l-4 4"/>',
  // a ruler laid across, its marks along one edge (#125)
  ruler:
    '<path d="M2 11 11 2l3 3-9 9z"/>' +
    '<path d="M5 8l1.5 1.5M7 6l1 1M9 4l1.5 1.5"/>',
  sliders:
    '<path d="M2 4h12M2 8h12M2 12h12"/>' +
    '<circle cx="6" cy="4" r="1.6"/><circle cx="10.5" cy="8" r="1.6"/>' +
    '<circle cx="5" cy="12" r="1.6"/>',
};

function setIcon(button, icon) {
  button.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    ICONS[icon] +
    "</svg>";
}

/** With no text on it, a button's name is its tooltip and what a screen
 *  reader says -- which is where the key that does the same goes, too. */
function name(button, text) {
  button.title = text;
  button.setAttribute("aria-label", text);
}

/** Play a button's icon once, as a cue to what it does: its animation, put
 *  on with `magpy-cue` and taken off when it ends, to be played again. */
function cue(button) {
  button.classList.remove("magpy-cue");
  void button.offsetWidth; // the class gone, for the animation to start over
  button.classList.add("magpy-cue");
  button.addEventListener(
    "animationend",
    () => button.classList.remove("magpy-cue"),
    { once: true },
  );
}

function iconButton(icon, text, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "magpy-icon";
  setIcon(el, icon);
  name(el, text);
  el.addEventListener("click", onClick);
  return el;
}

/** What the picture button saves the view as, before the browser asks. */
const PICTURE_NAME = "magpylib-scene.png";

/** What a view says when python does not send the step it asked for. */
const NO_ANSWER =
  "No answer from Python for this step: the kernel may be busy or not " +
  "running. Run the cell again to play this run.";

/** What a view says when python does not answer an edit. */
/** How long, in ms, python may take to answer what was asked before the view
 *  says it is being waited on (`watchBusy`): long enough that a drag answered
 *  at pointer rate never shows it, short enough to say so before one wonders.
 *  Counted from the asking -- a slider moved, a pose reached -- not from the
 *  sending: a value held back behind the one away has been waited on too. */
const BUSY_AFTER = 350;

// The busy ring's turn, an angle the ring's colours are laid from and its
// animation runs through. widget.css registers it with `@property`, which a
// browser ignores in a shadow root -- where marimo draws a widget -- and the
// ring then stood still, drawn half the time. Registered here, it is the
// whole page's.
try {
  CSS.registerProperty({
    name: "--magpy-busy-turn",
    syntax: "<angle>",
    inherits: false,
    initialValue: "0deg",
  });
} catch {
  // registered already, by another view of the page
}

const NO_EDIT_ANSWER =
  "No answer from Python for this edit yet: the kernel may be busy or not " +
  "running. The view catches up if it answers.";

/** The style group of a sensor's part (legend.mjs), which the object panel
 *  opens at when the part's row is picked: the field lines are coloured as
 *  the pixels are, by `pixel.field`. */
const PART_STYLE = { Axes: "arrows", Pixels: "pixel", FieldLines: "pixel" };

/** The keys that pick the handles, as the studio's panel has them. */
const HANDLE_KEYS = {
  w: "translate",
  e: "rotate",
  r: "scale",
  p: "polarization",
  q: "none",
};

/** What a drag in each mode writes: what an expression deciding it loses. */
const DRAG_WRITES = {
  translate: "position",
  rotate: "orientation",
  scale: "shape",
  polarization: "polarization",
};

/** The resizes whose faces move one at a time: the shape's middle moves
 *  with them, which is its position (`scene3d`'s grips). */
const FACED = new Set(["free", "cylinder", "segment"]);

/** How each field a drag writes reads in the readout: what it is in, how
 *  much of it is worth showing, how wide its box is -- what the widest value
 *  of that kind needs, "-0.0100" or "-180.0" -- and where the scene says
 *  what it holds now. Fixed decimals rather than significant figures: those
 *  change the length of a number as it crosses a scale, which at pointer
 *  rate reads as a twitch. */
const FIELD_READS = {
  position: { kind: "length", width: "7ch", from: "anchors" },
  orientation: { kind: "angle", width: "6ch", from: "orientations" },
  shape: { kind: "length", width: "7ch", from: "shapes" },
  polarization: { kind: "field", width: "7ch", from: "polarizations" },
};

/** The unit a kind is shown in when the scene says nothing: SI, and
 *  degrees. The scene's own choice arrives in the payload (`units`). */
const SI = {
  length: { symbol: "m", scale: 1 },
  angle: { symbol: "°", scale: 1 },
  field: { symbol: "T", scale: 1 },
};

/** How much of a number is worth showing in each unit: a tenth of a
 *  millimetre whether the box says metres or millimetres. */
const DECIMALS = { m: 4, cm: 2, mm: 2, µm: 1, "°": 1, T: 4, mT: 1, µT: 1 };

/** The keys, as the key list says them: the view's everywhere, and the
 *  handles' where the view edits. */
const KEY_LIST = {
  view: [
    ["F", "frame the selection — Home: everything"],
    ["1 · 3 · 7", "look from the front, the right, the top"],
    ["5", "perspective or parallel"],
    ["H", "hide the selection — ⇧H: show only it"],
    ["⌥ / Alt on an eye", "click: show only that row — slide: fade the rest"],
    [
      "M",
      "measure: a corner, an edge, a face, a round surface or a wire's curve, then another — again: select, the measurements kept",
    ],
    [
      "Esc",
      "select nothing — then the measurements; measuring: the pick first",
    ],
    ["space", "play the path"],
    ["⌘ / Ctrl click", "add to the selection"],
  ],
  edit: [
    ["W · E · R · P", "move, turn, resize, aim the polarization"],
    ["Q", "put the handles away"],
    ["V · O", "the variables panel, the object panel — again: away"],
    ["X · Y · Z", "along one axis — A: all of them"],
    ["L", "the world's axes, or the object's own"],
    ["C", "select the collection it is in — again: the one round that"],
    ["S", "snap to round steps"],
    ["⇧ in a drag", "snap onto the other objects' corners"],
    ["⌘ / Ctrl click a dot", "pick its point — ⌥ drag: the dots in a box"],
    ["Delete", "take the point out of a wire"],
    ["Esc in a drag", "take the drag back"],
    ["⌘Z", "undo — ⇧⌘Z: redo"],
  ],
};

/** The axes button's round: each way the scale is said, its icon, what it is
 *  called -- in full, and in a word or two as the next one -- and the next. */
const AXES = {
  cube: {
    icon: "cube",
    says: "Scale: a view cube and a scale bar",
    named: "the view cube",
    next: "box",
  },
  box: {
    icon: "axes",
    says: "Scale: the graduated box",
    named: "the box",
    next: "none",
  },
  none: { icon: "axes", says: "Scale: not shown", named: "none", next: "cube" },
};

/** One of `AXES`, from what the model holds: `true` and `false` are what a
 *  view saved before there was a choice holds, and were the box and none. */
function axesChoice(value) {
  if (AXES[value]) return value;
  if (value === true) return "box";
  return value === false ? "none" : "cube";
}

/** The theme button's round: each choice, what it is called, and the next. */
const THEMES = {
  auto: { says: "Theme: as the notebook is", next: "light" },
  light: { says: "Theme: light", next: "dark" },
  dark: { says: "Theme: dark", next: "auto" },
};

/** How many rows a tree makes. */
const rowsIn = (nodes) =>
  nodes.reduce((count, node) => count + 1 + rowsIn(node.children), 0);

/** The id of the collection holding `objectId` in `tree`: null at the top,
 *  undefined when it is not there at all. */
function parentIn(tree, objectId, holder = null) {
  for (const node of tree) {
    if (node.id === objectId) return holder;
    const found = parentIn(node.children || [], objectId, node.id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** `objectIds`, with each collection among them as what it holds -- the
 *  payload's `collections` -- and only what is drawn: what can be hidden. */
function drawnFor(objectIds, payload) {
  const collections = payload?.collections || {};
  const drawn = new Set();
  for (const objectId of objectIds) {
    for (const each of collections[objectId] ?? [objectId]) {
      if (!collections[each]) drawn.add(each);
    }
  }
  return [...drawn];
}

function render({ model, el }) {
  el.classList.add("magpy-scene");

  // The renderer owns `view` -- it hangs its canvas there and watches its
  // size -- so the legend floats beside it, in a stage they share, rather
  // than inside something that is not the widget's to fill.
  const stage = document.createElement("div");
  stage.className = "magpy-scene-stage";
  // Focusable, so the view's keys can be the view's alone: they act only
  // while it has focus, and a notebook's own shortcuts are left alone the
  // rest of the time. JupyterLab reads this attribute as "not while focus is
  // in here"; marimo and the rest are kept out by stopping the event.
  stage.tabIndex = 0;
  stage.setAttribute("data-lm-suppress-shortcuts", "true");
  const view = document.createElement("div");
  view.className = "magpy-scene-view";
  view.style.height = `${model.get("height")}px`;
  const legendEl = document.createElement("div");
  legendEl.className = "magpy-scene-legend";
  // A pulse of current round the view's edge, as round a coil, while python
  // is slow to answer (`watchBusy`): out of sight the rest of the time.
  const busyRing = document.createElement("div");
  busyRing.className = "magpy-scene-busy";
  // The view in a pane of its own, which variants dropped beside it split
  // (`grid.mjs`): alone, it is the view as it always was.
  const panesEl = document.createElement("div");
  panesEl.className = "magpy-scene-panes";
  stage.append(panesEl, legendEl, busyRing);
  let gridScenes = []; // each variant pane's { scene, tree }: legend and scale
  let sharedModule = null; // the renderer's module, once loaded: see `draw`

  // --- controls ---------------------------------------------------------
  // Over the view, as Plotly's are, rather than in a bar beneath it: the
  // tools in the top corner, out of sight until the pointer is on the view,
  // and a run's transport along the foot, in sight whenever there is a run --
  // where in the run the picture is being not a tool but the state.
  const tools = document.createElement("div");
  tools.className = "magpy-scene-tools";
  const legendButton = iconButton(
    "legend",
    "Legend — double-click a name to frame it; H hides the selection, " +
      "shift-H shows only it",
    () => showLegend(!legendOpen),
  );
  const axesButton = iconButton("axes", "", () =>
    commit("axes", AXES[axesChoice(model.get("axes"))].next),
  );
  const flowButton = iconButton(
    "flow",
    "Flow — pulses along each current, the way it runs, and along each " +
      "field line, the way the field points",
    () => {
      const on = model.get("flow") === false;
      commit("flow", on);
      if (on) cue(flowButton);
    },
  );
  const fitButton = iconButton(
    "fit",
    "Frame everything (Home) — F frames the selection; 1, 3, 7 look from " +
      "the front, the right and the top",
    () => (grid.split ? grid.fit() : api?.fitView()),
  );
  const projectionButton = iconButton(
    "projection",
    "Orthographic projection (5)",
    () => showProjection(api?.toggleProjection()),
  );
  pressed(projectionButton, false); // perspective, until it is switched
  // A view is read only until someone asks: the pencil asks, and the handles
  // come out; pressed again, they go away, and the edits stay. Where the
  // objects are the cell's own, python first copies them into a studio
  // session, as `editable=True` does when the view is made; a view of a
  // session has one already. Shown only where there is something to edit
  // and a python to keep the edits -- see `showEditing`.
  const editButton = iconButton(
    "edit",
    "Edit — move, turn, resize and aim the objects, with undo, in a studio " +
      "session in the kernel; again to put the handles away",
    () => {
      const out = !editable();
      notify(
        out
          ? "Editing — W moves, E turns, R resizes, P aims; Q puts the handles away"
          : "Handles away — the edits stay; the pencil brings them back",
      );
      commit("editable", out);
    },
  );
  // The scene's variables as a panel over the view: a slider each, and the
  // scene following as one is dragged (`variables.mjs`, the same rows as the
  // studio's Variables view). With the handles, since moving a variable is an
  // edit like a drag: its toggle is at the foot of the edit column and the
  // panel docks beside it, so everything about editing hangs on the right
  // edge and the hover bar above is the view's. Not on a saved page, nor in
  // the studio panel, whose host has a Variables view of its own. See
  // `dressEditing`.
  // the dock the panels open in: made below, once the stage is in place
  let dock = null;
  let dockTitle = null;
  const variablesEl = document.createElement("div");
  variablesEl.className = "magpy-scene-variables";
  variablesEl.hidden = true;
  const variablesButton = iconButton(
    "sliders",
    "Variables — drag a value and the scene follows; a typed value takes a " +
      "unit, 15 mm or 2 cm",
    () => showVariables(variablesEl.hidden),
  );
  pressed(variablesButton, false);
  // Compact over the view: the rows and nothing else. The limits ride in
  // the tooltips, and the expression help is the sidebar's.
  // What a panel says about itself as a whole, in the dock's title line:
  // the one restore for the variables a drag or a step took over, and the
  // one reset for the appearance set on the selection. A slot each, shown
  // with its panel.
  const dockActionsVariables = document.createElement("span");
  dockActionsVariables.className = "magpy-scene-dock-actions";
  const dockActionsObject = document.createElement("span");
  dockActionsObject.className = "magpy-scene-dock-actions";
  const variables = createVariables(variablesEl, {
    // a preview asks for the scene in the same message, and redraws from it
    rpc: (method, params, { preview = false, since } = {}) =>
      call(method, params, { preview, scene: preview, since }),
    onPreview: redrawFromSession,
    empty: "No variables: a scene function's parameters are its variables.",
    compact: true,
    head: dockActionsVariables,
    variants: false, // along the foot of the view instead
  });
  function showVariables(open) {
    variablesEl.hidden = !open;
    pressed(variablesButton, open);
    if (open) {
      if (!inspectorEl.hidden) showInspector(false); // one panel at a time
      variables.refresh();
    }
    syncDock();
  }
  // The selection's properties -- its parameters, its pose and, folded under
  // one heading, its style, as the studio's Inspector shows them
  // (`inspector.mjs`), compact: no step editor, a cell being a bounded box.
  // Beside the column with the variables, one of the two open at a time; it
  // follows the selection.
  const inspectorEl = document.createElement("div");
  inspectorEl.className = "magpy-scene-inspector";
  inspectorEl.hidden = true;
  const inspectorButton = iconButton(
    "object",
    "Object — the selection's parameters, pose and style; type 15 mm, 5° " +
      "or a variable's name",
    () => showInspector(inspectorEl.hidden),
  );
  pressed(inspectorButton, false);
  const inspector = createInspector(inspectorEl, {
    rpc: (method, params) => call(method, params),
    // a wire's colour, or a mesh's own, as the view draws the object
    drawnColor: (objectId) => {
      const payload = model.get("payload") || {};
      const own = (item) => item.object_id === objectId && !item.copy;
      const wire = (payload.scatters ?? []).find((s) => own(s) && !s.path);
      return wire?.line_color ?? (payload.meshes ?? []).find(own)?.color;
    },
    onEdited: (result) => {
      if (result?.defined?.length) {
        const made = result.defined.join(", ");
        notify(`${made} made, at the value it replaces — the sliders have it`);
      }
    },
    compact: true,
    empty: "Select an object: its parameters and pose come here.",
    head: dockActionsObject,
  });
  function showInspector(open) {
    inspectorEl.hidden = !open;
    pressed(inspectorButton, open);
    if (open) {
      if (!variablesEl.hidden) showVariables(false); // one panel at a time
      inspector.show((model.get("selected") || [])[0]);
    }
    syncDock();
    showReadout(); // put away while the panel says the pose, or back
  }
  /** The scene as the session has it now, drawn: after a previewed value,
   *  which python answers without redrawing the view or telling the
   *  notebook, as it answers a pose mid-drag. The answer carries the scene
   *  when the call asked for it; else it is asked for. */
  async function redrawFromSession(answer) {
    try {
      const payload = answer?.scene ?? (await editor.scene());
      if (drawing()) api.render(view, payload);
    } catch {
      // the release reports; a preview nobody answered is not worth saying
    }
  }
  // Python writes the file -- it has every piece of it on disk -- and hands
  // it back to be saved. A page that is itself an export has no python
  // behind it to ask, and no button.
  const exportButton = iconButton(
    "download",
    "Save as one HTML file that works anywhere — orbit, legend, keys and " +
      "playback, no notebook needed",
    () => {
      // Nothing to choose, one click; a run or variants to leave out, the
      // foot asks first, everything kept (`startChoosing`).
      if (choosing) stopChoosing();
      else if (frames() > 1 || (model.get("variants") || []).length) {
        startChoosing();
      } else saveAs({ run: true, variants: true });
    },
  );
  function saveAs(choice) {
    exportJob = `${viewTag}-${++exports}`;
    showWriting({ text: "Writing…", done: 0, total: 0, job: exportJob });
    // The camera with it, so the file opens on what is on screen now
    // rather than on what was last reported.
    model.send({
      kind: "export",
      camera: api?.cameraState() ?? kept,
      job: exportJob,
      run: choice.run,
      steps: choice.steps,
      variants: choice.variants,
    });
  }
  // The view's own export, named: python writes one a piece at a time, this
  // view asking for each next piece, so a cancel is heard between them. The
  // name is this view's -- another view of the same widget hears the same
  // messages -- and null once it is done or stopped.
  const viewTag = Math.random().toString(36).slice(2, 10);
  let exports = 0;
  let exportJob = null;
  exportButton.hidden = Boolean(model.get("standalone"));
  // Taken here, not by python: the picture is what the browser drew, and a
  // page that is itself an export can take one as well.
  const pictureButton = iconButton(
    "picture",
    "Save the view as a PNG picture",
    async () => {
      // split, every pane as it stands, with its tag (#149)
      const shot = grid.split
        ? await grid.picture()
        : api && { picture: api.snapshot(), width: view.clientWidth };
      if (!shot?.picture) return;
      // with the colour bar on it, as the scale bar is: see `drawOn`
      const drawn = await colorBar
        .drawOn(shot.picture, shot.width)
        .catch(() => shot.picture);
      save(drawn, PICTURE_NAME);
    },
  );
  // A round rather than a toggle: auto, then light, then dark. The icon is
  // what is in force now; its name says what a click moves to.
  const themeButton = iconButton("auto", "", () =>
    commit("theme", THEMES[themeChoice()].next),
  );
  // Some hosts cannot give an element the screen -- VS Code's notebook
  // outputs, for one, are frames that do not allow it -- and a button that
  // can only fail is worse than none.
  const fullscreenButton = iconButton("expand", "Full screen", () =>
    toggleFullscreen(),
  );
  fullscreenButton.hidden = !document.fullscreenEnabled;
  pressed(fullscreenButton, false);
  const keysButton = iconButton("keys", "Keys", () => showKeys(keyList.hidden));
  pressed(keysButton, false);
  const keyList = document.createElement("div");
  keyList.className = "magpy-scene-keys";
  keyList.hidden = true;
  /** The key list, open or shut -- with the handles' keys where there are
   *  handles. Built when opened, so it says what this view has now. */
  function showKeys(open) {
    keyList.hidden = !open;
    pressed(keysButton, open);
    if (!open) return;
    const rows = [
      ...KEY_LIST.view,
      ...(model.tabWalks
        ? [["Tab", "select the next object — ⇧Tab: the one before"]]
        : []),
      // where the pencil is, the handle keys are the pencil
      ...(!editable() && !editButton.hidden
        ? [["W · E · R · P", "edit — the handles come out, in that mode"]]
        : []),
      ...(editable() ? KEY_LIST.edit : []),
    ];
    keyList.replaceChildren(
      ...rows.flatMap(([keys, does]) => {
        const kbd = document.createElement("kbd");
        kbd.textContent = keys;
        const text = document.createElement("span");
        text.textContent = does;
        return [kbd, text];
      }),
    );
  }
  // Editing, for a view whose objects are a session's -- see `editable`. A
  // shelf of their own down the side, always in sight: which handles are out
  // is the state of the view, not a tool to reach for.
  const editBar = document.createElement("div");
  editBar.className = "magpy-scene-edit";
  const handleButton = (icon, text, mode) =>
    iconButton(icon, text, () => setHandles(mode, { asked: true }));
  const modeButtons = {
    translate: handleButton(
      "move",
      "Move (W) — Q puts the handles away",
      "translate",
    ),
    rotate: handleButton("turn", "Turn (E)", "rotate"),
    scale: handleButton(
      "resize",
      "Resize (R) — objects with one size to drag",
      "scale",
    ),
    polarization: handleButton(
      "aim",
      "Aim the polarization (P)",
      "polarization",
    ),
  };
  const spaceButton = iconButton("world", "", () => toggleSpace());
  const undoButton = iconButton("undo", "Undo (⌘Z / Ctrl+Z)", () =>
    settle(editor.undo()),
  );
  const redoButton = iconButton("redo", "Redo (⇧⌘Z / Ctrl+Shift+Z)", () =>
    settle(editor.redo()),
  );
  // Every edit since this view's editing started, taken back in one step --
  // which undo takes back in turn. A host's own editor may have no such
  // start; then there is no button.
  const resetButton = iconButton(
    "revert",
    "Back to where editing started — one step, which undo takes back",
    () => editor.reset && settle(editor.reset()),
  );
  const rule = () => {
    const line = document.createElement("div");
    line.className = "magpy-scene-rule";
    return line;
  };
  // The editor's panels hang on this column, toggled from its foot: the
  // variables now, the selection later. One home for everything about
  // editing; the bar above is the view's.
  const panelToggles = document.createElement("div");
  panelToggles.className = "magpy-scene-edit-panels";
  panelToggles.append(rule(), variablesButton, inspectorButton);
  editBar.append(
    ...Object.values(modeButtons),
    spaceButton,
    rule(),
    undoButton,
    redoButton,
    resetButton,
    panelToggles,
  );
  // In groups, left to right: the camera; what is shown; editing; what
  // you take away; the window. A group whose every button is hidden -- the
  // pencil on a saved page -- goes with them, rule and all (see the CSS).
  const group = (...buttons) => {
    const span = document.createElement("span");
    span.className = "magpy-scene-tool-group";
    span.append(...buttons);
    return span;
  };
  // Last, as Plotly's toolbar ends with its own mark: magpylib's, a link
  // to where the studio is explained, opened beside the notebook.
  const mark = document.createElement("a");
  mark.className = "magpy-icon magpy-mark";
  mark.href = HOME;
  mark.target = "_blank";
  mark.rel = "noopener";
  name(mark, "Built with magpylib-studio");
  const markImage = document.createElement("img");
  markImage.src = MARK;
  markImage.alt = "";
  mark.append(markImage);
  // The ruler: a view setting, so in every view, a saved page's too; the
  // renderer says when it turns on or off, a key or Esc included.
  const rulerButton = iconButton(
    "ruler",
    "Measure: click a corner, an edge, a face, a round surface or a wire's curve, then another (M)",
    () => api?.setRuler(!api.rulerOn()),
  );
  pressed(rulerButton, false);
  view.addEventListener("rulerchange", (event) => {
    pressed(rulerButton, event.detail.on);
    mirrorRuler(event.detail.on, api);
  });
  view.addEventListener("measurechange", (event) => {
    mirrorMeasurements(event.detail.list, api);
    tellMeasurements();
  });
  // Split into panes, one ruler and one list of measurements for them all,
  // each pane's at its own variant (#125): a view that changed them, by a
  // key, a click or a label's x, has them handed on to the others.
  const rulerViews = () => [api, ...grid.apis].filter(Boolean);
  function mirrorRuler(on, from) {
    for (const each of rulerViews()) if (each !== from) each.setRuler(on);
  }
  function mirrorMeasurements(list, from) {
    for (const each of rulerViews()) {
      if (each !== from) each.setMeasurements(list);
    }
  }
  // The measurements as the `measurements` trait says them, for a notebook
  // to read and a saved page to carry: each pair's ends, and what it reads in
  // the scene's view -- a length in metres, or an angle in degrees. Told
  // when one is made or taken away, and once the scene settles after it
  // moved (`MEASURE_SETTLE`): not at every step of a drag.
  const MEASURE_SETTLE = 250;
  let measureSoon = null;
  function tellMeasurements() {
    clearTimeout(measureSoon);
    measureSoon = null;
    if (!api) return;
    const now = api.measurements().map((m) => ({
      a: m.a,
      b: m.b,
      length: m.angle == null ? m.metres : null,
      angle: m.angle,
    }));
    const told = model.get("measurements") || [];
    if (JSON.stringify(told) === JSON.stringify(now)) return;
    // ends named by a point, as this view named them: the panes take its
    // names, each having named them by a variant of its own
    if (told.some(({ a, b }) => a?.near || b?.near)) {
      mirrorMeasurements(
        now.map(({ a, b }) => ({ a, b })),
        api,
      );
    }
    model.set("measurements", now);
    model.save_changes();
  }
  function tellMeasurementsSoon() {
    clearTimeout(measureSoon);
    if (api?.rulerPairs().length || (model.get("measurements") || []).length) {
      measureSoon = setTimeout(tellMeasurements, MEASURE_SETTLE);
    }
  }
  const sameEnd = (p, q) =>
    ["kind", "objectId", "part", "index"].every(
      (key) => p?.[key] === q?.[key],
    ) && String(p?.near) === String(q?.near);
  /** The measurements the trait names, in every view, where they are not
   *  the ones there: assigned from python, or a saved page's. */
  function showMeasurements() {
    if (!api) return;
    const pairs = (model.get("measurements") || []).map(({ a, b }) => ({
      a,
      b,
    }));
    const have = api.rulerPairs();
    const same =
      have.length === pairs.length &&
      have.every(
        (m, i) => sameEnd(m.a, pairs[i].a) && sameEnd(m.b, pairs[i].b),
      );
    if (same) return;
    api.setMeasurements(pairs);
    mirrorMeasurements(pairs, api);
    tellMeasurementsSoon(); // what they read, once drawn
  }
  tools.append(
    group(fitButton, projectionButton, rulerButton),
    group(legendButton, axesButton, flowButton, themeButton),
    group(editButton),
    group(pictureButton, exportButton),
    group(keysButton, fullscreenButton),
    group(mark),
  );

  const transport = document.createElement("div");
  transport.className = "magpy-scene-transport";
  transport.hidden = true; // until a payload says there is a run
  const play = iconButton("play", "Play the path (space)", () =>
    setPlaying(!playing),
  );
  const scrub = document.createElement("input");
  scrub.type = "range";
  scrub.min = "0";
  scrub.value = "0";
  scrub.className = "magpy-scene-scrub";
  scrub.setAttribute("aria-label", "Step of the run");
  const counter = document.createElement("span");
  counter.className = "magpy-scene-counter";
  transport.append(play, scrub, counter);

  // The scene's variants (#118), in the foot beside the transport: a toggle
  // each, the one the values are in pressed. A click asks the
  // session, as the variables panel did, or -- on a saved page -- the page,
  // which drew each ahead (`_PAGE` in widget.py). Not in the studio panel,
  // whose host lists them in its Variables view.
  const variantsEl = document.createElement("div");
  variantsEl.className = "magpy-scene-variants";
  variantsEl.hidden = true;
  let variantRow = null; // made for a scene that has variants, and only then

  // Beside the chips: every variant in a pane of its own at once, laid out
  // in a grid -- and, every one out, all of them back, the scene alone.
  const spreadButton = iconButton("tile", "", () => spread());
  spreadButton.classList.add("magpy-scene-spread");
  spreadButton.hidden = true;
  let spreadFull = false; // what a press does: close them all, or open them

  // A page being written: how far, and -- the view's own export -- a button
  // that stops it.
  const writing = document.createElement("div");
  writing.className = "magpy-scene-writing";
  writing.hidden = true;
  writing.setAttribute("role", "status");
  const writingText = document.createElement("span");
  const writingCount = document.createElement("span");
  writingCount.className = "magpy-scene-counter";
  // a word, in the variants' material, rather than an icon to puzzle out
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.className = "magpy-vars-chip";
  stopButton.textContent = "Cancel";
  stopButton.title = "Stop writing the file";
  stopButton.addEventListener("click", () => {
    model.send({ kind: "export-cancel", job: exportJob });
    exportJob = null; // what is still on its way is for none
    hideWriting();
    notify("Stopped writing the file");
  });
  writing.append(writingText, writingCount, stopButton);

  // Choosing what a page carries, in the foot, before it is written: two
  // markers on the run's slider keep a stretch of it, a click on a
  // variant's chip leaves it out or takes it back, and Save or Cancel at
  // the end of the line. Everything kept to start.
  let choosing = null; // { first, last, out } while the foot asks
  const trim = document.createElement("div");
  trim.className = "magpy-scene-trim";
  trim.hidden = true;
  const trimEnd = (label) => {
    const end = document.createElement("input");
    end.type = "range";
    end.min = "0";
    end.setAttribute("aria-label", label);
    end.addEventListener("input", () => {
      if (!choosing) return;
      let first = Number(trimFrom.value);
      let last = Number(trimTo.value);
      // an end dragged past the other takes it along
      if (first > last) {
        if (end === trimFrom) last = first;
        else first = last;
        trimFrom.value = String(first);
        trimTo.value = String(last);
      }
      choosing.first = first;
      choosing.last = last;
      describeChoice();
    });
    trim.append(end);
    return end;
  };
  const trimFrom = trimEnd("First step the page keeps");
  const trimTo = trimEnd("Last step the page keeps");
  transport.insertBefore(trim, counter);
  const choose = document.createElement("div");
  choose.className = "magpy-scene-choose";
  choose.hidden = true;
  const chooseText = document.createElement("span");
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "magpy-vars-chip";
  saveButton.textContent = "Save";
  saveButton.title = "Write the page with what is kept";
  saveButton.addEventListener("click", () => {
    const { first, last, out } = choosing;
    const names = (model.get("variants") || []).filter((n) => !out.has(n));
    const run = frames() > 1;
    stopChoosing();
    saveAs({
      run: true,
      steps: run ? [first, last] : null,
      variants: names.length ? names : false,
    });
  });
  const cancelChoice = document.createElement("button");
  cancelChoice.type = "button";
  cancelChoice.className = "magpy-vars-chip";
  cancelChoice.textContent = "Cancel";
  cancelChoice.title = "Save nothing";
  cancelChoice.addEventListener("click", () => stopChoosing());
  choose.append(chooseText, saveButton, cancelChoice);
  function startChoosing() {
    const last = Math.max(frames() - 1, 0);
    choosing = { first: 0, last, out: new Set() };
    for (const end of [trimFrom, trimTo]) end.max = String(last);
    trimFrom.value = "0";
    trimTo.value = String(last);
    trim.hidden = frames() <= 1;
    scrub.hidden = !trim.hidden;
    counter.hidden = !trim.hidden; // the line says which steps
    choose.hidden = false;
    foot.classList.add("magpy-choosing");
    dressPaned(); // every variant offered to keep, those with a pane too
    pressed(exportButton, true);
    describeChoice();
    keepCorner();
    saveButton.focus();
  }
  function stopChoosing() {
    choosing = null;
    trim.hidden = true;
    scrub.hidden = false;
    counter.hidden = false;
    choose.hidden = true;
    foot.classList.remove("magpy-choosing");
    pickedBefore = null;
    // the row as it was: drawn again, its titles and labels are its own
    if (!variantsEl.hidden) variantRow?.refresh();
    pressed(exportButton, false);
    keepCorner();
  }
  /** What the page will carry, said at the end of the line, and shown on
   *  the trimmed slider and the chips. */
  function describeChoice() {
    const { first, last, out } = choosing;
    const names = model.get("variants") || [];
    const said = [];
    if (frames() > 1) {
      said.push(
        first === last ? `step ${first + 1}` : `steps ${first + 1}–${last + 1}`,
      );
      const span = Math.max(frames() - 1, 1);
      trim.style.setProperty("--from", `${(first / span) * 100}%`);
      trim.style.setProperty("--to", `${(last / span) * 100}%`);
    }
    if (names.length) {
      said.push(`${names.length - out.size} of ${names.length} variants`);
    }
    chooseText.textContent = `Save ${said.join(", ")}`;
    for (const chip of variantsEl.querySelectorAll(".magpy-vars-chip")) {
      chip.classList.toggle("magpy-left-out", out.has(chip.textContent));
      chip.title = out.has(chip.textContent)
        ? `${chip.textContent}: left out of the page -- click to keep it`
        : `${chip.textContent}: kept in the page -- click to leave it out`;
    }
    for (const option of variantsEl.querySelectorAll("option")) {
      if (option.value) {
        option.textContent = out.has(option.value)
          ? `${option.value} (left out)`
          : option.value;
      }
    }
  }
  // Too many for a chip each, the variants are a dropdown: while the foot
  // asks, a pick in it leaves that one out or takes it back, and is no use
  // of it -- the change is taken before the dropdown's own handler hears
  // it, and the dropdown put back where it stood.
  let pickedBefore = null;
  for (const type of ["pointerdown", "focusin"]) {
    variantsEl.addEventListener(
      type,
      (event) => {
        if (choosing && event.target.tagName === "SELECT") {
          pickedBefore ??= event.target.value;
        }
      },
      true,
    );
  }
  variantsEl.addEventListener(
    "change",
    (event) => {
      const pick = event.target;
      if (!choosing || pick.tagName !== "SELECT") return;
      event.stopPropagation();
      const name = pick.value;
      if (choosing.out.has(name)) choosing.out.delete(name);
      else choosing.out.add(name);
      pick.value = pickedBefore ?? "";
      describeChoice();
    },
    true,
  );
  // While the foot asks, a chip says whether its variant is kept: its click
  // is taken before the chip hears it, so nothing is used, slid or selected.
  for (const type of ["pointerdown", "click", "contextmenu"]) {
    variantsEl.addEventListener(
      type,
      (event) => {
        if (!choosing) return;
        const chip = event.target.closest(".magpy-vars-chip");
        if (!chip || !variantsEl.contains(chip)) return;
        event.stopPropagation();
        event.preventDefault();
        if (type !== "click") return;
        const name = chip.textContent;
        if (choosing.out.has(name)) choosing.out.delete(name);
        else choosing.out.add(name);
        describeChoice();
      },
      true,
    );
  }
  const progressBar = document.createElement("div");
  progressBar.className = "magpy-scene-progress";
  progressBar.hidden = true;

  // The foot: one line of what stands there -- the run's transport, the
  // variants, a page being written -- under the scale bar, which stands up
  // off it (`keepCorner`).
  const foot = document.createElement("div");
  foot.className = "magpy-scene-foot";
  foot.hidden = true;
  foot.append(
    transport,
    variantsEl,
    spreadButton,
    choose,
    writing,
    progressBar,
  );
  // Escape, from anywhere in the foot, puts the choice away
  foot.addEventListener("keydown", (event) => {
    if (choosing && event.key === "Escape") {
      event.stopPropagation();
      stopChoosing();
      exportButton.focus();
    }
  });

  // What the view has to say -- a file saved, full screen refused -- said
  // for a moment, and gone.
  const notice = document.createElement("div");
  notice.className = "magpy-scene-notice";
  notice.setAttribute("role", "status");

  stage.append(tools, editBar, variablesEl, inspectorEl, keyList, foot, notice);
  el.append(stage);

  // --- full screen ------------------------------------------------------
  // The whole widget, legend and controls with it, so nothing that works in
  // the cell stops working at full size. Asked of the root the widget sits in,
  // which in marimo is a shadow root: there, the document would name the
  // shadow's host as what is full screen, never this element. Asked when it
  // is needed, not once here: Jupyter renders a widget before attaching it,
  // and the root of an element not yet on the page is the element itself.
  const isFullscreen = () => el.getRootNode().fullscreenElement === el;
  function toggleFullscreen() {
    if (isFullscreen()) document.exitFullscreen();
    else {
      el.requestFullscreen().catch(() =>
        notify("This page does not allow full screen"),
      );
    }
  }
  function onFullscreenChange() {
    const on = isFullscreen();
    pressed(fullscreenButton, on);
    setIcon(fullscreenButton, on ? "shrink" : "expand");
    name(fullscreenButton, on ? "Leave full screen (Esc)" : "Full screen");
    sizeView();
    el.classList.toggle("magpy-fullscreen", on);
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);

  // --- the dock: the panels in a column beside the view ------------------
  // A panel is a column beside the view, which refits to what is left, not
  // a float over it: a float has nowhere to go on a narrow view, where the
  // trouble is room, not position. The column takes a third of the width,
  // and a handle on its inner edge drags it. Narrower than 720px it is a
  // sheet below the view instead, and the widget grows by it: a view of
  // 460px cannot hold the edit column and a sheet both, and a notebook's
  // outputs grow with what is in them.
  // One line of title and the mark that closes it; the column's toggles,
  // pressed, say which panel is open, so the dock has no tabs of its own.
  dock = document.createElement("div");
  dock.className = "magpy-scene-dock";
  dock.hidden = true;
  const dockHandle = document.createElement("div");
  dockHandle.className = "magpy-scene-dock-handle";
  dockHandle.title = "Drag to resize";
  const dockHead = document.createElement("div");
  dockHead.className = "magpy-scene-dock-head";
  dockTitle = document.createElement("span");
  dockTitle.className = "magpy-scene-dock-title";
  const dockClose = document.createElement("button");
  dockClose.type = "button";
  dockClose.className = "magpy-scene-dock-close";
  dockClose.textContent = "×";
  name(dockClose, "Close the panel");
  dockClose.addEventListener("click", () => {
    showVariables(false);
    showInspector(false);
  });
  dockHead.append(
    dockTitle,
    dockActionsVariables,
    dockActionsObject,
    dockClose,
  );
  dock.append(dockHandle, dockHead, variablesEl, inspectorEl);
  el.append(dock);
  const dockRoom = new ResizeObserver(() =>
    el.classList.toggle("magpy-narrow", el.clientWidth < 720),
  );
  dockRoom.observe(el);
  dockHandle.addEventListener("pointerdown", (e) => {
    if (el.classList.contains("magpy-narrow")) return; // the sheet has no edge to drag
    e.preventDefault();
    dockHandle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = dock.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.max(
        160,
        Math.min(el.clientWidth * 0.7, startW - (ev.clientX - startX)),
      );
      el.style.setProperty("--magpy-dock-width", `${w}px`);
    };
    const up = () => {
      dockHandle.removeEventListener("pointermove", move);
      dockHandle.removeEventListener("pointerup", up);
    };
    dockHandle.addEventListener("pointermove", move);
    dockHandle.addEventListener("pointerup", up);
  });
  /** The dock: open with whichever panel is, and named for it. */
  function syncDock() {
    if (!dock) return;
    dock.hidden = variablesEl.hidden && inspectorEl.hidden;
    el.classList.toggle("magpy-docked", !dock.hidden);
    dockTitle.textContent = variablesEl.hidden ? "Object" : "Variables";
    dockActionsVariables.hidden = variablesEl.hidden;
    dockActionsObject.hidden = inspectorEl.hidden;
  }
  /** The view's height: the cell's while in the cell, and the screen's
   *  otherwise; the renderer watches its element and follows either way. */
  function sizeView() {
    const height = isFullscreen() ? "" : `${model.get("height")}px`;
    // split, the panes share the view's height, and the view fills its own
    view.style.height = grid?.split ? "100%" : height;
    panesEl.style.height = grid?.split ? height || "100%" : "";
    if (!grid?.split) panesEl.style.padding = "";
  }

  // What selection and visibility *mean* is the widget's: they are traitlets.
  // The legend reports what a click would make them, as the view does.
  let partStyle = null; // the style group a part's row asked the panel for
  const legend = createLegend(legendEl, {
    onSelect: (ids, { part } = {}) => {
      // a sensor's part, picked: the panel opens at its style, with the
      // selection -- or now, for the sensor selected already
      partStyle = part && !inspectorEl.hidden ? PART_STYLE[part] : null;
      const same = ids.join() === (model.get("selected") || []).join();
      commit("selected", ids);
      if (same && partStyle && !inspectorEl.hidden) {
        inspector.show(ids[0], { group: partStyle });
        partStyle = null;
      }
    },
    onHide: hideAsked,
    // Each step of a slide drawn here, and the model told once, at its end:
    // a kernel round trip a step would trail the pointer.
    onFade: (levels, { settled }) => {
      if (drawing()) api.setFades(levels);
      if (settled) commit("faded", levels);
    },
    onFrame: (ids) => api?.fitView(ids),
    onHint: (ids) => api?.hint(ids),
    // An overlap marked as meant, or warned about again: an edit, settled
    // like any other, so the scene comes back without it.
    onIntend: ([a, b], intended) =>
      call("set_overlap_intended", { a, b, intended }).catch(() => {}),
    // How far apart two selected objects are, which only a session can say.
    onMeasure: (a, b) => (editable() ? call("get_gap", { a, b }) : null),
    canEdit: () => editable(),
  });
  // The colour bar of a sensor the field colours, and its cut: a view
  // setting, drawn at every step of a drag and the model told at its end,
  // as a fade is.
  const colorBarEl = document.createElement("div");
  stage.append(colorBarEl);
  const colorBar = createColorBar(colorBarEl, {
    onRange: (ranges, { settled }) => {
      if (drawing()) api.setColorRanges(colorBar.colouring(ranges));
      if (settled) commit("color_range", ranges);
    },
    // one scale for all, or each its own: as one change, the group's cuts
    // taken away with it
    onShare: (on, ranges) => {
      model.set("color_range", ranges);
      model.set("color_shared", on);
      model.save_changes();
    },
  });

  /** The colour bar, for the sensor selected or the first the field
   *  colours, with the cut the model holds -- and the renderer colouring
   *  what it shows, which the sensors on screen decide as much as the cut.
   *  Not while a run plays or another of its steps than the payload's is
   *  on screen: a frame is drawn in magpylib's colours for that step,
   *  which no bar says. */
  function dressColorBar() {
    const payload = gridPayload();
    barAside = playing || shown !== drawnStep();
    colorBar.update({
      payload,
      selected: model.get("selected") || [],
      units: payload.units,
      hidden: model.get("hidden") || [],
      shared: Boolean(model.get("color_shared")),
      aside: barAside,
    });
    colorBar.sync(model.get("color_range") || {});
    if (drawing()) {
      api.setColorRanges(colorBar.colouring(model.get("color_range") || {}));
    }
    if (grid.split) grid.wear();
    keepCorner(); // it beside the column, or alone, and the cube clear of it
  }
  let barAside = false; // see `dressColorBar`

  /** The bar away as a run starts or leaves the payload's step, and back
   *  as it returns there and stops. */
  function asideColorBar() {
    if ((playing || shown !== drawnStep()) !== barAside) dressColorBar();
  }

  /** Beside the editing column, its height, while the column is out;
   *  alone on the right edge where there is none. */
  function placeColorBar() {
    const beside = !editBar.hidden && editBar.offsetHeight > 0;
    colorBarEl.classList.toggle("beside", beside);
    colorBarEl.style.top = beside ? `${editBar.offsetTop}px` : "";
    colorBarEl.style.height = beside ? `${editBar.offsetHeight}px` : "";
    colorBarEl.style.right = beside
      ? `${stage.clientWidth - editBar.offsetLeft + 4}px`
      : "";
    colorBar.paint();
  }

  let legendOpen = null; // undecided until there is a tree, and room, to decide by
  let legendRoom = null; // waits for the view to have a size to decide in

  function commit(name, value) {
    model.set(name, value);
    model.save_changes();
  }

  /** The legend, drawn from the model. Like the transport, before anything
   *  is awaited, and for the same reason. */
  function dressLegend() {
    const tree = legendTree();
    const payload = gridPayload();
    const rows = rowsIn(tree);
    legendButton.hidden = rows === 0;
    if (!payload.meshes || rows === 0) {
      legendEl.hidden = true;
      return;
    }
    legend.update({ tree, payload });
    legend.sync(stateOf());
    // After the first time, it is the user's to open and close. One object
    // needs no list -- which is not a decision: a scene that grows later,
    // a slider making a ring of what was one magnet, still gets its look.
    if (legendOpen !== null) showLegend(legendOpen);
    else if (model.legendStartsClosed) {
      // a host with a legend of its own -- the studio's Scene tree
      showLegend(false);
    } else if (rows === 1) {
      legendEl.hidden = true;
      pressed(legendButton, false);
    } else settleLegend();
  }

  /** The legend's first look, in the room the view has: open in full if
   *  that leaves the scene room, else with nested collections folded, else
   *  with every collection folded -- and closed, its button there to open
   *  it, in a view too small even for that. Room means scrolling nothing and
   *  covering at most an eighth of the view: open in full in a narrow cell,
   *  a stack of rings hid a third of the scene.
   *
   *  Decided once; after that, open or closed is the user's, and so is what
   *  is folded. A view not yet on the page -- Jupyter renders before it
   *  attaches -- has no size to measure, and the legend waits for one. */
  function settleLegend() {
    const room = stage.getBoundingClientRect();
    if (!room.width || !room.height) {
      legendEl.hidden = true;
      if (!legendRoom) {
        legendRoom = new ResizeObserver(() => {
          if (!stage.clientWidth || !stage.clientHeight) return;
          legendRoom.disconnect();
          legendRoom = null;
          if (legendOpen === null) settleLegend();
        });
        legendRoom.observe(stage);
      }
      return;
    }
    legendEl.hidden = false; // to be measured
    const fits = () => {
      const box = legendEl.getBoundingClientRect();
      const scrolls = legendEl.scrollHeight > legendEl.clientHeight + 1;
      return (
        !scrolls && box.width * box.height <= (room.width * room.height) / 8
      );
    };
    for (const depth of [null, 1, 0]) {
      if (depth !== null) legend.foldFrom(depth);
      if (fits()) {
        showLegend(true);
        return;
      }
    }
    showLegend(false);
  }

  // --- theme ------------------------------------------------------------
  // The view takes its background from what it sits on, and its ink from
  // how light that background is, rather than inheriting a text colour that
  // was chosen for something else. Asked again whenever a theme may have
  // changed -- attributes on the page's root and body, which is where VS
  // Code, JupyterLab and marimo each record theirs, and the system's own
  // preference -- and the scene repainted when the answer differs.
  let theme = "";
  const themeChoice = () =>
    THEMES[model.get("theme")] ? model.get("theme") : "auto";
  function dressTheme() {
    // What the host paints, not what this widget painted over it: read with
    // its own colour on, a backdrop the view has just been given company on
    // would still look dark, and keep it dark.
    unwearBackdrop();
    const choice = themeChoice();
    setIcon(themeButton, choice);
    name(
      themeButton,
      `${THEMES[choice].says} — click for ${THEMES[choice].next}`,
    );
    // Chosen outright, light or dark wears the widget's own colours; left to
    // itself, it wears what it sits on, or else the theme the host declares.
    const behind =
      choice === "auto" ? (surroundings(el) ?? declaredTheme()) : null;
    const dark =
      choice === "dark" ||
      (choice === "auto" &&
        (behind
          ? behind.dark
          : matchMedia("(prefers-color-scheme: dark)").matches));
    const next = `${behind?.css}|${dark}`;
    if (next === theme) {
      // The colours stand; who shares the backdrop may not -- forced dark,
      // they never change, and sliders can still arrive after the view.
      wearBackdrop();
      return false;
    }
    theme = next;
    if (behind?.css) {
      el.style.setProperty("--vscode-editor-background", behind.css);
    } else el.style.removeProperty("--vscode-editor-background");
    el.classList.toggle("magpy-dark", dark);
    el.style.colorScheme = dark ? "dark" : "light"; // the scrubber's too
    wearBackdrop();
    return true;
  }

  // The backdrops painted to match, and given back as they were when the
  // widget goes. An inline `!important` is the one thing that outranks the
  // host's. Looked at again when the nearest one changes size: sliders that
  // arrive after the view are company it could not have seen.
  let backdrops = [];
  let watched = null;
  const backdropWatch = new ResizeObserver(() => retheme());
  function unwearBackdrop() {
    for (const node of backdrops) node.style.removeProperty("background");
    backdrops = [];
  }
  function wearBackdrop() {
    unwearBackdrop();
    backdrops = soleBackdrops(el);
    const colour = getComputedStyle(el)
      .getPropertyValue("--vscode-editor-background")
      .trim();
    for (const node of backdrops) {
      node.style.setProperty("background", colour, "important");
    }
    const nearest = nearestBackdrop(el);
    if (nearest !== watched) {
      if (watched) backdropWatch.unobserve(watched);
      if (nearest) backdropWatch.observe(nearest);
      watched = nearest;
    }
  }
  function retheme() {
    if (!dressTheme() || !api) return;
    draw();
    redrawGrid({ edited: true }); // the panes wear the new theme too
  }
  const themeWatch = new MutationObserver(retheme);
  for (const node of [document.documentElement, document.body]) {
    themeWatch.observe(node, { attributes: true });
  }
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  darkQuery.addEventListener("change", retheme);
  // And when the widget is put on the page, before it is first painted
  // there. Jupyter renders a widget before attaching it, when there is
  // nothing behind it to read, and it is dressed from the system's theme
  // until something looks again. Drawing did -- a renderer loaded a moment
  // later, and the view went from the system's colours to the page's before
  // your eyes -- and a view with no renderer to draw with never did at all.
  // A draw asked for before then is done now, dressed for where it is.
  const placing = new ResizeObserver(() => {
    if (unplaced && view.isConnected) {
      unplaced = false;
      dressTheme(); // the controls now, the scene once the renderer is in
      draw();
    } else retheme();
    keepCorner(); // what floats over the view moved with its edges
  });
  placing.observe(el);

  const stateOf = () => ({
    selected: model.get("selected") || [],
    // the lines not drawn, while they are switched off, as hidden
    hidden: [
      ...(model.get("hidden") || []),
      ...(linesComputed() && !model.get("field_lines")
        ? linesIn(legendTree())
        : []),
    ],
    faded: model.get("faded") || {},
  });

  // The toggles say what is in force, the way the panel's do: pressed when
  // on, never an icon that flips to name the other state.

  /** Open or close the legend, and let its button say which. */
  function showLegend(open) {
    legendOpen = open;
    legendEl.hidden = !open;
    pressed(legendButton, open);
  }

  /** How the scale is said, as the model has it: a trait, like hiding, so a
   *  cell can put it away for a clean picture and an export keeps it so. */
  function showAxes() {
    const choice = axesChoice(model.get("axes"));
    const { icon, says, next } = AXES[choice];
    setIcon(axesButton, icon);
    name(axesButton, `${says} — click for ${AXES[next].named}`);
    pressed(axesButton, choice !== "none");
    if (drawing()) api.setAxes(choice);
  }

  /** What floats over the view's bottom-right corner, where it is now, for
   *  the renderer's view cube and scale bar to stand clear of: the editing
   *  column, which reaches down there in a view under about 520px tall, the
   *  colour bar beside it, and the foot. Told again whenever either comes
   *  or goes, and when the view is resized. */
  function keepCorner() {
    placeColorBar(); // beside the column, as it now stands
    foot.hidden =
      transport.hidden && variantsEl.hidden && writing.hidden && choose.hidden;
    el.classList.toggle("magpy-footed", !foot.hidden);
    if (grid.split) placePanes();
    if (!drawing()) return;
    api.keepClear(
      [editBar, foot, colorBarEl]
        .filter((part) => !part.hidden)
        .map((part) => part.getBoundingClientRect()),
    );
  }

  /** The renderer answers with the projection now in force. */
  function showProjection(kind) {
    pressed(projectionButton, kind === "parallel");
    grid.followScene(); // the variants' panes look through it too
  }

  /** What the view keys ask of this host -- see `VIEW_KEYS` in scene3d.mjs,
   *  which holds the keys and moves the camera itself. Tab is answered only
   *  where the host asks (below). Each declines, with false, when it has
   *  nothing to do, so the key is left to the page. */
  const viewActions = {
    projection: showProjection,
    // Home, as the fit button: every pane framed, once there are some
    frameAll: () => (grid.split ? grid.fit() : false),
    // Tab walks the objects where the host says so -- the studio panel. In a
    // notebook it moves between cells, and a view that kept it would trap it.
    next: model.tabWalks
      ? (objectId) => {
          if (!objectId) return false;
          commit("selected", [objectId]);
        }
      : undefined,
    play() {
      if (frames() < 2) return false;
      setPlaying(!playing);
    },
    // Up from what was picked to the collection holding it, whose handles
    // move it whole -- a click in the view picks what is drawn, and a
    // collection draws nothing of its own.
    // Only where the view can hold a collection: a view with no session
    // behind it has no handles for one, and nothing it would draw as chosen.
    parent(objectId) {
      const holder = parentIn(model.get("tree") || [], objectId);
      if (!holder || !model.get("payload")?.collections?.[holder]) {
        return false;
      }
      commit("selected", [holder]);
    },
    deselect() {
      if (!(model.get("selected") || []).length) return false;
      commit("selected", []);
    },
    hide({ isolate }) {
      // A collection hides as what it holds: that is what is drawn, and what
      // the legend's eye hides too -- a sensor drawn as its parts, as those.
      // Hidden as the legend shows it, the lines switched off among it, and
      // left so: the keys hide what is drawn, and do not switch lines on.
      const parts = partsIn(legendTree());
      const asParts = (ids) => ids.flatMap((id) => parts.get(id) ?? [id]);
      const hidden = new Set(stateOf().hidden);
      const off = linesComputed() && !model.get("field_lines");
      const drawn = (ids) =>
        ids.filter((id) => !(off && id.endsWith("/lines")));
      const chosen = drawn(
        asParts(drawnFor(model.get("selected") || [], model.get("payload"))),
      );
      if (isolate) {
        // Show only the selection -- or, when it is all that shows already,
        // everything again: the one key narrows the view and restores it.
        // Whatever else is hidden stays hidden: in the studio, hiding is
        // saved with the scene, and a hidden object is not drawn at all.
        const others = drawn(
          asParts([...drawnIn(model.get("payload"))]),
        ).filter((id) => !chosen.includes(id));
        const unlit = [...hidden].filter((id) => !drawn([id]).length);
        if (!chosen.length || others.every((id) => hidden.has(id))) {
          if (hidden.size === unlit.length) return false;
          hideAsked(unlit);
          return;
        }
        const isolated = new Set([...hidden, ...others]);
        for (const id of chosen) isolated.delete(id);
        hideAsked([...isolated]);
        return;
      }
      if (!chosen.length) return false;
      const showing = chosen.some((id) => !hidden.has(id));
      for (const id of chosen) showing ? hidden.add(id) : hidden.delete(id);
      hideAsked([...hidden]);
    },
  };

  stage.addEventListener("keydown", (event) => {
    // typed into a box -- the readout's -- a key is a character, not a command
    if (event.target.closest?.("input, select, textarea")) return;
    // Esc, a first end picked in a variant's pane: that pick goes first, as
    // it would in the scene's own view
    const picking =
      event.key === "Escape" && grid.apis.find((each) => each.rulerPending());
    if (picking) {
      picking.viewKey(event);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!editKey(event) && !api?.viewKey(event, viewActions)) return;
    event.preventDefault();
    event.stopPropagation(); // the notebook listens further up
  });

  /** The editing keys, as the studio's panel has them: W, E, R and P pick
   *  the handles and Q puts them away; X, Y or Z holds a drag to one axis
   *  and A frees it; L swaps the world's axes for the object's own; S snaps
   *  to round steps. Cmd/Ctrl+Z undoes -- with Shift, redoes. */
  function editKey(event) {
    if (event.altKey) return false;
    const key = event.key.toLowerCase();
    if (!editable()) {
      // A handle key on a view that offers the pencil does what the pencil
      // does, and comes up in that mode: pressing W means "move it", and a
      // keyboard hand need not reach for the mouse once.
      const mode = HANDLE_KEYS[key];
      if (
        !mode ||
        mode === "none" ||
        editButton.hidden ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey
      ) {
        return false;
      }
      handles = mode;
      notify(
        "Editing — W moves, E turns, R resizes, P aims; Q puts the handles away",
      );
      commit("editable", true);
      return true;
    }
    if ((event.metaKey || event.ctrlKey) && key === "z") {
      // A host that has its own undo key -- VS Code runs its keybinding on
      // Cmd+Z in the studio panel -- says so, and the view leaves the key to
      // it: taken here as well, one press would undo twice.
      if (editor.undoKeys === false) return false;
      settle(event.shiftKey ? editor.redo() : editor.undo());
      return true;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey) return false;
    if (HANDLE_KEYS[key]) {
      // points picked take W, E and R for themselves: moved, turned, scaled
      if (!api?.setPointsMode?.(HANDLE_KEYS[key])) {
        setHandles(HANDLE_KEYS[key], { asked: true });
      }
    } else if (key === "x" || key === "y" || key === "z") constrain(key);
    else if (key === "a") constrain(null);
    else if (key === "l") toggleSpace();
    else if (key === "s") toggleSnap();
    else if (key === "v") showVariables(variablesEl.hidden);
    else if (key === "o") showInspector(inspectorEl.hidden);
    else return false;
    return true;
  }
  // A canvas cannot take focus, and the controls may keep it from moving
  // there on a press: give it to the stage outright.
  stage.addEventListener("pointerdown", () =>
    stage.focus({ preventScroll: true }),
  );

  let api = null; // this view's scene3d, made by its first draw
  const drawing = () => api !== null;
  let gone = false; // torn down: a draw on its way draws nothing
  let framed = false; // whether this widget has drawn into the view yet
  let refit = null; // frames the view again as its size settles -- see draw
  let unplaced = false; // a draw waits for the view to be on the page
  let keptRuler = null; // a released view's ruler, for its next renderer
  let kept = null; // where the camera was, for a view drawn again to look from

  /** Let go of the scene3d, for a view off the page (`sweep`) or torn down.
   *  One that comes back to the page is drawn again, by `placing`, with a
   *  new one, looking from where it was. */
  const held = { view, release };
  function release() {
    shared.views.delete(held);
    if (!api) return;
    // the ruler and its measurements, for the view drawn again to take up
    keptRuler = { on: api.rulerOn(), pairs: api.rulerPairs() };
    clearTimeout(gridTimer);
    // the variants' panes let go of theirs too -- a view let go of, not a
    // choice: the trait keeps them, and drawn again they open again
    lettingGo = true;
    grid.hide();
    lettingGo = false;
    panesAsked = (model.get("panes") || []).length > 0;
    if (framed) kept = api.cameraState();
    if (playing) setPlaying(false);
    // A frame asked for is asked for again when it is drawn, not waited for.
    inFlight = false;
    clearTimeout(silence);
    api.watchCamera(null);
    api.dispose();
    api = null;
    unplaced = true;
  }

  // Where the camera is, told to python once it stops moving, so that a
  // `write_html` from a cell saves the view as it is seen. A message and not
  // a trait: marimo re-runs every cell that reads a widget when one of its
  // traits changes, and orbiting is not something to recompute a notebook for.
  let cameraTimer = null;
  function tellCamera() {
    clearTimeout(cameraTimer);
    cameraTimer = setTimeout(() => {
      if (drawing()) {
        model.send({ kind: "camera", camera: api.cameraState() });
      }
    }, 300);
  }

  // --- playback ---------------------------------------------------------
  // A run that only moves arrives as motion, and is played here. One that
  // changes shape as it goes is asked for a frame at a time, as in the panel:
  // the whole run is every trace of every step, and one frame is all anyone
  // is looking at.
  /** The step of the run the payload draws: the first of a run captured,
   *  the last of a session's, where magpylib draws an object on a path. */
  const drawnStep = () => model.get("payload")?.step ?? 0;
  /** The step the view opens on: the payload's, or -- a saved page whose
   *  payload draws a step cut from its run, -1 (`_cut` in widget.py) -- the
   *  first kept, which a draw then asks for. */
  const openStep = () => Math.max(drawnStep(), 0);
  let playing = false;
  let inFlight = false;
  let wanted = null; // the frame last asked for, which may not be the one shown
  let shown = openStep(); // the step on screen
  let runId = 0; // which scene a frame was asked for; the model's, per payload
  let silence = null; // how long a frame has gone unanswered
  let startedAt = 0;
  let early = null; // a frame to be asked for when the clock reaches it

  const frames = () => model.get("frames");
  const duration = () => model.get("duration") || 5;

  /** The transport, read straight off the model.
   *
   * Synchronous, and called before anything is awaited: the frame count is
   * in hand the moment the widget mounts, and controls that waited for the
   * renderer would appear a frame later than the view and lay themselves out
   * again when they did -- the flicker on every re-run of the cell that made
   * the widget.
   */
  /** The variants' row, for a scene that has some. */
  function dressVariants() {
    const carried =
      (model.get("variants") || []).length > 0 &&
      (model.editor === undefined || model.showsVariants === true);
    variantsEl.hidden = !carried;
    if (carried) {
      variantRow ??= createVariables(variantsEl, {
        // a variant used, the panel's rows say the values it set; one a
        // slide passes asks for the scene in its answer, as a slider does
        rpc: (method, params, { preview = false } = {}) =>
          call(method, params, { preview, scene: preview }).then((answer) => {
            if (method === "use_variant" && !preview && !variablesEl.hidden) {
              variables.refresh();
            }
            return answer;
          }),
        // a page draws the variant itself, and answers with no scene
        onPreview: (answer) => answer?.scene && redrawFromSession(answer),
        // a host with an editor of its own previews no slide: a click uses
        // a variant there, through it, and a lift carries it
        slide: model.editor === undefined,
        // lifted out of the row, a chip is carried into the view
        onLift: (name, event, chip) => lift(name, event, chip),
        // clicked, a chip is selected, or added to the selection
        onSelect: (name, add) => select(name, add),
        variantsOnly: true,
        // as many as the foot of the view holds, past the panel's four
        fits: (names) => names.length <= 10 && names.join("").length <= 90,
      });
      variantRow.refresh();
    }
    dressSpread();
    keepCorner();
  }

  /** The variants a pane can be given: every one the row offers but the
   *  one the values are in, which the scene's own pane shows -- and one the
   *  scene cannot use as it stands, shown there and not offered. */
  function offeredVariants() {
    const refused = new Set([
      ...[...variantsEl.querySelectorAll(".magpy-vars-chip:disabled")].map(
        (chip) => chip.textContent,
      ),
      ...[...variantsEl.querySelectorAll("option:disabled")].map(
        (option) => option.value,
      ),
      variantsEl.querySelector(".magpy-vars-chip.on")?.textContent,
      variantsEl.querySelector("select")?.value,
    ]);
    return (model.get("variants") || []).filter((name) => !refused.has(name));
  }

  /** The spread button: shown with the row, and saying what a press does --
   *  every variant beside the scene, or, every one out already, or as many
   *  as there is room for, all of them back. */
  function dressSpread() {
    dressPaned();
    const offered = offeredVariants();
    const open = grid.names;
    spreadButton.hidden = variantsEl.hidden || offered.length === 0;
    const full =
      grid.split &&
      (offered.every((name) => open.includes(name)) ||
        open.length >= MOST_PANES - 1);
    spreadFull = full;
    setIcon(spreadButton, full ? "untile" : "tile");
    // closing, it says so in words: alone in the foot, an icon is a puzzle
    spreadButton.classList.toggle("magpy-scene-spread-worded", full);
    if (full) {
      const words = document.createElement("span");
      words.textContent = "Close panes";
      spreadButton.append(words);
    }
    // the icon and the label say what a press does
    name(
      spreadButton,
      full
        ? "Close every variant's pane, back to the scene alone"
        : offered.length > MOST_PANES - 1
          ? `Open ${MOST_PANES - 1} of the other variants beside the scene, each in a pane`
          : "Open every other variant beside the scene, each in a pane",
    );
  }

  /** A variant with a pane is there, not in the row as well: its chip, or
   *  its option of the dropdown, out of the row until the pane closes --
   *  but not while the foot asks what a page keeps, of every variant. */
  function dressPaned() {
    const open = new Set(choosing ? [] : grid.names);
    // split, the variant the scene is at is the scene's pane's, its tag
    // named for it (`grid.mark`): out of the row as well
    const split = grid.split && !choosing;
    const out = (chip) =>
      open.has(chip.textContent) || (split && chip.classList.contains("on"));
    const chips = [...variantsEl.querySelectorAll(".magpy-vars-chip")];
    for (const chip of chips) chip.classList.toggle("magpy-in-pane", out(chip));
    // every one in a pane: no row left to name, the spread button alone
    variantsEl.classList.toggle(
      "magpy-all-paned",
      chips.length > 0 && chips.every(out),
    );
    for (const option of variantsEl.querySelectorAll("option")) {
      option.hidden = open.has(option.value) && !option.selected;
    }
    dressSelected();
  }

  // --- the variants selected -----------------------------------------------
  // Apart from the one the scene is at: a click on a chip or a pane's tag
  // selects its variant alone, Ctrl or Cmd adds it or takes it out, and the
  // `selected_variants` trait says which, for a notebook to plot them.
  let chosen = model.get("selected_variants") || [];

  function select(name, add) {
    let now = [name];
    if (add) {
      now = chosen.includes(name)
        ? chosen.filter((each) => each !== name)
        : [...chosen, name];
    }
    chosen = now;
    dressSelected();
    const told = model.get("selected_variants") || [];
    if (told.length === now.length && told.every((n, i) => n === now[i])) {
      return;
    }
    model.set("selected_variants", now);
    model.save_changes();
  }

  /** The chips and the panes' tags of the variants selected, marked. */
  function dressSelected() {
    const marked = new Set(choosing ? [] : chosen);
    for (const chip of variantsEl.querySelectorAll(".magpy-vars-chip")) {
      chip.classList.toggle("magpy-selected", marked.has(chip.textContent));
    }
    grid.choose([...marked]);
  }

  let panesAsked = (model.get("panes") || []).length > 0; // before a draw
  let lettingGo = false; // panes closed with the view, not by a hand
  let showingPanes = false; // laying out what the trait asks: told at the end

  /** The panes the trait asks for: those opened, laid out as the spread
   *  button lays them, the rest closed -- but the variant the scene is at,
   *  the scene's pane's already. Asked before the view has drawn, once it
   *  has. The trait then says what was opened. */
  async function showPanes() {
    if (!api || !sharedModule) {
      panesAsked = true;
      return;
    }
    panesAsked = false;
    const now = await currentVariant();
    const asked = (model.get("panes") || []).filter((name) => name !== now);
    const open = grid.names;
    if (
      asked.length === open.length &&
      asked.every((name, i) => name === open[i])
    ) {
      tellPanes(open); // what the scene's own variant would have added
      return;
    }
    showingPanes = true;
    try {
      if (!asked.length) grid.hide();
      else {
        grid.keep(asked);
        grid.fill(asked);
      }
    } finally {
      showingPanes = false;
    }
    tellPanes(grid.names);
  }

  /** The trait told which variants have a pane, when they changed. */
  function tellPanes(names) {
    const told = model.get("panes") || [];
    if (told.length === names.length && told.every((n, i) => n === names[i])) {
      return;
    }
    model.set("panes", names);
    model.save_changes();
  }

  function spread() {
    if (!api || !sharedModule) return; // nothing drawn yet to split
    if (spreadFull) grid.hide();
    else grid.fill(offeredVariants());
  }

  // --- variants side by side -----------------------------------------------
  // A chip lifted out of the row and dropped in the view is a pane of its own
  // beside the scene's (`grid.mjs`), the controls where they are round them.
  const grid = createGrid(panesEl, {
    view,
    mainApi: () => api,
    // a pane opened measures as the view does, its ruler on or off with it
    factory: () => {
      const made = sharedModule.createScene3d();
      made.setRuler(api?.rulerOn() ?? false);
      made.setMeasurements(api?.rulerPairs() ?? []);
      return made;
    },
    onRuler: (on, from) => mirrorRuler(on, from),
    onMeasure: (list, from) => {
      mirrorMeasurements(list, from);
      tellMeasurements();
    },
    sceneOf: (name, frame) =>
      call("variant_scene", frame == null ? { name } : { name, frame }, {
        quiet: true,
      }),
    look: () => ({
      hidden: model.get("hidden") || [],
      fades: model.get("faded") || {},
      colouring: colorBar.colouring(model.get("color_range") || {}),
      selected: model.get("selected") || [],
      axes: axesChoice(model.get("axes")),
      flow: model.get("flow") !== false,
    }),
    onPick: (detail) =>
      view.dispatchEvent(new CustomEvent("objectpick", { detail })),
    onScenes: (drawn) => {
      gridScenes = drawn;
      dressLegend();
      dressColorBar();
    },
    stepNow: () => stepShown(),
    // the scene's pane is the one edited: its tag wears the pencil
    live: () => editable(),
    // the scene's pane closed: the scene takes the next pane's variant, one
    // step to undo, as a click on its chip would
    foldInto: async (name) => {
      try {
        const res = await call("use_variant", { name });
        if (res && res.ok === false) return false;
      } catch {
        return false;
      }
      variantRow?.refresh();
      if (!variablesEl.hidden) variables.refresh();
      return true;
    },
    // a pane's tag clicked selects its variant, as its chip does
    onSelect: (name, add) => select(name, add),
    onLayout: (split, names) => {
      el.classList.toggle("magpy-paned", split);
      if (split) {
        currentVariant().then((now) => {
          knownVariant = now;
          grid.mark(now);
          dressSelected(); // the scene's tag names the variant it is at
        });
      }
      // the copies of the variants whose panes closed, let go of in python
      // -- but those selected, a cell's to read -- and not for a view let
      // go of, whose panes open again from them when it is drawn again
      const shrank = paneNames.some((each) => !names.includes(each));
      paneNames = names;
      if (sharedModule && shrank && !gone && !lettingGo) {
        const keep = [...new Set([...names, ...chosen])];
        call("drop_variant_copies", { keep }, { quiet: true }).catch(() => {});
      }
      if (!split) gridScenes = [];
      if (!showingPanes && !lettingGo) tellPanes(names);
      dressSpread();
      sizeView();
      keepCorner();
      if (!split) {
        dressLegend();
        dressColorBar();
      }
    },
  });

  // the row is made again as it learns which variants the scene can use:
  // the spread button follows it
  new MutationObserver(() => dressSpread()).observe(variantsEl, {
    childList: true,
    subtree: true,
  });
  // the legend opened, closed, or a row of it folded: the panes beside it
  // take the room it leaves
  new ResizeObserver(() => grid.split && placePanes()).observe(legendEl);

  let paneNames = []; // the variants with a pane, at the last layout

  /** A chip lifted out of the row: carried, to be dropped in the view. */
  function lift(name, event, chip) {
    if (!api || !sharedModule) return; // nothing drawn yet to split
    // the pressed one, the variant the scene is at, is in its pane already
    const shown = Boolean(chip?.classList.contains("on"));
    grid.carry(event, { name, from: chip, shown });
  }

  /** The variant the scene is at, or null: the row's to say. */
  const currentVariant = () =>
    call("get_variables", {}, { quiet: true })
      .then((panel) => panel?.variant ?? null)
      .catch(() => null);

  /** The variants' panes again: after an edit, or a step. A step is posed
   *  or asked for pane by pane (`grid.stepTo`), with no word to python for
   *  a run that only moves. An edit stops what the panes were asking for at
   *  once, and draws them again once the edits stop coming for a moment: a
   *  slider dragged costs one copy of the scene a pane, at the end, and not
   *  one for every value it passes. Which variant the scene is at is asked
   *  only then. */
  let knownVariant = null;
  let gridTimer = null;
  const GRID_SETTLE = 300; // ms without an edit before the panes redraw
  const stepShown = () => (shown === drawnStep() ? null : shown);
  function redrawGrid({ edited = false } = {}) {
    if (!grid.split) return;
    if (!edited) {
      grid.stepTo(stepShown());
      return;
    }
    grid.stale();
    clearTimeout(gridTimer);
    gridTimer = setTimeout(async () => {
      if (!grid.split || gone) return;
      knownVariant = await currentVariant();
      if (!grid.split || gone) return;
      const at = stepShown();
      grid.redraw(at === null ? model.get("payload") : null, at, knownVariant);
    }, GRID_SETTLE);
  }

  /** The panes in the room the controls leave: the tools above, the legend
   *  to the left, the colour bar and the edit column to the right, and the
   *  foot below. */
  function placePanes() {
    const room = (part, side) =>
      part.hidden || !part.offsetParent ? 8 : part[side] + 16;
    panesEl.style.paddingTop = `${room(tools, "offsetHeight")}px`;
    panesEl.style.paddingLeft = `${legendOpen ? room(legendEl, "offsetWidth") : 8}px`;
    const right = Math.max(
      room(colorBarEl.firstElementChild ?? colorBarEl, "offsetWidth"),
      room(editBar, "offsetWidth"),
    );
    panesEl.style.paddingRight = `${right}px`;
    panesEl.style.paddingBottom = `${room(foot, "offsetHeight")}px`;
    grid.corners();
  }

  /** The tiles' scenes as one, for the legend and the colour bar: what any
   *  tile draws, and a sensor in several tiles as a sensor read in several
   *  places, as a pattern's copies are. */
  function gridPayload() {
    const payload = model.get("payload") || {};
    if (!grid.split || !gridScenes.length) return payload;
    const every = (key) =>
      [payload, ...gridScenes.map(({ scene }) => scene)].flatMap(
        (scene) => scene[key] ?? [],
      );
    return {
      ...payload,
      meshes: every("meshes"),
      scatters: every("scatters"),
      pixels: every("pixels"),
      fieldlines: every("fieldlines"),
    };
  }

  /** The objects in any tile, once each: the trees of the tiles laid over
   *  one another, a node's children the union of its children in each. A
   *  choice can give a variant objects the scene does not have. */
  function gridTree(tree) {
    if (!grid.split || !gridScenes.length) return tree;
    const merge = (into, nodes) => {
      for (const node of nodes) {
        const known = into.find((each) => each.id === node.id);
        if (known) known.children = merge([...known.children], node.children);
        else into.push({ ...node, children: merge([], node.children) });
      }
      return into;
    };
    return gridScenes.reduce(
      (into, { tree: theirs }) => merge(into, theirs),
      merge([], tree),
    );
  }

  function dressTransport() {
    const animated = frames() > 1;
    transport.hidden = !animated;
    keepCorner();
    scrub.max = String(Math.max(1, frames() - 1));
    scrub.value = String(shown);
    showStep();
  }

  /** Where in the run the picture is. */
  function showStep() {
    counter.textContent = `${shown + 1} / ${frames()}`;
  }

  /** How far a page being written has got, in the foot: `job` the view's
   *  own export, which the button stops, else one a cell is writing, which
   *  the busy kernel would not hear stopped. */
  function showWriting({ text, done, total, job }) {
    writingText.textContent = text;
    writingCount.textContent = total ? `${done} / ${total}` : "";
    stopButton.hidden = job === undefined;
    progressBar.hidden = !total;
    progressBar.style.width = total ? `${(100 * done) / total}%` : "0";
    if (writing.hidden) {
      writing.hidden = false;
      keepCorner();
    }
  }

  function hideWriting() {
    writing.hidden = true;
    progressBar.hidden = true;
    keepCorner();
  }

  let noticeTimer = null;
  function notify(text, { stay = false } = {}) {
    notice.textContent = text;
    notice.classList.add("shown");
    clearTimeout(noticeTimer);
    if (stay) return; // until something replaces it
    noticeTimer = setTimeout(() => notice.classList.remove("shown"), 2500);
  }

  /** Ask for a frame; the newest ask wins.
   *
   * A scrub moves the thumb far faster than frames come back, and the frame
   * worth drawing is the one under the pointer now, not each it passed
   * through. Dropping the ones that arrive while a request is out would leave
   * the frame the user released on unasked-for, and the thumb would snap back
   * to whatever last came in.
   */
  function askFor(index) {
    wanted = Math.max(0, Math.min(index, frames() - 1));
    if (inFlight || !api) return;
    if (api.posed()) {
      // Nothing to wait for, and no python needed: a notebook read without
      // its kernel, or a docs page, plays this as well as a live one.
      api.poseFrame(wanted);
      reached(wanted);
      return;
    }
    // The step a session's payload draws is drawn from it, whole, and
    // nothing is asked for: its field lines, and its pixels in the colour
    // bar's colours, are what no frame carries. A captured run's first
    // frame is its payload's own, and the cheaper to draw.
    if (model.get("payload")?.step !== undefined && wanted === drawnStep()) {
      reached(wanted);
      draw();
      return;
    }
    inFlight = true;
    model.send({ kind: "frame", index: wanted, runId });
    clearTimeout(silence);
    silence = setTimeout(unanswered, 4000);
  }

  /** A frame asked for and not answered. Said, rather than leaving a slider
   *  that moves over a picture that does not: most often a notebook read
   *  without its kernel, where nothing will ever answer. A kernel that is
   *  only busy answers late, and the answer is still taken. */
  function unanswered() {
    if (!inFlight) return;
    setPlaying(false);
    scrub.value = String(shown); // the step on screen, not the one asked for
    notify(NO_ANSWER, { stay: true });
  }

  /** Put away what `unanswered` said, once there is an answer after all. */
  function answered() {
    clearTimeout(silence);
    if (notice.textContent === NO_ANSWER) notice.classList.remove("shown");
  }

  /** The picture is at step `index`: say so, and go on to the next. */
  function reached(index) {
    const moved = index !== shown;
    shown = index;
    if (moved) redrawGrid();
    scrub.value = String(index);
    showStep();
    asideColorBar();
    if (playing) afterFrame();
    else if (wanted !== null && wanted !== shown) askFor(wanted);
  }

  function setPlaying(on) {
    clearTimeout(early);
    playing = api ? api.setPlaying(on) : false;
    setIcon(play, playing ? "pause" : "play");
    name(play, playing ? "Pause (space)" : "Play the path (space)");
    asideColorBar();
    if (!playing) return;
    // Restart from the top when play is pressed at the end of the run, rather
    // than finishing immediately.
    if (shown >= frames() - 1) shown = 0;
    startedAt = performance.now() - (shown / frames()) * duration() * 1000;
    askFor(shown);
  }

  // A run lasts what magpylib says it lasts however many steps it has, so the
  // frame to draw next is wherever the clock has got to -- with at least one
  // step of progress, or a slow scene would ask for the frame it is showing.
  function afterFrame() {
    if (!playing) return;
    const elapsed = (performance.now() - startedAt) / 1000;
    let next = Math.max(
      Math.floor((elapsed / duration()) * frames()),
      shown + 1,
    );
    // The run ends on its last *frame*, not when the clock says so: asking
    // for an index past the end returns the frame already on screen, and
    // between the two the view would spend a round trip per redraw on it.
    if (next > frames() - 1) {
      if (!model.get("repeat")) {
        setPlaying(false);
        return;
      }
      next = 0;
      startedAt = performance.now();
    }
    // Ahead of the clock -- frames coming back faster than the run moves,
    // from a quick kernel or from a saved page that answers at once -- waits
    // for it. Asking straight away played a five-second run in however long
    // the round trips took. And never asked for in the same breath, even
    // behind the clock: a posed step answers at once, so a run whose steps
    // take longer to pose than they last would otherwise never give the
    // page a moment to paint -- and, repeating, never stop.
    const wait =
      startedAt + (next / frames()) * duration() * 1000 - performance.now();
    early = setTimeout(() => askFor(next), Math.max(0, wait));
  }

  scrub.addEventListener("input", () => {
    if (playing) setPlaying(false);
    askFor(Number(scrub.value));
  });

  model.on("msg:custom", (message) => {
    if (message.kind === "rpc") {
      answer(message);
      return;
    }
    if (message.kind === "export") {
      // only the page this view asked for, and not since stopped
      if (message.job !== undefined && message.job !== exportJob) return;
      exportJob = null;
      hideWriting();
      download(message);
      return;
    }
    if (message.kind === "progress") {
      // A page being written: the view's own export a piece at a time, the
      // next asked for here unless it was stopped; or one a cell writes.
      if (message.job !== undefined && message.job !== exportJob) return;
      if (message.failed !== undefined) {
        exportJob = null;
        hideWriting();
        notify(`Could not write the file: ${message.failed}`, { stay: true });
        return;
      }
      if (message.job === undefined && message.final) {
        hideWriting();
        notify("File written");
        return;
      }
      showWriting(message);
      if (message.job !== undefined) {
        model.send({ kind: "export-more", job: message.job });
      }
      return;
    }
    if (message.kind === "refused") {
      // The pencil, or the lines, asked for a session python could not make
      // of the cell's objects: the model puts the press back, and this says
      // why, until something else is said.
      notify(message.message, { stay: true });
      return;
    }
    if (message.kind !== "frame") return;
    // A frame of the run before this one, answered after the view was
    // re-pointed: drawn, it would put the old scene over the new.
    if (message.runId !== runId) return;
    // Answered, whether or not it can be drawn: a request left out would
    // keep every later one from being made.
    inFlight = false;
    answered();
    // Off the page: a view drawn again asks for the step on screen again.
    if (!drawing()) return;
    api.renderFrame(message);
    scrub.max = String(message.frames - 1);
    reached(message.frame);
  });

  // --- editing ----------------------------------------------------------
  // An editable view's objects are a session's, in the kernel. The view asks it
  // to record what the handles do, as the studio's panel asks its engine --
  // the same calls -- and the drag itself is the panel's (`drag.mjs`): one
  // pose in flight, the newest waiting, the scene redrawn between. Python
  // redraws the view when a gesture is closed, and tells the notebook.
  // Editable when the model says so, and something can take the edits: a
  // kernel, or a host's own editor. A page saved from a view -- standalone,
  // with neither -- is read only.
  const editable = () =>
    Boolean(model.get("editable")) &&
    (model.editor !== undefined || !model.get("standalone"));
  let handles = "translate"; // what the user asked the handles to do
  let inEffect = "translate"; // what they do: a resize may not be possible
  let snapping = false;
  let along = null; // the one axis a drag is held to, or null for all
  const spaces = {}; // mode -> the axes chosen for it, where one was chosen

  /** Put out the handles for `mode`, as far as the selection allows: a
   *  resize needs a size to drag and an aim a polarization, and neither
   *  takes several objects at once. The renderer says what is in effect,
   *  and the buttons show that; what was asked is kept, and asked again
   *  whenever the selection changes. */
  function setHandles(mode, { asked = false } = {}) {
    handles = mode;
    inEffect = drawing() && editable() ? api.setGizmoMode(mode) : mode;
    for (const [its, button] of Object.entries(modeButtons)) {
      pressed(button, inEffect === its);
    }
    showSpace(inEffect);
    showReadout();
    if (!asked || inEffect === mode) return;
    const chosen = model.get("selected") || [];
    notify(
      !chosen.length
        ? "Select an object first"
        : chosen.length > 1
          ? "Resizing and aiming take one object at a time"
          : mode === "scale"
            ? `${chosen[0]} has no single size to drag`
            : `${chosen[0]} has no polarization to aim`,
    );
  }

  /** Which axes a drag in the mode in force goes along. A resize has no
   *  choice: a size only means anything along the object's own axes. */
  function showSpace(mode = handles) {
    const local = drawing() && api.spaceOf() === "local";
    setIcon(spaceButton, local ? "local" : "world");
    name(
      spaceButton,
      mode === "scale"
        ? "Axes: the object's own — a size has no other"
        : local
          ? "Axes: the object's own (L for the world's)"
          : "Axes: the world's (L for the object's own)",
    );
    spaceButton.disabled = mode === "scale";
  }

  function toggleSpace() {
    if (!drawing() || !editable()) return;
    const space = api.toggleSpace();
    if (DRAG_WRITES[inEffect] && inEffect !== "scale") spaces[inEffect] = space;
    showSpace();
  }

  function constrain(axis) {
    if (!drawing()) return;
    along = axis;
    api.constrainAxis(axis);
    notify(axis ? `Along ${axis.toUpperCase()} only (A for all)` : "All axes");
  }

  function toggleSnap() {
    if (!drawing()) return;
    const step = api.setSnapping(!snapping);
    snapping = step !== null && step !== undefined;
    notify(
      snapping
        ? `Snapping to ${Number(step.toPrecision(3))} m and 15° (S)`
        : "Snapping off",
    );
  }

  /** The panel python asked the view to open with -- `open_panel` -- open,
   *  where there are panels: an editable view in a notebook. Opening only:
   *  closed by hand, it stays closed until python asks again. */
  function openAsked() {
    if (!editable() || model.editor !== undefined) return;
    const asked = model.get("open_panel");
    if (asked === "variables" && variablesEl.hidden) showVariables(true);
    else if (asked === "object" && inspectorEl.hidden) showInspector(true);
  }

  function dressEditing() {
    editBar.hidden = !editable();
    grid.relabel(); // the scene's tag wears the pencil, or not
    resetButton.hidden = !editor.reset;
    // The panels go with the handles, on the column that goes with them.
    // Not in the studio panel, whose host shows them in its sidebar.
    panelToggles.hidden = model.editor !== undefined;
    if (!editable() && !variablesEl.hidden) showVariables(false);
    if (!editable() && !inspectorEl.hidden) showInspector(false);
    showEditing();
    if (!keyList.hidden) showKeys(true);
    setHandles(handles);
    if (!editable() && drawing()) api.setGizmoMode("none");
    keepCorner(); // the column came, went, or changed its height
  }

  /** The pencil, where it can do something: a view with objects named to
   *  edit and a python behind it to keep the edits -- so not on a saved
   *  page, nor a bare `show` that handed over no objects, nor the studio's
   *  panel, where the view is the editor. Pressed while the handles are
   *  out, as the projection button is while the view is orthographic. */
  /** Whether something can compute field lines (#45): not a saved page, nor
   *  a view made for looking only. The studio's panel has no kernel but an
   *  engine behind its editor, which the switch goes to as an edit. */
  const linesComputed = () =>
    model.get("editable") !== null &&
    !(Boolean(model.get("standalone")) && model.editor === undefined);

  /** The legend's tree: a sensor's field lines, a row beneath it, listed
   *  where they can be computed, or are drawn -- a saved page keeps them. */
  function legendTree() {
    const tree = gridTree(model.get("tree") || []);
    if (linesComputed() || model.get("payload")?.fieldlines?.length) {
      return tree;
    }
    const pruned = (nodes) =>
      nodes
        .filter((node) => node.kind !== "FieldLines")
        .map((node) => ({ ...node, children: pruned(node.children) }));
    return pruned(tree);
  }

  /** The ids of the field lines' rows in the legend. */
  const linesIn = (tree) =>
    [...partsIn(tree).values()].flat().filter((id) => id.endsWith("/lines"));

  /** What an eye or H asks hidden. Where they are computed, a sensor's field
   *  lines are the `field_lines` switch's: shown while it is off, one turns
   *  it on, the others staying hidden; every one of them hidden turns it
   *  off, and nothing computes a field nobody sees. The legend is shown them
   *  hidden while it is off (`stateOf`). */
  function hideAsked(ids) {
    const lines = linesComputed() ? linesIn(legendTree()) : [];
    const on = Boolean(model.get("field_lines"));
    const others = ids.filter((id) => !lines.includes(id));
    if (!lines.length) return commit("hidden", ids);
    if (!on && lines.some((id) => !ids.includes(id))) {
      model.set("hidden", ids);
      model.set("field_lines", true);
      model.save_changes();
    } else if (on && lines.every((id) => ids.includes(id))) {
      model.set("hidden", others);
      model.set("field_lines", false);
      model.save_changes();
    } else commit("hidden", on ? ids : others);
  }

  /** The flow's switch, where something flows: a wire, a strip, a sheet,
   *  a field line. */
  function showFlow() {
    const payload = model.get("payload") || {};
    flowButton.hidden = !(
      (payload.scatters ?? []).some((item) => item.flow) ||
      (payload.meshes ?? []).some((item) => item.streams) ||
      (payload.fieldlines ?? []).length
    );
    pressed(flowButton, model.get("flow") !== false);
  }

  function showEditing() {
    editButton.hidden =
      model.get("editable") === null || // made for looking only
      model.editor !== undefined ||
      Boolean(model.get("standalone")) ||
      !(model.get("tree") || []).length;
    pressed(editButton, editable());
  }

  // Each view numbers its own calls, under a name of its own: python answers
  // every view of a widget, and two showing the same one -- a second
  // `display` of it -- would otherwise take each other's answers.
  const caller = Math.random().toString(36).slice(2, 10);
  let nextCall = 0;
  const calls = new Map(); // id -> { timer, asked, settle }
  let dragActive = false; // between a drag's first move and its release
  // `since`: when what the call carries was asked for, if before now -- the
  // first value a slider or a drag held back while the one before was away.
  // `quiet`: a read no edit waits on -- a variant's pane, which says itself
  // that it is waiting -- with no ring, and no word if it is slow.
  function call(
    method,
    params = {},
    { preview = false, scene = false, since, quiet = false } = {},
  ) {
    return new Promise((resolve, reject) => {
      const id = `${caller}:${++nextCall}`;
      // Said, and still waited on: python may only be busy -- a scene of
      // thousands of cells takes longer than this -- and its answer settles
      // the call when it comes. The ring stays on until then, and a slider
      // or a drag holds its next value back rather than queueing it behind
      // the one python is still working on.
      const timer = quiet ? null : setTimeout(unheard, 4000);
      const asked = since ?? performance.now();
      calls.set(id, {
        timer,
        asked,
        quiet,
        settle(message) {
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        },
      });
      // waited on past BUSY_AFTER, it shows the ring
      if (!quiet) {
        setTimeout(
          () => calls.has(id) && watchBusy(),
          Math.max(BUSY_AFTER - (performance.now() - asked), 0),
        );
      }
      // `preview` marks a value the pointer is still on: python applies
      // it and says nothing to the notebook, as for a pose mid-drag.
      // `scene` asks for the scene in the same answer, sparing a second
      // message on a host where every message costs.
      model.send({
        kind: "rpc",
        id,
        method,
        params,
        ...(preview ? { preview: true } : {}),
        ...(scene ? { scene: true } : {}),
      });
    });
  }

  /** The ring round the view on once a call has waited past `BUSY_AFTER`:
   *  by each call's age, not by whether any is out -- a quick drag always
   *  has one out, answered in a few milliseconds. Off once none is out: a
   *  slider or a drag fallen behind the pointer sends the next value as the
   *  last is answered, each waited on a little less than `BUSY_AFTER`, and
   *  the view is behind until it has caught up. */
  function watchBusy() {
    const now = performance.now();
    const out = [...calls.values()].filter((each) => !each.quiet);
    let slow = busyRing.classList.contains("on") && out.length > 0;
    for (const { asked } of out) slow ||= now - asked >= BUSY_AFTER - 1;
    busyRing.classList.toggle("on", slow);
  }

  function answer(message) {
    const pending = calls.get(message.id);
    if (!pending) return; // another view's
    calls.delete(message.id);
    clearTimeout(pending.timer);
    // after what the answer sets going: a slider or a drag sends the value
    // that waited behind it at once, and the ring stays on for that one
    // rather than going out between them
    setTimeout(watchBusy);
    if (notice.textContent === NO_EDIT_ANSWER) notice.classList.remove("shown");
    pending.settle(message);
  }

  /** An edit nobody answered: said, and -- once no drag is in hand -- the
   *  picture put back to the last scene python sent, which is what the
   *  session holds as far as this view can know. Most often a notebook read
   *  without its kernel. Mid-drag the picture is left alone: redrawn, it
   *  would take the node the handles hold, and a kernel that is only busy
   *  still takes the poses when it gets to them, and the view catches up. */
  function unheard() {
    notify(NO_EDIT_ANSWER, { stay: true });
    if (!dragActive && drawing()) api.render(view, model.get("payload") || {});
  }

  /** Say what the session refused, or what went wrong asking it. */
  function settle(asked) {
    asked
      .then((result) => {
        if (result?.ok === false) notify(result.error);
        else if (result?.defined?.length) {
          const made = result.defined.join(", ");
          notify(
            `${made} made, at the value it replaces — the sliders have it`,
          );
        }
      })
      .catch((error) => notify(error.message));
  }

  // --- the readout ---------------------------------------------------------
  // The numbers the handles are writing, in the corner, as boxes that take a
  // typed value too: a drag is for finding a value and a keyboard for saying
  // one, and they are wanted in the same breath. The boxes follow the handles
  // while they move and take a typed value when they stop. Rebuilt only when
  // what they show changes, and never over the one being typed in.
  const readout = document.createElement("div");
  readout.className = "magpy-scene-readout";
  readout.hidden = true;
  const readoutHead = document.createElement("div");
  readoutHead.className = "magpy-scene-readout-head";
  const readoutFields = document.createElement("div");
  readoutFields.className = "magpy-scene-readout-fields";
  const readoutTakes = document.createElement("div");
  readoutTakes.className = "magpy-scene-readout-takes";
  readout.append(readoutHead, readoutFields, readoutTakes);
  stage.append(readout);
  let readoutKey = "";

  /** What the readout can show: one object, the field the handles in effect
   *  write, as numbers someone could type. Several objects have no single
   *  value, and a mesh's parameter is its whole vertex array. */
  function readable() {
    const chosen = model.get("selected") || [];
    const field = DRAG_WRITES[inEffect];
    if (!editable() || chosen.length !== 1 || !field) return null;
    // a point the handles hold, alone: where it is in its object's frame
    const point = inEffect === "scale" ? api?.heldPoint?.() : null;
    if (point?.objectId === chosen[0]) {
      const unit = model.get("payload")?.units?.length || SI.length;
      const box = {
        kind: "length",
        unit: unit.symbol,
        scale: unit.scale,
        decimals: DECIMALS[unit.symbol] ?? 4,
        width: FIELD_READS.position.width,
      };
      return {
        objectId: chosen[0],
        field: "point",
        attr: point.attr,
        label: `point ${point.index + 1}`,
        index: point.index,
        numbers: point.at,
        expressions: null,
        boxes: [box, box, box],
      };
    }
    const read = FIELD_READS[field];
    const value = (model.get("payload")?.[read.from] || {})[chosen[0]];
    if (value === undefined) return null;
    const numbers = field === "shape" ? value.value : value;
    if (!Array.isArray(numbers) || Array.isArray(numbers[0])) return null;
    const attr = field === "shape" ? value.attr : field;
    // Each number in the scene's unit for its kind, as the Inspector and the
    // variables show it. One kind per field, but for a CylinderSegment's
    // dimension: three lengths, then two angles.
    const segment = field === "shape" && value.constraint === "segment";
    const boxes = numbers.map((_, index) => {
      const kind = segment && index > 2 ? "angle" : read.kind;
      const unit = model.get("payload")?.units?.[kind] || SI[kind];
      return {
        kind,
        unit: unit.symbol,
        scale: unit.scale,
        decimals: DECIMALS[unit.symbol] ?? 4,
        width: kind === "angle" ? FIELD_READS.orientation.width : read.width,
      };
    });
    // and the expression written where a number is, where one was
    const expressions =
      model.get("payload")?.expressions?.[chosen[0]]?.[attr] || null;
    return { objectId: chosen[0], field, attr, numbers, expressions, boxes };
  }

  function showReadout() {
    // What a drag in this mode would take over, said on the object before
    // the drag rather than after: a value written `=gap / 2` is set outright
    // by a drag, and the variable stops deciding it.
    const chosen = model.get("selected") || [];
    const parametric = model.get("payload")?.parametric?.[chosen[0]] || {};
    const fields = [DRAG_WRITES[inEffect]];
    // a face moved alone moves the shape's middle too, which is its position
    const shape = model.get("payload")?.shapes?.[chosen[0]];
    if (inEffect === "scale" && FACED.has(shape?.constraint)) {
      fields.push("position");
    }
    const names = editable()
      ? [...new Set(fields.flatMap((field) => parametric[field] ?? []))]
      : [];
    const decide = names.length > 1 ? "decide" : "decides";
    readoutTakes.textContent = names.length
      ? `${names.join(", ")} ${decide} this — a drag takes it over`
      : "";
    // With the object panel open the pose is in its rows, so the readout is
    // put away, and comes back for a drag, when the numbers move faster
    // than a panel reads them.
    const spoken = inspectorEl.hidden || dragActive;
    const shown = spoken ? readable() : null;
    if (!shown) {
      readoutKey = "";
      readoutHead.textContent = "";
      readoutFields.replaceChildren();
      readout.hidden = !spoken || !readoutTakes.textContent;
      el.classList.toggle("magpy-reading", !readout.hidden);
      return;
    }
    const named = shown.label ?? shown.attr;
    readoutHead.textContent = `${shown.objectId} · ${named}`;
    const key = `${shown.objectId}/${named}/${shown.numbers.length}`;
    if (key !== readoutKey) {
      readoutKey = key;
      // each box followed by its unit, so that one typed in another unit --
      // `7 mm` -- reads as a value beside values, not a stray
      readoutFields.replaceChildren(
        ...shown.boxes.flatMap((box, index) => {
          const unit = document.createElement("span");
          unit.className = "unit";
          unit.textContent = box.unit;
          return [numberBox(index, box.width), unit];
        }),
      );
    }
    fillReadout(shown);
    readout.hidden = false;
    el.classList.add("magpy-reading");
  }

  function numberBox(index, width) {
    const box = document.createElement("input");
    box.style.width = width;
    // Not `type="number"`: its spinners are noise at this size, and one on a
    // value in metres steps by a metre.
    box.type = "text";
    box.dataset.index = String(index);
    box.title =
      "Type a value — 15 mm, 5° — or a variable's name; a new name is made " +
      "at the value it replaces";
    // Enter needs nothing of its own: the browser fires `change` for it, and
    // a second commit of the same value is a second step to undo.
    box.addEventListener("change", commitReadout);
    box.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      // Back to what the scene says, this box too -- before the blur, whose
      // `change` would otherwise send what was typed.
      const shown = readable();
      if (shown) fillReadout(shown, { typedOver: true });
      box.blur();
    });
    return box;
  }

  /** The boxes as the scene has them: the number in the scene's unit, or
   *  the expression written there -- `gap` -- in place of it. */
  function fillReadout(shown, { typedOver = false, numbers = null } = {}) {
    const values = numbers ?? shown.numbers;
    for (const box of readoutFields.querySelectorAll("input")) {
      // the box being typed in keeps what is typed, until it is given up
      if (!typedOver && box === box.getRootNode().activeElement) continue;
      const index = Number(box.dataset.index);
      const expression = numbers ? null : shown.expressions?.[index];
      if (expression) {
        box.value = expression;
      } else {
        const { scale, decimals } = shown.boxes[index];
        const value = values[index] * scale;
        box.value = (Math.abs(value) < 1e-12 ? 0 : value).toFixed(decimals);
      }
      box.classList.toggle("expr", Boolean(expression));
      box.dataset.shown = box.value; // to tell a typed value from a shown one
    }
  }

  /** The numbers at pointer rate, while the handles move them. */
  function showPose(pose) {
    const shown = readable();
    const edit = pose.edits[0];
    if (!shown || pose.edits.length > 1 || edit.objectId !== shown.objectId) {
      return;
    }
    const last = (value) =>
      Array.isArray(value?.[0]) ? value[value.length - 1] : value;
    let live = last(edit[shown.field]);
    if (shown.field === "point") {
      const points = (value) =>
        Array.isArray(value?.[0]?.[0]) ? value.flatMap(points) : value;
      live = edit.shape ? points(edit.shape.value)?.[shown.index] : null;
    } else if (shown.field === "shape") {
      const value = edit.shape?.value;
      live = value && !Array.isArray(value[0]) ? [].concat(value) : null;
    }
    if (live?.length === shown.numbers.length) {
      fillReadout(shown, { numbers: live });
    }
  }

  /** What was typed, as the same edit a drag's release sends -- through the
   *  view, which knows whether the object is on a path: a typed pose moves a
   *  path the way a drag does, rather than replacing it with one pose.
   *
   *  A number is read by the engine, in the scene's unit or the one typed
   *  with it (`15 mm`, `5°`), so the units live in one place. Anything else
   *  is an expression: a variable's name binds the element to it, and a name
   *  the scene lacks is made at the value it replaces. */
  async function commitReadout() {
    const shown = readable();
    if (!shown || !drawing()) return;
    // What each box holds now, as the scene has it: the expression where
    // one is written, else the number itself rather than the rounding it is
    // shown at -- typing x must not round y and z to four decimals.
    const current = shown.numbers.map((value, index) =>
      shown.expressions?.[index] ? `=${shown.expressions[index]}` : value,
    );
    const boxes = [...readoutFields.querySelectorAll("input")];
    let refused = null;
    const typed = await Promise.all(
      boxes.map(async (box, index) => {
        const text = box.value.trim();
        if (!text || box.value === box.dataset.shown) return current[index];
        if (QUANTITY.test(text)) {
          const read = await editor.quantity(text, shown.boxes[index].kind);
          if (read?.ok) return read.value;
          refused = read?.error || `${text} is not a value`;
          return current[index];
        }
        return `=${text.replace(/^=/, "")}`;
      }),
    );
    if (refused) {
      notify(refused);
      showReadout(); // what was typed goes back to what the scene says
      return;
    }
    if (typed.every((value, index) => value === current[index])) {
      showReadout(); // nothing said
      return;
    }
    if (shown.field === "point") {
      // the whole array, that one point typed: see `pointEdit`
      const edit = api.pointEdit(typed);
      if (edit) settle(editor.commit([edit]));
      return;
    }
    const edit = { objectId: shown.objectId };
    const bound = typed.some((value) => typeof value === "string");
    if (shown.field === "shape") {
      edit.shape = { attr: shown.attr, value: typed };
    } else if (bound) {
      edit[shown.field] = typed; // the engine reads the expression
    } else {
      edit[shown.field] = api.poseEdit(shown.objectId, shown.field, typed);
    }
    settle(editor.commit([edit], { define: true }));
  }

  /** What the view edits through: `begin`, `preview`, `commit`, `scene`,
   *  `undo`, `redo`, each a promise of the answer. A notebook's is the
   *  session in its kernel, over this widget's own connection. A host with
   *  its own way to the session -- the VS Code studio panel, whose edits go
   *  through the extension host so that its sidebar and field view keep up --
   *  hands one over on the model, and the view does not need to know which.
   *  `undoKeys: false` on it leaves Cmd/Ctrl+Z to a host that has its own. */
  const editor = model.editor ?? {
    begin: () => call("begin_interaction"),
    // the scene comes back with the pose, and the drag redraws from it
    preview: (edits, { scene = true, since } = {}) =>
      call("apply_edits", { edits }, { scene, since }),
    commit(edits, { define = false } = {}) {
      const done = call("apply_edits", {
        edits,
        ...(define ? { define: true } : {}),
      });
      // after the pose, which the session answers in order
      call("end_interaction").catch(() => {});
      return done;
    },
    // typed text as a number of `kind`, in the scene's unit or the one typed
    quantity: (text, kind) => call("quantity", { name: "", text, unit: kind }),
    scene: () => call("get_scene"),
    undo: () => call("undo"),
    redo: () => call("redo"),
    reset: () => call("reset"),
    // Esc in a drag: the group closed where the drag got to, then undone --
    // which gives back a variable it overruled, as moving back would not.
    // The session answers in order, so the undo finds the group closed.
    cancel() {
      call("end_interaction").catch(() => {});
      return call("undo");
    },
  };

  const stopDrags = watchDrags(view, {
    drawing: () => drawing() && editable(),
    begin({ objectIds, mode }) {
      dragActive = true;
      if (!inspectorEl.hidden) showReadout(); // the numbers, for the drag
      if (playing) setPlaying(false); // the pointer is the one being asked
      editor.begin({ objectIds, mode }).catch(() => {});
    },
    showPose,
    preview: (pose, options) => editor.preview(pose.edits, options),
    scene: () => editor.scene(),
    render(payload, { keep }) {
      if (drawing()) api.render(view, payload, { keep });
    },
    commit(pose) {
      dragActive = false;
      if (!inspectorEl.hidden) showReadout(); // and away again
      settle(editor.commit(pose.edits));
    },
    cancel() {
      dragActive = false;
      if (!inspectorEl.hidden) showReadout();
      settle(editor.cancel());
    },
  });

  // --- selection --------------------------------------------------------
  // The view reports a click; what selection *means* is the host's, which
  // here is a traitlet the notebook can read and write.
  // the point the handles hold changed: the readout says that one's place
  view.addEventListener("pointheld", () => showReadout());

  view.addEventListener("objectpick", (event) => {
    const { objectId, adding } = event.detail;
    const current = model.get("selected") || [];
    let next;
    if (adding) {
      next = current.includes(objectId)
        ? current.filter((id) => id !== objectId)
        : [...current, objectId];
    } else {
      // clicking the only selected object again clears it: there is nothing
      // else to click, the background not being pickable
      next = current.length === 1 && current[0] === objectId ? [] : [objectId];
    }
    model.set("selected", next);
    model.save_changes();
  });

  // --- keeping up with the model -------------------------------------------
  // One update from python is several traits -- a re-pointed scene is its
  // payload, its tree, and the selection and hiding carried over to it -- and
  // they have to be read together. Jupyter sets them all and then says so;
  // marimo sets one, says so, and only then sets the next. A handler for the
  // first would see the rest as they were: a new payload against the old
  // tree, a selection naming objects the tree does not have yet, a hidden
  // ring drawn for a frame before its hiding arrives. So changes are
  // gathered, and the view catches up once, after the last of them.
  const changed = new Set();
  let echoed = model.get("revision"); // the last edit told back -- see catchUp
  for (const name of [
    "payload",
    "tree",
    "selected",
    "hidden",
    "faded",
    "color_range",
    "color_shared",
    "axes",
    "flow",
    "theme",
    "editable",
    "field_lines",
    "open_panel",
    "revision",
    "variants",
    "panes",
    "selected_variants",
    "measurements",
  ]) {
    model.on(`change:${name}`, () => {
      if (!changed.size) queueMicrotask(catchUp);
      changed.add(name);
    });
  }

  function catchUp() {
    const now = new Set(changed);
    changed.clear(); // first, so a change made while catching up is kept
    if (now.has("axes")) showAxes();
    if (now.has("flow") && drawing()) api.setFlow(model.get("flow") !== false);
    if (now.has("payload") || now.has("flow")) showFlow();
    if (now.has("theme")) retheme();
    if (now.has("editable")) dressEditing();
    if (now.has("editable") || now.has("open_panel")) openAsked();
    // An edit settled -- an undo, a drag, a value set from python -- and the
    // rows may say something else now. Not mid-drag: the panel declines
    // itself, and reads its rows back at the release.
    if ((now.has("payload") || now.has("revision")) && !variablesEl.hidden) {
      variables.refresh();
    }
    // which variant the values are in, after any edit of them
    if (now.has("panes")) showPanes();
    if (now.has("measurements")) showMeasurements();
    if (now.has("selected_variants")) {
      chosen = model.get("selected_variants") || [];
      dressSelected();
    }
    if (now.has("variants")) {
      dressVariants();
      grid.keep(model.get("variants") || []);
    } else if (
      (now.has("payload") || now.has("revision")) &&
      !variantsEl.hidden
    ) {
      variantRow.refresh();
    }
    // The object panel follows the selection, and reads the scene back
    // after an edit settled -- once, since a re-pointed view is both.
    if (!inspectorEl.hidden) {
      if (now.has("selected")) {
        inspector.show((model.get("selected") || [])[0], {
          group: partStyle ?? undefined,
        });
        partStyle = null;
      } else if (now.has("payload") || now.has("revision")) {
        inspector.refresh();
      }
    }
    if (now.has("payload") || now.has("selected")) showReadout();
    if (now.has("revision") && model.get("revision") !== echoed) {
      // An edit python settled. marimo re-runs the cells that read a widget
      // when the view says the widget changed, not when python does -- so
      // the view says it, with the value python gave, once: marimo hands the
      // value back, and echoing that too would re-run them for ever. Jupyter
      // hears its own value back, which changes nothing.
      echoed = model.get("revision");
      model.set("revision", echoed);
      model.save_changes();
    }
    const scene = now.has("payload");
    if (scene) {
      // A re-pointed view is a different run. Anything asked for belonged to
      // the last one -- and a request python drops, which is what happens
      // when the new scene has no frames to serve, would leave `inFlight`
      // latched and playback dead for the life of the widget.
      if (playing) setPlaying(false);
      runId += 1; // what is still on its way belongs to the last one
      inFlight = false;
      answered(); // nothing is owed any more
      wanted = null;
      shown = openStep();
    }
    if (scene || now.has("tree")) {
      dressLegend();
      showEditing(); // a view pointed at objects, or away from them
    } else legend.sync(stateOf());
    if (
      scene ||
      ["selected", "hidden", "color_range", "color_shared"].some((k) =>
        now.has(k),
      )
    ) {
      dressColorBar();
    }
    if (grid.split && (scene || now.has("revision"))) {
      redrawGrid({ edited: true });
    } else if (grid.split) grid.wear();
    if (scene) {
      dressTransport();
      draw(); // which applies the hiding and the selection itself
      return;
    }
    // Only while the renderer is this view's: one whose element has left the
    // page may have handed it to another widget, and a selection set from
    // python for the old view would land on the new one's scene.
    if (!drawing()) return;
    if (now.has("hidden")) api.setHidden(model.get("hidden") || []);
    if (now.has("faded")) api.setFades(model.get("faded") || {});
    if (now.has("selected")) {
      api.highlight(model.get("selected") || []);
      if (editable()) setHandles(handles); // what was asked, for the new one
    }
  }

  // --- drawing ----------------------------------------------------------
  /** Whether the view is on the page; when not, a draw waits for `placing`. */
  function placed() {
    if (view.isConnected) return true;
    unplaced = true;
    return false;
  }

  async function draw() {
    // Not off the page, where nothing behind the view has a colour to read:
    // drawn once, when `placing` sees the view arrive.
    if (!placed()) return;
    let module;
    try {
      module = await loadRenderer();
    } catch (error) {
      // The renderer would not load -- a page whose security policy refuses
      // scripts made from a blob, for one. Said where the scene would be.
      if (!gone) {
        notify(`The 3D view could not load here: ${error.message}`, {
          stay: true,
        });
      }
      return;
    }
    if (gone || !placed()) return; // torn down, or off the page, meanwhile
    unplaced = false;
    if (!api) {
      sweep();
      api = module.createScene3d();
      sharedModule = module;
      shared.views.add(held);
      // drawn again after a release: measuring as it was
      if (keptRuler) {
        api.setMeasurements(keptRuler.pairs);
        api.setRuler(keptRuler.on);
        pressed(rulerButton, keptRuler.on);
        keptRuler = null;
      } else showMeasurements(); // a saved page's, or set from python
    }
    const payload = model.get("payload") || {};
    if (!payload.meshes) return;
    // Again here, not only at mount: a notebook may hand over the element
    // before it is on the page, when there is nothing behind it to read --
    // nor a backdrop to find. (Dressing wears the backdrops too.)
    dressTheme();
    // Read only, unless the objects are a session's.
    api.setGizmoMode(editable() ? handles : "none");
    // Before the render, so nodes are built hidden rather than drawn and then
    // taken away.
    api.setHidden(model.get("hidden") || []);
    api.setFades(model.get("faded") || {});
    api.setColorRanges(colorBar.colouring(model.get("color_range") || {}));
    api.setAxes(axesChoice(model.get("axes")));
    api.setFlow(model.get("flow") !== false);
    api.watchCamera(() => {
      tellCamera();
      grid.followScene(); // the variants' panes turn with it
    });
    if (!framed) showProjection("perspective");
    api.render(view, payload, { keepCamera: framed });
    tellMeasurementsSoon(); // what they read in the scene drawn now
    // After the render, which hangs the canvas in this view.
    keepCorner();
    // A saved view opens where it was looking when it was saved, and one
    // back on the page where it was looking when it left (`release`). A live
    // one has no camera to start from, and frames the scene.
    const saved = kept ?? (framed ? null : model.get("camera"));
    if (saved) showProjection(api.setCamera(saved));
    kept = null;
    framed = true;
    if (panesAsked) showPanes(); // asked for before there was a view
    // How the handles drag is this view's to say -- chosen, perhaps, before
    // its scene3d was made, or by the one before it (`release`) -- and the
    // step follows the scene, which may have just changed size.
    api.setSnapping(snapping);
    api.constrainAxis(along);
    api.setSpaces(spaces);
    api.highlight(model.get("selected") || []);
    if (editable()) setHandles(handles);
    // The payload is one step of the run (`drawnStep`), so a redraw of the
    // same run -- a theme that changed -- would leave the picture there
    // while the counter says otherwise. Back to the step that was on screen.
    if (shown !== drawnStep()) askFor(shown);
    // The view framed itself at whatever size it had then, and a host may
    // not have laid it out yet: a cell whose output is made before it is
    // placed, or a second output beside it that narrows the first. So it is
    // framed again whenever its size changes -- until the camera is touched,
    // after which where it looks is the user's.
    if (!refit && !saved) {
      let size = `${view.clientWidth}x${view.clientHeight}`;
      refit = new ResizeObserver(() => {
        const now = `${view.clientWidth}x${view.clientHeight}`;
        if (!view.clientHeight || now === size) return;
        size = now;
        if (drawing()) api.fitView();
      });
      refit.observe(view);
      const touched = () => refit.disconnect();
      for (const kind of ["pointerdown", "wheel", "keydown"]) {
        stage.addEventListener(kind, touched, { once: true, passive: true });
      }
    }
  }

  model.on("change:height", sizeView);
  // Before the first await, so the controls and the legend arrive with the
  // element rather than a frame after it, and dressed for where they are.
  dressTheme();
  dressLegend();
  dressColorBar();
  dressTransport();
  dressVariants();
  dressEditing();
  openAsked();
  showAxes();
  showFlow();
  draw();

  /** Hand the browser the file python wrote, as a download. */
  function download({ html, filename }) {
    const href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    save(href, filename);
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  }

  /** Have the browser save what `href` holds, as `filename`.
   *
   * Unless the page says how it saves, as `window.magpySave`: a VS Code
   * webview -- the studio's script panel -- has no downloads, and a click on
   * the link would do nothing at all. It asks where, and says when it has. */
  function save(href, filename) {
    if (typeof window.magpySave === "function") {
      window.magpySave(href, filename);
      return;
    }
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    // In the page, not detached: some browsers ignore a click on a link that
    // is not in a document.
    link.hidden = true;
    el.append(link);
    link.click();
    link.remove();
    notify(`Saved ${filename}`);
  }

  return () => {
    unwearBackdrop();
    backdropWatch.disconnect();
    legendRoom?.disconnect();
    themeWatch.disconnect();
    placing.disconnect();
    darkQuery.removeEventListener("change", retheme);
    clearTimeout(early);
    clearTimeout(silence);
    clearTimeout(noticeTimer);
    clearTimeout(cameraTimer);
    stopDrags();
    refit?.disconnect();
    for (const pending of calls.values()) clearTimeout(pending.timer);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    gone = true;
    clearTimeout(gridTimer);
    lettingGo = true;
    grid.hide();
    lettingGo = false;
    release();
  };
}

export default { render };
