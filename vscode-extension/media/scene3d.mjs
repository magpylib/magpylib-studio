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

/** The drag handles, and the edit a finished drag asks for.
 *
 * What a drag can report is limited by what the payload is: magpylib bakes
 * each object's transform into the vertices, so the node starts every render
 * at identity and its rotation is only ever the turn *this* drag made. A
 * position can be sent as it stands -- the node sits on the object's own
 * origin -- but a rotation has to go out as the relative turn it is, which is
 * what magpylib's rotate() takes anyway.
 */
function makeGizmo(canvasEl) {
  let turnedFrom = null;
  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSpace("world"); // the axes the user reads off the model
  gizmo.size = 0.6; // full size swamps a small object
  scene.add(gizmo.getHelper());

  gizmo.addEventListener("dragging-changed", (event) => {
    controls.enabled = !event.value; // do not orbit while dragging a handle
    const node = gizmo.object;
    if (!node) return;
    if (event.value) {
      turnedFrom = node.quaternion.clone();
      return;
    }
    const detail = { objectId: node.userData.objectId };
    if (gizmo.mode === "rotate") {
      // the turn this drag made, about the object's own origin -- which is
      // where magpylib rotates when it is given no anchor
      const turn = node.quaternion.clone().multiply(turnedFrom.invert());
      const angle = 2 * Math.acos(THREE.MathUtils.clamp(turn.w, -1, 1));
      const sine = Math.sqrt(Math.max(1 - turn.w * turn.w, 0));
      if (sine < 1e-9) return; // no turn worth recording
      detail.mode = "rotate";
      detail.angle = THREE.MathUtils.radToDeg(angle);
      detail.axis = [turn.x / sine, turn.y / sine, turn.z / sine];
    } else {
      detail.mode = "translate";
      detail.position = node.getWorldPosition(new THREE.Vector3()).toArray();
    }
    canvasEl.dispatchEvent(new CustomEvent("objecttransform", { detail }));
  });
}

/** Which handles to show, or "none" to put them away. Also how the handles
 *  find their way back onto an object that a re-render has just replaced. */
function setGizmoMode(mode) {
  gizmoMode = mode;
  if (!gizmo) return;
  const node = mode === "none" ? null : byObjectId.get(selectedId);
  if (!node) {
    gizmo.detach();
    return;
  }
  gizmo.mode = mode;
  gizmo.attach(node);
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
function nodeFor(objectId, anchor) {
  let node = byObjectId.get(objectId);
  if (node) return node;
  node = new THREE.Group();
  if (anchor) node.position.fromArray(anchor);
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

/** Everything drawn, as one sphere -- null when there is nothing to look at. */
function sceneSphere() {
  const box = new THREE.Box3();
  for (const node of byObjectId.values()) box.expandByObject(node);
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
function fitView() {
  const sphere = sceneSphere();
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

/** Replace the drawn objects with `payload`, keeping the camera where it is. */
function render(canvasEl, payload, { keepCamera = true } = {}) {
  ensureRenderer(canvasEl);
  const background = cssColor("--vscode-editor-background", "#1e1e1e");
  scene.background = new THREE.Color(background);

  // Dropping a node does not free what it holds on the GPU, and this runs on
  // every edit: a colorscale texture per mesh, left to accumulate, is a leak.
  for (const node of byObjectId.values()) {
    scene.remove(node);
    node.traverse((child) => {
      child.geometry?.dispose();
      child.material?.map?.dispose();
      child.material?.dispose();
    });
  }
  byObjectId.clear();
  // `attach` keeps each trace where magpylib put it while re-parenting it, so
  // the baked world coordinates survive the move onto the object's own node.
  for (const item of payload.meshes) {
    nodeFor(item.object_id, payload.anchors[item.object_id]).attach(buildMesh(item));
  }
  for (const item of payload.scatters) {
    nodeFor(item.object_id, payload.anchors[item.object_id]).attach(buildScatter(item));
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
  highlight(selectedId); // the objects are new; the selection is not
}

window.scene3d = { render, fitView, highlight, setGizmoMode, byObjectId };
