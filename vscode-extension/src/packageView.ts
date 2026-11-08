import { realpathSync } from 'fs';
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
  /** The folder the engine or the figure named: two views are one when this is. */
  readonly dir: string;
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
  for (const file of FILES) {
    try {
      real.set(file, realpathSync(join(dir, file)));
    } catch {
      throw new Error(`its view is not whole: ${join(dir, file)} is missing`);
    }
  }
  const roots = [...new Set([...real.values()].map((path) => dirname(path)))];
  return {
    dir,
    roots: roots.map((path) => vscode.Uri.file(path)),
    uri: (webview, file) => webview.asWebviewUri(vscode.Uri.file(real.get(file)!)),
  };
}

/** What a side bar view shows before an engine has said where its view is.
 *  None is started for the side bar alone, so this lasts until a scene opens. */
export function waitingHtml(text: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
</head>
<body style="color: var(--vscode-descriptionForeground); padding: 0 1em;">
  <p>${text}</p>
</body>
</html>`;
}
