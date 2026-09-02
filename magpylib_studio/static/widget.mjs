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

function button(label, title, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.title = title;
  el.addEventListener("click", onClick);
  return el;
}

function render({ model, el }) {
  el.classList.add("magpy-scene");
  const background = pageBackground();
  if (background)
    el.style.setProperty("--vscode-editor-background", background);

  const view = document.createElement("div");
  view.className = "magpy-scene-view";
  view.style.height = `${model.get("height")}px`;

  const bar = document.createElement("div");
  bar.className = "magpy-scene-bar";
  const status = document.createElement("span");
  status.className = "magpy-scene-status";
  const play = button("▶", "Play the paths", () => setPlaying(!playing));
  play.hidden = true;
  const scrub = document.createElement("input");
  scrub.type = "range";
  scrub.min = "0";
  scrub.value = "0";
  scrub.hidden = true; // until a payload says how many steps there are
  scrub.className = "magpy-scene-scrub";
  bar.append(
    button("Fit", "Frame the whole scene", () => api?.fitView()),
    button("Ortho", "Switch between perspective and orthographic", (event) => {
      // The renderer answers with the projection now in force, so the
      // button offers the other one.
      event.target.textContent =
        api?.toggleProjection() === "parallel" ? "Persp" : "Ortho";
    }),
    play,
    scrub,
    status,
  );
  el.append(view, bar);

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

  const frames = () => model.get("frames");
  const duration = () => model.get("duration") || 5;

  //: What the bar says when nothing is selected and nothing is playing.
  let summary = "";

  /** Everything the bar shows, read straight off the model.
   *
   * Synchronous, and called before anything is awaited: the payload, the
   * frame count and the labels are all in hand the moment the widget mounts,
   * so a bar that waited for the renderer would appear a frame later than the
   * view and lay itself out again when it did -- which is the flicker on
   * every re-run of the cell that made the widget.
   */
  function dressBar() {
    const payload = model.get("payload") || {};
    const animated = frames() > 1;
    play.hidden = !animated;
    scrub.hidden = !animated;
    scrub.max = String(Math.max(1, frames() - 1));
    summary = payload.meshes
      ? `${payload.meshes.length} meshes, ${payload.scatters.length} lines` +
        (animated ? ` · ${frames()} steps` : "")
      : "";
    sayWhatIsSelected();
  }

  function say(text) {
    status.textContent = text;
  }

  /** The selection in the words the notebook uses for it, when it was told
   *  them -- `SceneWidget.identify` -- and by id when it was not. */
  function sayWhatIsSelected() {
    const ids = model.get("selected") || [];
    const labels = model.get("labels") || {};
    say(
      ids.length
        ? `Selected: ${ids.map((id) => labels[id] || id).join(", ")}`
        : summary,
    );
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
    playing = api ? api.setPlaying(on) : false;
    play.textContent = playing ? "⏸" : "▶";
    play.title = playing ? "Pause" : "Play the paths";
    if (!playing) {
      if (frames() > 1) say(`Frame ${shown + 1} of ${frames()}`);
      return;
    }
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
    askFor(next);
  }

  scrub.addEventListener("input", () => {
    if (playing) setPlaying(false);
    askFor(Number(scrub.value));
  });

  model.on("msg:custom", (message) => {
    if (message.kind !== "frame" || !api) return;
    inFlight = false;
    if (slot.host !== view) return; // this view has gone; its renderer is elsewhere
    api.renderFrame(message);
    shown = message.frame;
    scrub.max = String(message.frames - 1);
    scrub.value = String(message.frame);
    say(
      `${playing ? "Playing" : "Frame"} ${message.frame + 1} of ${message.frames}`,
    );
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

  model.on("change:selected", () => {
    api?.highlight(model.get("selected") || []);
    sayWhatIsSelected();
  });

  // --- drawing ----------------------------------------------------------
  async function draw() {
    api = await slot.api;
    if (slot.host !== view) return; // the slot was taken while we were away
    const payload = model.get("payload") || {};
    if (!payload.meshes) return;
    api.setGizmoMode("none"); // read only: nothing here can be dragged
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

  model.on("change:payload", () => {
    // A re-pointed view is a different run. Anything asked for belonged to the
    // last one -- and a request python drops, which is what happens when the
    // new scene has no frames to serve, would leave `inFlight` latched and
    // playback dead for the life of the widget.
    if (playing) setPlaying(false);
    inFlight = false;
    wanted = null;
    shown = 0;
    dressBar();
    draw();
  });
  model.on("change:height", () => {
    view.style.height = `${model.get("height")}px`;
  });
  dressBar(); // before the first await, so the bar arrives with the element
  draw();

  return () => {
    // Only if it is still ours. A view whose element left the page has already
    // had its slot taken by the next cell that asked, and freeing it here --
    // late, on a teardown that comes after -- would hand that cell's renderer
    // to a third.
    if (slot.host === view) slot.host = null; // back to the pool
  };
}

export default { render };
