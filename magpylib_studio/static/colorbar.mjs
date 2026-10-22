/**
 * The view's colour bar: the field colours of one sensor -- the one
 * selected, else the first whose pixels the field colours -- as a slim bar
 * down the right edge: beside the editing column while that is out, and
 * alone where it is not. The least its pixels read at the foot, the most at
 * the top, both said above and below it, and the sensor and its field named
 * on it -- "bore · |B|",
 * written along the bar, clipped to its height, whole in its tooltip -- so
 * what is said beside it stands right against it. With more than one sensor
 * coloured so, a click on the name shows the next one's.
 *
 * Two handles, there while the pointer is, cut a range from it: the
 * sensor's colours stretch over the cut, and the field past either end
 * takes that end's colour, on its pixels and its field lines alike
 * (`setColorRanges` in scene3d.mjs). Drag a handle to move one end, the band
 * between them to move both, press the bar to bring the nearer handle there,
 * double-click it to take the cut away. The cut's ends are said beside
 * its handles while there is one, and the field under the pointer. Or say
 * it: a click on a value -- an
 * end, or a handle's, beside it under the pointer -- takes a number typed,
 * in the scene's unit or with one of its own, which may reach past what the
 * sensor reads, to colour two scenes on one scale: the bar then reaches the
 * cut, its handle where its value is, and a mark in it, its value beside,
 * says where what the sensor reads ends. A handle takes the focus
 * too: arrows move it, a tenth of the bar with shift, Enter types its value.
 *
 * A picture of the view carries the bar (`drawOn`), as it carries the scale
 * bar: a field's colours without their scale say nothing.
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

export function createColorBar(container, { onRange }) {
  container.classList.add("magpy-colorbar");
  container.hidden = true;
  const most = element("magpy-colorbar-end", container);
  const track = element("magpy-colorbar-track", container);
  const least = element("magpy-colorbar-end", container);
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

  let shown = null; // { id, scale, unit, name, candidates }
  let ranges = {}; // the widget's color_range
  let cut = null; // [from, to] for the sensor shown, while one is dragged
  let pointing = null; // the share of the bar the pointer rests at
  let asked = null; // the last update's arguments, to show the next sensor by
  let chosen = null; // a sensor the name's click chose, until the selection moves
  let selectedWas = "";
  let typing = null; // the box a value is being typed in

  let frozen = null; // what the bar reaches, held while a handle is dragged
  /** What the sensor reads, from the least to the most. */
  const levels = () => shown.scale.levels;
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

  /** Show the sensor `payload` colours by the field: the one the name's
   *  click chose, else the selected one if that is one, else the first --
   *  its table drawn as the bar, it and its field named. Not one hidden, nor
   *  one whose pixels are hidden and whose lines are too, or not drawn:
   *  nothing on screen is in its colours. */
  function update(args) {
    asked = args;
    const { payload, selected, units, hidden } = args;
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
    const picked = (selected ?? []).join();
    if (picked !== selectedWas) chosen = null; // the selection moved: it decides
    selectedWas = picked;
    const item =
      scaled.find((each) => each.object_id === chosen) ??
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
    shown = {
      id: item.object_id,
      scale: item.scale,
      unit,
      name: `${item.name} · |${item.scale.source}|`,
      candidates: scaled.map((each) => each.object_id),
    };
    name.textContent = shown.name;
    const more = shown.candidates.length > 1;
    name.classList.toggle("more", more);
    container.title =
      `${item.name}: |${item.scale.source}| in ${unit.symbol}, ${item.scale.scaling}` +
      (more ? " — click the name for the next sensor's" : "");
    paint();
  }

  /** Mirror the widget's `color_range`. */
  function sync(next) {
    ranges = next ?? {};
    paint();
  }

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

  /** The colours along the bar for a cut `from`..`to`, as a CSS gradient
   *  toward `way`: the table stretched over the cut, each end's colour flat
   *  past it. */
  function gradient(from, to, way) {
    const { lut } = shown.scale;
    const stops = Array.from({ length: STOPS }, (_, i) => {
      const f = i / (STOPS - 1);
      const t = to > from ? (valueAt(f) - from) / (to - from) : 0.5;
      const colour =
        lut[Math.round(Math.min(Math.max(t, 0), 1) * (lut.length - 1))];
      return `${colour} ${(f * 100).toFixed(1)}%`;
    });
    return `linear-gradient(${way}, ${stops.join(", ")})`;
  }

  /** Tell the widget of `next` for the sensor shown: a cut, or none -- none
   *  where it is the whole of what the sensor reads. */
  function tell(next, settled) {
    const others = { ...ranges };
    delete others[shown.id];
    const [least, most] = levels();
    const near = (a, b) => Math.abs(a - b) <= AT_END * (most - least);
    const whole = !next || (near(next[0], least) && near(next[1], most));
    onRange(whole ? others : { ...others, [shown.id]: next }, { settled });
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
      paint(); // the bar reaching the cut, as it settled
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
    box.value = said(which === "low" ? from : to, shown.unit);
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

  low.addEventListener("pointerdown", (event) => drag("low", event));
  high.addEventListener("pointerdown", (event) => drag("high", event));
  band.addEventListener("pointerdown", (event) => drag("band", event));
  // A press on the bar past the cut brings the nearer handle there, and
  // drags it.
  for (const shade of [shadeLow, shadeHigh]) {
    shade.addEventListener("pointerdown", (event) => {
      if (!shown) return;
      const [from, to] = currentCut().map(at);
      const f = shareAt(event);
      const which = Math.abs(f - from) <= Math.abs(f - to) ? "low" : "high";
      drag(which, event)?.(event);
    });
  }
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
  // several sensors coloured by the field: the name shows the next one's
  name.addEventListener("click", () => {
    if (!shown || shown.candidates.length < 2) return;
    const at = shown.candidates.indexOf(shown.id);
    chosen = shown.candidates[(at + 1) % shown.candidates.length];
    update(asked);
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
    const { lut } = shown.scale;
    for (let i = 0; i < STOPS; i++) {
      const f = i / (STOPS - 1);
      const t = to > from ? (valueAt(f) - from) / (to - from) : 0.5;
      fill.addColorStop(
        f,
        lut[Math.round(Math.min(Math.max(t, 0), 1) * (lut.length - 1))],
      );
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

  return { update, sync, paint, drawOn };
}
