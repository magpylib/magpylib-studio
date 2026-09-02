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
 * `tools/build-widget.sh` stamps a hash of its sources into the banner. This
 * recomputes it. Cheap enough to run on every compile, which is where an edit
 * to the renderer is made.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..");
const REPO = path.join(EXT, "..");

const BUNDLE = path.join(REPO, "magpylib_studio", "static", "widget.js");
const SOURCES = [
  path.join(REPO, "magpylib_studio", "static", "widget.mjs"),
  path.join(EXT, "media", "scene3d.mjs"),
];
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

const hash = crypto.createHash("sha256");
for (const file of SOURCES) hash.update(fs.readFileSync(file));
const actual = hash.digest("hex");

if (actual !== stamped[1]) {
  console.error(
    "check-widget: the notebook widget was built from different sources than " +
      `the ones in the tree (${SOURCES.map((f) => path.relative(REPO, f)).join(", ")}). ` +
      REBUILD,
  );
  process.exit(1);
}

console.log("check-widget: the widget bundle matches its sources.");
