/**
 * Every message a panel sends is answered, and every answer is sent for.
 *
 *   node harness/check-messages.js
 *
 * A webview and its host talk in untyped objects with a `type` field, across a
 * boundary neither tsc nor ESLint can see across. Rename one end and nothing
 * complains: the message is posted into a void, or the handler waits for a
 * message nobody sends, and the feature quietly stops working while everything
 * still compiles.
 *
 * One of those shipped: the panel sent `transformObject` and the host listened
 * for `transformObjects`, so the pose a drag *ended* on was never recorded,
 * the undo group it opened was never closed, and a scene dragged and then
 * closed offered to save nothing. One word, in a string, in a file that
 * compiles, found by reading. This is the cheapest thing that catches it.
 *
 * What it does not check, and what it therefore did not catch, is a mismatch
 * inside a message rather than in its name: the same round of work had the
 * view sending a `objectIds` field the panel read as `objectId`. Checking
 * that means knowing the shape of every payload, which is a type system, and
 * this is a grep. Names are what rot fastest; these are the names.
 *
 * Nor which *handler* answers: the panels share a host, so a type read by the
 * wrong provider still passes here.
 */
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..");

/** The `type:` of every `postMessage` argument — both arms of a ternary
 *  included, since that is how the panel picks between hiding and isolating.
 *
 *  Only inside the call: a `type` field is also how an object says it is a
 *  Collection, and those are not messages. */
function sent(source) {
  const found = new Set();
  // Anything that posts, not `postMessage` alone: the field panel is written
  // to through a helper that knows which panel it is.
  for (const call of source.matchAll(/\bpost[A-Za-z]*\(/g)) {
    let depth = 0;
    let to = call.index + call[0].length - 1;
    do {
      if (source[to] === "(") depth++;
      else if (source[to] === ")") depth--;
      to++;
    } while (depth > 0 && to < source.length);
    for (const [, expression] of source
      .slice(call.index, to)
      .matchAll(/\btype:\s*([^,}\n]+)/g)) {
      for (const [, , literal] of expression.matchAll(/(['"])([\w]+)\1/g)) {
        found.add(literal);
      }
    }
  }
  return found;
}

/** What a `message.type` is compared against. Scoped to message-ish names, so
 *  that an object's own `.type` — a Collection, a magnet — is not mistaken for
 *  one of these. */
function handled(source) {
  const found = new Set();
  const test =
    /\b(?:message|msg|event\.data|data)\.type\s*[!=]==\s*(['"])([\w]+)\1/g;
  for (const [, , literal] of source.matchAll(test)) {
    found.add(literal);
  }
  return found;
}

function read(dir, endings) {
  return fs
    .readdirSync(path.join(EXT, dir))
    .filter((name) => endings.some((end) => name.endsWith(end)))
    .filter((name) => !name.endsWith(".test.ts"))
    .map((name) => ({
      name: `${dir}/${name}`,
      source: fs.readFileSync(path.join(EXT, dir, name), "utf8"),
    }));
}

let failures = 0;
function check(side, senders, receivers) {
  const answered = new Set();
  for (const file of receivers) {
    for (const type of handled(file.source)) answered.add(type);
  }
  const asked = new Map();
  for (const file of senders) {
    for (const type of sent(file.source)) {
      if (!asked.has(type)) asked.set(type, file.name);
    }
  }
  for (const [type, from] of asked) {
    if (!answered.has(type)) {
      console.log(`FAIL  ${from} sends "${type}", which nothing ${side} reads`);
      failures++;
    }
  }
  for (const type of answered) {
    if (!asked.has(type)) {
      console.log(
        `FAIL  something ${side} reads "${type}", which nothing sends`,
      );
      failures++;
    }
  }
  console.log(
    `ok    ${asked.size} message types ${side === "in src/" ? "to" : "from"} the host, all matched`,
  );
}

const panels = read("media", [".js", ".mjs"]);
const host = read("src", [".ts"]);
check("in src/", panels, host);
check("in media/", host, panels);
process.exit(failures ? 1 : 0);
