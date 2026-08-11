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
let outline = null;
let selectedId;
let gizmo = null;
let gizmoMode = "translate";
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

  const report = (preview) => {
    const node = gizmo.object;
    if (!node || !from) return;
    const detail = { objectId: node.userData.objectId, preview };
    const turned = node.quaternion.clone().multiply(from.quaternion.clone().invert());

    if (from.polarization) {
      // The drag turns the vector, not the magnet. magpylib keeps it in the
      // object's own frame, so the turn is applied in world and taken back:
      // reading the stored vector as world-space is out by the object's own
      // rotation, which is a silent error the picture cannot show.
      if (Math.abs(turned.w) >= 1 - 1e-9) return;
      detail.polarization = from.polarization
        .clone()
        .applyQuaternion(turned)
        .applyQuaternion(from.orientation.clone().invert())
        .toArray();
      canvasEl.dispatchEvent(new CustomEvent("objecttransform", { detail }));
      return;
    }

    // One rigid motion, applied to every frame the object passes through: a
    // point p goes to (where the handles are now) + turn x (p - where they
    // were). An object with no path is the single-frame case of that, and
    // the offset between its position and its centroid is what the turn acts
    // on -- which is why turning something off-centre moves it, and why
    // anything centred on its own position stays put.
    const here = node.getWorldPosition(new THREE.Vector3());
    const rigid = (point) =>
      here.clone().add(point.clone().sub(from.here).applyQuaternion(turned));

    const placed = rigid(from.placed);
    if (!placed.equals(from.placed)) {
      detail.position = from.path
        ? from.path.position.map((p) => rigid(new THREE.Vector3().fromArray(p)).toArray())
        : placed.toArray();
    }
    if (Math.abs(turned.w) < 1 - 1e-9) {
      // every frame turns by the same amount, so the path keeps its shape
      detail.orientation = from.path
        ? from.path.orientation.map((r) =>
            rotvecOf(turned.clone().multiply(quaternionOf(r))),
          )
        : rotvecOf(turned.clone().multiply(from.orientation));
    }
    if (from.shape && !node.scale.equals(UNSCALED)) {
      detail.shape = {
        attr: from.shape.attr,
        value: resized(node.scale, from.shape, from.centre),
        scale: node.scale.toArray(), // for the readout: a mesh has no size to print
      };
    }
    if (detail.position || detail.orientation || detail.shape) {
      outline?.update(); // the box tracks the object, not the other way round
      canvasEl.dispatchEvent(new CustomEvent("objecttransform", { detail }));
    }
  };

  gizmo.addEventListener("dragging-changed", (event) => {
    controls.enabled = !event.value; // do not orbit while dragging a handle
    const node = gizmo.object;
    if (!node) return;
    if (event.value) {
      const objectId = node.userData.objectId;
      const orientation = quaternionOf(orientations[objectId]);
      const placed = new THREE.Vector3().fromArray(anchors[objectId] || [0, 0, 0]);
      const here = node.getWorldPosition(new THREE.Vector3());
      from = {
        position: node.position.clone(),
        quaternion: node.quaternion.clone(),
        orientation,
        placed, // where the object is, as against where its handles are
        here, // where the handles were when the drag began: the pivot
        path: paths[objectId] || null, // so a drag moves the whole track
        // where the handles are in the object's own frame, which is the
        // centre a vertex array has to be scaled about to match the screen
        centre: here
          .clone()
          .sub(placed)
          .applyQuaternion(orientation.clone().invert()),
        shape: gizmo.mode === "scale" ? shapes[objectId] : null,
        polarization:
          gizmoMode === "polarization"
            ? new THREE.Vector3()
                .fromArray(polarizations[objectId])
                .applyQuaternion(orientation) // stored local, turned in world
            : null,
      };
      canvasEl.dispatchEvent(
        new CustomEvent("dragstart", { detail: { objectId, mode: gizmoMode } }),
      );
    } else {
      report(false); // the one that gets recorded and redrawn
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
  const missing =
    (mode === "scale" && !shapes[selectedId]) ||
    (mode === "polarization" && !polarizations[selectedId]);
  gizmoMode = missing ? "translate" : mode;
  if (!gizmo) return gizmoMode;
  const node = gizmoMode === "none" ? null : byObjectId.get(selectedId);
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
    proxy.quaternion.copy(quaternionOf(orientations[selectedId]));
    proxy.userData.objectId = selectedId;
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
      canvasEl.dispatchEvent(new CustomEvent("objectpick", { detail: { objectId } }));
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
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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
  const nodes = byObjectId.has(objectId)
    ? [byObjectId.get(objectId)]
    : byObjectId.values();
  for (const node of nodes) box.expandByObject(node);
  return box.isEmpty() ? null : box.getBoundingSphere(new THREE.Sphere());
}

/** Outline the selected object.
 *
 * A box rather than a tint or an emissive glow: colour *is* the data here --
 * it carries magnetization direction and field magnitude -- so a highlight
 * that repainted the object would overwrite what the user is looking at.
 */
function highlight(objectId) {
  selectedId = objectId;
  if (outline) {
    scene.remove(outline);
    outline.dispose();
    outline = null;
  }
  setGizmoMode(gizmoMode); // the handles belong to whatever is selected now
  const node = byObjectId.get(objectId);
  if (!node) return;
  const accent = cssColor("--vscode-focusBorder", "#0078d4");
  outline = new THREE.BoxHelper(node, new THREE.Color(accent));
  outline.raycast = () => {}; // an indicator, not a target
  scene.add(outline);
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

  const vertical = THREE.MathUtils.degToRad(camera.fov);
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
  const distance =
    (sphere.radius /
      Math.sin(Math.min(vertical, horizontal) / 2)) *
    1.1; // a margin, so nothing sits exactly on the edge

  const direction = new THREE.Vector3(0.55, -0.68, 0.48).normalize();
  camera.near = Math.max(distance / 5000, 1e-6);
  camera.far = distance * 20;
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.updateProjectionMatrix();
  controls.target.copy(sphere.center);
  controls.update();
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
function render(canvasEl, payload, { keepCamera = true, keep = null } = {}) {
  ensureRenderer(canvasEl);
  const background = cssColor("--vscode-editor-background", "#1e1e1e");
  scene.background = new THREE.Color(background);
  orientations = payload.orientations || {};
  anchors = payload.anchors || {};
  paths = payload.paths || {};
  shapes = payload.shapes || {};
  polarizations = payload.polarizations || {};

  // Dropping a node does not free what it holds on the GPU, and this runs on
  // every edit: a colorscale texture per mesh, left to accumulate, is a leak.
  for (const [objectId, node] of byObjectId) {
    if (objectId === keep) continue;
    scene.remove(node);
    node.traverse((child) => {
      child.geometry?.dispose();
      child.material?.map?.dispose();
      child.material?.dispose();
    });
    byObjectId.delete(objectId);
  }
  // `attach` keeps each trace where magpylib put it while re-parenting it, so
  // the baked world coordinates survive the move onto the object's own node.
  for (const item of payload.meshes.concat(payload.scatters)) {
    if (item.object_id === keep) continue;
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
  const sphere = sceneSphere();
  raycaster.params.Points.threshold = sphere ? sphere.radius / 100 : 1;
  raycaster.params.Line.threshold = raycaster.params.Points.threshold;
  // Mid-drag the selected object is the one that was *not* rebuilt, and
  // re-attaching the gizmo to it would interrupt the drag in progress.
  if (keep === null) highlight(selectedId);
}

window.scene3d = {
  render,
  fitView,
  highlight,
  setGizmoMode,
  constrainAxis,
  setSpace,
  spaceOf,
  toggleSpace,
  axisView,
  canResize: (objectId) => Boolean(shapes[objectId]),
  canAim: (objectId) => Boolean(polarizations[objectId]),
  byObjectId,
};
