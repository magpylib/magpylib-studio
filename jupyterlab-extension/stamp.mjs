/**
 * Stamp the built extension with what it was built from, as
 * `tools/build-widget.sh` stamps the widget's bundle: `labextension/` is
 * committed so that the wheel needs no node, and a source changed without a
 * build would ship the old tab without a word. `tests/test_labextension.py`
 * recomputes this. Run by `npm run build`, after the build.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// What the build reads, by path from here, sorted: the same list the test takes.
const SOURCES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "src/index.ts",
];
const hash = createHash("sha256");
for (const name of SOURCES) hash.update(fs.readFileSync(path.join(HERE, name)));
const digest = hash.digest("hex");
fs.writeFileSync(
  path.join(HERE, "labextension", "sources.sha256"),
  digest + "\n",
);
console.log(`stamped labextension/ with ${digest.slice(0, 12)}`);
