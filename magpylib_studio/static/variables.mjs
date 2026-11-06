/**
 * The scene's variables, as a panel any host can mount: a slider for a range,
 * a dropdown for options, a box that takes a typed value -- `15 mm`, `2 cm`,
 * or an expression -- and, moved, the whole scene following in milliseconds.
 * A scene with variants gets one more row above the others: a toggle per
 * variant, the one the values are in pressed, and pressing another sets them
 * as one step to undo -- or a dropdown, when there are too many to fit.
 *
 * The VS Code studio's Variables view and the notebook widget's panel are
 * this one module (docs/decisions.md#0019-the-editors-panels-are-the-widgets-and-a-host-mounts-them): the sidebar mounts it
 * in a webview with its calls going through the extension host, the widget
 * floats it over the view with its calls going to the session in the kernel.
 * The module knows neither. It is handed:
 *
 * - `rpc(method, params, { preview, since })`: the engine's answer, as a
 *   promise. `preview` marks a value the pointer is still on, which a host
 *   may treat more lightly than a settled edit; `since`, when the slider
 *   first moved past the value the view shows, for a host that says how
 *   long it has been kept waiting.
 * - `onPreview(answer)`: after a previewed value is answered, for a host
 *   that has to redraw itself -- the widget draws the scene the answer
 *   carries, or asks for it. Awaited inside the drag's pacing, so a redraw
 *   counts against the same frame.
 * - `actions`: `{ edit(name), remove(name) }`, what a host with dialogs of
 *   its own does about a variable beyond its value. A button is shown only
 *   for an action supplied; in a notebook the scene function is where a
 *   variable is added or renamed, and the widget supplies none.
 * - `empty`: what to say when the scene has no variables.
 * - `head`: an element for what the panel says about itself as a whole --
 *   the widget's dock gives its title line. There goes the one button that
 *   lets every taken-over variable decide again, and the rows carry no ↺
 *   of their own; without it, each taken-over row has its ↺.
 * - `compact`: the rows and nothing else, for a panel floating over a 3D
 *   view -- nothing over the view that cannot act. No expression help under
 *   the rows, no note of the hard limits under a slider that spans less
 *   (the name's tooltip says them), a choice as its dropdown alone, and a
 *   number with no range as its box alone. The sidebar has the room, and
 *   shows all of it.
 * - `variantsOnly`: the variants' row and nothing else, for a host that shows
 *   it apart from the rows -- the widget, along the foot of the view
 *   (docs/decisions.md#0050-a-saved-page-carries-its-variants). `fits(names)`
 *   says whether they are a toggle each there, or a dropdown. `variants`
 *   false is the rows without it, for that host's panel. `slide` makes the
 *   pressed toggle a handle: dragged sideways, each variant it passes is
 *   shown, as a slider's values are, and the one let go on is used.
 *   `onLift(name, event, chip)`, with `slide`: the pressed toggle lifted
 *   out of the row, up, before any slide -- the host's to carry from there
 *   (the widget drops it in the view as a pane of its own), and nothing
 *   used.
 *   `onSelect(name, add)`: a toggle clicked, for a host that keeps a
 *   selection of variants apart from the one the values are in -- `add` with
 *   Ctrl or Cmd held, the scene left as it is, and the toggle in or out of
 *   the selection; without, after the values are set to it, as a slide's
 *   release does too.
 *
 * And gives back `{ refresh(), help(), dragging() }`: read the rows again
 * (skipped while a thumb is held, and caught up at the release), load the
 * expression help, and whether a drag is in hand.
 *
 * Dragging a variable is a protocol, not a function: open an undo group, send
 * values while the pointer moves -- one per frame at most, newest wins --
 * commit the release once, and close the group after it, with a value still
 * held at the release flushed before the group closes. Every bug this panel
 * has had was in the order of those, which `harness/check-variable-drag.js`
 * holds it to.
 */

/** A value, short: 0.015 and not 0.015000000000000001. */
function short(value) {
  if (value === null || value === undefined) return "?";
  // A variable is not always a number: one constrained to options holds a
  // name ('z'), and rounding that used to throw on .toPrecision and take the
  // whole panel down with it.
  if (typeof value !== "number") return String(value);
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toPrecision(6)));
}

/** A value as the variable is shown: 0.015 is 15 for a length shown in mm.
 *  The document holds SI; `shown` says the unit and how many make one. */
function inUnit(v, value) {
  return short(
    typeof value === "number" && v.shown ? value * v.shown.scale : value,
  );
}

/** Variants few and short enough for a toggle each, one press to use; past
 *  that they would crowd the row, and a dropdown holds them instead. */
function asToggles(names) {
  return names.length <= 4 && names.join("").length <= 32;
}

/** What a variant sets, as the rows show each value: "n 8, gap 9 mm". */
function valuesOf(values, variables) {
  return Object.entries(values || {})
    .map(([name, value]) => {
      const v = variables.find((each) => each.name === name);
      if (!v) return null;
      const symbol = v.shown && v.shown.symbol ? " " + v.shown.symbol : "";
      return `${name} ${inUnit(v, value)}${symbol}`;
    })
    .filter(Boolean)
    .join(", ");
}

/** A number, then perhaps a unit and nothing else -- `15`, `15 mm`, `-90°` --
 *  which the engine reads (`quantity`), so the units live in one place. */
export const QUANTITY =
  /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*[A-Za-zµμ°]*\s*$/;

/** Typed text -> document value: a number if it is one, else "=expr". */
function asValue(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : "=" + trimmed;
}

/** What a variable is being overruled on, in as few words as it takes. */
function where(shadowed) {
  const first = `${shadowed[0].object_id}'s ${shadowed[0].field}`;
  return shadowed.length > 1
    ? `${first} (and ${shadowed.length - 1} more)`
    : first;
}

/** What ↺ will do about it: drop a later step, or put back an expression a
 *  value was written over in the create step (a resize, an aim) -- or both. */
function how(shadowed) {
  const undo = [];
  if (shadowed.some((s) => s.events)) {
    undo.push("dropping the step that states it outright");
  }
  if (shadowed.some((s) => "overridden" in s)) {
    undo.push("putting back the expression a value was written over");
  }
  return undo.join(" and ");
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function createVariables(
  container,
  {
    rpc,
    onPreview,
    actions = {},
    empty = "No variables.",
    compact = false,
    head = null,
    variantsOnly = false,
    variants: withVariants = true,
    fits = asToggles,
    slide = false,
    onLift = null,
    onSelect = null,
  } = {},
) {
  const withHelp = !compact && !variantsOnly;
  const ranges = !compact;
  // The scene's variants, when it has some: a dropdown above the variables
  // they set, saying which one the values are in now.
  const variantEl = element("div", "magpy-vars-variant");
  variantEl.hidden = true;
  const listEl = element("div", "magpy-vars-list");
  const emptyEl = element("div", "magpy-vars-empty", empty);
  emptyEl.hidden = true;
  const helpEl = element("details", "magpy-vars-help");
  helpEl.append(element("summary", "", "what can go in a value"));
  const helpBody = element("div", "magpy-vars-help-body");
  helpEl.append(helpBody);
  // Loaded when first opened, so a panel nobody opens asks for nothing.
  helpEl.addEventListener("toggle", () => {
    if (helpEl.open) help().catch(say);
  });
  const statusEl = element("div", "magpy-vars-status");
  container.append(
    variantEl,
    listEl,
    emptyEl,
    ...(withHelp ? [helpEl] : []),
    statusEl,
  );

  function say(what) {
    statusEl.textContent = what instanceof Error ? what.message : String(what);
  }

  // A rebuild replaces the slider element, so it must not happen while a
  // thumb is held: edits elsewhere broadcast back here, and the broadcast
  // is debounced, which is exactly long enough to land mid-drag.
  let dragging = false;
  let missedRefresh = false;

  function commitTyped(v, text) {
    // What was typed, committed: a number the engine reads in the variable's
    // unit, or anything else as an expression, as it always was.
    if (!QUANTITY.test(text)) {
      commit(v.name, asValue(text));
      return;
    }
    rpc("quantity", { name: v.name, text })
      .then((read) => {
        if (read && read.ok) commit(v.name, read.value);
        else say(read ? read.error : "");
      })
      .catch(say);
  }

  function commit(name, value) {
    say("");
    pendingValue = null; // a committed value supersedes anything still waiting
    return rpc("set_variable", { name, value })
      .then((res) => {
        if (res && res.ok === false) say(res.error);
        return load();
      })
      .catch(say);
  }

  /** Set the variables to a variant's values, as one step to undo. */
  function useVariant(name) {
    say("");
    return rpc("use_variant", { name })
      .then((res) => {
        if (res && res.ok === false) say(res.error);
        else if (res && res.ignored) {
          say(`${name} left out ${res.ignored.join(", ")}: no longer a value`);
        }
        return load();
      })
      .catch(say);
  }

  /** Which variant the values are in, and the way to another: a toggle each
   *  while they are few, one press to use, and a dropdown once they would
   *  crowd the row. Named, not stored: move a slider and the values are in
   *  none, so no toggle is pressed and the dropdown says so -- there is
   *  nothing to go back to by choosing that. */
  function showVariants(variants, current, variables, unusable = {}) {
    const names = Object.keys(variants || {});
    variantEl.hidden = names.length === 0;
    variantEl.innerHTML = "";
    if (!names.length) return;
    const label = element("span", "magpy-vars-name", "variant");
    label.title =
      "A variant is a set of values for the variables: choosing one sets " +
      "them all, as one step to undo";
    // A variant the scene cannot use as it stands -- a value its limits
    // refuse now -- is shown and not offered, and says why.
    const says = (name) =>
      unusable[name]
        ? `${name} cannot be used as the scene stands: ${unusable[name]}`
        : `${name}: ${valuesOf(variants[name], variables)}`;
    if (fits(names)) {
      const toggles = element("div", "magpy-vars-chips");
      toggles.classList.toggle("magpy-vars-slides", slide);
      const chips = [];
      for (const name of names) {
        const on = name === current;
        const chip = element("button", "magpy-vars-chip", name);
        chip.type = "button";
        chip.classList.toggle("on", on);
        chip.setAttribute("aria-pressed", String(on));
        chip.disabled = Boolean(unusable[name]);
        chip.title = says(name);
        // A press on a toggle that slides is the slide's, a click with no
        // move included; a click from the keyboard is not pressed at all.
        chip.addEventListener("click", (event) => {
          if (onSelect && adds(event)) {
            // a Ctrl-click on a Mac is a context menu, taken already
            if (event.timeStamp - menuAt > 500) onSelect(name, true);
            return;
          }
          if (!on && !(slide && event.detail > 0)) useVariant(name);
          onSelect?.(name, false);
        });
        if (onSelect) {
          chip.addEventListener("contextmenu", (event) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            menuAt = event.timeStamp;
            onSelect(name, true);
          });
        }
        const up = onLift ? ", or up into the view beside the scene" : "";
        if (slide && !chip.disabled) {
          chip.title = `${says(name)} -- drag sideways for the others${up}`;
          chip.addEventListener("pointerdown", (event) =>
            slideFrom(event, chips, names, unusable),
          );
        } else if (onLift && !chip.disabled) {
          // no slide here: a press only lifts, and a click still uses it
          chip.title = `${says(name)} -- drag it up into the view beside the scene`;
          chip.addEventListener("pointerdown", (event) =>
            liftFrom(event, chip, name),
          );
        }
        chips.push(chip);
        toggles.appendChild(chip);
      }
      variantEl.append(label, toggles);
      return;
    }
    const pick = element("select");
    const none = element("option", "", "—");
    none.value = "";
    none.disabled = true;
    none.selected = current == null;
    pick.appendChild(none);
    for (const name of names) {
      const item = element("option", "", name);
      item.value = name;
      item.selected = name === current;
      item.disabled = Boolean(unusable[name]);
      item.title = says(name);
      pick.appendChild(item);
    }
    pick.title =
      current == null
        ? "The values are in no variant: choose one to set them"
        : `The values are ${current}'s: choose another to set them`;
    pick.addEventListener("change", () => useVariant(pick.value));
    variantEl.append(label, pick);
  }

  /** A variant pressed and slid along the row -- any, not only the one the
   *  values are in, so a slide needs no click first: the one pressed and
   *  each one the pointer passes shown as a preview, one on the wire at a
   *  time and the newest waiting, and the one let go on used -- the whole
   *  slide one step to undo, as a slider's drag is. The toggles stay as they
   *  are until the release: `dragging` holds off the reads that would
   *  rebuild them. */
  let variantSent = Promise.resolve();
  let variantWaiting = null;
  let variantInFlight = false;

  function previewVariant(name) {
    variantWaiting = name;
    if (variantInFlight) return;
    variantInFlight = true;
    const next = variantWaiting;
    variantWaiting = null;
    variantSent = rpc("use_variant", { name: next }, { preview: true })
      .then((answer) => onPreview?.(answer))
      .catch(() => {}) // the release reports
      .then(() => {
        variantInFlight = false;
        if (variantWaiting) previewVariant(variantWaiting);
      });
  }

  /** A click that adds to the selection, or takes from it: Ctrl or Cmd held. */
  const adds = (event) => event.ctrlKey || event.metaKey;
  let menuAt = -Infinity; // when a Ctrl-click last came as a context menu

  /** The click a carried toggle's release would make on it, taken: a carry
   *  let go back over its row changes nothing. */
  function swallowClick(chip) {
    const swallow = (click) => {
      click.stopImmediatePropagation();
      click.preventDefault();
    };
    chip.addEventListener("click", swallow, { capture: true, once: true });
    addEventListener(
      "pointerup",
      () => setTimeout(() => chip.removeEventListener("click", swallow, true)),
      { capture: true, once: true },
    );
  }

  /** How far above its row a toggle is lifted, in CSS pixels, to be carried. */
  const LIFT = 14;

  /** A press on a toggle where nothing slides: lifted up out of the row, it
   *  is the host's to carry (`onLift`); let go where it was, it is a click. */
  function liftFrom(event, chip, name) {
    if (event.button !== 0 || (onSelect && adds(event))) return;
    const top = chip.getBoundingClientRect().top;
    const move = (e) => {
      if (e.clientY >= top - LIFT) return;
      done();
      swallowClick(chip); // let go back over it, it is no click on it
      onLift(name, e, chip);
    };
    const done = () => {
      removeEventListener("pointermove", move, true);
      removeEventListener("pointerup", done, true);
      removeEventListener("pointercancel", done, true);
    };
    addEventListener("pointermove", move, true);
    addEventListener("pointerup", done, true);
    addEventListener("pointercancel", done, true);
  }

  function slideFrom(event, chips, names, unusable) {
    if (event.button !== 0) return; // the main button, a finger or a pen
    if (onSelect && adds(event)) return; // a selection's click, not a slide
    event.preventDefault(); // no text selected along the way
    const start = chips.findIndex((chip) => chip.classList.contains("on"));
    let at = start;
    let slid = false; // past the toggle pressed: a slide, not a click
    dragging = true;
    const nearest = (x) => {
      let best = at;
      let gap = Infinity;
      chips.forEach((chip, i) => {
        // one out of the row -- its variant in a pane of the host's -- none
        if (unusable[names[i]] || !chip.getClientRects().length) return;
        const box = chip.getBoundingClientRect();
        const off = Math.abs(box.left + box.width / 2 - x);
        if (off < gap) [best, gap] = [i, off];
      });
      return best;
    };
    const press = (i) => {
      for (const [k, chip] of [
        [at, chips[at]],
        [i, chips[i]],
      ]) {
        if (!chip) continue; // none was pressed before
        chip.classList.toggle("on", k === i);
        chip.setAttribute("aria-pressed", String(k === i));
      }
      at = i;
    };
    // the one pressed shows pressed at once, and asks nothing until the
    // pointer leaves it: a click is one use, as a click on any toggle is
    press(nearest(event.clientX));
    const pressedAt = at;
    const move = (e) => {
      // lifted up out of the row before sliding: the host carries it
      if (!slid && onLift) {
        const box = chips[pressedAt].getBoundingClientRect();
        if (e.clientY < box.top - LIFT) {
          removeEventListener("pointermove", move, true);
          removeEventListener("pointerup", release, true);
          removeEventListener("pointercancel", release, true);
          press(start);
          dragging = false;
          // a refresh held off while the chip was pressed, caught up
          if (missedRefresh) {
            missedRefresh = false;
            load().catch(say);
          }
          // let go back over the chip, it is not a click on it as well
          swallowClick(chips[pressedAt]);
          onLift(names[pressedAt], e, chips[pressedAt]);
          return;
        }
      }
      const i = nearest(e.clientX);
      if (i === at) return;
      if (!slid) {
        slid = true;
        variantEl.classList.add("magpy-vars-sliding");
        rpc("begin_interaction").catch(() => {});
      }
      press(i);
      previewVariant(names[at]);
    };
    const release = async () => {
      removeEventListener("pointermove", move, true);
      removeEventListener("pointerup", release, true);
      removeEventListener("pointercancel", release, true);
      if (!slid) {
        dragging = false;
        if (pressedAt !== start) await useVariant(names[pressedAt]);
        return;
      }
      variantEl.classList.remove("magpy-vars-sliding");
      variantWaiting = null;
      await variantSent;
      if (at !== start) {
        say("");
        try {
          const res = await rpc("use_variant", { name: names[at] });
          if (res && res.ok === false) say(res.error);
          else onSelect?.(names[at], false);
        } catch (error) {
          say(error);
        }
      }
      await rpc("end_interaction").catch(() => {});
      dragging = false;
      missedRefresh = false;
      await load().catch(say);
    };
    addEventListener("pointermove", move, true);
    addEventListener("pointerup", release, true);
    addEventListener("pointercancel", release, true);
  }

  /** Let the variable decide again what a later step states outright. */
  function restore(name) {
    say("");
    return rpc("restore_variable", { name })
      .then((res) => {
        if (res && res.ok === false) say(res.error);
        return load();
      })
      .catch(say);
  }

  /** Let every taken-over variable decide again, as one step to undo. */
  function restoreAll(names) {
    say("");
    const each = names.reduce(
      (done, name) =>
        done.then(() =>
          rpc("restore_variable", { name }).then((res) => {
            if (res && res.ok === false) say(res.error);
          }),
        ),
      rpc("begin_interaction").catch(() => {}),
    );
    return each
      .then(() => rpc("end_interaction").catch(() => {}))
      .then(load)
      .catch(say);
  }

  /** Close the undo group after the release has been recorded.
   *
   * A range input fires `pointerup` *before* the `change` that commits its
   * value, so closing on pointerup would leave the value the user actually
   * chose outside the group and undoing as a step of its own. Deferring past
   * both puts it inside, and still closes for a click that changed nothing
   * and so never fired `change` at all.
   */
  function endInteractionSoon() {
    setTimeout(() => {
      // Whatever the frame gate or the round trip was still holding belongs
      // to the gesture that just ended, and goes now, past both: sent after
      // the group had closed it would undo as a step of its own.
      //
      // Only a drag that came back to where it started arrives here with
      // anything left: `change` runs before this and takes the final value
      // with it whenever the value moved. So what is waiting is the value
      // the slider began at, and the engine may be sitting on somewhere the
      // pointer passed through -- which is why it still has to be sent, and
      // why it is sent as a preview. Nothing needs marking as edited by a
      // gesture that put everything back, and the engine drops its own undo
      // entry for one.
      if (pendingValue) {
        const { name, value } = pendingValue;
        pendingValue = null;
        rpc("set_variable", { name, value }, { preview: true })
          .then((answer) => onPreview?.(answer))
          .catch(() => {});
      }
      rpc("end_interaction").catch(() => {});
    }, 0);
  }

  /** Set the variable while the slider is still moving.
   *
   * Everything written in terms of it follows, which is the whole point of
   * a variable and none of it is on this panel -- so a slider that only
   * spoke on release was asking the user to let go to see what they had
   * done.
   *
   * Held to whichever is slower, the round trip or a frame, with the newest
   * waiting value going out and the rest dropped -- they were places the
   * pointer passed through, not values anyone asked to see.
   *
   * A frame, because that is the fastest the screen can show anything: a
   * mouse reports at 125 Hz and plenty report faster, and a scene rebuilt
   * for a value that is overwritten before it can be drawn is work spent on
   * nothing. A round trip, because past that the scene is the limit and
   * there is nothing to be gained by asking again -- a variable that
   * reshapes a hundred magnets sends fewer sets instead of queueing up ones
   * the user has already dragged past. Neither is an interval chosen in
   * advance: on a small scene the frame decides, on a heavy one the rebuild
   * does, and the drag stays as smooth as that scene can be. A host that
   * redraws itself (`onPreview`) does so inside the same round trip.
   *
   * `load` is not called here on purpose: it would rebuild this panel, and
   * the slider under the pointer with it.
   */
  let liveInFlight = false; // a value is on the wire
  let frameSpent = false; // one has already gone out this frame
  let pendingValue = null;

  function preview(name, value) {
    // the newest value, waited on since the first one it replaced
    const since = pendingValue?.since ?? performance.now();
    pendingValue = { name, value, since };
    sendValue();
  }

  function sendValue() {
    if (liveInFlight || frameSpent || !pendingValue) return;
    liveInFlight = true;
    // Opened again on the next frame rather than on the reply, so a scene
    // that answers in less than a frame waits for the frame and one that
    // takes longer is never made to wait for the next: whichever is slower
    // decides, with no rounding up to frame boundaries in between.
    frameSpent = true;
    requestAnimationFrame(() => {
      frameSpent = false;
      sendValue();
    });
    const { name, value, since } = pendingValue;
    pendingValue = null;
    rpc("set_variable", { name, value }, { preview: true, since })
      .then((answer) => onPreview?.(answer))
      .catch(() => {
        // the release value reports; a refusal mid-drag is not worth saying
      })
      .then(() => {
        liveInFlight = false;
        sendValue();
      });
  }

  function button(glyph, title, onClick) {
    const el = element("button", "", glyph);
    el.type = "button";
    el.title = title;
    el.addEventListener("click", onClick);
    return el;
  }

  /** Read off the engine's own allow-list, so it cannot go stale. */
  let helpLoaded = false;
  async function help() {
    if (helpLoaded || !withHelp) return;
    const got = await rpc("expression_help", {});
    helpLoaded = true;
    helpBody.innerHTML = "";
    const list = element("dl");
    for (const [name, value] of [
      ["operators", got.operators.join(" ")],
      ["functions", got.functions.join(" ")],
      ["constants", got.constants.join(" ")],
      ["for example", got.examples.join("   ")],
    ]) {
      list.append(element("dt", "", name), element("dd", "", value));
    }
    const note = element("div", "magpy-vars-help-note", got.note);
    helpBody.append(list, note);
  }

  // One read at a time: a commit and the host's own refresh land together,
  // and two builds of the same rows is the second one wasted.
  let loading = false;
  let reloadDue = false;
  async function load() {
    if (dragging) {
      missedRefresh = true;
      return;
    }
    if (loading) {
      reloadDue = true;
      return;
    }
    loading = true;
    try {
      do {
        reloadDue = false;
        await build();
      } while (reloadDue && !dragging);
    } finally {
      loading = false;
    }
  }

  async function build() {
    const { variables, variants, variant, unusable } = await rpc(
      "get_variables",
      {},
    );
    if (withVariants) showVariants(variants, variant, variables, unusable);
    if (variantsOnly) return;
    listEl.innerHTML = "";
    emptyEl.hidden = variables.length > 0;
    for (const v of variables) {
      const row = element("div", "magpy-vars-row");

      const name = element("span", "magpy-vars-name", v.name);
      // What it measures, beside what it is called: the box holds 15, and
      // the 15 is millimetres. Not in the box, where it would be typed over.
      if (v.shown && v.shown.symbol) {
        name.append(" ", element("span", "magpy-vars-unit", v.shown.symbol));
      }
      // A variable can be perfectly well defined and decide nothing: a drag
      // states a pose outright and the expression that used to decide it
      // stays in the create step, replayed and then overwritten. The slider
      // still slides, and nothing moves. Better to say which it is than to
      // leave someone dragging a control that has quietly stopped being
      // connected.
      if (v.inert) {
        row.classList.add("magpy-vars-inert");
      }
      // The '=' is what makes it an expression, not merely being a string: a
      // variable constrained to options holds a *name* ("z"), and treating
      // that as an expression chopped its first character off and showed an
      // empty box where the value should be.
      const isExpression =
        typeof v.expression === "string" && v.expression.startsWith("=");
      const symbol = v.shown && v.shown.symbol ? " " + v.shown.symbol : "";
      name.title = isExpression
        ? v.name +
          " = " +
          v.expression.slice(1) +
          ", currently " +
          inUnit(v, v.value) +
          symbol
        : v.name + (symbol ? " (" + symbol.trim() + ")" : "");

      // Soft bounds win: they are the range worth dragging through. A
      // variable defined by an expression is not draggable - its value
      // belongs to the expression, not to the slider.
      const b = v.bounds || {};
      const choices =
        Array.isArray(b.options) && b.options.length ? b.options : null;
      const low = b.soft_min !== undefined ? b.soft_min : b.min;
      const high = b.soft_max !== undefined ? b.soft_max : b.max;
      const slidable =
        !isExpression && low !== undefined && high !== undefined && low < high;

      const text = element("input", "magpy-vars-value");
      text.type = "text";
      text.spellcheck = false;
      text.value = isExpression ? v.expression.slice(1) : inUnit(v, v.value);
      if (b.integer) name.title += " — whole numbers only";
      if (choices) {
        name.title += " — one of " + choices.join(", ");
      }
      // Appended like the qualifiers above rather than written over them:
      // what the variable is comes first, and what has stopped heeding it
      // after.
      if (v.inert) {
        // read by a branch out of the scene: what it waits for, and that a
        // value set now is what that branch will have
        const waits = (v.waits || [])
          .map((needs) =>
            Object.entries(needs)
              .map(([choice, value]) => `${choice} is ${value}`)
              .join(" and "),
          )
          .join(", or ");
        name.title += v.shadowed
          ? ` — nothing follows it any more: ${where(v.shadowed)} is stated` +
            ` outright, and ↺ gives it back by ${how(v.shadowed)}`
          : waits
            ? ` — read only when ${waits}: set now, it shows then`
            : " — nothing in the scene is written in terms of it yet";
      }
      if (isExpression) {
        text.classList.add("magpy-vars-expr");
        text.title = "currently " + inUnit(v, v.value) + symbol;
      }
      if (choices && !isExpression) {
        // The dropdown is the editor. Typing here would send 'z' through
        // asValue and store the expression "=z" instead of the name.
        text.readOnly = true;
        text.title = "one of " + choices.join(", ");
        // and over the view the dropdown says the value already
        text.hidden = compact;
      }
      text.addEventListener("change", () => commitTyped(v, text.value));

      const slot = element("div", "magpy-vars-slot");
      // A variable with options is a choice, not a quantity: an axis is 'z',
      // which is a name and not a small number. A dropdown is to options what
      // the slider is to a range, and the text box beside it would only let
      // you type something the engine is going to refuse.
      if (choices && !isExpression) {
        const pick = element("select");
        choices.forEach((option, index) => {
          const item = element("option", "", String(option));
          // the index, so the option's own type survives the round trip
          // through the DOM: 'z' has to stay the string 'z', and 8 the number 8
          item.value = String(index);
          item.selected = String(option) === String(v.value);
          pick.appendChild(item);
        });
        pick.title = "one of " + choices.join(", ");
        pick.addEventListener("change", () =>
          commit(v.name, choices[Number(pick.value)]),
        );
        slot.appendChild(pick);
      } else if (slidable) {
        const slider = element("input");
        slider.type = "range";
        slider.min = low;
        slider.max = high;
        // a count has no values between its values
        slider.step = b.integer ? 1 : (high - low) / 100;
        slider.value = v.value;
        slider.title = inUnit(v, low) + " .. " + inUnit(v, high) + symbol;
        // live scene while dragging, one edit in the history when released
        slider.addEventListener("pointerdown", () => {
          dragging = true;
          rpc("begin_interaction").catch(() => {}); // the whole drag undoes as one
        });
        slider.addEventListener("input", () => {
          text.value = inUnit(v, parseFloat(slider.value));
          // Only under the pointer: a keyboard step fires input and change
          // together, and would otherwise set the same value twice.
          if (dragging) preview(v.name, parseFloat(slider.value));
        });
        slider.addEventListener("change", () => {
          dragging = false;
          commit(v.name, parseFloat(slider.value));
        });
        slider.addEventListener("pointerup", () => {
          dragging = false;
          endInteractionSoon();
          if (missedRefresh) {
            missedRefresh = false;
            load().catch(say);
          }
        });
        slot.appendChild(slider);
      } else if (!isExpression) {
        // Nowhere to slide to: the box is the control. Said beside it where
        // there is room, and in the name's tooltip over the view.
        if (compact) {
          name.title += " — no range to slide; type a value";
        } else {
          const hint = element("span", "magpy-vars-hint", "no range");
          hint.title = "Give it a range to get a slider";
          slot.appendChild(hint);
        }
      }

      const acts = element("div", "magpy-vars-acts");
      // Everything about the variable except its value, which is the box
      // beside this: one button each, as the row is as wide as a sidebar and
      // the slider is what should have the space. Only what the host can do.
      if (v.shadowed && !head) {
        acts.append(
          button(
            "↺",
            `Let ${v.name} decide ${where(v.shadowed)} again, by ` +
              how(v.shadowed),
            () => restore(v.name),
          ),
        );
      }
      if (actions.edit) {
        acts.append(
          button("⋯", "Edit " + v.name + "…", () => actions.edit(v.name)),
        );
      }
      if (actions.remove) {
        acts.append(
          button("✕", "Remove " + v.name, () => actions.remove(v.name)),
        );
      }
      row.append(name, slot, text, acts);
      listEl.appendChild(row);

      // hard limits worth seeing when they differ from the slider's span:
      // a note under the row where there is room, else in the name's tooltip
      const hard = b.min !== undefined || b.max !== undefined;
      if (hard && (b.soft_min !== undefined || b.soft_max !== undefined)) {
        const allowed =
          "allowed " +
          (b.min === undefined ? "−∞" : inUnit(v, b.min)) +
          " .. " +
          (b.max === undefined ? "∞" : inUnit(v, b.max)) +
          symbol;
        if (ranges) {
          listEl.appendChild(element("div", "magpy-vars-range", allowed));
        } else {
          name.title += " — " + allowed;
        }
      }
    }
    // In the head, one restore for every taken-over variable, where the
    // host gave one: a mark per row has no column over the view.
    if (head) {
      head.replaceChildren();
      const taken = variables.filter((v) => v.shadowed);
      if (taken.length) {
        const names = taken.map((v) => v.name);
        const said =
          names.length > 1
            ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1]
            : names[0];
        const restoreAllButton = element(
          "button",
          "magpy-vars-restore",
          "↺ Restore",
        );
        restoreAllButton.type = "button";
        restoreAllButton.title =
          `Let ${said} decide again, by ` +
          how(taken.flatMap((v) => v.shadowed));
        restoreAllButton.addEventListener("click", () => restoreAll(names));
        head.appendChild(restoreAllButton);
      }
    }
  }

  return {
    /** Read the rows again. Not while a thumb is held: then at the release. */
    refresh: () => load().catch(say),
    help: () => help().catch(say),
    dragging: () => dragging,
    say,
  };
}
