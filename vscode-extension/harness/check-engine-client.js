/**
 * A reply the client cannot read fails its request, rather than leaving it to
 * wait forever.
 *
 *   node harness/check-engine-client.js     (after tsc: it runs out/)
 *
 * The engine once wrote a field reading of NaN as bare `NaN`, which is not
 * JSON (#164): the client logged the line and dropped it, and the request it
 * answered never came back, so whatever waited on it hung. The engine writes
 * strict JSON now; this is the client's side, run against a stand-in engine
 * that answers one request with a line that does not parse, writes a stray
 * line with no id, and answers another properly.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { EngineClient, EngineError } = require("../out/engineClient.js");

// The stand-in, run as the client runs python: `<it> -m magpylib_studio`.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-client-"));
const engine = path.join(dir, "engine");
fs.writeFileSync(
  engine,
  `#!${process.execPath}
require("readline")
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const { id, method } = JSON.parse(line);
    if (method === "reads_nan") {
      process.stdout.write('{"id":' + id + ',"result":{"values":[NaN]}}\\n');
      process.stdout.write("a stray line, no reply\\n");
    } else {
      process.stdout.write(JSON.stringify({ id, result: "fine" }) + "\\n");
    }
  });
`,
);
fs.chmodSync(engine, 0o755);

async function main() {
  const client = new EngineClient(engine, dir);
  const logged = [];
  client.onStderr = (text) => logged.push(text);
  try {
    const failed = await Promise.race([
      client.request("reads_nan").then(
        () => "resolved",
        (e) => e,
      ),
      new Promise((resolve) =>
        setTimeout(() => resolve("still waiting"), 3000),
      ),
    ]);
    assert.ok(failed instanceof EngineError, `the request was ${failed}`);
    assert.strictEqual(failed.rpcError.type, "InvalidReply");
    // the stray line fails nothing, and the next request is answered
    assert.strictEqual(await client.request("fine"), "fine");
    assert.strictEqual(
      logged.filter((t) => t.startsWith("invalid JSON")).length,
      2,
    );
  } finally {
    client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("check-engine-client: an unreadable reply fails its request");
}

main().catch((e) => {
  console.error(`check-engine-client: ${e.message}`);
  process.exit(1);
});
