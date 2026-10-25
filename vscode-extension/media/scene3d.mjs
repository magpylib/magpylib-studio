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
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const scene = new THREE.Scene();
let host = null; // the element the view is hung in; whose theme it wears
let sizing = null; // watches the host for a size change, wherever it is now
let sighting = null; // and whether it is on screen, for a current's flow
let inSight = true;
let camera = null;
let controls = null;
let renderer = null;
const raycaster = new THREE.Raycaster();
// The layer a trace drawn in a batch is kept on: picked, never drawn
// (`rebatch`).
const BATCHED = 1;
raycaster.layers.enable(BATCHED);
const byObjectId = new Map();
// What the host has hidden. By id, and held here rather than on the nodes:
// every redraw and every frame of a run rebuilds those, and a visibility set
// on one from outside would last only until the next.
let hiddenIds = new Set();
// How faintly the host has each object drawn, as a share of its own opacity.
// By id and held here, as hiding is, for the same reason.
let fades = new Map();
let framed = false;
// What marks the selection, each `{ on, part }`: a part hung on the trace it
// marks, so a drag or a step of a run carries it along. See `outline`.
let outlines = [];
// A fainter mark, for what the host is pointing at rather than what is
// selected -- a legend row under the pointer -- and for what is under the
// pointer in the view (`hover`). By id, so it can be drawn again round
// whatever a redraw builds for them.
let hintIds = [];
let hoveredId = null;
// What overlaps what, as pairs of ids: shaded in amber where the two
// interpenetrate, and marked in amber round each, as the selection is in
// green. Each scene the engine sends says which (`overlaps`), so the marks
// follow a drag frame by frame. They are found where each path ends
// (`endOverlaps`) and, where something moves, at every step
// (`stepOverlaps`), so a run shows each step's own.
const NO_OVERLAPS = Object.freeze([]);
let endOverlaps = NO_OVERLAPS;
let stepOverlaps = null;
let overlaps = NO_OVERLAPS;

/** What overlaps at frame `index` of a run of `frames`: the step it shows,
 *  where the scene says each step's, else where the paths end and nothing
 *  before. A run may have fewer frames than its paths have steps. */
function overlapsAt(index, frames) {
  if (!stepOverlaps) return index >= frames - 1 ? endOverlaps : NO_OVERLAPS;
  const steps = stepOverlaps.length;
  const step =
    frames > 1 ? Math.round((index * (steps - 1)) / (frames - 1)) : steps - 1;
  return stepOverlaps[Math.min(Math.max(step, 0), steps - 1)];
}

/** The ids that `pairs` name, each once. */
function idsOf(pairs) {
  return [...new Set(pairs.flat())];
}

/** A pair as one key, whichever way round it is named. */
function pairKey(pair) {
  return [...pair].sort().join("\n");
}
let hints = [];
let axes = null; // the box, ticks and names that give the scene a scale
let axesFor = null; // { ranges, labels } it is drawn for: see `drawAxes`
// How the host wants the scale said: "box", "cube" -- the view cube and the
// scale bar, in a corner -- or "none". Held here, like hiding, because the box
// is drawn again on every redraw.
let axesMode = "cube";
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
// Source id -> its pattern's copies, in the order the pattern laid them: the
// path a trace follows while the source is selected.
let copies = {};
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
    sighting ??= new IntersectionObserver((entries) => {
      inSight = entries[entries.length - 1].isIntersecting;
      redraw(); // back in sight, a current flows on from where it is
    });
    sighting.disconnect();
    sighting.observe(canvasEl);
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
  if (drawnBySoftware()) flowFrameMs = SOFTWARE_FLOW_FRAME_MS;

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
  // and a page shown again flows on, as a view back in sight does
  document.addEventListener("visibilitychange", redraw);
  watchPicks();
  makeGizmo();
  makeGrips();
  watchGrips();
}

/** Draw the view at the next frame, once however many ask before then.
 *
 * On demand rather than every frame: a notebook holds a view per cell, most
 * of them scrolled away and all of them idle most of the time, and a render
 * loop apiece keeps the GPU drawing every one of them sixty times a second.
 * So whatever changes the picture asks for a frame -- the orbit and the
 * handles as they move, a new size, and every call a host makes (see
 * `drawingAfter`) -- and nothing else draws. The exceptions are the flow, a
 * current's or the field's, which asks for the next frame from each one it
 * draws, and only while it is to be seen (`flowing`); and a turn to an axis
 * view and the corner growing or shrinking, which ask until they are done
 * (`moving`). */
let frameAsked = false; // a frame is on its way
let frameWanted = false; // and something besides a current's flow wants it
let lastDrawn = 0;
let lastStep = 0; // when `moving` last moved something, or 0
function redraw() {
  frameWanted = true;
  askFrame();
}

function askFrame() {
  if (!renderer || frameAsked) return;
  frameAsked = true;
  requestAnimationFrame(drawFrame);
}

function drawFrame(now) {
  frameAsked = false;
  const moved = moving(now);
  if (moved) frameWanted = true;
  const flows = flowing();
  if (flows || moved) askFrame();
  // the flow alone draws no faster than `flowFrameMs`, whatever the display
  if (!frameWanted && (!flows || now - lastDrawn < flowFrameMs)) return;
  frameWanted = false;
  lastDrawn = now;
  if (flows) flowClock.value = ((now / 1000) * FLOW_RATE) % 1;
  sizeGrips();
  drawPicture(now);
  drawCorner(true);
}

/** The scene, and the marks over it: everything but the corner. */
function drawPicture(now = performance.now()) {
  keepBatches();
  const cues = cuesAt(now);
  lookOfOverlaps(cues);
  // The handles go over the marks, which would otherwise be laid over them
  // where they cross a selection's outline: drawn last, on their own. They
  // are drawn through everything anyway (`HANDLE_LOOK`).
  const handles = [gizmo?.getHelper(), grips, dots, snapMark].filter(
    (root) => root?.visible,
  );
  for (const root of handles) root.visible = false;
  try {
    renderer.render(scene, camera);
  } finally {
    for (const root of handles) root.visible = true;
  }
  drawRegions();
  drawMarks();
  if (handles.length) {
    renderer.autoClear = false;
    for (const root of handles) renderer.render(root, camera);
    renderer.autoClear = true;
  }
}

/** Take a step of what is on its way -- a turn to an axis view, the corner
 *  growing or shrinking, a mark settling -- for the frame drawn at `now`;
 *  whether anything moved. All step, not one or the others: `|`, not `||`. */
function moving(now) {
  const elapsed = lastStep ? Math.min(now - lastStep, 50) : 16;
  const moved = stepTurn(now) | growCorner(elapsed) | settling(now);
  lastStep = moved ? now : 0;
  return Boolean(moved);
}

/** Whether the view is drawn without a GPU -- SwiftShader, llvmpipe, a
 *  basic render driver -- as a browser draws on a machine without one, or
 *  with it turned off. */
function drawnBySoftware() {
  const gl = renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const name = gl.getParameter(
    debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER,
  );
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(
    String(name),
  );
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
 * A resize drags one magpylib value, not three: a Dipole has one size, so
 * the axes that value does not separate must not separate on screen either.
 * Applied to the node as the drag runs, so the handles cannot be pulled into
 * a shape the object could never take.
 */
function constrainScale(node, constraint) {
  const { x, y, z } = node.scale;
  if (constraint === "uniform") {
    // whichever axis was pulled furthest from 1 is the one being dragged
    const pulled = [x, y, z].reduce((a, b) =>
      Math.abs(b - 1) > Math.abs(a - 1) ? b : a,
    );
    node.scale.setScalar(pulled);
  }
}

/** The parameter value a scale comes to, from the one the drag started at. */
function resized(scale, shape, centre) {
  if (shape.constraint === "uniform") return shape.value * scale.x;
  const about = ([x, y, z]) => [
    centre.x + (x - centre.x) * scale.x,
    centre.y + (y - centre.y) * scale.y,
    centre.z + (z - centre.z) * scale.z,
  ];
  if (shape.constraint === "vertices" || shape.constraint === "points") {
    // A mesh has no dimension; the array is the parameter. It scales about
    // the centroid, because that is the point the handles are on -- for a
    // shape whose position is already its centre that is the origin, and
    // this is the plain multiplication it looks like. A current's or a
    // triangle's vertices the same way.
    return shape.value.map(about);
  }
  if (shape.constraint === "pixels") {
    // A sensor's pixels the same way, nested as they came: a list or a grid.
    const spread = (value) =>
      Array.isArray(value[0]) ? value.map(spread) : about(value);
    return spread(shape.value);
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
    if (from.point) {
      // The points held, carried as the handles carried their stand-in --
      // moved, or turned or scaled about their middle -- in the object's
      // own frame, as magpylib keeps its vertices.
      const [objectId] = from.objectIds;
      node.updateMatrixWorld(true);
      const carry = from.point.frame
        .clone()
        .invert()
        .multiply(node.matrixWorld)
        .multiply(from.point.start.clone().invert())
        .multiply(from.point.frame);
      const still = carry.elements.every(
        (v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12,
      );
      if (still) return; // pressed, not moved
      const value = nested(
        from.point.like,
        from.point.value.map((p, i) =>
          from.point.indices.includes(i)
            ? new THREE.Vector3().fromArray(p).applyMatrix4(carry).toArray()
            : p,
        ),
      );
      host.dispatchEvent(
        new CustomEvent("objecttransform", {
          detail: {
            preview,
            edits: [{ objectId, shape: { attr: from.point.attr, value } }],
          },
        }),
      );
      return;
    }
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
          // and about where, in the object's frame: pixels a variable
          // decides are stretched there as a formula (`apply_edits`)
          about: from.centre.toArray(),
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
      node.updateMatrixWorld(true);
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
        // a point picked up, and the points as they were
        point:
          node === pointProxy
            ? {
                indices: node.userData.indices,
                attr: shapes[primary].attr,
                // the object's frame, and the stand-in in it, as they began
                frame: frameOf(primary),
                start: node.matrixWorld.clone(),
                like: shapes[primary].value, // its nesting, to write back in
                value: pointsOf(shapes[primary].value).map((p) => [...p]),
              }
            : null,
        polarization:
          gizmoMode === "polarization"
            ? new THREE.Vector3()
                .fromArray(polarizations[primary])
                .applyQuaternion(orientation) // stored local, turned in world
            : null,
      };
      // What a drag with Shift snaps to, and -- moving whole objects -- the
      // vertices of its own it snaps with, in the frame of what is dragged.
      from.targets = snapTargets(new Set(drawnFor(objectIds)));
      from.own =
        node === proxy || node === pointProxy ? [] : drawnPointsOf(node);
      // `redrawn`: the handles are on a stand-in, so the object's own node
      // is drawn again from the engine as the drag goes, not kept
      host.dispatchEvent(
        new CustomEvent("dragstart", {
          detail: {
            objectIds: from.objectIds,
            mode: gizmoMode,
            redrawn: node === proxy || node === pointProxy,
          },
        }),
      );
    } else {
      showSnap(null);
      if (dragCancelled) {
        // Esc: the drag is taken back, not recorded -- see `cancelDrag`
        dragCancelled = false;
        host.dispatchEvent(
          new CustomEvent("objecttransform", {
            detail: { preview: false, cancel: true, edits: [] },
          }),
        );
      } else {
        report(false); // the one that gets recorded and redrawn
      }
      for (const each of from.hung) {
        if (each.parent === node) scene.attach(each);
      }
      releasePaths(from.pathTraces);
      from = null;
      redraw(); // and the flow goes on
    }
  });
  // A handle lit under the pointer, or moved by it.
  gizmo.addEventListener("change", redraw);
  gizmo.addEventListener("objectChange", () => {
    if (from?.shape) constrainScale(gizmo.object, from.shape.constraint);
    if (from) snapDragged(gizmo.object, from);
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

/** The resizes the engine draws as they go, whose drawings do not scale
 *  with what they draw: a sensor's cross and pixels, a current's arrows
 *  keep their styled size (`threejs.SCALE_COVARIANT`). */
const REDRAWN_RESIZES = new Set(["pixels", "points"]);

/** Whether the handles go on the stand-in: see `setGizmoMode`. */
function standsIn() {
  const objectId = primaryId();
  return (
    gizmoMode === "polarization" ||
    patterned.has(objectId) ||
    (gizmoMode === "scale" && REDRAWN_RESIZES.has(shapes[objectId]?.constraint))
  );
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
  // a shape with grips of its own resizes by them, in place of the handles
  const alone = gizmoMode === "scale" && !together;
  flatAxes = alone ? flatOf(primaryId()) : new Set();
  showAxes();
  placeGrips(alone ? primaryId() : null);
  if (gripped) {
    gizmo.detach();
    return gizmoMode;
  }
  // and one written as points has a dot on each, a picked one the move
  // handles; a point stays picked only while its object is resized
  if (!alone || chosenPoint?.objectId !== primaryId()) chosenPoint = null;
  if (!alone || pickedPoints?.objectId !== primaryId()) pickedPoints = null;
  if (!pickedPoints) pointsMode = "translate";
  placeDots(alone ? primaryId() : null);
  if (placePointHandles()) return gizmoMode;
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
  // where they go. Nor about some resizes (`REDRAWN_RESIZES`). A node that is
  // going to be rebuilt cannot be the one the handles are on, so they go here
  // instead.
  if (standsIn()) {
    // A redraw mid-drag comes back through here (`highlight`), and the drag
    // is read off the stand-in: placed afresh, a release before the pointer
    // moved again would find no turn and no resize, and send nothing.
    if (gizmo.dragging && gizmo.object === proxy) return gizmoMode;
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

let lockedAxis = null; // the one axis the handles keep, by key, or none
let flatAxes = new Set(); // the axes a flat shape has no extent along

/** Restrict the handles to one axis, or to all of them again. */
function constrainAxis(axis) {
  lockedAxis = axis || null;
  showAxes();
}

/** The handles' axes: those the lock keeps, but for any the shape resized
 *  is flat along -- a triangle's, a sheet's or a pixel grid's own z, which
 *  a resize has nothing to stretch along. */
function showAxes() {
  if (!gizmo) return;
  for (const axis of ["x", "y", "z"]) {
    gizmo[`show${axis.toUpperCase()}`] =
      !flatAxes.has(axis) && (!lockedAxis || lockedAxis === axis);
  }
}

/** The axes `objectId`'s points have no extent along, in its own frame,
 *  where it resizes by its points. */
function flatOf(objectId) {
  const shape = shapes[objectId];
  if (!["vertices", "points", "pixels"].includes(shape?.constraint)) {
    return new Set();
  }
  const each = (value) =>
    Array.isArray(value[0]) ? value.flatMap(each) : [value];
  const points = each(shape.value);
  const extents = [0, 1, 2].map(
    (k) =>
      Math.max(...points.map((p) => p[k])) -
      Math.min(...points.map((p) => p[k])),
  );
  const most = Math.max(...extents);
  return new Set(["x", "y", "z"].filter((_, k) => extents[k] <= 1e-9 * most));
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

// --- grips --------------------------------------------------------------
//
// A resize by the shape's own numbers rather than by the handles' three
// axes. A grip per number, drawn as the handles are and standing out of the
// face that number moves: a Cuboid's six faces, a cylinder's curved face and
// its top and bottom, a segment's two radii and its flat ends, a sphere's or
// a loop's rim. A face is dragged along the grip and moves alone, the one
// opposite staying where it is, so the shape's middle -- its position --
// goes half the way; with ⌥ both move, and the position stays. A radius
// grows all round, and an angle is dragged round the axis. A drag is one
// edit -- the parameter, and the position where it moves -- through the
// handles' own events (`dragstart`, `objecttransform`), and the engine
// draws the shape as it goes.
//
// A shape written as points -- a tetrahedron, a triangle, a wire -- has a
// dot on each in the resize as well. Pointed at, a dot gets the move
// handles: dragged by the dot, the point moves freely, facing the view, and
// by an arrow along that axis -- that point alone. ⌘/ctrl-click picks
// several, and the handles hold them together, on their middle.

const grips = new THREE.Group(); // in the shape's own frame
grips.name = "grips";
grips.visible = false;
grips.matrixAutoUpdate = false;
let guide = null; // the line the dragged grip moves along
let gripped = null; // { objectId, attr, kind, scalar, value, frame } while shown
let gripping = null; // the drag in progress: see `watchGrips`
let gripHovered = null; // the grip under the pointer, by index
let gripPressed = false; // a press on a grip or a dot, which no pick may take
const MOST_GRIPS = 6;

/** The points' dots, in the same frame; and the stand-in the move handles
 *  go on when one is picked up. */
const dots = new THREE.Group();
dots.name = "dots";
dots.visible = false;
dots.matrixAutoUpdate = false;
let dotted = null; // { objectId, value, frame } while the dots are shown
let dotHovered = null;
let chosenPoint = null; // { objectId, index }: the point under the pointer
let pickedPoints = null; // { objectId, indices }: ⌘/ctrl-clicked, held
let pointsMode = "translate"; // what the handles do to points picked
let heldKey = ""; // the points the handles held, as last told: `announceHeld`
const pointProxy = new THREE.Object3D();

/** What a grip moves, by colour: x, y and z as the handles colour them, and
 *  r, phi and z for the round shapes -- red for a radius, green for an
 *  angle, blue for a height. And the colour of the one in hand, the
 *  handles' own. */
const RED = 0xff0000;
const GREEN = 0x00ff00;
const BLUE = 0x0000ff;
const GRIP_ACTIVE = 0xffff00;
const DOT = 0xcccccc;

/** A grip on a face, which moves the length `k` measures across the shape:
 *  out along `normal` from `foot`, the shape's middle on that line. Alone,
 *  the face moves and the middle goes half the way (`shift`); with `both`,
 *  the face opposite moves too and the middle stays. */
function face(k, at, normal, foot, colour, kept = (value) => value) {
  return {
    at,
    normal,
    colour,
    line: { foot, along: normal },
    to(from, moved, both) {
      const grown = snapped(from[k] + moved * (both ? 2 : 1), false);
      const value = kept(changed(from, k, grown));
      const shift = both
        ? null
        : normal.clone().multiplyScalar((value[k] - from[k]) / 2);
      return { value, shift };
    },
  };
}

/** A grip on a rim, which moves a diameter (`times` 2) or a radius (1) at
 *  `k`, all round: the middle stays. Read out from the axis (`outward`),
 *  whichever way the grip points: an inner radius's points in. */
function rim(
  k,
  at,
  normal,
  colour,
  times,
  kept = (value) => value,
  outward = normal,
) {
  return {
    at,
    normal,
    colour,
    line: { foot: new THREE.Vector3(), along: outward },
    to: (from, moved) => ({
      value: kept(changed(from, k, snapped(from[k] + moved * times, false))),
    }),
  };
}

/** Each shape's grips, by its constraint, for its value -- an array, a
 *  diameter as one number in one -- in its own frame: its middle at the
 *  origin, a round shape's axis along z. Each says where it stands, the way
 *  it points, its colour, its motion -- a `line` through `foot` along
 *  `along`, or `round` the axis at that radius -- and `to`, what a drag
 *  `moved` that far from where it began comes to: a length, or degrees. */
const GRIPS = {
  free([a, b, c]) {
    const least = 1e-3 * Math.max(a, b, c);
    const kept = (value) => value.map((v) => Math.max(v, least));
    const origin = new THREE.Vector3();
    const axes = [
      [0, new THREE.Vector3(1, 0, 0), RED, a],
      [1, new THREE.Vector3(0, 1, 0), GREEN, b],
      [2, new THREE.Vector3(0, 0, 1), BLUE, c],
    ];
    return axes.flatMap(([k, axis, colour, size]) =>
      [axis, axis.clone().negate()].map((normal) =>
        face(
          k,
          normal.clone().multiplyScalar(size / 2),
          normal,
          origin,
          colour,
          kept,
        ),
      ),
    );
  },
  segment([inner, outer, height, start, end]) {
    const rad = THREE.MathUtils.degToRad;
    const middle = (inner + outer) / 2;
    const across = flat(rad((start + end) / 2));
    const foot = across.clone().multiplyScalar(middle);
    const up = new THREE.Vector3(0, 0, 1);
    const round = (angle) =>
      new THREE.Vector3(-Math.sin(angle), Math.cos(angle), 0);
    // and it stays a segment: radii in order, some height, some angle
    const kept = (value) => {
      const least = 1e-3 * Math.max(value[1], value[2]);
      value[0] = Math.min(Math.max(value[0], 0), value[1] - least);
      value[1] = Math.max(value[1], value[0] + least);
      value[2] = Math.max(value[2], least);
      value[3] = Math.min(Math.max(value[3], value[4] - 360), value[4] - 1);
      value[4] = Math.max(Math.min(value[4], value[3] + 360), value[3] + 1);
      return value;
    };
    const angle = (k, at, normal) => ({
      at,
      normal,
      colour: GREEN,
      round: middle,
      to: (from, moved) => ({
        value: kept(changed(from, k, snapped(from[k] + moved, true))),
      }),
    });
    return [
      rim(
        0,
        across.clone().multiplyScalar(inner),
        across.clone().negate(),
        RED,
        1,
        kept,
        across,
      ),
      rim(1, across.clone().multiplyScalar(outer), across, RED, 1, kept),
      face(2, foot.clone().setZ(height / 2), up, foot, BLUE, kept),
      face(
        2,
        foot.clone().setZ(-height / 2),
        up.clone().negate(),
        foot,
        BLUE,
        kept,
      ),
      angle(
        3,
        flat(rad(start)).multiplyScalar(middle),
        round(rad(start)).negate(),
      ),
      angle(4, flat(rad(end)).multiplyScalar(middle), round(rad(end))),
    ];
  },
  cylinder([diameter, height]) {
    const out = new THREE.Vector3(1, 0, 0);
    const up = new THREE.Vector3(0, 0, 1);
    const origin = new THREE.Vector3();
    const least = 1e-3 * Math.max(diameter, height);
    const kept = (value) => value.map((v) => Math.max(v, least));
    return [
      rim(0, out.clone().multiplyScalar(diameter / 2), out, RED, 2, kept),
      face(1, up.clone().multiplyScalar(height / 2), up, origin, BLUE, kept),
      face(
        1,
        up.clone().multiplyScalar(-height / 2),
        up.clone().negate(),
        origin,
        BLUE,
        kept,
      ),
    ];
  },
  diameter([diameter]) {
    const out = new THREE.Vector3(1, 0, 0);
    const kept = (value) => [Math.max(value[0], 1e-3 * diameter)];
    return [
      rim(0, out.clone().multiplyScalar(diameter / 2), out, RED, 2, kept),
    ];
  },
};

/** The unit vector at `angle` round the z axis, in its plane. */
function flat(angle) {
  return new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
}

/** `from` with its `k`th number `value`. */
function changed(from, k, value) {
  const next = [...from];
  next[k] = value;
  return next;
}

/** The look of everything here: the handles', drawn over what they are on. */
const HANDLE_LOOK = {
  depthTest: false, // a grip behind the shape is still a grip
  depthWrite: false,
  fog: false,
  toneMapped: false,
  transparent: true,
};

/** The most grips a shape has, each one of the scale handles' own handle --
 *  a shaft, a cube at its end and a wider picker no one sees -- drawn as
 *  `TransformControls` draws them, standing up along its own y. And the
 *  points' dots, a cube each, made as they are needed. */
function makeGrips() {
  const shaft = new THREE.CylinderGeometry(0.0075, 0.0075, 0.5, 3);
  shaft.translate(0, 0.25, 0);
  const head = new THREE.BoxGeometry(0.08, 0.08, 0.08);
  head.translate(0, 0.54, 0);
  const picker = new THREE.CylinderGeometry(0.2, 0, 0.6, 4);
  picker.translate(0, 0.3, 0);
  for (let index = 0; index < MOST_GRIPS; index++) {
    const material = new THREE.MeshBasicMaterial(HANDLE_LOOK);
    const grip = new THREE.Group();
    const reach = new THREE.Mesh(picker, material);
    reach.visible = false; // raycast all the same: a wide target, unseen
    for (const part of [
      new THREE.Mesh(shaft, material),
      new THREE.Mesh(head, material),
      reach,
    ]) {
      part.renderOrder = 1000;
      grip.add(part);
    }
    grip.userData.grip = index;
    grips.add(grip);
  }
  guide = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ ...HANDLE_LOOK, opacity: 0.5 }),
  );
  guide.renderOrder = 999;
  guide.frustumCulled = false;
  grips.add(guide);
  scene.add(grips, dots, pointProxy, snapMark);
}

/** The grips the shape shown has, without the guide. Raycasting reaches
 *  the hidden ones too, so the ones not in use are left out here. */
function gripObjects() {
  return grips.children.filter(
    (child) => child.userData.grip !== undefined && child.visible,
  );
}

/** Where `objectId`'s own frame is: its node stands on its centroid, turned
 *  with it, and the frame's origin is `pivot` back, at its position. */
function frameOf(objectId) {
  const node = byObjectId.get(objectId);
  const pivot = pivots[objectId] ?? new THREE.Vector3();
  node.updateMatrixWorld(true);
  return node.matrixWorld
    .clone()
    .multiply(
      new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z),
    );
}

/** Show the grips on `objectId`, if it has them, or put them away. */
function placeGrips(objectId) {
  if (gripping) return; // a drag carries its own value: see `watchGrips`
  const node = objectId ? byObjectId.get(objectId) : null;
  const shape = objectId ? shapes[objectId] : null;
  if (!node?.visible || !GRIPS[shape?.constraint]) {
    gripped = null;
    grips.visible = false;
    return;
  }
  const frame = frameOf(objectId);
  gripped = {
    objectId,
    attr: shape.attr,
    kind: shape.constraint,
    scalar: !Array.isArray(shape.value), // a diameter, sent back as one
    value: [].concat(shape.value),
    frame,
  };
  grips.matrix.copy(frame);
  grips.matrixWorldNeedsUpdate = true;
  grips.visible = true;
  setGrips(gripped.value);
}

/** Stand the grips where `value` has them -- `shift` off, where a face
 *  moving alone has moved the shape's middle -- the one in hand or under
 *  the pointer lit; and while one is dragged, the line it moves along. */
function setGrips(value, shift = null) {
  const specs = GRIPS[gripped.kind](value);
  const up = new THREE.Vector3(0, 1, 0);
  const lit = gripping?.index ?? gripHovered;
  for (const grip of grips.children) {
    const index = grip.userData.grip;
    if (index === undefined) continue;
    const spec = specs[index];
    grip.visible = Boolean(spec);
    if (!spec) continue;
    grip.position.copy(spec.at);
    if (shift) grip.position.add(shift);
    grip.quaternion.setFromUnitVectors(up, spec.normal);
    grip.children[0].material.color.setHex(
      index === lit ? GRIP_ACTIVE : spec.colour,
    );
  }
  const spec = gripping ? specs[gripping.index] : null;
  guide.visible = Boolean(spec);
  if (!spec) return;
  guide.material.color.setHex(spec.colour);
  let points;
  if (spec.line) {
    // through where it stands, both ways
    const { foot, along } = spec.line;
    const span = 1.5 * Math.max(spec.at.distanceTo(foot), 1e-9);
    points = [
      foot.clone().addScaledVector(along, -span),
      foot.clone().addScaledVector(along, span),
    ];
  } else {
    // round the axis, all the way
    points = Array.from({ length: 97 }, (_, k) =>
      flat((k / 96) * 2 * Math.PI).multiplyScalar(spec.round),
    );
  }
  if (shift) for (const point of points) point.add(shift);
  guide.geometry.dispose();
  guide.geometry = new THREE.BufferGeometry().setFromPoints(points);
}

/** A point array's points, however it nests them: a sensor's pixels may
 *  come as a grid. */
function pointsOf(value) {
  return Array.isArray(value[0]?.[0]) ? value.flatMap(pointsOf) : value;
}

/** `points`, in order, put back into `like`'s nesting. */
function nested(like, points) {
  let k = 0;
  const fill = (value) =>
    Array.isArray(value[0]?.[0])
      ? value.map(fill)
      : value.map(() => points[k++]);
  return fill(like);
}

const dotPool = []; // the points' dots, made as they are needed
const ghostPool = []; // a wire's segments' middles: a point to put there
let ghostHovered = null; // the ghost under the pointer, as where it puts one

/** `pool`'s `index`th dot, made if it is not yet. */
function dotIn(pool, index, size) {
  while (pool.length <= index) {
    const dot = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshBasicMaterial(HANDLE_LOOK),
    );
    dot.renderOrder = 1000;
    dots.add(dot);
    pool.push(dot);
  }
  return pool[index];
}

/** Show a dot on each of `objectId`'s points, if they move one at a time,
 *  and on a wire a fainter one on each segment's middle, a click on which
 *  puts a point there; or put them away. */
function placeDots(objectId) {
  const node = objectId ? byObjectId.get(objectId) : null;
  const shape = objectId ? shapes[objectId] : null;
  if (!node?.visible || !shape?.pointwise) {
    dotted = null;
    dots.visible = false;
    return;
  }
  const points = pointsOf(shape.value);
  dotted = { objectId, value: points, frame: frameOf(objectId) };
  dots.matrix.copy(dotted.frame);
  dots.matrixWorldNeedsUpdate = true;
  dots.visible = true;
  const held = heldPoints();
  points.forEach((point, index) => {
    const dot = dotIn(dotPool, index, 0.08);
    dot.visible = true;
    dot.position.fromArray(point);
    dot.userData.dot = index;
    const lit = index === dotHovered || held?.includes(index);
    dot.material.color.setHex(lit ? GRIP_ACTIVE : DOT);
  });
  for (const dot of dotPool.slice(points.length)) dot.visible = false;
  const middles = shape.insertable
    ? points.slice(1).map((p, k) => p.map((v, n) => (v + points[k][n]) / 2))
    : [];
  middles.forEach((middle, k) => {
    const ghost = dotIn(ghostPool, k, 0.06);
    const lit = k + 1 === ghostHovered;
    ghost.visible = true;
    ghost.position.fromArray(middle);
    ghost.userData.ghost = k + 1; // where the point it makes goes
    ghost.material.color.setHex(lit ? GRIP_ACTIVE : DOT);
    ghost.material.opacity = lit ? 1 : 0.45;
  });
  for (const ghost of ghostPool.slice(middles.length)) ghost.visible = false;
}

/** The dots in use. */
function dotObjects() {
  return dotPool.filter((dot) => dot.visible);
}

/** The ghosts in use. */
function ghostObjects() {
  return ghostPool.filter((ghost) => ghost.visible);
}

/** Put `value`, a shape's points, as one edit: a point put in or taken
 *  out is no drag, and is one step to undo. */
function commitPoints(objectId, attr, value) {
  host.dispatchEvent(
    new CustomEvent("objecttransform", {
      detail: { preview: false, edits: [{ objectId, shape: { attr, value } }] },
    }),
  );
}

/** A point in the middle of a wire's segment, before point `k`; the new
 *  point is then the one under the pointer. */
function insertPoint(k) {
  const shape = shapes[dotted.objectId];
  const points = pointsOf(shape.value);
  const middle = points[k - 1].map((v, n) => (v + points[k][n]) / 2);
  pickedPoints = null;
  chosenPoint = { objectId: dotted.objectId, index: k };
  commitPoints(dotted.objectId, shape.attr, [
    ...points.slice(0, k),
    middle,
    ...points.slice(k),
  ]);
}

/** Delete or Backspace: the points the handles hold, out of a wire that
 *  keeps two at least. Answers whether it took the key. */
function deletePoints() {
  const indices = heldPoints();
  const shape = dotted ? shapes[dotted.objectId] : null;
  if (!indices?.length || !shape?.insertable) return false;
  const points = pointsOf(shape.value).filter((_, i) => !indices.includes(i));
  if (points.length < 2) return false; // a wire runs between two at least
  const { objectId } = dotted;
  pickedPoints = null;
  chosenPoint = null;
  commitPoints(objectId, shape.attr, points);
  return true;
}

/** The points the move handles hold: those ⌘/ctrl-clicked, while any are,
 *  or the one under the pointer. */
function heldPoints() {
  if (!dotted) return null;
  if (pickedPoints?.objectId === dotted.objectId) return pickedPoints.indices;
  if (chosenPoint?.objectId === dotted.objectId) return [chosenPoint.index];
  return null;
}

/** Put the move handles on the points held, through a stand-in on their
 *  middle, turned with the object for "local". Returns whether they went
 *  there. */
function placePointHandles() {
  const indices = heldPoints();
  const points = (indices ?? []).map((i) => dotted.value[i]).filter(Boolean);
  if (!points.length) return false;
  // on their middle, where the free handle in it is the one point's own dot
  const point = [0, 1, 2].map(
    (k) => points.reduce((sum, p) => sum + p[k], 0) / points.length,
  );
  // a point moves along all three, off a flat shape's plane too: a
  // triangle's corner lifted tilts the triangle
  flatAxes = new Set();
  showAxes();
  // a redraw mid-drag comes back through here: the stand-in is the drag
  if (gizmo.dragging && gizmo.object === pointProxy) return true;
  pointProxy.position.fromArray(point).applyMatrix4(dotted.frame);
  pointProxy.quaternion.copy(quaternionOf(orientations[dotted.objectId]));
  pointProxy.scale.set(1, 1, 1);
  pointProxy.userData.objectId = dotted.objectId;
  pointProxy.userData.indices = [...indices];
  // points picked are moved, turned or scaled as W, E or R said; the one
  // under the pointer, alone, only moves
  const mode = pickedPoints ? pointsMode : "translate";
  gizmo.setSpace(mode === "scale" ? "local" : (SPACES[mode] ?? "world"));
  gizmo.mode = mode;
  gizmo.attach(pointProxy);
  return true;
}

/** W, E or R while points are picked: the handles move, turn or scale them
 *  about their middle, and the object's own mode stays. Answers whether it
 *  took the key. */
function setPointsMode(mode) {
  if (!pickedPoints || !["translate", "rotate", "scale"].includes(mode)) {
    return false;
  }
  pointsMode = mode;
  setGizmoMode(gizmoMode);
  return true;
}

/** Tell the host when the points the handles hold change, for a readout
 *  of the one held to follow. */
function announceHeld() {
  const indices =
    gizmo?.object === pointProxy ? pointProxy.userData.indices : null;
  const key = indices ? `${dotted?.objectId}:${indices.join()}` : "";
  if (key === heldKey) return;
  heldKey = key;
  host?.dispatchEvent(new CustomEvent("pointheld"));
}

/** The one point the handles hold, as the readout shows it: its object,
 *  which point, and where it is in the object's own frame. Null for none,
 *  or for several. */
function heldPoint() {
  const indices =
    gizmo?.object === pointProxy ? pointProxy.userData.indices : null;
  if (indices?.length !== 1 || !dotted) return null;
  const [index] = indices;
  return {
    objectId: dotted.objectId,
    attr: shapes[dotted.objectId].attr,
    index,
    at: dotted.value[index],
  };
}

/** The edit that puts the point held at `at`: numbers, or an expression
 *  where one is typed in a box. */
function pointEdit(at) {
  const held = heldPoint();
  if (!held) return null;
  const shape = shapes[held.objectId];
  const points = pointsOf(shape.value).map((p, i) =>
    i === held.index ? at : p,
  );
  return {
    objectId: held.objectId,
    shape: { attr: shape.attr, value: nested(shape.value, points) },
  };
}

/** Keep each grip and dot the size of the handles on screen, whatever the
 *  zoom: `TransformControls`' own measure, at its distance. */
function sizeGrips() {
  const shown = [
    ...(grips.visible ? gripObjects() : []),
    ...(dots.visible ? dots.children.filter((dot) => dot.visible) : []),
    ...(snapMark.visible ? [snapMark] : []),
  ];
  if (!shown.length) return;
  grips.updateMatrixWorld(true);
  dots.updateMatrixWorld(true);
  const at = new THREE.Vector3();
  for (const handle of shown) {
    handle.getWorldPosition(at);
    const factor = camera.isOrthographicCamera
      ? (camera.top - camera.bottom) / camera.zoom
      : at.distanceTo(camera.position) *
        Math.min(
          (1.9 * Math.tan((Math.PI * camera.fov) / 360)) / camera.zoom,
          7,
        );
    // in the frame's own scale, which is the world's: the frames are rigid
    handle.scale.setScalar((factor * (gizmo?.size ?? 1)) / 4);
  }
}

/** Snap a length to the move's step, an angle to the turn's, when on. */
function snapped(value, angle) {
  const step = angle
    ? gizmo?.rotationSnap && THREE.MathUtils.radToDeg(gizmo.rotationSnap)
    : gizmo?.translationSnap;
  return step ? Math.round(value / step) * step : value;
}

/** Where `objectId` stood when a drag began: its position, its turn and
 *  its path. Each step is measured from there -- the scene redrawn mid-drag
 *  says where the last step left it, and adding to that would add the shift
 *  again every step. */
function poseOf(objectId) {
  return JSON.parse(
    JSON.stringify({
      anchor: anchors[objectId] ?? [0, 0, 0],
      turn: orientations[objectId] ?? [0, 0, 0],
      path: paths[objectId] ?? null,
    }),
  );
}

/** Where a shift of the shape's middle, in its own frame, puts it from
 *  `pose`: every step of its path, where it has one, each turned its way. */
function shiftedPosition(pose, shift) {
  const moved = (position, turn) =>
    new THREE.Vector3()
      .fromArray(position)
      .add(shift.clone().applyQuaternion(quaternionOf(turn)))
      .toArray();
  return pose.path
    ? pose.path.position.map((p, i) => moved(p, pose.path.orientation[i]))
    : moved(pose.anchor, pose.turn);
}

// --- snapping -----------------------------------------------------------
//
// Shift held while dragging, what is dragged lands on what is near it on
// screen: a point on another object's vertex, a face where its plane meets
// one, a whole object vertex to vertex. The vertices are those the engine
// draws, so a curved surface is snapped to at its facets' corners; a path's
// track and a field line are not things to land on.

const SNAP_PIXELS = 10;
let shiftHeld = false; // read off the pointer as it moves: see `watchGrips`
const snapMark = new THREE.Mesh(
  new THREE.BoxGeometry(0.12, 0.12, 0.12),
  new THREE.MeshBasicMaterial({ ...HANDLE_LOOK, color: GRIP_ACTIVE }),
);
snapMark.renderOrder = 1001;
snapMark.visible = false;

/** Where on the page `point`, in the world, is drawn; null behind the view. */
function onScreen(point) {
  const p = point.clone().project(camera);
  if (p.z > 1) return null;
  const { clientWidth: w, clientHeight: h } = renderer.domElement;
  return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
}

/** The vertices drawn for every object but those in `skip`, in the world,
 *  each with where it is on the page, kept in cells of `SNAP_PIXELS` for a
 *  look near the pointer: what a drag snaps to. Taken once a drag, which
 *  the camera does not move during. */
function snapTargets(skip) {
  const seen = new Map();
  const at = new THREE.Vector3();
  const visit = (part) => {
    if (!part.visible || part.userData.path || part.userData.unsnapped) return;
    if (!part.isInstancedMesh && !part.isPoints) {
      for (const [x, y, z] of verticesOf(part.geometry)) {
        at.set(x, y, z).applyMatrix4(part.matrixWorld);
        const key = `${at.x.toFixed(12)},${at.y.toFixed(12)},${at.z.toFixed(12)}`;
        if (!seen.has(key)) seen.set(key, at.clone());
      }
    }
    for (const child of part.children) visit(child);
  };
  for (const [objectId, node] of byObjectId) {
    if (skip.has(objectId) || !node.visible) continue;
    node.updateMatrixWorld(true);
    visit(node);
  }
  const cells = new Map();
  for (const point of seen.values()) {
    const page = onScreen(point);
    if (!page) continue;
    const key = cellOf(page);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ point, page });
  }
  return cells;
}

function cellOf([x, y]) {
  return `${Math.floor(x / SNAP_PIXELS)},${Math.floor(y / SNAP_PIXELS)}`;
}

/** Of `cells`, the target nearest `page` within `SNAP_PIXELS`, or null. */
function nearestTarget(cells, page) {
  if (!page) return null;
  const [cx, cy] = cellOf(page).split(",").map(Number);
  let best = null;
  let distance = SNAP_PIXELS;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const target of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
        const d = Math.hypot(
          target.page[0] - page[0],
          target.page[1] - page[1],
        );
        if (d <= distance) {
          distance = d;
          best = { ...target, distance: d };
        }
      }
    }
  }
  return best;
}

/** A geometry's vertices: the engine's numbers where it kept them, the
 *  buffer's otherwise -- a wide line's ends, an outline's. */
function* verticesOf(geometry) {
  const exact = geometry?.userData.exact;
  if (exact) {
    for (let i = 0; i + 2 < exact.length; i += 3) {
      const [x, y, z] = [exact[i], exact[i + 1], exact[i + 2]];
      if (x !== null && y !== null && z !== null) yield [x, y, z]; // a pen lift
    }
    return;
  }
  const attributes = geometry?.attributes;
  const lists = attributes?.instanceStart
    ? [attributes.instanceStart, attributes.instanceEnd]
    : attributes?.position
      ? [attributes.position]
      : [];
  for (const list of lists) {
    for (let i = 0; i < list.count; i++) {
      yield [list.getX(i), list.getY(i), list.getZ(i)];
    }
  }
}

/** Mark what was snapped to, or nothing. */
function showSnap(point) {
  snapMark.visible = Boolean(point);
  if (point) snapMark.position.copy(point);
}

/** The vertices drawn under `node` -- what it carries too -- in its own
 *  frame, for a drag of it to snap with as it moves. */
function drawnPointsOf(node) {
  node.updateMatrixWorld(true);
  const inverse = node.matrixWorld.clone().invert();
  const seen = new Map();
  const at = new THREE.Vector3();
  node.traverseVisible((part) => {
    if (part.userData.path || part.isInstancedMesh) return;
    if (part.isPoints || !part.geometry?.userData.exact) return; // its own
    for (const [x, y, z] of verticesOf(part.geometry)) {
      at.set(x, y, z).applyMatrix4(part.matrixWorld).applyMatrix4(inverse);
      const key = `${at.x.toFixed(12)},${at.y.toFixed(12)},${at.z.toFixed(12)}`;
      if (!seen.has(key)) seen.set(key, at.clone());
    }
  });
  return [...seen.values()];
}

/** With Shift held and the handles moving it, land what is dragged on the
 *  nearest target: a point picked up, on it; a whole object, the one of its
 *  own vertices nearest a target on that target. */
function snapDragged(node, from) {
  if (!shiftHeld || gizmo.mode !== "translate") return showSnap(null);
  node.updateMatrixWorld(true);
  if (node === pointProxy) {
    const near = nearestTarget(
      from.targets,
      onScreen(node.getWorldPosition(new THREE.Vector3())),
    );
    if (near) node.position.copy(near.point); // the stand-in is the scene's
    return showSnap(near?.point);
  }
  let best = null;
  let mine = null;
  for (const local of from.own) {
    const world = local.clone().applyMatrix4(node.matrixWorld);
    const near = nearestTarget(from.targets, onScreen(world));
    if (near && (!best || near.distance < best.distance)) {
      best = near;
      mine = world;
    }
  }
  if (best) node.position.add(best.point.clone().sub(mine));
  showSnap(best?.point);
}

let dragCancelled = false; // Esc in a drag of the handles: see `cancelDrag`
let cancelGrip = () => false; // and in a grip's: see `watchGrips`

/** Esc in a drag: it ends where it began and is taken back, as if never
 *  made (`drag.mjs`). Answers whether there was one. */
function cancelDrag() {
  if (cancelGrip()) return true;
  if (!gizmo?.dragging) return false;
  dragCancelled = true;
  gizmo.reset(); // the handles, and what they carry, back where they began
  gizmo.dragging = false;
  return true;
}

/** The grips' and the dots' pointer: lit under it, dragged or picked by
 *  it. Bound after the picks, whose release looks at `gripPressed` before
 *  this clears it. */
function watchGrips() {
  const element = renderer.domElement;
  const aim = (event) => {
    const rect = element.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
  };
  const gripAt = (event) => {
    if (!grips.visible) return null;
    aim(event);
    const hit = raycaster.intersectObjects(gripObjects(), true)[0];
    return hit ? hit.object.parent.userData.grip : null;
  };
  const dotAt = (event) => {
    if (!dots.visible) return null;
    aim(event);
    const hit = raycaster.intersectObjects(dotObjects(), false)[0];
    return hit ? hit.object.userData.dot : null;
  };
  const ghostAt = (event) => {
    if (!dots.visible) return null;
    aim(event);
    const hit = raycaster.intersectObjects(ghostObjects(), false)[0];
    return hit ? hit.object.userData.ghost : null;
  };
  /** Where the pointer is along a grip's motion, in the shape's own frame:
   *  how far along its line, or the angle round the axis in degrees. Null
   *  where the view cannot say -- looking edge-on at the plane an angle
   *  turns in. */
  const reading = (event, spec) => {
    aim(event);
    const ray = raycaster.ray.clone().applyMatrix4(gripping.inverse);
    if (spec.line) {
      const { foot, along } = spec.line;
      const reach = 1000 * Math.max(spec.at.distanceTo(foot), 1e-6);
      const onLine = new THREE.Vector3();
      ray.distanceSqToSegment(
        foot.clone().addScaledVector(along, -reach),
        foot.clone().addScaledVector(along, reach),
        undefined,
        onLine,
      );
      return onLine.sub(foot).dot(along);
    }
    const hit = ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      new THREE.Vector3(),
    );
    if (!hit || Math.hypot(hit.x, hit.y) < 1e-12) return null;
    return THREE.MathUtils.radToDeg(Math.atan2(hit.y, hit.x));
  };
  /** For Shift in a grip's drag: the other objects' vertices within the
   *  shape's reach across its line, each as how far along the line it is,
   *  where that is on the page, and the vertex itself. */
  const lineTargets = (drag) => {
    const { foot, along } = drag.spec.line;
    const lengths =
      gripped?.kind === "segment" ? drag.from.slice(0, 3) : drag.from;
    const reach = Math.max(...lengths); // across the line: the shape's size
    const frame = drag.inverse.clone().invert();
    const out = [];
    for (const cell of snapTargets(
      new Set(drawnFor([drag.objectId])),
    ).values()) {
      for (const { point } of cell) {
        const local = point.clone().applyMatrix4(drag.inverse).sub(foot);
        const t = local.dot(along);
        if (local.addScaledVector(along, -t).length() > reach) continue;
        const onLine = foot
          .clone()
          .addScaledVector(along, t)
          .applyMatrix4(frame);
        out.push({ t, page: onScreen(onLine), vertex: point });
      }
    }
    return out;
  };
  /** Where Shift lands a grip dragged `moved` along its line from where it
   *  began: on the target nearest its own point on the page, if one is
   *  near -- the face then meets that vertex's level. */
  const snapAlong = (drag, moved) => {
    drag.targets ??= lineTargets(drag);
    const { foot, along } = drag.spec.line;
    const t0 = drag.spec.at.clone().sub(foot).dot(along);
    const frame = drag.inverse.clone().invert();
    const page = onScreen(
      foot
        .clone()
        .addScaledVector(along, t0 + moved)
        .applyMatrix4(frame),
    );
    let best = null;
    for (const target of drag.targets) {
      if (!page || !target.page) continue;
      const d = Math.hypot(target.page[0] - page[0], target.page[1] - page[1]);
      if (d <= SNAP_PIXELS && (!best || d < best.d)) best = { d, target };
    }
    return best
      ? { moved: best.target.t - t0, point: best.target.vertex }
      : null;
  };
  cancelGrip = () => {
    if (!gripping) return false;
    const drag = gripping;
    gripping = null;
    gripPressed = false;
    controls.enabled = true;
    redraw(); // and the flow goes on
    element.style.cursor = "";
    showSnap(null);
    if (gripped) setGrips(gripped.value);
    if (drag.moved) {
      host.dispatchEvent(
        new CustomEvent("objecttransform", {
          detail: { preview: false, cancel: true, edits: [] },
        }),
      );
    }
    redraw();
    return true;
  };
  const send = (drag, preview) => {
    const edit = {
      objectId: drag.objectId,
      shape: {
        attr: drag.attr,
        value: drag.scalar ? drag.value[0] : drag.value,
      },
    };
    if (drag.shift?.lengthSq() > 0) {
      edit.position = shiftedPosition(drag.pose, drag.shift);
    }
    host.dispatchEvent(
      new CustomEvent("objecttransform", {
        detail: { preview, edits: [edit] },
      }),
    );
  };
  /** The point under the pointer gets the move handles, and keeps them
   *  while the pointer is on them: pressed where the dot is, their middle
   *  moves it freely, facing the view, and an arrow along its axis. Off
   *  both, the handles go back to the whole shape. */
  const hoverPoints = (event) => {
    if (!dotted || gizmo.dragging) return;
    if (pickedPoints?.objectId === dotted.objectId) return; // they hold them
    const dot = dotAt(event);
    const held = gizmo.object === pointProxy && gizmo.axis !== null;
    const next = dot ?? (held ? (chosenPoint?.index ?? null) : null);
    if (next === (chosenPoint?.index ?? null)) return;
    chosenPoint =
      next === null ? null : { objectId: dotted.objectId, index: next };
    setGizmoMode(gizmoMode);
    announceHeld();
  };

  // ⌘/ctrl-click on a dot picks its point, or puts it back: the points
  // picked move together, the handles on their middle. Taken before the
  // handles and the orbit see the press, which would start a drag of them.
  element.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
      const dot = dotted ? dotAt(event) : null;
      if (dot === null) return;
      event.stopImmediatePropagation();
      gripPressed = true; // nor is it a pick of the object behind
      const held = new Set(
        pickedPoints?.objectId === dotted.objectId ? pickedPoints.indices : [],
      );
      if (held.has(dot)) held.delete(dot);
      else held.add(dot);
      pickedPoints = held.size
        ? {
            objectId: dotted.objectId,
            indices: [...held].sort((a, b) => a - b),
          }
        : null;
      setGizmoMode(gizmoMode);
      announceHeld();
      redraw();
    },
    true,
  );

  // A click on a ghost puts a point there. Taken before the handles and the
  // orbit, as a press on a dot with ⌘ is; made on the release, if the press
  // stayed put.
  let ghostPress = null;
  element.addEventListener(
    "pointerdown",
    (event) => {
      // over the whole shape's handles too, which it sits in the middle
      // of; only a point's handles in hand come before it
      if (event.button !== 0 || !dotted) return;
      if (gizmo?.axis && gizmo.object === pointProxy) return;
      const ghost = ghostAt(event);
      if (ghost === null) return;
      event.stopImmediatePropagation();
      gripPressed = true;
      ghostPress = { ghost, x: event.clientX, y: event.clientY };
    },
    true,
  );

  // ⌥-drag over empty space draws a box: the dots in it are picked, with
  // those picked already. The orbit and a pick of what is behind stand
  // aside for it.
  let boxing = null;
  const boxRect = (event) => ({
    left: Math.min(boxing.x, event.clientX),
    top: Math.min(boxing.y, event.clientY),
    right: Math.max(boxing.x, event.clientX),
    bottom: Math.max(boxing.y, event.clientY),
  });
  element.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || !event.altKey || !dotted || gizmo?.axis) return;
      if (dotAt(event) !== null || ghostAt(event) !== null) return;
      if (gripped && gripAt(event) !== null) return; // ⌥ on a grip: both faces
      event.stopImmediatePropagation();
      gripPressed = true;
      element.setPointerCapture(event.pointerId);
      const overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed",
        border: "1px dashed #ffcc00",
        background: "rgba(255, 204, 0, 0.08)",
        pointerEvents: "none",
        zIndex: "10",
      });
      document.body.appendChild(overlay);
      boxing = { x: event.clientX, y: event.clientY, overlay };
    },
    true,
  );
  element.addEventListener(
    "pointermove",
    (event) => {
      if (!boxing) return;
      const { left, top, right, bottom } = boxRect(event);
      Object.assign(boxing.overlay.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${right - left}px`,
        height: `${bottom - top}px`,
      });
    },
    true,
  );

  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (gizmo?.axis) return; // the move handles of a point already have it
    if (!gripped) return;
    const index = gripAt(event);
    if (index === null) return;
    gripPressed = true;
    controls.enabled = false; // the press is the grip's, not the orbit's
    element.setPointerCapture(event.pointerId);
    const from = [...gripped.value];
    gripping = {
      index,
      objectId: gripped.objectId,
      attr: gripped.attr,
      scalar: gripped.scalar,
      spec: GRIPS[gripped.kind](from)[index],
      inverse: gripped.frame.clone().invert(),
      pose: poseOf(gripped.objectId),
      from,
      value: [...from],
      shift: null,
      moved: false,
      turned: 0, // degrees, unwrapped: an angle can go round past ±180
    };
    gripping.at = reading(event, gripping.spec);
    gripping.last = gripping.at;
  });

  element.addEventListener("pointermove", (event) => {
    shiftHeld = event.shiftKey; // for the handles' drags: see `snapDragged`
    if (!gripping) {
      if (event.buttons) return; // orbiting
      hoverPoints(event);
      const index = gripAt(event);
      const dot = dotAt(event);
      const ghost = dot === null ? ghostAt(event) : null;
      if (
        index === gripHovered &&
        dot === dotHovered &&
        ghost === ghostHovered
      ) {
        return;
      }
      gripHovered = index;
      dotHovered = dot;
      ghostHovered = ghost;
      element.style.cursor =
        ghost !== null ? "copy" : index === null && dot === null ? "" : "grab";
      if (gripped) setGrips(gripped.value);
      if (dotted) placeDots(dotted.objectId);
      redraw();
      return;
    }
    const { spec, from } = gripping;
    const now = reading(event, spec);
    if (now === null || gripping.at === null) return;
    let moved = now - gripping.at;
    if (spec.round !== undefined) {
      gripping.turned += ((now - gripping.last + 540) % 360) - 180;
      gripping.last = now;
      moved = gripping.turned;
    } else if (event.shiftKey) {
      // Shift: where the face, or the rim, comes nearest another object's
      // vertex along its line, it stops there -- touching, not inside
      const landed = snapAlong(gripping, moved);
      if (landed) moved = landed.moved;
      showSnap(landed?.point);
    } else {
      showSnap(null);
    }
    // ⌥ while dragging grows both ways, and lets go of it again
    const { value, shift = null } = spec.to(from, moved, event.altKey);
    const same =
      value.every((v, k) => v === gripping.value[k]) &&
      (shift?.equals(gripping.shift ?? new THREE.Vector3()) ?? !gripping.shift);
    if (same) return;
    gripping.value = value;
    gripping.shift = shift;
    if (!gripping.moved) {
      gripping.moved = true;
      element.style.cursor = "grabbing";
      host.dispatchEvent(
        new CustomEvent("dragstart", {
          detail: {
            objectIds: [gripping.objectId],
            mode: "scale",
            redrawn: true, // the engine draws the shape as it goes
          },
        }),
      );
    }
    setGrips(value, shift);
    send(gripping, true);
    redraw();
  });

  const letGo = (event) => {
    gripPressed = false;
    if (ghostPress) {
      const stayed =
        Math.hypot(
          event.clientX - ghostPress.x,
          event.clientY - ghostPress.y,
        ) <= 4;
      if (stayed && dotted) insertPoint(ghostPress.ghost);
      ghostPress = null;
      return;
    }
    if (boxing) {
      const { left, top, right, bottom } = boxRect(event);
      boxing.overlay.remove();
      boxing = null;
      element.releasePointerCapture?.(event.pointerId);
      const canvas = element.getBoundingClientRect();
      const inside = dotObjects()
        .filter((dot) => {
          const page = onScreen(dot.getWorldPosition(new THREE.Vector3()));
          if (!page) return false;
          const x = page[0] + canvas.left;
          const y = page[1] + canvas.top;
          return x >= left && x <= right && y >= top && y <= bottom;
        })
        .map((dot) => dot.userData.dot);
      if (inside.length && dotted) {
        const held = new Set([
          ...(pickedPoints?.objectId === dotted.objectId
            ? pickedPoints.indices
            : []),
          ...inside,
        ]);
        pickedPoints = {
          objectId: dotted.objectId,
          indices: [...held].sort((a, b) => a - b),
        };
        setGizmoMode(gizmoMode);
        announceHeld();
        redraw();
      }
      return;
    }
    showSnap(null);
    if (!gripping) return;
    const drag = gripping;
    gripping = null;
    controls.enabled = true;
    element.releasePointerCapture?.(event.pointerId);
    element.style.cursor = gripHovered === null ? "" : "grab";
    // where it was let go, until the engine's scene puts the grips back
    if (gripped) {
      gripped.value = drag.value;
      setGrips(drag.value, drag.shift);
    }
    if (drag.moved) send(drag, false);
    redraw();
  };
  element.addEventListener("pointerup", letGo);
  element.addEventListener("pointercancel", letGo);
  element.addEventListener("pointerleave", () => {
    if (gripping || (gripHovered === null && dotHovered === null)) return;
    gripHovered = null;
    dotHovered = null;
    element.style.cursor = "";
    if (gripped) setGrips(gripped.value);
    if (dotted) placeDots(dotted.objectId);
    redraw();
  });
}

const TURN_MS = 400; // how long the view takes to turn to an axis view
let turning = null; // an axis view the camera is turning to: see `axisView`

/** Look from `x, y, z` -- along an axis, or from an edge or a corner of the
 *  view cube -- at the distance the camera already is. The view turns there
 *  over a few frames, so that where it went can be followed
 *  (docs/decisions.md#0035-the-corner-shows-the-axes-and-grows-the-cube-on-hover). */
function axisView(x, y, z) {
  if (!camera) return;
  stopTurning();
  const distance = camera.position.distanceTo(controls.target) || 1;
  const from = new THREE.Vector3(x, y, z).normalize();
  // z is up in a magpylib scene, so looking straight down it needs another
  // reference or the view has no defined roll. Asked of the direction made a
  // unit first: a corner's (1, -1, 1) is not looking down z.
  const up = new THREE.Vector3(0, 0, 1);
  if (Math.abs(from.z) > 0.99) up.set(0, 1, 0);
  const end = controls.target.clone().addScaledVector(from, distance);
  if (lessMotion) {
    landTurn({ up, end });
    return;
  }
  const facing = new THREE.Matrix4().lookAt(end, controls.target, up);
  turning = {
    from: camera.quaternion.clone(),
    to: new THREE.Quaternion().setFromRotationMatrix(facing),
    distance,
    up,
    end,
    began: performance.now(),
  };
  redraw();
}

/** One step of the turn `axisView` began, for the frame drawn at `now`;
 *  whether there was one to take. The camera swings about what it looks at
 *  and is handed back to the orbit only at the end: the orbit would hold it
 *  to its up, which the turn changes when it ends looking down z. */
function stepTurn(now) {
  if (!turning) return false;
  const { from, to, distance, began } = turning;
  const t = THREE.MathUtils.clamp((now - began) / TURN_MS, 0, 1);
  const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  camera.quaternion.slerpQuaternions(from, to, eased);
  camera.position
    .set(0, 0, distance)
    .applyQuaternion(camera.quaternion)
    .add(controls.target);
  camera.updateMatrixWorld();
  fitClipping();
  // the cube turns under a pointer that stays where it clicked
  if (cornerPointer) markCube(cubeTarget(cornerPointer));
  if (t === 1) {
    const done = turning;
    turning = null;
    landTurn(done);
  }
  return true;
}

function landTurn({ up, end }) {
  camera.up.copy(up);
  camera.position.copy(end);
  controls.update();
}

/** Leave a turn where it has got to: something else moves the camera now. */
function stopTurning() {
  if (!turning) return;
  turning = null;
  camera.up.set(0, 0, 1);
  const looking = camera.position.clone().sub(controls.target).normalize();
  if (Math.abs(looking.z) > 0.99) camera.up.set(0, 1, 0);
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
  let onCube = false; // whether the press began on the view cube
  // Bound before the handles are made, so this runs ahead of their own: a
  // handle behind the cube must not take a press meant for the cube, and is
  // off until the press ends. The orbit is left on, so dragging the cube
  // turns the view as dragging anywhere else does.
  element.addEventListener("pointerdown", (event) => {
    down.set(event.clientX, event.clientY);
    // the main button only: the others pan and zoom, here as anywhere
    onCube = event.button === 0 && Boolean(cubeTarget(event));
    if (onCube && gizmo) gizmo.enabled = false;
  });
  const letGo = () => {
    if (onCube && gizmo) gizmo.enabled = true;
    const was = onCube;
    onCube = false;
    return was;
  };
  element.addEventListener("pointercancel", letGo);
  // What is under the pointer is looked for once a frame, however often the
  // pointer moves: a pick goes through every trace drawn.
  let looking = null; // the last move, while a look is due
  const lookSoon = (event) => {
    if (!looking) {
      requestAnimationFrame(() => {
        const event = looking;
        looking = null;
        if (event) hover(onHandle() ? null : pick(event));
      });
    }
    looking = event;
  };
  element.addEventListener("pointermove", (event) => {
    if (event.buttons) return;
    hoverCorner(event);
    markCube(cubeTarget(event));
    lookSoon(event);
  });
  // an orbit or a zoom moves the scene under a pointer that stays put
  element.addEventListener("wheel", lookSoon, { passive: true });
  element.addEventListener("pointerleave", () => {
    hoverCorner(null);
    markCube(null);
    looking = null;
    hover(null);
  });
  element.addEventListener("pointerup", (event) => {
    const fromCube = letGo();
    // a drag may have ended off the cube
    hoverCorner(event);
    markCube(cubeTarget(event));
    lookSoon(event);
    // orbiting also ends in a pointerup: only a press that stayed put is a click
    if (down.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 4) {
      return;
    }
    // a click on the cube is a view, never a pick of what is behind it
    if (fromCube) {
      const looking = cubeTarget(event);
      if (looking) axisView(...looking);
      return;
    }
    // a handle under the pointer was the target of the press, not the object
    // behind it -- otherwise letting go of a gizmo selects whatever it covers
    if (gizmo?.axis || gripPressed) return;
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
  // A faded object is one being looked through: the click goes on to what
  // it shows, and takes the faded one only where nothing else is there. So
  // does a field line, which runs past and in front of what it is the field
  // of.
  let through;
  for (const hit of hits) {
    const objectId = ownerOf(hit.object);
    if (objectId === undefined || !shown(hit.object)) continue;
    const behind = (fades.get(objectId) ?? 1) < 1 || hit.object.userData.field;
    if (!behind) return objectId;
    through ??= objectId;
  }
  return through;
}

/** Whether the pointer is on something a press would take rather than the
 *  object behind it: the view cube, a handle, a grip, a point. */
function onHandle() {
  return (
    cornerHot ||
    Boolean(gizmo?.axis) ||
    gripHovered !== null ||
    dotHovered !== null ||
    ghostHovered !== null
  );
}

/** Mark faintly what is under the pointer -- what a click would select --
 *  or, given nothing, stop. */
function hover(objectId) {
  const now = objectId ?? null;
  if (now === hoveredId) return;
  hoveredId = now;
  drawHints();
  redraw();
}

/** Whether `part` is drawn: it and everything above it visible, in the
 *  scene -- a current's arrows are put away inside a node that shows. */
function shown(part) {
  for (let node = part; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === scene) return true;
  }
  return false;
}

/** The studio id of the object `part` was drawn for. */
function ownerOf(part) {
  for (let node = part; node; node = node.parent) {
    if (node.userData.objectId) return node.userData.objectId;
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
  flowResolution.set(w, h);
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
  for (const node of byObjectId.values()) dress(node);
  highlight(selectedIds); // an outline round nothing reads as a bug
  drawHints();
}

/** Draw each object `levels` names at that share of its own opacity, and
 *  every other at its own. */
function setFades(levels) {
  fades = new Map(Object.entries(levels ?? {}));
  for (const node of byObjectId.values()) dress(node);
}

/** Show `node` and fade it as `hiddenIds` and `fades` say. A sensor drawn
 *  as its parts -- its pixels and its field lines, marked so in the payload,
 *  and the rest of it its axes (`threejs.PARTS`) -- shows and fades each by
 *  the part's own id, which its legend's rows hide and fade apart. */
function dress(node) {
  const objectId = node.userData.objectId;
  // a collection's node draws nothing, and hidden would hide what it carries
  node.visible = node.userData.collection || !hiddenIds.has(objectId);
  const built = node.children.filter((child) => child.userData.built);
  if (!built.some((child) => child.userData.part)) {
    fade(node, fades.get(objectId) ?? 1);
    return;
  }
  for (const child of built) {
    const part = child.userData.part ?? `${objectId}/axes`;
    child.visible = !hiddenIds.has(part);
    fade(child, fades.get(part) ?? fades.get(objectId) ?? 1);
  }
  // every part hidden is the sensor hidden: not picked, walked to or framed
  node.visible &&= built.some((child) => child.visible);
}

/** `dress` the nodes drawn as parts, once their items are on them. */
function dressParts() {
  for (const node of byObjectId.values()) {
    if (node.children.some((child) => child.userData.part)) dress(node);
  }
}

/** Draw what `part` carries at `level` of its own opacity. Only what was
 *  built for the scene, which remembers that opacity (`buildItem`): an
 *  outline hung on it keeps its own. Faded, it stops writing depth, so what
 *  stands behind it or inside it shows through whole. Not into another
 *  object's node, which a collection's carries while it is dragged. */
function fade(part, level) {
  relook.add(part);
  const material = part.material;
  if (material?.userData.own !== undefined) {
    material.opacity = material.userData.own * level;
    // a current's flow is see-through at any level: it is a glow on the wire;
    // and a field line, which other lines show through
    const blended = Boolean(material.userData.blended);
    const transparent = material.opacity < 1 || blended;
    // three compiles an opaque material's alpha away: the program changes
    // when this does, once, and not on every step of a slide
    if (material.transparent !== transparent) material.needsUpdate = true;
    material.transparent = transparent;
    material.depthWrite = level >= 1 && !blended;
    // what is opaque hides a mark behind it; what is faded is looked through
    if (part.isMesh && !part.isLineSegments2) {
      part.layers[transparent ? "disable" : "enable"](MASK);
    }
  }
  for (const child of part.children) {
    if (child.userData.objectId === undefined) fade(child, level);
  }
}

/** Say the scene's scale with the view cube and a scale bar, with the
 *  graduated box, or not at all: `"cube"`, `"box"` or `"none"`. Framing
 *  leaves room for the box's numbers only while it is there. */
function setAxes(mode) {
  axesMode = mode === "box" || mode === "none" ? mode : "cube";
  if (axesMode === "box" && !axes) buildAxes();
  if (axes) axes.visible = axesMode === "box";
  // Whatever was under the pointer was under it in the last view drawn,
  // which a pooled renderer is moving on from.
  cornerHot = false;
  cornerPointer = null;
  grown = 0;
  poseCorner();
  markCube(null);
}

/** Mark these objects faintly -- what a click would select -- or, given
 *  none, stop. For a host showing where something is without choosing it. */
function hint(objectIds) {
  hintIds = [].concat(objectIds ?? []);
  drawHints();
}

/** The faint marks afresh: what the host points at, and what the pointer is
 *  on unless it is selected, and marked in full already. */
function drawHints() {
  takeOff(hints);
  // Called on every redraw and every frame of a run, and nearly always with
  // nothing to point at: no style lookup for a colour nothing will wear.
  const faint =
    hoveredId && !selectedIds.includes(hoveredId)
      ? [...new Set([...hintIds, hoveredId])]
      : hintIds;
  hints = faint.length ? outline(faint, HINT_OPACITY) : [];
  countMarks();
}

/** Faces meeting at more than this many degrees meet at an edge: where an
 *  overlap's shading is outlined. A cylinder's sides, at 7.2° a facet, are
 *  one smooth surface; its rims are edges. */
const EDGE_ANGLE = 25;

/** What a selection is drawn in: a green nothing else in a scene is. Not the
 *  theme's focus colour, a blue: magpylib draws an object and its path in a
 *  blue by default, and a field's arrows run through blues, so a blue
 *  selection was there to be looked for rather than seen. Brighter and
 *  yellower than the green magpylib paints a magnet's south pole. */
const SELECTION_COLOUR = "#39ff14";

/** What an overlap is drawn in: an amber, the colour of a warning, as the
 *  legend's mark is. Not a red: magpylib paints a magnet's north pole red,
 *  white and green across it, and a red outline vanished on the very magnets
 *  it marked. */
const OVERLAP_COLOURS = { dark: "#ffab00", light: "#d98500" };

/** Whether the scene is drawn on a dark ground, which the overlap's colour
 *  follows. */
function darkScene() {
  return (scene.background?.getHSL({}).l ?? 0) < 0.5;
}
const overlapColour = () => OVERLAP_COLOURS[darkScene() ? "dark" : "light"];

/** How faint a pattern's copies are marked beside their source, marked in
 *  full: the family reads as one leader and its followers, and a click on
 *  any of them selects the source. */
const COPY_OUTLINE = 0.35;

/** How faint what is pointed at is marked: a legend row, or the pointer. */
const HINT_OPACITY = 0.4;

/** How faint the dashed line through a pattern's copies is drawn. */
const TRACE_OPACITY = 0.55;

/** How wide, in pixels, a selected path or wire is drawn. A plain GL line is
 *  one pixel whatever it is asked for, which is easy to miss. */
const OUTLINE_WIDTH = 1.5;

/** How much larger a selected path's markers are drawn, beside its line. */
const PATH_MARKER_GROWTH = 1.6;

/** The wide lines' materials, which must know the view's size in pixels to
 *  draw a width in pixels: told again when it changes (`resize`). */
const wideMaterials = new Set();

/** Mark what `objectIds` stand for -- the selection, or at `opacity` below 1
 *  what the host points at -- and return what was added, to take off again.
 *
 * A shape is marked by a line round its outline (`drawMarks`), never by a
 * colour on it, which says the magnetization -- nor on a marker coloured by
 * the field. A path and a wire are lines, with no outline of their own: they
 * are drawn in the selection's colour instead. A box round an object went round
 * everything drawn for it, path included: a magnet on an orbit got a box
 * the size of the ring, and a ring of them six such boxes, a cage pointing
 * at none of them.
 *
 * Each part hangs on the trace it marks, so it moves with it -- or, where
 * many shapes are marked, on the first of them (`markShapes`).
 */
function outline(objectIds, opacity, copyOpacity = opacity) {
  const added = [];
  const hang = hanger(added);
  const shapes = shapesTo(hang);
  const colour = SELECTION_COLOUR;
  for (const objectId of drawnFor(objectIds)) {
    const node = byObjectId.get(objectId);
    if (!node?.visible) continue;
    for (const trace of node.children) {
      if (!trace.userData.trace) continue; // a handle, or another node
      const own = trace.userData.copy ? copyOpacity : opacity;
      if (!shapes.take(trace, own < 1 ? FAINT : STRONG)) {
        outlineTrace(trace, own, hang, colour, true);
      }
    }
  }
  shapes.done();
  return added;
}

/** Mark what overlaps, in the overlap's colour: each id's own traces and no
 *  others. A pattern's copy is drawn under its source's node and named
 *  there by `userData.copy`, so it is found by that name -- and a source's
 *  mark stays off its copies, which may well be clear. */
function outlineOverlaps(objectIds) {
  const added = [];
  const wanted = new Set(objectIds);
  if (!wanted.size) return added;
  const hang = hanger(added);
  const shapes = shapesTo(hang);
  const colour = overlapColour();
  for (const [objectId, node] of byObjectId) {
    if (!node.visible) continue;
    for (const trace of node.children) {
      if (!trace.userData.trace) continue;
      if (
        wanted.has(trace.userData.copy ?? objectId) &&
        !shapes.take(trace, WARN)
      ) {
        outlineTrace(trace, 1, hang, colour, false); // a path is not what overlaps
      }
    }
  }
  shapes.done();
  return added;
}

/** The shapes of a mark, gathered to be marked at once: each on its own
 *  (`markShape`), or -- `BATCH_FROM` of them and more in one channel -- all
 *  as one (`markShapes`). A body meshed into 5,888 cells, marked cell by
 *  cell, was 5,888 draws. `take` says whether it took a trace: not one that
 *  is no shape, nor one hidden. Traces playing a run are gathered by their
 *  track, which moves them together: a sealed body on a path is one track. */
function shapesTo(hang) {
  const gathered = new Map(); // a channel and a track -> its shapes
  const trackOf = new Map(tracked.map(({ built, track }) => [built, track]));
  return {
    take(trace, channel) {
      if (!trace.isMesh || trace.isLineSegments2 || !shown(trace)) {
        return false;
      }
      const key = `${channel} ${trackOf.get(trace) ?? ""}`;
      if (!gathered.has(key)) gathered.set(key, { channel, meshes: [] });
      gathered.get(key).meshes.push(trace);
      return true;
    },
    done() {
      for (const { channel, meshes } of gathered.values()) {
        if (meshes.length < BATCH_FROM) {
          for (const mesh of meshes) markShape(mesh, channel, hang);
        } else {
          markShapes(meshes, channel, hang);
        }
      }
    },
  };
}

/** A merged mark's shape, by the trace it hangs on: kept while the same
 *  traces are marked, so that a drag's redraw -- every step of it -- does
 *  not put a body's every cell through the GPU again. Let go when that
 *  trace is freed (`free`). */
const mergedMarks = new WeakMap(); // a trace -> its channel -> { meshes, geometry }

/** Many shapes marked as one, hung on the first of them. It moves with them
 *  as long as they move together, which is how they move: a drag carries
 *  everything selected as one rigid motion, and a trace that plays a run of
 *  its own is never among them (`shapesTo`). */
function markShapes(meshes, channel, hang) {
  const on = meshes[0];
  // by channel too: a body selected with another, and hinted alone, is two
  // merges that start with the same cell
  if (!mergedMarks.has(on)) mergedMarks.set(on, new Map());
  const kept = mergedMarks.get(on);
  let merged = kept.get(channel);
  if (
    merged?.meshes.length !== meshes.length ||
    merged.meshes.some((mesh, k) => mesh !== meshes[k])
  ) {
    merged?.geometry.dispose();
    merged = { meshes, geometry: mergedShape(on, meshes) };
    kept.set(channel, merged);
  }
  markShape(on, channel, hang, merged.geometry);
}

/** `meshes` as one geometry, in the frame of `on`: their corners only,
 *  which is all a mark draws. */
function mergedShape(on, meshes) {
  on.updateWorldMatrix(true, false);
  const back = on.matrixWorld.clone().invert();
  const into = new THREE.Matrix4();
  let vertices = 0;
  let corners = 0;
  for (const { geometry } of meshes) {
    const { count } = geometry.attributes.position;
    vertices += count;
    corners += geometry.index?.count ?? count;
  }
  const position = new Float32Array(vertices * 3);
  const index = new Uint32Array(corners);
  let at = 0; // vertices written
  let k = 0; // corners written
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const e = into.multiplyMatrices(back, mesh.matrixWorld).elements;
    const from = mesh.geometry.attributes.position;
    for (let i = 0; i < from.count; i++) {
      const [x, y, z] = [from.getX(i), from.getY(i), from.getZ(i)];
      const o = (at + i) * 3;
      position[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
      position[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      position[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const own = mesh.geometry.index;
    if (own) for (let i = 0; i < own.count; i++) index[k++] = at + own.getX(i);
    else for (let i = 0; i < from.count; i++) index[k++] = at + i;
    at += from.count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

/** A shape's mark: the shape again -- its own geometry, or `geometry` made
 *  for it -- drawn only into the marks' mask, in `channel` (`drawMarks`). */
function markShape(mesh, channel, hang, geometry = mesh.geometry) {
  const part = new THREE.Mesh(geometry, MARK_MATERIALS[channel]);
  part.layers.set(MARK);
  part.userData.mark = true;
  part.userData.borrowed = true; // the shape's geometry, or `mergedMarks`'
  // at its middle, shown while it is small on screen (`markedBox`)
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const dot = new THREE.Points(DOT_GEOMETRY, MARK_DOTS[channel]);
  geometry.boundingBox.getCenter(dot.position);
  dot.layers.set(MARK);
  dot.visible = false;
  dot.frustumCulled = false;
  dot.raycast = () => {};
  part.add(dot);
  part.userData.dot = dot;
  hang(mesh, part);
}

/** How a mark's parts are hung on what they mark, and kept in `added` to
 *  take off again. */
function hanger(added) {
  return (on, part) => {
    part.raycast = () => {}; // an indicator, not a target
    part.renderOrder = 1; // drawn over what it marks
    part.userData.outline = true;
    on.add(part);
    added.push({ on, part });
  };
}

/** One trace that is not a shape drawn in `colour`: a scatter's lines, and
 *  its markers too where it is a path and `markers` says so. A sensor's
 *  markers can be its pixels, coloured by the field they read. */
function outlineTrace(trace, opacity, hang, colour, markers) {
  if (trace.isMesh) return; // a shape hidden: nothing to mark
  for (const part of trace.children) {
    if (part.isLine) {
      const pairs = segmentsOf(part.geometry.getAttribute("position").array);
      if (pairs.length) {
        hang(part, wideSegments(pairs, OUTLINE_WIDTH, opacity, true, colour));
      }
    } else if (markers && trace.userData.path && part.isPoints) {
      hang(part, pathMarkers(part, opacity, colour));
    }
  }
}

/** Lines from `pairs` -- each six numbers, a segment's two ends -- `width`
 *  pixels wide in `colour`. Where they are `shown` they are hidden by what
 *  stands in front, and drawn a little toward the eye, so that a line is
 *  not lost in the faces it runs over; otherwise they show through
 *  everything. */
function wideSegments(pairs, width, opacity, shown, colour) {
  return wideLines(
    new LineSegmentsGeometry().setPositions(pairs),
    width,
    opacity,
    shown,
    colour,
  );
}

/** `wideSegments` on a geometry of segments made already. */
function wideLines(geometry, width, opacity, shown, colour) {
  const material = new LineMaterial({
    linewidth: width,
    transparent: opacity < 1,
    opacity,
    depthTest: shown,
    polygonOffset: shown,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  material.color = new THREE.Color(colour);
  if (renderer) renderer.getSize(material.resolution);
  wideMaterials.add(material);
  return new LineSegments2(geometry, material);
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

/** A path's markers again, larger and in `colour`, over themselves. Their
 *  geometry is the path's own, not a copy. */
function pathMarkers(part, opacity, colour) {
  const copy = new THREE.Points(
    part.geometry,
    new THREE.PointsMaterial({
      color: new THREE.Color(colour),
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
    wideMaterials.delete(part.material);
    free(part);
  }
}

// --- where two overlap --------------------------------------------------
// An overlap is shaded where the two interpenetrate: the region they share,
// hatched in amber and outlined, drawn through whatever stands in front of
// it -- it is inside them both. Worked out here from the shapes drawn, for
// every pair whose shapes are convex solids: a cuboid, a cylinder, a sphere,
// a tetrahedron, a convex mesh, and each cell of a meshed body. Their shared
// region is convex, and bounded by the faces of each that lie inside the
// other: each face clipped by the other's planes. A hollow shape -- a ring,
// a segment of one -- is not convex, and its overlap is marked round it
// only (`outlineOverlaps`). A meshed body's region is a piece a cell, and the
// pieces' inner faces are hidden as a solid's would be: the regions are drawn
// apart, after the picture, on depths of their own (`drawRegions`).

/** A shape too fine to work its faces out on every scene: past this many
 *  triangles it is not shaded. A cylinder is a few hundred. */
const SOLID_MOST_TRIANGLES = 4096;

/** The faces of a convex solid, as planes -- four numbers each, `n` and `d`,
 *  the solid where `n·p + d <= 0` -- in its geometry's own frame; or null
 *  for a shape that is not one: open, flat, hollow, or too fine. Worked
 *  out once per geometry. */
function facesOf(geometry) {
  if (geometry.userData.faces !== undefined) return geometry.userData.faces;
  geometry.userData.faces = null;
  const position = geometry.attributes.position;
  const index = geometry.index;
  const corners = index ? index.count : position.count;
  if (corners / 3 > SOLID_MOST_TRIANGLES) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3()).length();
  if (!size) return null;
  const centre = middleOf(geometry);
  const corner = (k) =>
    new THREE.Vector3().fromBufferAttribute(
      position,
      index ? index.getX(k) : k,
    );
  const faces = [];
  const seen = new Set();
  const across = new THREE.Vector3();
  for (let t = 0; t + 2 < corners; t += 3) {
    const a = corner(t);
    const n = corner(t + 1)
      .sub(a)
      .cross(across.copy(corner(t + 2)).sub(a));
    if (n.length() < 1e-9 * size * size) continue; // a sliver
    n.normalize();
    // outward, away from the middle -- inside a convex solid
    if (n.dot(centre) > n.dot(a)) n.negate();
    const d = -n.dot(a);
    const key = [n.x, n.y, n.z, d / size]
      .map((v) => Math.round(v * 1e4))
      .join();
    if (seen.has(key)) continue;
    seen.add(key);
    faces.push(n.x, n.y, n.z, d);
  }
  if (faces.length < 16) return null; // fewer than four faces: not a solid
  // convex: no corner stands outside any face
  const tolerance = 1e-4 * size;
  const p = new THREE.Vector3();
  for (let v = 0; v < position.count; v++) {
    p.fromBufferAttribute(position, v);
    for (let k = 0; k < faces.length; k += 4) {
      const out = faces[k] * p.x + faces[k + 1] * p.y + faces[k + 2] * p.z;
      if (out + faces[k + 3] > tolerance) return null;
    }
  }
  geometry.userData.faces = Float64Array.from(faces);
  return geometry.userData.faces;
}

/** The mean of a geometry's corners, in its own frame: inside a convex solid,
 *  as the middle of its box is not -- a tetrahedron's corner of a cube. */
function middleOf(geometry) {
  if (!geometry.userData.middle) {
    const position = geometry.attributes.position;
    const middle = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let v = 0; v < position.count; v++) {
      middle.add(p.fromBufferAttribute(position, v));
    }
    geometry.userData.middle = middle.divideScalar(position.count || 1);
  }
  return geometry.userData.middle;
}

/** `faces` carried by `matrix` into the world. */
function worldFaces(faces, matrix) {
  const turn = new THREE.Matrix3().getNormalMatrix(matrix);
  const n = new THREE.Vector3();
  const on = new THREE.Vector3();
  const out = new Float64Array(faces.length);
  for (let k = 0; k < faces.length; k += 4) {
    n.set(faces[k], faces[k + 1], faces[k + 2]);
    on.copy(n)
      .multiplyScalar(-faces[k + 3])
      .applyMatrix4(matrix);
    n.applyMatrix3(turn).normalize();
    out.set([n.x, n.y, n.z, -n.dot(on)], k);
  }
  return out;
}

/** `polygon` -- corners, three numbers each -- cut back to the side of face
 *  `k` of `faces` the solid is on, `margin` beyond it kept, so that a face
 *  lying in it is kept whole. */
function clipped(polygon, faces, k, margin) {
  const [nx, ny, nz, d] = faces.subarray(k, k + 4);
  const out = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    const dp = nx * p[0] + ny * p[1] + nz * p[2] + d - margin;
    const dq = nx * q[0] + ny * q[1] + nz * q[2] + d - margin;
    if (dp <= 0) out.push(p);
    if (dp <= 0 !== dq <= 0) {
      const t = dp / (dp - dq);
      out.push([
        p[0] + t * (q[0] - p[0]),
        p[1] + t * (q[1] - p[1]),
        p[2] + t * (q[2] - p[2]),
      ]);
    }
  }
  return out;
}

/** Whether world point `p` lies within `faces`, `margin` beyond them kept. */
function within(p, faces, margin) {
  for (let k = 0; k < faces.length; k += 4) {
    const out = faces[k] * p[0] + faces[k + 1] * p[1] + faces[k + 2] * p[2];
    if (out + faces[k + 3] > margin) return false;
  }
  return true;
}

/** The faces of `mesh` that lie within `faces` -- another solid's, in the
 *  world, inside `box` -- added to `points` as world triangles, nine numbers
 *  each. A face clear of the box is passed over unclipped: of a cylinder's
 *  hundreds, a cell of a meshed body reaches a few. A face with one of
 *  `beside` -- the other cells of its body, `{ box, faces }` -- just outside
 *  it lies between two cells, inside the region, and is left out; and, where
 *  `shared`, one lying in a face of the other solid, which has given it. */
function clipShape(points, mesh, faces, box, margin, beside, shared) {
  const position = mesh.geometry.attributes.position;
  const index = mesh.geometry.index;
  const corners = index ? index.count : position.count;
  const e = mesh.matrixWorld.elements;
  const corner = (k) => {
    const v = index ? index.getX(k) : k;
    const [x, y, z] = [position.getX(v), position.getY(v), position.getZ(v)];
    return [
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14],
    ];
  };
  const { min, max } = box;
  const clear = (polygon, i) =>
    polygon.every((p) => p[i] < min.getComponent(i) - margin) ||
    polygon.every((p) => p[i] > max.getComponent(i) + margin);
  const middle = middleOf(mesh.geometry).clone().applyMatrix4(mesh.matrixWorld);
  const lying = (polygon) => {
    for (let k = 0; k < faces.length; k += 4) {
      const [nx, ny, nz, d] = faces.subarray(k, k + 4);
      const off = (p) => Math.abs(nx * p[0] + ny * p[1] + nz * p[2] + d);
      if (polygon.every((p) => off(p) <= 10 * margin)) return true;
    }
    return false;
  };
  const out = new THREE.Vector3();
  const [n, across] = [new THREE.Vector3(), new THREE.Vector3()];
  const step = 1e3 * margin;
  for (let t = 0; t + 2 < corners; t += 3) {
    let polygon = [corner(t), corner(t + 1), corner(t + 2)];
    if (clear(polygon, 0) || clear(polygon, 1) || clear(polygon, 2)) continue;
    // the face's normal, away from its solid's middle
    const [p, q, r] = polygon;
    n.set(q[0] - p[0], q[1] - p[1], q[2] - p[2]).cross(
      across.set(r[0] - p[0], r[1] - p[1], r[2] - p[2]),
    );
    if (n.dot(out.set(...p).sub(middle)) < 0) n.negate();
    n.normalize();
    for (let k = 0; k < faces.length && polygon.length > 2; k += 4) {
      polygon = clipped(polygon, faces, k, margin);
    }
    if (polygon.length < 3 || (shared && lying(polygon))) continue;
    if (beside.length) {
      out.set(0, 0, 0);
      for (const corner of polygon) out.add(across.set(...corner));
      out.divideScalar(polygon.length).addScaledVector(n, step);
      const there = out.toArray();
      const between = beside.some(
        (cell) =>
          cell.mesh !== mesh &&
          cell.box.containsPoint(out) &&
          within(there, cell.faces, margin),
      );
      if (between) continue;
    }
    for (let i = 1; i + 1 < polygon.length; i++) {
      points.push(...polygon[0], ...polygon[i], ...polygon[i + 1]);
    }
  }
}

/** The solids drawn now for each of `ids`, by the id an overlap names it by:
 *  a pattern's copy by its own, though drawn on its source's node. */
function solidsById(ids) {
  const wanted = new Set(ids);
  const solids = new Map();
  for (const [objectId, node] of byObjectId) {
    if (!node.visible) continue;
    for (const trace of node.children) {
      const id = trace.userData.copy ?? objectId;
      if (!wanted.has(id) || !trace.userData.solid || !shown(trace)) continue;
      if (!solids.has(id)) solids.set(id, []);
      solids.get(id).push(trace);
    }
  }
  return solids;
}

/** Where `as` and `bs` -- two objects' solids -- interpenetrate, as world
 *  triangles; empty where none of them are convex solids that do. A meshed
 *  body's cells are compared only where they reach the other's box, and only
 *  those have their faces worked out. */
function sharedRegion(as, bs) {
  const boxOf = (mesh) => {
    mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  };
  const spanning = (boxes) =>
    boxes.reduce((all, box) => all.union(box), new THREE.Box3());
  let a = as.map((mesh) => ({ mesh, box: boxOf(mesh) }));
  let b = bs.map((mesh) => ({ mesh, box: boxOf(mesh) }));
  const reachB = spanning(b.map(({ box }) => box));
  a = a.filter(({ box }) => box.intersectsBox(reachB));
  const reachA = spanning(a.map(({ box }) => box));
  b = b.filter(({ box }) => box.intersectsBox(reachA));
  const faces = new Map(); // a solid -> its faces in the world, once
  const facesIn = ({ mesh }) => {
    if (!faces.has(mesh)) {
      faces.set(mesh, worldFaces(facesOf(mesh.geometry), mesh.matrixWorld));
    }
    return faces.get(mesh);
  };
  a = a.filter(({ mesh }) => facesOf(mesh.geometry));
  b = b.filter(({ mesh }) => facesOf(mesh.geometry));
  // a body's cells, each beside the others: see `clipShape`
  const cells = (side) =>
    side.length > 1 ? side.map((s) => ({ ...s, faces: facesIn(s) })) : [];
  const [cellsA, cellsB] = [cells(a), cells(b)];
  const points = [];
  for (const one of a) {
    for (const other of b) {
      if (!one.box.intersectsBox(other.box)) continue;
      const margin = 1e-6 * one.box.getSize(new THREE.Vector3()).length();
      clipShape(points, one.mesh, facesIn(other), other.box, margin, cellsA);
      clipShape(
        points,
        other.mesh,
        facesIn(one),
        one.box,
        margin,
        cellsB,
        true,
      );
    }
  }
  return points;
}

let regionsDrawn = false; // whether any region is hung: see `drawRegions`

/** Each pair's region, kept while neither of the two moves or is drawn
 *  again: a selection, a hint or a frame redraws the marks, and a region
 *  over a meshed body's cells is many milliseconds to work out. */
const keptRegions = new Map(); // a pair's key -> { pose, on, geometry, edges }

/** Where `solids` stand: how many, the first, and its place in the world. A
 *  body's cells move together, with their node; drawn again, they are new. */
function standingOf(solids) {
  if (!solids.length) return "";
  solids[0].updateWorldMatrix(true, false);
  const { uuid, matrixWorld } = solids[0];
  return `${solids.length} ${uuid} ${matrixWorld.elements.join()}`;
}

/** Shade each overlapping pair where it interpenetrates: the region, hung on
 *  the first solid of the first of the two, and its edges. */
function shadeOverlaps(pairs) {
  const added = [];
  const solids = pairs.length ? solidsById(idsOf(pairs)) : new Map();
  const hang = (on, part) => {
    part.raycast = () => {}; // an indicator, not a target
    part.userData.region = true;
    part.userData.borrowed = true; // `keptRegions`'
    part.layers.set(REGION);
    on.add(part);
    added.push({ on, part });
  };
  const shaded = new Set(); // the pairs shaded now: the rest are let go
  for (const pair of pairs) {
    const key = pairKey(pair);
    shaded.add(key);
    const [as, bs] = pair.map((id) => solids.get(id) ?? []);
    const pose = `${standingOf(as)} | ${standingOf(bs)}`;
    let kept = keptRegions.get(key);
    if (kept?.pose !== pose) {
      if (kept) dropRegion(kept);
      kept = { pose, ...regionOf(as, bs) };
      keptRegions.set(key, kept);
    }
    if (!kept.geometry) continue;
    // its nearest faces' depths first, then the hatch on those alone
    hang(kept.on, new THREE.Mesh(kept.geometry, REGION_DEPTH));
    const shading = new THREE.Mesh(kept.geometry, REGION_MATERIAL);
    shading.renderOrder = 1;
    hang(kept.on, shading);
    if (kept.edges) {
      // in front of the shading, hidden by it where it is behind
      const line = wideLines(kept.edges, 1.25, 0.9, true, overlapColour());
      line.renderOrder = 2;
      hang(kept.on, line);
    }
  }
  regionsDrawn = added.length > 0;
  for (const [key, kept] of keptRegions) {
    if (shaded.has(key)) continue;
    dropRegion(kept);
    keptRegions.delete(key);
  }
  return added;
}

/** The region `as` and `bs` share, in the frame of the first of `as`, and its
 *  edges: `{ on, geometry, edges }`, nothing where they share none. */
function regionOf(as, bs) {
  const points = sharedRegion(as, bs);
  if (!points.length) return {};
  const on = as[0];
  const back = on.matrixWorld.clone().invert();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(points, 3).applyMatrix4(back),
  );
  const pairs = regionEdges(geometry);
  const edges = pairs.length
    ? new LineSegmentsGeometry().setPositions(pairs)
    : null;
  return { on, geometry, edges };
}

function dropRegion({ geometry, edges }) {
  geometry?.dispose();
  edges?.dispose();
}

/** The edges of a region, as `wideSegments` takes them: found at the
 *  region's own size, since three merges corners closer than 1e-4 -- a
 *  tenth of a millimetre in a scene in metres, which a small overlap is. */
function regionEdges(geometry) {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3()).length();
  if (!size) return [];
  const centre = geometry.boundingBox.getCenter(new THREE.Vector3());
  const unit = geometry.clone();
  unit
    .translate(-centre.x, -centre.y, -centre.z)
    .scale(1 / size, 1 / size, 1 / size);
  const found = new THREE.EdgesGeometry(unit, EDGE_ANGLE);
  unit.dispose();
  const pairs = found.attributes.position.array;
  found.dispose();
  for (let i = 0; i < pairs.length; i += 3) {
    pairs[i] = pairs[i] * size + centre.x;
    pairs[i + 1] = pairs[i + 1] * size + centre.y;
    pairs[i + 2] = pairs[i + 2] * size + centre.z;
  }
  return pairs;
}

/** A region's depths, drawn first and nothing else: the hatch is then drawn
 *  only on the nearest face, once a pixel -- a little toward the eye, since
 *  two programs place a vertex a rounding apart. */
const REGION_DEPTH = new THREE.MeshBasicMaterial({
  colorWrite: false,
  side: THREE.DoubleSide,
});

/** An overlap's shading: stripes across the screen, the draughtsman's hatch
 *  for a section, in the overlap's colour. Drawn on depths of its own, so a
 *  pixel shows the region's nearest face only, however many lie behind. */
const REGION_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    colour: { value: new THREE.Color() },
    opacity: { value: 1 },
    period: { value: 7 }, // pixels from a stripe to the next
  },
  vertexShader: `
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 colour;
    uniform float opacity;
    uniform float period;
    void main() {
      float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / period));
      gl_FragColor = vec4(colour, min(1.0, opacity * mix(0.2, 0.7, stripe)));
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
  side: THREE.DoubleSide,
});

/** The layer the overlaps' regions are on, which the picture does not draw:
 *  `drawRegions` does, after it. */
const REGION = 4;

/** Draw the overlaps' regions over the picture, through what stands in front
 *  of them, each pixel its nearest face. */
function drawRegions() {
  if (!regionsDrawn) return;
  const kept = {
    autoClear: renderer.autoClear,
    background: scene.background,
    layers: camera.layers.mask,
    update: scene.matrixWorldAutoUpdate,
  };
  try {
    renderer.autoClear = false;
    renderer.clearDepth();
    scene.background = null;
    scene.matrixWorldAutoUpdate = false; // brought up to date by the picture
    camera.layers.set(REGION);
    renderer.render(scene, camera);
  } finally {
    camera.layers.mask = kept.layers;
    scene.background = kept.background;
    scene.matrixWorldAutoUpdate = kept.update;
    renderer.autoClear = kept.autoClear;
  }
}

/** The overlaps' shading as it looks now: in the scene's amber, and
 *  blinking twice as an overlap comes (`cuesAt`). */
function lookOfOverlaps({ blink }) {
  if (!overlaps.length) return;
  const { uniforms } = REGION_MATERIAL;
  uniforms.colour.value.set(overlapColour());
  uniforms.opacity.value = 1 + 0.8 * blink;
  uniforms.period.value = 7 * renderer.getPixelRatio();
}

// --- how marks are drawn ------------------------------------------------
// A line round the outline of what is selected rather than a colour on it:
// colour *is* the data here -- it carries magnetization direction and field
// magnitude -- so a highlight that repainted the object would overwrite what
// the user is looking at. The outline is the silhouette only, not every edge
// a shape has: those read as a wireframe, and a meshed body's cells as a
// mesh. It is bold, three pixels and a short halo: a glow with a thin line
// was barely there, and the rest faded dimmed field lines being dragged
// (docs/decisions.md#0038-the-selection-is-outlined).
//
// The shapes marked are drawn flat into a mask. It says, pixel by pixel,
// which marks a shape there carries -- red for the selection, green for a
// faint mark, blue for an overlap -- and, in alpha, whether any opaque shape
// is there at all. Those are drawn first, black (`MASK`), so a mark is hidden
// where something stands in front of it. The line is drawn outside each
// marked shape, where the mask changes, and the halo from the mask blurred.
// Drawn only while something is marked, near it, a sample a pixel of the
// screen's, and let go when nothing is.

/** The layer every opaque shape is also on, a batch as one: what hides a
 *  mark behind it. */
const MASK = 2;
/** The layer a mark's own shapes are on, which only the mask draws. */
const MARK = 3;
// the mask's channels
const STRONG = 0; // the selection
const FAINT = 1; // what is pointed at, a selected pattern's copies
const WARN = 2; // what overlaps

const FLAT_VERTEX = `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/** A mark's shape in its channel of the mask, a little toward the eye so
 *  that it is not hidden by itself, drawn black beneath it. */
const CHANNELS = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
/** How strongly a mark is drawn into the mask: in full where it shows, and
 *  faintly where something hides it, which is drawn first (`drawMarks`). */
const MARK_LEVEL = { value: 1 };
const HIDDEN_LEVEL = 0.4;
const MARK_FRAGMENT = `
  uniform vec3 channel;
  uniform float level;
  void main() { gl_FragColor = vec4(channel * level, 1.0); }`;
const MARK_MATERIALS = CHANNELS.map(
  (channel) =>
    new THREE.ShaderMaterial({
      uniforms: {
        channel: { value: new THREE.Vector3(...channel) },
        level: MARK_LEVEL,
      },
      vertexShader: FLAT_VERTEX,
      fragmentShader: MARK_FRAGMENT,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
);

/** A dot in a mark's channel, a few pixels across, for a shape too small on
 *  screen to cover a pixel of the mask: what is selected always shows. */
const DOT_SIZE = { value: 4 }; // the screen's pixels: see `drawMarks`
const MARK_DOTS = CHANNELS.map(
  (channel) =>
    new THREE.ShaderMaterial({
      uniforms: {
        channel: { value: new THREE.Vector3(...channel) },
        level: MARK_LEVEL,
        size: DOT_SIZE,
      },
      vertexShader: `
        uniform float size;
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size;
        }`,
      fragmentShader: MARK_FRAGMENT,
    }),
);
const DOT_GEOMETRY = new THREE.BufferGeometry().setAttribute(
  "position",
  new THREE.Float32BufferAttribute([0, 0, 0], 3),
);

/** Every opaque shape, in black: in the mask's alpha, and in its depth. */
const HIDER = new THREE.MeshBasicMaterial({
  color: 0x000000,
  side: THREE.DoubleSide,
});

/** A pass over the whole picture: one triangle that covers it. */
const fullView = new THREE.Mesh(
  new THREE.BufferGeometry()
    .setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    )
    .setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2),
    ),
);
fullView.frustumCulled = false;
const fullScene = new THREE.Scene().add(fullView);
const fullCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const FULL_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

/** Half a Gaussian blur, along `stride`: nine taps in five reads, the
 *  filtering doing the rest. */
const BLUR_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    source: { value: null },
    stride: { value: new THREE.Vector2() },
  },
  vertexShader: FULL_VERTEX,
  fragmentShader: `
    uniform sampler2D source;
    uniform vec2 stride;
    varying vec2 vUv;
    void main() {
      vec3 sum = texture2D(source, vUv).rgb * 0.2270270;
      sum += (texture2D(source, vUv + stride * 1.3846154).rgb +
              texture2D(source, vUv - stride * 1.3846154).rgb) * 0.3162162;
      sum += (texture2D(source, vUv + stride * 3.2307692).rgb +
              texture2D(source, vUv - stride * 3.2307692).rgb) * 0.0702703;
      gl_FragColor = vec4(sum, 1.0);
    }`,
  depthTest: false,
  depthWrite: false,
});

/** How far the halo round a line reaches: in steps of the half-size blur,
 *  each two CSS pixels, some ten past the edge. A pixel further off is done
 *  with in one read. */
const HALO_STRIDE = 1.5;

/** The marks laid over the picture: each channel's line round its shapes and
 *  a halo fading out from it, in its colour -- an overlap's under a faint
 *  mark's under the selection's. */
const MARKS_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    mask: { value: null },
    around: { value: null }, // the mask blurred: where a mark is near
    texel: { value: new THREE.Vector2() },
    pixel: { value: 1 }, // the screen's pixels in a CSS pixel
    strong: { value: new THREE.Color() },
    faint: { value: new THREE.Color() },
    warn: { value: new THREE.Color() },
    edge: { value: new THREE.Vector3() }, // each channel's line
    halo: { value: new THREE.Vector3() }, // and its halo
    neighbour: { value: 0.5 }, // how much of a halo falls on another shape
  },
  vertexShader: FULL_VERTEX,
  fragmentShader: `
    uniform sampler2D mask;
    uniform sampler2D around;
    uniform vec2 texel;
    uniform float pixel;
    uniform vec3 strong;
    uniform vec3 faint;
    uniform vec3 warn;
    uniform vec3 edge;
    uniform vec3 halo;
    uniform float neighbour;
    varying vec2 vUv;
    // each channel's most, three CSS pixels round: a shape's edge, from outside
    vec3 rim() {
      vec3 most = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7853982;
        vec2 toward = vec2(cos(a), sin(a)) * texel * pixel;
        for (int k = 1; k <= 3; k++) {
          most = max(most, texture2D(mask, vUv + float(k) * toward).rgb);
        }
      }
      return most;
    }
    // the mask here, its edge softened over a pixel as the picture's are
    vec4 at() {
      vec2 d = 0.5 * texel;
      return 0.25 * (texture2D(mask, vUv + vec2(-d.x, -d.y)) + texture2D(mask, vUv + vec2(d.x, -d.y)) +
                     texture2D(mask, vUv + vec2(-d.x, d.y)) + texture2D(mask, vUv + vec2(d.x, d.y)));
    }
    vec4 over(vec4 under, vec3 colour, float alpha) {
      return vec4(colour * alpha + under.rgb * (1.0 - alpha), alpha + under.a * (1.0 - alpha));
    }
    void main() {
      vec3 reach = texture2D(around, vUv).rgb;
      // nothing marked near -- most of the box -- in one read
      if (max(reach.r, max(reach.g, reach.b)) < 0.002) discard;
      vec4 here = at();
      // a mark here, shown or hidden (\`HIDDEN_LEVEL\`): no halo on it
      vec3 covered = min(here.rgb * 4.0, vec3(1.0));
      vec3 outside = 1.0 - covered;
      // held back over another shape, a neighbour in a ring
      vec3 other = clamp(here.a - covered, 0.0, 1.0);
      vec3 glow = reach * outside * mix(vec3(1.0), vec3(neighbour), other) * halo;
      // the line where the mark steps down: in full round what shows, faint
      // round what is hidden
      vec3 line = clamp((rim() - here.rgb) * edge + glow, 0.0, 1.0);
      vec4 sum = over(over(over(vec4(0.0), warn, line.b), faint, line.g), strong, line.r);
      if (sum.a < 0.002) discard;
      gl_FragColor = vec4(sum.rgb / sum.a, sum.a);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthTest: false,
  depthWrite: false,
});

/** Draw `material` over the whole of `target`, or of the canvas. */
function overAll(material, target) {
  fullView.material = material;
  renderer.setRenderTarget(target);
  renderer.render(fullScene, fullCamera);
}

/** The mask and its blur, while anything is marked: `{ mask, across, down }`. */
let markTargets = null;
let marking = false; // whether anything is marked: see `countMarks`

/** Whether any shape is marked, which the marks are drawn for. */
function countMarks() {
  marking = [outlines, hints].some((added) =>
    added.some(({ part }) => part.userData.mark),
  );
}

/** The mask and its blur at `width` by `height`, made the first time. */
function targetsFor(width, height) {
  markTargets ??= {
    mask: new THREE.WebGLRenderTarget(1, 1),
    across: new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }),
    down: new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }),
  };
  const { mask, across, down } = markTargets;
  if (mask.width !== width || mask.height !== height) {
    mask.setSize(width, height);
    across.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
    down.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
  }
  return markTargets;
}

/** Where on the view the marks can fall: round every marked shape on
 *  screen, `margin` wider all round, in the drawing buffer's pixels from its
 *  lower left -- the whole view where a shape reaches behind the eye -- or
 *  null where none is in view. The passes are kept to it, so what a mark
 *  costs goes with its size on screen, not the view's. */
function markedBox(width, height, margin) {
  const box = new THREE.Box2();
  const corner = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const own = new THREE.Box2();
  for (const { part } of [...outlines, ...hints]) {
    if (!part.userData.mark || !shown(part)) continue;
    const { geometry } = part;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    own.makeEmpty();
    for (let i = 0; i < 8; i++) {
      corner
        .set(
          i & 1 ? max.x : min.x,
          i & 2 ? max.y : min.y,
          i & 4 ? max.z : min.z,
        )
        .applyMatrix4(part.matrixWorld);
      eye.copy(corner).applyMatrix4(camera.matrixWorldInverse);
      if (camera.isPerspectiveCamera && eye.z >= 0) {
        return { x: 0, y: 0, width, height };
      }
      corner.project(camera);
      own.expandByPoint(new THREE.Vector2(corner.x, corner.y));
    }
    box.union(own);
    // a shape a few pixels across is marked by its dot as well
    const across = Math.max(
      ((own.max.x - own.min.x) / 2) * width,
      ((own.max.y - own.min.y) / 2) * height,
    );
    part.userData.dot.visible = across < 4 * renderer.getPixelRatio();
  }
  if (box.isEmpty()) return null;
  const x0 = Math.max(0, Math.floor(((box.min.x + 1) / 2) * width - margin));
  const y0 = Math.max(0, Math.floor(((box.min.y + 1) / 2) * height - margin));
  const x1 = Math.min(width, Math.ceil(((box.max.x + 1) / 2) * width + margin));
  const y1 = Math.min(
    height,
    Math.ceil(((box.max.y + 1) / 2) * height + margin),
  );
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** When an overlap that was not there came: its shading blinks twice
 *  (`cuesAt`) and then holds still, asking for no frame, as nothing in an
 *  idle view does (`redraw`). */
const cueTimes = { warned: -Infinity };
const BLINK_MS = 1400;

/** How the overlaps' shading looks at `now`. */
function cuesAt(now) {
  const warned = lessMotion
    ? 1
    : Math.max(0, (now - cueTimes.warned) / BLINK_MS);
  return {
    blink: warned < 1 ? Math.max(0, Math.sin(4 * Math.PI * warned)) : 0,
    settling: warned < 1,
  };
}

/** Whether a blink is under way, and wants the next frame. */
function settling(now) {
  return regionsDrawn && cuesAt(now).settling;
}

/** Lay the marks over the picture just drawn. */
function drawMarks() {
  if (!marking) {
    if (markTargets) {
      for (const target of Object.values(markTargets)) target.dispose();
      markTargets = null;
    }
    return;
  }
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const { mask, across, down } = targetsFor(
    Math.max(1, size.x),
    Math.max(1, size.y),
  );
  const pixel = renderer.getPixelRatio();
  const box = markedBox(size.x, size.y, Math.ceil(16 * pixel));
  if (!box) return;
  const colours = [SELECTION_COLOUR, overlapColour()]; // by the ground, set aside below
  const kept = {
    autoClear: renderer.autoClear,
    colour: renderer.getClearColor(new THREE.Color()),
    alpha: renderer.getClearAlpha(),
    background: scene.background,
    layers: camera.layers.mask,
    update: scene.matrixWorldAutoUpdate,
  };
  try {
    renderer.autoClear = false;
    scene.background = null;
    scene.matrixWorldAutoUpdate = false; // brought up to date by the picture
    renderer.setClearColor(0x000000, 0);
    // Cleared whole, which is cheap, and drawn in the box only: a pass reads
    // a little round what it draws, and finds nothing there.
    for (const [target, scale] of [
      [mask, 1],
      [across, 0.5],
      [down, 0.5],
    ]) {
      target.scissorTest = false;
      renderer.setRenderTarget(target);
      renderer.clear();
      target.scissor.set(
        Math.floor(box.x * scale),
        Math.floor(box.y * scale),
        Math.ceil(box.width * scale),
        Math.ceil(box.height * scale),
      );
      target.scissorTest = true;
    }
    renderer.setRenderTarget(mask);
    scene.overrideMaterial = HIDER;
    camera.layers.set(MASK);
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    // the marks faintly through what hides them, then in full where they show
    camera.layers.set(MARK);
    DOT_SIZE.value = 4 * pixel;
    for (const [level, depthTest] of [
      [HIDDEN_LEVEL, false],
      [1, true],
    ]) {
      MARK_LEVEL.value = level;
      for (const material of [...MARK_MATERIALS, ...MARK_DOTS]) {
        material.depthTest = depthTest;
        material.uniformsNeedUpdate = true;
      }
      renderer.render(scene, camera);
    }
    camera.layers.mask = kept.layers;
    BLUR_MATERIAL.uniforms.source.value = mask.texture;
    BLUR_MATERIAL.uniforms.stride.value.set(
      (HALO_STRIDE * pixel) / across.width,
      0,
    );
    overAll(BLUR_MATERIAL, across);
    BLUR_MATERIAL.uniforms.source.value = across.texture;
    BLUR_MATERIAL.uniforms.stride.value.set(
      0,
      (HALO_STRIDE * pixel) / down.height,
    );
    overAll(BLUR_MATERIAL, down);
    const { uniforms } = MARKS_MATERIAL;
    uniforms.mask.value = mask.texture;
    uniforms.around.value = down.texture;
    uniforms.texel.value.set(1 / mask.width, 1 / mask.height);
    uniforms.pixel.value = pixel;
    uniforms.strong.value.set(colours[0]);
    uniforms.faint.value.set(colours[0]);
    uniforms.warn.value.set(colours[1]);
    uniforms.edge.value.set(1, 0.45, 0.8);
    uniforms.halo.value.set(1.8, 0.6, 0.5);
    renderer.setScissor(
      box.x / pixel,
      box.y / pixel,
      box.width / pixel,
      box.height / pixel,
    );
    renderer.setScissorTest(true);
    overAll(MARKS_MATERIAL, null);
  } finally {
    renderer.setScissorTest(false);
    scene.overrideMaterial = null;
    camera.layers.mask = kept.layers;
    scene.background = kept.background;
    scene.matrixWorldAutoUpdate = kept.update;
    renderer.setRenderTarget(null);
    renderer.setClearColor(kept.colour, kept.alpha);
    renderer.autoClear = kept.autoClear;
  }
}

function buildMesh(item) {
  const geometry = new THREE.BufferGeometry();
  // the engine's own numbers, which a snap lands on: the buffer's are
  // 32-bit, a few nanometres out at a magnet's size
  geometry.userData.exact = item.position;
  const options = {
    transparent: item.opacity < 1,
    opacity: item.opacity,
    side: THREE.DoubleSide,
  };

  const lut = typeof item.lut === "number" ? luts[item.lut] : item.lut;
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
  if (item.back_uv) {
    // A triangle magnetized through it, a pole's colour on each face: this
    // side drawn only where it faces the eye, and the other on a twin of
    // it, so the two are never drawn over each other (`threejs._two_faced`).
    mesh.material.side = THREE.FrontSide;
    const under = geometry.clone();
    under.setAttribute("uv", new THREE.Float32BufferAttribute(item.back_uv, 2));
    mesh.add(
      new THREE.Mesh(
        under,
        new THREE.MeshLambertMaterial({ ...options, side: THREE.BackSide }),
      ),
    );
  }
  if (item.streams) {
    const flow = flowLine(withPenLifts(item.streams), {
      colour: streamColour(item.color),
      width: 3,
      opacity: item.opacity,
      flow: item.flow,
      spacing: item.spacing,
      onSurface: true,
    });
    if (flow) mesh.add(flow);
  }
  mesh.name = item.name;
  mesh.userData.trace = true;
  // coloured face by face: a sensor's axes, or its arrows by the field
  mesh.userData.faceColoured = Boolean(item.facecolor);
  // a body that may overlap another, shaded where it does (`shadeOverlaps`):
  // not a sensor, a current's sheet or arrows, nor a triangle with no inside
  mesh.userData.solid =
    !item.facecolor && !item.back_uv && !item.streams && !item.arrows;
  // one of many drawn alike, which a batch may draw for it (`rebatch`)
  const alike =
    !item.facecolor &&
    !item.back_uv &&
    !item.streams &&
    !item.arrows &&
    !(item.opacity < 1);
  if (alike) {
    mesh.userData.batch = lut
      ? lutKey(lut)
      : `#${options.color.getHexString()}`;
    mesh.userData.lut = lut ?? null;
  }
  return mesh;
}

// --- many magnets, few draws --------------------------------------------
// A scene of thousands of magnets -- a body meshed into cells -- drew each
// as a draw call of its own: 15 ms a frame to orbit a U-core of 5,888
// cells, 68 with the CPU four times slower. Its traces still hang on their
// objects' nodes, where they are picked, outlined, framed and snapped to,
// but on a layer the camera does not draw (`BATCHED`); what it draws is one
// `THREE.BatchedMesh` per colouring, holding each trace as an instance of
// its own. An instance follows its trace's pose every frame while the trace
// can move -- dragged, or playing a path -- and is not drawn while its
// trace is hidden; a faded trace, see-through, is drawn on its own. A
// colouring of fewer than `BATCH_FROM` traces is drawn as it was.
//
// Kept by flags, not calls: whatever builds or frees a trace marks the
// batches out of date, whatever hides or fades one their looks, a new
// selection what moves; `keepBatches`, before every draw, does what is due,
// once, however many marked it.
const BATCH_FROM = 64;
const batches = new Map(); // a colouring -> { mesh, live, dead, size }
const inBatch = new Map(); // a trace -> { key, instance, at }
const lutKeys = new WeakMap(); // a colour table -> its key, computed once
let batchesStale = false; // traces built or freed
const relook = new Set(); // traces hidden, shown or faded since the last look
let moversStale = false; // the selection, or what plays, changed
let movers = []; // the batched traces whose pose a batch follows

function lutKey(lut) {
  let key = lutKeys.get(lut);
  if (key === undefined) {
    key = `lut ${Array.from(lut).join(",")}`;
    lutKeys.set(lut, key);
  }
  return key;
}

/** Bring the batches up to what the flags say changed: before every draw. */
function keepBatches() {
  if (batchesStale) {
    batchesStale = false;
    rebatch();
    moversStale = true;
  }
  for (const part of relook) look(part);
  relook.clear();
  if (moversStale) {
    moversStale = false;
    movers = [];
    for (const objectId of drawnFor(selectedIds)) {
      for (const part of byObjectId.get(objectId)?.children ?? []) {
        if (inBatch.has(part)) movers.push(part);
      }
    }
    for (const { built } of tracked) {
      if (inBatch.has(built)) movers.push(built);
    }
  }
  for (const part of movers) follow(part);
}

/** Draw a batched trace by its batch, or on its own while see-through,
 *  or not at all while hidden. */
function look(part) {
  const entry = inBatch.get(part);
  if (!entry) return;
  const drawn = shown(part);
  const clear = part.material.transparent;
  batches.get(entry.key).mesh.setVisibleAt(entry.instance, drawn && !clear);
  part.layers.set(drawn && clear ? 0 : BATCHED);
}

/** Put a trace's instance where the trace now stands, if it moved. */
function follow(part) {
  const entry = inBatch.get(part);
  if (!entry) return;
  part.updateWorldMatrix(true, false);
  if (entry.at.equals(part.matrixWorld)) return;
  entry.at.copy(part.matrixWorld);
  batches.get(entry.key).mesh.setMatrixAt(entry.instance, entry.at);
}

/** Batch what may be batched now: the traces gone out of their batches,
 *  the new ones in. An instance is deleted in place, its geometry left as
 *  dead space; a batch more dead than live is built again whole, as after a
 *  scene drawn afresh, whose traces are all new. */
function rebatch() {
  const kinds = new Map(); // a colouring -> its traces, drawn now
  for (const node of byObjectId.values()) {
    for (const part of node.children) {
      const key = part.userData.batch;
      if (!key) continue;
      if (!kinds.has(key)) kinds.set(key, []);
      kinds.get(key).push(part);
    }
  }
  const now = new Set([...kinds.values()].flat());
  for (const [part, entry] of inBatch) {
    const kind = kinds.get(entry.key);
    if (!now.has(part) || kind.length < BATCH_FROM) unbatch(part, entry);
  }
  // A batch built again keeps its material: a material disposed takes its
  // shader program with it, and the next frame compiles it again (#44).
  // One whose colouring is gone goes, colour table and all.
  const spare = new Map();
  for (const [key, batch] of batches) {
    if (batch.live && batch.dead <= batch.live) continue;
    for (const [part, entry] of inBatch) {
      if (entry.key === key) unbatch(part, entry);
    }
    scene.remove(batch.mesh);
    spare.set(key, batch.mesh.material);
    batch.mesh.dispose();
    batches.delete(key);
  }
  for (const [key, parts] of kinds) {
    if (parts.length < BATCH_FROM) continue;
    const joining = parts.filter((part) => !inBatch.has(part));
    if (joining.length) join(key, joining, spare.get(key));
    spare.delete(key);
  }
  for (const material of spare.values()) {
    material.map?.dispose();
    material.dispose();
  }
}

function unbatch(part, entry) {
  const batch = batches.get(entry.key);
  batch.mesh.deleteInstance(entry.instance);
  const count = part.geometry.attributes.position.count;
  batch.live -= count;
  batch.dead += count;
  part.layers.set(0);
  if (!part.material.transparent) part.layers.enable(MASK);
  inBatch.delete(part);
}

/** Add `parts` to the batch of colouring `key`, made or grown for them --
 *  made with `material` where one is to hand. */
function join(key, parts, material) {
  let vertices = 0;
  let corners = 0;
  for (const part of parts) {
    vertices += part.geometry.attributes.position.count;
    corners += part.geometry.index?.count ?? 0;
  }
  let batch = batches.get(key);
  if (!batch) {
    const size = { vertices, corners: Math.max(corners, 1) };
    const mesh = new THREE.BatchedMesh(
      parts.length,
      size.vertices,
      size.corners,
      material ?? batchMaterial(parts[0]),
    );
    // drawn whole, unsorted: an opaque scene in view needs neither, and
    // both cost a pass over every instance every frame
    mesh.perObjectFrustumCulled = false;
    mesh.sortObjects = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.layers.enable(MASK); // its instances hide a mark as they would alone
    scene.add(mesh);
    batch = { mesh, live: 0, dead: 0, size };
    batches.set(key, batch);
  } else {
    const { mesh, size } = batch;
    const room = mesh.unusedVertexCount;
    const roomCorners = mesh.unusedIndexCount;
    if (room < vertices || roomCorners < corners) {
      // half as much again as it will hold, so a drag's few new traces
      // do not grow it every step
      size.vertices = Math.ceil(1.5 * (size.vertices - room + vertices));
      size.corners = Math.ceil(1.5 * (size.corners - roomCorners + corners));
      mesh.setGeometrySize(size.vertices, size.corners);
    }
    if (mesh.instanceCount + parts.length > mesh.maxInstanceCount) {
      mesh.setInstanceCount(
        Math.ceil(1.5 * (mesh.instanceCount + parts.length)),
      );
    }
  }
  for (const part of parts) {
    let instance;
    try {
      instance = batch.mesh.addInstance(batch.mesh.addGeometry(part.geometry));
    } catch {
      continue; // made unlike the batch's first: drawn on its own
    }
    part.updateWorldMatrix(true, false);
    const at = part.matrixWorld.clone();
    batch.mesh.setMatrixAt(instance, at);
    batch.live += part.geometry.attributes.position.count;
    inBatch.set(part, { key, instance, at });
    look(part);
    // its own copy on the GPU, if it was drawn alone: the batch has one
    part.geometry.dispose();
  }
}

/** A batch's material: its traces' own, with a colour table of its own,
 *  since each trace's goes when the trace is freed (`free`). */
function batchMaterial(sample) {
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  if (sample.userData.lut) material.map = lutTexture(sample.userData.lut);
  else material.color.copy(sample.material.color);
  return material;
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

/** One trace as the thing drawn: a mesh, a sensor's pixels, or a scatter.
 *  A pattern's copy, drawn under its source, is marked as the copy it is,
 *  for the outline to draw it fainter than the source. */
function buildItem(item) {
  const built =
    item.kind === "mesh"
      ? buildMesh(item)
      : item.kind === "pixels"
        ? buildPixels(item)
        : item.kind === "fieldlines"
          ? buildFieldLines(item)
          : buildScatter(item);
  if (item.copy) built.userData.copy = item.copy;
  built.userData.built = true; // what a node carries for its object, see `dress`
  if (built.userData.batch) batchesStale = true;
  if (item.part) built.userData.part = item.part;
  // a current's arrows, which say what its flow says: see `setFlow`
  if (item.arrows) {
    built.userData.arrows = true;
    built.visible = !flowShown;
    flowArrows.add(built);
  }
  // a field line is the field's, not a thing a drag could land on
  if (item.kind === "fieldlines") built.userData.unsnapped = true;
  // the opacity a fade is a share of -- a field line's material, kept from
  // build to build, knows its own already (`fieldLineMaterial`)
  built.traverse((part) => {
    if (part.material && part.material.userData.own === undefined) {
      part.material.userData.own = part.material.opacity;
    }
  });
  fade(built, fades.get(item.object_id) ?? 1);
  return built;
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
    for (const part of parts) part.setMatrixAt(i, matrix);
  }
  // Coloured as magpylib coloured them, or -- the colour bar's cut on them
  // (`colorRanges`) -- from the sensor's table over the cut, by each one's
  // |field|; a pixel that reads nothing keeps magpylib's grey.
  const own = (i) =>
    Array.isArray(item.colors) ? item.colors[i] : item.colors;
  group.userData.recolour = (range) => {
    for (let i = 0; i < count; i++) {
      const norm = item.norms?.[i];
      colour.set(
        range && item.scale && norm > 0
          ? tableColour(item.scale.lut, item.scale.levels, range, norm)
          : own(i),
      );
      for (const part of parts) part.setColorAt(i, colour);
    }
    for (const part of parts) part.instanceColor.needsUpdate = true;
  };
  group.userData.recolour(colorRanges.get(item.object_id));
  for (const part of parts) {
    part.instanceMatrix.needsUpdate = true;
    // so framing and picking see the instances, not the one shape at the origin
    part.computeBoundingBox();
    part.computeBoundingSphere();
    part.userData.trace = true;
    group.add(part);
  }
  return group;
}

/** `hex` (six digits, sRGB), lightened on a dark `paper` or darkened on a
 *  light one just as far as it takes to stand 3:1 against it -- the contrast
 *  a line needs to read as one. Its hue stays, and a colour that already
 *  stands out comes back as it was, so lines and arrows still agree there. */
function legible(hex, paper) {
  const rgb = (h) =>
    [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const linear = (c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const luminance = ([r, g, b]) =>
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const back = luminance(rgb(paper));
  const ink = rgb(hex);
  if (contrast(luminance(ink), back) >= 3) return `#${hex}`;
  // towards white on a page darker than the luminance where white and black
  // stand out from it equally, towards black on a lighter one
  const toward = back < 0.18 ? 1 : 0;
  const mix = (t) => ink.map((c) => c + (toward - c) * t);
  let [low, high] = [0, 1];
  for (let n = 0; n < 12; n++) {
    const t = (low + high) / 2;
    if (contrast(luminance(mix(t)), back) >= 3) high = t;
    else low = t;
  }
  const byte = (c) =>
    Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(high).map(byte).join("")}`;
}

/** One material per opacity for each sensor's lines (`owner`, their node):
 *  kept across rebuilds and never disposed, so its program is compiled once
 *  -- a material per frame would also grow `wideMaterials` without end,
 *  since a discarded node's are not taken out of it. A sensor's own, so that
 *  fading its lines fades no other's; the opacity a fade is a share of is the
 *  band's, set here once (`own`), where a rebuild would take the faded one
 *  for it and fade again. Its lines flow as a current does, the way the
 *  field points (`FIELD_PULSE`), while the host's flow is on. */
const fieldLineMaterials = new Map();
function fieldLineMaterial(opacity, owner) {
  const key = `${owner}|${opacity}`;
  let material = fieldLineMaterials.get(key);
  if (!material) {
    material = new LineMaterial({
      vertexColors: true,
      linewidth: FIELD_PULSE_WIDTH,
      dashed: true, // for the distance along the line, which a pulse runs by
      transparent: true,
      opacity,
      depthWrite: false, // lines behind lines still show through
    });
    material.uniforms.flowClock = flowClock;
    material.uniforms.flowGlow = flowGlow;
    material.uniforms.fieldFlow = fieldFlow;
    material.fragmentShader = material.fragmentShader
      .replace(
        "uniform float gapSize;",
        "uniform float gapSize;\n\t\t\tuniform float flowClock;\n\t\t\tuniform float flowGlow;\n\t\t\tuniform float fieldFlow;",
      )
      .replace(DASH_TEST, FIELD_PULSE)
      // lit after its colour, which a line's vertices carry
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n\t\t\tdiffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), flowGlow * pulse * pulse );",
      );
    material.userData.own = opacity;
    // see-through at any fade: lines behind lines still show
    material.userData.blended = true;
    if (renderer) renderer.getSize(material.resolution);
    wideMaterials.add(material);
    fieldLineMaterials.set(key, material);
  }
  return material;
}

/** How strongly a stretch of line shows, by where its |B| falls on the
 *  colour scale: the field the sensor reads in full, a fringe a tenth of it
 *  faint -- so what the eye lands on is what the sensor is about. */
/** Lines in one plane at most: past it the plane is as full as it gets. */
const FIELD_LINES_MOST = 400;

const FIELD_LINE_BANDS = [
  { below: 0.2, opacity: 0.18 },
  { below: 0.4, opacity: 0.45 },
  { below: Infinity, opacity: 0.85 },
];

/** Field lines through a sensor's pixels (#45, a prototype), integrated here
 *  from the field python sends on a grid round the sensor -- in numpy the
 *  same lines cost several times as long, and weigh more than the field they
 *  come from. Nothing to tune; python says where and how far apart:
 *
 *  - In the grid's own frame: a flat grid, the sensor's plane when its
 *    pixels lie in one, keeps the lines in it; a box lets them run in 3D.
 *  - RK4 along B/|B| (its part in the plane, for a flat grid), interpolated
 *    linearly, both ways from each pixel, nearest the middle first.
 *  - As far apart as the pixels: a pixel already on a line starts none, and
 *    a line stops within half a spacing of another (Jobard and Lefer's
 *    evenly spaced streamlines), so a uniform field draws a line per row.
 *  - A line also stops leaving the grid, closing on itself, where the
 *    field is under a twenty-fifth of the sensor's, or at a magnet.
 *  - Coloured by |field| from the table python sends, which magpylib made
 *    from the sensor's colorscaling and colormap over what its pixels read:
 *    a line and an arrow where they meet are one colour. Fainter where the
 *    field is weaker, on a log scale a decade either way of the field at the
 *    pixels (`FIELD_LINE_BANDS`) -- a fringe falls off as the cube of the
 *    distance.
 *
 *  Not a trace: nothing outlines or picks it, and it is the sensor's
 *  drawing, rebuilt with its readings. */
function buildFieldLines(item) {
  const [nx, ny, nz] = item.shape;
  const flat = nz === 1;
  const [ox, oy, oz] = item.origin;
  const axes = item.axes; // three rows: the grid's axes in the world
  const h = item.step;
  const raw = window.atob(item.values);
  const field = new Float32Array(raw.length / 2);
  for (let i = 0; i < field.length; i++) {
    const quantum = raw.charCodeAt(2 * i) | (raw.charCodeAt(2 * i + 1) << 8);
    field[i] = ((quantum << 16) >> 16) * item.scale; // little-endian int16
  }
  const bits = window.atob(item.inside);
  const within = (i, j, k) => {
    const n = (i * ny + j) * nz + k;
    return (bits.charCodeAt(n >> 3) >> (n & 7)) & 1;
  };
  // Each colour at least 3:1 against what the view is drawn on (`legible`):
  // a colormap's end -- viridis's purple on a dark page, its yellow on a
  // white one -- left its lines all but gone.
  const paper = new THREE.Color(
    cssColor("--vscode-editor-background", "#1e1e1e"),
  ).getHexString();
  const lut = item.lut.map(
    (colour) =>
      new THREE.Color(legible(new THREE.Color(colour).getHexString(), paper)),
  );

  // Everything below in grid units, along the grid's axes: a step of half a
  // cell, and positions turned back into the world only when written.
  let strength = 0; // |B| where `sample` last looked
  const b = new Float64Array(3); // B there, along the grid's axes
  /** B at a point into `b` and `strength`; the length of the part a line
   *  follows, or -1 outside the grid or inside a magnet. */
  function sample(fx, fy, fz) {
    // written so that NaN, which compares false with everything, is outside
    if (!(fx >= 0 && fy >= 0 && fx <= nx - 1 && fy <= ny - 1)) return -1;
    if (!flat && !(fz >= 0 && fz <= nz - 1)) return -1;
    const i = Math.min(Math.floor(fx), nx - 2);
    const j = Math.min(Math.floor(fy), ny - 2);
    const k = flat ? 0 : Math.min(Math.floor(fz), nz - 2);
    // A line stops at a magnet, in a plane as in 3D: the lines are of the
    // field in the air, where the sensor reads it. Let through, a 3D line
    // from the demo's bore wandered for most of a metre in and out of the
    // magnets, turning 75 degrees a cell, on a path no tracing can trust --
    // half the step moved it 17 mm. Stopped, the lines turn 8 degrees a cell
    // and keep to the exact field within 0.1 mm.
    if (within(Math.round(fx), Math.round(fy), flat ? 0 : Math.round(fz))) {
      return -1;
    }
    const tx = fx - i;
    const ty = fy - j;
    const tz = flat ? 0 : fz - k;
    b[0] = b[1] = b[2] = 0;
    for (let dx = 0; dx < 2; dx++) {
      const wx = dx ? tx : 1 - tx;
      for (let dy = 0; dy < 2; dy++) {
        const wxy = wx * (dy ? ty : 1 - ty);
        for (let dz = 0; dz < (flat ? 1 : 2); dz++) {
          const w = flat ? wxy : wxy * (dz ? tz : 1 - tz);
          const at = (((i + dx) * ny + (j + dy)) * nz + (k + dz)) * 3;
          b[0] += w * field[at];
          b[1] += w * field[at + 1];
          b[2] += w * field[at + 2];
        }
      }
    }
    strength = Math.hypot(b[0], b[1], b[2]);
    if (flat) b[2] = 0; // the part in the plane is what a line in it follows
    return flat ? Math.hypot(b[0], b[1]) : strength;
  }
  const toGrid = (x, y, z, row) =>
    ((x - ox) * axes[row] +
      (y - oy) * axes[row + 1] +
      (z - oz) * axes[row + 2]) /
    h;
  const seeds = [];
  for (let s = 0; s < item.seeds.length; s += 3) {
    const [x, y, z] = item.seeds.slice(s, s + 3);
    seeds.push([toGrid(x, y, z, 0), toGrid(x, y, z, 3), toGrid(x, y, z, 6)]);
  }
  // the middle of the colour scale, and where a line gives up on the field
  const atSeeds = seeds
    .map(([x, y, z]) => (sample(x, y, z) > 0 ? strength : 0))
    .filter((m) => m > 0)
    .sort((p, q) => p - q);
  const middle = atSeeds[Math.floor(atSeeds.length / 2)];
  if (!middle) return new THREE.Group();
  // where a line ends for want of field: a twenty-fifth of what the sensor
  // reads, past the faintest band -- a fringe drawn to the edge of the grid
  // was hair round the scene, and said nothing the faint band does not
  const fade = middle / 25;

  // What is drawn so far, for the distance test: points in cells half a
  // spacing across, each cell a linked list in flat arrays. A point carries
  // its line and how far along it it is, so a line is kept off its own older
  // stretch as off any other -- which is what ends a loop that comes round
  // near, but not onto, where it began -- and not off the stretch just drawn.
  const spacing = item.spacing / h;
  const cell = spacing / 2;
  const [cx, cy, cz] = [nx, ny, flat ? 1 : nz].map(
    (n) => Math.ceil(n / cell) + 1,
  );
  const head = new Int32Array(cx * cy * cz).fill(-1);
  let capacity = 1 << 14;
  let px = new Float32Array(capacity);
  let py = new Float32Array(capacity);
  let pz = new Float32Array(capacity);
  let owner = new Int32Array(capacity);
  let along = new Int32Array(capacity);
  let link = new Int32Array(capacity);
  let stored = 0;
  const lag = Math.ceil((2 * spacing) / 0.5); // steps of a line's own wake
  const cellIndex = (i, j, k) => (i * cy + j) * cz + k;
  function claim(x, y, z, line, step) {
    if (stored === capacity) {
      capacity *= 2;
      const grow = (old, Kind) => {
        const bigger = new Kind(capacity);
        bigger.set(old);
        return bigger;
      };
      px = grow(px, Float32Array);
      py = grow(py, Float32Array);
      pz = grow(pz, Float32Array);
      owner = grow(owner, Int32Array);
      along = grow(along, Int32Array);
      link = grow(link, Int32Array);
    }
    const c = cellIndex(
      Math.floor(x / cell),
      Math.floor(y / cell),
      flat ? 0 : Math.floor(z / cell),
    );
    px[stored] = x;
    py[stored] = y;
    pz[stored] = z;
    owner[stored] = line;
    along[stored] = step;
    link[stored] = head[c];
    head[c] = stored++;
  }
  /** Whether a point drawn is within `apart` -- one of another line, or of
   *  `line` itself more than its wake back from `step`. */
  function crowded(x, y, z, line, step, apart) {
    const reach = Math.ceil(apart / cell);
    const i0 = Math.floor(x / cell);
    const j0 = Math.floor(y / cell);
    const k0 = flat ? 0 : Math.floor(z / cell);
    for (
      let i = Math.max(i0 - reach, 0);
      i <= Math.min(i0 + reach, cx - 1);
      i++
    ) {
      for (
        let j = Math.max(j0 - reach, 0);
        j <= Math.min(j0 + reach, cy - 1);
        j++
      ) {
        const k1 = flat ? 0 : Math.min(k0 + reach, cz - 1);
        for (let k = flat ? 0 : Math.max(k0 - reach, 0); k <= k1; k++) {
          for (let p = head[cellIndex(i, j, k)]; p !== -1; p = link[p]) {
            if (owner[p] === line && Math.abs(along[p] - step) < lag) continue;
            const dx = px[p] - x;
            const dy = py[p] - y;
            const dz = pz[p] - z;
            if (dx * dx + dy * dy + dz * dz < apart * apart) return true;
          }
        }
      }
    }
    return false;
  }

  const bands = FIELD_LINE_BANDS.map(() => ({
    positions: [],
    values: [], // |field| at each end of each segment, to colour it by
    distances: [], // along the line, the way B points, in pulses
  }));
  const world = (x, y, z, out) => {
    for (let c = 0; c < 3; c++) {
      out.push(
        item.origin[c] + h * (x * axes[c] + y * axes[3 + c] + z * axes[6 + c]),
      );
    }
  };
  // how strongly it shows, by the field against the sensor's
  const tone = (magnitude) =>
    Math.min(Math.max(0.5 + 0.5 * Math.log10(magnitude / middle), 0), 1);

  const ds = 0.5;
  const longest = Math.ceil((2 * (nx + ny + nz)) / ds);
  // How near another line a line may run: half a spacing, the even look of
  // a streamplot, in a plane as in 3D. Let closer in 3D, the lines bunched
  // into the gaps between magnets and drew hair there.
  const nearest = 0.5 * spacing;
  // where a flat grid's lines may start next: beside a line, a spacing off
  const frontier = [];
  let lines = 0;
  /** A line from (sx, sy, sz) both ways, unless it would start on one. */
  function trace(sx, sy, sz, apart) {
    if (crowded(sx, sy, sz, -1, 0, apart)) return;
    if (sample(sx, sy, sz) <= fade) return;
    const line = lines++;
    claim(sx, sy, sz, line, 0);
    // a line's pulses out of step with its neighbours', not a front across
    const phase = (line * 0.618034) % 1;
    const stride = FIELD_FLOW_STRIDE * spacing;
    for (const sign of [1, -1]) {
      let x = sx;
      let y = sy;
      let z = sz;
      let d = phase;
      let m = sample(x, y, z);
      if (m <= fade) break;
      let shown = strength;
      for (let n = 0; n < longest; n++) {
        const k1x = (sign * b[0]) / m;
        const k1y = (sign * b[1]) / m;
        const k1z = (sign * b[2]) / m;
        const m2 = sample(
          x + 0.5 * ds * k1x,
          y + 0.5 * ds * k1y,
          z + 0.5 * ds * k1z,
        );
        if (m2 <= fade) break;
        const k2x = (sign * b[0]) / m2;
        const k2y = (sign * b[1]) / m2;
        const k2z = (sign * b[2]) / m2;
        const m3 = sample(
          x + 0.5 * ds * k2x,
          y + 0.5 * ds * k2y,
          z + 0.5 * ds * k2z,
        );
        if (m3 <= fade) break;
        const k3x = (sign * b[0]) / m3;
        const k3y = (sign * b[1]) / m3;
        const k3z = (sign * b[2]) / m3;
        const m4 = sample(x + ds * k3x, y + ds * k3y, z + ds * k3z);
        if (m4 <= fade) break;
        const tx =
          x + (ds / 6) * (k1x + 2 * k2x + 2 * k3x + (sign * b[0]) / m4);
        const ty =
          y + (ds / 6) * (k1y + 2 * k2y + 2 * k3y + (sign * b[1]) / m4);
        const tz = flat
          ? 0
          : z + (ds / 6) * (k1z + 2 * k2z + 2 * k3z + (sign * b[2]) / m4);
        const next = sample(tx, ty, tz); // leaves `b` at the new point
        const step = sign * (n + 1);
        if (next <= fade || crowded(tx, ty, tz, line, step, nearest)) {
          break;
        }
        const t = tone(shown);
        const band =
          bands[FIELD_LINE_BANDS.findIndex((each) => t < each.below)];
        world(x, y, z, band.positions);
        world(tx, ty, tz, band.positions);
        const d1 = d + (sign * Math.hypot(tx - x, ty - y, tz - z)) / stride;
        band.distances.push(d, d1);
        d = d1;
        band.values.push(shown, strength);
        claim(tx, ty, tz, line, step);
        // a start beside the line every spacing or so along it
        if (flat && n % Math.max(Math.round(spacing / ds), 1) === 0) {
          frontier.push(tx, ty, tx - x, ty - y);
        }
        x = tx;
        y = ty;
        z = tz;
        m = next;
        shown = strength;
      }
    }
  }
  // the pixels' own lines first, a pixel on a line already starting none
  for (const [sx, sy, sz] of seeds) trace(sx, sy, sz, 0.75 * spacing);
  // then, in a plane, the rest of it, beside the lines drawn -- Jobard and
  // Lefer's seeding, as matplotlib's streamplot fills its plane; capped by
  // count rather than by time, so a frame's lines do not depend on how fast
  // the machine was
  for (
    let p = 0;
    flat && p < frontier.length && lines < FIELD_LINES_MOST;
    p += 4
  ) {
    const x = frontier[p];
    const y = frontier[p + 1];
    const dx = frontier[p + 2];
    const dy = frontier[p + 3];
    const across = spacing / Math.hypot(dx, dy);
    if (!Number.isFinite(across)) continue;
    trace(x - dy * across, y + dx * across, 0, 0.99 * spacing);
    trace(x + dy * across, y - dx * across, 0, 0.99 * spacing);
  }
  const group = new THREE.Group();
  group.name = item.name;
  const coloured = []; // each band's part and |field| along it: `lineColouring`
  bands.forEach((band, i) => {
    if (!band.positions.length) return;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(band.positions);
    // as `computeLineDistances` lays them out, but counted the way B points
    const distances = new THREE.InstancedInterleavedBuffer(
      new Float32Array(band.distances),
      2,
      1,
    );
    geometry.setAttribute(
      "instanceDistanceStart",
      new THREE.InterleavedBufferAttribute(distances, 1, 0),
    );
    geometry.setAttribute(
      "instanceDistanceEnd",
      new THREE.InterleavedBufferAttribute(distances, 1, 1),
    );
    // Not part of what the view frames: the lines run to the edge of their
    // grid, a quarter wider than the scene, and framing them shrank it. An
    // empty box is what `expandByObject` adds nothing for; and so nothing
    // culls them by it either.
    geometry.boundingBox = new THREE.Box3();
    const part = new LineSegments2(
      geometry,
      fieldLineMaterial(FIELD_LINE_BANDS[i].opacity, item.object_id),
    );
    part.userData.band = i;
    part.frustumCulled = false;
    part.raycast = pickedAsLine;
    part.userData.field = true; // flows, but stays when the flow goes
    flowLines.add(part);
    group.add(part);
    coloured.push({ part, values: Float32Array.from(band.values) });
  });
  group.userData.recolour = lineColouring(coloured, lut, item.levels);
  group.userData.recolour(colorRanges.get(item.object_id));
  return group;
}

/** How wide a field line is to a click, in pixels: wider than it is drawn. */
const FIELD_LINE_REACH = 8;

/** A field line's raycast, which `pick` takes for its sensor where nothing
 *  else is under the pointer: with its pixels hidden, its lines are all
 *  there is of it to click. Three's would miss every line, by the empty box
 *  `buildFieldLines` leaves for framing, so the ray is given the real one.
 *  Not made in `buildFieldLines`, where it would keep the grid it traced. */
function pickedAsLine(raycaster, intersects) {
  const geometry = this.geometry;
  const framed = geometry.boundingBox;
  const params = raycaster.params.Line2;
  geometry.boundingBox = null; // computed from the lines for this ray
  raycaster.params.Line2 = {
    threshold: Math.max(0, FIELD_LINE_REACH - this.material.linewidth),
  };
  try {
    LineSegments2.prototype.raycast.call(this, raycaster, intersects);
  } finally {
    geometry.boundingBox = framed;
    raycaster.params.Line2 = params;
  }
}

/** How a sensor's field lines take their colours: each segment's ends from
 *  `lut` by their |field|, `values` of each band's `part`, past the
 *  readings the end colour -- or over the colour bar's range, as the
 *  sensor's pixels are (`colorRanges`). Made out here, so that what it keeps
 *  is these, not all the tracing worked with. */
function lineColouring(coloured, lut, levels) {
  return (range) => {
    for (const { part, values } of coloured) {
      // in place after the first time: a handle's drag colours them again
      // at every step, and a new buffer each time is one the GPU keeps
      const kept = part.geometry.attributes.instanceColorStart?.data;
      const colours =
        kept?.array.length === values.length * 3
          ? kept.array
          : new Float32Array(values.length * 3);
      for (let j = 0; j < values.length; j++) {
        const colour = tableColour(lut, levels, range, values[j]);
        colours[j * 3] = colour.r;
        colours[j * 3 + 1] = colour.g;
        colours[j * 3 + 2] = colour.b;
      }
      if (colours === kept?.array) kept.needsUpdate = true;
      else part.geometry.setColors(colours);
    }
  };
}

/** The colour `value` takes from a table spread evenly over `levels` -- or,
 *  where the colour bar cut a `range` from them, over that range, stretched
 *  to it, the value past either end taking that end's colour. The table's
 *  colormap and scaling are magpylib's over the readings, so a cut is the
 *  colours the sensor would take had it read only that range. */
function tableColour(lut, [low, high], range, value) {
  const [from, to] = range ?? [low, high];
  const t = to > from ? (value - from) / (to - from) : 0.5;
  return lut[Math.round(Math.min(Math.max(t, 0), 1) * (lut.length - 1))];
}

/** Colour each sensor's pixels and field lines over the range `ranges`
 *  names for it, by id -- a cut, or a scale it shares, as the view's colour
 *  bar says (`colouring` in colorbar.mjs) -- and one not named over all it
 *  reads, as magpylib coloured it. Only those whose range changed: a
 *  handle's drag sets them at every step. */
function setColorRanges(ranges) {
  const was = colorRanges;
  colorRanges = new Map(Object.entries(ranges ?? {}));
  const same = (a, b) => a === b || (a && b && a[0] === b[0] && a[1] === b[1]);
  for (const id of new Set([...was.keys(), ...colorRanges.keys()])) {
    if (same(was.get(id), colorRanges.get(id))) continue;
    byObjectId
      .get(id)
      ?.traverse((part) => part.userData.recolour?.(colorRanges.get(id)));
  }
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

/** How a current's wire flows: pulses run along it the way the current
 *  runs, which the payload says (`threejs._mark_flows`), whatever else the
 *  view is doing -- a run playing or not. Each pulse is a bright head, its
 *  tail narrowing and fading behind it: it says the way even standing. */
const FLOW_RATE = 0.8; // pulses passing a point of the wire each second
const FLOW_FRAME_MS = 15; // sixty frames a second: a faster display draws every other
// Without a GPU every frame is the CPU's: sixty a second of a software
// renderer kept a slow machine's page 97% busy with the view at rest.
const SOFTWARE_FLOW_FRAME_MS = 45; // some twenty frames a second
let flowFrameMs = FLOW_FRAME_MS; // see `drawnBySoftware`
const FLOW_SPACING = 0.75; // of the wire's own radius from a pulse to the next
const FLOW_TAIL = 0.6; // of that spacing, a pulse's tail
const flowGlow = { value: 0 }; // how far a head is lit toward white: on a dark scene
const UNLIT = { value: 0 };
const flowClock = { value: 0 }; // where every pulse is in its stride, 0 to 1
const flowResolution = new THREE.Vector2(1, 1); // one for all, see `resize`
const flowLines = new Set(); // wires and field lines drawn flowing, to know if any is
const flowArrows = new Set(); // a flowing current's arrows, away while it flows
let flowShown = true; // the host's: see `setFlow`
let colorRanges = new Map(); // the colour bar's ranges, by sensor: see `setColorRanges`
// still for whoever asks the system for less motion: the pulses show the
// way, standing, and the view turns and the corner grows at once
const lessMotion = Boolean(
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
);

/** Where three's dashed wide line drops a gap. A pulse is drawn there
 *  instead, at the line's distance counted in strides -- the dash scale is
 *  the wire's direction over its spacing -- so a stride is one pulse. */
const DASH_TEST =
  "if ( mod( vLineDistance + dashOffset, dashSize + gapSize ) > dashSize ) discard; // todo - FIX";
const PULSE = `
  float stride = fract( vLineDistance - flowClock );
  float body = smoothstep( ${(1 - FLOW_TAIL).toFixed(3)}, 1.0, stride ) * ( 1.0 - smoothstep( 0.97, 1.0, stride ) );
  float girth = mix( 0.15, 1.0, body );
  float edge = fwidth( vUv.x );
  alpha *= sqrt( body ) * ( 1.0 - smoothstep( girth - edge, girth + edge, abs( vUv.x ) ) );
  if ( alpha < 0.01 ) discard;
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), flowGlow * body * body );`;

/** How a field line flows: pulses run along it the way B points, at the
 *  currents' pace, each a head wider and brighter than the line, its tail
 *  narrowing behind it -- the line itself stays, a little dimmer, so the
 *  picture is still the field's. Standing, it is the line as it was. */
const FIELD_LINE_WIDTH = 1.75; // pixels, the line between pulses
const FIELD_PULSE_WIDTH = 3.5; // pixels, a pulse's head
const FIELD_FLOW_STRIDE = 3; // of the lines' spacing, from a pulse to the next
const fieldFlow = { value: 1 }; // 1 while the field's lines flow: see `setFlow`
const FIELD_PULSE = `
  float stride = fract( vLineDistance - flowClock );
  float pulse = fieldFlow * smoothstep( ${(1 - FLOW_TAIL).toFixed(3)}, 1.0, stride ) * ( 1.0 - smoothstep( 0.97, 1.0, stride ) );
  float girth = mix( ${(FIELD_LINE_WIDTH / FIELD_PULSE_WIDTH).toFixed(3)}, 1.0, pulse );
  float edge = fwidth( vUv.x );
  alpha *= mix( 1.0, 0.6 + 0.9 * pulse, fieldFlow ) * ( 1.0 - smoothstep( girth - edge, girth + edge, abs( vUv.x ) ) );
  alpha = min( alpha, 1.0 );
  if ( alpha < 0.01 ) discard;`;

/** A pulse's material, one per wire: its colour, its width, its fade. */
function flowMaterial(colour, width, opacity, glow = flowGlow) {
  const material = new LineMaterial({
    linewidth: width,
    opacity,
    dashed: true,
    transparent: true,
    depthWrite: false,
  });
  material.color = new THREE.Color(colour);
  material.uniforms.flowClock = flowClock;
  material.uniforms.flowGlow = glow;
  material.uniforms.resolution.value = flowResolution;
  material.fragmentShader = material.fragmentShader
    .replace(
      "uniform float gapSize;",
      "uniform float gapSize;\n\t\t\tuniform float flowClock;\n\t\t\tuniform float flowGlow;",
    )
    .replace(DASH_TEST, PULSE);
  material.userData.blended = true; // see `fade`
  return material;
}

/** The pulses along a wire -- or a sheet's or a strip's streams --
 *  `position` its points: as many as fit its length at `FLOW_SPACING` of
 *  its radius, or at `spacing` where it says, to a whole number, so that a
 *  loop's join is never seen. Six round a ring, three along a straight
 *  wire. On a surface, drawn a little toward the eye, as an outline is. */
function flowLine(
  position,
  { colour, width, opacity, flow, spacing, onSurface },
) {
  const pairs = segmentsOf(position);
  if (!pairs.length) return null;
  const line = new LineSegments2(
    new LineSegmentsGeometry().setPositions(pairs),
    // on a surface the head stands out against the surface, lit or not
    flowMaterial(colour, width, opacity, onSurface ? UNLIT : flowGlow),
  );
  line.computeLineDistances();
  line.geometry.computeBoundingSphere();
  const radius = line.geometry.boundingSphere.radius;
  const distances = line.geometry.attributes.instanceDistanceEnd.data.array;
  const length = distances[distances.length - 1];
  if (!(length > 0) || !(radius > 0)) return null;
  const count = Math.max(
    1,
    Math.round(length / (spacing || FLOW_SPACING * radius)),
  );
  line.material.dashScale = (Math.sign(flow) * count) / length;
  if (onSurface) {
    line.material.polygonOffset = true;
    line.material.polygonOffsetFactor = -2;
    line.material.polygonOffsetUnits = -4;
  }
  line.raycast = () => {}; // the wire is what is picked
  line.userData.flow = true;
  line.userData.unsnapped = true; // a snap lands on the wire's own points
  line.visible = flowShown;
  flowLines.add(line);
  return line;
}

/** What a sheet's or a strip's flow is drawn in: its own colour, lighter on
 *  a dark one and darker on a light one, to stand out on it. */
function streamColour(colour) {
  const own = new THREE.Color(colour || "#2e91e5");
  return own.getHSL({}).l < 0.75
    ? own.lerp(new THREE.Color("#ffffff"), 0.75)
    : own.lerp(new THREE.Color("#000000"), 0.6);
}

/** Whether a current or a field line flows where it can be seen: so
 *  whether the view asks for its next frame. Not with the view off screen,
 *  or its page hidden, or every line that flows hidden, nor for whoever
 *  asked for less motion -- nor while a handle is held, when each frame
 *  the flow draws is one the drag's own redraws wait behind. A line taken
 *  off the scene is forgotten. */
function flowing() {
  if (!flowShown || lessMotion || !inSight || document.hidden) return false;
  if (gizmo?.dragging || gripping) return false;
  for (const line of flowLines) {
    let node = line;
    let shown = true;
    for (; node && node !== scene; node = node.parent) shown &&= node.visible;
    if (!node) flowLines.delete(line);
    else if (shown) return true;
  }
  return false;
}

/** Show a current's flow along its wire, and the field's along its lines,
 *  or not: the host's choice, for a picture without it. A current's arrows,
 *  which magpylib draws to say the same, come back when it goes; a field
 *  line stays, standing. */
function setFlow(on) {
  flowShown = on !== false;
  fieldFlow.value = flowShown ? 1 : 0;
  for (const line of flowLines) {
    if (!line.userData.field) line.visible = flowShown;
  }
  for (const arrows of flowArrows) arrows.visible = !flowShown;
}

function buildScatter(item) {
  const geometry = new THREE.BufferGeometry();
  geometry.userData.exact = item.position; // see `buildMesh`
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
    if (item.flow) {
      const flow = flowLine(position, {
        colour: item.line_color,
        width: Math.min(Math.max(item.line_width, 3), 7),
        opacity: item.opacity,
        flow: item.flow,
      });
      if (flow) group.add(flow);
    }
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
  // The corners of each drawn part's own box, turned as the part is: what
  // `fitView` frames. A box along the world's axes round a card leaning in
  // a ring reaches corners the card has none in, and framed by them the
  // ring sat in the middle of the view with a margin all round.
  const parts = [];
  const take = (node) => {
    box.expandByObject(node);
    node.updateWorldMatrix(true, true);
    node.traverse((part) => {
      let own = null;
      if (part.isInstancedMesh) {
        if (!part.boundingBox) part.computeBoundingBox();
        own = part.boundingBox;
      } else if (part.geometry) {
        if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
        own = part.geometry.boundingBox;
      }
      if (!own || own.isEmpty()) return;
      for (const x of [own.min.x, own.max.x]) {
        for (const y of [own.min.y, own.max.y]) {
          for (const z of [own.min.z, own.max.z]) {
            parts.push(
              new THREE.Vector3(x, y, z).applyMatrix4(part.matrixWorld),
            );
          }
        }
      }
    });
  };
  const chosen = drawnFor([].concat(objectIds ?? []))
    .map((objectId) => byObjectId.get(objectId))
    .filter(Boolean);
  if (chosen.length) {
    for (const node of chosen) take(node);
  } else {
    // A hidden object is not part of what is being looked at.
    for (const node of byObjectId.values()) {
      if (node.visible) take(node);
    }
    // the graduated box sits a little outside the objects, and framing the
    // scene without its scale showing would cut the numbers off
    if (axes?.visible) take(axes);
  }
  if (box.isEmpty()) return null;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  sphere.parts = parts;
  // A box with a NaN bound is not empty, and every number taken from it is
  // NaN: better no answer than one that silently blanks the view.
  return Number.isFinite(sphere.radius) ? sphere : null;
}

/** Select `objectIds`: mark them, and put the handles on them. A line round
 *  each, never a colour on it: see `drawMarks`. */
function highlight(objectIds) {
  selectedIds = (Array.isArray(objectIds) ? objectIds : [objectIds]).filter(
    Boolean,
  );
  setGizmoMode(gizmoMode); // the handles belong to whatever is selected now
  drawOutlines();
  if (hoveredId) drawHints(); // selected now, it is marked in full instead
  moversStale = true; // its batches follow what is selected, to be dragged
}

/** Mark the selection and the overlaps afresh, round whatever is drawn for
 *  them now. */
function drawOutlines() {
  takeOff(outlines);
  outlines = [
    ...outline(selectedIds, 1, COPY_OUTLINE),
    // the selection's green wins where an overlapping object is selected
    ...outlineOverlaps(
      idsOf(overlaps).filter((id) => !selectedIds.includes(id)),
    ),
    ...shadeOverlaps(overlaps),
    ...patternTraces(selectedIds),
  ];
  countMarks();
}

/** The path a pattern laid its copies on, through their centres, while the
 *  source is selected: a dashed line in the selection's colour, closed when
 *  the ring comes back round to the source. It says how the copies follow,
 *  where the faint outlines say that they do. Drawn through what hides it,
 *  since it is a guide and not a thing. */
function patternTraces(objectIds) {
  const added = [];
  for (const objectId of objectIds) {
    const made = copies[objectId];
    if (!patterned.has(objectId) || !made?.length) continue;
    const points = [objectId, ...made]
      .map((id) => centroids[id])
      .filter(Boolean);
    if (points.length < 2) continue;
    const at = (point) => new THREE.Vector3().fromArray(point);
    const step = at(points[0]).distanceTo(at(points[1]));
    const back = at(points[points.length - 1]).distanceTo(at(points[0]));
    // a ring closes when the last copy sits one step short of the source
    const closed = points.length > 2 && Math.abs(back - step) < 0.15 * step;
    const run = closed ? [...points, points[0]] : points;
    let length = 0;
    for (let i = 1; i < run.length; i++) {
      length += at(run[i - 1]).distanceTo(at(run[i]));
    }
    if (!length) continue;
    const material = new LineMaterial({
      linewidth: 1,
      dashed: true,
      dashSize: length / 90,
      gapSize: length / 90,
      transparent: true,
      opacity: TRACE_OPACITY,
      depthTest: false,
    });
    material.color = new THREE.Color(SELECTION_COLOUR);
    if (renderer) renderer.getSize(material.resolution);
    wideMaterials.add(material);
    const line = new Line2(
      new LineGeometry().setPositions(run.flat()),
      material,
    );
    line.computeLineDistances();
    line.raycast = () => {}; // a guide, not a target
    line.renderOrder = 1;
    scene.add(line);
    added.push({ on: scene, part: line });
  }
  return added;
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

// Where a view first looks from, as matplotlib's does: 30 degrees above the
// xy plane, -60 round from x. +x runs down to the right, +y up to the right.
const FIRST_LOOK = new THREE.Vector3(
  Math.cos(Math.PI / 6) * Math.cos(-Math.PI / 3),
  Math.cos(Math.PI / 6) * Math.sin(-Math.PI / 3),
  Math.sin(Math.PI / 6),
);

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
  stopTurning();

  // Framing should not also spin the view: keep the angle the camera is
  // already at. On the very first fit there is none, and an off-axis start
  // shows three faces of a box, which reads as depth where face-on does not.
  const looking = camera.position.clone().sub(controls.target);
  const direction =
    looking.lengthSq() > 0 ? looking.normalize() : FIRST_LOOK.clone();

  // The corners of each part's box as the camera will see them, about the
  // scene's centre: how far each reaches across the view and up it, and how
  // far toward the eye. Framed by them rather than by the sphere round the
  // whole, a ring of magnets fills the view, where the sphere -- as tall as
  // the ring is wide, and reaching corners the ring has none in -- left
  // half of it empty.
  let up = camera.up.clone().projectOnPlane(direction);
  if (up.lengthSq() < 1e-9) up = new THREE.Vector3(0, 1, 0); // looking down it
  up.normalize();
  const across = new THREE.Vector3().crossVectors(up, direction).normalize();
  const corners = sphere.parts.map((corner) => {
    const at = corner.clone().sub(sphere.center);
    return [at.dot(across), at.dot(up), at.dot(direction)];
  });
  const margin = 1.08;
  let distance;
  if (camera.isOrthographicCamera) {
    // No perspective, so distance decides nothing but clipping: the frustum
    // is what frames the scene.
    const aspect =
      camera.right > camera.left
        ? (camera.right - camera.left) / (camera.top - camera.bottom)
        : 1;
    // a loop, not a spread: a scene of thousands of parts has more corners
    // than a call takes arguments
    let tall = 0;
    for (const [x, y] of corners) {
      tall = Math.max(tall, Math.abs(y), Math.abs(x) / aspect);
    }
    frustumHeight = Math.max(tall, sphere.radius * 0.05) * 2 * margin;
    distance = sphere.radius * 4;
  } else {
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
    let reach = 0;
    for (const [x, y, z] of corners) {
      reach = Math.max(
        reach,
        z + Math.abs(x) / Math.tan(horizontal / 2),
        z + Math.abs(y) / Math.tan(vertical / 2),
      );
    }
    distance = Math.max(reach, sphere.radius * 0.5) * margin;
  }
  camera.near = camera.isOrthographicCamera
    ? -sphere.radius * 8 // ortho may see behind itself; a box, not a cone
    : Math.max(distance / 5000, 1e-6);
  camera.far = distance * 20;
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  applyProjection();
  controls.target.copy(sphere.center);
  controls.update();
  fitClipping();
  if (snapping) setSnapping(true); // the step follows the scene's size
}

/** Scale where the camera is by `factor`, about the origin, as a scene's
 *  coordinates are when it comes in another unit: it looks at what it
 *  looked at, from where it looked. */
function rescaleCamera(factor) {
  camera.position.multiplyScalar(factor);
  controls.target.multiplyScalar(factor);
  frustumHeight *= factor;
  camera.near *= factor;
  camera.far *= factor;
  applyProjection();
  controls.update();
  if (snapping) setSnapping(true); // the step follows the scene's size
}

/** Where the scene is, as last drawn: what the clipping planes must take in. */
let drawnSphere = null;

/** The clipping planes, from where the camera is now: the near one a
 *  hundredth of the way to what it looks at, the far one past the far side
 *  of the scene. Depth is told apart in steps of about distance² / (near ·
 *  2²⁴), so the near plane a five-thousandth of the way in, set once at the
 *  fit, made them tens of microns at a hand's length, and faces a hair
 *  apart -- a sheet's streams on it, an outline on a face -- fought. Kept
 *  with the camera as the orbit moves it, so zooming in clips nothing. A
 *  parallel projection keeps the box `fitView` gave it. */
function fitClipping() {
  if (!camera || !controls || camera.isOrthographicCamera) return;
  const reach = camera.position.distanceTo(controls.target);
  if (!(reach > 0)) return;
  camera.near = Math.max(reach / 100, 1e-6);
  const beyond = drawnSphere
    ? camera.position.distanceTo(drawnSphere.center) + drawnSphere.radius
    : reach * 20;
  camera.far = Math.max(beyond * 1.5, camera.near * 100);
  camera.updateProjectionMatrix();
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
  stopTurning();
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
  made.addEventListener("start", stopTurning); // a drag or a wheel takes over
  made.addEventListener("change", () => {
    fitClipping();
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
  turning = null; // everything a turn would leave is set here
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
  fitClipping(); // a camera saved before the planes followed it
  framed = true; // a view that was looked at, not one to frame
  return state.projection;
}

/** The view as a PNG data URL, as it is on screen. Drawn again for it rather
 *  than read off the canvas: WebGL lets go of what it drew once that is
 *  shown, so what is on screen is no longer there to read. The view alone --
 *  nothing a host floats over it, legend or controls, is in the picture. */
function snapshot() {
  if (!renderer) return null;
  drawPicture();
  drawCorner(false); // the scale bar is part of the picture; the cube, a control
  return renderer.domElement.toDataURL("image/png");
}

/** The view copied onto a canvas of its own, drawn again for it as the
 *  snapshot is: for a host to show in its place while this renderer draws
 *  something else. A copy rather than a PNG, which would be encoded on the
 *  spot, only to be decoded again to be shown. */
function still() {
  if (!renderer) return null;
  drawPicture();
  drawCorner(true);
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

// Metres per unit an axis label may name a length in, and the units a length
// is said in. The box and the scale bar say a length in the one that reads
// best, whatever the scene is drawn in: "1 mm", not "0.001 m".
const METRES = {
  km: 1e3,
  m: 1,
  dm: 0.1,
  cm: 0.01,
  mm: 1e-3,
  µm: 1e-6, // the micro sign, and the Greek letter it is confused with
  μm: 1e-6,
  um: 1e-6,
  nm: 1e-9,
};
const SAID_IN = [
  ["km", 1e3],
  ["m", 1],
  ["mm", 1e-3],
  ["µm", 1e-6],
  ["nm", 1e-9],
];

/** The unit `metres` reads best in -- the largest it is at least one of --
 *  as `[name, metres per one]`. */
function readsBest(metres) {
  return (
    SAID_IN.find(([, per]) => metres >= per * (1 - 1e-9)) ?? SAID_IN.at(-1)
  );
}

/** The box, ticks and names that say how big any of this is.
 *
 * Magpylib scenes are measurements, and a view of one that does not say what
 * scale it is at leaves you judging a magnet by eye. Plotly draws a graduated
 * cube; this is the same idea with the axis names magpylib itself supplies,
 * numbered in the unit that reads best for the box's size -- one for all
 * three axes, so their numbers compare.
 */
function drawAxes(ranges, labels) {
  if (axes) {
    scene.remove(axes);
    axes.traverse(free);
    axes = null;
  }
  // The unit the coordinates are in, for the box's numbers and the scale
  // bar: magpylib names it in each axis's label, "x (mm)".
  unit = /\(([^)]+)\)\s*$/.exec(labels?.x ?? "")?.[1] ?? "";
  axesFor = ranges ? { ranges, labels } : null;
  // Built only while it is shown: its numbers are a canvas each, and a
  // scene drawn again at every step of a drag built them all again for a
  // box nobody saw -- a third of a redraw. `setAxes` builds it when asked.
  if (axesMode === "box") buildAxes();
}

/** The box for the scene `drawAxes` was last given. */
function buildAxes() {
  if (!axesFor) return;
  const { ranges, labels } = axesFor;
  // The box's numbers in the unit that reads best for its largest; a unit
  // this does not know is kept, numbers and names as they came.
  const factor = METRES[unit];
  const [shown, per] = factor
    ? readsBest(Math.max(...ranges.flat().map(Math.abs)) * factor)
    : [unit, 1];
  const toShown = (value) => (value * (factor ?? 1)) / per;

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
  const names = ["x", "y", "z"].map((name) => {
    const label = labels?.[name] ?? name;
    return factor ? label.replace(/\(([^)]+)\)\s*$/, `(${shown})`) : label;
  });
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
        Number(toShown(value).toPrecision(4)).toString(),
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
  axes.visible = axesMode === "box";
  scene.add(axes);
  // Placed now, not at the first frame. A Box3Helper is the unit cube it is
  // built as until `updateMatrixWorld` fits it to its box, which a render
  // calls and a measurement does not -- and the first fit, which frames the
  // axes with the objects, comes before any render. Measured unplaced, a
  // scene in centimetres was framed as two metres of nothing round a speck.
  axes.updateMatrixWorld(true);
}

// --- the view cube and the scale bar -----------------------------------------
// The other way to say which way the scene faces and how big it is: in a
// corner, rather than round the scene
// (docs/decisions.md#0027-the-scale-is-said-round-the-scene-or-in-its-corner).
// Both are drawn into the canvas after the scene, in the same frame -- not
// laid over it as HTML: a pooled renderer moves between views, and the canvas
// is what moves with it, and what a resting view's picture is taken from.
//
// At rest the corner shows the axes alone, small. With the pointer on its
// square it grows, up and left out of the view's corner, and the cube comes
// up round them to be clicked. The bar stands low in the middle of the
// view's foot, beside the axes at rest
// (docs/decisions.md#0035-the-corner-shows-the-axes-and-grows-the-cube-on-hover).

// The corner's square, in CSS pixels: at rest the size the cube's was before
// it grew, which is what stands clear of what a host floats over the view;
// grown, room for the cube and the arrows past it.
const CORNER_SIDE = { rest: 84, grown: 112 };
const CORNER_MARGIN = 8; // from the view's edges, as the widget's tools sit
// How far in from an edge a press means the edge rather than the face, as a
// share of a side: the faces keep most of the cube, the edges stay easy to hit.
const CUBE_EDGE = 0.2;
// How far the square sees from the cube's middle, in cube sides, at the
// middle's depth: at rest, as far as the axes and their names reach turned
// any way; grown, the arrows past the cube and their names past them.
const CORNER_REACH = { rest: 1.4, grown: 1.3 };
// The corner is seen in perspective, whatever the view is seen in: an arrow
// coming toward the eye ends in a larger head than one going away, which is
// what says which is which when the arrows alone are up. Narrow enough that
// what comes nearest still stands inside the square.
const CORNER_FOV = 30;
const CORNER_GROWTH_MS = 50; // the time constant it grows and shrinks by
// The axes start just outside the cube's -x, -y, -z corner and run along its
// edges and past them. At rest, with no cube, they stand about the middle.
const AXES_FROM = { rest: -0.34, grown: -0.56 };
const AXIS_LENGTH = 1.36;
// How much of an axis is left where it runs straight away from the eye: an
// arrow fades along its length as it goes behind, its name with its tip, and
// one in the screen's plane or coming nearer is drawn whole. Its name has to
// stay readable as it fades, on a dark page too.
const AXIS_FAR = 0.4;
// The handles' red, green and blue, dark enough to read on a light face and
// light enough on a dark one.
const AXIS_INKS = { x: "#e5484d", y: "#2f9e44", z: "#3b82f6" };
const BAR_LONGEST = 120; // CSS pixels; a round length is never under 2/5 of it
const BAR_ROOM = { width: BAR_LONGEST + 16, height: 30 };
const BAR_UP = 26; // the bar's middle, up from the margin at the view's foot
const CORNER_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

let unit = ""; // the scene's length unit, for the scale bar
let corner = null; // the corner's scene and camera, in the colours it was made in
let marked = null; // the part of the cube under the pointer, as "x,y,z"
let cornerHot = false; // whether the pointer is on the corner's square
let cornerPointer = null; // and where it is on the canvas, while it is
let grown = 0; // how far the corner has grown, from 0 at rest to 1
let bar = null; // the scale bar's canvas, and what was last painted on it
let insets = { right: 0, bottom: 0 }; // how far in the host pushes the square
const cubeRay = new THREE.Raycaster();
const cornerEye = new THREE.Vector3(); // toward the eye, for `aimCorner`

// The cube is drawn from where a point is on it, so that a face's name is
// looked up along the face's own two axes and the part a click would look
// from is lit by the same rule `cubeTarget` decides the click by.
const CUBE_VERTEX = `
varying vec3 vAt;
varying vec3 vNormal;
varying vec3 vFacing;
void main() {
  vAt = position;
  vNormal = normal;
  vFacing = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const CUBE_FRAGMENT = `
uniform sampler2D names; // the six faces' names, side by side
uniform vec3 body;
uniform vec3 rimInk;
uniform float rim;
uniform float dim; // the light, on a face turned from it and toward it
uniform float bright;
uniform vec3 accent;
uniform vec3 marked;
uniform float marking;
uniform float edge;
varying vec3 vAt;
varying vec3 vNormal;
varying vec3 vFacing;
void main() {
  vec3 n = normalize(vNormal);
  vec3 a = abs(n);
  int axis = a.x >= a.y && a.x >= a.z ? 0 : (a.y >= a.z ? 1 : 2);
  float side = n[axis] >= 0.0 ? 1.0 : -1.0;
  // across and up the face, as a camera looking from it has them
  vec2 uv;
  if (axis == 0) uv = vec2(side * vAt.y, vAt.z);
  else if (axis == 1) uv = vec2(-side * vAt.x, vAt.z);
  else uv = vec2(side * vAt.x, vAt.y);
  float cell = float(2 * axis) + (side > 0.0 ? 0.0 : 1.0);

  vec3 facing = normalize(vFacing);
  float light = dot(facing, normalize(vec3(-0.45, 0.65, 0.62))) * 0.5 + 0.5;
  vec3 colour = body * mix(dim, bright, light);
  colour = mix(colour, rimInk, pow(1.0 - clamp(abs(facing.z), 0.0, 1.0), 3.0) * rim);

  float inner = 0.5 - edge;
  vec3 along = abs(vAt);
  vec3 soft = fwidth(along) * 0.6 + 1e-5;
  vec3 band = smoothstep(vec3(inner) - soft, vec3(inner) + soft, along);
  float match = marking;
  for (int i = 0; i < 3; i++) {
    match *= marked[i] == 0.0 ? 1.0 - band[i] : band[i] * step(0.0, marked[i] * vAt[i]);
  }
  colour = mix(colour, accent, match * 0.6);

  // Sampled at the surface's own rate of change: where one face turns into
  // the next the name's coordinates jump, and their derivatives would pick
  // the smallest mipmap -- a dotted seam along every edge.
  vec2 inCell = uv + 0.5;
  float inside = step(0.0, inCell.x) * step(inCell.x, 1.0) * step(0.0, inCell.y) * step(inCell.y, 1.0);
  float rate = max(length(dFdx(vAt)), length(dFdy(vAt)));
  vec4 name = textureGrad(
    names,
    vec2((cell + clamp(inCell.x, 0.0, 1.0)) / 6.0, clamp(inCell.y, 0.0, 1.0)),
    vec2(rate / 6.0, 0.0),
    vec2(0.0, rate)
  ) * inside;
  colour = colour * (1.0 - name.a) + name.rgb; // premultiplied

  gl_FragColor = vec4(colour, 1.0);
  #include <colorspace_fragment>
}`;

// An axis's arrow, each point of it as faint as it is far behind where the
// three start: whole level with that and in front of it, AXIS_FAR an arrow's
// length behind.
const AXIS_VERTEX = `
uniform float span;
varying float vToward;
void main() {
  vec4 at = modelViewMatrix * vec4(position, 1.0);
  vec4 from = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vToward = (at.z - from.z) / span; // -1 an arrow's length behind, 1 in front
  gl_Position = projectionMatrix * at;
}`;
const AXIS_FRAGMENT = `
uniform vec3 ink;
uniform float far;
uniform float opacity;
varying float vToward;
void main() {
  gl_FragColor = vec4(ink, opacity * mix(far, 1.0, clamp(1.0 + vToward, 0.0, 1.0)));
  #include <colorspace_fragment>
}`;

/** How much of an axis is drawn where it is `toward` the eye, from -1 an
 *  arrow's length behind where the axes start to 0 level with it: what the
 *  arrows' shader says, for their names. */
function axisFade(toward) {
  return AXIS_FAR + (1 - AXIS_FAR) * THREE.MathUtils.clamp(1 + toward, 0, 1);
}

/** The axes and the cube, in the colours the view wears now: made when
 *  first wanted, and again when the theme changes under it. */
function dressCorner() {
  const ink = cssColor("--vscode-editorLineNumber-foreground", "#888");
  const paper = cssColor("--vscode-editor-background", "#1e1e1e");
  const accent = cssColor("--vscode-focusBorder", "#4b8fe2");
  if (
    corner?.ink === ink &&
    corner?.paper === paper &&
    corner?.accent === accent
  ) {
    return;
  }
  dropCorner();
  const dark = new THREE.Color(paper).getHSL({}).l < 0.25;
  const names = cubeNames(dark ? "#e3e7ec" : "#2b3138");
  const uniforms = {
    names: { value: names },
    body: {
      value: new THREE.Color(paper).lerp(
        new THREE.Color(ink),
        dark ? 0.3 : 0.1,
      ),
    },
    rimInk: { value: new THREE.Color(dark ? "#e3e7ec" : "#2b3138") },
    rim: { value: dark ? 0.22 : 0.14 },
    // on a light page a face lit brighter than the paper would vanish into it
    dim: { value: dark ? 0.5 : 0.6 },
    bright: { value: dark ? 1.22 : 1 },
    accent: { value: new THREE.Color(accent) },
    marked: { value: new THREE.Vector3() },
    marking: { value: 0 },
    edge: { value: CUBE_EDGE },
  };
  const body = new THREE.Mesh(
    new RoundedBoxGeometry(1, 1, 1, 6, 0.13),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: CUBE_VERTEX,
      fragmentShader: CUBE_FRAGMENT,
    }),
  );
  const axes = cornerAxes(dark);
  const cornerScene = new THREE.Scene();
  cornerScene.add(body, axes);
  corner = {
    ink,
    paper,
    accent,
    body,
    axes,
    uniforms,
    scene: cornerScene,
    camera: new THREE.PerspectiveCamera(CORNER_FOV, 1, 0.1, 10),
    distance: 0, // the camera's from the middle: `poseCorner` sets it as it grows
  };
  placeMark();
  poseCorner();
}

function dropCorner() {
  if (!corner) return;
  corner.scene.traverse((part) => {
    part.geometry?.dispose();
    part.material?.map?.dispose();
    part.material?.dispose();
  });
  corner.uniforms.names.value.dispose();
  corner = null;
}

/** The faces' names in `ink`, side by side in the order the cube's shader
 *  looks them up: +x, -x, +y, -y, +z, -z, each in a square a face across. */
function cubeNames(ink) {
  const cell = 256;
  const canvas = document.createElement("canvas");
  canvas.width = cell * 6;
  canvas.height = cell;
  const context = canvas.getContext("2d");
  context.fillStyle = ink;
  context.font = `600 ${Math.round(cell * 0.34)}px ${CORNER_FONT}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  ["+x", "−x", "+y", "−y", "+z", "−z"].forEach((name, i) => {
    context.fillText(name, cell * (i + 0.5), cell * 0.53);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.premultiplyAlpha = true;
  texture.anisotropy = 4;
  return texture;
}

/** The x, y and z arrows, each named at its tip, fading as they go behind.
 *  What the cube hides of them is drawn again, faintly, where it hides it. */
function cornerAxes(dark) {
  const axes = new THREE.Group();
  const head = { radius: 0.072, length: 0.2 };
  const shaft = new THREE.CylinderGeometry(
    0.026,
    0.026,
    AXIS_LENGTH - head.length,
    12,
  ).translate(0, (AXIS_LENGTH - head.length) / 2, 0);
  const tip = new THREE.ConeGeometry(head.radius, head.length, 24).translate(
    0,
    AXIS_LENGTH - head.length / 2,
    0,
  );
  ["x", "y", "z"].forEach((name, i) => {
    const along = new THREE.Vector3().setComponent(i, 1);
    const ink = new THREE.Color(AXIS_INKS[name]);
    if (dark) ink.lerp(new THREE.Color("#ffffff"), 0.08);
    const arrow = new THREE.Group();
    const shaded = (opacity) =>
      new THREE.ShaderMaterial({
        uniforms: {
          ink: { value: ink },
          far: { value: AXIS_FAR },
          opacity: { value: opacity },
          span: { value: AXIS_LENGTH },
        },
        vertexShader: AXIS_VERTEX,
        fragmentShader: AXIS_FRAGMENT,
        transparent: true,
      });
    const solid = shaded(1);
    const faint = Object.assign(shaded(0.3), {
      depthFunc: THREE.GreaterDepth, // only behind what is drawn already
      depthWrite: false,
    });
    for (const geometry of [shaft, tip]) {
      const hidden = new THREE.Mesh(geometry, faint);
      hidden.renderOrder = 1;
      arrow.add(new THREE.Mesh(geometry, solid), hidden);
    }
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), along);
    const label = axisName(name, `#${ink.getHexString()}`);
    label.position.copy(along).multiplyScalar(AXIS_LENGTH + 0.13);
    label.userData.along = along; // for `aimCorner` to fade it by
    axes.add(arrow, label);
  });
  return axes;
}

/** An axis's name, to stand at its arrow's tip: hidden by the cube as the
 *  arrow is, and like it drawn faintly there. */
function axisName(name, ink) {
  const side = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side;
  const context = canvas.getContext("2d");
  context.fillStyle = ink;
  context.font = `600 ${side * 0.8}px ${CORNER_FONT}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(name, side / 2, side * 0.47);
  // Straight alpha, not premultiplied: a sprite does not scale a
  // premultiplied texture's colour by its opacity, and the faint copy came
  // out as bright as the other.
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Group();
  for (const faint of [false, true]) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map,
        depthWrite: false,
        ...(faint && { opacity: 0.3, depthFunc: THREE.GreaterDepth }),
      }),
    );
    sprite.renderOrder = 2;
    label.add(sprite);
  }
  label.scale.setScalar(0.3);
  return label;
}

/** Turn the corner's camera as the view's is turned, and fade each axis's
 *  name as its tip goes behind. */
function aimCorner() {
  corner.camera.quaternion.copy(camera.quaternion);
  corner.camera.position
    .set(0, 0, corner.distance)
    .applyQuaternion(camera.quaternion);
  corner.camera.updateMatrixWorld();
  const eye = cornerEye.set(0, 0, 1).applyQuaternion(camera.quaternion);
  for (const part of corner.axes.children) {
    if (!part.userData.along) continue;
    const fade = axisFade(part.userData.along.dot(eye));
    const [whole, hidden] = part.children; // as `axisName` makes them
    whole.material.opacity = fade;
    hidden.material.opacity = 0.3 * fade;
  }
}

/** How far the corner has grown, eased in and out: 0 at rest, 1 grown. */
function easedGrowth() {
  return grown * grown * (3 - 2 * grown);
}

/** The corner's square as it is now, in CSS pixels. */
function cornerSide() {
  const { rest, grown: full } = CORNER_SIDE;
  return rest + (full - rest) * easedGrowth();
}

/** Pose the corner as far as it has grown: the camera closer, the cube up
 *  from nothing round the middle, the axes from the middle to its corner. */
function poseCorner() {
  if (!corner) return;
  const eased = easedGrowth();
  const { rest, grown: full } = CORNER_REACH;
  const reach = rest + (full - rest) * eased;
  corner.distance = reach / Math.tan(THREE.MathUtils.degToRad(CORNER_FOV) / 2);
  corner.body.visible = eased > 0.01;
  corner.body.scale.setScalar(Math.max(eased, 0.01));
  corner.axes.position.setScalar(
    AXES_FROM.rest + (AXES_FROM.grown - AXES_FROM.rest) * eased,
  );
}

/** Grow the corner while the pointer is on it, and shrink it back after:
 *  `event` is the pointer's last move, or null when it has left the view. */
function hoverCorner(event) {
  const on = Boolean(event && onCorner(event));
  // Kept, to ask again what is under the pointer as the cube comes up round
  // it: a pointer that stops on the corner moves no more, and the cube was
  // not there yet when it last did.
  cornerPointer = on
    ? { offsetX: event.offsetX, offsetY: event.offsetY }
    : null;
  if (on === cornerHot) return;
  cornerHot = on;
  redraw();
}

/** One step of growing or shrinking, `elapsed` milliseconds on from the
 *  last; whether there was one to take. */
function growCorner(elapsed) {
  const goal = cornerHot ? 1 : 0;
  if (grown === goal) return false;
  grown = lessMotion
    ? goal
    : grown + (goal - grown) * (1 - Math.exp(-elapsed / CORNER_GROWTH_MS));
  if (Math.abs(goal - grown) < 0.004) grown = goal;
  poseCorner();
  if (cornerPointer) markCube(cubeTarget(cornerPointer));
  return true;
}

/** Where a pointer at `event` is on the corner's square, from -1 to 1 across
 *  and up it, or null when it is not on it. Where it is on the canvas is as
 *  the event already says. Asked of the layout instead, every move of the
 *  pointer over the view would be a measurement, for the few over the
 *  corner. */
function onCorner(event) {
  if (axesMode !== "cube" || !renderer) return null;
  const size = renderer.getSize(new THREE.Vector2());
  const [left, top] = cornerAt(size);
  const side = cornerSide();
  const at = new THREE.Vector2(
    ((event.offsetX - left) / side) * 2 - 1,
    -((event.offsetY - top) / side) * 2 + 1,
  );
  return Math.abs(at.x) > 1 || Math.abs(at.y) > 1 ? null : at;
}

/** Where a press at `event` on the cube says to look from -- a face, an edge
 *  or a corner, as `[x, y, z]` each -1, 0 or 1 -- or null when it is not on
 *  the cube, or the cube is not up. */
function cubeTarget(event) {
  const at = onCorner(event);
  if (!at) return null;
  if (!corner) dressCorner();
  if (!corner.body.visible) return null;
  aimCorner();
  cubeRay.setFromCamera(at, corner.camera);
  const hit = cubeRay.intersectObject(corner.body)[0];
  if (!hit) return null;
  // within CUBE_EDGE of a side is that side too: an edge is two, a corner three
  return corner.body
    .worldToLocal(hit.point)
    .toArray()
    .map((along) => (Math.abs(along) > 0.5 - CUBE_EDGE ? Math.sign(along) : 0));
}

/** Where the corner's square stands on a view `size` across, `side` pixels
 *  square: its left edge and its top, in CSS pixels from the view's top
 *  left. In from the bottom right corner, and from whatever the host floats
 *  there (`keepClear`). */
function cornerAt(size, side = cornerSide()) {
  return [
    size.x - CORNER_MARGIN - insets.right - side,
    size.y - CORNER_MARGIN - insets.bottom - side,
  ];
}

/** Stand the corner and the bar clear of `rects`: what the host floats over
 *  the view, where each is now, as DOMRects. One that reaches into the
 *  corner pushes the square the shorter way out of its way -- a column down
 *  the right-hand edge pushes it left, a bar along the foot pushes it up,
 *  and the scale bar with it. The square at rest is what stands clear:
 *  grown, under the pointer, it may reach in under a column that stops
 *  short of the corner. The host says again whenever what it floats comes,
 *  goes or moves; nothing is measured between times. */
function keepClear(rects) {
  insets = { right: 0, bottom: 0 };
  if (!host) return;
  // The element the view hangs in, not the canvas: a host asks from its own
  // resize observer, which runs before this module's has sized the canvas to
  // it, and the canvas then still measures as it was.
  const view = host.getBoundingClientRect();
  // the square's reach up from the foot, and in from the edge
  const reach = CORNER_MARGIN + CORNER_SIDE.rest;
  for (const rect of rects ?? []) {
    if (
      rect.right <= view.right - reach ||
      rect.bottom <= view.bottom - reach
    ) {
      continue;
    }
    const left = view.right - rect.left;
    const up = view.bottom - rect.top;
    if (left < up) insets.right = Math.max(insets.right, left);
    else insets.bottom = Math.max(insets.bottom, up);
  }
}

/** Mark the part of the cube a click would look from -- given nothing,
 *  nothing -- and point at it. */
function markCube(direction) {
  const key = direction ? direction.join(",") : null;
  if (key === marked) return;
  marked = key;
  if (renderer) renderer.domElement.style.cursor = direction ? "pointer" : "";
  placeMark();
  redraw();
}

/** Light what `marked` names on the cube: a face's middle, an edge's strip
 *  either side of it, a corner's three squares. */
function placeMark() {
  if (!corner) return;
  const { uniforms } = corner;
  uniforms.marking.value = marked ? 1 : 0;
  if (marked) uniforms.marked.value.fromArray(marked.split(",").map(Number));
}

/** Draw the corner and the scale bar over what was just drawn, when the
 *  scale is said that way. `withCube` false leaves the corner out: a picture
 *  of the view keeps the bar, which is part of what it shows, and not the
 *  control. */
function drawCorner(withCube) {
  if (axesMode !== "cube" || !renderer) return;
  const size = renderer.getSize(new THREE.Vector2());
  if (!corner) dressCorner();
  renderer.autoClear = false;
  renderer.clearDepth(); // the scene's depths are nothing to the corner
  if (withCube) {
    aimCorner();
    const side = cornerSide();
    const [left, top] = cornerAt(size, side);
    renderer.setViewport(left, size.y - top - side, side, side);
    renderer.render(corner.scene, corner.camera);
    renderer.setViewport(0, 0, size.x, size.y);
  }
  // Across the foot, low beside the axes at rest -- and left of them, in a
  // view too narrow for both. Nothing floats over a picture, so there it
  // stands at the foot whatever the host has over it now.
  const lift = withCube ? insets.bottom : 0;
  const [restLeft] = cornerAt(size, CORNER_SIDE.rest);
  drawBar(
    size,
    Math.min(size.x / 2, restLeft - BAR_ROOM.width / 2),
    CORNER_MARGIN + lift + BAR_UP,
  );
  renderer.autoClear = true;
}

/** How long one CSS pixel is in the scene, at the point the view turns
 *  about: everywhere, in a parallel view; in perspective, at that depth. */
function scenePerPixel(height) {
  const seen = camera.isOrthographicCamera
    ? camera.top - camera.bottom
    : 2 *
      camera.position.distanceTo(controls.target) *
      Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  return seen / camera.zoom / height;
}

/** A bar of a round length -- 1, 2 or 5 times a power of ten, in the scene's
 *  unit -- its middle `across` the view and `up` from its foot, in CSS
 *  pixels. */
function drawBar(size, across, up) {
  const perPixel = scenePerPixel(size.y);
  if (!(perPixel > 0 && Number.isFinite(perPixel))) return;
  const most = BAR_LONGEST * perPixel;
  const decade = Math.pow(10, Math.floor(Math.log10(most)));
  // a half too, for the decade a rounding log10 puts one too high
  const length = [5, 2, 1, 0.5].map((n) => n * decade).find((n) => n <= most);
  const text = sayLength(length);
  const ratio = renderer.getPixelRatio();
  if (bar?.ratio !== ratio) {
    dropBar();
    bar = makeBar(ratio);
  }
  paintBar(text, length / perPixel);
  const { width, height } = BAR_ROOM;
  bar.plane.position.set(across, up, 0);
  bar.plane.scale.set(width, height, 1);
  Object.assign(bar.camera, { right: size.x, top: size.y });
  bar.camera.updateProjectionMatrix();
  renderer.render(bar.scene, bar.camera);
}

/** `length`, in the scene's unit, in the unit that reads best. A unit this
 *  does not know is said as it is. */
function sayLength(length) {
  const factor = METRES[unit];
  if (!factor) return `${Number(length.toPrecision(3))} ${unit}`.trim();
  const [name, per] = readsBest(length * factor);
  return `${Number(((length * factor) / per).toPrecision(3))} ${name}`;
}

/** The scale bar's plane, with a canvas of its own to paint, at `ratio`
 *  device pixels to the CSS pixel. The canvas is never resized: a texture's
 *  size is fixed once it is on the GPU. */
function makeBar(ratio) {
  const canvas = document.createElement("canvas");
  canvas.width = BAR_ROOM.width * ratio;
  canvas.height = BAR_ROOM.height * ratio;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false; // drawn pixel for pixel
  texture.minFilter = THREE.LinearFilter;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  const barScene = new THREE.Scene();
  barScene.add(plane);
  return {
    ratio,
    canvas,
    texture,
    plane,
    scene: barScene,
    // in CSS pixels from the view's bottom left; its right and top are the
    // view's size, set as it is drawn
    camera: new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1),
    painted: "",
  };
}

function dropBar() {
  if (!bar) return;
  bar.texture.dispose();
  bar.plane.geometry.dispose();
  bar = null;
}

/** Paint the bar `pixels` long, named `text` -- only when that, or the
 *  theme, has changed since it was last painted. */
function paintBar(text, pixels) {
  const { ink, paper } = corner;
  const key = [text, pixels.toFixed(1), ink, paper].join("|");
  if (key === bar.painted) return;
  bar.painted = key;
  const { width, height } = BAR_ROOM;
  const context = bar.canvas.getContext("2d");
  context.setTransform(bar.ratio, 0, 0, bar.ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  // the bar and its name both in the middle of the room
  const left = (width - pixels) / 2;
  const right = left + pixels;
  const middle = width / 2;
  const y = height - 7;
  context.font = "12px sans-serif";
  // each over a halo of the background, to read over whatever is behind it
  const ends = () => {
    context.beginPath();
    context.moveTo(left, y - 5);
    context.lineTo(left, y);
    context.lineTo(right, y);
    context.lineTo(right, y - 5);
  };
  context.lineJoin = context.lineCap = "round";
  context.strokeStyle = paper;
  context.lineWidth = 4;
  ends();
  context.stroke();
  context.textAlign = "center";
  context.lineWidth = 3;
  context.strokeText(text, middle, y - 6);
  context.strokeStyle = context.fillStyle = ink;
  context.lineWidth = 1.5;
  ends();
  context.stroke();
  context.fillText(text, middle, y - 6);
  bar.texture.needsUpdate = true;
}

/** Free what `part` holds on the GPU: its geometry, unless borrowed from a
 *  path that still draws it, and its texture. Not its material. A material
 *  owns nothing on the GPU itself; its compiled program is three's, shared by
 *  every material of the same kind and let go when the last of them is
 *  disposed -- and a scene is rebuilt on every frame of a drag, so disposing
 *  the old meshes' materials threw every program away, and the next frame
 *  compiled and linked them all again: seven programs a frame, 14 ms of a
 *  16 ms frame on an M4 Pro, measured. Left alone, a material goes with its
 *  mesh, and the program stays for the next one like it. */
function free(part) {
  if (part.userData.batch) batchesStale = true;
  for (const { geometry } of mergedMarks.get(part)?.values() ?? []) {
    geometry.dispose();
  }
  mergedMarks.delete(part);
  flowLines.delete(part);
  flowArrows.delete(part);
  if (!part.userData.borrowed) part.geometry?.dispose();
  part.material?.map?.dispose();
}

/** Take what is drawn on `node` off it, and free it. The node itself stays,
 *  and whatever is attached to it -- the handles -- with it. */
function clearNode(node) {
  for (const child of [...(node?.children ?? [])]) {
    node.remove(child);
    child.traverse(free);
  }
}

/** Every item a payload draws: its meshes, its scatters and -- in a scene
 *  the engine drew -- its sensors' pixels. A frame of a run has no pixels
 *  of its own; its sensors came as meshes. */
function drawnItems(payload) {
  return payload.meshes.concat(
    payload.scatters,
    payload.pixels ?? [],
    payload.fieldlines ?? [],
  );
}

/** Drop every node but the ones held, freeing what they hold on the GPU.
 *  This runs on every edit: a colorscale texture per mesh, left to
 *  accumulate, is a leak. */
function discard(held) {
  for (const [objectId, node] of byObjectId) {
    if (held.has(objectId)) continue;
    scene.remove(node);
    node.traverse(free);
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
  overlaps = overlapsAt(payload.frame, payload.frames);
  for (const item of drawnItems(payload)) {
    const node = nodeFor(item.object_id, null);
    node.quaternion.identity(); // the geometry already holds the pose
    node.add(buildItem(item));
  }
  dressParts();
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
    entry.built.traverse(free);
    entry.built = buildItem(item);
    entry.node.attach(entry.built);
    // a sensor's part, or its axes beside its parts, hidden as they were
    if (entry.node.children.some((child) => child.userData.part)) {
      dress(entry.node);
    }
  }
  const frames = Math.max(
    1,
    ...Object.values(tracks ?? {}).map((steps) => steps.length),
    ...Object.values(changes ?? {}).map((steps) => steps.length),
  );
  const shown = overlapsAt(index, frames);
  const turned = shown !== overlaps;
  overlaps = shown;
  // What moved carries its marks; what was built again needs new ones, and
  // where two overlap and either moves, the region they share moves with it.
  if (changing.length || turned || overlapMoves()) {
    drawOutlines();
    drawHints();
  }
}

/** Whether either of an overlapping pair plays a run of its own. */
function overlapMoves() {
  if (!overlaps.length || !tracked.length) return false;
  const moving = new Set(
    tracked.map(({ built }) => built.userData.copy ?? ownerOf(built)),
  );
  return overlaps.some((pair) => pair.some((id) => moving.has(id)));
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
  Escape: "deselect", // but a drag in progress first: that is taken back
  Delete: "deletePoints", // the points held, out of a wire
  Backspace: "deletePoints",
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
    case "deselect":
      return cancelDrag() || ask(host.deselect);
    case "deletePoints":
      return deletePoints();
    default: // play
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
 * round trip behind the pointer -- several, on a slow kernel. So it is
 * carried from the pose the engine drew it at (`centroids`, `orientations`)
 * to where the handles hold the node now: what it reads lags, and catches
 * up with the next redraw, but where it is does not jump back to where the
 * pointer was a round trip ago.
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
  // a pulse's head lit toward white where that stands out: on a dark scene
  flowGlow.value = darkScene() ? 0.45 : 0;
  orientations = payload.orientations || {};
  anchors = payload.anchors || {};
  paths = payload.paths || {};
  // an overlap that was not there blinks as it comes (`cuesAt`): not every
  // frame of a drag that keeps it
  const were = new Set(overlaps.map(pairKey));
  endOverlaps = payload.overlaps ?? NO_OVERLAPS;
  stepOverlaps = payload.overlaps_by_step ?? null;
  overlaps = endOverlaps;
  if (overlaps.some((pair) => !were.has(pairKey(pair)))) {
    cueTimes.warned = performance.now();
  }
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
  copies = payload.copies || {};

  // A gesture's later steps draw only what it moves (`partial`): every other
  // node stands as its first step drew it, held as the dragged ones are.
  if (payload.partial) {
    const redrawn = new Set(payload.partial);
    for (const objectId of byObjectId.keys()) {
      if (!redrawn.has(objectId)) held.add(objectId);
    }
  }
  discard(held);
  const readings = new Set(payload.readings ?? []);
  const carried = new Map(); // a held reading's id -> from the engine's pose to its node's
  for (const objectId of held) {
    if (!readings.has(objectId)) continue;
    const node = byObjectId.get(objectId);
    clearNode(node);
    const at = payload.centroids?.[objectId];
    if (!node || !at) continue;
    node.updateWorldMatrix(true, false);
    const drawnAt = new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(at),
      quaternionOf(orientations[objectId]),
      new THREE.Vector3(1, 1, 1),
    );
    carried.set(objectId, node.matrixWorld.clone().multiply(drawnAt.invert()));
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
    const carry = carried.get(item.object_id);
    if (carry) built.applyMatrix4(carry); // where the handles hold it now
    node.attach(built);
    if (item.track != null) {
      tracked.push({ built, rest: built.matrix.clone(), track: item.track });
    }
    if (item.changes != null) {
      changing.push({ node, built, changes: item.changes });
    }
  }
  dressParts();
  placeCollections();

  // Size first: the fit depends on the aspect ratio, and on the very first
  // render the canvas may not have been laid out yet.
  resize(canvasEl);
  // The axes before the fit, which frames them with the objects: fitted
  // first, a renderer's first scene was framed without its box -- or with the
  // last scene's -- and came up zoomed in, the numbers off the edge, unless
  // something happened to fit it again.
  const was = METRES[unit];
  drawAxes(payload.ranges, payload.labels);
  if (keepCamera && framed && was && METRES[unit] && METRES[unit] !== was) {
    // The scene again, in another unit: a cell's objects, in the millimetres
    // magpylib drew them in, made editable come back in the session's
    // metres. The camera kept as it was looked at them from a thousand
    // times too far, a speck the scale bar called twenty metres across.
    rescaleCamera(was / METRES[unit]);
  }
  if (corner) dressCorner(); // in the theme the scene was just drawn in
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
  drawnSphere = sphere;
  fitClipping(); // the scene may reach further than it did
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
  setFlow,
  setColorRanges,
  keepClear,
  setHidden,
  setFades,
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
  heldPoint,
  pointEdit,
  setPointsMode,
  byObjectId,
});

// The first instance keeps the name. The notebook widget makes one of these
// per view, from a blob, and the studio's script panel draws that widget
// beside its own copy of this file -- which would otherwise lose `window`'s
// renderer to the widget's the moment one was drawn, and draw its next plain
// scene with a renderer the widget still holds.
window.scene3d ??= scene3d;
