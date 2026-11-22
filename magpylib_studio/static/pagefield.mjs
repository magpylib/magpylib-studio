/**
 * A sensor dragged on a saved page, its field lines drawn again by the page
 * itself (#176): no python behind it, material-response's compiled kernels
 * instead -- a magnet's B, a solved sheet's H -- loaded from the page.
 *
 * What python sends a view, the page works out here, by the same rules
 * (`fieldlines.py`, `MagpylibStudioSession._field_lines`), which the scene
 * hands over with its sources (`page_field`): only the sensor moves, so the
 * grid the lines were drawn on is kept while its pixels stay on it, and the
 * lines are only traced again from where they are now. A pixel off it takes
 * a coarser grid round the sensor, its field computed at the drag's
 * tolerance; at the release the grid at rest is kept, slid by whole steps,
 * or laid again, at the finer tolerance. The grid rules below are python's,
 * a second copy that `tests/test_page_field.py` holds to it.
 */

// --- small vector algebra; quaternions as scipy has them, (x, y, z, w) -----

/** `v` turned by `q`, or by its inverse. */
function turn(q, v, inverse = false) {
  const s = inverse ? -1 : 1;
  const [qx, qy, qz, w] = [s * q[0], s * q[1], s * q[2], q[3]];
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + w * tx + (qy * tz - qz * ty),
    v[1] + w * ty + (qz * tx - qx * tz),
    v[2] + w * tz + (qx * ty - qy * tx),
  ];
}

/** The quaternion of rotation vector `r` in degrees, as the view writes an
 *  orientation (`quaternionOf` in scene3d.mjs, and edits). */
export function quaternionOf(r) {
  const degrees = Math.hypot(r[0], r[1], r[2]);
  if (degrees < 1e-12) return [0, 0, 0, 1];
  const half = (degrees * Math.PI) / 360;
  const s = Math.sin(half) / degrees;
  return [r[0] * s, r[1] * s, r[2] * s, Math.cos(half)];
}

/** The rotation vector of quaternion `q`, in degrees, as the view reads one. */
export function rotvecOf(q) {
  const [x, y, z, w] = q[3] < 0 ? q.map((c) => -c) : q;
  const sine = Math.hypot(x, y, z);
  if (sine < 1e-300) return [0, 0, 0];
  const degrees = (360 / Math.PI) * Math.atan2(sine, w);
  return [(x * degrees) / sine, (y * degrees) / sine, (z * degrees) / sine];
}

/** `a` after `b`: the quaternion that turns by `b`, then by `a`. */
function product(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Little-endian float64s from base64, as `fieldlines._float64` writes them. */
function float64s(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Float64Array(bytes.buffer);
}

// --- the grid, as `fieldlines.py` lays it -----------------------------------

/** Where a sensor's pixels are, at `pose`: `seeds_of`. */
export function seedsAt(sensor, pose) {
  return sensor.pixels.map((p) => {
    const v = turn(pose.orientation, p);
    return [
      v[0] + pose.position[0],
      v[1] + pose.position[1],
      v[2] + pose.position[2],
    ];
  });
}

/** The axes the grid is laid along, as rows, and whether the seeds lie in a
 *  plane: `frame_of`, from the plane's normal in the sensor's own frame,
 *  which a rigid move only turns. */
export function frameOf(sensor, pose) {
  if (!sensor.normal) return [IDENTITY, false];
  const normal = normalOf(turn(pose.orientation, sensor.normal));
  const leaning = normal.map(Math.abs);
  const nearest = leaning.indexOf(Math.min(...leaning));
  const world = IDENTITY[nearest];
  const along = dot(world, normal);
  let across = world.map((w, k) => w - along * normal[k]);
  const size = Math.hypot(...across);
  across = across.map((a) => a / size);
  return [[across, cross(normal, across), normal], true];
}
/** `normal` the way `frame_of` points it: its largest component positive
 *  (the first of equals, as numpy's argmax). */
function normalOf(normal) {
  let largest = 0;
  for (let k = 1; k < 3; k++) {
    if (Math.abs(normal[k]) > Math.abs(normal[largest])) largest = k;
  }
  return normal[largest] < 0 ? normal.map((v) => -v) : normal;
}
const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** The mean of rows `points`. */
function middle(points) {
  const c = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k++) c[k] += p[k];
  return c.map((v) => v / points.length);
}

/** `grid_around`: the grid for `seeds` round them and the sources near
 *  them, about `points` points, in their plane where `planar`. */
export function gridAround(centres, seeds, points, [axes, planar]) {
  const centre = middle(seeds);
  let far = 0;
  for (const s of seeds)
    far = Math.max(far, Math.hypot(...s.map((v, k) => v - centre[k])));
  const reach = 3 * Math.max(far, 0.005);
  const near = centres.filter(
    (c) => Math.hypot(...c.map((v, k) => v - centre[k])) <= reach,
  );
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const p of [...near, ...seeds]) {
    const d = p.map((v, k) => v - centre[k]);
    for (let k = 0; k < 3; k++) {
      const local = dot(axes[k], d);
      low[k] = Math.min(low[k], local);
      high[k] = Math.max(high[k], local);
    }
  }
  const pad = 0.25 * Math.max(...high.map((h, k) => h - low[k])) || 0.01;
  for (let k = 0; k < 3; k++) {
    low[k] -= pad;
    high[k] += pad;
  }
  let step, shape;
  if (planar) {
    low[2] = high[2] = 0;
    const span = [high[0] - low[0], high[1] - low[1]];
    step = Math.sqrt((span[0] * span[1]) / points);
    shape = [...span.map((s) => Math.max(Math.ceil(s / step) + 1, 2)), 1];
  } else {
    const span = high.map((h, k) => h - low[k]);
    step = Math.cbrt((span[0] * span[1] * span[2]) / points);
    shape = span.map((s) => Math.max(Math.ceil(s / step) + 1, 2));
  }
  const origin = centre.map(
    (c, k) =>
      c + low[0] * axes[0][k] + low[1] * axes[1][k] + low[2] * axes[2][k],
  );
  return { origin, axes, step, shape };
}

const isFlat = (grid) => grid.shape[2] === 1;

/** `points_of`: the grid's points in the world, flat, the last axis fastest. */
export function pointsOf(grid) {
  const [nx, ny, nz] = grid.shape;
  const out = new Float64Array(nx * ny * nz * 3);
  const { origin: o, axes: a, step: h } = grid;
  let at = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const [u, v, w] = [h * i, h * j, h * k];
        for (let c = 0; c < 3; c++) {
          out[at++] = o[c] + u * a[0][c] + v * a[1][c] + w * a[2][c];
        }
      }
    }
  }
  return out;
}

/** `holds`: whether `grid` still serves `seeds`, kept `margin` of its
 *  largest side from its edges, and in its plane, a flat one's. */
export function holds(grid, seeds, margin) {
  const sides = grid.shape.map((n) => grid.step * (n - 1));
  const room = margin * Math.max(...sides);
  const flat = isFlat(grid);
  for (const s of seeds) {
    const d = s.map((v, k) => v - grid.origin[k]);
    for (let k = 0; k < 3; k++) {
      const local = dot(grid.axes[k], d);
      if (flat && k === 2) {
        if (Math.abs(local) > 1e-3 * grid.step) return false;
      } else if (!(local >= room && local <= sides[k] - room)) return false;
    }
  }
  return true;
}

/** `slide`: `kept` moved by whole steps with seeds from `then` to `now`;
 *  `[grid, was]`, `was` the index among `kept`'s points of each of the new
 *  grid's, or -1. Null where the seeds have left a flat grid's plane. */
export function slide(kept, then, now) {
  const axes = kept.axes;
  const from = middle(then);
  const to = middle(now);
  const moved = axes.map((a) =>
    dot(
      a,
      to.map((v, k) => v - from[k]),
    ),
  );
  if (isFlat(kept)) {
    for (const s of now) {
      const local = dot(
        axes[2],
        s.map((v, k) => v - kept.origin[k]),
      );
      if (Math.abs(local) > 1e-3 * kept.step) return null;
    }
    moved[2] = 0;
  }
  // numpy's rint: halves to even
  const shift = moved.map((m) => {
    const x = m / kept.step;
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  });
  const [nx, ny, nz] = kept.shape;
  const was = new Int32Array(nx * ny * nz);
  let at = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const [a, b, c] = [i + shift[0], j + shift[1], k + shift[2]];
        const inside = a >= 0 && a < nx && b >= 0 && b < ny && c >= 0 && c < nz;
        was[at++] = inside ? (a * ny + b) * nz + c : -1;
      }
    }
  }
  const origin = kept.origin.map(
    (o, k) =>
      o +
      kept.step *
        (shift[0] * axes[0][k] + shift[1] * axes[1][k] + shift[2] * axes[2][k]),
  );
  return [{ ...kept, origin }, was];
}

/** `keeps_to`: whether the field `along` a flat grid's axes stays in its
 *  plane, outside the magnets, within `across` of all of it. */
export function keepsTo(along, within, across) {
  let total = 0;
  let off = 0;
  for (let n = 0; n < within.length; n++) {
    if (within[n]) continue;
    const [x, y, z] = [along[3 * n], along[3 * n + 1], along[3 * n + 2]];
    total += Math.hypot(x, y, z);
    off += Math.abs(z);
  }
  return total === 0 || off <= across * total;
}

// --- the field, and what is inside a body ------------------------------------

/** The sources of `field` (a scene's `page_field`) made ready to compute:
 *  each sheet built once into the kernels' `Sheet`, the sheets' triangles
 *  in the world for the inside test, and the centres `gridAround` reads. */
export function prepared(kernels, field) {
  const sheets = field.sheets.map((s) => ({
    ...s,
    built: new kernels.ChargeSheet(
      float64s(s.triangles),
      float64s(s.charge_densities),
    ),
  }));
  // `_inside_sheets`: every sheet's triangles in the world, as one body --
  // parts solved together leave out the faces they share
  const corners = [];
  for (const s of field.sheets) {
    const local = float64s(s.triangles);
    for (let i = 0; i < local.length; i += 3) {
      const v = turn(s.orientation, [local[i], local[i + 1], local[i + 2]]);
      corners.push(
        v[0] + s.position[0],
        v[1] + s.position[1],
        v[2] + s.position[2],
      );
    }
  }
  return {
    field,
    kernels,
    sheets,
    body: Float64Array.from(corners),
    centres: [...field.cuboids, ...field.sheets].map((s) => s.position),
  };
}

/** `points` (flat, the world's) in `source`'s own frame. */
function intoFrame(source, points) {
  const out = new Float64Array(points.length);
  const p = source.position;
  for (let i = 0; i < points.length; i += 3) {
    const v = turn(
      source.orientation,
      [points[i] - p[0], points[i + 1] - p[1], points[i + 2] - p[2]],
      true,
    );
    out[i] = v[0];
    out[i + 1] = v[1];
    out[i + 2] = v[2];
  }
  return out;
}

/** `local`, a source's field in its own frame, turned into the world's and
 *  added to `sum`, times `scale`; NaN as nothing, as `fieldlines.field`. */
function addTurned(source, local, sum, scale) {
  for (let i = 0; i < local.length; i += 3) {
    const v = turn(source.orientation, [local[i], local[i + 1], local[i + 2]]);
    for (let k = 0; k < 3; k++) {
      const value = scale * v[k];
      if (Number.isFinite(value)) sum[i + k] += value;
    }
  }
}

/** B, or H, of the scene's sources at `points` (flat, the world's): the
 *  magnets' from the kernels' cuboid, the sheets' H times mu0 for B. */
export function fieldAt(ready, points, kind, tolerance) {
  const { kernels, field } = ready;
  const sum = new Float64Array(points.length);
  for (const c of field.cuboids) {
    const local = kernels.cuboid_field(
      kind,
      intoFrame(c, points),
      Float64Array.from(c.dimension),
      Float64Array.from(c.polarization),
    );
    addTurned(c, local, sum, 1);
  }
  for (const s of ready.sheets) {
    const h = s.built.h(intoFrame(s, points), tolerance);
    addTurned(s, h, sum, kind === "H" ? 1 : field.mu0);
  }
  return sum;
}

/** Which `points` are inside a magnet or a solved body: `fieldlines.inside`
 *  -- a cuboid as `_inside_cuboids` tests it, the sheets as one closed body
 *  by the crossings of a ray, magpylib's `_mask_inside_trimesh`. */
export function insideAt(ready, points) {
  const n = points.length / 3;
  const within = new Uint8Array(n);
  const surface = ready.field.rules.surface;
  for (const c of ready.field.cuboids) {
    if (!c.polarization.some((v) => v !== 0)) continue;
    const half = c.dimension.map((d) => Math.abs(d) / 2);
    const local = intoFrame(c, points);
    for (let i = 0; i < n; i++) {
      if (within[i]) continue;
      let hit = true;
      for (let k = 0; k < 3; k++) {
        if (!(Math.abs(local[3 * i + k]) - half[k] < surface * half[k]))
          hit = false;
      }
      if (hit) within[i] = 1;
    }
  }
  if (ready.body.length) insideMesh(points, ready.body, within);
  return within;
}

/** magpylib's `_mask_inside_trimesh` on `faces` (flat, nine numbers a
 *  triangle), into `within`: points in the enclosing box are tested by a
 *  line from a point outside it, which crosses the faces an odd number of
 *  times or ends on one. The same constants, so the same answers. */
function insideMesh(points, faces, within) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < faces.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      low[k] = Math.min(low[k], faces[i + k]);
      high[k] = Math.max(high[k], faces[i + k]);
    }
  }
  const start = [low[0] - 12.0012345, low[1] - 5.9923456, low[2] - 6.9932109];
  const m = faces.length / 9;
  // per face: its corners and its normal, once
  const normal = new Float64Array(3 * m);
  for (let f = 0; f < m; f++) {
    const o = 9 * f;
    const a = [
      faces[o] - faces[o + 6],
      faces[o + 1] - faces[o + 7],
      faces[o + 2] - faces[o + 8],
    ];
    const b = [
      faces[o + 3] - faces[o + 6],
      faces[o + 4] - faces[o + 7],
      faces[o + 5] - faces[o + 8],
    ];
    normal.set(cross(a, b), 3 * f);
  }
  const norm2 = (x, y, z) => x * x + y * y + z * z;
  const tripleProduct = (a, b, c) =>
    (a[1] * b[2] - a[2] * b[1]) * c[0] +
    (a[2] * b[0] - a[0] * b[2]) * c[1] +
    (a[0] * b[1] - a[1] * b[0]) * c[2];
  const n = points.length / 3;
  for (let i = 0; i < n; i++) {
    const p = [points[3 * i], points[3 * i + 1], points[3 * i + 2]];
    let boxed = true;
    for (let k = 0; k < 3; k++) {
      if (!(p[k] < high[k] + 1e-12 && p[k] > low[k] - 1e-12)) boxed = false;
    }
    if (!boxed || within[i]) continue;
    const d = [p[0] - start[0], p[1] - start[1], p[2] - start[2]];
    let crossings = 0;
    let touch = false;
    for (let f = 0; f < m; f++) {
      const o = 9 * f;
      const nx = normal[3 * f];
      const ny = normal[3 * f + 1];
      const nz = normal[3 * f + 2];
      // the corner the planes are measured from: the third, or the second
      // where the point is on the third
      let r = 6;
      if (
        norm2(p[0] - faces[o + 6], p[1] - faces[o + 7], p[2] - faces[o + 8]) <
        1e-16
      )
        r = 3;
      const ref = [faces[o + r], faces[o + r + 1], faces[o + r + 2]];
      const s0 = [start[0] - ref[0], start[1] - ref[1], start[2] - ref[2]];
      const s1 = [p[0] - ref[0], p[1] - ref[1], p[2] - ref[2]];
      const nn = norm2(nx, ny, nz);
      const proj0 =
        (s0[0] * nx + s0[1] * ny + s0[2] * nz) / Math.sqrt(norm2(...s0) * nn);
      const proj1 =
        (s1[0] * nx + s1[1] * ny + s1[2] * nz) / Math.sqrt(norm2(...s1) * nn);
      const planeTouch = Math.abs(proj1) < 1e-7;
      const planeCross = Math.sign(proj0) !== Math.sign(proj1);
      if (!planeTouch && !planeCross) continue;
      const a = [
        faces[o] - start[0],
        faces[o + 1] - start[1],
        faces[o + 2] - start[2],
      ];
      const b = [
        faces[o + 3] - start[0],
        faces[o + 4] - start[1],
        faces[o + 5] - start[2],
      ];
      const c = [
        faces[o + 6] - start[0],
        faces[o + 7] - start[1],
        faces[o + 8] - start[2],
      ];
      const area1 = tripleProduct(a, b, d);
      const area2 = tripleProduct(b, c, d);
      const area3 = tripleProduct(c, a, d);
      const boundary =
        Math.abs(area1) < 1e-12 ||
        Math.abs(area2) < 1e-12 ||
        Math.abs(area3) < 1e-12;
      const through =
        boundary ||
        (Math.sign(area1) === Math.sign(area2) &&
          Math.sign(area2) === Math.sign(area3));
      if (!through) continue;
      if (planeCross) crossings += 1;
      if (planeTouch) touch = true;
    }
    if (crossings % 2 !== 0 || touch) within[i] = 1;
  }
}

// --- the item a view draws ---------------------------------------------------

/** The field `along` a grid's axes as `fieldlines.encoded_field` sends it:
 *  16 bits a component against the peak, the inside packed a bit a point. */
function encoded(grid, along, within) {
  let peak = 0;
  for (let i = 0; i < along.length; i++)
    peak = Math.max(peak, Math.abs(along[i]));
  peak = peak || 1;
  const quanta = new Int16Array(along.length);
  for (let i = 0; i < along.length; i++)
    quanta[i] = Math.round((along[i] / peak) * 32767);
  const bits = new Uint8Array(Math.ceil(within.length / 8));
  for (let n = 0; n < within.length; n++)
    if (within[n]) bits[n >> 3] |= 1 << (n & 7);
  const base64 = (bytes) => {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  };
  return {
    origin: grid.origin,
    axes: grid.axes.flat(),
    step: grid.step,
    shape: grid.shape,
    values: base64(new Uint8Array(quanta.buffer)),
    scale: peak / 32767,
    inside: base64(bits),
  };
}

/** The ``fieldlines`` item, as `fieldlines.item` makes it: `saved`'s name
 *  and colours, the grid's field, and the seeds nearest the middle first. */
function itemOf(saved, sensor, rules, grid, along, within, seeds) {
  const centre = middle(seeds);
  // as `fieldlines.item` orders them: to a picometre, equals in order
  const away = (s) =>
    Math.round(Math.hypot(...s.map((v, k) => v - centre[k])) * 1e12);
  const order = seeds
    .map((s, i) => [away(s), i])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .slice(0, rules.max_seeds);
  const finest = isFlat(grid)
    ? (Math.max(grid.shape[0], grid.shape[1]) * grid.step) / 30
    : Infinity;
  return {
    ...saved,
    ...encoded(grid, along, within),
    seeds: order.flatMap(([, i]) =>
      seeds[i].map((v) => Math.round(v * 1e9) / 1e9),
    ),
    spacing: Math.min(sensor.apart ?? 4 * grid.step, finest),
  };
}

/** The field along a grid's axes, from the world's. */
function alongAxes(grid, world) {
  const out = new Float64Array(world.length);
  for (let i = 0; i < world.length; i += 3) {
    const v = [world[i], world[i + 1], world[i + 2]];
    for (let k = 0; k < 3; k++) out[i + k] = dot(grid.axes[k], v);
  }
  return out;
}

/** A saved item's grid, field along its axes and inside, decoded. */
function decodedItem(item) {
  const axes = [
    item.axes.slice(0, 3),
    item.axes.slice(3, 6),
    item.axes.slice(6, 9),
  ];
  const grid = {
    origin: item.origin,
    axes,
    step: item.step,
    shape: item.shape,
  };
  const raw = atob(item.values);
  const along = new Float64Array(raw.length / 2);
  for (let i = 0; i < along.length; i++) {
    const quantum = raw.charCodeAt(2 * i) | (raw.charCodeAt(2 * i + 1) << 8);
    along[i] = ((quantum << 16) >> 16) * item.scale;
  }
  const bits = atob(item.inside);
  const within = new Uint8Array(along.length / 3);
  for (let n = 0; n < within.length; n++) {
    within[n] = (bits.charCodeAt(n >> 3) >> (n & 7)) & 1;
  }
  return { grid, along, within };
}

// --- a dragged sensor's pixels ----------------------------------------------

/** A ``pixels`` item (`threejs._pixels_payload`) of a sensor moved to
 *  `pose`: its pixels carried there (`carry`, turned by `turned`), each
 *  turned along the field it now reads -- the sensor's components of it,
 *  as `fieldlines.readings` reads them -- and coloured by its |field| from
 *  the sensor's colour table, as the view colours a cut of it
 *  (`tableColour` in scene3d.mjs). Sizes stay: a page drags only sensors
 *  whose pixels are one size whatever they read (`_redrawn_in_page`). */
function pixelsAt(item, sensor, pose, carry, turned, sources, tolerance) {
  const n = item.origins.length / 3;
  const origins = new Array(3 * n);
  for (let i = 0; i < n; i++) {
    const p = carry(item.origins.slice(3 * i, 3 * i + 3));
    origins[3 * i] = p[0];
    origins[3 * i + 1] = p[1];
    origins[3 * i + 2] = p[2];
  }
  const world = fieldAt(
    sources,
    Float64Array.from(origins),
    sensor.kind,
    tolerance,
  );
  const kept = [0, 1, 2].map((k) => sensor.components.includes("xyz"[k]));
  const norms = new Array(n);
  const vectors = new Array(3 * n);
  for (let i = 0; i < n; i++) {
    let v = [world[3 * i], world[3 * i + 1], world[3 * i + 2]];
    if (!kept.every(Boolean)) {
      const own = turn(pose.orientation, v, true).map((c, k) =>
        kept[k] ? c : 0,
      );
      v = turn(pose.orientation, own);
    }
    const size = Math.hypot(v[0], v[1], v[2]);
    norms[i] = size;
    for (let k = 0; k < 3; k++) vectors[3 * i + k] = size > 0 ? v[k] / size : 0;
  }
  const moved = { ...item, origins };
  if (item.turn) moved.turn = product(turned, item.turn);
  if (item.glyph?.anchor)
    moved.glyph = { ...item.glyph, anchor: carry(item.glyph.anchor) };
  if (item.vectors) moved.vectors = vectors;
  if (item.scale) {
    const { lut, levels } = item.scale;
    const [low, high] = levels;
    const own = (i) =>
      Array.isArray(item.colors) ? item.colors[i] : item.colors;
    moved.norms = norms;
    moved.colors = norms.map((norm, i) => {
      if (!(norm > 0)) return own(i);
      const t = high > low ? (norm - low) / (high - low) : 0.5;
      return lut[Math.round(Math.min(Math.max(t, 0), 1) * (lut.length - 1))];
    });
  }
  return moved;
}

// --- the editor --------------------------------------------------------------

/** The version of material-response's kernel API this page is written
 *  against (`api_version()` in its `wasm.rs`): kernels of another are not
 *  used, and the page's lines stay as they were saved. */
export const KERNELS_API = 1;

/** What a page drags its sensors with, for the view (`widget.mjs`), as a
 *  python session's editor answers it: `begin`, `preview`, `commit`,
 *  `cancel`, `scene`, `undo`, `redo` -- and `movable`, which sensors of the
 *  scene shown it can move, alone and with no path. `kernels` are what the
 *  page carries: the glue module's text and the WebAssembly, in base64. */
export async function pageEditor(model, { glue, wasm }) {
  const url = URL.createObjectURL(
    new Blob([glue], { type: "text/javascript" }),
  );
  const kernels = await import(url);
  const bytes = Uint8Array.from(atob(wasm), (c) => c.charCodeAt(0));
  await kernels.default({ module_or_path: bytes });
  if (kernels.api_version?.() !== KERNELS_API) {
    throw new Error(
      `the field kernels speak API ${kernels.api_version?.()}, the page ${KERNELS_API}`,
    );
  }

  const readied = new WeakMap(); // page_field -> its sources made ready
  const rests = new WeakMap(); // payload -> { key: { grid, along, within, seeds } }
  const ready = (field) => {
    if (!readied.has(field)) readied.set(field, prepared(kernels, field));
    return readied.get(field);
  };
  const undone = [];
  const redone = [];
  let gesture = null; // { before, key, held }
  // A scene the page did not draw itself -- a variant clicked -- is not one
  // its drags can be taken back into.
  let mine = null;
  model.on("change:payload", (payload) => {
    if (payload === mine) return;
    undone.length = 0;
    redone.length = 0;
  });
  /** Draw `payload`, the page's own. */
  const show = (payload) => {
    mine = payload;
    model.set("payload", payload);
  };

  /** The sensor the edits move, and the pose they put it at. */
  function posed(payload, edits) {
    const field = payload?.page_field;
    const edit = edits.length === 1 ? edits[0] : null;
    const sensor = edit && field?.sensors?.[edit.objectId];
    if (!sensor || edit.shape || edit.polarization) return null;
    const pose = {
      position: edit.position ?? sensor.position,
      orientation: edit.orientation
        ? quaternionOf(edit.orientation)
        : sensor.orientation,
    };
    return { key: edit.objectId, sensor, pose, field };
  }

  /** The grid, field and inside at rest of sensor `key` in `payload`: the
   *  page's own once it has drawn them, else the payload's item. */
  function restOf(payload, key, sensor) {
    let kept = rests.get(payload);
    if (!kept) rests.set(payload, (kept = {}));
    if (!kept[key]) {
      const item = (payload.fieldlines || []).find((i) => i.object_id === key);
      if (!item) return null;
      kept[key] = { ...decodedItem(item), seeds: seedsAt(sensor, sensor) };
    }
    return kept[key];
  }

  /** The field and inside on `grid`, at `tolerance`. */
  function computed(sources, grid, kind, tolerance) {
    const points = pointsOf(grid);
    return {
      grid,
      along: alongAxes(grid, fieldAt(sources, points, kind, tolerance)),
      within: insideAt(sources, points),
    };
  }

  /** A new grid round `seeds`, of about `points`, in their plane where the
   *  field keeps to it -- probed first where `probe`, as at rest -- else a
   *  box: `_field_lines`'s order. */
  function laid(sources, sensor, pose, seeds, points, tolerance, probe) {
    const { rules } = sources.field;
    const frame = frameOf(sensor, pose);
    const box = () =>
      computed(
        sources,
        gridAround(sources.centres, seeds, points, [IDENTITY, false]),
        sensor.kind,
        tolerance,
      );
    if (frame[1] && probe) {
      const looked = computed(
        sources,
        gridAround(sources.centres, seeds, rules.probe_points, frame),
        sensor.kind,
        tolerance,
      );
      if (!keepsTo(looked.along, looked.within, rules.across)) return box();
    }
    const got = computed(
      sources,
      gridAround(sources.centres, seeds, points, frame),
      sensor.kind,
      tolerance,
    );
    if (isFlat(got.grid) && !keepsTo(got.along, got.within, rules.across))
      return box();
    return got;
  }

  /** `payload` with sensor `key` moved from its pose there to `pose`, and its
   *  lines `item`: each of its drawings carried rigidly, its pose said. */
  /** `payload` with sensor `key` moved from its pose there to `pose`, and
   *  its lines `item`: each of its drawings carried rigidly, its pixels
   *  reading the field where they now are (`pixelsAt`, from `sources` at
   *  `tolerance`), its pose said. */
  function movedPayload(payload, key, sensor, pose, item, sources, tolerance) {
    const from = sensor;
    const turned = product(pose.orientation, [
      -from.orientation[0],
      -from.orientation[1],
      -from.orientation[2],
      from.orientation[3],
    ]);
    const carry = (p) => {
      const v = turn(turned, [
        p[0] - from.position[0],
        p[1] - from.position[1],
        p[2] - from.position[2],
      ]);
      return [
        v[0] + pose.position[0],
        v[1] + pose.position[1],
        v[2] + pose.position[2],
      ];
    };
    const out = { ...payload };
    for (const [name, value] of Object.entries(payload)) {
      if (!Array.isArray(value) || !value.some((i) => i?.object_id === key))
        continue;
      out[name] = value.map((i) => {
        if (i?.object_id !== key) return i;
        if (name === "fieldlines") return item;
        if (name === "pixels") {
          return pixelsAt(i, sensor, pose, carry, turned, sources, tolerance);
        }
        const moved = { ...i };
        if (Array.isArray(i.position) && typeof i.position[0] === "number") {
          const p = new Array(i.position.length);
          for (let n = 0; n < p.length; n += 3) {
            const v = carry([
              i.position[n],
              i.position[n + 1],
              i.position[n + 2],
            ]);
            p[n] = v[0];
            p[n + 1] = v[1];
            p[n + 2] = v[2];
          }
          moved.position = p;
        }
        if (i.glyph?.anchor)
          moved.glyph = { ...i.glyph, anchor: carry(i.glyph.anchor) };
        return moved;
      });
    }
    for (const name of ["anchors", "centroids"]) {
      if (payload[name]?.[key])
        out[name] = { ...payload[name], [key]: carry(payload[name][key]) };
    }
    if (payload.orientations?.[key]) {
      out.orientations = {
        ...payload.orientations,
        [key]: rotvecOf(pose.orientation),
      };
    }
    const sensors = {
      ...payload.page_field.sensors,
      [key]: { ...sensor, ...pose },
    };
    out.page_field = { ...payload.page_field, sensors };
    return out;
  }

  const savedItem = (payload, key) =>
    (payload.fieldlines || []).find((i) => i.object_id === key);

  return {
    /** Sensor `key`'s lines as drawn now: the item, as python's. */
    lines: (key) => savedItem(model.get("payload"), key),
    /** Sensor `key`'s pixels as drawn now, the ``pixels`` item. */
    pixels: (key) =>
      (model.get("payload").pixels || []).find((i) => i.object_id === key),
    /** How long each preview took to work out, in ms, the last first. */
    took: [],
    /** Whether the page can move what `selected` names in `payload`. */
    movable(selected, payload) {
      return (
        selected.length === 1 &&
        Boolean(payload?.page_field?.sensors?.[selected[0]]) &&
        Boolean(savedItem(payload, selected[0]))
      );
    },
    begin() {
      gesture = { before: model.get("payload"), held: null };
      return Promise.resolve({ ok: true });
    },
    preview(edits) {
      const started = performance.now();
      const answer = this.answer(edits);
      this.took.unshift(performance.now() - started);
      this.took.length = Math.min(this.took.length, 200);
      return Promise.resolve(answer);
    },
    /** `preview`'s answer to `edits`. */
    answer(edits) {
      const payload = gesture?.before ?? model.get("payload");
      const moved = posed(payload, edits);
      if (!moved) return { ok: false };
      const { key, sensor, pose, field } = moved;
      const sources = ready(field);
      const seeds = seedsAt(sensor, pose);
      const { rules } = field;
      // the grid the drag holds: at first the one at rest, while it serves
      let held = gesture?.held;
      if (!held) {
        const rest = restOf(payload, key, sensor);
        held = rest && holds(rest.grid, seeds, rules.held_margin) ? rest : null;
      }
      if (!held || !holds(held.grid, seeds, rules.held_margin)) {
        held = laid(
          sources,
          sensor,
          pose,
          seeds,
          rules.drag_points,
          rules.tolerance.drag,
          true,
        );
      }
      if (gesture) gesture.held = held;
      const item = itemOf(
        savedItem(payload, key),
        sensor,
        rules,
        held.grid,
        held.along,
        held.within,
        seeds,
      );
      const scene = {
        ...movedPayload(
          payload,
          key,
          sensor,
          pose,
          item,
          sources,
          rules.tolerance.drag,
        ),
        partial: [key],
      };
      return { ok: true, scene };
    },
    commit(edits) {
      const payload = gesture?.before ?? model.get("payload");
      gesture = null;
      const moved = posed(payload, edits);
      if (!moved)
        return Promise.resolve({
          ok: false,
          error: "a saved page moves its sensors only",
        });
      const { key, sensor, pose, field } = moved;
      const sources = ready(field);
      const seeds = seedsAt(sensor, pose);
      const { rules } = field;
      const rest = restOf(payload, key, sensor);
      let got;
      if (holds(rest.grid, seeds, rules.rest_margin)) {
        got = rest;
      } else {
        const slid = slide(rest.grid, rest.seeds, seeds);
        if (slid) {
          const [grid, was] = slid;
          const points = pointsOf(grid);
          const n = was.length;
          const fresh = [];
          for (let i = 0; i < n; i++) if (was[i] < 0) fresh.push(i);
          const along = new Float64Array(3 * n);
          const within = new Uint8Array(n);
          for (let i = 0; i < n; i++) {
            if (was[i] < 0) continue;
            along.set(rest.along.subarray(3 * was[i], 3 * was[i] + 3), 3 * i);
            within[i] = rest.within[was[i]];
          }
          if (fresh.length) {
            const asked = new Float64Array(3 * fresh.length);
            fresh.forEach((i, at) =>
              asked.set(points.subarray(3 * i, 3 * i + 3), 3 * at),
            );
            const world = fieldAt(
              sources,
              asked,
              sensor.kind,
              rules.tolerance.rest,
            );
            const values = alongAxes(grid, world);
            const inside = insideAt(sources, asked);
            fresh.forEach((i, at) => {
              along.set(values.subarray(3 * at, 3 * at + 3), 3 * i);
              within[i] = inside[at];
            });
          }
          got = { grid, along, within };
          if (isFlat(grid) && !keepsTo(along, within, rules.across)) {
            got = computed(
              sources,
              gridAround(sources.centres, seeds, rules.rest_points, [
                IDENTITY,
                false,
              ]),
              sensor.kind,
              rules.tolerance.rest,
            );
          }
        } else {
          got = laid(
            sources,
            sensor,
            pose,
            seeds,
            rules.rest_points,
            rules.tolerance.rest,
            true,
          );
        }
      }
      const item = itemOf(
        savedItem(payload, key),
        sensor,
        rules,
        got.grid,
        got.along,
        got.within,
        seeds,
      );
      const next = movedPayload(
        payload,
        key,
        sensor,
        pose,
        item,
        sources,
        rules.tolerance.rest,
      );
      rests.set(next, { [key]: { ...got, seeds } });
      undone.push(payload);
      redone.length = 0;
      show(next);
      return Promise.resolve({ ok: true });
    },
    cancel() {
      const before = gesture?.before;
      gesture = null;
      if (before) show(before);
      return Promise.resolve({ ok: true });
    },
    scene: () => Promise.resolve(model.get("payload")),
    undo() {
      if (!undone.length)
        return Promise.resolve({ ok: false, error: "Nothing to undo" });
      redone.push(model.get("payload"));
      show(undone.pop());
      return Promise.resolve({ ok: true });
    },
    redo() {
      if (!redone.length)
        return Promise.resolve({ ok: false, error: "Nothing to redo" });
      undone.push(model.get("payload"));
      show(redone.pop());
      return Promise.resolve({ ok: true });
    },
  };
}
