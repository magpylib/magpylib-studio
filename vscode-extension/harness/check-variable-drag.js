/**
 * A slider drag, driven the way a hand drives it, run as part of `npm run
 * compile`.
 *
 *   node harness/check-variable-drag.js
 *
 * Dragging a variable is a protocol, not a function: the panel opens an undo
 * group, sends values while the pointer moves, and closes the group after the
 * release -- and every bug this file exists for was in the *order* of those,
 * not in any one of them. None was visible to tsc, to ESLint, or to the
 * extension tests, which never open this panel. They were found by reading,
 * which is not a thing that can be run again.
 *
 * What it holds to, on the real engine and the panel's own script:
 *
 * 1. One value per frame at most, newest wins. A mouse reports faster than a
 *    screen draws, and a scene rebuilt for a value that is overwritten before
 *    it can be drawn is work spent on nothing. Frames are supplied by hand
 *    here, which is the only way to tell "one per frame" from "one, eventually".
 *
 * 2. A value still waiting when the pointer lifts goes out *before* the group
 *    closes. A drag that comes back to where it started fires no `change`, so
 *    nothing commits, and a value released after `end_interaction` would undo
 *    as a step of its own -- one gesture, two things to undo.
 *
 * 3. A release that does commit commits once. The flush in (2) must not send
 *    the value `change` has already sent.
 */
const { enginePython } = require("./engine-python");
const { mount, startEngine } = require("./webview-harness");

let failures = 0;
let engine; // module scope so a thrown check still takes the engine with it
function check(ok, message) {
  console.log(`${ok ? "ok   " : "FAIL "} ${message}`);
  if (!ok) failures++;
}

async function main() {
  if (!enginePython()) {
    // The engine is a separate install; `npm run compile` must not need one.
    console.log("skip  variable drag (no python here can import the engine)");
    return;
  }
  engine = startEngine();
  await engine.request("load_example", { name: "halbach" });

  // Frames on demand: the panel asks for one after every value it sends, and
  // nothing is due until this queue is drained.
  const frames = [];
  const { roots, settle, sent } = await mount("variables", engine, {
    requestAnimationFrame: (fn) => frames.push(fn),
  });
  const drawFrame = () => {
    for (let i = 0; i < 10 && frames.length; i++) {
      for (const fn of frames.splice(0)) fn();
    }
  };
  await settle(8);

  const sliderFor = (name) => {
    const row = roots
      .get("list")
      .querySelectorAll("div.row")
      .find((r) => r.querySelector("span.name")?.textContent === name);
    const el = row?.all().find((e) => e.type === "range");
    if (!el) {
      throw new Error(`no slider for ${name} — the panel rendered no row`);
    }
    return el;
  };

  /** What the panel said to the host since the last mark, in order. */
  let mark = sent.length;
  const since = () => sent.slice(mark).filter((m) => m.type === "rpcRequest");
  const sets = () => since().filter((m) => m.method === "set_variable");
  const restart = () => {
    drawFrame(); // a frame owed from the last gesture must not open this one
    mark = sent.length;
  };

  const drag = (slider, value) => {
    slider.value = value;
    slider.dispatch("input");
  };

  // --- 1. one value per frame, newest wins --------------------------------
  restart();
  let slider = sliderFor("n");
  slider.dispatch("pointerdown");
  drag(slider, 12); // goes at once: no frame has been spent yet
  drag(slider, 14); // overtaken before a frame comes round
  drag(slider, 16);
  await settle(6);
  check(
    sets().length === 1 && sets()[0].params.value === 12,
    `three values in one frame send one: ${sets().map((m) => m.params.value)}`,
  );
  check(
    sets().every((m) => m.preview === true),
    "a value under the pointer is marked a preview",
  );
  check(
    since()[0]?.method === "begin_interaction",
    "the gesture opens an undo group before it sends anything",
  );

  drawFrame();
  await settle(6);
  check(
    sets().length === 2 && sets()[1].params.value === 16,
    `the next frame sends the newest and drops the rest: ${sets().map((m) => m.params.value)}`,
  );

  // --- 2. a drag that comes back to where it started ----------------------
  // The drag above left n at 16, which is where this one has to end.
  restart();
  slider.dispatch("pointerdown");
  drag(slider, 18); // goes at once
  drag(slider, 16); // back to the start, and held: no frame, one on the wire
  slider.dispatch("pointerup"); // released where it began: no `change` fires
  await settle(8);

  const held = sets().find((m) => m.params.value === 16);
  const closes = since().findIndex((m) => m.method === "end_interaction");
  check(!!held, "the value held at the release is not dropped");
  check(
    !!held && closes !== -1 && since().indexOf(held) < closes,
    "it is sent before the undo group closes, not after",
  );
  check(
    !!held && held.preview === true,
    "and as a preview: a gesture that put everything back has edited nothing",
  );
  check(
    !since()
      .slice(closes + 1)
      .some((m) => m.method === "set_variable"),
    "nothing follows the group's close",
  );
  check(
    !since().some((m) => m.method === "get_variables"),
    "and the panel is not rebuilt for a drag that changed nothing",
  );

  const settled = await engine.request("get_variables");
  check(
    settled.variables.find((v) => v.name === "n")?.value === 16,
    "the scene is put back where the drag started, not left part-way",
  );
  // The step such a drag used to leave is invisible in the event log -- a
  // variable is not an event -- so ask the only thing that can tell it is
  // gone: one undo has to reach past this gesture to the drag before it,
  // rather than stopping on a step that puts back what is already on screen.
  await engine.request("undo");
  const undone = (await engine.request("get_variables")).variables.find(
    (v) => v.name === "n",
  );
  check(
    undone?.value === 10,
    `and leaves no step to undo: one undo reaches past it, to n=${undone?.value}`,
  );

  // --- 3. an ordinary release commits once --------------------------------
  restart();
  await settle(4); // the commit above rebuilt the rows
  slider = sliderFor("n");
  slider.dispatch("pointerdown");
  drag(slider, 22);
  drag(slider, 24);
  slider.dispatch("change"); // what a release fires when the value moved
  slider.dispatch("pointerup");
  await settle(8);

  const commits = sets().filter((m) => m.preview !== true);
  check(
    commits.length === 1 && commits[0].params.value === 24,
    `a release commits the final value once: ${commits.map((m) => m.params.value)}`,
  );
  const closed = since().findIndex((m) => m.method === "end_interaction");
  check(
    closed !== -1 &&
      !since()
        .slice(closed + 1)
        .some((m) => m.method === "set_variable"),
    "the group closes after the last thing that changed the scene",
  );
  check(
    since()
      .slice(closed + 1)
      .some((m) => m.method === "get_variables"),
    "and the panel reads its rows back once the gesture is over, not during",
  );

  const { variables } = await engine.request("get_variables");
  const n = variables.find((v) => v.name === "n");
  check(n?.value === 24, `the scene is left holding the released value: n=${n?.value}`);
}

main()
  .then(() => process.exit(failures ? 1 : 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => engine?.proc.kill());
