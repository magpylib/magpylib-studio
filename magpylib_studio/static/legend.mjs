/**
 * The widget's legend: the scene's objects, as their Collection hierarchy.
 *
 * The tree view of magpylib's three.js prototype (`sandbox/threejs`), kept as
 * it was: a caret folds a collection, an eye hides it and everything beneath
 * it -- or, pressed and slid sideways, fades it -- a swatch says what it is
 * drawn in, and the label selects -- a plain click
 * replaces, cmd/ctrl toggles, shift takes the range from the last row clicked,
 * in tree order, which is the only order a scene has. A double click frames
 * what the row holds, and the pointer resting on a row shows where it is.
 *
 * A plain click on a collection selects the collection itself, where the view
 * can put handles on one (its payload's `collections`), so a drag moves it
 * whole; otherwise, and for the other clicks, what it holds.
 *
 * A component, not a panel with opinions: it holds nothing a notebook can see.
 * What is selected, hidden and faded are the widget's traitlets. The legend
 * is told them (`sync`) and says what a click would make them (`onSelect`,
 * `onHide`, `onFade`), what it would look at (`onFrame`), or what the pointer
 * is on (`onHint`); the widget decides.
 *
 * What overlaps is marked: a warning at the end of each overlapping row,
 * passed up to a folded collection, and above the list a count that steps
 * through the pairs. The payload says which (`overlaps`), by the ids the view
 * draws, a pattern's copies among them; a copy is not listed, so it is
 * marked on its source's row.
 *
 * A sensor whose pixels the view draws apart is listed as its parts (`Axes`,
 * `Pixels`, `FieldLines`: `threejs.PARTS`), each a row beneath it with an eye
 * of its own, which hides and fades that part alone; the sensor's eye
 * cascades to them all, as a collection's does. A part is not an object: a
 * click on its row, a double click or the pointer resting on it is one on
 * its sensor.
 */

/** A part of a sensor's drawing, listed beneath it: see `threejs.PARTS`. */
const PART_KINDS = new Set(["Axes", "Pixels", "FieldLines"]);
const isPart = (node) => PART_KINDS.has(node.kind);

/** Each sensor in `tree` drawn as its parts, and what its eye hides in its
 *  place: those, and itself where its axes are not one of them -- a sensor
 *  whose pixels magpylib draws, with only its field lines apart. */
export function partsIn(tree, into = new Map()) {
  for (const node of tree) {
    const parts = node.children.filter(isPart);
    if (parts.length) {
      const own = parts.some((part) => part.kind === "Axes") ? [] : [node.id];
      into.set(node.id, [...own, ...parts.map((part) => part.id)]);
    }
    partsIn(node.children, into);
  }
  return into;
}

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
    [...payload.meshes, ...payload.scatters, ...(payload.pixels ?? [])].map(
      (item) => item.object_id,
    ),
  );
}

/** What each drawn object is drawn in, as CSS -- decided the way the renderer
 *  decides it, and by the first trace the object has. */
function swatchesOf(payload) {
  const swatches = new Map();
  for (const item of [
    ...payload.meshes,
    ...payload.scatters,
    ...(payload.pixels ?? []),
    ...(payload.fieldlines ?? []),
  ]) {
    // a sensor's parts by their own: its pixels' colours, its lines'
    const key = item.part ?? item.object_id;
    if (!swatches.has(key)) {
      swatches.set(key, swatchOf(item, payload.luts || []));
    }
  }
  return swatches;
}

/** One trace's colour, in `buildMesh`'s order of precedence: face colours
 *  over a colour scale over a flat colour. A magnet coloured by its
 *  polarization is its colour scale, drawn as the gradient it is. */
function swatchOf(item, luts) {
  if (item.kind === "scatter") {
    return item.lines ? item.line_color : item.marker_color;
  }
  // a sensor's lines in their table, strongest in the middle, as round a
  // magnet; its pixels, read by the field, in the same table across
  if (item.kind === "fieldlines") return gradientOfColours(item.lut, true);
  if (item.kind === "pixels" && item.scale) {
    return gradientOfColours(item.scale.lut);
  }
  if (item.kind === "pixels") {
    // a sensor's pixels coloured by the field: the middle of its colours
    const colors = item.colors;
    return Array.isArray(colors)
      ? colors[Math.floor(colors.length / 2)]
      : colors;
  }
  if (item.facecolor) return mostCommon(item.facecolor);
  // a payload shares its colour tables, and a mesh names its own by index
  const lut = typeof item.lut === "number" ? luts[item.lut] : item.lut;
  if (lut) return gradientOf(lut);
  return item.color || "#2e91e5";
}

/** A sensor's axes as the view draws them, as a CSS image: the shafts in
 *  the sensor's colour, the tips in those of its x, y and z -- z up, x to
 *  the lower left, y to the lower right, as the sensor's icon has them. A
 *  picture rather than the masks of the other kinds, which take one colour. */
function axesPicture(body, [x, y, z]) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    `<path d="M8 8.2V4.8M8 8.2 4.99 10.18M8 8.2l3.01 1.98" fill="none" stroke="${body}" stroke-width="1.3" stroke-linecap="round"/>` +
    `<path d="M8 2.2 6.6 4.8h2.8Z" fill="${z}"/>` +
    `<path d="m2.99 11.5 2.72-.23-1.43-2.17Z" fill="${x}"/>` +
    `<path d="m13.01 11.5-2.72-.23 1.43-2.17Z" fill="${y}"/>` +
    "</svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Colours from the least field to the most, as a CSS gradient: across, or
 *  `radial`, the most in the middle. Five stops: a 13px icon shows no more. */
function gradientOfColours(colours, radial = false) {
  const stops = [0, 0.25, 0.5, 0.75, 1].map(
    (at) => colours[Math.round(at * (colours.length - 1))],
  );
  return radial
    ? `radial-gradient(circle, ${stops.reverse().join(", ")})`
    : `linear-gradient(90deg, ${stops.join(", ")})`;
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

/** The tree's icon for a kind of object (`media/icons`, carried in the
 *  stylesheet as masks): the shape says what it is, the colour behind it what
 *  it is drawn in. A magnet shows its polarization colours through its own
 *  outline. A kind without an icon of its own gets the nearest. */
const ICONS = {
  Cuboid: "cuboid",
  Cylinder: "cylinder",
  CylinderSegment: "cylinder-segment",
  Sphere: "sphere",
  Tetrahedron: "tetrahedron",
  TriangularMesh: "mesh",
  Triangle: "triangle",
  TriangleSheet: "sheet",
  TriangleStrip: "strip",
  Circle: "loop",
  Polyline: "polyline",
  Dipole: "dipole",
  CustomSource: "custom",
  Sensor: "sensor",
  Axes: "sensor",
  Pixels: "pixels",
  FieldLines: "field-lines",
};

/** How many objects a row stands for in the view: itself and the copies its
 *  pattern makes, times what a patterned collection repeats. A pattern's
 *  copies are drawn on their source and not listed, so a ring of ten lists
 *  one magnet; the count says ten. A sealed collection's parts are not
 *  listed either, and are counted the same way. */
function drawnUnder(node) {
  const own = 1 + (node.copies || 0);
  if (node.parts) return own * node.parts;
  const held = node.children.filter((child) => !isPart(child));
  if (!held.length) return own;
  return own * held.reduce((sum, child) => sum + drawnUnder(child), 0);
}

/** How many things a collection can hold and still be shown open when it is
 *  first seen. Past this it starts folded: a ring of sixty-four would
 *  otherwise be the whole list, and its row still says what is inside -- how
 *  many, and whether any of them is selected or hidden. */
const FOLD_ABOVE = 12;

/** How deep a row sits, by its address: "0" is at the top, "0/1" one down. */
const depthOf = (path) => path.split("/").length - 1;

/** How far a press on an eye moves before it is a slide, not a click; how
 *  far a slide goes from faintest to whole; and how faint is faintest --
 *  not gone, which is the click's. */
const SLIDE_START = 3;
const SLIDE_RANGE = 100;
const FAINTEST = 0.1;

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

export function createLegend(
  container,
  { onSelect, onHide, onFade, onFrame, onHint, onIntend, onMeasure, canEdit },
) {
  let order = []; // every node, in tree order
  let leaves = new Map(); // id -> the drawn objects under that row
  let shows = new Map(); // id -> what its eye hides: those, or their parts
  let holds = {}; // the collections the view can select, as the payload says
  let swatches = new Map();
  let selected = [];
  let hidden = new Set();
  let faded = new Map(); // id -> the share of its opacity it is drawn at
  let anchor = null; // the row a shift-click ranges from
  let proposed = null; // the selection a click here last asked for
  let parents = new Map(); // id -> the id of the collection holding it
  let pathOf = new Map(); // id -> where it sits, as the folds address it
  let primaryAt; // where the first selected object sits
  const rows = new Map(); // id -> row element
  const eyes = new Map(); // id -> its row's eye
  let barEl = null; // how far a slide has faded its row, along the row's foot
  // Folded collections, by where they sit rather than by id: a re-pointed view
  // is new objects at new ids, and a slider drag should not unfold what the
  // user had folded.
  const folded = new Set();
  // Collections already seen, by the same addressing. Only the first sight of
  // one decides whether it starts folded; after that, it is the user's.
  const seen = new Set();
  // How deep a collection may sit and still start open, once the widget has
  // asked for less (`foldFrom`); a ring added by a later rebuild at that
  // depth starts folded like the ones that were there.
  let foldDepth = Infinity;
  const folds = new Map(); // path -> what folds or opens that collection
  let pairs = []; // the overlapping pairs, as the payload lists them
  let depths = []; // how deep each goes, in metres, or null
  let intended = []; // the pairs that overlap on purpose
  let units = null; // how the scene shows a length, when it says
  let sourceOf = new Map(); // a pattern's copy -> the source it is listed as
  let labels = new Map(); // id -> its row's label
  let stepped = null; // the pair the header last showed: { list, index }
  let header = null; // what the header holds, to fill again
  let measured = null; // the gap between the two selected: { key, text }
  let shownPayload = null; // the payload the gap was measured in

  container.classList.add("magpy-legend");
  // A shift-click extends whatever text selection the page already has, and
  // user-select does not stop that, so the press itself is refused.
  container.addEventListener("mousedown", (event) => {
    if (event.shiftKey) event.preventDefault();
  });
  container.addEventListener("mouseleave", () => onHint?.([]));

  /** Ids a click on `node` acts on: its own traces, if it has any, and those
   *  of everything beneath it. A collection is drawn only as its contents.
   *  And what its eye hides, kept in `shows`: the same, but a sensor drawn
   *  as its parts as those, and a part as itself -- a click on which is on
   *  its sensor (`owner`). */
  function collectLeaves(node, drawn, owner = null) {
    for (const child of node.children) parents.set(child.id, node.id);
    if (isPart(node)) {
      leaves.set(node.id, owner ? [owner.id] : []);
      shows.set(node.id, [node.id]);
      return { picks: [], hides: [node.id] };
    }
    const own = drawn.has(node.id) ? [node.id] : [];
    let picks = own;
    // drawn as its axes and the rest, a sensor hides as those
    let hides = node.children.some((child) => child.kind === "Axes") ? [] : own;
    for (const child of node.children) {
      const under = collectLeaves(child, drawn, node);
      picks = picks.concat(under.picks);
      hides = hides.concat(under.hides);
    }
    leaves.set(node.id, picks);
    shows.set(node.id, hides);
    return { picks, hides };
  }

  function propose(ids, part = null) {
    proposed = ids;
    onSelect(ids, { part });
  }

  /** `ids`, a collection among them as the drawn objects it holds. */
  const drawnOf = (ids) =>
    ids.flatMap((id) => (holds[id] ? (leaves.get(id) ?? []) : [id]));

  function select(node, mode) {
    const mine = leaves.get(node.id);
    // A part's row is a way in to its sensor, and to what of it the part
    // is: it selects the sensor, and never clears it, as a second click on
    // a row that is the whole selection does.
    if (isPart(node) && mode === "replace") {
      anchor = node.id;
      propose(mine, node.kind);
      return;
    }
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
      const chosen = new Set(drawnOf(selected));
      const all = mine.length > 0 && mine.every((id) => chosen.has(id));
      for (const id of mine) all ? chosen.delete(id) : chosen.add(id);
      propose([...chosen]);
      return;
    }
    // Clicking the row that is already exactly the selection clears it, as a
    // second click on the only selected object in the view does.
    const picking = holds[node.id] ? [node.id] : mine;
    const same =
      picking.length === selected.length &&
      picking.every((id) => selected.includes(id));
    propose(same ? [] : picking);
  }

  /** The eye cascades: anything showing, and the lot goes; none, and it all
   *  comes back. */
  function toggleHidden(node) {
    const mine = shows.get(node.id);
    const showing = mine.some((id) => !hidden.has(id));
    const next = new Set(hidden);
    for (const id of mine) showing ? next.add(id) : next.delete(id);
    onHide([...next]);
  }

  /** The share of their own opacity a row's objects are drawn at, together. */
  function levelOf(node) {
    const mine = shows.get(node.id);
    if (!mine.length) return 1;
    const sum = mine.reduce((total, id) => total + (faded.get(id) ?? 1), 0);
    return sum / mine.length;
  }

  /** What is faded, with all `node` holds at `level`. Drawn whole is not
   *  faded, and is left out. */
  function fadedWith(node, level) {
    const next = new Map(faded);
    for (const id of shows.get(node.id)) {
      level < 1 ? next.set(id, level) : next.delete(id);
    }
    return next;
  }

  /** Press on a row's eye and slide sideways to fade what the row holds:
   *  left for less of it, right for more, `SLIDE_RANGE` pixels the whole
   *  way. A press that does not slide is a click, and hides. The view is
   *  told at every step, and the level settled once, at the release. */
  function slideToFade(eye, node) {
    let from = null; // where the press began, and the level then
    let slid = false;
    eye.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      eye.setPointerCapture(event.pointerId);
      from = { x: event.clientX, level: levelOf(node) };
      slid = false;
    });
    eye.addEventListener("pointermove", (event) => {
      if (!from) return;
      const dx = event.clientX - from.x;
      if (!slid) {
        if (Math.abs(dx) < SLIDE_START) return;
        slid = true;
        rows.get(node.id).classList.add("sliding");
        onHint?.([]); // the hover's outline would cover the fade it shows
        // a hidden row slid is a row to look at
        const mine = shows.get(node.id);
        if (mine.every((id) => hidden.has(id))) {
          onHide([...hidden].filter((id) => !mine.includes(id)));
        }
      }
      // in hundredths, so a notebook reads 0.3 back rather than 0.30000000000000004
      const level =
        Math.round(
          100 * Math.min(1, Math.max(FAINTEST, from.level + dx / SLIDE_RANGE)),
        ) / 100;
      faded = fadedWith(node, level);
      paint();
      barEl ??= part("magpy-legend-bar");
      barEl.style.setProperty("--fade", String(level));
      rows.get(node.id).append(barEl);
      onFade(Object.fromEntries(faded), { settled: false });
    });
    const release = () => {
      if (!from) return;
      from = null;
      if (!slid) return;
      rows.get(node.id)?.classList.remove("sliding");
      barEl?.remove();
      onFade(Object.fromEntries(faded), { settled: true });
    };
    eye.addEventListener("pointerup", release);
    eye.addEventListener("pointercancel", release);
    // The release of a slide is a click as well, and not one that hides.
    eye.addEventListener("click", () => {
      if (slid) slid = false;
      else toggleHidden(node);
    });
  }

  function addRow(node, path, into, parent = null) {
    pathOf.set(node.id, path);
    // what the row holds as a collection does: a sensor's parts are not that
    const held = node.children.filter((child) => !isPart(child));
    const row = document.createElement("div");
    row.className = "magpy-legend-row";
    const caret = part("magpy-legend-caret");
    const eye = part(
      "magpy-legend-eye",
      "Show / hide — slide sideways to fade",
    );
    const swatch = part("magpy-legend-swatch");
    const label = part("magpy-legend-label");
    label.textContent = node.label;
    row.title =
      isPart(node) && parent
        ? `${parent.label}'s ${node.label}`
        : `${node.label} (${node.kind})`;
    // a sensor's axes are what is left of it beside its other parts
    const colour =
      swatches.get(node.id) ??
      (isPart(node) && parent ? swatches.get(parent.id) : undefined);
    if (colour) swatch.style.background = colour;
    // A collection is drawn only as its contents, so it has no colour of its
    // own: its slot says what it is instead, and the names stay in line.
    if (held.length || node.parts) swatch.classList.add("collection");
    // a sensor, and its axes, drawn as the view draws them
    else if (["Sensor", "Axes"].includes(node.kind) && node.colors && colour) {
      swatch.classList.add("picture");
      swatch.style.background = "";
      swatch.style.setProperty(
        "--magpy-picture",
        axesPicture(colour, node.colors),
      );
    } else if (colour)
      swatch.classList.add("icon", `icon-${ICONS[node.kind] || "custom"}`);
    else swatch.classList.add("none");
    row.append(caret, swatch, label);
    const drawn = drawnUnder(node);
    if (held.length) {
      // What a folded row would otherwise hide: how much is in it, the
      // copies its patterns make included.
      const count = part("magpy-legend-count");
      count.textContent = String(drawn);
      if (drawn !== held.length) {
        count.title = `${held.length} listed, ${drawn} drawn: a pattern's copies are drawn on their source`;
      }
      row.append(count);
    } else if (node.parts) {
      // A sealed collection: one row, what it is made of counted.
      const count = part(
        "magpy-legend-count",
        `made of ${node.parts} parts, sealed: picked, moved and hidden whole`,
      );
      count.textContent = String(drawn);
      row.append(count);
    } else if (node.copies) {
      // The source of a pattern: one listed, this many drawn.
      const count = part(
        "magpy-legend-count",
        `${node.copies} copies, made by its pattern`,
      );
      count.textContent = `×${drawn}`;
      row.append(count);
    }
    const warning = overlapMark(node);
    if (warning) row.append(warning);
    // At the end of the row, as Figma's layers and VS Code's trees put a
    // row's actions: most of the time it is not showing, and a column kept
    // for it at the start pushed every name away from its caret.
    row.append(eye);
    into.append(row);
    rows.set(node.id, row);
    eyes.set(node.id, eye);

    slideToFade(eye, node);
    // The whole row selects, as a row in any tree view does -- all of it but
    // the caret and the eye, which have their own work.
    const own = (event) =>
      event.target.closest(".magpy-legend-eye, .magpy-legend-caret:not(.leaf)");
    row.addEventListener("click", (event) => {
      // The second click of a double click is the double click's: counted
      // on its own, it would clear the selection the first one just made.
      if (own(event) || event.detail > 1) return;
      select(node, modeOf(event));
    });
    row.addEventListener("dblclick", (event) => {
      if (!own(event)) onFrame?.(leaves.get(node.id));
    });
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
    node.children.forEach((child, i) =>
      addRow(child, `${path}/${i}`, branch, node),
    );
    if (!seen.has(path)) {
      seen.add(path);
      if (node.children.length > FOLD_ABOVE || depthOf(path) >= foldDepth) {
        folded.add(path);
      }
    }
    const fold = (on) => {
      row.classList.toggle("folded", on);
      branch.hidden = on;
    };
    fold(folded.has(path));
    folds.set(path, fold);
    caret.addEventListener("click", () => {
      const on = !folded.has(path);
      on ? folded.add(path) : folded.delete(path);
      fold(on);
    });
  }

  /** The row an id is listed on: its own, or its source's for a copy. */
  const rowOf = (id) => sourceOf.get(id) ?? id;

  /** What an id is called: its row's label, and which copy for a copy. */
  function nameOf(id) {
    const row = rowOf(id);
    const label = labels.get(row) ?? row;
    return row === id
      ? label
      : `${label} (copy ${id.slice(id.lastIndexOf("#") + 1)})`;
  }

  /** A length as the scene shows one: in its unit, else in millimetres. */
  function lengthOf(metres) {
    const shown = units ?? { symbol: "mm", scale: 1000 };
    const value = metres * shown.scale;
    const text =
      value === 0 || Math.abs(value) >= 0.01
        ? value.toFixed(2)
        : value.toPrecision(2);
    return `${text} ${shown.symbol}`;
  }

  /** How deep an overlapping pair goes, or null where nobody knows. */
  function overlapDepth(pair) {
    const at = pairs.findIndex(([a, b]) => a === pair[0] && b === pair[1]);
    return at < 0 ? null : (depths[at] ?? null);
  }

  /** Of `list`, the pairs `node` is in: its own, its copies', and -- for a
   *  collection -- everything beneath it. */
  function pairsOf(node, list) {
    const mine = new Set(
      node.children.length ? inTreeOrder([node]).map((n) => n.id) : [node.id],
    );
    return list.filter(([a, b]) => mine.has(rowOf(a)) || mine.has(rowOf(b)));
  }

  /** Whether a pair is the row's own: its, or its copies'. */
  const ownBy = (node) => (pair) => pair.some((id) => rowOf(id) === node.id);

  /** What a row says about one of its pairs. */
  function describe(node, [a, b], meant) {
    const [mine, other] = rowOf(a) === node.id ? [a, b] : [b, a];
    const who =
      mine === node.id
        ? "Overlaps"
        : `Copy ${mine.slice(mine.lastIndexOf("#") + 1)} overlaps`;
    const depth = meant ? null : overlapDepth([a, b]);
    return `${who} ${nameOf(other)}${depth == null ? "" : ` by ${lengthOf(depth)}`}${meant ? ", on purpose" : ""}`;
  }

  /** The warning at the end of an overlapping row, or nothing. Resting on it
   *  shows the others; a click looks at them all. A row whose overlaps are
   *  all meant gets it faint, and a click warns about them again. */
  function overlapMark(node) {
    const active = pairsOf(node, pairs);
    const meant = pairsOf(node, intended).filter(ownBy(node));
    if (!active.length && !meant.length) return null;
    const mark = part("magpy-legend-overlap");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", "overlaps");
    // Its own pairs -- its copies', for a patterned collection -- always; those
    // of the rows beneath it only while it is folded and they are not shown.
    const own = active.filter(ownBy(node));
    const lines = [
      ...own.map((pair) => describe(node, pair, false)),
      ...meant.map((pair) => describe(node, pair, true)),
    ];
    const inside = active.length - own.length;
    if (inside) {
      lines.push(`${inside} overlapping pair${inside === 1 ? "" : "s"} inside`);
    }
    if (!own.length && inside) mark.classList.add("inside");
    const involved = [...new Set([...active, ...meant].flat().map(rowOf))];
    if (!active.length) {
      mark.classList.add("intended");
      if (canEdit?.()) lines.push("Click to warn about it again.");
    }
    mark.title = lines.join("\n");
    mark.addEventListener("mouseenter", () => onHint?.(involved));
    mark.addEventListener("mouseleave", () => onHint?.(leaves.get(node.id)));
    mark.addEventListener("click", (event) => {
      event.stopPropagation(); // looking, not choosing
      if (active.length) onFrame?.(involved);
      else if (canEdit?.()) for (const pair of meant) onIntend?.(pair, false);
    });
    return mark;
  }

  /** A button-like piece of the header. */
  function chip(className, text, title, act) {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    el.title = title;
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.addEventListener("click", act);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        act();
      }
    });
    return el;
  }

  /** Above the list: how many pairs overlap, and a click to step through
   *  them, each selected and looked at in turn -- in a scene of hundreds, or
   *  with a magnet inside a ring, the one place to find them -- with, for
   *  the one shown, a way to say it is meant; how many are meant, likewise;
   *  and, with two objects selected, how far apart they are. */
  function overlapHeader() {
    header = document.createElement("div");
    header.className = "magpy-legend-header";
    const lists = { active: pairs, intended };
    const step = (list) => () => {
      const at =
        stepped?.list === list ? (stepped.index + 1) % lists[list].length : 0;
      stepped = { list, index: at };
      const pair = [...new Set(lists[list][at].map(rowOf))];
      propose(pair);
      onFrame?.(pair);
      fillHeader();
    };
    header.step = step;
    fillHeader();
    return header;
  }

  function fillHeader() {
    if (!header) return;
    header.replaceChildren();
    const editing = canEdit?.() ?? false;
    const showing = (list, all) =>
      stepped?.list === list && stepped.index < all.length
        ? all[stepped.index]
        : null;
    if (pairs.length) {
      const pair = showing("active", pairs);
      header.append(
        chip(
          "magpy-legend-overlaps",
          `${pairs.length} overlap${pairs.length === 1 ? "" : "s"}`,
          pair
            ? `${pairs.map(([a, b]) => `${nameOf(a)} and ${nameOf(b)}`)[stepped.index]}${overlapDepth(pair) == null ? "" : `, ${lengthOf(overlapDepth(pair))} deep`}. Click for the next.`
            : "Magnets that overlap: magpylib adds their magnetizations where they do, so the field there is wrong. Click to look at each pair in turn.",
          header.step("active"),
        ),
      );
      if (pair && editing) {
        header.append(
          chip(
            "magpy-legend-act",
            "On purpose",
            `${nameOf(pair[0])} and ${nameOf(pair[1])} overlap on purpose, as a cut-out does: stop warning about it`,
            () => onIntend?.(pair, true),
          ),
        );
      }
    }
    if (intended.length) {
      const pair = showing("intended", intended);
      header.append(
        chip(
          "magpy-legend-intended",
          `${intended.length} on purpose`,
          "Overlaps marked as meant: not warned about. Click to look at each in turn.",
          header.step("intended"),
        ),
      );
      if (pair && editing) {
        header.append(
          chip(
            "magpy-legend-act",
            "Warn again",
            `Warn about ${nameOf(pair[0])} and ${nameOf(pair[1])} overlapping again`,
            () => onIntend?.(pair, false),
          ),
        );
      }
    }
    if (measured?.text) {
      const line = document.createElement("div");
      line.className = "magpy-legend-measure";
      line.textContent = measured.text;
      header.append(line);
    }
    header.hidden = !header.childElementCount;
  }

  /** With exactly two objects selected, ask how far apart they are, and
   *  say it in the header: once per pair and scene, not per repaint. */
  function measure() {
    const chosen = selected;
    if (!onMeasure || chosen.length !== 2) {
      if (measured) {
        measured = null;
        fillHeader();
      }
      return;
    }
    const key = `${chosen[0]}|${chosen[1]}`;
    if (measured?.key === key && measured.payload === shownPayload) return;
    measured = { key, payload: shownPayload, text: measured?.text ?? "" };
    const asked = measured;
    Promise.resolve(onMeasure(chosen[0], chosen[1]))
      .then((answer) => {
        if (measured !== asked || !answer || answer.ok === false) return;
        const names = `${nameOf(chosen[0])} – ${nameOf(chosen[1])}`;
        asked.text =
          answer.state === "gap"
            ? `${names}: ${lengthOf(answer.distance)} apart`
            : answer.state === "touch"
              ? `${names}: touching`
              : `${names}: overlap${answer.depth == null ? "" : `, ${lengthOf(answer.depth)} deep`}`;
        fillHeader();
      })
      .catch(() => {});
  }

  /** Draw `tree`, for a view drawing `payload`. */
  function update({ tree, payload }) {
    const drawn = drawnIn(payload);
    holds = payload.collections || {};
    order = inTreeOrder(tree);
    leaves = new Map();
    shows = new Map();
    parents = new Map();
    pathOf = new Map();
    for (const node of tree) collectLeaves(node, drawn);
    swatches = swatchesOf(payload);
    pairs = payload.overlaps ?? [];
    depths = payload.overlap_depths ?? [];
    intended = payload.intended_overlaps ?? [];
    units = payload.units?.length ?? null;
    shownPayload = payload;
    if (
      stepped &&
      stepped.index >= (stepped.list === "active" ? pairs : intended).length
    ) {
      stepped = null;
    }
    sourceOf = new Map(
      Object.entries(payload.copies ?? {}).flatMap(([source, made]) =>
        made.map((copy) => [copy, source]),
      ),
    );
    labels = new Map(order.map((node) => [node.id, node.label]));
    if (!order.some((node) => node.id === anchor)) anchor = null;
    rows.clear();
    eyes.clear();
    folds.clear();
    container.replaceChildren(overlapHeader());
    tree.forEach((node, i) => addRow(node, String(i), container));
    paint();
  }

  /** Mirror what is selected, hidden and faded onto the rows. */
  function sync(state) {
    selected = state.selected;
    hidden = new Set(state.hidden);
    faded = new Map(Object.entries(state.faded ?? {}));
    paint();
    measure();
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
    const chosen = new Set(drawnOf(selected));
    for (const node of order) {
      const mine = leaves.get(node.id);
      const seen = shows.get(node.id);
      const row = rows.get(node.id);
      const picked = mine.filter((id) => chosen.has(id)).length;
      const gone = seen.filter((id) => hidden.has(id)).length;
      const all = (n, of) => of.length > 0 && n === of.length;
      const some = (n, of) => n > 0 && n < of.length;
      row.classList.toggle("selected", all(picked, mine));
      row.classList.toggle("partial", some(picked, mine));
      row.classList.toggle("off", all(gone, seen));
      row.classList.toggle("mixed", some(gone, seen));
      row.classList.toggle("empty", mine.length === 0);
      const level = levelOf(node);
      row.classList.toggle("faded", level < 1);
      eyes.get(node.id).style.setProperty("--fade", String(level));
    }
  }

  /** Fold every collection `depth` levels down or deeper -- 0 is the top --
   *  and any that arrives there later. The widget's first look at a tree
   *  that, open, would cover too much of the view. */
  function foldFrom(depth) {
    foldDepth = depth;
    for (const [path, fold] of folds) {
      if (depthOf(path) < depth) continue;
      folded.add(path);
      fold(true);
    }
  }

  return { update, sync, foldFrom };
}
