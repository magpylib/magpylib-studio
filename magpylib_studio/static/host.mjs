/**
 * The widget in a host's own panel: the model anywidget holds in a notebook,
 * held here for a host with no kernel -- the VS Code studio's scene tab
 * (docs/decisions.md#0011-one-view).
 *
 * Here, in the package, because it is the widget's: what the model holds, how
 * a payload says how many steps a run has, which children of a sensor are its
 * parts, what the view's own calls ask. A host loads it from the package that
 * wrote the scene, with the widget (decision 0057), so it is always of the
 * payload's version; what the host keeps is what only it can do, handed in as
 * `host`:
 *
 *   rpc(method, params)    the engine, through the host
 *   editor                 the edits (`begin`, `preview`, `commit`, ...): 0011
 *   select(objectId)       a pick, for the side bar to show
 *   setVisible(hide, show) hiding, an edit in the studio, saved and undoable
 *   setFieldLines(on)      the field lines' switch, the document's too
 *   useVariant(name)       a variant used from the view's row of them
 *   say(text)              a word in the host's bar
 *
 * And a script's figure, drawn in a host's panel with no python behind it
 * (`mountFigure`): what a `widget` payload's body holds, read here too.
 *
 * These are the extension's one contract with this file, and `rpc.PROTOCOL`
 * covers it: a change to `host`, or to what `mountWidget` and `mountFigure`
 * take and return, is a bump.
 */
import widget from "./widget.js";

/** The view's own calls the host answers: the grid of variants (#127) asks
 *  each variant's scene and which variant the scene is at, through the host
 *  to the engine, and uses one through the host, which brings every surface
 *  along, as the Variables view's choice does. */
const READS = new Set([
  "variant_scene",
  "get_variables",
  "drop_variant_copies",
]);

/** A sensor drawn as its parts -- its axes, pixels and field lines, listed
 *  beneath it (`threejs.PARTS`) -- hides them one by one as the view's own
 *  setting, as a fade is: no object of the document is a part. Hidden whole,
 *  it is the sensor that is hidden, an edit as any object's is. */
const PART_KINDS = new Set(["Axes", "Pixels", "FieldLines"]);

/** Each sensor in `tree` drawn whole as its parts -- its axes among them --
 *  and their ids; and, in `apart`, every part's id. */
function partsIn(tree, into = new Map(), apart = new Set()) {
  for (const node of tree) {
    const children = node.children || [];
    const parts = children.filter((child) => PART_KINDS.has(child.kind));
    const ids = parts.map((part) => part.id);
    for (const id of ids) apart.add(id);
    if (parts.some((part) => part.kind === "Axes")) into.set(node.id, ids);
    partsIn(children, into, apart);
  }
  return { whole: into, apart };
}

function hiddenIn(tree, into = []) {
  for (const node of tree) {
    if (node.visible === false) into.push(node.id);
    hiddenIn(node.children || [], into);
  }
  return into;
}

/** How many steps the scene's run has: one past the step its payload draws,
 *  the last (`step`), which counts every path -- `paths` leaves out those too
 *  long to drag, and a pattern's copies. */
function framesOf(payload) {
  if (payload.step !== undefined) return payload.step + 1;
  const steps = Object.values(payload.paths || {}).map(
    (path) => path.position.length,
  );
  return Math.max(1, ...steps);
}

/**
 * Draw the widget in `el`, against a model held here and `host` (above).
 *
 * Returns what the host drives it with: `load(current)` draws the engine's
 * scene as it is now -- unless `current()` says, once the engine has
 * answered, that the host has moved on -- `select(objectId)` takes a pick the
 * side bar made, and `resize(height)` the panel's height.
 */
export function mountWidget(el, host) {
  // What the view sets and saves is the user's: a selection is told to the
  // side bar, and hiding is an edit in the studio, so it is told to the host
  // as one. What the host says is taken in without being told back.
  const values = {
    payload: {},
    tree: [],
    selected: [],
    hidden: [],
    // a view setting here too, not told to the host: docs/decisions.md#0031-the-legends-eye-fades-as-a-view-setting
    faded: {},
    // the colour bar's cut, and its one scale for all, view settings too:
    // docs/decisions.md#0033-the-colour-bar-cuts-a-sensors-colours-as-a-view-setting
    color_range: {},
    color_shared: false,
    axes: "cube",
    flow: true, // a view setting, as a fade is: not told to the host
    theme: "auto",
    height: 400,
    frames: 1,
    duration: 5,
    repeat: false,
    editable: true,
    standalone: true, // no kernel to write an HTML export
    revision: 0,
    last_edit: {},
  };
  const listeners = {};
  const emit = (event, value) =>
    (listeners[event] || []).forEach((listener) => listener(value));
  /** Set what the host says, as a change the view hears but does not send. */
  function take(key, value) {
    values[key] = value;
    emit(`change:${key}`, value);
  }
  // what the host last heard from here
  const told = { selected: [], hidden: [], field_lines: false };
  let partsHidden = new Set();
  let inSidebar = null; // the object the side bar shows

  /** What the view saved, told to whoever it is for. */
  function tell() {
    const selected = values.selected || [];
    if (selected.join() !== told.selected.join()) {
      told.selected = selected;
      // The side bar shows one object. A new first object is a pick to tell
      // it; adding to a selection keeps the one it shows.
      if (selected.length && selected[0] !== inSidebar) {
        inSidebar = selected[0];
        host.select(inSidebar);
      }
    }
    const asked = new Set(values.hidden || []);
    const { whole, apart } = partsIn(values.tree || []);
    const hidden = new Set([...asked].filter((id) => !apart.has(id)));
    partsHidden = new Set([...asked].filter((id) => apart.has(id)));
    for (const [sensor, ids] of whole) {
      if (!ids.every((id) => asked.has(id))) continue;
      hidden.add(sensor);
      for (const id of ids) partsHidden.delete(id);
    }
    const was = new Set(told.hidden);
    const hide = [...hidden].filter((id) => !was.has(id));
    const show = [...was].filter((id) => !hidden.has(id));
    told.hidden = [...hidden];
    // One call, so one step to undo: showing only the selection can hide some
    // objects and show another in the same keystroke.
    if (hide.length || show.length) host.setVisible(hide, show);
    // the lines are the document's too: an edit, saved and undoable
    const lines = Boolean(values.field_lines);
    if (lines !== told.field_lines) {
      told.field_lines = lines;
      host.setFieldLines(lines);
    }
  }

  /** A step of the run, asked of the engine as the view asks it of a kernel. */
  async function serveFrame({ index, runId }) {
    try {
      const frame = await host.rpc("get_scene", { frame: index });
      if (frame.duration) values.duration = frame.duration;
      emit("msg:custom", { kind: "frame", ...frame, runId });
    } catch (error) {
      host.say(String(error.message || error));
    }
  }

  function answerCall({ id, method, params }) {
    const reply = (answer) =>
      emit("msg:custom", { kind: "rpc", id, ...answer });
    if (method === "use_variant") {
      host.useVariant(params.name);
      reply({ result: { ok: true } });
    } else if (READS.has(method)) {
      host.rpc(method, params).then(
        (result) => reply({ result }),
        (error) =>
          reply({ error: { message: String(error.message || error) } }),
      );
    }
  }

  const model = {
    get: (key) => values[key],
    set: (key, value) => {
      values[key] = value;
      emit(`change:${key}`, value);
    },
    save_changes: tell,
    on: (event, listener) => (listeners[event] ||= []).push(listener),
    off() {},
    send(message) {
      if (message.kind === "frame") serveFrame(message);
      else if (message.kind === "rpc") answerCall(message);
    },
    // the studio's Scene tree is its legend; the widget's is a button away
    legendStartsClosed: true,
    // Tab walks the scene's objects, as it did in the studio's panel
    tabWalks: true,
    // the variants' row along the foot, for a click to use one -- through the
    // host -- and a lift to show one beside the scene (#127)
    showsVariants: true,
    editor: host.editor,
  };

  widget.render({ model, el });

  return {
    async load(current = () => true) {
      const [payload, tree, panel] = await Promise.all([
        host.rpc("get_scene", {}),
        host.rpc("object_tree", {}),
        host.rpc("get_variables", {}),
      ]);
      if (!current()) return; // the host moved on while the engine answered
      const hidden = hiddenIn(tree);
      told.hidden = hidden;
      // a sensor hidden as its parts, as the legend's eye hides it, and the
      // parts hidden here where it is not
      const { whole, apart } = partsIn(tree);
      const off = [
        ...hidden.flatMap((id) => whole.get(id) ?? [id]),
        ...[...partsHidden].filter((id) => apart.has(id)),
      ];
      // the document's switch, which the engine's scene says (#45)
      told.field_lines = Boolean(payload.field_lines);
      take("tree", tree);
      // the variants' names, for the grid of them; the Variables view uses them
      const names = Object.keys(panel?.variants ?? {});
      if (names.join("\n") !== (values.variants ?? []).join("\n")) {
        take("variants", names);
      }
      take("hidden", off);
      take("frames", framesOf(payload));
      take("field_lines", told.field_lines);
      take("payload", payload);
    },
    select(objectId) {
      // the side bar, or a pick told back: one object, and the set restarts
      inSidebar = objectId || null;
      const selected = inSidebar ? [inSidebar] : [];
      told.selected = selected;
      take("selected", selected);
    },
    resize(height) {
      take("height", height);
    },
  };
}

/** Each object's place in the legend -- its position and name at every level
 *  down -- by its id. A script's ids are the objects' own, from the process
 *  that drew them, so a re-run's are all new; the place is what carries over. */
function placesIn(tree, above = "", places = new Map()) {
  tree.forEach((node, i) => {
    const place = `${above}/${i}:${node.label}`;
    places.set(node.id, place);
    placesIn(node.children || [], place, places);
  });
  return places;
}

/** `ids` in the tree `before`, as the ids of the same places in `after`.
 *  One whose place is gone, or now holds something else, is dropped. */
function carried(ids, before, after) {
  const was = placesIn(before);
  const now = new Map([...placesIn(after)].map(([id, place]) => [place, id]));
  return ids.map((id) => now.get(was.get(id))).filter(Boolean);
}

/**
 * Draw a script's figure in `el`: the body of a `widget` payload, whose state
 * is the model and whose run is every frame of a run too big to carry as
 * changes. There is no python behind it: the model is held here, and answers
 * the view's asks for frames from the run.
 *
 * Returns `show(body, height)` -- the first figure, or a re-run's, in the view
 * as the user left it -- `resize(height)` and `dispose()`, which lets the
 * renderer go.
 */
export function mountFigure(el) {
  let model = null;
  let run = [];
  let cleanup = null;

  function localModel(state) {
    const values = { ...state };
    const listeners = {};
    const emit = (event, value) =>
      (listeners[event] || []).forEach((listener) => listener(value));
    return {
      get: (key) => values[key],
      set(key, value) {
        values[key] = value;
        emit(`change:${key}`, value);
      },
      save_changes() {},
      on: (event, listener) => (listeners[event] ||= []).push(listener),
      off() {},
      send(message) {
        if (message.kind !== "frame" || !run.length) return;
        const at = Math.max(0, Math.min(message.index, run.length - 1));
        setTimeout(() =>
          emit("msg:custom", {
            kind: "frame",
            ...run[at],
            runId: message.runId,
          }),
        );
      },
    };
  }

  return {
    show(body, height) {
      const state = body.state || {};
      run = body.run || [];
      if (model) {
        // A re-run: the script's new figure, in the view as the user left
        // it. What was set here -- theme, axes, what is hidden and picked --
        // was set by the user, not the script, and stays. Everything before
        // the payload: the widget reads a new payload with the tree, run
        // length and pace it belongs to.
        const before = model.get("tree") || [];
        const after = state.tree || [];
        for (const key of ["hidden", "selected"]) {
          model.set(key, carried(model.get(key) || [], before, after));
        }
        for (const key of ["tree", "frames", "duration", "repeat"]) {
          model.set(key, state[key]);
        }
        model.set("payload", state.payload);
        return;
      }
      model = localModel({ ...state, height });
      cleanup = widget.render({ model, el }) || null;
    },
    resize(height) {
      model?.set("height", height);
    },
    dispose() {
      cleanup?.();
      cleanup = null;
      model = null;
      run = [];
    },
  };
}
