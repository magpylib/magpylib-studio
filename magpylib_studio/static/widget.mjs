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
 * `scene3d.mjs` keeps its scene, camera and renderer as module state -- one
 * view per module instance -- which is exactly right in a webview that has one
 * panel, and wrong in a notebook, where two cells are two scenes and a re-run
 * is a third. An ES module is instantiated once per URL, so a fresh instance
 * means a fresh URL: the bundled source is imported here as text and handed to
 * `import()` as a blob.
 *
 * The cost is a copy of three.js per live view, so views are pooled and a
 * slot whose element has left the page is taken by the next cell that asks
 * rather than a new one being made. The fix that would let this be a plain
 * import is `scene3d.mjs` becoming a factory; that is a large change to a file
 * the extension depends on, and this is a small one that does not touch it.
 *
 * ## How many
 *
 * Each renderer is a WebGL context, and a page gets about sixteen: past that
 * the browser drops the oldest, and its view goes blank without a word. So
 * no more than `MOST_RENDERERS` are live at once, as pythreejs does it. A
 * view that needs one when they are all out takes the one least wanted -- a
 * view scrolled out of sight before one in it, and the longest untouched
 * first -- and that view rests: it shows a picture of itself until the
 * pointer comes back to it, or until it is in sight and a renderer is to be
 * had without putting another view in sight to rest.
 *
 * The pool is the page's, not this module's. anywidget imports a widget's
 * module afresh for each widget, from a blob of its own, so a pool held here
 * would be one per widget: no limit at all, and a cell re-run leaving its
 * renderers behind for the collector rather than handing them on.
 */
import rendererSource from "../../build/renderer.txt";
import { watchDrags } from "./drag.mjs";
import { createLegend, drawnIn } from "./legend.mjs";
import { QUANTITY, createVariables } from "./variables.mjs";

/** How many renderers may be live on a page at once: pythreejs's number,
 *  half what a browser allows, leaving room for anything else drawing in
 *  WebGL there -- a plotly figure's 3D scene takes a context of its own. */
const MOST_RENDERERS = 8;

/** Everything the views of this build share on the page. Keyed by the build
 *  (`WIDGET_BUILD` is stamped in by `tools/build-widget.sh`): a notebook can
 *  hold the output of an older one, whose renderers need not answer to this
 *  one's calls.
 *
 * - `pool`: live renderers, `{ host, api, freeze, shown, used }` -- `api` a
 *   promise of one scene3d, `freeze` what its view does when it is taken.
 * - `inSight`: the views on screen.
 * - `waiting`: the views on screen that are resting, for want of a renderer.
 * - `retry`: what each view does to take a renderer back, when one may be
 *   had -- it comes into sight, or a view out of sight or gone frees one. */
const shared = (globalThis[
  Symbol.for(`magpylib-studio.widget/${WIDGET_BUILD}`)
] ??= {
  pool: [],
  inSight: new WeakSet(),
  waiting: new Set(),
  retry: new WeakMap(),
  sight: null,
});
const { pool, inSight, waiting, retry } = shared;
shared.sight ??= new IntersectionObserver((entries) => {
  // The whole batch first, then what it means: a view coming into sight is
  // weighed against where the others are now, not where they were before
  // the entries ahead of its own.
  let left = false;
  for (const { target, isIntersecting } of entries) {
    if (isIntersecting) inSight.add(target);
    else {
      inSight.delete(target);
      waiting.delete(target);
      left = true;
    }
  }
  for (const { target, isIntersecting } of entries) {
    if (isIntersecting) retry.get(target)?.();
  }
  if (left) offer(); // a view gone out of sight has a renderer to spare
});

/** Let the views waiting on screen try again: a renderer may have come free. */
function offer() {
  for (const view of [...waiting]) retry.get(view)?.();
}

function loadRenderer() {
  const url = URL.createObjectURL(
    new Blob([rendererSource], { type: "text/javascript" }),
  );
  return import(url).then((module) => {
    URL.revokeObjectURL(url); // it has been fetched; the module instance stays
    return module.scene3d;
  });
}

/** A renderer for `el`, or null when none is to be had.
 *
 * One whose element has gone is taken first. `isConnected` as well as the
 * cleanup below, because a cell removed while the widget was never destroyed
 * -- marimo re-running the cell that made it -- frees the element without
 * freeing the slot. But only an element that was on the page can have left
 * it: Jupyter renders a widget before attaching it, and a view not yet
 * attached is not a view that has gone. Taken as one, two widgets rendered
 * together shared a renderer, and the first lost its canvas. And a view that
 * has gone may come back -- JupyterLab takes cells far out of sight off the
 * page, and puts them back as they are scrolled to -- so it is put to rest
 * like any other, to take a renderer back when it does.
 *
 * With every renderer out, one is taken from a view that has it -- see "How
 * many" above -- and `freeze` is what `el` will do when its own is taken.
 * `anywhere: false` takes one only from a view out of sight: a view waking
 * by itself must not put another in plain view to rest, which would wake in
 * turn. Null, rather than one more renderer, when there is none to take.
 */
function acquire(el, freeze, { anywhere = true } = {}) {
  // Whatever is on the page now has been seen there, whether or not it was
  // drawn after it arrived.
  for (const slot of pool) if (slot.host?.isConnected) slot.shown = true;
  let slot = pool.find(
    (slot) => !slot.host || (slot.shown && !slot.host.isConnected),
  );
  if (!slot && pool.length >= MOST_RENDERERS) {
    slot = leastWanted(anywhere);
    if (!slot) return null;
  }
  slot?.freeze?.(); // still its view's while it takes its picture
  if (!slot) {
    slot = { api: loadRenderer() };
    pool.push(slot);
  }
  slot.host = el;
  slot.freeze = freeze;
  slot.shown = false; // until its element is seen on the page
  slot.used = performance.now();
  return slot;
}

/** The renderer whose view would miss it least: out of sight before in it,
 *  then the longest untouched. Never one whose view is not on the page yet
 *  -- Jupyter draws a widget before attaching it, and a box of them before
 *  any: those are about to be looked at. Undefined when there is none. */
function leastWanted(anywhere) {
  const seen = (slot) => (inSight.has(slot.host) ? 1 : 0);
  return pool
    .filter(
      (slot) =>
        slot.shown &&
        slot.host?.isConnected &&
        (anywhere || !inSight.has(slot.host)),
    )
    .sort((a, b) => seen(a) - seen(b) || a.used - b.used)[0];
}

/** A colour, as the bytes it paints: red, green, blue and alpha. A canvas does
 *  the reading, so `rgb(…)`, `color(srgb …)`, `oklch(…)` -- whatever a
 *  stylesheet's colour computes to -- all come out the same way. */
let probe = null;
function paint(color) {
  probe ??= document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  return probe.getImageData(0, 0, 1, 1).data;
}

/** Backdrops a host paints behind every widget output whatever its theme.
 *  VS Code's Jupyter renderer puts each output on `background: #fff
 *  !important`, in a dark editor as much as a light one, because ipywidgets'
 *  own controls take their colours from JupyterLab's theme variables, which
 *  VS Code does not supply: on white they are legible, on dark they are not.
 *  Two of them, one in the other -- the output (padded 8px) and the box the
 *  widget is put in (padded 0 8px) -- as a live VS Code page showed.
 *
 *  So they are looked past only when the view is alone on them, and then the
 *  view wears VS Code's theme and paints them to match. Shared with other
 *  widgets -- sliders in the same box -- the view wears the white, as they
 *  must, rather than sitting dark among light controls. */
const BACKDROPS = ".cell-output-ipywidget-background";

/** What counts as sharing a backdrop: another widget, whether or not it has
 *  been drawn yet -- Jupyter renders a box's children one by one -- or
 *  anything else that takes up room. VS Code puts an empty `div.cell-output`
 *  beside every widget, where a plain-text output would go, and an empty
 *  placeholder is no company. Nor is another view of a scene -- a second
 *  `display` of the same one -- which was not drawn for the white as a
 *  slider is: a box holding one is company only for whatever else it holds.
 *  A view not drawn yet counts until it is, and the backdrop is looked at
 *  again when it arrives. */
const WIDGETS = ".lm-Widget, .jupyter-widgets";
const SCENE = ".magpy-scene";
function company(node) {
  if (node.matches(SCENE)) return false;
  if (node.querySelector(SCENE)) return [...node.children].some(company);
  if (node.matches(WIDGETS)) return true;
  const box = node.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/** A colour as `rgb(…)`, which three.js reads, or null when it is not
 *  opaque. */
function opaque(color) {
  const [r, g, b, a] = paint(color);
  return a > 200 ? { css: `rgb(${r}, ${g}, ${b})`, r, g, b } : null;
}

/** The theme a host declares outright, for a page that paints nothing behind
 *  the view to read. VS Code's webviews -- a notebook's outputs among them --
 *  are transparent (`body { background-color: transparent }`, in its own
 *  webview host), and say which theme is in force on the body instead, with
 *  the editor's colours as variables on the root. The system's setting is no
 *  substitute: VS Code's theme need not be the system's. */
function declaredTheme() {
  const kind = document.body?.dataset.vscodeThemeKind; // vscode-dark, …
  if (!kind) return null;
  const root = getComputedStyle(document.documentElement);
  const colour =
    root.getPropertyValue("--vscode-notebook-editorBackground").trim() ||
    root.getPropertyValue("--vscode-editor-background").trim();
  return {
    css: colour ? (opaque(colour)?.css ?? null) : null,
    // vscode-high-contrast is dark, vscode-high-contrast-light is not
    dark: !kind.includes("light"),
  };
}

/** The host's backdrops that hold this widget and nothing else, innermost
 *  first -- and so may wear the view's colour instead of leaving a white rim
 *  round a dark view. None when the first holds anything else: sliders in
 *  the same box were drawn for the white, and would be unreadable on
 *  anything darker. None, too, for a widget not yet on the page, whose
 *  company may not have arrived. */
function soleBackdrops(el) {
  const found = [];
  if (!el.isConnected) return found;
  for (let node = el; ;) {
    const root = node.getRootNode();
    const parent =
      node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    if (!parent) return found;
    const siblings = [...parent.children].filter((child) => child !== node);
    if (siblings.some(company)) return found;
    if (parent.matches(BACKDROPS)) found.push(parent);
    else if (found.length) return found; // past the outermost of them
    node = parent;
  }
}

/** The host's backdrop nearest the widget, alone on it or not: its size
 *  changes when company arrives, which is when to look again. */
function nearestBackdrop(el) {
  for (let node = el.parentNode; node; node = node.parentNode) {
    if (node instanceof ShadowRoot) node = node.host;
    if (!(node instanceof Element)) return null;
    if (node.matches(BACKDROPS)) return node;
  }
  return null;
}

/** What the view sits on: the first opaque background among the elements
 *  holding it, followed out of shadow roots, since marimo renders into one.
 *
 * Not the page's body. In VS Code's notebooks the body wears the editor's
 * theme while widget outputs sit on a white panel of their own, and a view
 * dressed from the body was a dark box on white -- with the panel's dark
 * text inherited onto it, which left the legend and the tools unreadable.
 */
function surroundings(el) {
  const alone = new Set(soleBackdrops(el));
  for (let node = el.parentNode; node; node = node.parentNode) {
    if (node instanceof ShadowRoot) node = node.host;
    if (!(node instanceof Element)) break; // the document: nothing opaque
    if (alone.has(node)) continue;
    const found = opaque(getComputedStyle(node).backgroundColor);
    if (found) {
      const { css, r, g, b } = found;
      return { css, dark: 0.299 * r + 0.587 * g + 0.114 * b < 128 };
    }
  }
  return null;
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
  undo: '<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/>',
  redo: '<path d="M10.5 3l3 3-3 3"/><path d="M13.5 6h-7a4 4 0 0 0 0 8H9"/>',
  edit: '<path d="M11.5 2.5l2 2-8 8h-2v-2z"/><path d="M10 4l2 2"/>',
  revert: '<path d="M2.5 3v3.5H6"/><path d="M3.2 6.5a5 5 0 1 1-.5 3.5"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9" stroke-width="2"/>',
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
const NO_EDIT_ANSWER =
  "No answer from Python for this edit yet: the kernel may be busy or not " +
  "running. The view catches up if it answers.";

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
    ["Esc", "select nothing"],
    ["space", "play the path"],
    ["⌘ / Ctrl click", "add to the selection"],
  ],
  edit: [
    ["W · E · R · P", "move, turn, resize, aim the polarization"],
    ["Q", "put the handles away"],
    ["X · Y · Z", "along one axis — A: all of them"],
    ["L", "the world's axes, or the object's own"],
    ["C", "select the collection it is in — again: the one round that"],
    ["S", "snap to round steps"],
    ["⌘Z", "undo — ⇧⌘Z: redo"],
  ],
};

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
  stage.append(view, legendEl);

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
  const axesButton = iconButton(
    "axes",
    "Axes — the box that gives the scene its scale",
    () => commit("axes", !model.get("axes")),
  );
  const fitButton = iconButton(
    "fit",
    "Frame everything (Home) — F frames the selection; 1, 3, 7 look from " +
      "the front, the right and the top",
    () => api?.fitView(),
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
  const variables = createVariables(variablesEl, {
    // a preview asks for the scene in the same message, and redraws from it
    rpc: (method, params, { preview = false } = {}) =>
      call(method, params, { preview, scene: preview }),
    onPreview: redrawFromSession,
    empty: "No variables: a scene function's parameters are its variables.",
    compact: true,
  });
  function showVariables(open) {
    variablesEl.hidden = !open;
    pressed(variablesButton, open);
    if (open) variables.refresh();
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
      notify("Writing the file…");
      // The camera with it, so the file opens on what is on screen now
      // rather than on what was last reported.
      model.send({ kind: "export", camera: api?.cameraState() ?? kept });
    },
  );
  exportButton.hidden = Boolean(model.get("standalone"));
  // Taken here, not by python: the picture is what the browser drew, and a
  // page that is itself an export can take one as well.
  const pictureButton = iconButton(
    "picture",
    "Save the view as a PNG picture",
    () => {
      const picture = api?.snapshot();
      if (picture) save(picture, PICTURE_NAME);
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
  panelToggles.append(rule(), variablesButton);
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
  tools.append(
    group(fitButton, projectionButton),
    group(legendButton, axesButton, themeButton),
    group(editButton),
    group(pictureButton, exportButton),
    group(keysButton, fullscreenButton),
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

  // What the view has to say -- a file saved, full screen refused -- said
  // for a moment, and gone.
  const notice = document.createElement("div");
  notice.className = "magpy-scene-notice";
  notice.setAttribute("role", "status");

  stage.append(tools, editBar, variablesEl, keyList, transport, notice);
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
    // The view's height is the cell's while in the cell, and the screen's
    // otherwise; the renderer watches its element and follows either way.
    view.style.height = on ? "" : `${model.get("height")}px`;
    el.classList.toggle("magpy-fullscreen", on);
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);

  // What selection and visibility *mean* is the widget's: they are traitlets.
  // The legend reports what a click would make them, as the view does.
  const legend = createLegend(legendEl, {
    onSelect: (ids) => commit("selected", ids),
    onHide: (ids) => commit("hidden", ids),
    onFrame: (ids) => api?.fitView(ids),
    onHint: (ids) => api?.hint(ids),
  });
  let legendOpen = null; // undecided until there is a tree, and room, to decide by
  let legendRoom = null; // waits for the view to have a size to decide in

  function commit(name, value) {
    model.set(name, value);
    model.save_changes();
  }

  /** The legend, drawn from the model. Like the transport, before anything
   *  is awaited, and for the same reason. */
  function dressLegend() {
    const tree = model.get("tree") || [];
    const payload = model.get("payload") || {};
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
    if (dressTheme() && api) draw();
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
  const placing = new ResizeObserver(retheme);
  placing.observe(el);

  const stateOf = () => ({
    selected: model.get("selected") || [],
    hidden: model.get("hidden") || [],
  });

  // The toggles say what is in force, the way the panel's do: pressed when
  // on, never an icon that flips to name the other state.

  /** Open or close the legend, and let its button say which. */
  function showLegend(open) {
    legendOpen = open;
    legendEl.hidden = !open;
    pressed(legendButton, open);
  }

  /** The graduated box, as the model has it: a trait, like hiding, so a
   *  cell can put it away for a clean picture and an export keeps it so. */
  function showAxes() {
    const on = Boolean(model.get("axes"));
    pressed(axesButton, on);
    if (drawing()) api.setAxes(on);
  }

  /** The renderer answers with the projection now in force. */
  function showProjection(kind) {
    pressed(projectionButton, kind === "parallel");
  }

  /** What the view keys ask of this host -- see `VIEW_KEYS` in scene3d.mjs,
   *  which holds the keys and moves the camera itself. Tab is answered only
   *  where the host asks (below). Each declines, with false, when it has
   *  nothing to do, so the key is left to the page. */
  const viewActions = {
    projection: showProjection,
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
      // the legend's eye hides too.
      const chosen = drawnFor(
        model.get("selected") || [],
        model.get("payload"),
      );
      const hidden = new Set(model.get("hidden") || []);
      if (isolate) {
        // Show only the selection -- or, when it is all that shows already,
        // everything again: the one key narrows the view and restores it.
        // Whatever else is hidden stays hidden: in the studio, hiding is
        // saved with the scene, and a hidden object is not drawn at all.
        const others = [...drawnIn(model.get("payload"))].filter(
          (id) => !chosen.includes(id),
        );
        if (!chosen.length || others.every((id) => hidden.has(id))) {
          if (!hidden.size) return false;
          commit("hidden", []);
          return;
        }
        const isolated = new Set([...hidden, ...others]);
        for (const id of chosen) isolated.delete(id);
        commit("hidden", [...isolated]);
        return;
      }
      if (!chosen.length) return false;
      const showing = chosen.some((id) => !hidden.has(id));
      for (const id of chosen) showing ? hidden.add(id) : hidden.delete(id);
      commit("hidden", [...hidden]);
    },
  };

  stage.addEventListener("keydown", (event) => {
    // typed into a box -- the readout's -- a key is a character, not a command
    if (event.target.closest?.("input, select, textarea")) return;
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
    if (HANDLE_KEYS[key]) setHandles(HANDLE_KEYS[key], { asked: true });
    else if (key === "x" || key === "y" || key === "z") constrain(key);
    else if (key === "a") constrain(null);
    else if (key === "l") toggleSpace();
    else if (key === "s") toggleSnap();
    else return false;
    return true;
  }
  // A canvas cannot take focus, and the controls may keep it from moving
  // there on a press: give it to the stage outright.
  stage.addEventListener("pointerdown", () =>
    stage.focus({ preventScroll: true }),
  );

  // What a view holds while it has no renderer: one it can compare against.
  const none = { host: null };
  let slot = acquire(view, freeze) ?? none;
  let api = null;
  // Whether the renderer is loaded and still this view's to drive.
  const drawing = () => api !== null && slot.host === view;
  let framed = false; // whether this widget has drawn into the view yet
  let refit = null; // frames the view again as its size settles -- see draw

  // --- resting ----------------------------------------------------------
  // A view whose renderer was taken for another -- see "How many" at the top
  // -- shows a picture of itself, and takes one back when it is wanted again.
  let resting = false;
  let still = null; // the picture, or the note saying how to draw it
  // In sight, and on the page: the observer says a view has gone a moment
  // after it has, and a view off the page must not take a renderer it can
  // never be seen to give back.
  const onScreen = () => view.isConnected && inSight.has(view);
  let kept = null; // where the camera was, to look from again

  /** Give up the renderer: called by `acquire` for the view taking it, while
   *  it is still this one's -- the picture is drawn with it. Only what this
   *  view drew is kept: a renderer handed on before this view had drawn into
   *  it shows another view's scene, from another view's camera. Nor is a
   *  picture taken off the page, where nobody sees it and a view may never
   *  come back to be seen. */
  function freeze() {
    const picture = framed && view.isConnected ? api?.still() : null;
    if (framed) kept = api?.cameraState() ?? kept;
    if (playing) setPlaying(false);
    // A frame asked for is asked for again on waking, not waited for now.
    inFlight = false;
    clearTimeout(silence);
    api?.watchCamera(null);
    api = null;
    resting = true;
    if (onScreen()) waiting.add(view);
    view.querySelector("canvas:not(.magpy-scene-still)")?.remove();
    if (picture || !still) showStill(picture);
  }

  /** `picture` where the canvas was -- or, with none, how to have it back. */
  function showStill(picture) {
    still?.remove();
    if (picture) {
      still = picture;
      still.classList.add("magpy-scene-still");
    } else {
      still = document.createElement("div");
      still.className = "magpy-scene-still magpy-scene-waiting";
      still.textContent =
        "More 3D views than the page can draw at once: point here to draw this one";
    }
    view.append(still);
  }
  if (slot === none) {
    resting = true;
    showStill(null);
  }

  /** Take a renderer back, and say whether one was had: always when the
   *  user reaches for the view; when it wakes of itself, only one that no
   *  view on screen is using -- or it would put that view to rest in turn,
   *  and so on round the screen. A view on screen that finds none waits. */
  function wake({ anywhere }) {
    if (!resting) return true;
    const taken = acquire(view, freeze, { anywhere });
    if (!taken) {
      if (onScreen()) waiting.add(view);
      return false;
    }
    waiting.delete(view);
    slot = taken;
    resting = false;
    return true;
  }

  /** The user has come to the view: it is wanted, and wanted most. */
  function touch() {
    if (resting) {
      if (wake({ anywhere: true })) draw();
    } else if (slot.host === view) slot.used = performance.now();
  }
  // Moved over, not merely under the pointer: scrolling a page slides views
  // beneath a pointer that stays put, and the browser says each has been
  // entered. Those are sightings, and are treated as such.
  const moved = (event) => {
    if (event.movementX || event.movementY) touch();
  };
  el.addEventListener("pointermove", moved);
  el.addEventListener("pointerdown", touch);
  stage.addEventListener("focusin", touch);
  stage.addEventListener("keydown", touch); // focused already, and resting
  retry.set(view, () => {
    if (resting && onScreen() && wake({ anywhere: false })) draw();
  });
  shared.sight.observe(view);

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
  let playing = false;
  let inFlight = false;
  let wanted = null; // the frame last asked for, which may not be the one shown
  let shown = 0;
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
  function dressTransport() {
    const animated = frames() > 1;
    transport.hidden = !animated;
    el.classList.toggle("magpy-animated", animated);
    scrub.max = String(Math.max(1, frames() - 1));
    scrub.value = String(shown);
    showStep();
  }

  /** Where in the run the picture is. */
  function showStep() {
    counter.textContent = `${shown + 1} / ${frames()}`;
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
      if (slot.host !== view) return; // the renderer is drawing another view
      api.poseFrame(wanted);
      reached(wanted);
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
    shown = index;
    scrub.value = String(index);
    showStep();
    if (playing) afterFrame();
    else if (wanted !== null && wanted !== shown) askFor(wanted);
  }

  function setPlaying(on) {
    clearTimeout(early);
    playing = api ? api.setPlaying(on) : false;
    setIcon(play, playing ? "pause" : "play");
    name(play, playing ? "Pause (space)" : "Play the path (space)");
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
      download(message);
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
    // Gone, or resting: its renderer is elsewhere, and a resting view asks
    // for the step again when it wakes.
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

  function dressEditing() {
    editBar.hidden = !editable();
    resetButton.hidden = !editor.reset;
    // The panels go with the handles, on the column that goes with them.
    // Not in the studio panel, whose host shows them in its sidebar.
    panelToggles.hidden = model.editor !== undefined;
    if (!editable() && !variablesEl.hidden) showVariables(false);
    showEditing();
    if (!keyList.hidden) showKeys(true);
    setHandles(handles);
    if (!editable() && drawing()) api.setGizmoMode("none");
  }

  /** The pencil, where it can do something: a view with objects named to
   *  edit and a python behind it to keep the edits -- so not on a saved
   *  page, nor a bare `show` that handed over no objects, nor the studio's
   *  panel, where the view is the editor. Pressed while the handles are
   *  out, as the projection button is while the view is orthographic. */
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
  const calls = new Map(); // id -> { timer, settle }
  let dragActive = false; // between a drag's first move and its release
  function call(method, params = {}, { preview = false, scene = false } = {}) {
    return new Promise((resolve, reject) => {
      const id = `${caller}:${++nextCall}`;
      const timer = setTimeout(() => {
        calls.delete(id);
        unheard();
        reject(new Error(NO_EDIT_ANSWER));
      }, 4000);
      calls.set(id, {
        timer,
        settle(message) {
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        },
      });
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

  function answer(message) {
    const pending = calls.get(message.id);
    if (!pending) return; // given up on already
    calls.delete(message.id);
    clearTimeout(pending.timer);
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
      .catch((error) => {
        if (error.message !== NO_EDIT_ANSWER) notify(error.message);
      });
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
    const read = FIELD_READS[field];
    const value = (model.get("payload")?.[read.from] || {})[chosen[0]];
    if (value === undefined) return null;
    const numbers = field === "shape" ? value.value : value;
    if (!Array.isArray(numbers) || Array.isArray(numbers[0])) return null;
    const attr = field === "shape" ? value.attr : field;
    // in the scene's unit, as the Inspector and the variables show it
    const unit = model.get("payload")?.units?.[read.kind] || SI[read.kind];
    // and the expression written where a number is, where one was
    const expressions =
      model.get("payload")?.expressions?.[chosen[0]]?.[attr] || null;
    return {
      objectId: chosen[0],
      field,
      attr,
      numbers,
      expressions,
      unit: unit.symbol,
      scale: unit.scale,
      decimals: DECIMALS[unit.symbol] ?? 4,
      ...read,
    };
  }

  function showReadout() {
    // What a drag in this mode would take over, said on the object before
    // the drag rather than after: a value written `=gap / 2` is set outright
    // by a drag, and the variable stops deciding it.
    const chosen = model.get("selected") || [];
    const parametric = model.get("payload")?.parametric?.[chosen[0]] || {};
    const names = (editable() && parametric[DRAG_WRITES[inEffect]]) || [];
    const decide = names.length > 1 ? "decide" : "decides";
    readoutTakes.textContent = names.length
      ? `${names.join(", ")} ${decide} this — a drag takes it over`
      : "";
    const shown = readable();
    if (!shown) {
      readoutKey = "";
      readoutHead.textContent = "";
      readoutFields.replaceChildren();
      readout.hidden = !readoutTakes.textContent;
      el.classList.toggle("magpy-reading", !readout.hidden);
      return;
    }
    readoutHead.textContent = `${shown.objectId} · ${shown.attr}`;
    const key = `${shown.objectId}/${shown.attr}/${shown.numbers.length}`;
    if (key !== readoutKey) {
      readoutKey = key;
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = shown.unit;
      readoutFields.replaceChildren(
        ...shown.numbers.map((_, index) => numberBox(index, shown.width)),
        unit,
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
        const value = values[index] * shown.scale;
        box.value = (Math.abs(value) < 1e-12 ? 0 : value).toFixed(
          shown.decimals,
        );
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
    if (shown.field === "shape") {
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
          const read = await editor.quantity(text, shown.kind);
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
    preview: (edits) => call("apply_edits", { edits }, { scene: true }),
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
  };

  const stopDrags = watchDrags(view, {
    drawing: () => drawing() && editable(),
    patterned: () => new Set(model.get("payload")?.patterned ?? []),
    begin({ objectIds, mode }) {
      dragActive = true;
      if (playing) setPlaying(false); // the pointer is the one being asked
      editor.begin({ objectIds, mode }).catch(() => {});
    },
    showPose,
    preview: (pose) => editor.preview(pose.edits),
    scene: () => editor.scene(),
    render(payload, { keep }) {
      if (drawing()) api.render(view, payload, { keep });
    },
    commit(pose) {
      dragActive = false;
      settle(editor.commit(pose.edits));
    },
  });

  // --- selection --------------------------------------------------------
  // The view reports a click; what selection *means* is the host's, which
  // here is a traitlet the notebook can read and write.
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
    "axes",
    "theme",
    "editable",
    "revision",
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
    if (now.has("theme")) retheme();
    if (now.has("editable")) dressEditing();
    // An edit settled -- an undo, a drag, a value set from python -- and the
    // rows may say something else now. Not mid-drag: the panel declines
    // itself, and reads its rows back at the release.
    if ((now.has("payload") || now.has("revision")) && !variablesEl.hidden) {
      variables.refresh();
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
      shown = 0;
    }
    if (scene || now.has("tree")) {
      dressLegend();
      showEditing(); // a view pointed at objects, or away from them
    } else legend.sync(stateOf());
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
    if (now.has("selected")) {
      api.highlight(model.get("selected") || []);
      if (editable()) setHandles(handles); // what was asked, for the new one
    }
  }

  // --- drawing ----------------------------------------------------------
  async function draw() {
    // A resting view is drawn by waking it, and only if that does not put a
    // view on screen to rest: a scene or a theme that changed under a
    // picture is caught up when the view is next looked at or pointed to.
    if (resting && !(onScreen() && wake({ anywhere: false }))) return;
    // The renderer this draw loads, held on to: while it loads, the view may
    // be put to rest and woken again with another, and a draw that took
    // whichever it held when it came back would drive a renderer drawing
    // some other view -- or hang a second canvas beside its own.
    const mine = slot;
    const ours = () => slot === mine && mine.host === view;
    let loaded;
    try {
      loaded = await mine.api;
    } catch (error) {
      // The renderer would not load -- a page whose security policy refuses
      // scripts made from a blob, for one. Said where the scene would be,
      // and not kept: the next draw, by this widget or another taking the
      // slot, tries again rather than failing on the same rejected promise.
      if (!ours()) return;
      api = null;
      notify(`The 3D view could not load here: ${error.message}`, {
        stay: true,
      });
      mine.api = loadRenderer();
      mine.api.catch(() => {}); // the next draw's to report, not the page's
      return;
    }
    if (!ours()) return; // taken while we were away
    api = loaded;
    mine.used = performance.now();
    if (view.isConnected) mine.shown = true;
    const payload = model.get("payload") || {};
    if (!payload.meshes) return;
    // Again here, not only at mount: a notebook may hand over the element
    // before it is on the page, when there is nothing behind it to read --
    // nor a backdrop to find.
    dressTheme();
    wearBackdrop();
    // Read only, unless the objects are a session's.
    api.setGizmoMode(editable() ? handles : "none");
    // Before the render, so nodes are built hidden rather than drawn and then
    // taken away -- and so a pooled renderer drops the last widget's.
    api.setHidden(model.get("hidden") || []);
    api.setAxes(Boolean(model.get("axes")));
    api.watchCamera(tellCamera);
    if (!framed) {
      // A pooled renderer comes with the last widget's projection and the
      // legend row it was pointing at. A new view starts from neither --
      // or its projection button would say the opposite of what it shows.
      if (api.cameraState()?.projection === "parallel") api.toggleProjection();
      showProjection("perspective");
    }
    if (!framed || kept) api.hint([]);
    still?.remove(); // the canvas takes its place in the same frame
    still = null;
    api.render(view, payload, { keepCamera: framed });
    // A saved view opens where it was looking when it was saved, and a woken
    // one where it was looking when it was put to rest. A live one has no
    // camera to start from, and frames the scene.
    const saved = kept ?? (framed ? null : model.get("camera"));
    if (saved) showProjection(api.setCamera(saved));
    kept = null;
    framed = true;
    // How the handles drag is this view's to say. A renderer handed on comes
    // snapping, held to an axis and on the axes the last view chose; and the
    // step follows the scene, which may have just changed size.
    api.setSnapping(snapping);
    api.constrainAxis(along);
    api.setSpaces(spaces);
    api.highlight(model.get("selected") || []);
    if (editable()) setHandles(handles);
    // The payload is the run's first frame, so a redraw of the same run --
    // a theme that changed -- would leave the picture at the start while the
    // counter says otherwise. Back to the step that was on screen.
    if (shown > 0) askFor(shown);
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

  model.on("change:height", () => {
    if (!isFullscreen()) view.style.height = `${model.get("height")}px`;
  });
  // Before the first await, so the controls and the legend arrive with the
  // element rather than a frame after it, and dressed for where they are.
  dressTheme();
  dressLegend();
  dressTransport();
  dressEditing();
  showAxes();
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
    // `el` is the host's, and may be rendered into again -- anywidget does,
    // on a module reloaded -- so what was hung on it goes with the view.
    el.removeEventListener("pointermove", moved);
    el.removeEventListener("pointerdown", touch);
    shared.sight.unobserve(view);
    inSight.delete(view);
    waiting.delete(view);
    retry.delete(view);
    // Only if it is still ours. A view whose element left the page has already
    // had its slot taken by the next cell that asked, and freeing it here --
    // late, on a teardown that comes after -- would hand that cell's renderer
    // to a third. So has a resting one.
    if (slot.host === view) {
      slot.host = null; // back to the pool
      slot.freeze = null;
      api?.watchCamera(null);
      offer(); // to a view on screen waiting for one
    }
  };
}

export default { render };
