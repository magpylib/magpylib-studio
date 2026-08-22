/**
 * The interpreter the checks run the engine with.
 *
 * A working copy keeps it in `../.venv`, and the checks that need a scene
 * looked there and nowhere else. CI has no venv — it does `pip install -e .`
 * into the runner's own Python — so those checks skipped there and reported
 * success without having run, which is the worst way for a check to pass:
 * the one place they were meant to guard was the one place they were silent.
 *
 * Asking each candidate whether it can import the engine, rather than trusting
 * where it sits, is what makes the same check work in both places. Set
 * MAGPYLIB_STUDIO_PYTHON to name one outright.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");

/** A python that can `import magpylib_studio`, or null if none here can. */
function enginePython() {
  const venv = path.join(REPO, ".venv", "bin", "python");
  const named = process.env.MAGPYLIB_STUDIO_PYTHON;
  const candidates = named ? [named] : [venv, "python3", "python"];
  for (const python of candidates) {
    // The venv path is the only candidate that is a path: skip it when it is
    // not there rather than spawning something that cannot exist.
    if (python === venv && !fs.existsSync(venv)) {
      continue;
    }
    try {
      execFileSync(python, ["-c", "import magpylib_studio"], {
        stdio: "ignore",
      });
      return python;
    } catch {
      // not this one: absent, or present without the engine installed in it
    }
  }
  return null;
}

module.exports = { enginePython };
