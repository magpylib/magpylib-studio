import * as vscode from 'vscode';

/** Set while a box that takes typing has the focus inside one of the studio's
 *  webviews, which VS Code cannot see: its `inputFocus` stays false there.
 *  The studio's undo and redo keys stand aside while it holds, so Cmd/Ctrl+Z
 *  undoes the typing rather than the scene (media/textFocus.mjs). */
export const TEXT_FOCUS = 'magpylib-studio.textFocus';

let current = false;

export function setTextFocus(focused: boolean): void {
  if (focused === current) {
    return;
  }
  current = focused;
  void vscode.commands.executeCommand('setContext', TEXT_FOCUS, focused);
}

/** Take a webview's `textFocus` message; false for any other message. */
export function tookTextFocus(message: { type?: unknown; focused?: unknown }): boolean {
  if (message.type !== 'textFocus') {
    return false;
  }
  setTextFocus(message.focused === true);
  return true;
}
