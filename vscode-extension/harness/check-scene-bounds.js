/**
 * The 3D view can receive and aim at every shipped example, run as part of
 * `npm run compile`.
 *
 *   node harness/check-scene-bounds.js
 *
 * Two silent failures, both of which the helical winding hit at once, and
 * neither of which any other check could see.
 *
 * 1. The payload has to *arrive*. Magpylib separates the segments of a trace
 *    with NaN -- plotly's way of lifting the pen between the arrows along a
 *    current path -- and `json.dumps` writes that as a bare `NaN`, which is
 *    not JSON. `engineClient.handleLine` catches the parse error, logs to
 *    stderr and returns *without resolving the request*, so the view waits
 *    forever for a scene that was already computed. `JSON.parse` here is the
 *    same parser, so a payload that would not arrive fails this check.
 *
 * 2. It has to be possible to point a camera at it. `fitView` solves for a
 *    distance from the bounding sphere of everything drawn, and a sphere is
 *    just numbers: one NaN vertex and the camera goes to NaN and the canvas
 *    draws nothing. `Box3.isEmpty()` is false for a box whose bounds are NaN,
 *    so nothing downstream notices.
 *
 * It builds the geometry the way `buildScatter` does, out of the same two
 * helpers, because the bug was never in either half alone.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { enginePython } = require("./engine-python");

const EXT = path.join(__dirname, "..");
const REPO = path.join(EXT, "..");

const PAYLOADS = `
import json
from magpylib_studio.session import EXAMPLES, MagpylibStudioSession
out = {}
for name in EXAMPLES:
    s = MagpylibStudioSession()
    s.load_example(name)
    scene = s.get_scene()
    out[name] = [
        {"object_id": i["object_id"], "position": i["position"]}
        for i in scene["meshes"] + scene["scatters"]
    ]
print(json.dumps(out))
`;

async function main() {
  const python = enginePython();
  if (!python) {
    // The engine is a separate install; `npm run compile` must not need one.
    console.log("skip  scene bounds (no python here can import the engine)");
    return;
  }
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({ measureText: () => ({ width: 1 }), fillText() {} }),
    }),
  };
  const THREE = await import("three");
  const { boundByFinitePoints, withPenLifts } =
    await import("../media/scene3d.mjs");

  const raw = execFileSync(python, ["-c", PAYLOADS], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  let scenes;
  try {
    scenes = JSON.parse(raw);
  } catch (err) {
    // The engine's own reader would drop this response and never resolve.
    console.log(
      `FAIL  the scene payload is not JSON the view can read: ${err.message}`,
    );
    process.exit(1);
  }

  let failures = 0;
  for (const [name, traces] of Object.entries(scenes)) {
    const node = new THREE.Group();
    let lifts = 0;
    for (const trace of traces) {
      const position = withPenLifts(trace.position);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
      boundByFinitePoints(geometry, position);
      lifts += trace.position.filter((v) => v === null).length / 3;
      node.add(new THREE.Line(geometry));
    }
    const sphere = new THREE.Box3()
      .expandByObject(node)
      .getBoundingSphere(new THREE.Sphere());
    if (!Number.isFinite(sphere.radius) || !Number.isFinite(sphere.center.x)) {
      console.log(`FAIL  ${name} cannot be framed: its bounding sphere is NaN`);
      failures++;
      continue;
    }
    const across = (sphere.radius * 2 * 1000).toFixed(1);
    const note = lifts ? `, ${lifts} pen-lifts spanned` : "";
    console.log(`ok    ${name} frames at ${across} mm across${note}`);
  }
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
