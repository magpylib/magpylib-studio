const vscodeApi = acquireVsCodeApi();
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
let nextReqId = 1;
const pending = new Map();
// A rebuild replaces the slider element, so it must not happen while a
// thumb is held: edits elsewhere broadcast back here, and the broadcast
// is debounced, which is exactly long enough to land mid-drag.
let dragging = false;
let missedRefresh = false;

/** `preview` marks a value the pointer is still on: the host keeps the views
 *  that show it live and leaves the bookkeeping until the release. */
function rpc(method, params, { preview = false } = {}) {
  return new Promise((resolve, reject) => {
    const reqId = nextReqId++;
    pending.set(reqId, { resolve, reject });
    vscodeApi.postMessage({ type: "rpcRequest", reqId, method, params, preview });
  });
}

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

/** Typed text -> document value: a number if it is one, else "=expr". */
function asValue(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : "=" + trimmed;
}

function commit(name, value) {
  statusEl.textContent = "";
  pendingValue = null; // a committed value supersedes anything still waiting
  rpc("set_variable", { name, value })
    .then((res) => {
      if (res && res.ok === false) statusEl.textContent = res.error;
      return load();
    })
    .catch((err) => {
      statusEl.textContent = String(err);
    });
}

/** Close the undo group after the release has been recorded.
 *
 * A range input fires `pointerup` *before* the `change` that commits its
 * value, so closing on pointerup would leave the value the user actually
 * chose outside the group and undoing as a step of its own. Deferring past
 * both puts it inside, and still closes for a click that changed nothing and
 * so never fired `change` at all.
 */
function endInteractionSoon() {
  setTimeout(() => {
    // Whatever the frame gate or the round trip was still holding belongs to
    // the gesture that just ended, and goes now, past both: sent after the
    // group had closed it would undo as a step of its own.
    //
    // Only a drag that came back to where it started arrives here with
    // anything left: `change` runs before this and takes the final value with
    // it whenever the value moved. So what is waiting is the value the slider
    // began at, and the engine may be sitting on somewhere the pointer passed
    // through -- which is why it still has to be sent, and why it is sent as
    // a preview. Nothing needs marking as edited by a gesture that put
    // everything back, and the engine drops its own undo entry for one.
    if (pendingValue) {
      const { name, value } = pendingValue;
      pendingValue = null;
      rpc("set_variable", { name, value }, { preview: true }).catch(() => {});
    }
    rpc("end_interaction").catch(() => {});
  }, 0);
}

/** Set the variable while the slider is still moving.
 *
 * Everything written in terms of it follows, which is the whole point of a
 * variable and none of it is on this panel -- so a slider that only spoke on
 * release was asking the user to let go to see what they had done.
 *
 * Held to whichever is slower, the round trip or a frame, with the newest
 * waiting value going out and the rest dropped -- they were places the
 * pointer passed through, not values anyone asked to see.
 *
 * A frame, because that is the fastest the screen can show anything: a mouse
 * reports at 125 Hz and plenty report faster, and a scene rebuilt for a value
 * that is overwritten before it can be drawn is work spent on nothing. A
 * round trip, because past that the scene is the limit and there is nothing
 * to be gained by asking again -- a variable that reshapes a hundred magnets
 * sends fewer sets instead of queueing up ones the user has already dragged
 * past. Neither is an interval chosen in advance: on a small scene the frame
 * decides, on a heavy one the rebuild does, and the drag stays as smooth as
 * that scene can be.
 *
 * `load` is not called here on purpose: it would rebuild this panel, and the
 * slider under the pointer with it.
 */
let liveInFlight = false; // a value is on the wire
let frameSpent = false; // one has already gone out this frame
let pendingValue = null;

function preview(name, value) {
  pendingValue = { name, value };
  sendValue();
}

function sendValue() {
  if (liveInFlight || frameSpent || !pendingValue) return;
  liveInFlight = true;
  // Opened again on the next frame rather than on the reply, so a scene that
  // answers in less than a frame waits for the frame and one that takes
  // longer is never made to wait for the next: whichever is slower decides,
  // with no rounding up to frame boundaries in between.
  frameSpent = true;
  requestAnimationFrame(() => {
    frameSpent = false;
    sendValue();
  });
  const { name, value } = pendingValue;
  pendingValue = null;
  rpc("set_variable", { name, value }, { preview: true })
    .catch(() => {
      // the release value reports; a refusal mid-drag is not worth saying
    })
    .then(() => {
      liveInFlight = false;
      sendValue();
    });
}

function button(glyph, title, action, name) {
  const el = document.createElement("button");
  el.textContent = glyph;
  el.title = title;
  el.addEventListener("click", () =>
    vscodeApi.postMessage({ type: "action", action, name }),
  );
  return el;
}

/** Read off the engine's own allow-list, so it cannot go stale. */
async function loadHelp() {
  const help = await rpc("expression_help", {});
  const body = document.getElementById("helpBody");
  body.innerHTML = "";
  const list = document.createElement("dl");
  for (const [name, value] of [
    ["operators", help.operators.join(" ")],
    ["functions", help.functions.join(" ")],
    ["constants", help.constants.join(" ")],
    ["for example", help.examples.join("   ")],
  ]) {
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
  const note = document.createElement("div");
  note.style.opacity = "0.7";
  note.style.marginTop = "6px";
  note.textContent = help.note;
  body.append(list, note);
}

async function load() {
  if (dragging) {
    missedRefresh = true;
    return;
  }
  const { variables } = await rpc("get_variables", {});
  listEl.innerHTML = "";
  emptyEl.hidden = variables.length > 0;
  for (const v of variables) {
    const row = document.createElement("div");
    row.className = "row";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = v.name;
    // The '=' is what makes it an expression, not merely being a string: a
    // variable constrained to options holds a *name* ("z"), and treating that
    // as an expression chopped its first character off and showed an empty
    // box where the value should be.
    const isExpression =
      typeof v.expression === "string" && v.expression.startsWith("=");
    name.title = isExpression
      ? v.name + " = " + v.expression.slice(1) + ", currently " + short(v.value)
      : v.name;

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

    const text = document.createElement("input");
    text.type = "text";
    text.spellcheck = false;
    text.value = isExpression ? v.expression.slice(1) : short(v.value);
    if (b.integer) name.title += " — whole numbers only";
    if (choices) {
      name.title += " — one of " + choices.join(", ");
    }
    if (isExpression) {
      text.classList.add("expr");
      text.title = "currently " + short(v.value);
    }
    if (choices && !isExpression) {
      // The dropdown is the editor. Typing here would send 'z' through
      // asValue and store the expression "=z" instead of the name.
      text.readOnly = true;
      text.title = "one of " + choices.join(", ");
    }
    text.addEventListener("change", () => commit(v.name, asValue(text.value)));

    const slot = document.createElement("div");
    // A variable with options is a choice, not a quantity: an axis is 'z',
    // which is a name and not a small number. A dropdown is to options what
    // the slider is to a range, and the text box beside it would only let
    // you type something the engine is going to refuse.
    if (choices && !isExpression) {
      const pick = document.createElement("select");
      choices.forEach((option, index) => {
        const item = document.createElement("option");
        // the index, so the option's own type survives the round trip through
        // the DOM: 'z' has to stay the string 'z', and 8 the number 8
        item.value = String(index);
        item.textContent = String(option);
        item.selected = String(option) === String(v.value);
        pick.appendChild(item);
      });
      pick.title = "one of " + choices.join(", ");
      pick.addEventListener("change", () =>
        commit(v.name, choices[Number(pick.value)]),
      );
      slot.appendChild(pick);
    } else if (slidable) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = low;
      slider.max = high;
      // a count has no values between its values
      slider.step = b.integer ? 1 : (high - low) / 100;
      slider.value = v.value;
      slider.title = short(low) + " .. " + short(high);
      // live scene while dragging, one edit in the history when released
      slider.addEventListener("pointerdown", () => {
        dragging = true;
        rpc("begin_interaction"); // the whole drag undoes as one
      });
      slider.addEventListener("input", () => {
        text.value = short(parseFloat(slider.value));
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
          load();
        }
      });
      slot.appendChild(slider);
    } else if (!isExpression) {
      const hint = document.createElement("span");
      hint.style.opacity = "0.5";
      hint.style.fontSize = "10px";
      hint.textContent = "no range";
      hint.title = "Give it a range to get a slider";
      slot.appendChild(hint);
    }

    const acts = document.createElement("div");
    acts.className = "acts";
    acts.append(
      // Everything about the variable except its value, which is the box
      // beside this: one menu rather than a button each, because the row is
      // as wide as a sidebar and the slider is what should have the space.
      button("⋯", "Edit " + v.name + "…", "edit", v.name),
      button("✕", "Remove " + v.name, "remove", v.name),
    );
    row.append(name, slot, text, acts);
    listEl.appendChild(row);

    // hard limits worth seeing when they differ from the slider's span
    const hard = b.min !== undefined || b.max !== undefined;
    if (hard && (b.soft_min !== undefined || b.soft_max !== undefined)) {
      const note = document.createElement("div");
      note.className = "range";
      note.textContent =
        "allowed " +
        (b.min === undefined ? "−∞" : short(b.min)) +
        " .. " +
        (b.max === undefined ? "∞" : short(b.max));
      listEl.appendChild(note);
    }
  }
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "rpcResult" || message.type === "rpcError") {
    const entry = pending.get(message.reqId);
    if (!entry) return;
    pending.delete(message.reqId);
    if (message.type === "rpcResult") entry.resolve(message.result);
    else entry.reject(new Error(message.method + ": " + message.error));
  } else if (message.type === "refresh") {
    load().catch((err) => {
      statusEl.textContent = String(err);
    });
  } else if (message.type === "help") {
    loadHelp().catch((err) => {
      statusEl.textContent = String(err);
    });
  } else {
    // A message the host sends and this end does not handle is a broken
    // contract, not a no-op: it is how "what can go in a value" stayed
    // empty. Say so where it can be seen.
    statusEl.textContent = "unhandled message: " + message.type;
  }
});

vscodeApi.postMessage({ type: "ready" });
