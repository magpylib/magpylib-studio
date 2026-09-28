/**
 * What the pages here share: the widget, the scene, and a model to run one
 * against -- what anywidget hands `render`, and no more. They play the
 * notebook themselves, so what they check is the widget and not a notebook.
 */
export const widget = (await import("/static/widget.js")).default;
export const state = await (await fetch("/out/state.json")).json();

/** A model of its own for each view, as each widget in a notebook has. */
export function localModel() {
  const values = structuredClone(state);
  const listeners = {};
  return {
    get: (key) => values[key],
    set(key, value) {
      values[key] = value;
      for (const listener of listeners[`change:${key}`] || []) listener(value);
    },
    save_changes() {},
    on: (event, listener) => (listeners[event] ||= []).push(listener),
    off() {},
    send() {},
  };
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
