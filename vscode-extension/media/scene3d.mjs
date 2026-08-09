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

const scene = new THREE.Scene();
let camera = null;
let controls = null;
let renderer = null;
const byObjectId = new Map();
let framed = false;

/** Panel background, so the view sits in whatever theme VS Code is wearing. */
function themeColor() {
  const css = getComputedStyle(document.body)
    .getPropertyValue("--vscode-editor-background")
    .trim();
  return css || "#1e1e1e";
}

function ensureRenderer(canvasEl) {
  if (renderer) return;
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
}

function resize(canvasEl) {
  if (!renderer) return;
  const { clientWidth: w, clientHeight: h } = canvasEl;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
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

function buildMesh(item, anchor) {
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

  // magpylib bakes the transform into the vertices, so re-centre on the
  // object's own origin and carry it on the mesh: that is what makes the mesh
  // movable, and what a gizmo would later be attached to
  const origin = new THREE.Vector3();
  if (anchor) {
    origin.fromArray(anchor);
  } else {
    geometry.computeBoundingBox();
    geometry.boundingBox.getCenter(origin);
  }
  geometry.translate(-origin.x, -origin.y, -origin.z);

  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial(options));
  mesh.position.copy(origin);
  mesh.name = item.name;
  mesh.userData.objectId = item.object_id;
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
  group.userData.objectId = item.object_id;
  return group;
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
  const box = new THREE.Box3();
  for (const object of byObjectId.values()) box.expandByObject(object);
  if (box.isEmpty()) return;

  const sphere = box.getBoundingSphere(new THREE.Sphere());
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
  scene.background = new THREE.Color(themeColor());

  for (const object of byObjectId.values()) scene.remove(object);
  byObjectId.clear();
  for (const item of payload.meshes) {
    const mesh = buildMesh(item, payload.anchors[item.object_id]);
    scene.add(mesh);
    byObjectId.set(item.object_id, mesh);
  }
  for (const item of payload.scatters) {
    const group = buildScatter(item);
    scene.add(group);
    // several traces can share an object (a current draws a loop and an
    // arrow), so the first one registered wins the key
    if (!byObjectId.has(item.object_id)) byObjectId.set(item.object_id, group);
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
}

window.scene3d = { render, fitView, byObjectId };
