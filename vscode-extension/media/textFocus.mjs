// Whether the focus is in a box that takes typing, told to the extension host
// as it changes. VS Code cannot see into a webview: its `inputFocus` stays
// false while a box in here has the focus, so the studio's Cmd/Ctrl+Z binding
// took the key from the box and undid the scene instead of the typing. The
// host keeps `magpylib-studio.textFocus` from what this says, and the binding
// stands aside while it holds; VS Code's own undo then reaches the box.

/** Input types that take typing; a slider, a checkbox or a colour does not. */
const TYPED = new Set([
  "text",
  "number",
  "search",
  "email",
  "url",
  "tel",
  "password",
]);

/** Whether `el` takes typing: a box, a text area, an editable element. */
function takesTyping(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return !el.readOnly && !el.disabled;
  if (el.tagName === "INPUT") {
    return TYPED.has(el.type) && !el.readOnly && !el.disabled;
  }
  return false;
}

/**
 * Tell `post` true when a box that takes typing gets the focus and false when
 * it loses it -- to another element, to the rest of VS Code, or to being taken
 * out of the page, for which some Chromium versions fire no focusout: while a
 * box has the focus, any change to the page looks again. Told only when it
 * changes.
 *
 * @param {(focused: boolean) => void} post
 */
export function watchTextFocus(post) {
  let told = false;
  // A page that loses the focus keeps its active element, so the window's
  // own focus is followed apart.
  let away = !document.hasFocus();
  /** @type {MutationObserver | null} */
  let watcher = null;
  const check = () => {
    const now = !away && takesTyping(document.activeElement);
    if (now === told) return;
    told = now;
    post(now);
    if (now && !watcher) {
      watcher = new MutationObserver(check);
      watcher.observe(document.body, { childList: true, subtree: true });
    } else if (!now && watcher) {
      watcher.disconnect();
      watcher = null;
    }
  };
  // the focus has moved by the time a timer runs, not yet during focusout
  document.addEventListener("focusin", check);
  document.addEventListener("focusout", () => setTimeout(check));
  window.addEventListener("focus", () => {
    away = false;
    check();
  });
  window.addEventListener("blur", () => {
    away = true;
    check();
  });
}
