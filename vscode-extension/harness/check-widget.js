/**
 * The notebook widget's bundle is the renderer that is in the tree.
 *
 *   node harness/check-widget.js
 *
 * `magpylib_studio/static/widget.js` is a build product and is committed --
 * a wheel is built by hatchling alone, and nobody installing magpylib-studio
 * should need node. What that costs is a way to go stale, and the way it goes
 * stale is not the widget's own file: it is `media/scene3d.mjs`, which the
 * panel loads directly and so shows an edit to immediately, while the widget
 * keeps whatever renderer it was last built with. Nothing would say so.
 *
 * `tools/build-widget.sh` stamps a hash of its sources into the banner --
 * and of the three.js and esbuild it built them with, since upgrading three
 * changes the panel at once and the widget not at all. This recomputes it.
 * Cheap enough to run on every compile, which is where an edit to the
 * renderer is made.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..");
const REPO = path.join(EXT, "..");

const STATIC = path.join(REPO, "magpylib_studio", "static");
const BUNDLE = path.join(STATIC, "widget.js");
// The set the build hashes, the way it takes them: every module of the
// widget's own and the renderer, by path from the repo root, sorted.
const SOURCES = [
  ...fs
    .readdirSync(STATIC)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => `magpylib_studio/static/${name}`),
  "vscode-extension/media/scene3d.mjs",
].sort();
const REBUILD =
  "Run tools/build-widget.sh (needs npm install in vscode-extension/).";

if (!fs.existsSync(BUNDLE)) {
  console.error(
    `check-widget: ${path.relative(REPO, BUNDLE)} is missing. ${REBUILD}`,
  );
  process.exit(1);
}

const banner = fs.readFileSync(BUNDLE, "utf8").slice(0, 500);
const stamped = /^\/\/ sources-sha256: ([0-9a-f]{64})$/m.exec(banner);
if (!stamped) {
  console.error(`check-widget: the bundle carries no source hash. ${REBUILD}`);
  process.exit(1);
}

// What it was built with: the three.js the panel loads, and the esbuild the
// build pins.
const THREE_PACKAGE = path.join(EXT, "node_modules", "three", "package.json");
if (!fs.existsSync(THREE_PACKAGE)) {
  console.error(
    "check-widget: three.js is not installed; run npm install in vscode-extension/.",
  );
  process.exit(1);
}
const three = JSON.parse(fs.readFileSync(THREE_PACKAGE, "utf8")).version;
const esbuild = /^ESBUILD=(\S+)$/m.exec(
  fs.readFileSync(path.join(REPO, "tools", "build-widget.sh"), "utf8"),
)?.[1];

const hash = crypto.createHash("sha256");
for (const file of SOURCES) hash.update(fs.readFileSync(path.join(REPO, file)));
hash.update(`three@${three} ${esbuild}`);
const actual = hash.digest("hex");

if (actual !== stamped[1]) {
  console.error(
    "check-widget: the notebook widget was built from different sources than " +
      `the ones in the tree (${SOURCES.join(", ")}), or with another three.js ` +
      `or esbuild than three@${three} and ${esbuild}. ` +
      REBUILD,
  );
  process.exit(1);
}

console.log("check-widget: the widget bundle matches its sources.");

// The legend's type icons are the tree's (`media/icons`), carried in the
// widget's own stylesheet as masks, since the package cannot read the
// extension's files. Generated here, and checked here, so an icon redrawn for
// the tree cannot leave the legend on the old one. `--write-icons` writes.
const ICONS = path.join(EXT, "media", "icons");
const CSS = path.join(STATIC, "widget.css");
const BEGIN =
  "/* --- the legend's type icons: generated from vscode-extension/media/icons";
const END = "/* --- end of the generated icons --- */";
const rules = fs
  .readdirSync(ICONS)
  .filter((name) => name.endsWith(".svg"))
  .sort()
  .map((name) => {
    const svg = fs
      .readFileSync(path.join(ICONS, name), "utf8")
      .replace(/\s+/g, " ")
      .replace(/> </g, "><")
      .replace(/stroke="#[0-9a-fA-F]+"/, 'stroke="black"') // a mask: alpha is all
      .trim();
    const stem = name.replace(/\.svg$/, "");
    return `.magpy-legend-swatch.icon-${stem} {\n  --magpy-icon: url("data:image/svg+xml,${encodeURIComponent(svg)}");\n}`;
  });
const block = `${BEGIN} by harness/check-widget.js --write-icons --- */\n${rules.join("\n")}\n${END}`;
const css = fs.readFileSync(CSS, "utf8");
const start = css.indexOf(BEGIN);
const end = css.indexOf(END);
const current =
  start >= 0 && end >= 0 ? css.slice(start, end + END.length) : null;
if (process.argv.includes("--write-icons")) {
  const written =
    current === null
      ? css.replace(
          "\n.magpy-legend-label {",
          `\n${block}\n\n.magpy-legend-label {`,
        )
      : css.slice(0, start) + block + css.slice(end + END.length);
  fs.writeFileSync(CSS, written);
  console.log(
    `check-widget: wrote ${rules.length} icons into ${path.relative(REPO, CSS)}.`,
  );
} else if (current !== block) {
  console.error(
    "check-widget: the legend's icons in magpylib_studio/static/widget.css " +
      "are not the tree's in media/icons. Run node harness/check-widget.js --write-icons.",
  );
  process.exit(1);
} else {
  console.log("check-widget: the legend's icons are the tree's.");
}
