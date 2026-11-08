/**
 * Lint the package's view code that the extension loads from the package as
 * it is (decisions 0056 and 0057): the model of a hosted widget, and the
 * renderer the widget bundles. Part of `npm run lint`.
 *
 *   node harness/lint-package-view.mjs
 *
 * A run of its own because ESLint lints nothing outside the folder it is based
 * in, and the package sits beside this one: here the base is the repo root,
 * and `eslint.config.mjs` names these files from there. The package's other
 * modules are checked by their build.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(EXT, "..");
const FILES = ["host.mjs", "scene3d.mjs"].map((name) =>
  path.join("magpylib_studio", "static", name),
);

const eslint = new ESLint({
  cwd: REPO,
  overrideConfigFile: path.join(EXT, "eslint.config.mjs"),
});
const results = await eslint.lintFiles(FILES);
const linted = results.filter(
  (result) =>
    !result.messages.some((m) =>
      /outside of base path|ignored/i.test(m.message),
    ),
);
if (linted.length !== FILES.length) {
  console.error("lint-package-view: not every file was linted:", FILES);
  process.exit(1);
}
const formatter = await eslint.loadFormatter("stylish");
const said = await formatter.format(results);
if (said) console.log(said);
process.exit(results.some((result) => result.errorCount > 0) ? 1 : 0);
