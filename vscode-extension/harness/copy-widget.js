/**
 * The notebook widget, copied where the extension's panels can load it: the
 * studio panel and the script panel both draw it.
 *
 *   node harness/copy-widget.js
 *
 * A figure a script leaves for the panel is the notebook widget's own state,
 * and the panel draws the widget from it -- the same legend, playback, tools
 * and keys as a notebook cell. The widget is built into the python package
 * (`tools/build-widget.sh`), which the extension does not ship; a webview can
 * only load what is inside the extension. So `npm run compile` copies it in,
 * next to media/ rather than in it: ESLint reads media/, and the bundle is
 * minified three.js. `check:widget` has already said the bundle is current.
 */
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..");
const STATIC = path.join(EXT, "..", "magpylib_studio", "static");
const TARGET = path.join(EXT, "widget");

fs.mkdirSync(TARGET, { recursive: true });
for (const file of ["widget.js", "widget.css"]) {
  fs.copyFileSync(path.join(STATIC, file), path.join(TARGET, file));
}
console.log("copy-widget: the notebook widget is in widget/ for the panel.");
