import * as vscode from 'vscode';

/** Set while a box that takes typing has the focus inside one of the studio's
 *  webviews, which VS Code cannot see: its `inputFocus` stays false there.
 *  The studio's undo and redo keys stand aside while it holds, so Cmd/Ctrl+Z
 *  undoes the typing rather than the scene (media/textFocus.mjs). */
export const TEXT_FOCUS = 'magpylib-studio.textFocus';

let current = false;
/** The webview whose box has the focus, while one has. */
let holder: vscode.Webview | undefined;

export function setTextFocus(focused: boolean, webview?: vscode.Webview): void {
  holder = focused ? webview : undefined;
  if (focused === current) {
    return;
  }
  current = focused;
  void vscode.commands.executeCommand('setContext', TEXT_FOCUS, focused);
}

/** Take a webview's `textFocus` message; false for any other message. */
export function tookTextFocus(
  message: { type?: unknown; focused?: unknown },
  webview?: vscode.Webview,
): boolean {
  if (message.type !== 'textFocus') {
    return false;
  }
  setTextFocus(message.focused === true, webview);
  return true;
}

/** Undo or redo the typing in the box with the focus. In a scene's tab VS
 *  Code's own undo goes to the custom editor and never reaches the box
 *  (plans/several-scenes.md §8), so the box's page runs the browser's. */
export function undoTyping(command: 'undo' | 'redo'): void {
  void holder?.postMessage({ type: 'typing', command });
}
