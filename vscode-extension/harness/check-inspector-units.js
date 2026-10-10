/**
 * Units in the Inspector, run as part of `npm run compile`.
 *
 *   node harness/check-inspector-units.js
 *
 * The document holds metres and tesla; the Inspector shows an object's
 * parameters and pose in the scene's units and reads what is typed back
 * through the engine (`read_values`), as the Variables panel does. On the
 * real engine and the Inspector's own module -- the package's
 * `inspector.mjs`, which the sidebar and the notebook widget both mount:
 *
 * 1. SI unless the scene says otherwise: a Cuboid's dimension is `(m)` and
 *    its boxes hold 0.01.
 * 2. A scene shown in mm and mT says so beside each parameter -- dimension
 *    `(mm)`, polarization `(mT)`, the pose `(mm, °)` -- and its boxes hold
 *    10, 1000 and 23.
 * 3. A bare number typed is in that unit, and one with a unit in its own:
 *    `12` is 12 mm, `1.5 cm` is 15 mm. The components not typed in keep
 *    their exact values, and an expression stays one.
 * 4. A unit that is not a length is refused with the engine's reason, and
 *    nothing is stored.
 * 5. magnetization, in A/m, which no unit setting covers, is as it was.
 */
const { enginePython } = require("./engine-python");
const { mountInspector, startEngine } = require("./webview-harness");

let failures = 0;
let engine;
function check(ok, message) {
  console.log(`${ok ? "ok   " : "FAIL "} ${message}`);
  if (!ok) failures++;
}

async function main() {
  if (!enginePython()) {
    console.log("skip  inspector units (no python here can import the engine)");
    return;
  }
  engine = startEngine();
  await engine.request("load_example", { name: "halbach" });
  const { panel, root, settle } = await mountInspector(engine);
  await settle(4);
  const select = async (id) => {
    await panel.show(id);
    await settle(16);
  };

  const row = (name) => {
    const found = root
      .querySelector("div.magpy-ins-params")
      .querySelectorAll("div.magpy-ins-row")
      .find(
        (r) => r.querySelector("label")?.textContent.split(" ")[0] === name,
      );
    if (!found) {
      throw new Error(`no row for ${name} — the Inspector rendered none`);
    }
    return found;
  };
  const label = (name) => row(name).querySelector("label").textContent.trim();
  const boxes = (el) => el.all().filter((e) => e.type === "text");
  const values = (name) => boxes(row(name)).map((b) => b.value);
  const param = async (name) =>
    (await engine.request("get_params", { object_id: "r1" })).find(
      (p) => p.name === name,
    ).value;
  const type = async (input, text) => {
    input.value = text;
    input.dispatch("change");
    await settle(16);
  };

  // 1. SI by default
  await select("r1");
  check(
    label("dimension") === "dimension (m)",
    `a length says it is in metres: "${label("dimension")}"`,
  );
  check(
    values("dimension").join(", ") === "0.01, 0.01, 0.01",
    `and holds metres: ${values("dimension").join(", ")}`,
  );

  // 2. a scene shown in mm and mT
  await engine.request("set_model_unit", { unit: "mm" });
  await engine.request("set_field_unit", { unit: "mT" });
  await panel.refresh();
  await settle(16);
  check(
    label("dimension") === "dimension (mm)",
    `shown in mm, it says so: "${label("dimension")}"`,
  );
  check(
    values("dimension").join(", ") === "10, 10, 10",
    `and holds millimetres: ${values("dimension").join(", ")}`,
  );
  check(
    label("polarization") === "polarization (mT)" &&
      values("polarization")[0] === "1000",
    `a polarization in mT: "${label("polarization")}" ${values("polarization")[0]}`,
  );
  const pose = root.querySelector("div.magpy-ins-transform");
  const poseTitle = pose.querySelector("summary").textContent;
  const position = boxes(pose).slice(0, 3);
  check(
    poseTitle === "pose (mm, °)",
    `the pose says its units: "${poseTitle}"`,
  );
  check(
    position.map((b) => b.value).join(", ") === "radius, 0, 0",
    `and an expression stays one: ${position.map((b) => b.value).join(", ")}`,
  );

  // 3. read in its unit, or in the one typed
  await type(boxes(row("dimension"))[0], "12");
  let stored = await param("dimension");
  check(
    stored.join(", ") === "0.012, 0.01, 0.01",
    `a bare "12" is 12 mm, the others untouched: ${stored.join(", ")}`,
  );
  await type(boxes(row("dimension"))[1], "1.5 cm");
  stored = await param("dimension");
  check(
    stored.join(", ") === "0.012, 0.015, 0.01",
    `"1.5 cm" is 15 mm: ${stored.join(", ")}`,
  );
  await type(boxes(row("polarization"))[0], "800");
  check(
    (await param("polarization"))[0] === 0.8,
    `a bare "800" is 800 mT: ${(await param("polarization"))[0]}`,
  );

  // 4. refused, with the reason
  await type(boxes(row("dimension"))[2], "5 kg");
  check(
    (await param("dimension"))[2] === 0.01,
    "a unit that is not a length stores nothing",
  );
  const status = root.querySelector("div.magpy-ins-status").textContent;
  check(
    /'kg' is not a unit of length/.test(status),
    `and says why: "${status}"`,
  );

  // 5. A/m is as it was
  check(
    label("magnetization") === "magnetization (A/m)",
    `a magnetization is in A/m still: "${label("magnetization")}"`,
  );
}

main()
  .then(() => process.exit(failures ? 1 : 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => engine?.proc.kill());
