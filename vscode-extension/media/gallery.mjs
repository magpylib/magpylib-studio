// The example gallery's page (`src/gallery.ts`): a card per example, its
// picture in the editor's theme, a click opening it. Both pictures are on the
// card and the stylesheet shows the one the theme asks for, so a theme
// changed while the gallery is open is followed without a message.

const vscode = acquireVsCodeApi();
const gallery = document.getElementById("gallery");

/** One card: a button, so the keys reach it as a click does. */
function card({ name, label, description, light, dark }) {
  const item = document.createElement("div");
  item.setAttribute("role", "listitem");
  const button = document.createElement("button");
  button.className = "card";
  button.title = `Open ${label} in a tab of its own`;
  const frame = document.createElement("div");
  frame.className = "picture";
  for (const [theme, src] of [
    ["light", light],
    ["dark", dark],
  ]) {
    const img = document.createElement("img");
    img.className = theme;
    img.src = src;
    img.alt = "";
    img.loading = "lazy";
    // an example nobody has drawn yet: the card without its picture
    img.addEventListener("error", () => img.remove());
    frame.append(img);
  }
  const title = document.createElement("span");
  title.className = "label";
  title.textContent = label;
  const text = document.createElement("span");
  text.className = "description";
  text.textContent = description;
  button.append(frame, title, text);
  button.addEventListener("click", () =>
    vscode.postMessage({ type: "open", name }),
  );
  item.append(button);
  return item;
}

window.addEventListener("message", ({ data }) => {
  if (data.type !== "examples") return;
  gallery.replaceChildren(...data.examples.map(card));
  if (data.error) {
    const said = document.createElement("p");
    said.className = "error";
    said.textContent = `The examples could not be listed: ${data.error}`;
    gallery.append(said);
  }
});

vscode.postMessage({ type: "ready" });
