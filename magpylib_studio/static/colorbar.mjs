/**
 * The view's colour bar: the field colours of one sensor -- the one
 * selected, else the first whose pixels the field colours -- as a slim bar
 * down the right edge: against the editing column, as a part of it, while
 * that is out, and alone where it is not. The least its pixels read at the
 * foot, the most at the top, both said in the card, above and below, and
 * the sensor and its field named along the bar -- "bore · |B|", clipped to
 * its height, whole in its tooltip -- so two sensors are never mistaken for
 * each other, and a long name stays in the card.
 *
 * Two handles, there while the pointer is, cut a range from it: the
 * sensor's colours stretch over the cut, and the field past either end
 * takes that end's colour, on its pixels and its field lines alike
 * (`setColorRanges` in scene3d.mjs). Drag a handle to move one end, the band
 * between them to move both, press the bar to bring the nearer handle there,
 * double-click it to take the cut away. Under the pointer the bar says the
 * range in force beside its ends, and the field where the pointer is.
 *
 * A component, as the legend is: what is cut is the widget's `color_range`,
 * which the bar is told (`sync`) and says what a drag would make it
 * (`onRange`, at every step and once settled). Where it stands is the
 * widget's to say (`placeColorBar`).
 */

/** How many stops of a table the bar's gradient is drawn with. */
const STOPS = 24;

/** The least a cut may span, as a share of the bar. */
const NARROWEST = 0.02;

/** How near an end a handle lands to be at it: no cut on that side. */
const AT_END = 0.005;

/** How far apart two values beside the bar are kept, in pixels. */
const LINE = 14;

function element(className, parent) {
  const el = document.createElement("div");
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

export function createColorBar(container, { onRange }) {
  container.classList.add("magpy-colorbar");
  container.hidden = true;
  const most = element("magpy-colorbar-end", container);
  const row = element("magpy-colorbar-row", container);
  const name = element("magpy-colorbar-name", row);
  const track = element("magpy-colorbar-track", row);
  const least = element("magpy-colorbar-end", container);
  const shadeHigh = element("magpy-colorbar-shade high", track);
  const shadeLow = element("magpy-colorbar-shade low", track);
  const band = element("magpy-colorbar-band", track);
  const high = element("magpy-colorbar-handle", track);
  const low = element("magpy-colorbar-handle", track);
  const highText = element("magpy-colorbar-label value", container);
  const lowText = element("magpy-colorbar-label value", container);
  const pointer = element("magpy-colorbar-label pointer", container);
  high.title =
    "Drag to cut the top of the range — double-click the bar to reset";
  low.title =
    "Drag to cut the foot of the range — double-click the bar to reset";

  let shown = null; // { id, scale, unit }
  let ranges = {}; // the widget's color_range
  let cut = null; // [from, to] for the sensor shown, while one is dragged
  let pointing = null; // the share of the bar the pointer rests at

  const span = () => shown.scale.levels;
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

  /** Show the sensor `payload` colours by the field, the selected one if
   *  that is one: its table drawn as the bar, it and its field named. Not
   *  one hidden, nor one whose pixels are hidden and whose lines are too, or
   *  not drawn: nothing on screen is in its colours. */
  function update({ payload, selected, units, hidden }) {
    const off = new Set(hidden ?? []);
    const lined = new Set(
      (payload?.fieldlines ?? []).map((item) => item.object_id),
    );
    const seen = ({ object_id: id }) =>
      !off.has(id) &&
      !(off.has(`${id}/pixels`) && (!lined.has(id) || off.has(`${id}/lines`)));
    const scaled = (payload?.pixels ?? []).filter(
      (item) => item.scale && seen(item),
    );
    const item =
      scaled.find((each) => (selected ?? []).includes(each.object_id)) ??
      scaled[0];
    container.hidden = !item;
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
    shown = { id: item.object_id, scale: item.scale, unit };
    name.textContent = `${item.name} · |${item.scale.source}|`;
    container.title = `${item.name}: |${item.scale.source}| in ${unit.symbol}, ${item.scale.scaling}`;
    paint();
  }

  /** Mirror the widget's `color_range`. */
  function sync(next) {
    ranges = next ?? {};
    paint();
  }

  /** The gradient as the pixels take it, the handles and the shading past
   *  them where the cut puts them -- at the ends where there is none -- and
   *  beside the bar, what is said: its name, the cut's ends, the pointer's
   *  field, kept a line apart. */
  function paint() {
    if (!shown) return;
    const [from, to] = cut ?? ranges[shown.id] ?? span();
    // the table stretched over the cut, each end's colour flat past it
    const { lut } = shown.scale;
    const stops = Array.from({ length: STOPS }, (_, i) => {
      const f = i / (STOPS - 1);
      const t = to > from ? (valueAt(f) - from) / (to - from) : 0.5;
      const colour =
        lut[Math.round(Math.min(Math.max(t, 0), 1) * (lut.length - 1))];
      return `${colour} ${(f * 100).toFixed(1)}%`;
    });
    track.style.background = `linear-gradient(to top, ${stops.join(", ")})`;
    const f = Math.min(Math.max(at(from), 0), 1);
    const t = Math.min(Math.max(at(to), 0), 1);
    low.style.bottom = `${f * 100}%`;
    high.style.bottom = `${t * 100}%`;
    shadeLow.style.height = `${f * 100}%`;
    shadeHigh.style.height = `${(1 - t) * 100}%`;
    band.style.bottom = `${f * 100}%`;
    band.style.height = `${(t - f) * 100}%`;
    most.textContent = said(span()[1], shown.unit);
    least.textContent = said(span()[0], shown.unit);
    highText.textContent = said(to, shown.unit);
    lowText.textContent = said(from, shown.unit);
    const top = track.offsetTop;
    const height = track.clientHeight || 1;
    const y = (share) => top + (1 - share) * height;
    highText.style.top = `${y(t)}px`;
    lowText.style.top = `${Math.max(y(f), y(t) + LINE)}px`;
    pointer.hidden = pointing === null;
    if (pointing !== null) {
      pointer.textContent = said(valueAt(pointing), shown.unit);
      pointer.style.top = `${y(pointing)}px`;
    }
    container.classList.toggle("cut", Boolean(ranges[shown.id] || cut));
  }

  /** Tell the widget of `next` for the sensor shown: a cut, or none. */
  function tell(next, settled) {
    const others = { ...ranges };
    delete others[shown.id];
    const whole = !next || (at(next[0]) <= AT_END && at(next[1]) >= 1 - AT_END);
    onRange(whole ? others : { ...others, [shown.id]: next }, { settled });
  }

  /** Drag `which` -- "low", "high" or "band" -- from a pointer press; the
   *  step it takes for a pointer, to take one at once. */
  function drag(which, event) {
    if (!shown || event.button !== 0) return null;
    event.preventDefault();
    event.stopPropagation();
    const start = ranges[shown.id] ?? span();
    const from = shareAt(event);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    container.classList.add("dragging");
    pointing = null;
    const move = (moved) => {
      const f = shareAt(moved);
      let [a, b] = start.map(at);
      if (which === "low") a = Math.min(f, b - NARROWEST);
      else if (which === "high") b = Math.max(f, a + NARROWEST);
      else {
        const shift = Math.min(Math.max(f - from, -a), 1 - b);
        a += shift;
        b += shift;
      }
      cut = [valueAt(Math.max(a, 0)), valueAt(Math.min(b, 1))];
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
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", release);
    target.addEventListener("pointercancel", release);
    return move;
  }

  low.addEventListener("pointerdown", (event) => drag("low", event));
  high.addEventListener("pointerdown", (event) => drag("high", event));
  band.addEventListener("pointerdown", (event) => drag("band", event));
  // A press on the bar past the cut brings the nearer handle there, and
  // drags it.
  for (const shade of [shadeLow, shadeHigh]) {
    shade.addEventListener("pointerdown", (event) => {
      if (!shown) return;
      const [from, to] = (ranges[shown.id] ?? span()).map(at);
      const f = shareAt(event);
      const which = Math.abs(f - from) <= Math.abs(f - to) ? "low" : "high";
      drag(which, event)?.(event);
    });
  }
  track.addEventListener("dblclick", () => {
    if (shown && ranges[shown.id]) tell(null, true);
  });
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

  return { update, sync, paint };
}
