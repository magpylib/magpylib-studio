/**
 * Empties what a fresh debug window runs in, so that it opens with nothing
 * from before: no tabs, no unsaved scenes brought back, no recovery copies,
 * nothing the studio remembered about the workspace.
 *
 *   node harness/fresh-host.js ~/.cache/magpylib-studio/fresh-host
 *   node harness/fresh-host.js ~/.cache/magpylib-studio/fresh-machine
 *
 * Every other F5 window shares VS Code's own profile, where all of that lives
 * per workspace and comes back on the next launch.
 *
 * `fresh-host` is a profile, for "Run Extension (fresh)". A few settings are
 * put back into it, so that the window is quiet rather than VS Code's first
 * run: no Welcome page, and no workspace-trust question, which the studio
 * would otherwise wait on (it does not run in an untrusted folder).
 *
 * `fresh-machine` is a machine as a new user has it, for "Run Extension (fresh
 * machine, no Python)": VS Code's first run in `profile/`, no extensions in
 * `extensions/`, and an empty `project/` folder to open. The launch takes
 * every Python, uv and pip off the PATH; `shell` stands in for the login
 * shell the studio asks for `python3`, which would otherwise read your
 * dotfiles and macOS's path_helper and find them again.
 *
 * Outside the repo and short: VS Code puts its IPC socket in the profile, and
 * a socket path longer than 103 characters fails on macOS.
 */
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
const kind = dir && path.basename(dir);
// It deletes what it is given, so it takes nothing but a folder of its names.
if (kind !== "fresh-host" && kind !== "fresh-machine") {
  console.error(
    `fresh-host: expected a folder named fresh-host or fresh-machine, got ${dir}`,
  );
  process.exit(1);
}

fs.rmSync(dir, { recursive: true, force: true });
if (kind === "fresh-host") {
  fs.mkdirSync(path.join(dir, "User"), { recursive: true });
  const settings = {
    "workbench.startupEditor": "none",
    "security.workspace.trust.enabled": false,
  };
  fs.writeFileSync(
    path.join(dir, "User", "settings.json"),
    JSON.stringify(settings, null, 2) + "\n",
  );
} else {
  for (const sub of ["profile", "extensions", "project"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  // `-lc CMD` as the studio calls it, run without a login: the PATH stays
  // the launch's. Anything else, a terminal's shell, is plain sh.
  fs.writeFileSync(
    path.join(dir, "shell"),
    '#!/bin/sh\nif [ "$1" = "-lc" ]; then exec /bin/sh -c "$2"; fi\nexec /bin/sh "$@"\n',
    { mode: 0o755 },
  );
}
console.log(`fresh-host: ${dir} is empty`);
