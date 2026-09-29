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
 */
import rendererSource from "../../build/renderer.txt";
import { createLegend, drawnIn } from "./legend.mjs";

/** Live views: `{ host, api }`, where `api` is a promise of one scene3d. */
const pool = [];

function loadRenderer() {
  const url = URL.createObjectURL(
    new Blob([rendererSource], { type: "text/javascript" }),
  );
  return import(url).then((module) => {
    URL.revokeObjectURL(url); // it has been fetched; the module instance stays
    return module.scene3d;
  });
}

/** A renderer for `el`, reusing one whose element has gone.
 *
 * `isConnected` as well as the cleanup below, because a cell removed while
 * the widget was never destroyed -- marimo re-running the cell that made it --
 * frees the element without freeing the slot. But only an element that was
 * on the page can have left it: Jupyter renders a widget before attaching it,
 * and a view not yet attached is not a view that has gone. Taken as one, two
 * widgets rendered together shared a renderer, and the first lost its canvas.
 */
function acquire(el) {
  // Whatever is on the page now has been seen there, whether or not it was
  // drawn after it arrived.
  for (const slot of pool) if (slot.host?.isConnected) slot.shown = true;
  const free = pool.find(
    (slot) => !slot.host || (slot.shown && !slot.host.isConnected),
  );
  const slot = free || { host: null, api: null };
  if (!free) {
    slot.api = loadRenderer();
    pool.push(slot);
  }
  slot.host = el;
  slot.shown = false; // until its element is seen on the page
  return slot;
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
 *  placeholder is no company. */
const WIDGETS = ".lm-Widget, .jupyter-widgets";
function company(node) {
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
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9" stroke-width="2"/>',
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

/** The theme button's round: each choice, what it is called, and the next. */
const THEMES = {
  auto: { says: "Theme: as the notebook is", next: "light" },
  light: { says: "Theme: light", next: "dark" },
  dark: { says: "Theme: dark", next: "auto" },
};

/** How many rows a tree makes. */
const rowsIn = (nodes) =>
  nodes.reduce((count, node) => count + 1 + rowsIn(node.children), 0);

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
      model.send({ kind: "export", camera: api?.cameraState() });
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
  tools.append(
    legendButton,
    axesButton,
    fitButton,
    projectionButton,
    themeButton,
    pictureButton,
    exportButton,
    fullscreenButton,
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

  stage.append(tools, transport, notice);
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
    else if (rows === 1) {
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
   *  which holds the keys and moves the camera itself. Tab is not answered:
   *  in a notebook it moves between cells, and a view that kept it would be
   *  a trap. Each declines, with false, when it has nothing to do, so the
   *  key is left to the page. */
  const viewActions = {
    projection: showProjection,
    play() {
      if (frames() < 2) return false;
      setPlaying(!playing);
    },
    deselect() {
      if (!(model.get("selected") || []).length) return false;
      commit("selected", []);
    },
    hide({ isolate }) {
      const chosen = model.get("selected") || [];
      const hidden = new Set(model.get("hidden") || []);
      if (isolate) {
        // Show only the selection -- or, with something already hidden,
        // everything again: the one key narrows the view and restores it.
        if (!hidden.size && !chosen.length) return false;
        const drawn = drawnIn(model.get("payload"));
        commit(
          "hidden",
          hidden.size ? [] : [...drawn].filter((id) => !chosen.includes(id)),
        );
        return;
      }
      if (!chosen.length) return false;
      const showing = chosen.some((id) => !hidden.has(id));
      for (const id of chosen) showing ? hidden.add(id) : hidden.delete(id);
      commit("hidden", [...hidden]);
    },
  };

  stage.addEventListener("keydown", (event) => {
    if (!api?.viewKey(event, viewActions)) return;
    event.preventDefault();
    event.stopPropagation(); // the notebook listens further up
  });
  // A canvas cannot take focus, and the controls may keep it from moving
  // there on a press: give it to the stage outright.
  stage.addEventListener("pointerdown", () =>
    stage.focus({ preventScroll: true }),
  );

  const slot = acquire(view);
  let api = null;
  // Whether the renderer is loaded and still this view's to drive.
  const drawing = () => api !== null && slot.host === view;
  let framed = false; // whether this widget has drawn into the view yet
  let refit = null; // waits for a first size, when the view was laid out late

  // Where the camera is, told to python once it stops moving, so that a
  // `write_html` from a cell saves the view as it is seen. A message and not
  // a trait: marimo re-runs every cell that reads a widget when one of its
  // traits changes, and orbiting is not something to recompute a notebook for.
  let cameraTimer = null;
  function tellCamera() {
    clearTimeout(cameraTimer);
    cameraTimer = setTimeout(() => {
      if (slot.host === view) {
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
    if (message.kind === "export") {
      download(message);
      return;
    }
    if (message.kind !== "frame" || !api) return;
    // A frame of the run before this one, answered after the view was
    // re-pointed: drawn, it would put the old scene over the new.
    if (message.runId !== runId) return;
    inFlight = false;
    answered();
    if (slot.host !== view) return; // this view has gone; its renderer is elsewhere
    api.renderFrame(message);
    scrub.max = String(message.frames - 1);
    reached(message.frame);
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
  for (const name of [
    "payload",
    "tree",
    "selected",
    "hidden",
    "axes",
    "theme",
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
    if (scene || now.has("tree")) dressLegend();
    else legend.sync(stateOf());
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
    if (now.has("selected")) api.highlight(model.get("selected") || []);
  }

  // --- drawing ----------------------------------------------------------
  async function draw() {
    try {
      api = await slot.api;
    } catch (error) {
      // The renderer would not load -- a page whose security policy refuses
      // scripts made from a blob, for one. Said where the scene would be,
      // and not kept: the next draw, by this widget or another taking the
      // slot, tries again rather than failing on the same rejected promise.
      api = null;
      if (slot.host !== view) return;
      notify(`The 3D view could not load here: ${error.message}`, {
        stay: true,
      });
      slot.api = loadRenderer();
      slot.api.catch(() => {}); // the next draw's to report, not the page's
      return;
    }
    if (slot.host !== view) return; // the slot was taken while we were away
    if (view.isConnected) slot.shown = true;
    const payload = model.get("payload") || {};
    if (!payload.meshes) return;
    // Again here, not only at mount: a notebook may hand over the element
    // before it is on the page, when there is nothing behind it to read --
    // nor a backdrop to find.
    dressTheme();
    wearBackdrop();
    api.setGizmoMode("none"); // read only: nothing here can be dragged
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
      api.hint([]);
    }
    api.render(view, payload, { keepCamera: framed });
    // A saved view opens where it was looking when it was saved. A live one
    // has no camera to start from, and frames the scene.
    const saved = framed ? null : model.get("camera");
    if (saved) showProjection(api.setCamera(saved));
    framed = true;
    api.highlight(model.get("selected") || []);
    // The payload is the run's first frame, so a redraw of the same run --
    // a theme that changed -- would leave the picture at the start while the
    // counter says otherwise. Back to the step that was on screen.
    if (shown > 0) askFor(shown);
    // The element may still have been unsized when the view framed itself --
    // a cell that is laid out after its output is made. One refit, once it
    // has a size, and only if the camera has not been touched since.
    if (!view.clientHeight && !refit && !saved) {
      refit = new ResizeObserver(() => {
        if (!view.clientHeight) return;
        refit.disconnect();
        api.fitView();
      });
      refit.observe(view);
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
    darkQuery.removeEventListener("change", retheme);
    clearTimeout(early);
    clearTimeout(silence);
    clearTimeout(noticeTimer);
    clearTimeout(cameraTimer);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    // Only if it is still ours. A view whose element left the page has already
    // had its slot taken by the next cell that asked, and freeing it here --
    // late, on a teardown that comes after -- would hand that cell's renderer
    // to a third.
    if (slot.host === view) {
      slot.host = null; // back to the pool
      api?.watchCamera(null);
    }
  };
}

export default { render };
