// The 3D view as a scene graph rather than a chart.
//
// Plotly draws the scene from a figure that is replaced whole on every edit.
// This builds one THREE.Mesh per object, keyed by the studio id the rest of
// the protocol already uses, so a later change can move or recolour a single
// object without asking python for a new scene.
//
// Loaded as a module because three ships ESM only; `scene3d` is on window as
// well as exported, so the panels' own scripts can drive it.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

const scene = new THREE.Scene();
let host = null; // the element the view is hung in; whose theme it wears
let sizing = null; // watches the host for a size change, wherever it is now
let camera = null;
let controls = null;
let renderer = null;
const raycaster = new THREE.Raycaster();
const byObjectId = new Map();
// What the host has hidden. By id, and held here rather than on the nodes:
// every redraw and every frame of a run rebuilds those, and a visibility set
// on one from outside would last only until the next.
let hiddenIds = new Set();
let framed = false;
// What marks the selection, each `{ on, part }`: a part hung on the trace it
// marks, so a drag or a step of a run carries it along. See `outline`.
let outlines = [];
// A fainter outline, for what the host is pointing at rather than what is
// selected: a legend row under the pointer. By id, so it can be drawn again
// round whatever a redraw builds for them.
let hintIds = [];
let hints = [];
let axes = null; // the box, ticks and names that give the scene a scale
// Whether the host wants that box. Held here, like hiding, because the box is
// drawn again on every redraw; the panel never says, and always has it.
let axesShown = true;
let selectedIds = []; // the primary is first: what the sidebar is showing
// What a drag of several objects turns. It stands at the middle of the
// selection and is never drawn -- only the motion it makes is read off it.
const rig = new THREE.Object3D();
let gizmo = null;
let gizmoMode = "translate";
let snapping = false;
let playing = false;
let pivots = {}; // studio id -> its handle point, in its own frame

let frustumHeight = 1; // what an orthographic camera shows, top to bottom
let cameraMoved = null; // a host's, told whenever the camera has moved
/** Which axes each kind of drag runs along, in three's vocabulary.
 *
 * Per mode rather than one setting for all of them, because the right answer
 * differs and the control shows which is in force: positioning is world work,
 * while a polarization is *stored* in the object's frame and a dimension only
 * means anything along the object's own axes -- three forces that one anyway.
 */
const DEFAULT_SPACES = {
  translate: "world",
  rotate: "world",
  polarization: "local",
  scale: "local",
};
const SPACES = { ...DEFAULT_SPACES };
let orientations = {}; // studio id -> the rotation baked into its vertices
let anchors = {}; // studio id -> where the object is
let paths = {}; // studio id -> every frame it passes through, when it has one
// A run that is its first frame moved about: each motion, a pose per step,
// and each trace that moves with the matrix it was hung with -- which is
// where it stands at the first step. Null when the run is not motion --
// frames are asked for instead -- and empty when it is motion of nothing.
let tracks = null;
let tracked = [];
// What poses cannot say: each changing trace's item at every step, and each
// one drawn, with the node it hangs on -- swapped for the step's own.
let changes = [];
let changing = [];
// The payload's colour tables, each once; a mesh names its own by index.
let luts = [];
let shapes = {}; // studio id -> the one parameter a resize may drag
let polarizations = {}; // studio id -> its polarization, in its own frame
//: Sources a later step copies. Their copies are drawn on their own node and
//: under their own id, so what the handles hold is the whole pattern -- which
//: is what a drag now moves, the engine recording it before the step that
//: copies it rather than after.
let patterned = new Set();
// Studio id -> what a collection holds, nested collections too. A collection
// draws nothing of its own: it has a node only for handles to go on, and what
// it holds is hung on that node while it is dragged.
let collections = {};
let centroids = {}; // studio id -> where its handles go, for the nodes made here
// What the polarization handles turn. The object must not turn with them, so
// they cannot be attached to it: this stands in, and only its rotation is read.
const proxy = new THREE.Object3D();

/** A VS Code theme colour, so the view wears whatever the editor is wearing.
 *
 * Read off the host element rather than the document. Custom properties
 * inherit, so in the webview -- where VS Code sets them on the root -- this is
 * the same value it always was; and it lets a host that is not VS Code, the
 * notebook widget, dress the view by styling its own element instead of
 * writing the editor's variable names onto somebody else's page.
 */
function cssColor(name, fallback) {
  const css = getComputedStyle(host || document.body)
    .getPropertyValue(name)
    .trim();
  return css || fallback;
}

function ensureRenderer(canvasEl) {
  // Before the early return: a re-hung canvas is a new host, and everything
  // aimed at the old one has to follow it. Only the events and the size do --
  // the listeners are on the canvas, which moves with the renderer.
  if (host !== canvasEl) {
    host = canvasEl;
    sizing ??= new ResizeObserver(() => resize(host));
    sizing.disconnect();
    sizing.observe(canvasEl);
  }
  if (renderer) {
    // switching back from plotly empties the host element, and a WebGL context
    // is far too expensive to rebuild for that: re-hang the canvas instead
    if (renderer.domElement.parentElement !== canvasEl) {
      canvasEl.appendChild(renderer.domElement);
    }
    return;
  }
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  canvasEl.appendChild(renderer.domElement);

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.up.set(0, 0, 1); // magpylib scenes are z-up
  controls = orbit();

  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(1, -1, 1);
  scene.add(key);

  // A lost context comes back empty: three rebuilds what it holds, and the
  // picture has to be drawn again on top.
  renderer.domElement.addEventListener("webglcontextrestored", redraw);
  watchPicks();
  makeGizmo();
}

/** Draw the view at the next frame, once however many ask before then.
 *
 * On demand rather than every frame: a notebook holds a view per cell, most
 * of them scrolled away and all of them idle most of the time, and a render
 * loop apiece keeps the GPU drawing every one of them sixty times a second.
 * So whatever changes the picture asks for a frame -- the orbit and the
 * handles as they move, a new size, and every call a host makes (see
 * `drawingAfter`) -- and nothing else draws. */
let frameAsked = false;
function redraw() {
  if (!renderer || frameAsked) return;
  frameAsked = true;
  requestAnimationFrame(() => {
    frameAsked = false;
    renderer.render(scene, camera);
  });
}

/** A rotation as magpylib writes one: an axis scaled by its angle in degrees. */
function rotvecOf(quaternion) {
  const sine = Math.sqrt(Math.max(1 - quaternion.w * quaternion.w, 0));
  if (sine < 1e-9) return [0, 0, 0];
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(quaternion.w, -1, 1));
  const scale = THREE.MathUtils.radToDeg(angle) / sine;
  return [quaternion.x * scale, quaternion.y * scale, quaternion.z * scale];
}

function quaternionOf(rotvec) {
  const axis = new THREE.Vector3().fromArray(rotvec || [0, 0, 0]);
  const degrees = axis.length();
  if (degrees < 1e-12) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromAxisAngle(
    axis.normalize(),
    THREE.MathUtils.degToRad(degrees),
  );
}

const UNSCALED = new THREE.Vector3(1, 1, 1);

/** Hold the scale to the shape of the parameter behind it.
 *
 * A resize drags one magpylib value, not three: a Sphere has a diameter and a
 * Cylinder a (diameter, height), so the axes that value does not separate
 * must not separate on screen either. Applied to the node as the drag runs,
 * so the handles cannot be pulled into a shape the object could never take.
 */
function constrainScale(node, constraint) {
  const { x, y, z } = node.scale;
  if (constraint === "uniform") {
    // whichever axis was pulled furthest from 1 is the one being dragged
    const pulled = [x, y, z].reduce((a, b) =>
      Math.abs(b - 1) > Math.abs(a - 1) ? b : a,
    );
    node.scale.setScalar(pulled);
  } else if (constraint === "xy") {
    const radial = Math.abs(x - 1) > Math.abs(y - 1) ? x : y;
    node.scale.set(radial, radial, z);
  }
}

/** The parameter value a scale comes to, from the one the drag started at. */
function resized(scale, shape, centre) {
  if (shape.constraint === "uniform") return shape.value * scale.x;
  if (shape.constraint === "xy")
    return [shape.value[0] * scale.x, shape.value[1] * scale.z];
  if (shape.constraint === "vertices") {
    // A mesh has no dimension; the array is the parameter. It scales about
    // the centroid, because that is the point the handles are on -- for a
    // shape whose position is already its centre that is the origin, and
    // this is the plain multiplication it looks like.
    return shape.value.map(([x, y, z]) => [
      centre.x + (x - centre.x) * scale.x,
      centre.y + (y - centre.y) * scale.y,
      centre.z + (z - centre.z) * scale.z,
    ]);
  }
  return [
    shape.value[0] * scale.x,
    shape.value[1] * scale.y,
    shape.value[2] * scale.z,
  ];
}

/** The drag handles, and the pose a drag reports as it goes.
 *
 * Reported as the pose *reached*, never as the turn made, and that is the
 * whole design. The engine coalesces repeated absolute poses on one object
 * into a single construction step, so a drag of any length coalesces into
 * one -- while a relative rotate cannot be replaced in place and would leave
 * one event per frame in the history, and one undo per frame to get back.
 *
 * Reporting an absolute rotation takes knowing the one already there, which
 * the picture cannot show: magpylib bakes it into the vertices, so the node
 * starts every render unrotated. That is what the payload's `orientations`
 * is for.
 *
 * Only the part that moved is sent. A drag that moves an object should not
 * overwrite an orientation the user wrote as an expression, and vice versa.
 */
function makeGizmo() {
  let from = null;
  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSpace(spaceOf()); // the axes the user reads off the model
  gizmo.size = 0.45; // full size swamps a small object
  scene.add(gizmo.getHelper());
  scene.add(proxy);
  scene.add(rig);

  const report = (preview) => {
    const node = gizmo.object;
    if (!node || !from) return;
    const turned = node.quaternion
      .clone()
      .multiply(from.quaternion.clone().invert());

    if (from.polarization) {
      // The drag turns the vector, not the magnet. magpylib keeps it in the
      // object's own frame, so the turn is applied in world and taken back:
      // reading the stored vector as world-space is out by the object's own
      // rotation, which is a silent error the picture cannot show.
      if (Math.abs(turned.w) >= 1 - 1e-9) return;
      const primary = from.objectIds[0];
      const aimed = from.polarization
        .clone()
        .applyQuaternion(turned)
        .applyQuaternion(from.orientations[primary].clone().invert())
        .toArray();
      host.dispatchEvent(
        new CustomEvent("objecttransform", {
          detail: {
            preview,
            edits: [{ objectId: primary, polarization: aimed }],
          },
        }),
      );
      return;
    }

    // One rigid motion, applied to every frame of every object selected: a
    // point p goes to (where the handles are now) + turn x (p - where they
    // were). One object with no path is the single-frame, single-object case
    // of that, and the offset between its position and its centroid is what
    // the turn acts on -- which is why turning something off-centre moves it,
    // and why anything centred on its own position stays put.
    const here = node.getWorldPosition(new THREE.Vector3());
    const rigid = (point) =>
      here.clone().add(point.clone().sub(from.here).applyQuaternion(turned));
    const turning = Math.abs(turned.w) < 1 - 1e-9;
    // a path moves only where the edit below moves the object's position
    holdPaths(from.pathTraces, (objectId) => {
      const placed = new THREE.Vector3().fromArray(
        anchors[objectId] || [0, 0, 0],
      );
      return !rigid(placed).equals(placed);
    });

    const edits = [];
    for (const objectId of from.objectIds) {
      const edit = { objectId };
      const path = from.paths[objectId];
      const placed = rigid(from.placed[objectId]);
      if (!placed.equals(from.placed[objectId])) {
        edit.position = path
          ? path.position.map((p) =>
              rigid(new THREE.Vector3().fromArray(p)).toArray(),
            )
          : placed.toArray();
      }
      if (turning) {
        // every frame turns by the same amount, so a path keeps its shape
        edit.orientation = path
          ? path.orientation.map((r) =>
              rotvecOf(turned.clone().multiply(quaternionOf(r))),
            )
          : rotvecOf(turned.clone().multiply(from.orientations[objectId]));
      }
      if (from.shape && !node.scale.equals(UNSCALED)) {
        edit.shape = {
          attr: from.shape.attr,
          value: resized(node.scale, from.shape, from.centre),
          scale: node.scale.toArray(), // a mesh has no size worth printing
        };
      }
      if (edit.position || edit.orientation || edit.shape) edits.push(edit);
    }
    if (edits.length) {
      host.dispatchEvent(
        new CustomEvent("objecttransform", { detail: { preview, edits } }),
      );
    }
  };

  gizmo.addEventListener("dragging-changed", (event) => {
    controls.enabled = !event.value; // do not orbit while dragging a handle
    const node = gizmo.object;
    if (!node) return;
    if (event.value) {
      // Dragging the rig carries everything selected; dragging an object's
      // own node carries that one. Either way it is one rigid motion, and the
      // only difference is how many objects come along with it.
      const objectIds =
        node === rig ? outermost(selectedIds) : [node.userData.objectId];
      const primary = objectIds[0];
      const orientation = quaternionOf(orientations[primary]);
      const here = node.getWorldPosition(new THREE.Vector3());
      const placed = {};
      const turns = {};
      for (const objectId of objectIds) {
        placed[objectId] = new THREE.Vector3().fromArray(
          anchors[objectId] || [0, 0, 0],
        );
        turns[objectId] = quaternionOf(orientations[objectId]);
      }
      // `attach` keeps each object where it is while hanging it on the rig or
      // on a collection's node, so what is dragged moves with the handles at
      // pointer rate -- waiting for the model to come back would show nothing
      // moving. The rig carries the selection, and either carries what a
      // collection among it holds. A stand-in carries nothing.
      const carried = [];
      if (node === rig || node.userData.collection) {
        for (const objectId of objectIds) {
          carried.push(objectId, ...(collections[objectId] ?? []));
        }
      }
      const hung = carried
        .map((objectId) => byObjectId.get(objectId))
        .filter((each) => each && each !== node);
      for (const each of hung) node.attach(each);
      // The paths of everything carried, where they are now: see `holdPaths`.
      const pathTraces = [];
      node.traverse((trace) => {
        if (!trace.userData.path) return;
        let owner = trace.parent;
        while (owner && !owner.userData.objectId) owner = owner.parent;
        trace.updateWorldMatrix(true, false);
        pathTraces.push({
          trace,
          owner: owner?.userData.objectId,
          local: trace.matrix.clone(),
          world: trace.matrixWorld.clone(),
        });
      });
      from = {
        objectIds,
        hung,
        pathTraces,
        quaternion: node.quaternion.clone(),
        orientations: turns,
        placed, // where each object is, as against where the handles are
        here, // where the handles were when the drag began: the pivot
        paths, // so a drag moves whole tracks and not their ends
        // where the handles are in the object's own frame, which is the
        // centre a vertex array has to be scaled about to match the screen
        centre: here
          .clone()
          .sub(placed[primary])
          .applyQuaternion(orientation.clone().invert()),
        shape: gizmo.mode === "scale" ? shapes[primary] : null,
        polarization:
          gizmoMode === "polarization"
            ? new THREE.Vector3()
                .fromArray(polarizations[primary])
                .applyQuaternion(orientation) // stored local, turned in world
            : null,
      };
      host.dispatchEvent(
        new CustomEvent("dragstart", {
          detail: { objectIds: from.objectIds, mode: gizmoMode },
        }),
      );
    } else {
      report(false); // the one that gets recorded and redrawn
      for (const each of from.hung) {
        if (each.parent === node) scene.attach(each);
      }
      releasePaths(from.pathTraces);
      from = null;
    }
  });
  // A handle lit under the pointer, or moved by it.
  gizmo.addEventListener("change", redraw);
  gizmo.addEventListener("objectChange", () => {
    if (from?.shape) constrainScale(gizmo.object, from.shape.constraint);
    report(true);
  });
}

/** Keep each path where the edit will leave it while its object is dragged.
 *
 * A path hangs on its object's node, as the object's shape does, so it went
 * where the handles took the node: it turned with a magnet turned in place,
 * and grew with one resized, until the engine drew it again where it had been
 * all along. A path is where the object goes, not part of it, and the drag's
 * edit moves it only with the object's position -- a move, or a turn about a
 * point off that position -- and then rigidly, as the node moves. So a path
 * follows the node when `moved(owner)` says the edit moves its object, and
 * stays where it was otherwise. Set as matrices, which hold a path still
 * under a node turned and stretched at once, where position, rotation and
 * scale alone cannot. */
function holdPaths(held, moved) {
  for (const { trace, owner, local, world } of held) {
    if (!trace.parent) continue; // drawn again mid-drag, a reading redrawn
    trace.matrixAutoUpdate = false;
    if (moved(owner)) {
      trace.matrix.copy(local);
    } else {
      trace.parent.updateWorldMatrix(true, false);
      trace.matrix.copy(trace.parent.matrixWorld).invert().multiply(world);
    }
    trace.matrixWorldNeedsUpdate = true;
  }
}

/** Hand the paths `holdPaths` held back to the usual way of being placed. */
function releasePaths(held) {
  for (const { trace } of held) {
    trace.matrix.decompose(trace.position, trace.quaternion, trace.scale);
    trace.matrixAutoUpdate = true;
  }
}

/** Which handles to show, or "none" to put them away. Also how the handles
 *  find their way back onto an object that a re-render has just replaced.
 *
 *  Returns the mode actually in effect, which is not always the one asked
 *  for: a resize needs a parameter to drag and most objects have none, so
 *  the caller is told rather than left showing handles that do nothing.
 */
function setGizmoMode(mode) {
  // Several objects move and turn together; resizing or aiming them as a
  // group would mean deciding what a shared dimension or a shared direction
  // is, and there is no such thing. Those stay on the one object selected.
  const together = selectedIds.length > 1;
  const missing =
    (mode === "scale" && (together || !shapes[primaryId()])) ||
    (mode === "polarization" && (together || !polarizations[primaryId()]));
  gizmoMode = missing ? "translate" : mode;
  if (!gizmo) return gizmoMode;
  if (together && gizmoMode !== "none") {
    const centre = selectionCentre();
    if (centre) {
      rig.position.copy(centre);
      rig.quaternion.identity();
      rig.updateMatrixWorld(true);
      gizmo.setSpace("world"); // the objects disagree about their own axes
      gizmo.mode = gizmoMode;
      gizmo.attach(rig);
      return gizmoMode;
    }
  }
  const node = gizmoMode === "none" ? null : byObjectId.get(primaryId());
  if (!node) {
    gizmo.detach();
    return gizmoMode;
  }
  gizmo.setSpace(spaceOf());
  // Handles on a stand-in, for the drags whose picture can only come from the
  // engine. Aiming a polarization turns the vector and not the magnet. And
  // nothing local is honest about a patterned source: its copies hang on this
  // very node, but a move of the source moves them by the mirror of it, and a
  // turn turns them about somewhere else entirely -- only the rebuild knows
  // where they go. A node that is going to be rebuilt cannot be the one the
  // handles are on, so they go here instead.
  if (gizmoMode === "polarization" || patterned.has(primaryId())) {
    // The handles sit on the object and turn the stand-in. Two things have to
    // line up for them to follow a turned magnet: the stand-in must carry the
    // object's rotation, *and* the handles must be drawn against it -- three
    // only orients them to the object in local space, and scale is the one
    // mode it forces there, which is why resize followed and this did not.
    proxy.position.copy(node.getWorldPosition(new THREE.Vector3()));
    proxy.quaternion.copy(quaternionOf(orientations[primaryId()]));
    // A resize is read off this: it has to start the drag unscaled, or the
    // last one's factor would be counted twice.
    proxy.scale.set(1, 1, 1);
    proxy.userData.objectId = primaryId();
    // Aiming a polarization is a turn of the stand-in and nothing else; every
    // other mode is itself. Hard-coding "scale" here was right while this
    // branch only ever carried the two, and became a move that resized as
    // soon as it carried all four.
    gizmo.mode = gizmoMode === "polarization" ? "rotate" : gizmoMode;
    gizmo.attach(proxy);
    return gizmoMode;
  }
  gizmo.mode = gizmoMode;
  gizmo.attach(node);
  return gizmoMode;
}

/** Restrict the handles to one axis, or to all of them again. */
function constrainAxis(axis) {
  if (!gizmo) return;
  gizmo.showX = !axis || axis === "x";
  gizmo.showY = !axis || axis === "y";
  gizmo.showZ = !axis || axis === "z";
}

/** The axes the current mode drags along. */
function spaceOf() {
  return SPACES[gizmoMode] || "world";
}

/** Drag along the object's own axes, or the world's. Returns the one in
 *  force, which is not always the one asked for: a resize has no choice. */
function setSpace(space) {
  if (gizmoMode !== "scale") {
    SPACES[gizmoMode] = space;
    setGizmoMode(gizmoMode); // re-attach: the stand-in is placed per mode
  }
  return spaceOf();
}

function toggleSpace() {
  return setSpace(spaceOf() === "world" ? "local" : "world");
}

/** Every mode's axes at once: the defaults, but for `chosen` -- mode to
 *  space. For a host handing this renderer to a view of its own, which
 *  brings the choices it made and none of the last view's. */
function setSpaces(chosen = {}) {
  Object.assign(SPACES, DEFAULT_SPACES, chosen);
  SPACES.scale = "local"; // a size has no other
  setGizmoMode(gizmoMode);
}

/** Look down an axis, from where the camera already is. */
function axisView(x, y, z) {
  if (!camera) return;
  const distance = camera.position.distanceTo(controls.target) || 1;
  // z is up in a magpylib scene, so looking straight down it needs another
  // reference or the view has no defined roll
  camera.up.set(0, 0, 1);
  if (Math.abs(z) > 0.99) camera.up.set(0, 1, 0);
  camera.position
    .copy(controls.target)
    .addScaledVector(new THREE.Vector3(x, y, z).normalize(), distance);
  controls.update();
}

/** Report clicks on an object as an `objectpick` event on the host element.
 *
 * A DOM event rather than a callback: the panel owns what selection *means*
 * -- it belongs to the studio's sidebar, not to this view -- and this module
 * stays a component that can be dropped in without wiring.
 *
 * Reported on `host` rather than on an element captured when the listeners
 * were bound: the renderer outlives the element it hangs in, and a host that
 * re-hangs it -- a notebook cell being re-run -- would otherwise go on
 * receiving picks at the element it had thrown away.
 */
function watchPicks() {
  const down = new THREE.Vector2();
  const element = renderer.domElement;
  element.addEventListener("pointerdown", (event) =>
    down.set(event.clientX, event.clientY),
  );
  element.addEventListener("pointerup", (event) => {
    // orbiting also ends in a pointerup: only a press that stayed put is a click
    if (down.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 4) {
      return;
    }
    // a handle under the pointer was the target of the press, not the object
    // behind it -- otherwise letting go of a gizmo selects whatever it covers
    if (gizmo?.axis) return;
    const objectId = pick(event);
    if (objectId) {
      host.dispatchEvent(
        new CustomEvent("objectpick", {
          // cmd on a mac, ctrl elsewhere: the modifier every editor uses to
          // add to a selection rather than replace it
          detail: { objectId, adding: event.metaKey || event.ctrlKey },
        }),
      );
    }
  });
}

/** The studio id under the pointer, or undefined for empty space. */
function pick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    ),
    camera,
  );
  // Only what is drawn. three.js raycasts invisible objects as readily as
  // visible ones, and a hidden object would take the click meant for
  // whatever is behind it.
  const drawn = [...byObjectId.values()].filter((node) => node.visible);
  const hits = raycaster.intersectObjects(drawn, true);
  for (const hit of hits) {
    for (let node = hit.object; node; node = node.parent) {
      if (node.userData.objectId) return node.userData.objectId;
    }
  }
  return undefined;
}

function resize(canvasEl) {
  if (!renderer) return;
  const { clientWidth: w, clientHeight: h } = canvasEl;
  if (!w || !h) return;
  // Let three set the canvas's CSS size as well as its buffer. Nothing else
  // sizes the element, so without this it lays out at its buffer size --
  // devicePixelRatio times too big, which on a retina display shows the top
  // left quarter of the scene and calls it the whole view.
  renderer.setSize(w, h);
  for (const material of wideMaterials) material.resolution.set(w, h);
  applyProjection();
  redraw(); // a canvas resized is a canvas cleared
}

/** A magpylib colorscale table as a texture the shader indexes by intensity. */
function lutTexture(lut) {
  const texture = new THREE.DataTexture(
    new Uint8Array(lut),
    lut.length / 4,
    1,
    THREE.RGBAFormat,
  );
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** The node that carries one studio object.
 *
 * magpylib bakes each object's transform into the vertices it sends, and can
 * send several traces for one object -- a current draws its loop and its
 * arrows separately. Hanging them all under one node keyed by the studio id
 * is what lets a pick, a highlight, and later a gizmo act on the object
 * rather than on whichever trace happened to be hit. The node sits on the
 * object's own origin, so it is also the pivot a rotation would use.
 */
function nodeFor(objectId, centroid) {
  let node = byObjectId.get(objectId);
  if (node) return node;
  node = new THREE.Group();
  if (centroid) node.position.fromArray(centroid);
  // The node stands in the object's own frame, not just at its origin. The
  // vertices arrive with the rotation already baked in, so a node left
  // unrotated has local axes that are really the world's -- and a resize
  // then pulls a turned cuboid along the world's X, shearing it on screen
  // until the rebuild puts the dimension back along the object's own axis.
  // Carrying the rotation here is what makes "local" mean local, for the
  // resize handles and for the L key alike. `attach` below takes the
  // rotation back out of each trace, so nothing moves on screen.
  node.quaternion.copy(quaternionOf(orientations[objectId]));
  node.userData.objectId = objectId;
  node.visible = !hiddenIds.has(objectId);
  scene.add(node);
  byObjectId.set(objectId, node);
  return node;
}

/** A node for each collection, for its handles: on its centroid, in its own
 *  frame. Nothing is drawn on it; see `makeGizmo` for what it carries. */
function placeCollections() {
  for (const objectId of Object.keys(collections)) {
    const node = nodeFor(objectId, centroids[objectId]);
    node.userData.collection = true;
    node.visible = true;
  }
}

/** `objectIds` and all that each collection among them holds: what is drawn
 *  for them, which is what an outline or a frame goes round. A collection
 *  itself is kept: it draws nothing of its own, but the copies a pattern of
 *  it makes are drawn on its node -- the array example's rows and layers,
 *  which were left out of the selection of the array they make up. */
function drawnFor(objectIds) {
  const drawn = new Set();
  for (const objectId of objectIds) {
    drawn.add(objectId);
    for (const each of collections[objectId] ?? []) drawn.add(each);
  }
  return [...drawn];
}

/** Those of `objectIds` that no other of them holds: a collection moved
 *  moves what it holds, and moving that as well would move it twice. */
function outermost(objectIds) {
  return objectIds.filter(
    (objectId) =>
      !objectIds.some((other) => collections[other]?.includes(objectId)),
  );
}

/** Hide these objects, and show every other. */
function setHidden(objectIds) {
  hiddenIds = new Set(objectIds);
  for (const [objectId, node] of byObjectId) {
    // a collection's node draws nothing, and hidden would hide what it carries
    node.visible = node.userData.collection || !hiddenIds.has(objectId);
  }
  highlight(selectedIds); // an outline round nothing reads as a bug
  drawHints();
}

/** Show the graduated box -- the scene's scale -- or put it away. Framing
 *  leaves room for its numbers only while it is there. */
function setAxes(on) {
  axesShown = on;
  if (axes) axes.visible = on;
}

/** Outline these objects faintly -- what a click would select -- or, given
 *  none, stop. For a host showing where something is without choosing it. */
function hint(objectIds) {
  hintIds = [].concat(objectIds ?? []);
  drawHints();
}

function drawHints() {
  takeOff(hints);
  // Called on every redraw and every frame of a run, and nearly always with
  // nothing to point at: no style lookup for a colour nothing will wear.
  hints = hintIds.length ? outline(hintIds, 0.4) : [];
}

/** Faces meeting at more than this many degrees meet at an edge. A
 *  cylinder's sides, at 7.2° a facet, are one smooth surface; its rims are
 *  edges. */
const EDGE_ANGLE = 25;

/** What a selection is drawn in: a green nothing else in a scene is. Not the
 *  theme's focus colour, a blue: magpylib draws an object and its path in a
 *  blue by default, and a field's arrows run through blues, so a blue
 *  selection was there to be looked for rather than seen. Brighter and
 *  yellower than the green magpylib paints a magnet's south pole. */
const SELECTION_COLOUR = "#39ff14";

/** How wide, in pixels, the selection's lines are: an edge in view, a path or
 *  a wire, and an edge the shape hides, drawn faintly through it. A plain GL
 *  line is one pixel whatever it is asked for, which is easy to miss. */
const OUTLINE_WIDTH = 1.5;
const HIDDEN_WIDTH = 1;

/** How much larger a selected path's markers are drawn, beside its line. */
const PATH_MARKER_GROWTH = 1.6;

/** The wide lines' materials, which must know the view's size in pixels to
 *  draw a width in pixels: told again when it changes (`resize`). */
const wideMaterials = new Set();

/** Mark what `objectIds` stand for -- the selection, or at `opacity` below 1
 *  what the host points at -- and return what was added, to take off again.
 *
 * A shape is outlined by its edges, and its path is drawn in the selection's
 * colour rather than boxed in with it. A box round an object goes round
 * everything drawn for it, path included: a magnet on an orbit got a box the
 * size of the ring, and a ring of them six such boxes, a cage pointing at
 * none of them. Colour is touched only where it says nothing -- a path, a
 * wire -- never on a shape, where it says the magnetization, or on a marker
 * coloured by the field.
 *
 * Each part hangs on the trace it marks, so it moves with it.
 */
function outline(objectIds, opacity) {
  const added = [];
  const hang = (on, part) => {
    part.raycast = () => {}; // an indicator, not a target
    part.renderOrder = 1; // drawn over what it marks
    part.userData.outline = true;
    on.add(part);
    added.push({ on, part });
  };
  for (const objectId of drawnFor(objectIds)) {
    const node = byObjectId.get(objectId);
    if (!node?.visible) continue;
    for (const trace of node.children) {
      if (!trace.userData.trace) continue; // a handle, or another node
      if (trace.isMesh) {
        outlineShape(trace, opacity, hang);
        continue;
      }
      // A scatter: its lines take the selection's colour, and its markers
      // too where it is a path. A sensor's markers can be its pixels,
      // coloured by the field they read.
      for (const part of trace.children) {
        if (part.isLine) {
          const pairs = segmentsOf(
            part.geometry.getAttribute("position").array,
          );
          if (pairs.length) {
            hang(part, wideSegments(pairs, OUTLINE_WIDTH, opacity, true));
          }
        } else if (trace.userData.path && part.isPoints) {
          hang(part, pathMarkers(part, opacity));
        }
      }
    }
  }
  return added;
}

/** A shape's edges, wide in front where they show and faint through the
 *  shape where it hides them. Two get their box instead: a shape with no
 *  edges to draw -- a sphere, smooth all over -- and one coloured face by
 *  face, which is a sensor's: its axes, or its arrows coloured by the field,
 *  every small part of which would be outlined on its own. */
function outlineShape(mesh, opacity, hang) {
  let pairs;
  if (!mesh.userData.faceColoured) {
    const edges = new THREE.EdgesGeometry(mesh.geometry, EDGE_ANGLE);
    pairs = edges.getAttribute("position").array;
    edges.dispose();
  }
  if (!pairs || pairs.length < 18) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    pairs = boxEdges(mesh.geometry.boundingBox);
  }
  hang(mesh, wideSegments(pairs, OUTLINE_WIDTH, opacity, true));
  hang(mesh, wideSegments(pairs, HIDDEN_WIDTH, opacity * 0.35, false));
}

/** Lines from `pairs` -- each six numbers, a segment's two ends -- `width`
 *  pixels wide in the selection's colour. Where they are `shown` they are
 *  hidden by what stands in front, and drawn a little toward the eye, so
 *  that an edge is not lost in the faces it bounds; otherwise they show
 *  through everything. */
function wideSegments(pairs, width, opacity, shown) {
  const material = new LineMaterial({
    linewidth: width,
    transparent: opacity < 1,
    opacity,
    depthTest: shown,
    polygonOffset: shown,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  material.color = new THREE.Color(SELECTION_COLOUR);
  if (renderer) renderer.getSize(material.resolution);
  wideMaterials.add(material);
  return new LineSegments2(
    new LineSegmentsGeometry().setPositions(pairs),
    material,
  );
}

/** A line's points as the segments that join them, skipping a pen lift --
 *  a NaN, where magpylib breaks a trace between a current's arrows. */
function segmentsOf(position) {
  const pairs = [];
  for (let i = 0; i + 5 < position.length; i += 3) {
    const ends = position.subarray(i, i + 6);
    if (ends.every(Number.isFinite)) pairs.push(...ends);
  }
  return pairs;
}

/** A box's twelve edges, as `wideSegments` takes them. */
function boxEdges(box) {
  const { min: a, max: b } = box;
  const corner = [
    [a.x, a.y, a.z],
    [b.x, a.y, a.z],
    [b.x, b.y, a.z],
    [a.x, b.y, a.z],
    [a.x, a.y, b.z],
    [b.x, a.y, b.z],
    [b.x, b.y, b.z],
    [a.x, b.y, b.z],
  ];
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  return edges.flatMap(([i, j]) => [...corner[i], ...corner[j]]);
}

/** A path's markers again, larger and in the selection's colour, over
 *  themselves. Their geometry is the path's own, not a copy. */
function pathMarkers(part, opacity) {
  const copy = new THREE.Points(
    part.geometry,
    new THREE.PointsMaterial({
      color: new THREE.Color(SELECTION_COLOUR),
      transparent: opacity < 1,
      opacity,
      size: part.material.size * PATH_MARKER_GROWTH,
      sizeAttenuation: part.material.sizeAttenuation,
    }),
  );
  copy.userData.borrowed = true; // the geometry is the path's to free
  return copy;
}

/** Take off what `outline` hung, and free it. */
function takeOff(added) {
  for (const { on, part } of added) {
    on.remove(part);
    if (!part.userData.borrowed) part.geometry?.dispose();
    wideMaterials.delete(part.material);
    part.material?.dispose();
  }
}

function buildMesh(item) {
  const geometry = new THREE.BufferGeometry();
  const options = {
    transparent: item.opacity < 1,
    opacity: item.opacity,
    side: THREE.DoubleSide,
  };

  if (item.facecolor) {
    // per-triangle colours need one vertex per corner, so the index goes
    const pos = [];
    const col = [];
    const colour = new THREE.Color();
    for (let t = 0; t < item.facecolor.length; t++) {
      colour.set(item.facecolor[t]); // parses '#rrggbb' and 'black' alike
      for (let corner = 0; corner < 3; corner++) {
        const v = item.index[t * 3 + corner];
        pos.push(
          item.position[v * 3],
          item.position[v * 3 + 1],
          item.position[v * 3 + 2],
        );
        col.push(colour.r, colour.g, colour.b);
      }
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    options.vertexColors = true;
  } else {
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(item.position, 3),
    );
    geometry.setIndex(item.index);
    const lut = typeof item.lut === "number" ? luts[item.lut] : item.lut;
    if (lut) {
      // interpolate the intensity across the face and look the colour up per
      // fragment: the scale is piecewise, so sampling it per vertex loses it
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(item.uv, 2));
      options.map = lutTexture(lut);
    } else {
      options.color = new THREE.Color(item.color || "#2e91e5");
    }
  }
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial(options));
  mesh.name = item.name;
  mesh.userData.trace = true;
  // coloured face by face: a sensor's axes, or its arrows by the field
  mesh.userData.faceColoured = Boolean(item.facecolor);
  return mesh;
}

/** Bound a trace by the points that are actually points.
 *
 * magpylib separates the segments of a trace with NaN -- the arrows along a
 * current path are one trace with the pen lifted between them, which is
 * plotly's convention. GL drops the degenerate segments, so the picture comes
 * out right, but three bounds a geometry by *every* vertex: one NaN makes the
 * bounding box NaN, and `Box3.isEmpty()` is false for a box whose bounds are
 * NaN, so nothing downstream notices. `fitView` then solves for a NaN camera
 * distance and puts the camera at NaN -- a blank view -- and the raycast
 * threshold, taken from the same sphere, goes with it, so the scene cannot be
 * clicked either. The helical winding is 120 such separators in 540 points.
 *
 * Bounding it here rather than splitting the trace keeps it one draw call,
 * and gives framing and picking real numbers to work from.
 */
export function boundByFinitePoints(geometry, position) {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let i = 0; i + 2 < position.length; i += 3) {
    point.set(position[i], position[i + 1], position[i + 2]);
    if (
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Number.isFinite(point.z)
    ) {
      box.expandByPoint(point);
    }
  }
  if (box.isEmpty()) return;
  geometry.boundingBox = box;
  geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
}

/** `null` on the wire is a pen-lift -- see `threejs._pen_lifts`. JSON has no
 *  NaN, so the payload says it with the value JSON does have for "not a
 *  number", and the buffer wants it back as the NaN that GL knows to drop. */
export function withPenLifts(position) {
  return Float32Array.from(position, (value) => (value === null ? NaN : value));
}

/** One trace as the thing drawn: a mesh, a sensor's pixels, or a scatter. */
function buildItem(item) {
  if (item.kind === "mesh") return buildMesh(item);
  if (item.kind === "pixels") return buildPixels(item);
  return buildScatter(item);
}

/** A sensor's pixels, instanced: one shape -- the arrow magpylib draws, a
 *  cone, or a cube -- placed, turned along its reading, scaled and coloured
 *  per pixel from the matrices alone. A 7 x 7 probe was a mesh of 49
 *  arrows, a hundred kilobytes a frame; this is a few hundred numbers and
 *  one draw call a part. Picked as the sensor, like its axes; not outlined,
 *  as its arrows were not. */
function buildPixels(item) {
  const group = new THREE.Group();
  group.name = item.name;
  group.userData.trace = true;
  const count = item.sizes.length;
  const material = new THREE.MeshLambertMaterial({
    transparent: item.opacity < 1,
    opacity: item.opacity,
  });
  const parts = pixelShape(item.symbol).map(
    (geometry) => new THREE.InstancedMesh(geometry, material, count),
  );
  const matrix = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 0, 1);
  const along = new THREE.Vector3();
  const colour = new THREE.Color();
  for (let i = 0; i < count; i++) {
    at.set(
      item.origins[i * 3],
      item.origins[i * 3 + 1],
      item.origins[i * 3 + 2],
    );
    if (item.vectors) {
      along
        .set(
          item.vectors[i * 3],
          item.vectors[i * 3 + 1],
          item.vectors[i * 3 + 2],
        )
        .normalize();
      turn.setFromUnitVectors(up, along);
    } else {
      turn.identity();
    }
    const size = item.sizes[i];
    scale.set(size, size, size);
    matrix.compose(at, turn, scale);
    colour.set(Array.isArray(item.colors) ? item.colors[i] : item.colors);
    for (const part of parts) {
      part.setMatrixAt(i, matrix);
      part.setColorAt(i, colour);
    }
  }
  for (const part of parts) {
    part.instanceMatrix.needsUpdate = true;
    part.instanceColor.needsUpdate = true;
    // so framing and picking see the instances, not the one shape at the origin
    part.computeBoundingBox();
    part.computeBoundingSphere();
    part.userData.trace = true;
    group.add(part);
  }
  return group;
}

/** The shape a pixel is drawn as, at size 1 and pointing along z, as
 *  magpylib's `make_Pixels` draws it: an arrow is a five-sided shaft of
 *  half the size behind a head as wide as the size, tail to tip two sizes
 *  long with the pixel in the middle; a cone is two sizes tall, a cube one
 *  size across. Built per sensor, so disposing a node disposes nothing shared. */
function pixelShape(symbol) {
  if (symbol === "cube") return [new THREE.BoxGeometry(1, 1, 1)];
  if (symbol === "cone") {
    const cone = new THREE.ConeGeometry(0.5, 2, 5);
    cone.rotateX(Math.PI / 2); // three's cones stand on y; a reading points along z
    return [cone];
  }
  const shaft = new THREE.CylinderGeometry(0.25, 0.25, 1, 5);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, -0.5);
  const head = new THREE.ConeGeometry(0.5, 1, 5);
  head.rotateX(Math.PI / 2);
  head.translate(0, 0, 0.5);
  return [shaft, head];
}

function buildScatter(item) {
  const geometry = new THREE.BufferGeometry();
  const position = withPenLifts(item.position);
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  boundByFinitePoints(geometry, position);
  const group = new THREE.Group();
  if (item.lines) {
    // plain GL lines ignore width; Line2 would honour it, at the cost of an
    // addon and a resolution uniform
    group.add(
      new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
          color: new THREE.Color(item.line_color),
          transparent: item.opacity < 1,
          opacity: item.opacity,
        }),
      ),
    );
  }
  if (item.markers) {
    group.add(
      new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          color: new THREE.Color(item.marker_color),
          size: item.marker_size * window.devicePixelRatio,
          sizeAttenuation: false, // pixels, as plotly's markers are
        }),
      ),
    );
  }
  group.name = item.name;
  group.userData.trace = true;
  // an object's path, not the object: outlined apart from it (`outline`)
  group.userData.path = Boolean(item.path);
  return group;
}

/** One object, or everything drawn, as a sphere -- null if there is nothing
 *  to look at. */
/** The sphere round `objectIds` -- one id or several -- or, when none of them
 *  is drawn, round everything that is showing. */
function sceneSphere(objectIds) {
  const box = new THREE.Box3();
  const chosen = drawnFor([].concat(objectIds ?? []))
    .map((objectId) => byObjectId.get(objectId))
    .filter(Boolean);
  if (chosen.length) {
    for (const node of chosen) box.expandByObject(node);
  } else {
    // A hidden object is not part of what is being looked at.
    for (const node of byObjectId.values()) {
      if (node.visible) box.expandByObject(node);
    }
    // the graduated box sits a little outside the objects, and framing the
    // scene without its scale showing would cut the numbers off
    if (axes?.visible) box.expandByObject(axes);
  }
  if (box.isEmpty()) return null;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  // A box with a NaN bound is not empty, and every number taken from it is
  // NaN: better no answer than one that silently blanks the view.
  return Number.isFinite(sphere.radius) ? sphere : null;
}

/** Select `objectIds`: outline them, and put the handles on them.
 *
 * Edges rather than a tint or an emissive glow: colour *is* the data here --
 * it carries magnetization direction and field magnitude -- so a highlight
 * that repainted the object would overwrite what the user is looking at. And
 * no glow: that is a second render of every frame, and its halo bleeds onto
 * the neighbours in a ring of magnets, which is where telling them apart
 * matters. See `outline`.
 */
function highlight(objectIds) {
  selectedIds = (Array.isArray(objectIds) ? objectIds : [objectIds]).filter(
    Boolean,
  );
  setGizmoMode(gizmoMode); // the handles belong to whatever is selected now
  drawOutlines();
}

/** Outline the selection afresh, round whatever is drawn for it now. */
function drawOutlines() {
  takeOff(outlines);
  outlines = outline(selectedIds, 1);
}

/** Where a drag of several objects turns about: the middle of what is
 *  selected, which is the only point that belongs to all of them. */
function selectionCentre() {
  const middle = new THREE.Vector3();
  let counted = 0;
  for (const objectId of selectedIds) {
    const node = byObjectId.get(objectId);
    if (node) {
      middle.add(node.getWorldPosition(new THREE.Vector3()));
      counted++;
    }
  }
  return counted ? middle.divideScalar(counted) : null;
}

/** Put the whole scene in view, accounting for both field-of-view angles.
 *
 * The first attempt offset the camera by a fixed multiple of the largest span
 * and never checked the result: it ignored the aspect ratio, and a wide flat
 * assembly -- a halbach ring is exactly that -- came out clipped. This solves
 * for the distance instead, taking whichever of the two angles is tighter.
 * The panel is usually wider than tall, which makes the *vertical* angle the
 * limiting one, so guessing from the horizontal was wrong twice over.
 */
function fitView(objectIds) {
  const sphere = sceneSphere(objectIds);
  if (!sphere) return;

  // Framing should not also spin the view: keep the angle the camera is
  // already at. On the very first fit there is none, and an off-axis start
  // shows three faces of a box, which reads as depth where face-on does not.
  const looking = camera.position.clone().sub(controls.target);
  const direction =
    looking.lengthSq() > 0
      ? looking.normalize()
      : new THREE.Vector3(0.55, -0.68, 0.48).normalize();

  let distance;
  if (camera.isOrthographicCamera) {
    // No perspective, so distance decides nothing but clipping: the frustum
    // is what frames the scene.
    frustumHeight = sphere.radius * 2 * 1.1;
    distance = sphere.radius * 4;
  } else {
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
    distance =
      (sphere.radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.1;
  }
  camera.near = camera.isOrthographicCamera
    ? -sphere.radius * 8 // ortho may see behind itself; a box, not a cone
    : Math.max(distance / 5000, 1e-6);
  camera.far = distance * 20;
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  applyProjection();
  controls.target.copy(sphere.center);
  controls.update();
  if (snapping) setSnapping(true); // the step follows the scene's size
}

/** Fit whichever camera is in use to the canvas it draws on. */
function applyProjection() {
  const size = renderer.getSize(new THREE.Vector2());
  const aspect = size.x / size.y || 1;
  if (camera.isOrthographicCamera) {
    const half = frustumHeight / 2;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}

/** Swap between a perspective view and a parallel one, from where the camera
 *  already is. Returns the projection now in use.
 *
 * A parallel projection is how you tell whether two things line up: equal
 * lengths draw equal wherever they sit, so a ring of magnets can be checked
 * against its axis rather than judged through the foreshortening.
 */
function toggleProjection() {
  if (!camera) return "perspective";
  const target = controls.target.clone();
  const offset = camera.position.clone().sub(target);
  const wasOrthographic = camera.isOrthographicCamera;

  if (wasOrthographic) {
    camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  } else {
    // Keep what is on screen the same size across the swap: at the target,
    // a perspective camera shows this much.
    frustumHeight =
      2 * offset.length() * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  }
  camera.up.set(0, 0, 1);
  camera.position.copy(target).add(offset);
  // Rebuilt rather than repointed: the orbit controls read the camera in a
  // dozen places and were handed it once, and a stale reference in any of
  // them is a view that half moves.
  controls.dispose();
  controls = orbit();
  controls.target.copy(target);
  gizmo.camera = camera; // this one has a setter that passes it on
  applyProjection();
  camera.lookAt(target);
  controls.update();
  return wasOrthographic ? "perspective" : "parallel";
}

/** Orbit controls for the camera now in use, reporting every move of it. */
function orbit() {
  const made = new OrbitControls(camera, renderer.domElement);
  made.addEventListener("change", () => {
    redraw();
    cameraMoved?.();
  });
  return made;
}

/** Where the view is looking from, as a host can keep it and hand it back to
 *  `setCamera` -- in another page, even, which is what an export does. */
function cameraState() {
  if (!camera) return null;
  return {
    projection: camera.isOrthographicCamera ? "parallel" : "perspective",
    position: camera.position.toArray(),
    target: controls.target.toArray(),
    up: camera.up.toArray(),
    zoom: camera.zoom,
    height: frustumHeight,
    near: camera.near,
    far: camera.far,
  };
}

/** Look from where `cameraState` said. Returns the projection now in use. */
function setCamera(state) {
  if (!camera || !state) return;
  // A perspective camera has no `isOrthographicCamera` at all -- undefined,
  // not false -- and compared as it stands, every perspective state handed
  // back to a perspective camera turned it parallel.
  const parallel = Boolean(camera.isOrthographicCamera);
  if ((state.projection === "parallel") !== parallel) {
    toggleProjection();
  }
  frustumHeight = state.height;
  camera.up.fromArray(state.up);
  camera.position.fromArray(state.position);
  camera.zoom = state.zoom;
  camera.near = state.near;
  camera.far = state.far;
  controls.target.copy(new THREE.Vector3().fromArray(state.target));
  applyProjection();
  camera.lookAt(controls.target);
  controls.update();
  framed = true; // a view that was looked at, not one to frame
  return state.projection;
}

/** The view as a PNG data URL, as it is on screen. Drawn again for it rather
 *  than read off the canvas: WebGL lets go of what it drew once that is
 *  shown, so what is on screen is no longer there to read. The view alone --
 *  nothing a host floats over it, legend or controls, is in the picture. */
function snapshot() {
  if (!renderer) return null;
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL("image/png");
}

/** The view copied onto a canvas of its own, drawn again for it as the
 *  snapshot is: for a host to show in its place while this renderer draws
 *  something else. A copy rather than a PNG, which would be encoded on the
 *  spot, only to be decoded again to be shown. */
function still() {
  if (!renderer) return null;
  renderer.render(scene, camera);
  const source = renderer.domElement;
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext("2d").drawImage(source, 0, 0);
  return copy;
}

/** Tell `listener` whenever the camera moves: a drag, a zoom, a key, a fit.
 *  One at a time -- the host this renderer is drawing for. */
function watchCamera(listener) {
  cameraMoved = listener;
}

/** Drag in round numbers, or freely. Returns the step now in force.
 *
 * The step follows the scene rather than being a constant: a stride that
 * suits a scene measured in metres would pin a millimetre one to its origin,
 * and magpylib scenes are written at whatever scale the object is.
 */
function setSnapping(on) {
  snapping = on;
  if (!gizmo) return null;
  const sphere = sceneSphere();
  const rough = (sphere ? sphere.radius : 1) / 10;
  const decade = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 5, 10].find((n) => rough <= n * decade * 1.5) * decade;
  gizmo.translationSnap = on ? step : null;
  gizmo.rotationSnap = on ? THREE.MathUtils.degToRad(15) : null;
  gizmo.scaleSnap = on ? 0.1 : null;
  return on ? step : null;
}

/** A short string as a flat label that always faces the camera. */
function textSprite(text, color, height) {
  const canvas = document.createElement("canvas");
  const size = 64;
  let context = canvas.getContext("2d");
  context.font = `${size}px sans-serif`;
  canvas.width = Math.ceil(context.measureText(text).width) + 8;
  canvas.height = Math.ceil(size * 1.3);
  context = canvas.getContext("2d"); // resizing the canvas clears its state
  context.font = `${size}px sans-serif`;
  context.fillStyle = color;
  context.textBaseline = "middle";
  context.fillText(text, 4, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    }),
  );
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  sprite.raycast = () => {}; // scenery, not a target
  return sprite;
}

/** A step that lands on round numbers, near the size asked for. */
function niceStep(rough) {
  const decade = Math.pow(10, Math.floor(Math.log10(rough)));
  return [1, 2, 5, 10].find((n) => rough <= n * decade * 1.5) * decade;
}

/** The box, ticks and names that say how big any of this is.
 *
 * Magpylib scenes are measurements, and a view of one that does not say what
 * scale it is at leaves you judging a magnet by eye. Plotly draws a graduated
 * cube; this is the same idea with the labels magpylib itself supplies, so
 * the units follow whatever the scene is drawn in.
 */
function drawAxes(ranges, labels) {
  if (axes) {
    scene.remove(axes);
    axes.traverse((child) => {
      child.geometry?.dispose();
      child.material?.map?.dispose();
      child.material?.dispose();
    });
    axes = null;
  }
  if (!ranges) return;

  const low = new THREE.Vector3(ranges[0][0], ranges[1][0], ranges[2][0]);
  const high = new THREE.Vector3(ranges[0][1], ranges[1][1], ranges[2][1]);
  const span = high.clone().sub(low);
  const ink = cssColor("--vscode-editorLineNumber-foreground", "#888");
  const text = Math.max(span.x, span.y, span.z) / 28;

  axes = new THREE.Group();
  const box = new THREE.Box3Helper(
    new THREE.Box3(low, high),
    new THREE.Color(ink),
  );
  box.material.transparent = true;
  box.material.opacity = 0.35;
  box.raycast = () => {};
  axes.add(box);

  // Ticks on the three edges that meet at one corner: on all twelve they
  // would be unreadable, and one of each is enough to read a length off.
  const along = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  const names = [labels?.x ?? "x", labels?.y ?? "y", labels?.z ?? "z"];
  for (let axis = 0; axis < 3; axis++) {
    const from = low.getComponent(axis);
    const to = high.getComponent(axis);
    const step = niceStep((to - from) / 5);
    const outward = along[(axis + 1) % 3]
      .clone()
      .add(along[(axis + 2) % 3])
      .multiplyScalar(-text);
    for (
      let value = Math.ceil(from / step) * step;
      value <= to + step / 2;
      value += step
    ) {
      const at = low.clone();
      at.setComponent(axis, value);
      const label = textSprite(
        Number(value.toPrecision(4)).toString(),
        ink,
        text,
      );
      label.position.copy(at).add(outward);
      axes.add(label);
    }
    const name = textSprite(names[axis], ink, text * 1.2);
    name.position
      .copy(low)
      .setComponent(axis, (from + to) / 2)
      .add(outward.clone().multiplyScalar(2.4));
    axes.add(name);
  }
  axes.visible = axesShown;
  scene.add(axes);
  // Placed now, not at the first frame. A Box3Helper is the unit cube it is
  // built as until `updateMatrixWorld` fits it to its box, which a render
  // calls and a measurement does not -- and the first fit, which frames the
  // axes with the objects, comes before any render. Measured unplaced, a
  // scene in centimetres was framed as two metres of nothing round a speck.
  axes.updateMatrixWorld(true);
}

/** Drop every node but the ones held, freeing what they hold on the GPU.
 *  This runs on every edit: a colorscale texture per mesh, left to
 *  accumulate, is a leak. */
/** Take what is drawn on `node` off it, and free it. The node itself stays,
 *  and whatever is attached to it -- the handles -- with it. */
function clearNode(node) {
  for (const child of [...(node?.children ?? [])]) {
    node.remove(child);
    child.traverse((part) => {
      part.geometry?.dispose();
      part.material?.map?.dispose();
      part.material?.dispose();
    });
  }
}

/** Every item a payload draws: its meshes, its scatters and -- in a scene
 *  the engine drew -- its sensors' pixels. A frame of a run has no pixels
 *  of its own; its sensors came as meshes. */
function drawnItems(payload) {
  return payload.meshes.concat(payload.scatters, payload.pixels ?? []);
}

function discard(held) {
  for (const [objectId, node] of byObjectId) {
    if (held.has(objectId)) continue;
    scene.remove(node);
    node.traverse((child) => {
      child.geometry?.dispose();
      child.material?.map?.dispose();
      child.material?.dispose();
    });
    byObjectId.delete(objectId);
  }
}

/** How many poses the longest path in the scene runs through. */
function frameCount() {
  return Object.values(paths).reduce(
    (most, path) => Math.max(most, path.position.length),
    1,
  );
}

/** Draw one captured frame of the scene's paths.
 *
 * The traces arrive already at that step's pose -- and, for anything the
 * field decides, already recomputed for it -- so the nodes carry no transform
 * of their own here. A sensor's arrows turn as the magnet that makes them
 * turns, and that is not something moving a mesh about can show.
 */
function renderFrame(payload) {
  discard(new Set());
  // Frames and poses are two ways of playing a run, never both: a frame is
  // drawn afresh, so there is nothing of the first frame's left to move.
  tracks = null;
  tracked = [];
  changes = [];
  changing = [];
  luts = payload.luts ?? [];
  for (const item of drawnItems(payload)) {
    const node = nodeFor(item.object_id, null);
    node.quaternion.identity(); // the geometry already holds the pose
    node.add(buildItem(item));
  }
  placeCollections();
  // round the nodes just built, not the ones discarded
  drawOutlines();
  drawHints();
}

/** Put each moving trace where it is at step `index` of the run, when the
 *  payload carried the run as motion. Nothing is built: the traces are the
 *  first frame's, moved, which magpylib's frames are to rounding -- the
 *  engine checked before it sent the poses instead.
 *
 * A pose is the move from the first step, about the world's origin; the
 * trace hangs on its object's node, so it is carried into the node's frame
 * by the matrix it was hung with. */
function poseFrame(index) {
  const pose = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (const { built, rest, track } of tracked) {
    const steps = tracks[track];
    const [x, y, z, qx, qy, qz, qw] = steps[Math.min(index, steps.length - 1)];
    pose.compose(at.set(x, y, z), turn.set(qx, qy, qz, qw), one);
    built.matrix.copy(rest).multiply(pose);
    built.matrix.decompose(built.position, built.quaternion, built.scale);
  }
  // What changes is drawn as it is at this step, in place of the last.
  for (const entry of changing) {
    const steps = changes[entry.changes];
    const item = steps[Math.min(index, steps.length - 1)];
    entry.node.remove(entry.built);
    entry.built.traverse((part) => {
      part.geometry?.dispose();
      part.material?.map?.dispose();
      part.material?.dispose();
    });
    entry.built = buildItem(item);
    entry.node.attach(entry.built);
  }
  // What moved carries its outline; what was built again needs a new one.
  if (changing.length) {
    drawOutlines();
    drawHints();
  }
}

/** Whether the run can be played here, by `poseFrame`, with nothing to ask
 *  for -- including a run in which nothing drawn moves, whose steps change
 *  nothing on screen. */
const posed = () => tracks !== null;

/** Handles have no place on something moving of its own accord: a drag would
 *  fight the playback for the same object. */
function setPlaying(on) {
  playing = on;
  if (on) gizmo?.detach();
  else setGizmoMode(gizmoMode);
  return playing;
}

/** The object the sidebar is showing, which is the one single-object
 *  gestures act on. First in, so a shift-click keeps its meaning. */
function primaryId() {
  return selectedIds[0];
}

/** What a drag would have recorded, for a pose said in numbers instead.
 *
 * A drag moves an object by moving every frame of its path: a sensor that
 * sweeps through a gap *is* a track, and putting it somewhere means putting
 * the track there — not replacing it with the single pose it was left at.
 * Typing into the readout has to mean the same thing, or the two ways of
 * saying where something goes leave different documents, and the typed one
 * quietly throws a path away.
 *
 * The reference is where the object is, which is what the boxes read out: a
 * typed value is a destination, and the whole track moves so that the object
 * arrives at it.
 */
function poseEdit(objectId, field, numbers) {
  const path = paths[objectId];
  if (!path || (field !== "position" && field !== "orientation")) {
    return numbers;
  }
  if (field === "position") {
    const delta = new THREE.Vector3()
      .fromArray(numbers)
      .sub(new THREE.Vector3().fromArray(anchors[objectId] || [0, 0, 0]));
    return path.position.map((frame) =>
      new THREE.Vector3().fromArray(frame).add(delta).toArray(),
    );
  }
  // The turn that takes it from where it points to what was typed, applied to
  // every frame: each one turns by the same amount, so the track keeps its
  // shape -- the same rule `report` follows for a drag.
  const turned = quaternionOf(numbers).multiply(
    quaternionOf(orientations[objectId]).invert(),
  );
  return path.orientation.map((frame) =>
    rotvecOf(turned.clone().multiply(quaternionOf(frame))),
  );
}

/** The object after this one, so a keystroke can walk the scene. */
function nextObject(objectId, step = 1) {
  const drawn = [...byObjectId]
    .filter(([id, node]) => id && node.visible && !node.userData.collection)
    .map(([id]) => id);
  if (!drawn.length) return undefined;
  const at = drawn.indexOf(objectId);
  // from nothing, forward starts at the first object and back at the last
  if (at === -1) return step > 0 ? drawn[0] : drawn.at(-1);
  return drawn[(at + step + drawn.length) % drawn.length];
}

/** What each key does to a view, in every host that draws one.
 *
 * Framing, the axis views and the projection move the camera, which is this
 * module's, so `viewKey` does them. The rest name something the host owns --
 * the selection, the run, what is hidden -- and the host is asked, by calling
 * its function of the same name. A host without one, or whose one answers
 * false, has declined, and the key goes on to whatever else wants it: the
 * notebook widget declines Tab, because in a notebook Tab moves between
 * cells. The panel adds its handles' keys around these.
 */
const VIEW_KEYS = {
  f: "frame", // the selection, or everything when nothing is selected
  Home: "frameAll",
  1: "front",
  3: "right",
  7: "top",
  5: "projection",
  Tab: "next", // shift: the one before
  " ": "play",
  h: "hide", // shift: show only the selection, or everything again
  c: "parent", // the collection the selection is in; again, the one round it
  Escape: "deselect",
};

// Where the camera stands, from what it looks at, for each axis view.
const AXIS_VIEWS = { front: [0, -1, 0], right: [1, 0, 0], top: [0, 0, 1] };

/** Do what `event` asks of the view, asking `host` for its part. Answers
 *  whether the key was taken, so the host knows to stop it going further. */
function viewKey(event, host = {}) {
  // A chord is the application's, not the view's: cmd-F finds, ctrl-H is not H.
  if (event.metaKey || event.ctrlKey || event.altKey || !camera) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const action = VIEW_KEYS[key];
  const ask = (answer, argument) =>
    typeof answer === "function" && answer(argument) !== false;
  switch (action) {
    case undefined:
      return false;
    case "frame":
      fitView(selectedIds);
      return true;
    case "frameAll":
      fitView();
      return true;
    case "front":
    case "right":
    case "top":
      axisView(...AXIS_VIEWS[action]);
      return true;
    case "projection":
      host.projection?.(toggleProjection());
      return true;
    case "next":
      return ask(
        host.next,
        nextObject(selectedIds[0], event.shiftKey ? -1 : 1),
      );
    case "hide":
      return ask(host.hide, { isolate: event.shiftKey });
    case "parent":
      return selectedIds.length > 0 && ask(host.parent, selectedIds[0]);
    default: // play, deselect
      return ask(host[action]);
  }
}

/** Replace the drawn objects with `payload`, keeping the camera where it is.
 *
 * `keep` names one object to leave alone: the one being dragged. Everything
 * else in the scene is redrawn, because plenty of it is *derived* from the
 * dragged object -- a field's arrows turn as the magnet that makes them
 * moves, and no amount of moving a mesh locally will show that. The dragged
 * object itself is the one thing the picture usually has right, and swapping
 * its node out from under the gizmo mid-drag would end the drag.
 *
 * Usually: a sensor that draws its own reading -- pixels coloured, or drawn
 * as arrows, by the field they measure -- shows what it measured where the
 * drag began, carried along. The payload names those (`readings`). Their
 * node stays, with the handles on it, and what is drawn on it is replaced
 * like everything else: from the scene as the engine has it, which is a
 * round trip behind the pointer, and caught up by the next redraw.
 */
function render(canvasEl, payload, { keepCamera = true, keep = [] } = {}) {
  const held = new Set([].concat(keep ?? []));
  // What a dragged collection carries is held with it: rebuilt, it would be
  // drawn twice, once on the collection's node and once from the payload.
  for (const objectId of [...held]) {
    for (const each of collections[objectId] ?? []) held.add(each);
  }
  ensureRenderer(canvasEl);
  const background = cssColor("--vscode-editor-background", "#1e1e1e");
  scene.background = new THREE.Color(background);
  orientations = payload.orientations || {};
  anchors = payload.anchors || {};
  paths = payload.paths || {};
  // Where the handles stand in each object's own frame. The payload's poses
  // are the last frame of a path -- which is the pose the geometry is drawn
  // at -- so this is what lets playback put a node back at any other one.
  pivots = {};
  for (const [objectId, anchor] of Object.entries(anchors)) {
    const turn = quaternionOf(orientations[objectId]);
    pivots[objectId] = new THREE.Vector3()
      .fromArray((payload.centroids || {})[objectId] || anchor)
      .sub(new THREE.Vector3().fromArray(anchor))
      .applyQuaternion(turn.clone().invert());
  }
  shapes = payload.shapes || {};
  polarizations = payload.polarizations || {};
  patterned = new Set(payload.patterned || []);
  collections = payload.collections || {};
  centroids = payload.centroids || {};

  discard(held);
  const readings = new Set(payload.readings ?? []);
  for (const objectId of held) {
    if (readings.has(objectId)) clearNode(byObjectId.get(objectId));
  }
  tracks = payload.tracks ?? null;
  tracked = [];
  changes = payload.changes ?? [];
  changing = [];
  luts = payload.luts ?? [];
  // `attach` keeps each trace where magpylib put it while re-parenting it, so
  // the baked world coordinates survive the move onto the object's own node.
  for (const item of drawnItems(payload)) {
    if (held.has(item.object_id) && !readings.has(item.object_id)) continue;
    const node = nodeFor(item.object_id, payload.centroids[item.object_id]);
    const built = buildItem(item);
    node.attach(built);
    if (item.track != null) {
      tracked.push({ built, rest: built.matrix.clone(), track: item.track });
    }
    if (item.changes != null) {
      changing.push({ node, built, changes: item.changes });
    }
  }
  placeCollections();

  // Size first: the fit depends on the aspect ratio, and on the very first
  // render the canvas may not have been laid out yet.
  resize(canvasEl);
  // The axes before the fit, which frames them with the objects: fitted
  // first, a renderer's first scene was framed without its box -- or with the
  // last scene's -- and came up zoomed in, the numbers off the edge, unless
  // something happened to fit it again.
  drawAxes(payload.ranges, payload.labels);
  // Refit when there was nothing to look at before. A scene that arrives
  // empty and is filled by a later refresh -- which is what a parametric
  // example does -- would otherwise keep the camera fitted to the empty one.
  if (!keepCamera || !framed) {
    fitView();
    framed = [...byObjectId.values()].some((node) => !node.userData.collection);
  }
  // Lines and points are hit within a radius of the ray, measured in world
  // units: a fixed one would miss a scene in metres and swallow one in
  // millimetres, so scale it to what is on screen.
  const sphere = sceneSphere();
  raycaster.params.Points.threshold = sphere ? sphere.radius / 100 : 1;
  raycaster.params.Line.threshold = raycaster.params.Points.threshold;
  // Mid-drag the selected object is the one that was *not* rebuilt, and
  // re-attaching the gizmo to it would interrupt the drag in progress: the
  // outline is drawn again, round what was, and the handles left alone.
  if (!held.size) highlight(selectedIds);
  else drawOutlines();
  drawHints();
}

/** `api`, each of whose functions asks for a frame once it has run.
 *
 * Done here, once, rather than in each: what a host calls is what changes the
 * picture, and a function that forgot to ask would leave the view showing the
 * scene before it -- until something else happened to draw. One that only
 * reads costs a frame nobody sees, which is cheap beside that. */
function drawingAfter(api) {
  const wrapped = {};
  for (const [name, value] of Object.entries(api)) {
    wrapped[name] =
      typeof value === "function"
        ? (...args) => {
            try {
              return value(...args);
            } finally {
              redraw();
            }
          }
        : value;
  }
  return wrapped;
}

/** Everything a host may drive the view with.
 *
 * Exported *and* on `window`: the panel's classic script reads the global,
 * while a host that imports this module -- the notebook widget, which loads
 * it once per view so that two scenes on a page are two scenes -- takes the
 * export and so gets the instance it just made rather than the last one made.
 */
export const scene3d = drawingAfter({
  render,
  fitView,
  highlight,
  hint,
  setAxes,
  setHidden,
  setGizmoMode,
  constrainAxis,
  setSnapping,
  toggleProjection,
  cameraState,
  setCamera,
  watchCamera,
  snapshot,
  still,
  setPlaying,
  renderFrame,
  poseFrame,
  posed,
  frameCount,
  nextObject,
  setSpace,
  spaceOf,
  toggleSpace,
  setSpaces,
  axisView,
  viewKey,
  poseEdit,
  canResize: (objectId) => Boolean(shapes[objectId]),
  canAim: (objectId) => Boolean(polarizations[objectId]),
  byObjectId,
});

// The first instance keeps the name. The notebook widget makes one of these
// per view, from a blob, and the studio's script panel draws that widget
// beside its own copy of this file -- which would otherwise lose `window`'s
// renderer to the widget's the moment one was drawn, and draw its next plain
// scene with a renderer the widget still holds.
window.scene3d ??= scene3d;
