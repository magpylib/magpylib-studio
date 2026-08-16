/**
 * Two guards on the webview code, run as part of `npm run compile`.
 *
 *   node harness/check-webview-scripts.js
 *
 * 1. Every media script parses. They are loaded by URL, so a syntax error is
 *    reported nowhere the extension host can see it: the panel simply renders
 *    as the static HTML it starts as, blank and silent. That cost a day once.
 *    `.mjs` files are modules -- vm.Script would reject their imports as
 *    syntax errors -- so those go through `node --check`, which parses a
 *    `.mjs` path as a module.
 *
 * 2. No src/*.ts has grown a webview script back inside a template literal.
 *    That is where the escaping hazard lives — `\n` written singly is resolved
 *    by TypeScript into a real line break inside a quoted string — and where
 *    neither tsc nor eslint can see the code at all.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..");
let failures = 0;

for (const file of fs
  .readdirSync(path.join(EXT, "media"))
  .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))) {
  const full = path.join(EXT, "media", file);
  const source = fs.readFileSync(full, "utf8");
  try {
    if (file.endsWith(".mjs")) {
      execFileSync(process.execPath, ["--check", full], { stdio: "pipe" });
    } else {
      new vm.Script(source, { filename: file });
    }
    console.log(`ok    media/${file} (${source.split("\n").length} lines)`);
  } catch (err) {
    failures += 1;
    const detail = err.stderr
      ? String(err.stderr).trim().split("\n")[0]
      : err.message;
    console.log(`FAIL  media/${file}: ${detail}`);
  }
}

// A <script> with a body, as opposed to one that names a file to load.
const INLINE = /<script(?:\s+nonce="\$\{nonce\}")?>\s*\n[\s\S]*?<\/script>/;
for (const file of fs
  .readdirSync(path.join(EXT, "src"))
  .filter((f) => f.endsWith(".ts"))) {
  const source = fs.readFileSync(path.join(EXT, "src", file), "utf8");
  if (INLINE.test(source)) {
    failures += 1;
    console.log(
      `FAIL  src/${file} embeds a webview script. Put it in media/ and load ` +
        `it with mediaUri(): inside a template literal nothing checks it.`,
    );
  }
}

process.exit(failures ? 1 : 0);
