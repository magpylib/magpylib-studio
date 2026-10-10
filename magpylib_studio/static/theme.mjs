/**
 * What a widget wears: the theme the host declares, the colour it sits on,
 * and the backdrops it may paint. Shared by the view (`widget.mjs`), which
 * also paints the backdrops it is alone on, and a panel of its own
 * (`panel.mjs`), which only wears what it sits on.
 */

/** A colour, as the bytes it paints: red, green, blue and alpha. A canvas does
 *  the reading, so `rgb(…)`, `color(srgb …)`, `oklch(…)` -- whatever a
 *  stylesheet's colour computes to -- all come out the same way. */
let probe = null;
export function paint(color) {
  probe ??= document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  return probe.getImageData(0, 0, 1, 1).data;
}

/** Backdrops a host paints behind every widget output whatever its theme.
 *  VS Code's Jupyter renderer puts each output on `background: #fff
 *  !important`, in a dark editor as much as a light one, because ipywidgets'
 *  own controls take their colours from JupyterLab's theme variables, which
 *  VS Code does not supply: on white they are legible, on dark they are not.
 *  Two of them, one in the other -- the output (padded 8px) and the box the
 *  widget is put in (padded 0 8px) -- as a live VS Code page showed.
 *
 *  So they are looked past only when the view is alone on them, and then the
 *  view wears VS Code's theme and paints them to match. Shared with other
 *  widgets -- sliders in the same box -- the view wears the white, as they
 *  must, rather than sitting dark among light controls. */
const BACKDROPS = ".cell-output-ipywidget-background";

/** What counts as sharing a backdrop: another widget, whether or not it has
 *  been drawn yet -- Jupyter renders a box's children one by one -- or
 *  anything else that takes up room. VS Code puts an empty `div.cell-output`
 *  beside every widget, where a plain-text output would go, and an empty
 *  placeholder is no company. Nor is another view of a scene -- a second
 *  `display` of the same one -- which was not drawn for the white as a
 *  slider is: a box holding one is company only for whatever else it holds.
 *  A view not drawn yet counts until it is, and the backdrop is looked at
 *  again when it arrives. */
const WIDGETS = ".lm-Widget, .jupyter-widgets";
const SCENE = ".magpy-scene";
function company(node) {
  if (node.matches(SCENE)) return false;
  if (node.querySelector(SCENE)) return [...node.children].some(company);
  if (node.matches(WIDGETS)) return true;
  const box = node.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/** A colour as `rgb(…)`, which three.js reads, or null when it is not
 *  opaque. */
export function opaque(color) {
  const [r, g, b, a] = paint(color);
  return a > 200 ? { css: `rgb(${r}, ${g}, ${b})`, r, g, b } : null;
}

/** The theme a host declares outright, for a page that paints nothing behind
 *  the view to read. VS Code's webviews -- a notebook's outputs among them --
 *  are transparent (`body { background-color: transparent }`, in its own
 *  webview host), and say which theme is in force on the body instead, with
 *  the editor's colours as variables on the root. The system's setting is no
 *  substitute: VS Code's theme need not be the system's. */
export function declaredTheme() {
  const kind = document.body?.dataset.vscodeThemeKind; // vscode-dark, …
  if (!kind) return null;
  const root = getComputedStyle(document.documentElement);
  const colour =
    root.getPropertyValue("--vscode-notebook-editorBackground").trim() ||
    root.getPropertyValue("--vscode-editor-background").trim();
  return {
    css: colour ? (opaque(colour)?.css ?? null) : null,
    // vscode-high-contrast is dark, vscode-high-contrast-light is not
    dark: !kind.includes("light"),
  };
}

/** The host's backdrops that hold this widget and nothing else, innermost
 *  first -- and so may wear the view's colour instead of leaving a white rim
 *  round a dark view. None when the first holds anything else: sliders in
 *  the same box were drawn for the white, and would be unreadable on
 *  anything darker. None, too, for a widget not yet on the page, whose
 *  company may not have arrived. */
export function soleBackdrops(el) {
  const found = [];
  if (!el.isConnected) return found;
  for (let node = el; ;) {
    const root = node.getRootNode();
    const parent =
      node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    if (!parent) return found;
    const siblings = [...parent.children].filter((child) => child !== node);
    if (siblings.some(company)) return found;
    if (parent.matches(BACKDROPS)) found.push(parent);
    else if (found.length) return found; // past the outermost of them
    node = parent;
  }
}

/** The host's backdrop nearest the widget, alone on it or not: its size
 *  changes when company arrives, which is when to look again. */
export function nearestBackdrop(el) {
  for (let node = el.parentNode; node; node = node.parentNode) {
    if (node instanceof ShadowRoot) node = node.host;
    if (!(node instanceof Element)) return null;
    if (node.matches(BACKDROPS)) return node;
  }
  return null;
}

/** What the view sits on: the first opaque background among the elements
 *  holding it, followed out of shadow roots, since marimo renders into one.
 *
 * Not the page's body. In VS Code's notebooks the body wears the editor's
 * theme while widget outputs sit on a white panel of their own, and a view
 * dressed from the body was a dark box on white -- with the panel's dark
 * text inherited onto it, which left the legend and the tools unreadable.
 */
export function surroundings(el) {
  const alone = new Set(soleBackdrops(el));
  for (let node = el.parentNode; node; node = node.parentNode) {
    if (node instanceof ShadowRoot) node = node.host;
    if (!(node instanceof Element)) break; // the document: nothing opaque
    if (alone.has(node)) continue;
    const found = opaque(getComputedStyle(node).backgroundColor);
    if (found) {
      const { css, r, g, b } = found;
      return { css, dark: 0.299 * r + 0.587 * g + 0.114 * b < 128 };
    }
  }
  return null;
}

/** Dress `el` for the theme `choice` names -- "auto" wears what it sits on,
 *  else the theme the host declares, else the system's setting -- and say
 *  whether that is dark. The view's own dressing adds the backdrops it
 *  paints; a panel of its own only wears. */
export function wear(el, choice) {
  const behind =
    choice === "auto" ? (surroundings(el) ?? declaredTheme()) : null;
  const dark =
    choice === "dark" ||
    (choice === "auto" &&
      (behind
        ? behind.dark
        : matchMedia("(prefers-color-scheme: dark)").matches));
  if (behind?.css) {
    el.style.setProperty("--vscode-editor-background", behind.css);
  } else el.style.removeProperty("--vscode-editor-background");
  el.classList.toggle("magpy-dark", dark);
  el.style.colorScheme = dark ? "dark" : "light";
  return dark;
}
