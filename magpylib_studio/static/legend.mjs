/**
 * The widget's legend: the scene's objects, as their Collection hierarchy.
 *
 * The tree view of magpylib's three.js prototype (`sandbox/threejs`), kept as
 * it was: a caret folds a collection, an eye hides it and everything beneath
 * it, a swatch says what it is drawn in, and the label selects -- a plain click
 * replaces, cmd/ctrl toggles, shift takes the range from the last row clicked,
 * in tree order, which is the only order a scene has. A double click frames
 * what the row holds, and the pointer resting on a row shows where it is.
 *
 * A component, not a panel with opinions: it holds nothing a notebook can see.
 * What is selected and what is hidden are the widget's traitlets. The legend
 * is told them (`sync`) and says what a click would make them (`onSelect`,
 * `onHide`), what it would look at (`onFrame`), or what the pointer is on
 * (`onHint`); the widget decides.
 */

/** Every node, parents before their children. */
function inTreeOrder(nodes, out = []) {
  for (const node of nodes) {
    out.push(node);
    inTreeOrder(node.children, out);
  }
  return out;
}

/** The ids a payload draws something for. */
export function drawnIn(payload) {
  return new Set(
    [...payload.meshes, ...payload.scatters].map((item) => item.object_id),
  );
}

/** What to call each object in `tree`, by id. */
export function labelsOf(tree) {
  return new Map(inTreeOrder(tree).map((node) => [node.id, node.label]));
}

/** What each drawn object is drawn in, as CSS -- decided the way the renderer
 *  decides it, and by the first trace the object has. */
function swatchesOf(payload) {
  const swatches = new Map();
  for (const item of [...payload.meshes, ...payload.scatters]) {
    if (!swatches.has(item.object_id)) {
      swatches.set(item.object_id, swatchOf(item));
    }
  }
  return swatches;
}

/** One trace's colour, in `buildMesh`'s order of precedence: face colours
 *  over a colour scale over a flat colour. A magnet coloured by its
 *  polarization is its colour scale, drawn as the gradient it is. */
function swatchOf(item) {
  if (item.kind === "scatter") {
    return item.lines ? item.line_color : item.marker_color;
  }
  if (item.facecolor) return mostCommon(item.facecolor);
  if (item.lut) return gradientOf(item.lut);
  return item.color || "#2e91e5";
}

/** A colour scale's lookup table -- RGBA, flat -- as a CSS gradient. */
function gradientOf(lut) {
  const last = lut.length / 4 - 1;
  const stops = [0, 0.25, 0.5, 0.75, 1].map((at) => {
    const i = Math.round(at * last) * 4;
    return `rgb(${lut[i]} ${lut[i + 1]} ${lut[i + 2]})`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function mostCommon(values) {
  const counts = new Map();
  let best = values[0];
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
    if (counts.get(value) > counts.get(best)) best = value;
  }
  return best;
}

/** How many things a collection can hold and still be shown open when it is
 *  first seen. Past this it starts folded: a ring of sixty-four would
 *  otherwise be the whole list, and its row still says what is inside -- how
 *  many, and whether any of them is selected or hidden. */
const FOLD_ABOVE = 12;

function modeOf(event) {
  if (event.shiftKey) return "range";
  // cmd on a mac, ctrl elsewhere, as for a click in the view
  return event.metaKey || event.ctrlKey ? "toggle" : "replace";
}

function part(className, title) {
  const el = document.createElement("span");
  el.className = className;
  if (title) el.title = title;
  return el;
}

export function createLegend(container, { onSelect, onHide, onFrame, onHint }) {
  let order = []; // every node, in tree order
  let leaves = new Map(); // id -> the drawn objects under that row
  let swatches = new Map();
  let selected = [];
  let hidden = new Set();
  let anchor = null; // the row a shift-click ranges from
  let proposed = null; // the selection a click here last asked for
  let parents = new Map(); // id -> the id of the collection holding it
  let pathOf = new Map(); // id -> where it sits, as the folds address it
  let primaryAt; // where the first selected object sits
  const rows = new Map(); // id -> row element
  // Folded collections, by where they sit rather than by id: a re-pointed view
  // is new objects at new ids, and a slider drag should not unfold what the
  // user had folded.
  const folded = new Set();
  // Collections already seen, by the same addressing. Only the first sight of
  // one decides whether it starts folded; after that, it is the user's.
  const seen = new Set();

  container.classList.add("magpy-legend");
  // A shift-click extends whatever text selection the page already has, and
  // user-select does not stop that, so the press itself is refused.
  container.addEventListener("mousedown", (event) => {
    if (event.shiftKey) event.preventDefault();
  });
  container.addEventListener("mouseleave", () => onHint?.([]));

  /** Ids a click on `node` acts on: its own traces, if it has any, and those
   *  of everything beneath it. A collection is drawn only as its contents. */
  function collectLeaves(node, drawn) {
    for (const child of node.children) parents.set(child.id, node.id);
    const own = drawn.has(node.id) ? [node.id] : [];
    const under = own.concat(
      node.children.flatMap((child) => collectLeaves(child, drawn)),
    );
    leaves.set(node.id, under);
    return under;
  }

  function propose(ids) {
    proposed = ids;
    onSelect(ids);
  }

  function select(node, mode) {
    const mine = leaves.get(node.id);
    if (mode === "range" && anchor !== null) {
      const from = order.findIndex((n) => n.id === anchor);
      const to = order.indexOf(node);
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      propose([
        ...new Set(order.slice(lo, hi + 1).flatMap((n) => leaves.get(n.id))),
      ]);
      return; // the anchor stays where the range started
    }
    anchor = node.id;
    if (mode === "toggle") {
      const chosen = new Set(selected);
      const all = mine.length > 0 && mine.every((id) => chosen.has(id));
      for (const id of mine) all ? chosen.delete(id) : chosen.add(id);
      propose([...chosen]);
      return;
    }
    // Clicking the row that is already exactly the selection clears it, as a
    // second click on the only selected object in the view does.
    const same =
      mine.length === selected.length &&
      mine.every((id) => selected.includes(id));
    propose(same ? [] : mine);
  }

  /** The eye cascades: anything showing, and the lot goes; none, and it all
   *  comes back. */
  function toggleHidden(node) {
    const mine = leaves.get(node.id);
    const showing = mine.some((id) => !hidden.has(id));
    const next = new Set(hidden);
    for (const id of mine) showing ? next.add(id) : next.delete(id);
    onHide([...next]);
  }

  function addRow(node, path, into) {
    pathOf.set(node.id, path);
    const row = document.createElement("div");
    row.className = "magpy-legend-row";
    const caret = part("magpy-legend-caret");
    const eye = part("magpy-legend-eye", "Show / hide");
    const swatch = part("magpy-legend-swatch");
    const label = part("magpy-legend-label", `${node.label} (${node.kind})`);
    label.textContent = node.label;
    const colour = swatches.get(node.id);
    if (colour) swatch.style.background = colour;
    else swatch.classList.add("none");
    row.append(caret, eye, swatch, label);
    if (node.children.length) {
      // What a folded row would otherwise hide: how much is in it.
      const count = part("magpy-legend-count");
      count.textContent = String(node.children.length);
      row.append(count);
    }
    into.append(row);
    rows.set(node.id, row);

    eye.addEventListener("click", () => toggleHidden(node));
    label.addEventListener("click", (event) => {
      // The second click of a double click is the double click's: counted
      // on its own, it would clear the selection the first one just made.
      if (event.detail < 2) select(node, modeOf(event));
    });
    label.addEventListener("dblclick", () => onFrame?.(leaves.get(node.id)));
    // Which of twelve cubes "upper 3" is, without choosing it.
    row.addEventListener("mouseenter", () => onHint?.(leaves.get(node.id)));

    if (!node.children.length) {
      caret.classList.add("leaf");
      return;
    }
    row.classList.add("group");
    const branch = document.createElement("div");
    branch.className = "magpy-legend-branch";
    into.append(branch);
    node.children.forEach((child, i) => addRow(child, `${path}/${i}`, branch));
    if (!seen.has(path)) {
      seen.add(path);
      if (node.children.length > FOLD_ABOVE) folded.add(path);
    }
    const fold = (on) => {
      row.classList.toggle("folded", on);
      branch.hidden = on;
    };
    fold(folded.has(path));
    caret.addEventListener("click", () => {
      const on = !folded.has(path);
      on ? folded.add(path) : folded.delete(path);
      fold(on);
    });
  }

  /** Draw `tree`, for a view drawing `payload`. */
  function update({ tree, payload }) {
    const drawn = drawnIn(payload);
    order = inTreeOrder(tree);
    leaves = new Map();
    parents = new Map();
    pathOf = new Map();
    for (const node of tree) collectLeaves(node, drawn);
    swatches = swatchesOf(payload);
    if (!order.some((node) => node.id === anchor)) anchor = null;
    rows.clear();
    container.replaceChildren();
    tree.forEach((node, i) => addRow(node, String(i), container));
    paint();
  }

  /** Mirror what is selected and what is hidden onto the rows. */
  function sync(state) {
    selected = state.selected;
    hidden = new Set(state.hidden);
    paint();
    // A selection made here is already in view; one made in the view or in
    // a cell may be off the bottom of the list. Compared by place, not by
    // id: a rebuild carries the selection to new ids in the same places, and
    // following it there on every slider drag would fight whoever scrolled.
    const was = primaryAt;
    primaryAt = pathOf.get(selected[0]);
    const echo =
      proposed !== null &&
      proposed.length === selected.length &&
      proposed.every((id, i) => id === selected[i]);
    proposed = null;
    if (!echo && primaryAt !== undefined && primaryAt !== was) {
      reveal(selected[0]);
    }
  }

  /** Scroll the list to `id`'s row -- or, when that is folded away, to the
   *  collection it is in, whose mark says it is there. The list only: the
   *  browser's own scrollIntoView would scroll the notebook as well. */
  function reveal(id) {
    let at = id;
    while (rows.get(at)?.closest(".magpy-legend-branch[hidden]")) {
      at = parents.get(at);
    }
    const row = rows.get(at);
    if (!row) return;
    const list = container.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    if (box.top < list.top) container.scrollTop -= list.top - box.top;
    else if (box.bottom > list.bottom) {
      container.scrollTop += box.bottom - list.bottom;
    }
  }

  /** A row is selected, or hidden, when everything under it is; partly so
   *  when some of it is -- which is how a folded collection says that what
   *  was picked in the view, or hidden, is inside it. */
  function paint() {
    const chosen = new Set(selected);
    for (const node of order) {
      const mine = leaves.get(node.id);
      const row = rows.get(node.id);
      const picked = mine.filter((id) => chosen.has(id)).length;
      const gone = mine.filter((id) => hidden.has(id)).length;
      const all = (n) => mine.length > 0 && n === mine.length;
      const some = (n) => n > 0 && n < mine.length;
      row.classList.toggle("selected", all(picked));
      row.classList.toggle("partial", some(picked));
      row.classList.toggle("off", all(gone));
      row.classList.toggle("mixed", some(gone));
      row.classList.toggle("empty", mine.length === 0);
    }
  }

  return { update, sync };
}
