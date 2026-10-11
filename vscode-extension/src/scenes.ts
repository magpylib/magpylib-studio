import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

/** The custom editor's view type: a `.magpy.json` opens in the studio, a tab
 *  per scene. */
export const SCENE_VIEW_TYPE = 'magpylibStudio.scene';

/** A session name no engine has seen. Random, so that a stale one -- a call
 *  in flight when its scene closed, or when the engine restarted -- can only
 *  miss, never land in another scene. */
export function newSessionName(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * One open scene: a tab's document, held by a session of its own in the
 * engine. The engine owns the scene; this keeps what the extension needs to
 * speak about it -- the file, the session, the panels showing it, whether it
 * differs from its file, and the last document it settled on, which is what a
 * restarted engine is given back.
 */
export class SceneDocument implements vscode.CustomDocument {
  /** The engine session holding the scene. Renamed when a new engine opens
   *  it again: names are never reused. */
  session = newSessionName();
  /** The engine the session was opened in; any other means opening it again. */
  engine: unknown;
  /** The `open_session` for `engine`, answered or not yet. */
  opening: Promise<void> | undefined;
  /** What the engine is given to open the scene: the file's document at
   *  first, then the last one it settled on (see `scheduleSettle`). */
  lastDocument: unknown;
  /** Why the scene could not be read, when it could not. Such a scene is
   *  shown empty and never saved: an empty scene must not go over a file. */
  problem: string | undefined;
  dirty = false;
  /** Counted per edit: a save that an edit outran says so after. */
  revision = 0;
  /** The object picked in this scene, for the Inspector when it comes back. */
  selected: string | undefined;
  /** Its history is rolled back: the scene shows an earlier step. */
  rolledBack = false;
  /** Names this scene's recovery copy, kept apart from its session's name,
   *  which changes when an engine restarts. */
  readonly key = newSessionName();
  readonly panels = new Set<vscode.WebviewPanel>();
  /** Set while Save As hands this scene's session to the new file's
   *  document: its dispose must not close a session that lives on. */
  handedOver = false;
  /** When it opened, among the open scenes: the tree lists them so. */
  readonly openedAt = ++opened;

  constructor(
    public readonly uri: vscode.Uri,
    private readonly onDispose: (doc: SceneDocument) => void,
  ) {}

  get untitled(): boolean {
    return this.uri.scheme === 'untitled';
  }

  get name(): string {
    return this.uri.path.split('/').pop() || this.uri.path;
  }

  /** The folder relative mesh paths mean: the file's, or for an untitled
   *  scene the folder its name was given in, else the workspace's. */
  get baseDir(): string | undefined {
    if (this.uri.scheme === 'file') {
      return path.dirname(this.uri.fsPath);
    }
    if (this.untitled && path.isAbsolute(this.uri.path)) {
      return path.dirname(this.uri.path);
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  dispose(): void {
    this.onDispose(this);
  }
}

let opened = 0;

/** The open scenes, the one in front first and the rest by when they were
 *  last in front. */
const open: SceneDocument[] = [];
const frontChanged = new vscode.EventEmitter<SceneDocument | undefined>();
const scenesChanged = new vscode.EventEmitter<void>();

/** A scene opened or closed. */
export const onDidChangeScenes = scenesChanged.event;

/** The scene in front changed: another tab, a scene closed, the first one
 *  opened. Every view that shows one scene shows this one. */
export const onDidChangeFront = frontChanged.event;

/** The scene the side bar and the commands act on: the scene tab last in
 *  front, which stays in front while the focus is in the side bar or in
 *  another editor. */
export function frontScene(): SceneDocument | undefined {
  return open[0];
}

export function openScenes(): readonly SceneDocument[] {
  return open;
}

export function sceneFor(uri: vscode.Uri): SceneDocument | undefined {
  const key = uri.toString();
  return open.find((doc) => doc.uri.toString() === key);
}

/** A scene that has just opened: in front if it is the only one, behind
 *  otherwise until its tab is shown. */
export function addScene(doc: SceneDocument): void {
  open.push(doc);
  scenesChanged.fire();
  if (open.length === 1) {
    frontChanged.fire(doc);
  }
}

export function bringToFront(doc: SceneDocument): void {
  const at = open.indexOf(doc);
  if (at <= 0) {
    return;
  }
  open.splice(at, 1);
  open.unshift(doc);
  frontChanged.fire(doc);
}

export function removeScene(doc: SceneDocument): void {
  const at = open.indexOf(doc);
  if (at < 0) {
    return;
  }
  open.splice(at, 1);
  scenesChanged.fire();
  if (at === 0) {
    frontChanged.fire(open[0]);
  }
}

/** The scene a tree row belongs to, or is, when the argument is a row. */
export function sceneOfNode(node: unknown): SceneDocument | undefined {
  const row = node as { scene?: unknown; doc?: unknown } | undefined;
  const scene = row?.scene ?? row?.doc;
  return scene instanceof SceneDocument ? scene : undefined;
}
