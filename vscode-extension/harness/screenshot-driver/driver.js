/**
 * Sets the window up for `harness/screenshot.mjs`: the scene in its tab, the
 * studio's side bar without the Inspector, and the script tab beside it. Silent
 * unless SHOT_DIR is set, so it is harmless anywhere else. When the window is
 * ready it writes SHOT_DIR/ready, and the script takes the picture.
 */
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The window as the README shows it, one command at a time. */
const STEPS = [
  ["workbench.action.closeAuxiliaryBar"],
  ["workbench.view.extension.magpylib-studio"],
  // only for this throwaway profile: empty until something is selected, and
  // a selection draws handles and hints over the scene
  ["magpylib-studio.inspectorView.removeView"],
  ["magpylib-studio.viewScript"],
  // the scene in front, so the script tab draws no blinking cursor
  ["workbench.action.focusFirstEditorGroup"],
  ["notifications.clearAll"],
];

exports.activate = async () => {
  const dir = process.env.SHOT_DIR;
  if (!dir) {
    return;
  }
  const say = (entry) =>
    fs.appendFileSync(
      path.join(dir, "driver.log"),
      JSON.stringify(entry) + "\n",
    );
  try {
    // a new profile may open a walkthrough; it would sit in the scene's group
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await wait(1500);
    await vscode.commands.executeCommand(
      "vscode.openWith",
      vscode.Uri.file(process.env.SHOT_SCENE),
      "magpylibStudio.scene",
    );
    say({ step: "opened" });
    // the engine starts, builds the scene and the 3D view draws it
    await wait(9000);
    for (const [command, ...args] of STEPS) {
      try {
        await vscode.commands.executeCommand(command, ...args);
        say({ step: "ran", command });
      } catch (error) {
        say({ step: "failed", command, error: String(error) });
      }
      await wait(2500);
    }
    await wait(5000);
  } catch (error) {
    say({ error: String((error && error.stack) || error) });
  }
  fs.writeFileSync(path.join(dir, "ready"), "");
};
