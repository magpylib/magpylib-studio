/**
 * Units in the Variables panel, run as part of `npm run compile`.
 *
 *   node harness/check-variable-units.js
 *
 * The document holds metres; the panel shows a length in the scene's length
 * unit and reads what is typed back through the engine (`quantity`), so the
 * units live in one place (`docs/fem.md` §6). The extension tests cannot open
 * this panel, so this is where that is held to, on the real engine and the
 * panel's own script:
 *
 * 1. A length says what it is in, beside its name, and its box holds the
 *    number in that unit: SI unless the scene says otherwise -- `gap m`, 0.015.
 * 2. A bare number typed is in that unit, and one with a unit is in its own:
 *    `0.03`, `20 mm` and `2 cm` all mean what they say.
 * 3. A scene shown in mm shows `gap mm` holding 30, and reads a bare `20` as
 *    20 mm.
 * 4. A unit that is not one of the variable's is refused with the engine's
 *    reason, and nothing is stored.
 * 5. A variable that says nothing about what it measures is as it was: `n`
 *    shows 10 and takes 12.
 */
const { enginePython } = require("./engine-python");
const { mount, startEngine } = require("./webview-harness");

let failures = 0;
let engine;
function check(ok, message) {
  console.log(`${ok ? "ok   " : "FAIL "} ${message}`);
  if (!ok) failures++;
}

async function main() {
  if (!enginePython()) {
    console.log("skip  variable units (no python here can import the engine)");
    return;
  }
  engine = startEngine();
  await engine.request("load_example", { name: "halbach" });
  const { provider, roots, settle, sent } = await mount("variables", engine);
  await settle(8);

  const row = (name) => {
    const found = roots
      .get("list")
      .querySelectorAll("div.row")
      .find(
        (r) => r.querySelector("span.name")?.textContent.split(" ")[0] === name,
      );
    if (!found) {
      throw new Error(`no row for ${name} — the panel rendered none`);
    }
    return found;
  };
  const box = (name) =>
    row(name)
      .all()
      .find((e) => e.type === "text");
  const stored = async (name) =>
    (await engine.request("get_variables", {})).variables.find(
      (v) => v.name === name,
    ).expression;
  const type = async (name, text) => {
    const input = box(name);
    input.value = text;
    input.dispatch("change");
    await settle(12);
  };

  // 1. shown in its unit: SI by default
  let gapName = row("gap").querySelector("span.name").textContent;
  check(
    gapName === "gap m",
    `a length says its unit beside its name: "${gapName}"`,
  );
  check(
    box("gap").value === "0.015",
    `and its box holds metres: ${box("gap").value}`,
  );

  // 2. read in its unit, or in the one typed
  await type("gap", "0.03");
  check(
    (await stored("gap")) === 0.03,
    `"0.03" stores 0.03 m: ${await stored("gap")}`,
  );
  await type("gap", "20 mm");
  check(
    (await stored("gap")) === 0.02,
    `"20 mm" stores 0.02 m: ${await stored("gap")}`,
  );
  await type("gap", "2.5 cm");
  check(
    (await stored("gap")) === 0.025,
    `"2.5 cm" stores 0.025 m: ${await stored("gap")}`,
  );
  const asked = sent.filter(
    (m) => m.type === "rpcRequest" && m.method === "quantity",
  );
  check(
    asked.length === 3,
    `the engine reads all three (${asked.length} quantity calls)`,
  );

  // 3. a scene shown in mm
  await engine.request("set_model_unit", { unit: "mm" });
  provider.refresh();
  await settle(12);
  gapName = row("gap").querySelector("span.name").textContent;
  check(gapName === "gap mm", `shown in mm, it says so: "${gapName}"`);
  check(
    box("gap").value === "25",
    `and holds millimetres: ${box("gap").value}`,
  );
  await type("gap", "20");
  check(
    (await stored("gap")) === 0.02,
    `a bare "20" is 20 mm: ${await stored("gap")}`,
  );

  // 4. refused, with the reason
  const before = await stored("gap");
  await type("gap", "5 kg");
  check(
    (await stored("gap")) === before,
    "a unit that is not a length stores nothing",
  );
  const status = roots.get("status").textContent;
  check(
    /'kg' is not a unit of length/.test(status),
    `and says why: "${status}"`,
  );

  // 5. a count is as it was
  check(box("n").value === "10", `a count shows as it is: ${box("n").value}`);
  await type("n", "12");
  check(
    (await stored("n")) === 12,
    `and takes a bare number: ${await stored("n")}`,
  );
}

main()
  .then(() => process.exit(failures ? 1 : 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => engine?.proc.kill());
