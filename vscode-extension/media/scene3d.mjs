// The 3D view as a scene graph rather than a chart.
//
// Plotly draws the scene from a figure that is replaced whole on every edit.
// This builds one THREE.Mesh per object, keyed by the studio id the rest of
// the protocol already uses, so a later change can move or recolour a single
// object without asking python for a new scene.
//
// Loaded as a module because three ships ESM only; `scene3d` is on window so
// the classic studio.js can drive it.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

const scene = new THREE.Scene();
let camera = null;
let controls = null;
let renderer = null;
const raycaster = new THREE.Raycaster();
const byObjectId = new Map();
let framed = false;
let outlines = [];
let axes = null; // the box, ticks and names that give the scene a scale
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
/** Which axes each kind of drag runs along, in three's vocabulary.
 *
 * Per mode rather than one setting for all of them, because the right answer
 * differs and the control shows which is in force: positioning is world work,
 * while a polarization is *stored* in the object's frame and a dimension only
 * means anything along the object's own axes -- three forces that one anyway.
 */
const SPACES = {
  translate: "world",
  rotate: "world",
  polarization: "local",
  scale: "local",
};
let orientations = {}; // studio id -> the rotation baked into its vertices
let anchors = {}; // studio id -> where the object is
let paths = {}; // studio id -> every frame it passes through, when it has one
let shapes = {}; // studio id -> the one parameter a resize may drag
let polarizations = {}; // studio id -> its polarization, in its own frame
// What the polarization handles turn. The object must not turn with them, so
// they cannot be attached to it: this stands in, and only its rotation is read.
const proxy = new THREE.Object3D();

/** A VS Code theme colour, so the view wears whatever the editor is wearing. */
function cssColor(name, fallback) {
  const css = getComputedStyle(document.body).getPropertyValue(name).trim();
  return css || fallback;
}

function ensureRenderer(canvasEl) {
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
  controls = new OrbitControls(camera, renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(1, -1, 1);
  scene.add(key);

  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  new ResizeObserver(() => resize(canvasEl)).observe(canvasEl);
  watchPicks(canvasEl);
  makeGizmo(canvasEl);
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
    const pulled = [x, y, z].reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a));
    node.scale.setScalar(pulled);
  } else if (constraint === "xy") {
    const radial = Math.abs(x - 1) > Math.abs(y - 1) ? x : y;
    node.scale.set(radial, radial, z);
  }
}

/** The parameter value a scale comes to, from the one the drag started at. */
function resized(scale, shape, centre) {
  if (shape.constraint === "uniform") return shape.value * scale.x;
  if (shape.constraint === "xy") return [shape.value[0] * scale.x, shape.value[1] * scale.z];
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
  return [shape.value[0] * scale.x, shape.value[1] * scale.y, shape.value[2] * scale.z];
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
function makeGizmo(canvasEl) {
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
    const turned = node.quaternion.clone().multiply(from.quaternion.clone().invert());

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
      canvasEl.dispatchEvent(
        new CustomEvent("objecttransform", {
          detail: { preview, edits: [{ objectId: primary, polarization: aimed }] },
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

    const edits = [];
    for (const objectId of from.objectIds) {
      const edit = { objectId };
      const path = from.paths[objectId];
      const placed = rigid(from.placed[objectId]);
      if (!placed.equals(from.placed[objectId])) {
        edit.position = path
          ? path.position.map((p) => rigid(new THREE.Vector3().fromArray(p)).toArray())
          : placed.toArray();
      }
      if (turning) {
        // every frame turns by the same amount, so a path keeps its shape
        edit.orientation = path
          ? path.orientation.map((r) => rotvecOf(turned.clone().multiply(quaternionOf(r))))
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
      for (const box of outlines) box.update(); // boxes track objects, not the reverse
      canvasEl.dispatchEvent(
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
      const objectIds = node === rig ? [...selectedIds] : [node.userData.objectId];
      const primary = objectIds[0];
      const orientation = quaternionOf(orientations[primary]);
      const here = node.getWorldPosition(new THREE.Vector3());
      const placed = {};
      const turns = {};
      for (const objectId of objectIds) {
        placed[objectId] = new THREE.Vector3().fromArray(anchors[objectId] || [0, 0, 0]);
        turns[objectId] = quaternionOf(orientations[objectId]);
      }
      if (node === rig) {
        // `attach` keeps each object where it is while hanging it on the rig,
        // so the whole selection moves with the handles at pointer rate --
        // waiting for the model to come back would show nothing moving.
        for (const objectId of objectIds) {
          const carried = byObjectId.get(objectId);
          if (carried) rig.attach(carried);
        }
      }
      from = {
        objectIds,
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
      canvasEl.dispatchEvent(
        new CustomEvent("dragstart", {
          detail: { objectIds: from.objectIds, mode: gizmoMode },
        }),
      );
    } else {
      report(false); // the one that gets recorded and redrawn
      for (const objectId of from.objectIds) {
        const carried = byObjectId.get(objectId);
        if (carried && carried.parent === rig) scene.attach(carried);
      }
      from = null;
    }
  });
  gizmo.addEventListener("objectChange", () => {
    if (from?.shape) constrainScale(gizmo.object, from.shape.constraint);
    report(true);
  });
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
  if (gizmoMode === "polarization") {
    // The handles sit on the object and turn the stand-in. Two things have to
    // line up for them to follow a turned magnet: the stand-in must carry the
    // object's rotation, *and* the handles must be drawn against it -- three
    // only orients them to the object in local space, and scale is the one
    // mode it forces there, which is why resize followed and this did not.
    proxy.position.copy(node.getWorldPosition(new THREE.Vector3()));
    proxy.quaternion.copy(quaternionOf(orientations[primaryId()]));
    proxy.userData.objectId = primaryId();
    gizmo.mode = "rotate";
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
 */
function watchPicks(canvasEl) {
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
      canvasEl.dispatchEvent(
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
  const hits = raycaster.intersectObjects([...byObjectId.values()], true);
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
  applyProjection();
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
  scene.add(node);
  byObjectId.set(objectId, node);
  return node;
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
    if (item.lut) {
      // interpolate the intensity across the face and look the colour up per
      // fragment: the scale is piecewise, so sampling it per vertex loses it
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(item.uv, 2));
      options.map = lutTexture(item.lut);
    } else {
      options.color = new THREE.Color(item.color || "#2e91e5");
    }
  }
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial(options));
  mesh.name = item.name;
  return mesh;
}

function buildScatter(item) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(item.position, 3),
  );
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
  return group;
}

/** One object, or everything drawn, as a sphere -- null if there is nothing
 *  to look at. */
function sceneSphere(objectId) {
  const box = new THREE.Box3();
  if (byObjectId.has(objectId)) {
    box.expandByObject(byObjectId.get(objectId));
  } else {
    for (const node of byObjectId.values()) box.expandByObject(node);
    // the graduated box sits a little outside the objects, and framing the
    // scene without its scale showing would cut the numbers off
    if (axes) box.expandByObject(axes);
  }
  return box.isEmpty() ? null : box.getBoundingSphere(new THREE.Sphere());
}

/** Outline the selected object.
 *
 * A box rather than a tint or an emissive glow: colour *is* the data here --
 * it carries magnetization direction and field magnitude -- so a highlight
 * that repainted the object would overwrite what the user is looking at.
 */
function highlight(objectIds) {
  selectedIds = (Array.isArray(objectIds) ? objectIds : [objectIds]).filter(Boolean);
  for (const box of outlines) {
    scene.remove(box);
    box.dispose();
  }
  outlines = [];
  setGizmoMode(gizmoMode); // the handles belong to whatever is selected now
  const accent = new THREE.Color(cssColor("--vscode-focusBorder", "#0078d4"));
  for (const objectId of selectedIds) {
    const node = byObjectId.get(objectId);
    if (!node) continue;
    const box = new THREE.BoxHelper(node, accent);
    box.raycast = () => {}; // an indicator, not a target
    scene.add(box);
    outlines.push(box);
  }
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
function fitView(objectId) {
  const sphere = sceneSphere(objectId);
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
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  gizmo.camera = camera; // this one has a setter that passes it on
  applyProjection();
  camera.lookAt(target);
  controls.update();
  return wasOrthographic ? "perspective" : "parallel";
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
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
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
  const box = new THREE.Box3Helper(new THREE.Box3(low, high), new THREE.Color(ink));
  box.material.transparent = true;
  box.material.opacity = 0.35;
  box.raycast = () => {};
  axes.add(box);

  // Ticks on the three edges that meet at one corner: on all twelve they
  // would be unreadable, and one of each is enough to read a length off.
  const along = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const names = [labels?.x ?? "x", labels?.y ?? "y", labels?.z ?? "z"];
  for (let axis = 0; axis < 3; axis++) {
    const from = low.getComponent(axis);
    const to = high.getComponent(axis);
    const step = niceStep((to - from) / 5);
    const outward = along[(axis + 1) % 3].clone().add(along[(axis + 2) % 3]).multiplyScalar(-text);
    for (let value = Math.ceil(from / step) * step; value <= to + step / 2; value += step) {
      const at = low.clone();
      at.setComponent(axis, value);
      const label = textSprite(Number(value.toPrecision(4)).toString(), ink, text);
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
  scene.add(axes);
}

/** Drop every node but the ones held, freeing what they hold on the GPU.
 *  This runs on every edit: a colorscale texture per mesh, left to
 *  accumulate, is a leak. */
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
  for (const item of payload.meshes.concat(payload.scatters)) {
    const node = nodeFor(item.object_id, null);
    node.quaternion.identity(); // the geometry already holds the pose
    node.add(item.kind === "mesh" ? buildMesh(item) : buildScatter(item));
  }
  for (const box of outlines) box.update();
}

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

/** The object after this one, so a keystroke can walk the scene. */
function nextObject(objectId) {
  const drawn = [...byObjectId.keys()].filter(Boolean);
  if (!drawn.length) return undefined;
  return drawn[(drawn.indexOf(objectId) + 1) % drawn.length];
}

/** Replace the drawn objects with `payload`, keeping the camera where it is.
 *
 * `keep` names one object to leave alone: the one being dragged. Everything
 * else in the scene is redrawn, because plenty of it is *derived* from the
 * dragged object -- a field's arrows turn as the magnet that makes them
 * moves, and no amount of moving a mesh locally will show that. The dragged
 * object itself is the one thing the picture already has right, and swapping
 * it out from under the gizmo mid-drag would end the drag.
 */
function render(canvasEl, payload, { keepCamera = true, keep = [] } = {}) {
  const held = new Set([].concat(keep ?? []));
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

  discard(held);
  // `attach` keeps each trace where magpylib put it while re-parenting it, so
  // the baked world coordinates survive the move onto the object's own node.
  for (const item of payload.meshes.concat(payload.scatters)) {
    if (held.has(item.object_id)) continue;
    const node = nodeFor(item.object_id, payload.centroids[item.object_id]);
    node.attach(item.kind === "mesh" ? buildMesh(item) : buildScatter(item));
  }

  // Size first: the fit depends on the aspect ratio, and on the very first
  // render the canvas may not have been laid out yet.
  resize(canvasEl);
  // Refit when there was nothing to look at before. A scene that arrives
  // empty and is filled by a later refresh -- which is what a parametric
  // example does -- would otherwise keep the camera fitted to the empty one.
  if (!keepCamera || !framed) {
    fitView();
    framed = byObjectId.size > 0;
  }
  // Lines and points are hit within a radius of the ray, measured in world
  // units: a fixed one would miss a scene in metres and swallow one in
  // millimetres, so scale it to what is on screen.
  drawAxes(payload.ranges, payload.labels);
  const sphere = sceneSphere();
  raycaster.params.Points.threshold = sphere ? sphere.radius / 100 : 1;
  raycaster.params.Line.threshold = raycaster.params.Points.threshold;
  // Mid-drag the selected object is the one that was *not* rebuilt, and
  // re-attaching the gizmo to it would interrupt the drag in progress.
  if (!held.size) highlight(selectedIds);
}

window.scene3d = {
  render,
  fitView,
  highlight,
  setGizmoMode,
  constrainAxis,
  setSnapping,
  toggleProjection,
  setPlaying,
  renderFrame,
  frameCount,
  nextObject,
  setSpace,
  spaceOf,
  toggleSpace,
  axisView,
  canResize: (objectId) => Boolean(shapes[objectId]),
  canAim: (objectId) => Boolean(polarizations[objectId]),
  byObjectId,
};
