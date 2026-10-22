/**
 * The view's colour bar: the field colours of one sensor -- the one
 * selected, else the first whose pixels the field colours -- as a slim bar
 * down the right edge: beside the editing column while that is out, and
 * alone where it is not. The least its pixels read at the foot, the most at
 * the top, both said above and below it, and the sensor and its field named
 * on it -- "bore · |B|", written along the bar, clipped to its height, whole
 * in its tooltip -- so what is said beside it stands right against it. With
 * more than one sensor coloured so, the arrows under the bar show the next
 * one's; or, with the switch beside them, those that can share a scale
 * (the same colormap and scaling) share one: one bar, "4 sensors · |B|",
 * colouring them all over what they read together, or the cut, alike, so
 * their colours compare however many there are. A pattern's copies of a
 * sensor are that sensor: one scale over all they read, always.
 *
 * Two handles, there while the pointer is, cut a range from it: the
 * sensor's colours stretch over the cut, and the field past either end
 * takes that end's colour, on its pixels and its field lines alike
 * (`setColorRanges` in scene3d.mjs). Drag a handle to move one end, the band
 * between them to move both, press the bar to bring the nearer handle there,
 * double-click it to take the cut away. The cut's ends are said beside its
 * handles while there is one, and the field under the pointer. Or say it: a
 * click on a value -- an end, or a cut's beside it -- takes a number typed,
 * in the scene's unit or with one of its own, which may reach past what the
 * sensor reads, to colour two scenes on one scale: the bar then reaches the
 * cut, its handle where its value is, and a mark in it, its value beside,
 * says where what the sensor reads ends. A handle takes the focus too:
 * arrows move it, a tenth of the bar with shift, Enter types its value.
 *
 * A picture of the view carries the bar (`drawOn`), as it carries the scale
 * bar: a field's colours without their scale say nothing.
 *
 * A component, as the legend is: what is cut is the widget's `color_range`,
 * which the bar is told (`sync`) and says what a drag would make it
 * (`onRange`, at every step and once settled). What each sensor is coloured
 * over, cut or shared, is the bar's to say (`colouring`), so the renderer
 * colours what the bar shows and nothing else. Where it stands is the
 * widget's to say (`placeColorBar`), and when it steps aside: while a step
 * of a run, in colours of its own, is on screen.
 */

/** How many stops of a table the bar's gradient is drawn with. */
const STOPS = 24;

/** The least a cut may span, as a share of the bar. */
const NARROWEST = 0.02;

/** How near an end a handle lands to be at it: no cut on that side. */
const AT_END = 0.005;

/** How far apart two values beside the bar are kept, in pixels. */
const LINE = 14;

/** How far a key moves a handle, as a share of the bar; with shift. */
const STEP = 0.01;
const BIG_STEP = 0.1;

/** What a field may be typed in, beside a bare number in the bar's unit:
 *  B's and J's units in tesla, H's and M's in A/m. */
const UNITS = {
  T: 1,
  mT: 1e-3,
  µT: 1e-6,
  μT: 1e-6,
  uT: 1e-6,
  nT: 1e-9,
  "A/m": 1,
  "kA/m": 1e3,
  "MA/m": 1e6,
};

function element(className, parent, tag = "div") {
  const el = document.createElement(tag);
  el.className = className;
  parent?.append(el);
  return el;
}

/** A number as the bar says it: three figures, in the unit the scene shows
 *  the field in, and in SI for H. */
function said(value, unit) {
  const shown = Number((value * unit.scale).toPrecision(3));
  return `${shown} ${unit.symbol}`;
}

/** Typed text as a field in SI: a number, in `unit` unless it says its own
 *  -- `100`, `100 mT`, `0.1 T`. Null for anything else. */
export function readField(text, unit) {
  const found =
    /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([A-Za-zµμ/]*)\s*$/.exec(
      text,
    );
  if (!found) return null;
  const number = Number(found[1]);
  if (!Number.isFinite(number)) return null;
  if (!found[2]) return number / unit.scale;
  const per = UNITS[found[2]];
  // a unit of the other field's kind is no answer: 5 A/m is not a B
  const tesla = unit.symbol.endsWith("T");
  if (per === undefined || found[2].endsWith("T") !== tesla) return null;
  return number * per;
}

/** What a sensor's table is: those that are one can share a scale. */
const tableKey = ({ scale }) =>
  `${scale.scaling}|${scale.source?.[0]}|${scale.lut.join()}`;

/** From the least to the most that `items` read, together. */
const reach = (items) => [
  Math.min(...items.map((each) => each.scale.levels[0])),
  Math.max(...items.map((each) => each.scale.levels[1])),
];

const CYCLE_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12.5 6.5A4.6 4.6 0 0 0 4 4.6"/><path d="M3.8 2.2v2.6h2.6"/>' +
  '<path d="M3.5 9.5A4.6 4.6 0 0 0 12 11.4"/><path d="M12.2 13.8v-2.6H9.6"/></svg>';

export function createColorBar(container, { onRange, onShare }) {
  container.classList.add("magpy-colorbar");
  container.hidden = true;
  const most = element("magpy-colorbar-end", container);
  const track = element("magpy-colorbar-track", container);
  const least = element("magpy-colorbar-end", container);
  // the next sensor's bar, where there is more than one: under the bar
  const cycle = element("magpy-colorbar-next", container, "button");
  cycle.type = "button";
  cycle.innerHTML = CYCLE_ICON;
  cycle.hidden = true;
  cycle.addEventListener("click", () => {
    if (!shown || shown.candidates.length < 2) return;
    chosen = shown.candidates[(shown.at + 1) % shown.candidates.length];
    update(asked);
  });
  // one scale for all the sensors that can share one: under it
  const share = element("magpy-colorbar-share", container, "button");
  share.type = "button";
  share.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M6.5 9.5 9.5 6.5"/><path d="M7 4.5 8.2 3.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8"/>' +
    '<path d="M9 11.5 7.8 12.7a2.5 2.5 0 0 1-3.5-3.5L5.5 8"/></svg>';
  share.hidden = true;
  let shareIds = []; // the sensors the switch would join, or part
  share.addEventListener("click", () => {
    if (!asked) return;
    // a fresh start for them, whichever way: their own scales, or the one
    const fresh = { ...ranges };
    for (const id of shareIds) delete fresh[id];
    onShare?.(!asked.shared, fresh);
  });
  const shadeHigh = element("magpy-colorbar-shade high", track);
  const shadeLow = element("magpy-colorbar-shade low", track);
  const band = element("magpy-colorbar-band", track);
  const name = element("magpy-colorbar-name", track);
  const high = element("magpy-colorbar-handle", track);
  const low = element("magpy-colorbar-handle", track);
  // where what the sensor reads ends, when the bar reaches past it
  const readMarks = [0, 1].map(() => element("magpy-colorbar-readmark", track));
  const readTexts = [0, 1].map(() =>
    element("magpy-colorbar-label read", container),
  );
  for (const text of readTexts) text.title = "What the sensor reads ends here";
  const highText = element("magpy-colorbar-label value", container);
  const lowText = element("magpy-colorbar-label value", container);
  const pointer = element("magpy-colorbar-label pointer", container);
  for (const [handle, end] of [
    [high, "top"],
    [low, "foot"],
  ]) {
    handle.tabIndex = 0;
    handle.setAttribute("role", "slider");
    handle.title =
      `Drag to cut the ${end} of the range, or arrows when focused (shift: ` +
      "more), Enter to type it — double-click the bar to reset";
  }
  for (const value of [most, least, highText, lowText]) {
    value.title = "Click to type a value";
  }

  let shown = null; // { id, ids, scale, levels, unit, name, candidates, at }
  let ranges = {}; // the widget's color_range
  let common = {}; // id -> the scale it shares, where it shares one: `colouring`
  let cut = null; // [from, to] for the sensor shown, while one is dragged
  let pointing = null; // the share of the bar the pointer rests at
  let asked = null; // the last update's arguments, to show the next sensor by
  let missed = false; // an update that came while a drag held the bar
  let chosen = null; // a sensor the arrows chose, until the selection moves
  let selectedWas = "";
  let typing = null; // the box a value is being typed in

  let frozen = null; // what the bar reaches, held while a handle is dragged
  /** What the sensor reads, from the least to the most. */
  const levels = () => shown.levels;
  /** What the bar reaches: what the sensor reads, and a cut past it, so a
   *  handle stands where its value is -- held while a drag goes, for the
   *  handle not to run from the pointer as the cut it makes moves. */
  const span = () => {
    if (frozen) return frozen;
    const [least, most] = levels();
    const [from, to] = ranges[shown.id] ?? [least, most];
    return [Math.min(least, from), Math.max(most, to)];
  };
  const currentCut = () => cut ?? ranges[shown.id] ?? levels();
  /** Where `value` sits on the bar, 0 at the foot and 1 at the top. */
  const at = (value) => {
    const [least, most] = span();
    return most > least ? (value - least) / (most - least) : 0.5;
  };
  /** The value at a share `f` of the bar. */
  const valueAt = (f) => {
    const [least, most] = span();
    return least + Math.min(Math.max(f, 0), 1) * (most - least);
  };
  /** The share of the bar at a pointer's height. */
  const shareAt = (event) => {
    const box = track.getBoundingClientRect();
    return 1 - (event.clientY - box.top) / box.height;
  };

  /** Show the sensor `payload` colours by the field: the one the arrows
   *  chose, else the selected one if that is one, else the first -- its
   *  table drawn as the bar, it and its field named. Not one hidden, nor
   *  one whose pixels are hidden and whose lines are too, or not drawn:
   *  nothing on screen is in its colours. None while the widget says the
   *  bar steps `aside`. */
  function update(args) {
    asked = args;
    // a drag holds the bar it began with; what came meanwhile, at its end
    if (frozen) {
      missed = true;
      return;
    }
    const { payload, selected, units, hidden } = args;
    const off = new Set(hidden ?? []);
    const lined = new Set(
      (payload?.fieldlines ?? []).map((item) => item.object_id),
    );
    const seen = ({ object_id: id }) =>
      !off.has(id) &&
      !(off.has(`${id}/pixels`) && (!lined.has(id) || off.has(`${id}/lines`)));
    // one each: a pattern's copies come under their source's id, and are it
    const sensors = new Map();
    const copied = new Set();
    for (const each of payload?.pixels ?? []) {
      if (!each.scale || !seen(each)) continue;
      const known = sensors.get(each.object_id);
      if (known) copied.add(each.object_id);
      sensors.set(
        each.object_id,
        known
          ? {
              ...known,
              scale: { ...known.scale, levels: reach([known, each]) },
            }
          : each,
      );
    }
    const scaled = [...sensors.values()];
    const picked = (selected ?? []).join();
    if (picked !== selectedWas) chosen = null; // the selection moved: it decides
    selectedWas = picked;
    // the sensors that can share a scale, by their table
    const groups = new Map();
    for (const each of scaled) {
      const key = tableKey(each);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(each);
    }
    // the scales shared, for `colouring`: a group's, one scale for all, or
    // a sensor's own over all its copies read
    common = {};
    for (const group of groups.values()) {
      const together = Boolean(args.shared) && group.length > 1;
      const theirs = reach(group);
      for (const each of group) {
        if (together) common[each.object_id] = theirs;
        else if (copied.has(each.object_id))
          common[each.object_id] = each.scale.levels;
      }
    }
    const item =
      scaled.find((each) => each.object_id === chosen) ??
      scaled.find((each) => (selected ?? []).includes(each.object_id)) ??
      scaled[0];
    container.hidden = !item || Boolean(args.aside);
    if (!item) {
      shown = null;
      return;
    }
    const field = item.scale.source?.[0] ?? "B";
    // B and J in the scene's field unit; H and M are not, and stay in A/m
    const unit =
      field === "B" || field === "J"
        ? (units?.field ?? { symbol: "T", scale: 1 })
        : { symbol: "A/m", scale: 1 };
    // One scale for all: the bar is the group's, what they read together,
    // and its cut theirs. A group of one is a sensor alone, as without.
    const mates = groups.get(tableKey(item));
    const together = Boolean(args.shared) && mates.length > 1;
    const members = together ? mates : [item];
    const quantity = `|${item.scale.source}|`;
    // the arrows go on to the next sensor, or, sharing, the next group
    const candidates = args.shared
      ? [...groups.values()].map((group) => group[0].object_id)
      : scaled.map((each) => each.object_id);
    shown = {
      id: item.object_id,
      ids: members.map((each) => each.object_id),
      scale: item.scale,
      levels: reach(members),
      unit,
      name: together
        ? `${members.length} sensors · ${quantity}`
        : `${item.name} · ${quantity}`,
      candidates,
      // the one shown among them: its group's, sharing, whichever is shown
      at: args.shared
        ? [...groups.values()].indexOf(mates)
        : candidates.indexOf(item.object_id),
    };
    name.textContent = shown.name;
    const more = candidates.length > 1;
    cycle.hidden = !more;
    cycle.title = `The next sensor's colours (${shown.at + 1} of ${candidates.length})`;
    container.title =
      `${together ? members.map((each) => each.name).join(", ") : item.name}: ` +
      `${quantity} in ${unit.symbol}, ${item.scale.scaling}`;
    // the switch, where a scale can be shared at all
    share.hidden = mates.length < 2;
    share.classList.toggle("on", together);
    share.setAttribute("aria-pressed", String(together));
    share.title = together
      ? "One scale for all — click for each sensor its own"
      : `One scale for the ${mates.length} sensors with this colormap, for their colours to compare`;
    shareIds = mates.map((each) => each.object_id);
    paint();
  }

  /** Mirror the widget's `color_range`. */
  function sync(given) {
    ranges = given ?? {};
    paint();
  }

  /** What each sensor is coloured over, for the renderer, by id: its cut
   *  in `cuts`, else the scale it shares -- with the sensors on its table,
   *  the switch on, or with its pattern's copies -- else none: its own. Of
   *  the sensors on screen, so the colours are the bar's. */
  const colouring = (cuts) => ({ ...common, ...cuts });

  /** The gradient as the pixels take it, the handles and the hatching past
   *  them where the cut puts them -- at the ends where there is none --
   *  and beside the bar, right against it, what is said: the cut's ends,
   *  the pointer's field, kept a line apart. */
  function paint() {
    if (!shown) return;
    const [from, to] = currentCut();
    track.style.background = gradient(from, to, "to top");
    const f = Math.min(Math.max(at(from), 0), 1);
    const t = Math.min(Math.max(at(to), 0), 1);
    low.style.bottom = `${f * 100}%`;
    high.style.bottom = `${t * 100}%`;
    shadeLow.style.height = `${f * 100}%`;
    shadeHigh.style.height = `${(1 - t) * 100}%`;
    band.style.bottom = `${f * 100}%`;
    band.style.height = `${(t - f) * 100}%`;
    for (const [handle, value] of [
      [high, to],
      [low, from],
    ]) {
      handle.setAttribute("aria-valuetext", said(value, shown.unit));
    }
    if (typing?.parentElement !== most)
      most.textContent = said(span()[1], shown.unit);
    if (typing?.parentElement !== least)
      least.textContent = said(span()[0], shown.unit);
    if (typing?.parentElement !== highText)
      highText.textContent = said(to, shown.unit);
    if (typing?.parentElement !== lowText)
      lowText.textContent = said(from, shown.unit);
    const top = track.offsetTop;
    const height = track.clientHeight || 1;
    name.style.maxWidth = `${Math.max(height - 8, 0)}px`; // turned: its length
    const y = (share) => top + (1 - share) * height;
    // from the bar's own edge, not the card's, which the ends make wider
    const beside = `${container.clientWidth - track.offsetLeft + 3}px`;
    for (const label of [highText, lowText, pointer])
      label.style.right = beside;
    // an end that is cut, only: one at the bar's end is said there already
    highText.hidden =
      Math.abs(at(to) - 1) <= AT_END && typing?.parentElement !== highText;
    lowText.hidden =
      Math.abs(at(from)) <= AT_END && typing?.parentElement !== lowText;
    highText.style.top = `${y(t)}px`;
    lowText.style.top = `${Math.max(y(f), y(t) + LINE)}px`;
    levels().forEach((value, i) => {
      const share = at(value);
      const inside = share > AT_END && share < 1 - AT_END;
      readMarks[i].hidden = readTexts[i].hidden = !inside;
      if (!inside) return;
      readMarks[i].style.bottom = `${share * 100}%`;
      readTexts[i].textContent = said(value, shown.unit);
      readTexts[i].style.right = beside;
      readTexts[i].style.top = `${y(share)}px`;
    });
    pointer.hidden = pointing === null;
    if (pointing !== null) {
      pointer.textContent = said(valueAt(pointing), shown.unit);
      pointer.style.top = `${y(pointing)}px`;
    }
    container.classList.toggle("cut", Boolean(ranges[shown.id] || cut));
  }

  /** The colour at a share `f` of the bar for a cut `from`..`to`: the table
   *  stretched over the cut, each end's colour flat past it. */
  function colourAt(f, from, to) {
    const { lut } = shown.scale;
    const t = to > from ? (valueAt(f) - from) / (to - from) : 0.5;
    return lut[Math.round(Math.min(Math.max(t, 0), 1) * (lut.length - 1))];
  }

  /** The colours along the bar for a cut `from`..`to`, as a CSS gradient
   *  toward `way`. */
  function gradient(from, to, way) {
    const stops = Array.from({ length: STOPS }, (_, i) => {
      const f = i / (STOPS - 1);
      return `${colourAt(f, from, to)} ${(f * 100).toFixed(1)}%`;
    });
    return `linear-gradient(${way}, ${stops.join(", ")})`;
  }

  /** Tell the widget of `next` for the sensor shown: a cut, or none -- none
   *  where it is the whole of what the sensor reads. */
  function tell(next, settled) {
    const others = { ...ranges };
    for (const id of shown.ids) delete others[id];
    const [least, most] = levels();
    const near = (a, b) => Math.abs(a - b) <= AT_END * (most - least);
    const whole = !next || (near(next[0], least) && near(next[1], most));
    // one cut for all that share the scale; none, the scale they share
    const cuts = Object.fromEntries(shown.ids.map((id) => [id, next]));
    onRange(whole ? others : { ...others, ...cuts }, { settled });
  }

  /** Drag `which` -- "low", "high" or "band" -- from a pointer press; the
   *  step it takes for a pointer, to take one at once. */
  function drag(which, event) {
    if (!shown || event.button !== 0) return null;
    event.preventDefault();
    event.stopPropagation();
    frozen = span();
    const start = currentCut();
    const from = shareAt(event);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    container.classList.add("dragging");
    pointing = null;
    const move = (moved) => {
      const f = shareAt(moved);
      const [a, b] = start.map(at);
      // the end moved follows; the other stays, though typed past the bar
      if (which === "low")
        cut = [valueAt(Math.min(f, b - NARROWEST)), start[1]];
      else if (which === "high") {
        cut = [start[0], valueAt(Math.max(f, a + NARROWEST))];
      } else {
        const shift = Math.min(Math.max(f - from, -a), 1 - b);
        cut = [valueAt(a + shift), valueAt(b + shift)];
      }
      paint();
      tell(cut, false);
    };
    const release = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", release);
      target.removeEventListener("pointercancel", release);
      container.classList.remove("dragging");
      if (cut) tell(cut, true);
      cut = null;
      frozen = null;
      // the bar reaching the cut, as it settled -- on what came meanwhile
      if (missed) {
        missed = false;
        update(asked);
      } else paint();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", release);
    target.addEventListener("pointercancel", release);
    return move;
  }

  /** Set one end of the cut, `"low"` or `"high"`, to `value`, settled: kept
   *  the narrowest cut away from the other end. */
  function setEnd(which, value) {
    const [from, to] = currentCut();
    const gap = NARROWEST * (levels()[1] - levels()[0]);
    const next =
      which === "low"
        ? [Math.min(value, to - gap), to]
        : [from, Math.max(value, from + gap)];
    tell(next, true);
  }

  /** Type a value in place of `el`'s: Enter sets `which` end to it, Escape
   *  or a click away leaves it as it was. */
  function typeInto(el, which) {
    if (!shown || typing) return;
    const [from, to] = currentCut();
    const box = element("magpy-colorbar-input", null, "input");
    box.type = "text";
    const was = said(which === "low" ? from : to, shown.unit);
    box.value = was;
    box.setAttribute(
      "aria-label",
      `the ${which === "low" ? "foot" : "top"} of the colour range`,
    );
    typing = box;
    el.classList.add("typing");
    el.replaceChildren(box);
    box.focus();
    box.select();
    const done = (value) => {
      if (typing !== box) return;
      typing = null;
      el.classList.remove("typing");
      if (value !== null) setEnd(which, value);
      paint();
    };
    box.addEventListener("keydown", (event) => {
      event.stopPropagation(); // typed, not the view's keys
      if (event.key === "Escape") done(null);
      if (event.key !== "Enter") return;
      // as it was said: no cut at its rounding
      if (box.value.trim() === was) {
        done(null);
        return;
      }
      const value = readField(box.value, shown.unit);
      if (value === null) {
        box.setCustomValidity(
          `not a field in ${shown.unit.symbol}: ${box.value}`,
        );
        box.reportValidity();
        return;
      }
      done(value);
    });
    box.addEventListener("input", () => box.setCustomValidity(""));
    box.addEventListener("blur", () => done(null));
  }

  /** A press on the bar past the cut brings the nearer handle there, and
   *  drags it. */
  function press(event) {
    if (!shown) return;
    const [from, to] = currentCut().map(at);
    const f = shareAt(event);
    const which = Math.abs(f - from) <= Math.abs(f - to) ? "low" : "high";
    drag(which, event)?.(event);
  }
  low.addEventListener("pointerdown", (event) => drag("low", event));
  high.addEventListener("pointerdown", (event) => drag("high", event));
  for (const shade of [shadeLow, shadeHigh]) {
    shade.addEventListener("pointerdown", press);
  }
  // the band moves both ends -- but uncut it is the whole bar, with nothing
  // to move, and a press on it is one on the bar
  band.addEventListener("pointerdown", (event) => {
    if (!shown) return;
    const [from, to] = currentCut().map(at);
    if (from <= AT_END && to >= 1 - AT_END) press(event);
    else drag("band", event);
  });
  track.addEventListener("dblclick", () => {
    if (shown && ranges[shown.id]) tell(null, true);
  });
  // a value said is one to type
  most.addEventListener("click", () => typeInto(most, "high"));
  least.addEventListener("click", () => typeInto(least, "low"));
  highText.addEventListener("click", () => typeInto(highText, "high"));
  lowText.addEventListener("click", () => typeInto(lowText, "low"));
  // the keys, on a handle that has the focus
  for (const [handle, which] of [
    [high, "high"],
    [low, "low"],
  ]) {
    handle.addEventListener("keydown", (event) => {
      if (!shown) return;
      const step =
        (event.shiftKey ? BIG_STEP : STEP) * (levels()[1] - levels()[0]);
      const [from, to] = currentCut();
      const now = which === "low" ? from : to;
      const moves = {
        ArrowUp: step,
        ArrowRight: step,
        ArrowDown: -step,
        ArrowLeft: -step,
      };
      if (event.key in moves) setEnd(which, now + moves[event.key]);
      else if (event.key === "Enter") {
        // its value beside it, or the end's where it stands at the end
        const beside = which === "low" ? lowText : highText;
        typeInto(
          beside.hidden ? (which === "low" ? least : most) : beside,
          which,
        );
      } else if (event.key === "Escape") handle.blur();
      else return;
      event.preventDefault();
      event.stopPropagation(); // the bar's, not the view's
    });
  }
  // the field where the pointer rests
  track.addEventListener("pointermove", (event) => {
    if (!shown || container.classList.contains("dragging")) return;
    pointing = Math.min(Math.max(shareAt(event), 0), 1);
    paint();
  });
  track.addEventListener("pointerleave", () => {
    pointing = null;
    paint();
  });
  // the bar's own, not the view's: no orbit, no pick
  container.addEventListener("pointerdown", (event) => event.stopPropagation());
  container.addEventListener("click", (event) => event.stopPropagation());

  /** `picture`, a PNG data URL of the view `width` CSS pixels wide, with the
   *  bar drawn on it at its right edge, as it is in force -- its gradient,
   *  hatching, ends, cut and name. The picture itself where there is no
   *  bar. */
  async function drawOn(picture, width) {
    if (!shown || container.hidden) return picture;
    const image = new Image();
    image.src = picture;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const k = image.width / (width || image.width); // device pixels per CSS pixel
    const style = getComputedStyle(container);
    const ink = style.color;
    const paper =
      style.getPropertyValue("--vscode-editor-background").trim() || "#ffffff";
    const font = `${9.5 * k}px ${style.fontFamily || "sans-serif"}`;
    const H = image.height / k; // in CSS pixels, then scaled
    const barH = Math.min(240, H - 120);
    if (barH < 40) return picture;
    const x = image.width - 30 * k; // the bar's left edge
    const top = ((H - barH) / 2) * k;
    const w = 13 * k;
    const h = barH * k;
    const [from, to] = currentCut();
    // the gradient, as on screen, then the hatching past the cut
    const fill = ctx.createLinearGradient(0, top + h, 0, top);
    for (let i = 0; i < STOPS; i++) {
      const f = i / (STOPS - 1);
      fill.addColorStop(f, colourAt(f, from, to));
    }
    const rounded = (path) => {
      path.beginPath();
      path.roundRect(x, top, w, h, 4 * k);
    };
    ctx.save();
    rounded(ctx);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.clip();
    const fAt = Math.min(Math.max(at(from), 0), 1);
    const tAt = Math.min(Math.max(at(to), 0), 1);
    ctx.strokeStyle = paper;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = k;
    for (const [y0, y1] of [
      [top, top + (1 - tAt) * h],
      [top + (1 - fAt) * h, top + h],
    ]) {
      if (y1 - y0 < 0.5 * k) continue; // no cut on that side
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y0, w, y1 - y0); // the lines within that stretch alone
      ctx.clip();
      for (let d = y0 - w; d < y1; d += 4 * k) {
        ctx.beginPath();
        ctx.moveTo(x, d + w);
        ctx.lineTo(x + w, d);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
    ctx.save();
    rounded(ctx);
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = k;
    ctx.stroke();
    ctx.restore();
    // the words, under a halo of the page's colour
    const write = (text, cx, cy, align = "center", angle = 0, face = font) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.font = face;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3 * k;
      ctx.strokeStyle = paper;
      ctx.lineJoin = "round";
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = ink;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    write(said(span()[1], shown.unit), x + w / 2, top - 8 * k);
    write(said(span()[0], shown.unit), x + w / 2, top + h + 8 * k);
    // the cut's ends beside the bar, as on screen: an end that is cut, only
    const ty = top + (1 - tAt) * h;
    if (Math.abs(at(to) - 1) > AT_END)
      write(said(to, shown.unit), x - 3 * k, ty, "right");
    if (Math.abs(at(from)) > AT_END) {
      const fy = Math.max(top + (1 - fAt) * h, ty + LINE * k);
      write(said(from, shown.unit), x - 3 * k, fy, "right");
    }
    // where what the sensor reads ends, when the bar reaches past it
    for (const value of levels()) {
      const share = at(value);
      if (share <= AT_END || share >= 1 - AT_END) continue;
      const my = top + (1 - share) * h;
      ctx.save();
      ctx.fillStyle = ink;
      ctx.fillRect(x - 2 * k, my - k / 2, w + 4 * k, k);
      ctx.restore();
      write(
        said(value, shown.unit),
        x - 3 * k,
        my,
        "right",
        0,
        `italic ${font}`,
      );
    }
    // the name on the bar, along it, clipped to its height as on screen:
    // white, under a dark halo, legible on either end of a colormap
    ctx.save();
    ctx.font = `${9 * k}px ${style.fontFamily || "sans-serif"}`;
    let label = shown.name;
    while (label.length > 1 && ctx.measureText(label).width > h - 8 * k) {
      label = label.slice(0, -2) + "…";
    }
    ctx.translate(x + w / 2, top + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
    ctx.shadowBlur = 3 * k;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, 0, 0);
    ctx.restore();
    return canvas.toDataURL("image/png");
  }

  return { update, sync, colouring, paint, drawOn };
}
