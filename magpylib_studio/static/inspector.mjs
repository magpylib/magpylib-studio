/**
 * The selection's properties, as a panel any host can mount: what an object
 * is (its parameters, in the scene's units, expressions kept as written),
 * where it is (its pose), and -- where there is room -- the style tree the
 * engine's schema describes and the construction step the tree selected.
 *
 * The VS Code studio's Inspector and the notebook widget's object panel are
 * this one module (decision 0023): the sidebar mounts it
 * in a webview with its calls going through the extension host, the widget
 * floats it beside its edit column with its calls going to the session in
 * the kernel. The module knows neither. It is handed:
 *
 * - `rpc(method, params)`: the engine's answer, as a promise.
 * - `onEdited(result)`: after each write is answered, with the engine's
 *   answer -- which names a variable it made (`defined`).
 * - `compact`: the header, the parameters and the pose, and nothing else.
 *   For a panel over a 3D view: no style tree, no filter, no step editor.
 * - `empty`: what to say with nothing selected.
 *
 * And gives back `{ show(objectId), showStep(eventId), refresh(), say() }`.
 *
 * A number typed is read by the engine in the unit the field is shown in,
 * or the one typed with it (`read_values`); anything else is an expression,
 * and a bare name the scene lacks is made at the value it replaces
 * (`define`), so the units and the variables live in one place.
 */

// A number, then perhaps a unit and nothing else -- `15`, `15 mm`, `-90°`
// -- which the engine reads in the unit the field is shown in: the variables
// panel's, so the two panels and the readout agree on what is a quantity.
import { QUANTITY } from "./variables.mjs";

/** How component `i` of a field is shown, where the engine says it per
 *  component: a segment's dimension is three lengths and two angles. */
function shownAt(shown, i) {
  return Array.isArray(shown) ? shown[i] : shown;
}

/** The unit a field's label names: the one it is shown in, "mm, °" for a
 *  vector of both, or the engine's SI unit where it is shown as it is. */
function symbolOf(shown, fallback) {
  if (!shown) return fallback;
  const symbols = (Array.isArray(shown) ? shown : [shown])
    .map((s) => s && s.symbol)
    .filter(Boolean);
  return [...new Set(symbols)].join(", ") || fallback;
}

function leafPaths(props, prefix, out) {
  for (const [name, spec] of Object.entries(props)) {
    const path = prefix ? prefix + "." + name : name;
    if (spec.properties) leafPaths(spec.properties, path, out);
    else out.push([path, spec]);
  }
  return out;
}

// Which numbers of a mesh source the Inspector offers, per kind of source.
//
// `roundness` is two exponents nobody has intuition for until they have seen
// where they land, so its doc names the shapes rather than describing the
// formula: that is what makes it a knob rather than a number.
const MESH_FIELDS = {
  file: [
    {
      key: "scale",
      name: "scale",
      unit: "m per file unit",
      fallback: 1,
      doc: "0.001 for a file drawn in millimetres, which is most of them.",
    },
  ],
  superquadric: [
    {
      key: "size",
      name: "size",
      unit: "m",
      components: ["w", "d", "h"],
      fallback: [0.02, 0.02, 0.01],
      doc: "width, depth and height of the solid.",
    },
    {
      key: "roundness",
      name: "roundness",
      unit: "",
      components: ["profile", "plan"],
      fallback: [1, 1],
      doc:
        "profile rounds it seen from the side, plan seen from above. " +
        "0.05/0.05 is a block, 0.05/1 a cylinder, 1/1 a sphere, 2/2 a diamond.",
    },
    {
      key: "around",
      name: "around",
      unit: "samples",
      fallback: 48,
      doc: "How many samples around. More faces, closer to the true solid.",
    },
    {
      key: "across",
      name: "across",
      unit: "samples",
      fallback: 24,
      doc: "How many samples pole to pole.",
    },
  ],
};

const STEP_SKIP = [
  "id",
  "op",
  "target",
  "type",
  "children",
  "style",
  "hidden_style",
  "visible",
  "parent",
];

// Step fields that hold a name from a fixed set. An axis may also be
// given as a vector, which arrives as an array and gets the vector row
// instead — this is only for when it arrived as one of these.
const STEP_CHOICES = {
  axis: ["x", "y", "z"],
  // exactly the engine's _MIRROR_NORMALS keys — a test asserts that, since
  // a dropdown offering a plane the engine has never heard of is worse
  // than a text box ("zx" was in this list and produced a KeyError)
  plane: ["xy", "xz", "yz"],
};

// An event's own geometric vectors are points and directions, so their
// parts are x, y and z. A create step's parameters are not listed here:
// they are the object's, and the engine says what their parts are called
// (a dimension's depend on the shape, so it has none).
const STEP_COMPONENTS = {
  anchor: ["x", "y", "z"],
  step: ["x", "y", "z"],
  normal: ["x", "y", "z"],
  position: ["x", "y", "z"],
};

/** "7 × 7 × 3", so a table says what it is before it says what it holds. */
function shapeOf(value) {
  const dims = [];
  for (let v = value; Array.isArray(v); v = v[0]) dims.push(v.length);
  return dims.join(" × ");
}

// The dot is escaped on purpose. Unescaped it matches *any* character, so
// `/.?0+$/` ate the last significant digit along with the trailing zeros:
// 2.5 showed as "2.", 3.25 as "3.2" and 0.005 as "0.00" — and those strings
// are what a neighbouring edit committed back through asValue().
function short(value) {
  return Number(value)
    .toFixed(4)
    .replace(/\.?0+$/, "");
}

/** Document value -> what to show in the field, in the unit it is shown in:
 *  0.015 is 15 for a length shown in mm. An expression is as written. */
function asWritten(value, resolved, shown) {
  if (typeof value === "string" && value.startsWith("=")) return value.slice(1);
  return short(shown ? Number(resolved) * shown.scale : resolved);
}

/** A table's numbers as they are shown: 0.0234 m is 23.4 mm, not
 *  23.400000000000002. Expressions and names are as written. */
function scaledTable(value, scale) {
  if (Array.isArray(value)) return value.map((v) => scaledTable(v, scale));
  return typeof value === "number"
    ? Number((value * scale).toPrecision(12))
    : value;
}

/** Field text -> document value: a number if it is one, else "=expr". */
function asValue(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : "=" + trimmed;
}

/** A value written as a name rather than a number: an axis "z", a mirror
 *  plane "xy". Not everything in a step is arithmetic, and reading one of
 *  these as a number is where the NaN came from. */
function isName(value) {
  return typeof value === "string" && !value.startsWith("=");
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The unit, kept quiet next to the name it belongs to. */
function unitTag(unit) {
  return element("span", "magpy-ins-unit", unit ? "(" + unit + ")" : "");
}

export function createInspector(
  container,
  { rpc, onEdited, compact = false, empty = "Select an object." } = {},
) {
  container.classList.add("magpy-ins");
  const headerEl = element("div", "magpy-ins-header");
  const stepEl = element("div", "magpy-ins-step");
  const paramsEl = element("div", "magpy-ins-params");
  const transformEl = element("div", "magpy-ins-transform");
  // the filter sits with what it filters: the style list, which is the only
  // long one and the only one it touches
  const filterEl = element("input", "magpy-ins-filter");
  filterEl.type = "text";
  filterEl.placeholder = "Filter style properties…";
  filterEl.hidden = true;
  const propsEl = element("div", "magpy-ins-props");
  const emptyEl = element("div", "magpy-ins-empty", empty);
  const statusEl = element("div", "magpy-ins-status");
  container.append(
    headerEl,
    ...(compact ? [] : [stepEl]),
    paramsEl,
    transformEl,
    ...(compact ? [] : [filterEl, propsEl]),
    emptyEl,
    statusEl,
  );

  let objectId;
  // set to the source id when the selection is a generated copy: it can be
  // looked at, but nothing can be written to it
  let generatedFrom = null;
  let schema;
  let values = { set: {}, resolved: {} };
  let stepId = null;

  function say(what) {
    statusEl.textContent =
      what === undefined || what === null
        ? ""
        : what.message
          ? what.message
          : String(what);
  }
  /** Tell the user why what they typed was not taken. */
  const refused = (err) => say(err);

  /** A write's answer: what the engine refused, or what it made. */
  function answered(res) {
    if (res && res.ok === false) say(res.error);
    onEdited?.(res);
    return res;
  }

  /** Typed text -> document value. A number, perhaps with a unit, is read by
   *  the engine in the unit the field is shown in: `5` in a position shown in
   *  mm is 0.005, and `2 cm` says so outright. Anything else is an expression,
   *  as it always was. Rejects with the engine's reason. */
  async function readTyped(text, shown) {
    if (!shown || !QUANTITY.test(text)) return asValue(text);
    const read = await rpc("read_values", { terms: [text], unit: shown.unit });
    if (!read.ok) throw new Error(read.error);
    return read.values[0];
  }

  /** Generated copies exist only as long as the step that made them. */
  function refuseIfGenerated() {
    if (!generatedFrom) return false;
    // the pattern step is edited in the tree, which the widget has not
    say(
      "This is a generated copy. Edit " +
        generatedFrom +
        (compact ? "" : ", its pattern step,") +
        " or the variables it is written in terms of.",
    );
    return true;
  }

  async function applyEdit(path, value) {
    if (refuseIfGenerated()) return;
    say("");
    answered(await rpc("apply_edit", { object_id: objectId, path, value }));
    await reloadValues();
  }

  async function resetPath(path) {
    if (refuseIfGenerated()) return;
    say("");
    answered(await rpc("reset_style", { object_id: objectId, path }));
    await reloadValues();
  }

  function makeWidget(path, spec, value) {
    const wrap = element("div", "magpy-ins-widget");
    const types = [].concat(spec.type || []);
    const enums = (spec.enum || []).filter((v) => typeof v === "string");

    if (spec.format === "color") {
      const text = element("input");
      text.type = "text";
      text.value = value ?? "";
      text.placeholder = "default";
      text.addEventListener("change", () => {
        if (text.value) applyEdit(path, text.value);
      });
      const pick = element("input");
      pick.type = "color";
      if (/^#[0-9a-fA-F]{6}$/.test(value || "")) pick.value = value;
      pick.addEventListener("change", () => applyEdit(path, pick.value));
      wrap.append(text, pick);
    } else if (enums.length) {
      const sel = element("select");
      sel.append(new Option("(default)", ""));
      for (const opt of enums) sel.append(new Option(opt, opt));
      sel.value = typeof value === "string" ? value : "";
      sel.addEventListener("change", () => {
        if (sel.value) applyEdit(path, sel.value);
        else if (path in values.set) resetPath(path);
      });
      wrap.append(sel);
    } else if (types.includes("boolean")) {
      const sel = element("select");
      sel.append(
        new Option("(default)", ""),
        new Option("true", "true"),
        new Option("false", "false"),
      );
      sel.value = value === true ? "true" : value === false ? "false" : "";
      sel.addEventListener("change", () => {
        if (sel.value) applyEdit(path, sel.value === "true");
        else if (path in values.set) resetPath(path);
      });
      wrap.append(sel);
    } else if (types.includes("number")) {
      const num = element("input", "magpy-ins-num");
      num.type = "number";
      num.step = "any";
      if (value !== null && value !== undefined) num.value = value;
      num.addEventListener("change", () => {
        if (num.value !== "") applyEdit(path, parseFloat(num.value));
        else if (path in values.set) resetPath(path);
      });
      if (spec.minimum !== undefined && spec.maximum !== undefined) {
        const slider = element("input");
        slider.type = "range";
        slider.min = spec.minimum;
        slider.max = spec.maximum;
        slider.step = (spec.maximum - spec.minimum) / 100;
        if (value !== null && value !== undefined) slider.value = value;
        slider.addEventListener("input", () => {
          num.value = slider.value;
        });
        slider.addEventListener("change", () =>
          applyEdit(path, parseFloat(slider.value)),
        );
        wrap.append(slider);
      }
      wrap.append(num);
    } else if (types.includes("string")) {
      const text = element("input");
      text.type = "text";
      text.value = value ?? "";
      text.placeholder = "default";
      text.addEventListener("change", () => {
        if (text.value) applyEdit(path, text.value);
        else if (path in values.set) resetPath(path);
      });
      wrap.append(text);
    } else {
      return null; // free-form specs (model3d.data, path.frames): not editable here
    }
    return wrap;
  }

  // --- style section: the engine's schema as widgets ---------------------
  function render() {
    if (compact) return;
    const openGroups = new Set(
      Array.from(propsEl.querySelectorAll("details[open]")).map(
        (d) => d.dataset.group,
      ),
    );
    propsEl.innerHTML = "";
    if (!schema || !objectId) return;
    const filter = filterEl.value.trim().toLowerCase();
    for (const [group, spec] of Object.entries(schema.properties)) {
      const leaves = spec.properties
        ? leafPaths(spec.properties, group, [])
        : [[group, spec]];
      const rows = [];
      for (const [path, leafSpec] of leaves) {
        if (filter && !path.toLowerCase().includes(filter)) continue;
        const widget = makeWidget(path, leafSpec, values.resolved[path]);
        if (!widget) continue;
        const row = element(
          "div",
          "magpy-ins-row" + (path in values.set ? " magpy-ins-set" : ""),
        );
        const label = element("label");
        label.textContent = path.startsWith(group + ".")
          ? path.slice(group.length + 1)
          : path;
        label.title =
          path + (leafSpec.description ? " — " + leafSpec.description : "");
        const reset = element("button", "magpy-ins-reset", "↺");
        reset.type = "button";
        reset.title = "Reset to default";
        reset.addEventListener("click", () => resetPath(path));
        row.append(label, widget, reset);
        rows.push(row);
      }
      if (!rows.length) continue;
      const details = element("details");
      details.dataset.group = group;
      if (filter || openGroups.has(group) || !spec.properties)
        details.open = true;
      details.append(element("summary", "", group), ...rows);
      propsEl.appendChild(details);
    }
  }

  // --- step section: the selected construction step's own values --------
  //
  // Selecting a step in the Scene tree shows what it did, right above the
  // object it did it to: the property grid of a CAD history, rather than a
  // dialog you have to open and close.
  async function loadStep() {
    if (compact) return;
    stepEl.innerHTML = "";
    if (!stepId) return;
    const [listed, document_] = await Promise.all([
      rpc("get_events", {}),
      rpc("to_dict", {}),
    ]);
    const shown = listed.events.find((e) => e.id === stepId);
    const stored = (document_.events || []).find((e) => e.id === stepId);
    if (!shown || !stored) {
      stepId = null;
      return;
    }

    const box = element("details");
    box.open = true;
    const summary = element("summary", "", "step — " + shown.label);
    summary.title = shown.source;
    box.appendChild(summary);
    if (shown.error) {
      box.appendChild(
        element("div", "magpy-ins-hint magpy-ins-warning", shown.error),
      );
    }

    // a create step carries the object's constructor parameters; every
    // other kind carries its own arguments
    const isCreate = shown.op === "create";
    const stepValues = isCreate ? stored.params || {} : stored;
    // For a create step the fields are the object's own parameters, so the
    // engine already says what each one's parts are called and what unit it
    // is in — read that rather than keeping a second copy of the table here.
    const described = {};
    if (isCreate) {
      for (const p of await rpc("get_params", { object_id: shown.target })) {
        described[p.name] = p;
      }
    }
    const commit = (name, value) => {
      say("");
      const changes = isCreate
        ? { params: Object.assign({}, stepValues, { [name]: value }) }
        : { [name]: value };
      rpc("edit_event", { event_id: stepId, changes })
        .then((res) => {
          answered(res);
          if (res && res.ok !== false && res.broken && res.broken.length) {
            say(
              res.broken.length +
                " later step(s) no longer apply — undo to put them back",
            );
          }
          return reloadAll();
        })
        .catch(refused);
    };

    // how each value is shown and typed: a create step's as its object's
    // parameter, any other step's as the engine says for its arguments
    const unitOf = (name) =>
      isCreate
        ? described[name] && described[name].shown
        : (shown.shown || {})[name];
    for (const name of Object.keys(stepValues)) {
      if (STEP_SKIP.includes(name)) continue;
      const value = stepValues[name];
      const row = element("div", "magpy-ins-row");
      const label = element("label");
      label.append(document.createTextNode(name + " "));
      label.appendChild(
        unitTag(
          symbolOf(unitOf(name), described[name] && described[name].unit),
        ),
      );
      if (described[name]) label.title = described[name].doc;
      const wrap = element("div", "magpy-ins-widget");
      if (Array.isArray(value) && !Array.isArray(value[0])) {
        wrap.style.display = "block";
        const resolved = value.map((v) => (typeof v === "string" ? 0 : v));
        const parts =
          (described[name] && described[name].components) ||
          STEP_COMPONENTS[name] ||
          value.map((_, i) => String(i + 1));
        wrap.appendChild(
          vecRow(
            parts,
            resolved,
            (v) => commit(name, v),
            undefined,
            value,
            unitOf(name),
          ),
        );
      } else if (STEP_CHOICES[name] && STEP_CHOICES[name].includes(value)) {
        // a field whose values are named and countable: pick, don't type
        const sel = element("select");
        for (const option of STEP_CHOICES[name])
          sel.append(new Option(option, option));
        sel.value = value;
        sel.addEventListener("change", () => commit(name, sel.value));
        wrap.appendChild(sel);
      } else if (typeof value === "number" || typeof value === "string") {
        // A create step's fields are the object's own parameters, so the engine
        // reports what they currently come to; every other kind of step has no
        // resolved value to show, and numberInput says so rather than inventing
        // one.
        const described_ = described[name];
        const resolved =
          described_ && typeof described_.value === "number"
            ? described_.value
            : value;
        wrap.appendChild(
          numberInput(value, resolved, (v) => commit(name, v), unitOf(name)),
        );
      } else {
        wrap.appendChild(
          element("span", "magpy-ins-hint", JSON.stringify(value)),
        );
      }
      row.append(label, wrap, element("span"));
      box.appendChild(row);
    }
    stepEl.appendChild(box);
  }

  // --- properties section: the object's physics parameters --------------
  async function loadParams() {
    const params = await rpc("get_params", { object_id: objectId });
    paramsEl.innerHTML = "";
    if (!params.length) return;
    const box = element("details");
    box.open = true;
    box.appendChild(element("summary", "", "properties"));

    for (const p of params) {
      const commit = (value) => {
        if (refuseIfGenerated()) return;
        say("");
        // a bare name the scene lacks is made at the value it replaces
        rpc("set_param", {
          object_id: objectId,
          name: p.name,
          value,
          define: true,
        })
          .then((res) => {
            answered(res);
            return Promise.all([loadParams(), loadTransform()]);
          })
          .catch(refused);
      };
      if (p.kind === "scalar") {
        const row = element("div", "magpy-ins-row");
        const label = element("label");
        label.append(document.createTextNode(p.name + " "));
        label.appendChild(unitTag(symbolOf(p.shown, p.unit)));
        label.title = p.doc;
        const input = numberInput(
          p.written === undefined ? p.value : p.written,
          p.value,
          commit,
          p.shown,
        );
        const wrap = element("div", "magpy-ins-widget");
        wrap.appendChild(input);
        row.append(label, wrap, element("span"));
        box.appendChild(row);
      } else if (p.kind === "vector") {
        // one row like every other property, so the labels line up
        const row = element("div", "magpy-ins-row");
        const label = element("label");
        label.append(document.createTextNode(p.name + " "));
        label.appendChild(unitTag(symbolOf(p.shown, p.unit)));
        label.title = p.doc;
        const wrap = element("div", "magpy-ins-widget");
        wrap.style.display = "block";
        wrap.appendChild(
          vecRow(
            p.components || p.value.map((_, i) => String(i + 1)),
            p.value,
            commit,
            undefined,
            p.written,
            p.shown,
          ),
        );
        row.append(label, wrap, element("span"));
        box.appendChild(row);
      } else if (p.kind === "sampled") {
        // A run of points stated as the curve that draws them. The points are
        // what it comes to, not what it is: handing them to the table editor
        // below would let one stray edit replace a helix with the sixty points
        // it happened to draw, and the variables it followed with nothing. So
        // the formula is what you see, and it is edited where it is written.
        const spec = p.written.sampled;
        const shown = element("details", "magpy-ins-matrix");
        const summary = element(
          "summary",
          "",
          p.name +
            " — " +
            shapeOf(p.value) +
            ", sampled" +
            (p.unit ? " (" + p.unit + ")" : ""),
        );
        summary.title = p.doc;
        const area = element("textarea");
        area.readOnly = true;
        area.spellcheck = false;
        const terms = Array.isArray(spec.of) ? spec.of : [spec.of];
        area.value = terms
          .map((term) => String(term).replace(/^=/, ""))
          .concat(
            "for t in " +
              JSON.stringify(spec.over || [0, 1]) +
              ", " +
              String(spec.count).replace(/^=/, "") +
              " points",
          )
          .join("\n");
        area.rows = Math.min(8, terms.length + 2);
        shown.append(
          summary,
          area,
          element(
            "div",
            "magpy-ins-hint",
            "Drag the variables it is written in terms of, or edit it " +
              (compact ? "in the code." : "in the script tab."),
          ),
        );
        box.appendChild(shown);
      } else if (p.kind === "mesh") {
        // Where the mesh comes from, not the mesh. The same reason as the
        // sampled case above: the vertices are what the source came out as,
        // and handing forty thousand of them to the table editor would offer
        // an edit nobody wants over numbers the document does not even keep.
        const spec = p.value || {};
        const status = p.status || {};
        const shown = element("details", "magpy-ins-matrix");
        shown.open = true;
        const summary = element(
          "summary",
          "",
          "mesh — " + (status.source || spec.path || "source"),
        );
        summary.title = p.doc;
        shown.appendChild(summary);

        const said = (text, className) =>
          shown.appendChild(
            element("div", className || "magpy-ins-hint", text),
          );
        if (status.faces) {
          said(status.faces + " faces · " + status.vertices + " vertices");
        }
        const fault = status.open
          ? status.open_edges
            ? "open at " + status.open_edges + " edges"
            : "open"
          : status.disconnected
            ? status.parts
              ? "in " + status.parts + " separate parts"
              : "disconnected"
            : status.selfintersecting
              ? "self-intersecting"
              : "";
        if (fault) {
          // Said in the panel that shows the numbers this mesh produces,
          // because that is where believing them happens.
          said(
            "This mesh is " +
              fault +
              ". magpylib computes a field for it, and that field is not to " +
              "be trusted: the inside-outside test it rests on needs a closed " +
              "body.",
            "magpy-ins-hint magpy-ins-warning",
          );
        }
        if (status.flipped) {
          said(
            status.flipped +
              " faces were turned around on import to point outward.",
          );
        }
        if (status.changed) {
          said("The file has changed since this scene was saved.");
        }
        // What of the source is worth editing in place, per kind. A hull's
        // points are not here: a table of corners is what the script tab is
        // for, and this panel is for the handful of numbers that are really
        // knobs. Everything below writes the whole source back, because it is
        // one value in the document however many fields it shows.
        const fields = MESH_FIELDS[spec.from] || [];
        for (const f of fields) {
          const row = element("div", "magpy-ins-row");
          const label = element("label");
          label.append(document.createTextNode(f.name + " "));
          label.appendChild(unitTag(f.unit));
          label.title = f.doc;
          const wrap = element("div", "magpy-ins-widget");
          const current = spec[f.key] === undefined ? f.fallback : spec[f.key];
          if (f.components) {
            wrap.style.display = "block";
            wrap.appendChild(
              vecRow(f.components, current, (value) =>
                commit(Object.assign({}, spec, { [f.key]: value })),
              ),
            );
          } else {
            wrap.appendChild(
              numberInput(current, current, (value) =>
                commit(Object.assign({}, spec, { [f.key]: value })),
              ),
            );
          }
          row.append(label, wrap, element("span"));
          shown.appendChild(row);
        }
        box.appendChild(shown);
      } else {
        // Tables (vertices, faces, sensor pixels). A 12x12 pixel grid on
        // one line of JSON is not an editor, it is a wall — so the shape is
        // what you see, and the numbers are there when you want them.
        const table = element("details", "magpy-ins-matrix");
        const shape = element("summary");
        const symbol = symbolOf(p.shown, p.unit);
        shape.textContent =
          p.name +
          " — " +
          shapeOf(p.value) +
          (symbol ? " (" + symbol + ")" : "");
        shape.title = p.doc;
        const area = element("textarea");
        area.rows = Math.min(8, p.value.length + 1);
        area.spellcheck = false;
        // one row of numbers per line, in the unit the table is shown in
        const scale = p.shown && !Array.isArray(p.shown) ? p.shown.scale : 1;
        area.value = p.value
          .map((r) => JSON.stringify(scale === 1 ? r : scaledTable(r, scale)))
          .join(",\n");
        area.addEventListener("change", async () => {
          try {
            const typed = JSON.parse("[" + area.value + "]");
            commit(scale === 1 ? typed : await tableInDocument(typed, p.shown));
          } catch (err) {
            say(p.name + ": " + (err.message || err));
          }
        });
        table.append(shape, area);
        box.appendChild(table);
      }
    }
    paramsEl.appendChild(box);
  }

  /** A table typed in the unit it is shown in, back in the document's: every
   *  number read by the engine in one call, so 23.4 mm is 0.0234 exactly. */
  async function tableInDocument(typed, shown) {
    const numbers = [];
    const collect = (v) =>
      Array.isArray(v)
        ? v.forEach(collect)
        : typeof v === "number" && numbers.push(String(v));
    collect(typed);
    const read = await rpc("read_values", { terms: numbers, unit: shown.unit });
    if (!read.ok) throw new Error(read.error);
    let next = 0;
    const rebuild = (v) =>
      Array.isArray(v)
        ? v.map(rebuild)
        : typeof v === "number"
          ? read.values[next++]
          : v;
    return rebuild(typed);
  }

  // --- numbers that may be written as expressions -----------------------
  //
  // A field holds either a number or an expression over the document's
  // variables, so the widgets are text inputs, not number inputs: a number
  // input cannot hold "gap*2" at all. What the user types goes back as
  // typed; only a value that parses as a number is sent as one.
  function numberInput(value, resolved, onCommit, shown) {
    const input = element("input");
    input.type = "text";
    input.spellcheck = false;
    if (isName(value)) {
      // shown and committed verbatim: turning "z" into "=z" would make it
      // an expression over a variable of that name, which is a different
      // thing entirely
      input.value = value;
      input.addEventListener("change", () => onCommit(input.value.trim()));
      return input;
    }
    input.value = asWritten(value, resolved, shown);
    // What makes it an expression is the leading '=', not a mismatch with the
    // resolved value: a step's own fields have no resolved value to compare
    // against, and comparing against one anyway is what produced "currently
    // NaN" on every expression in a pattern step.
    if (typeof value === "string" && value.startsWith("=")) {
      input.classList.add("magpy-ins-expr");
      const current = Number(resolved);
      input.title = Number.isFinite(current)
        ? "expression — currently " +
          short(shown ? current * shown.scale : current) +
          (shown && shown.symbol ? " " + shown.symbol : "")
        : "expression";
    }
    // `5`, `5 mm` or `gap*2`, read in the unit the field is shown in
    input.addEventListener("change", () =>
      readTyped(input.value, shown).then(onCommit, refused),
    );
    return input;
  }

  // --- transform section: the absolute pose ------------------------------
  function vecRow(labels, vector, onCommit, readonly, written, shown) {
    const row = element(
      "div",
      "magpy-ins-vec" + (readonly ? " magpy-ins-readonly" : ""),
    );
    const inputs = [];
    // A component is sent as its document value unless the user typed in it.
    // Editing x has to send y and z too — the engine takes the whole vector —
    // and reading those back off the screen rounds them to what the field can
    // show: a position of 795774.715564545 came back as 795774.7156, and every
    // fifth decimal in the scene went that way one sibling edit at a time.
    const originals = [];
    const texts = [];
    const commitAll = () =>
      Promise.all(
        inputs.map((el, i) =>
          el.value === texts[i]
            ? originals[i]
            : readTyped(el.value, shownAt(shown, i)),
        ),
      ).then(onCommit, refused);
    labels.forEach((name, i) => {
      const tag = element("span", "", name);
      const original =
        written && written[i] !== undefined ? written[i] : vector[i];
      const input = numberInput(
        original,
        vector[i],
        commitAll,
        shownAt(shown, i),
      );
      originals.push(original);
      texts.push(input.value);
      if (readonly) {
        input.readOnly = true;
        input.tabIndex = -1;
        input.title = readonly;
      }
      inputs.push(input);
      row.append(tag, input);
    });
    return row;
  }

  function transformOp(method, params) {
    if (refuseIfGenerated()) return Promise.resolve();
    say("");
    // a bare name the scene lacks is made at the value it replaces
    return rpc(
      method,
      Object.assign({ object_id: objectId, define: true }, params),
    )
      .then((res) => {
        answered(res);
        return loadTransform();
      })
      .catch(refused);
  }

  async function loadTransform() {
    const t = await rpc("get_transform", { object_id: objectId });
    transformEl.innerHTML = "";
    const box = element("details");
    box.open = true;
    const units = t.shown || {};
    const said = [units.position, units.orientation]
      .map((s) => s && s.symbol)
      .filter(Boolean);
    // the units in a span of their own, so a heading set in capitals leaves
    // their case alone: mm is not MM
    const title = element("summary", "", "pose");
    if (said.length)
      title.appendChild(
        element("span", "magpy-ins-unit", " (" + said.join(", ") + ")"),
      );
    box.appendChild(title);

    // With a path there is no single pose to edit: the fields show the
    // last step read-only, and Transform… does the editing instead.
    const pathed =
      t.path_length > 1
        ? "read-only while this object has a path (" +
          t.path_length +
          " steps)" +
          (compact ? "" : " — use Transform… on the object in the Scene view")
        : "";
    if (pathed) {
      box.appendChild(
        element(
          "div",
          "magpy-ins-hint",
          "path: " + t.path_length + " steps (showing the last)",
        ),
      );
    }
    box.appendChild(
      vecRow(
        ["x", "y", "z"],
        t.position,
        (v) => transformOp("set_transform", { position: v }),
        pathed,
        t.written_position,
        units.position,
      ),
    );
    box.appendChild(
      vecRow(
        ["rx", "ry", "rz"],
        t.orientation,
        (v) => transformOp("set_transform", { orientation: v }),
        pathed,
        t.written_orientation,
        units.orientation,
      ),
    );
    if (!compact) {
      // Relative moves and rotations are not shown here: they record a
      // step, and this panel says what the object *is*. They live where the
      // other actions live, on the object in the Scene view.
      box.appendChild(
        element(
          "div",
          "magpy-ins-hint",
          "to move or rotate by an amount, use Transform… on " +
            "the object in the Scene view — those record a step",
        ),
      );
    }
    transformEl.appendChild(box);
  }

  async function reloadValues() {
    if (!compact) {
      values = await rpc("get_values", { object_id: objectId });
      render();
    }
    await Promise.all([loadParams(), loadTransform()]);
  }

  async function loadObject(id) {
    objectId = id;
    emptyEl.style.display = id ? "none" : "";
    say("");
    filterEl.hidden = compact || !id;
    if (!id) {
      headerEl.textContent = "";
      propsEl.innerHTML = "";
      transformEl.innerHTML = "";
      paramsEl.innerHTML = "";
      stepEl.innerHTML = "";
      return;
    }
    const listed = (await rpc("list_objects", {})).find((o) => o.id === id);
    generatedFrom = (listed && listed.derived) || null;
    headerEl.innerHTML = "";
    // An object with no label of its own is listed under its type, which
    // would then be said twice: the name is the id then, and the type alone
    // is what it is.
    const label =
      listed && listed.label && listed.label !== listed.type
        ? listed.label
        : id;
    const what = !listed
      ? ""
      : label === id
        ? listed.type
        : listed.type + "  ·  " + id;
    headerEl.appendChild(element("div", "magpy-ins-name", label));
    if (what) headerEl.appendChild(element("div", "magpy-ins-what", what));
    if (generatedFrom) {
      headerEl.appendChild(
        element(
          "div",
          "magpy-ins-generated",
          "generated from " +
            generatedFrom +
            (compact
              ? " — change that object or the variables"
              : " — change that object, its pattern step, or the variables"),
        ),
      );
    }
    if (!compact) {
      [schema, values] = await Promise.all([
        rpc("get_schema", { object_id: id }),
        rpc("get_values", { object_id: id }),
      ]);
      render();
    }
    await Promise.all([loadParams(), loadTransform()]);
  }

  /** The step form and the object's own sections, both back from source. */
  async function reloadAll() {
    await loadStep();
    if (objectId) await reloadValues();
  }

  filterEl.addEventListener("input", render);

  return {
    /** The object whose properties to show; none clears the panel. Picking
     *  an object directly is not picking a step: the step form clears. */
    show(id) {
      stepId = null;
      return loadObject(id).catch(say);
    },
    /** One construction step's own values above the object it acted on. */
    showStep(eventId) {
      stepId = eventId;
      return loadStep().catch(say);
    },
    /** Everything back from source: after an edit made elsewhere. */
    refresh: () => reloadAll().catch(say),
    say,
  };
}
