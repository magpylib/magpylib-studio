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
 * frees the element without freeing the slot.
 */
function acquire(el) {
  const free = pool.find((slot) => !slot.host || !slot.host.isConnected);
  const slot = free || { host: null, api: null };
  if (!free) {
    slot.api = loadRenderer();
    pool.push(slot);
  }
  slot.host = el;
  return slot;
}

/** The page's own background, so the view is not a light rectangle in a dark
 *  notebook. Only when it is opaque: `rgba(0, 0, 0, 0)` is the default, and
 *  means nothing was said. */
function pageBackground() {
  for (const node of [document.body, document.documentElement]) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && !/^(transparent$|rgba\(.*,\s*0\))/.test(color)) return color;
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
  fit:
    '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/>' +
    '<rect x="5.5" y="5.5" width="5" height="5" rx="1"/>',
  projection:
    '<path d="M8 1.75l5.5 3v6.5L8 14.25l-5.5-3v-6.5z"/>' +
    '<path d="M2.5 4.75 8 7.75l5.5-3M8 7.75v6.5"/>',
  expand: '<path d="M9.5 2H14v4.5M14 2 9.5 6.5M6.5 14H2V9.5M2 14l4.5-4.5"/>',
  shrink: '<path d="M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14"/>',
  download: '<path d="M8 2v8M4.75 6.75 8 10l3.25-3.25M2.5 11.5V14h11v-2.5"/>',
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

/** How many rows a tree makes. */
const rowsIn = (nodes) =>
  nodes.reduce((count, node) => count + 1 + rowsIn(node.children), 0);

function render({ model, el }) {
  el.classList.add("magpy-scene");
  const background = pageBackground();
  if (background)
    el.style.setProperty("--vscode-editor-background", background);

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
      model.send({ kind: "export" });
    },
  );
  exportButton.hidden = Boolean(model.get("standalone"));
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
    fitButton,
    projectionButton,
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
  // shadow's host as what is full screen, never this element.
  const root = el.getRootNode();
  const isFullscreen = () => root.fullscreenElement === el;
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
  let legendOpen = null; // undecided until there is a tree to decide by

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
    // Open when it has something to say: one object needs no list. After the
    // first time, it is the user's to open and close.
    showLegend(legendOpen ?? rows > 1);
    legend.update({ tree, payload });
    legend.sync(stateOf());
  }

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
  let framed = false; // whether this widget has drawn into the view yet
  let refit = null; // waits for a first size, when the view was laid out late

  // --- playback ---------------------------------------------------------
  // Frames are asked for one at a time, as in the panel: the whole run is
  // every trace of every step, and one frame is all anyone is looking at.
  let playing = false;
  let inFlight = false;
  let wanted = null; // the frame last asked for, which may not be the one shown
  let shown = 0;
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
  function notify(text) {
    notice.textContent = text;
    notice.classList.add("shown");
    clearTimeout(noticeTimer);
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
    inFlight = true;
    model.send({ kind: "frame", index: wanted });
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
    // the round trips took.
    const wait =
      startedAt + (next / frames()) * duration() * 1000 - performance.now();
    if (wait > 0) early = setTimeout(() => askFor(next), wait);
    else askFor(next);
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
    inFlight = false;
    if (slot.host !== view) return; // this view has gone; its renderer is elsewhere
    api.renderFrame(message);
    shown = message.frame;
    scrub.max = String(message.frames - 1);
    scrub.value = String(message.frame);
    showStep();
    if (playing) afterFrame();
    else if (wanted !== null && wanted !== shown) askFor(wanted);
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
  for (const name of ["payload", "tree", "selected", "hidden"]) {
    model.on(`change:${name}`, () => {
      if (!changed.size) queueMicrotask(catchUp);
      changed.add(name);
    });
  }

  function catchUp() {
    const now = new Set(changed);
    changed.clear(); // first, so a change made while catching up is kept
    const scene = now.has("payload");
    if (scene) {
      // A re-pointed view is a different run. Anything asked for belonged to
      // the last one -- and a request python drops, which is what happens
      // when the new scene has no frames to serve, would leave `inFlight`
      // latched and playback dead for the life of the widget.
      if (playing) setPlaying(false);
      inFlight = false;
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
    if (now.has("hidden")) api?.setHidden(model.get("hidden") || []);
    if (now.has("selected")) api?.highlight(model.get("selected") || []);
  }

  // --- drawing ----------------------------------------------------------
  async function draw() {
    api = await slot.api;
    if (slot.host !== view) return; // the slot was taken while we were away
    const payload = model.get("payload") || {};
    if (!payload.meshes) return;
    api.setGizmoMode("none"); // read only: nothing here can be dragged
    // Before the render, so nodes are built hidden rather than drawn and then
    // taken away -- and so a pooled renderer drops the last widget's.
    api.setHidden(model.get("hidden") || []);
    api.render(view, payload, { keepCamera: framed });
    framed = true;
    api.highlight(model.get("selected") || []);
    // The element may still have been unsized when the view framed itself --
    // a cell that is laid out after its output is made. One refit, once it
    // has a size, and only if the camera has not been touched since.
    if (!view.clientHeight && !refit) {
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
  // element rather than a frame after it.
  dressLegend();
  dressTransport();
  draw();

  /** Hand the browser the file python wrote, as a download. */
  function download({ html, filename }) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    link.download = filename;
    // In the page, not detached: some browsers ignore a click on a link that
    // is not in a document.
    link.hidden = true;
    el.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    notify(`Saved ${filename}`);
  }

  return () => {
    clearTimeout(early);
    clearTimeout(noticeTimer);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    // Only if it is still ours. A view whose element left the page has already
    // had its slot taken by the next cell that asked, and freeing it here --
    // late, on a teardown that comes after -- would hand that cell's renderer
    // to a third.
    if (slot.host === view) slot.host = null; // back to the pool
  };
}

export default { render };
