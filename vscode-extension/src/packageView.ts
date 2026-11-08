import { realpathSync, statSync } from 'fs';
import { dirname, join } from 'path';

import * as vscode from 'vscode';

/**
 * The package's view, where an engine or a script's figure says it is: the
 * notebook widget's bundle and stylesheet, and the Variables and Inspector
 * panels the side bar mounts (docs/decisions.md, 0056).
 *
 * The extension carries no copy. The payload a view reads changes with every
 * release, and a copy shipped here drew the payloads of whatever engine pip
 * had installed, without a word when the two were of different versions. A
 * view loaded from the package that wrote the scene is always of its version.
 *
 * Each file by its real path, with its folder a root the webview may load
 * from: VS Code refuses a file whose real path is outside every root, and an
 * installer may link a package's files from its cache (uv's
 * `link-mode=symlink`). Under remote development the extension runs where the
 * engine does, and these load from there as the extension's own files do.
 */
const FILES = ['widget.js', 'widget.css', 'variables.mjs', 'inspector.mjs'] as const;

export type PackageFile = (typeof FILES)[number];

export interface PackageView {
  /** The folder the engine or the figure named. */
  readonly dir: string;
  /** What the view is: its files' real paths and when each was written. Two
   *  views are one when this is, so a package upgraded in place -- the same
   *  folder, other files -- is another view, and what it draws is drawn again. */
  readonly key: string;
  /** The folders a webview drawing this view may load from. */
  readonly roots: vscode.Uri[];
  /** `file` of this view, as the URI `webview` may load. */
  uri(webview: vscode.Webview, file: PackageFile): vscode.Uri;
}

/** The view in `dir`. Throws, saying which file, when the package there has
 *  none: an install that is not whole. */
export function packageView(dir: unknown): PackageView {
  if (typeof dir !== 'string' || !dir) {
    throw new Error('it did not say where its view is');
  }
  const real = new Map<PackageFile, string>();
  const stamps: string[] = [];
  for (const file of FILES) {
    try {
      const path = realpathSync(join(dir, file));
      const { mtimeMs, size } = statSync(path);
      real.set(file, path);
      stamps.push(`${path}@${mtimeMs}:${size}`);
    } catch {
      throw new Error(`its view is not whole: ${join(dir, file)} is missing`);
    }
  }
  const roots = [...new Set([...real.values()].map((path) => dirname(path)))];
  return {
    dir,
    key: stamps.join('|'),
    roots: roots.map((path) => vscode.Uri.file(path)),
    uri: (webview, file) => webview.asWebviewUri(vscode.Uri.file(real.get(file)!)),
  };
}

/** Load `webview` with `view` -- `page` is its HTML -- or, with none, with
 *  `notice` in its place: a view waiting for an engine, or why there is none.
 *  The roots are the extension's and the view's. */
export function showPage(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  view: PackageView | undefined,
  page: (view: PackageView) => string,
  notice: string,
): void {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [extensionUri, ...(view?.roots ?? [])],
  };
  webview.html = view ? page(view) : noticeHtml(notice);
}

/** A page that says one thing, in the editor's own type: `text` is escaped,
 *  as an engine's error may hold anything. */
export function noticeHtml(text: string): string {
  const escaped = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
</head>
<body style="font-family: var(--vscode-font-family); color: var(--vscode-descriptionForeground); padding: 0 1em;">
  <p>${escaped}</p>
</body>
</html>`;
}
