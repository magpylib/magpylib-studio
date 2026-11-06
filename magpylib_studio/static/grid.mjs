/**
 * Variants side by side (#127), laid out as VS Code lays out its editors: a
 * variant's chip, lifted out of the view's foot, is dropped on a side of a
 * pane, which splits to take it; a pane is moved by its tag the same way, and
 * resized by the line between it and the next. The scene itself is the first
 * pane -- the view, live, with its handles -- and the others are its variants,
 * each a `createScene3d()` of its own, read only, drawing what `sceneOf` hands
 * it: the variant drawn on a copy of the session, or on a saved page from the
 * scenes it carries.
 *
 * Everything else stays the view's, once: the camera (a pane turned turns
 * them all), what is selected, hidden and faded, the colour scale, the step
 * of the run, the tools, the legend and the dock. The cube and the scale bar
 * stand where they stand in one view: in the pane at the bottom right, and
 * the pane under the middle of the bottom edge.
 *
 * After an edit the variants' panes are drawn again one by one. A newer edit
 * stops the round, and starts the next.
 */

/** Past this many panes, a chip dropped in the view is refused. */
export const MOST_PANES = 12;

/** The narrowest a pane is let be, in CSS pixels, either way. */
const NARROWEST = 80;

/** Which side of `box` the point `x`, `y` is nearest: where a pane dropped
 *  there would go. */
function sideOf(box, x, y) {
  const across = (x - box.left) / box.width;
  const down = (y - box.top) / box.height;
  const sides = [
    ["left", across],
    ["right", 1 - across],
    ["top", down],
    ["bottom", 1 - down],
  ];
  return sides.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

/** Whether the point `x`, `y` is in `el`'s box. */
function inside(el, x, y) {
  const at = el.getBoundingClientRect();
  return x >= at.left && x <= at.right && y >= at.top && y <= at.bottom;
}

/**
 * `el`: where the panes go, the view's place. Options:
 * - `view`: the view's own element, the scene's pane.
 * - `mainApi()`: the view's scene3d, or null before it is drawn.
 * - `factory()`: a new scene3d, for a variant's pane.
 * - `sceneOf(name, frame)`: a promise of `{ ok, scene, tree }` for the
 *   variant `name`, at step `frame` of its run or as it is drawn.
 * - `look()`: what every pane wears, as the view does -- `{ hidden, fades,
 *   colouring, selected, axes, flow }`.
 * - `onPick(detail)`: an object clicked in a pane, as the view reports one.
 * - `onScenes(drawn)`: every variant pane's `{ scene, tree }`, once a round
 *   is drawn: for a colour scale and a legend over all of them.
 * - `onLayout(split, names)`: the panes laid out again; `split`, whether
 *   there is more than the view, and `names` the variants with a pane.
 * - `stepNow()`: the step of the run the view shows, or null for its own.
 */
export function createGrid(el, options) {
  const {
    view,
    mainApi,
    factory,
    sceneOf,
    look,
    onPick,
    onScenes,
    onLayout,
    stepNow,
  } = options;
  el.classList.add("magpy-panes");
  /** The scene's own pane. */
  const scenePane = makePane(null);
  scenePane.body.append(view);
  // alone, as the view always was: laid out, and the host told, at a split
  scenePane.tag.hidden = true;
  el.append(scenePane.el);
  /** The layout: a pane, or `{ dir, children, sizes }` -- `dir` "row" or
   *  "column", `sizes` the share of each child, summing to 1. */
  let tree = scenePane;
  let round = 0; // the round of drawing on its way; a newer one stops it
  let step = null; // the step of the run shown, or null for the scene's own
  let current = null; // the variant the scene is at, if any
  let turning = false; // a camera passed on: the others say nothing back
  let refit = false; // the panes framed together once the new one is drawn

  function makePane(name) {
    const pane = document.createElement("div");
    pane.className = "magpy-pane";
    const body = document.createElement("div");
    body.className = "magpy-pane-body";
    const tag = document.createElement("div");
    tag.className = "magpy-pane-tag";
    const label = document.createElement("span");
    label.textContent = name ?? "scene";
    tag.append(label);
    pane.append(body, tag);
    const made = { name, el: pane, body, tag, label, api: null, drawn: false };
    if (name !== null) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "magpy-pane-close";
      close.textContent = "×";
      close.title = `Close ${name}`;
      close.addEventListener("click", () => remove(made));
      tag.append(close);
      made.api = factory();
      made.api.watchCamera(() => follow(made));
      body.addEventListener("objectpick", (event) => onPick(event.detail));
    }
    tag.title = "Drag to move it beside another";
    tag.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".magpy-pane-close"))
        return;
      if (panes().length > 1)
        carry(event, { pane: made, name: label.textContent });
    });
    return made;
  }

  const isPane = (node) => "el" in node;
  function panes(node = tree, into = []) {
    if (isPane(node)) into.push(node);
    else for (const child of node.children) panes(child, into);
    return into;
  }
  const variantPanes = () => panes().filter((pane) => pane.name !== null);

  /** `node`'s parent split and its place there, or null at the root. */
  function parentOf(node, at = tree) {
    if (isPane(at)) return null;
    const i = at.children.indexOf(node);
    if (i >= 0) return { split: at, i };
    for (const child of at.children) {
      const found = parentOf(node, child);
      if (found) return found;
    }
    return null;
  }

  /** `pane` put beside `target`, on its `side`: half of it. */
  function insert(pane, target, side) {
    const dir = side === "left" || side === "right" ? "row" : "column";
    const before = side === "left" || side === "top";
    const found = parentOf(target);
    if (found && found.split.dir === dir) {
      const { split, i } = found;
      const half = split.sizes[i] / 2;
      split.sizes[i] = half;
      split.children.splice(before ? i : i + 1, 0, pane);
      split.sizes.splice(before ? i : i + 1, 0, half);
    } else {
      const split = {
        dir,
        children: before ? [pane, target] : [target, pane],
        sizes: [0.5, 0.5],
      };
      if (found) found.split.children[found.i] = split;
      else tree = split;
    }
  }

  /** `pane` taken out of the layout, its share to its neighbours. */
  function detach(pane) {
    const found = parentOf(pane);
    if (!found) return;
    const { split, i } = found;
    const [share] = split.sizes.splice(i, 1);
    split.children.splice(i, 1);
    const left = split.sizes.reduce((a, b) => a + b, 0) || 1;
    split.sizes = split.sizes.map((size) => size + (share * size) / left);
    if (split.children.length === 1) {
      const [only] = split.children;
      const up = parentOf(split);
      if (up) up.split.children[up.i] = only;
      else tree = only;
    }
  }

  /** A variant's pane closed: it lets go of what it held on the renderer. */
  function remove(pane) {
    detach(pane);
    pane.api.watchCamera(null);
    pane.api.dispose();
    pane.el.remove();
    layout();
    drawn();
  }

  /** The variant `name` dropped on `side` of `target`: a pane for it. */
  function add(name, target, side) {
    if (panes().length >= MOST_PANES) return;
    const pane = makePane(name);
    refit ||= isPane(tree); // the view alone until now: it splits
    insert(pane, target, side);
    layout();
    step = stepNow(); // the step on screen now, whatever the last round drew
    redrawPanes([pane]);
  }

  // --- the layout ----------------------------------------------------------
  /** The tree as nested boxes, each pane's element moved -- never made
   *  again, so a pane keeps its canvas -- and a line between each two. */
  function layout() {
    const build = (node) => {
      if (isPane(node)) return node.el;
      const box = document.createElement("div");
      box.className = `magpy-split magpy-split-${node.dir}`;
      node.children.forEach((child, i) => {
        if (i > 0) box.append(sash(node, i));
        const part = build(child);
        part.style.flex = `${node.sizes[i]} 1 0`;
        box.append(part);
      });
      return box;
    };
    const root = build(tree);
    root.style.flex = "1 1 0";
    el.replaceChildren(root);
    const split = !isPane(tree);
    el.classList.toggle("magpy-panes-split", split);
    for (const pane of panes()) pane.tag.hidden = !split;
    onLayout(
      split,
      variantPanes().map((pane) => pane.name),
    );
    corners();
  }

  /** The line between `split`'s children `i - 1` and `i`, dragged to share
   *  the room between them out again. */
  function sash(split, i) {
    const line = document.createElement("div");
    line.className = "magpy-sash";
    line.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      line.setPointerCapture(event.pointerId);
      const row = split.dir === "row";
      const box = line.parentElement.getBoundingClientRect();
      const length = row ? box.width : box.height;
      const total = split.sizes[i - 1] + split.sizes[i];
      const before = split.sizes.slice(0, i - 1).reduce((a, b) => a + b, 0);
      const least = NARROWEST / length;
      const parts = [...line.parentElement.children].filter(
        (child) => !child.classList.contains("magpy-sash"),
      );
      const move = (e) => {
        const along = row ? e.clientX - box.left : e.clientY - box.top;
        const first = Math.min(
          Math.max(along / length - before, least),
          total - least,
        );
        split.sizes[i - 1] = first;
        split.sizes[i] = total - first;
        parts[i - 1].style.flex = `${first} 1 0`;
        parts[i].style.flex = `${total - first} 1 0`;
      };
      const ends = ["pointerup", "pointercancel", "lostpointercapture"];
      const up = () => {
        line.removeEventListener("pointermove", move);
        for (const end of ends) line.removeEventListener(end, up);
        corners();
      };
      line.addEventListener("pointermove", move);
      for (const end of ends) line.addEventListener(end, up);
    });
    return line;
  }

  /** The cube in the pane at the bottom right, the scale bar in the one under
   *  the middle of the bottom edge: where they stand in the single view. */
  function corners() {
    const all = panes();
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const bottom = box.bottom - parseFloat(style.paddingBottom) - 2;
    const right = box.right - parseFloat(style.paddingRight) - 2;
    const middle = (box.left + parseFloat(style.paddingLeft) + right) / 2;
    // the pane there, or the nearest -- the point may fall between two
    const under = (x, y) => {
      const off = (pane) => {
        const at = pane.el.getBoundingClientRect();
        const dx = Math.max(at.left - x, 0, x - at.right);
        const dy = Math.max(at.top - y, 0, y - at.bottom);
        return dx * dx + dy * dy;
      };
      return all.reduce((a, b) => (off(b) < off(a) ? b : a));
    };
    const cube = all.length > 1 ? under(right, bottom) : all[0];
    const bar = all.length > 1 ? under(middle, bottom) : all[0];
    for (const pane of all) {
      const api = pane === scenePane ? mainApi() : pane.api;
      api?.setCorner({ cube: pane === cube, bar: pane === bar });
    }
  }

  // --- carrying a chip or a pane -------------------------------------------
  /** Carry `what` -- `{ name }`, a variant's chip, or `{ pane, name }`, a
   *  pane by its tag -- from `event`, showing where it would land: half of
   *  the pane under the pointer, on the side the pointer is nearest. Let go,
   *  it lands there; Escape, or let go elsewhere, and nothing changes. */
  function carry(event, what) {
    event.preventDefault();
    const ghost = document.createElement("div");
    ghost.className = "magpy-pane-ghost";
    ghost.textContent = what.name;
    const mark = document.createElement("div");
    mark.className = "magpy-pane-drop";
    el.append(ghost, mark);
    let target = null;
    let side = null;
    const place = (e) => {
      const home = el.getBoundingClientRect();
      ghost.style.left = `${e.clientX - home.left + 12}px`;
      ghost.style.top = `${e.clientY - home.top + 12}px`;
      const full = !what.pane && panes().length >= MOST_PANES;
      const over = panes().find((pane) =>
        inside(pane.el, e.clientX, e.clientY),
      );
      target = over && over !== what.pane && !full ? over : null;
      mark.hidden = !target;
      ghost.classList.toggle("magpy-pane-refused", full);
      if (!target) return;
      const at = target.el.getBoundingClientRect();
      side = sideOf(at, e.clientX, e.clientY);
      let [left, top, width, height] = [at.left, at.top, at.width, at.height];
      if (side === "left" || side === "right") width /= 2;
      else height /= 2;
      if (side === "right") left += width;
      if (side === "bottom") top += height;
      Object.assign(mark.style, {
        left: `${left - home.left}px`,
        top: `${top - home.top}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
    };
    const done = () => {
      removeEventListener("pointermove", place, true);
      removeEventListener("pointerup", drop, true);
      removeEventListener("pointercancel", done, true);
      removeEventListener("keydown", escape, true);
      ghost.remove();
      mark.remove();
    };
    const drop = () => {
      done();
      if (!target) return;
      if (what.pane) {
        detach(what.pane);
        insert(what.pane, target, side);
        layout();
      } else add(what.name, target, side);
    };
    const escape = (e) => {
      if (e.key === "Escape") done();
    };
    place(event);
    addEventListener("pointermove", place, true);
    addEventListener("pointerup", drop, true);
    addEventListener("pointercancel", done, true);
    addEventListener("keydown", escape, true);
  }

  // --- what the panes draw -------------------------------------------------
  /** A pane turned: the others look from where it does. */
  function follow(moved) {
    if (turning) return;
    const api = moved === scenePane ? mainApi() : moved.api;
    const camera = api?.cameraState();
    if (!camera) return;
    turning = true;
    try {
      for (const pane of panes()) {
        if (pane === moved) continue;
        if (pane === scenePane) mainApi()?.setCamera(camera);
        else if (pane.drawn) pane.api.setCamera(camera);
      }
    } finally {
      turning = false;
    }
  }

  /** Every variant's pane drawn again, one by one: the scene changed, or
   *  the step. `own`, the scene's payload, stands in for the variant the
   *  scene is at, which needs no asking. */
  function redraw(own, at, now) {
    step = at;
    mark(now);
    round += 1;
    return redrawPanes(variantPanes(), own);
  }

  async function redrawPanes(which, own = null) {
    const mine = round;
    for (const pane of which) pane.el.classList.add("magpy-pane-busy");
    for (const pane of which) {
      if (mine !== round) return;
      if (step !== null && pane.drawn && pane.api.posed()) {
        pane.api.poseFrame(step); // a run that only moves, played here
        pane.el.classList.remove("magpy-pane-busy");
        continue;
      }
      let scene = own && pane.name === current ? own : null;
      // drawn from the scene's own payload: the scene's tree is the legend's
      if (scene) pane.tree = null;
      else {
        try {
          // a step is drawn over the scene: a pane new to the run draws
          // the variant's own first, which the legend and the bar read too
          if (step !== null && !pane.drawn) {
            const first = await sceneOf(pane.name, null);
            if (mine !== round) return;
            if (first?.ok && pane.el.isConnected) {
              pane.tree = first.tree;
              draw(pane, first.scene);
            }
          }
          const answer = await sceneOf(pane.name, step);
          if (mine !== round) return;
          scene = answer?.ok ? answer.scene : null;
          if (scene) pane.tree = answer.tree;
          // one the scene cannot use, now, says why, and counts for nothing
          pane.el.classList.toggle("magpy-pane-unusable", !answer?.ok);
          pane.el.title = answer?.ok ? "" : (answer?.error ?? "");
          if (!answer?.ok) pane.scene = pane.tree = null;
        } catch (error) {
          if (mine !== round) return;
          pane.el.title = error.message;
        }
      }
      try {
        if (scene && pane.el.isConnected) draw(pane, scene);
      } finally {
        pane.el.classList.remove("magpy-pane-busy");
      }
    }
    if (mine !== round) return;
    if (refit) fit();
    drawn();
  }

  /** Every pane framed alike: from where the one that needs it most stands,
   *  so that the largest fits its pane and the others are seen at its scale. */
  function fit() {
    refit = false;
    let best = null;
    let farthest = -1;
    const apis = panes()
      .map((pane) => (pane === scenePane ? mainApi() : pane.drawn && pane.api))
      .filter(Boolean);
    turning = true;
    try {
      for (const api of apis) {
        api.fitView();
        const state = api.cameraState();
        const reach =
          state.projection === "parallel"
            ? state.height / state.zoom
            : Math.hypot(...state.position.map((x, i) => x - state.target[i]));
        if (reach > farthest) [best, farthest] = [state, reach];
      }
      if (best) for (const api of apis) api.setCamera(best);
    } finally {
      turning = false;
    }
  }

  function drawn() {
    onScenes(
      variantPanes()
        .filter((pane) => pane.scene || pane.tree)
        .map(({ scene, tree: theirs }) => ({
          scene: scene ?? {},
          tree: theirs ?? [],
        })),
    );
  }

  /** `scene` in `pane`, wearing what the view wears, from the view's camera. */
  function draw(pane, scene) {
    const { api } = pane;
    const worn = look();
    if (scene.frame === undefined) pane.scene = scene; // what the bar reads
    api.setGizmoMode("none");
    api.setHidden(worn.hidden);
    api.setFades(worn.fades);
    api.setColorRanges(worn.colouring);
    api.setAxes(worn.axes);
    api.setFlow(worn.flow);
    turning = true;
    try {
      // a step of the run, over the scene drawn, as the view draws one
      if (scene.frame !== undefined && pane.drawn) api.renderFrame(scene);
      else api.render(pane.body, scene, { keepCamera: pane.drawn });
      const camera = mainApi()?.cameraState();
      if (camera) api.setCamera(camera);
    } finally {
      turning = false;
    }
    api.highlight(worn.selected);
    pane.drawn = true;
    corners();
  }

  /** What every pane wears, set again: a selection, a hiding, a fade, a cut
   *  of the colour scale, the axes. */
  function wear() {
    const worn = look();
    for (const { api, drawn: was } of variantPanes()) {
      if (!was) continue;
      api.setHidden(worn.hidden);
      api.setFades(worn.fades);
      api.setColorRanges(worn.colouring);
      api.highlight(worn.selected);
      api.setAxes(worn.axes);
      api.setFlow(worn.flow);
    }
    corners();
  }

  /** The variant the scene is at, said on the scene's own tag. */
  function mark(now) {
    current = now;
    scenePane.label.textContent = now ? `scene · ${now}` : "scene";
  }

  /** Back to the view alone: every variant's pane closed. */
  function hide() {
    round += 1;
    for (const pane of variantPanes()) {
      pane.api.watchCamera(null);
      pane.api.dispose();
      pane.el.remove();
    }
    tree = scenePane;
    layout();
  }

  /** Every variant of `names` beside the scene, laid out afresh as rows of
   *  panes near the view's shape: the scene first, then the variants in
   *  their order, as many as there is room for. A pane open already keeps
   *  its canvas and what it drew; only the new ones are drawn. */
  function fill(names) {
    const open = new Map(variantPanes().map((pane) => [pane.name, pane]));
    const wanted = [...names, ...open.keys()]
      .filter((name, i, all) => all.indexOf(name) === i)
      .slice(0, MOST_PANES - 1);
    for (const [name, pane] of open) {
      if (wanted.includes(name)) continue;
      pane.api.watchCamera(null);
      pane.api.dispose();
      pane.el.remove();
    }
    const made = [];
    const all = [
      scenePane,
      ...wanted.map((name) => {
        if (open.has(name)) return open.get(name);
        const pane = makePane(name);
        made.push(pane);
        return pane;
      }),
    ];
    const { cols } = shape(all.length);
    const rows = [];
    for (let i = 0; i < all.length; i += cols) {
      rows.push(all.slice(i, i + cols));
    }
    const line = (children, dir) =>
      children.length === 1
        ? children[0]
        : { dir, children, sizes: children.map(() => 1 / children.length) };
    tree = line(
      rows.map((row) => line(row, "row")),
      "column",
    );
    refit ||= made.length > 0;
    layout();
    step = stepNow();
    if (made.length) redrawPanes(made);
    else drawn();
  }

  /** The columns and rows `n` panes are laid out in: each pane as near the
   *  view's own shape as can be, few cells left empty in the last row. */
  function shape(n) {
    const { width, height } = el.getBoundingClientRect();
    const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
    let best = { cols: n, rows: 1, cost: Infinity };
    for (let cols = 1; cols <= n; cols += 1) {
      const rows = Math.ceil(n / cols);
      const cost =
        Math.abs(Math.log((aspect * rows) / cols)) + 0.3 * (rows * cols - n);
      if (cost < best.cost) best = { cols, rows, cost };
    }
    return best;
  }

  /** Close the panes of variants the scene no longer has. */
  function keep(names) {
    const known = new Set(names);
    const gone = variantPanes().filter((pane) => !known.has(pane.name));
    for (const pane of gone) {
      detach(pane);
      pane.api.watchCamera(null);
      pane.api.dispose();
      pane.el.remove();
    }
    if (gone.length) {
      layout();
      drawn();
    }
  }

  /** The scene's pane turned: the variants' look from where it does. */
  const followScene = () => follow(scenePane);

  return {
    carry,
    fit,
    mark,
    redraw,
    wear,
    hide,
    keep,
    fill,
    corners,
    followScene,
    get split() {
      return !isPane(tree);
    },
    /** The variants with a pane, in the layout's order. */
    get names() {
      return variantPanes().map((pane) => pane.name);
    },
  };
}
