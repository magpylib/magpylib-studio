import * as vscode from 'vscode';

import type { SceneDocument } from './scenes';

/** A scene open in a tab: a top-level row, its objects under it. `doc` is
 *  missing for a tab VS Code has not loaded yet -- a scene behind another tab
 *  after a reload -- which loads when its row is opened. */
export interface SceneRoot {
  kind: 'scene';
  uri: vscode.Uri;
  doc?: SceneDocument;
  /** The group its tab is in, where it loads. */
  column?: vscode.ViewColumn;
}

/** The one row of an empty scene, which adds its first object. */
export interface SceneHint {
  kind: 'hint';
  scene: SceneDocument;
}

export interface SceneObject {
  id: string;
  type: string;
  label: string;
  parent: string | null;
  visible: boolean;
  /** Set on a copy made by a duplicate event, naming the object it came
   *  from. Generated objects have no document entry to edit, so the tree
   *  shows them and stops there. */
  derived?: string;
  /** Set on a row the tree makes up for an object the built scene does not
   *  have, and why it does not: the log still records everything that
   *  happened to it, and steps you cannot see are steps you cannot undo. */
  absent?: AbsentReason;
  /** What the checks found for a mesh built from a source. An open or
   *  disconnected mesh computes a field, and the number is wrong — so the
   *  row says so rather than waiting to be clicked. */
  mesh?: MeshStatus;
  /** The objects this one overlaps, by id. magpylib adds the magnetizations
   *  of two magnets where they overlap, so the field there is wrong — and,
   *  as for a broken mesh, the row says so rather than waiting to be
   *  clicked. Pairs marked as meant are left out. */
  overlaps?: string[];
  /** The scene the row is in, set by the tree. */
  scene?: SceneDocument;
}

/** Say on a row that its object overlaps others: the warning a broken
 *  mesh gets, for the same reason — its field is wrong and looks right —
 *  and whom it overlaps, in the description and the tooltip. */
function markOverlaps(item: vscode.TreeItem, obj: SceneObject): void {
  if (!obj.overlaps?.length || !obj.visible) return;
  const others = obj.overlaps.join(', ');
  item.iconPath = new vscode.ThemeIcon(
    'warning',
    new vscode.ThemeColor('problemsWarningIcon.foreground'),
  );
  item.description = `${item.description ?? obj.type} · overlaps ${others}`;
  const said =
    typeof item.tooltip === 'string'
      ? item.tooltip
      : (item.tooltip?.value ?? `${obj.id} — ${obj.type}`);
  const tooltip = new vscode.MarkdownString(
    `${said}\n\n$(warning) Overlaps **${others}**. magpylib adds their ` +
      `magnetizations where they overlap, so the field there is wrong. ` +
      `If it is meant — a cut-out — mark it so in the view's legend.`,
  );
  tooltip.supportThemeIcons = true;
  item.tooltip = tooltip;
}

/** The engine's verdict on one mesh; see `magpylib_studio/meshes.py`. */
export interface MeshStatus {
  open?: boolean | null;
  disconnected?: boolean | null;
  selfintersecting?: boolean | null;
  open_edges?: number;
  parts?: number;
  intersecting_faces?: number;
  /** How many faces reorientation had to turn around. Repaired, not wrong. */
  flipped?: number;
  /** The file is not what it was when this scene was saved. */
  changed?: boolean;
  faces?: number;
  vertices?: number;
  /** `cube.stl · 12 faces`, or `hull of 30 points`. */
  source?: string;
}

/** What is wrong with a mesh, in the order a row has room to say it, or
 *  undefined when nothing is. Kept beside the type it reads because both the
 *  tree and the inspector have to say the same thing about the same mesh. */
export function meshFault(status: MeshStatus): string | undefined {
  if (status.open) {
    return status.open_edges ? `open at ${status.open_edges} edges` : 'open';
  }
  if (status.disconnected) {
    return status.parts ? `${status.parts} separate parts` : 'disconnected';
  }
  if (status.selfintersecting) {
    return 'self-intersecting';
  }
  return undefined;
}

/** Why an object with a history is missing from the scene: it was deleted,
 *  the history is rolled back to before it existed, or the log no longer
 *  builds it (its `create` was dropped or reordered away). */
export type AbsentReason = 'removed' | 'not applied' | 'not built';

/** One step of the construction, shown under the object it happened to. */
export interface SceneOperation {
  kind: 'operation';
  index: number;
  id: string;
  target: string;
  op: string;
  /** What it did, in words: "orbit 36° about z". */
  label: string;
  /** The call that did it, for the tooltip. */
  source: string;
  /** Recorded, but after the point the history is rolled back to. */
  pending?: boolean;
  /** The last rebuild could not apply it. */
  error?: string;
  /** The scene the row is in, set by the tree. */
  scene?: SceneDocument;
}

export type SceneNode = SceneRoot | SceneHint | SceneObject | SceneOperation;

export function isOperation(node: SceneNode): node is SceneOperation {
  return (node as SceneOperation).kind === 'operation';
}

export function isSceneRoot(node: SceneNode): node is SceneRoot {
  return (node as SceneRoot).kind === 'scene';
}

function isHint(node: SceneNode): node is SceneHint {
  return (node as SceneHint).kind === 'hint';
}

/** An object's row, not a scene's, a step's or the hint's. */
export function isObject(node: SceneNode | undefined): node is SceneObject {
  return node !== undefined && !('kind' in node);
}

// Wireframe SVGs in media/icons, one per magpylib class, colored by
// category (magnets red, currents blue, sensors green, misc gray).
const TYPE_ICON_FILES: Record<string, string> = {
  'magnet.Cuboid': 'cuboid',
  'magnet.Cylinder': 'cylinder',
  'magnet.CylinderSegment': 'cylinder-segment',
  'magnet.Sphere': 'sphere',
  'magnet.Tetrahedron': 'tetrahedron',
  'magnet.TriangularMesh': 'mesh',
  'current.Circle': 'loop',
  'current.Polyline': 'polyline',
  'current.TriangleSheet': 'sheet',
  'current.TriangleStrip': 'strip',
  'misc.Dipole': 'dipole',
  'misc.Triangle': 'triangle',
  'misc.CustomSource': 'custom',
  Sensor: 'sensor',
};

/** The glyph for a magpylib class, shared with the "Add Object…" menu so a
 *  cylinder is picked by the same picture the tree will show it as. */
export function iconFor(
  type: string,
  extensionUri: vscode.Uri,
): vscode.Uri | vscode.ThemeIcon {
  if (type === 'Collection') {
    return new vscode.ThemeIcon('folder');
  }
  const file =
    TYPE_ICON_FILES[type] ?? (type.startsWith('magnet.') ? 'cuboid' : 'custom');
  return vscode.Uri.joinPath(extensionUri, 'media', 'icons', `${file}.svg`);
}

const TREE_MIME = 'application/vnd.code.tree.magpylib-studio.sceneview';

/** What a headstone row says it is, in the terms that make it fixable. */
const ABSENT_TOOLTIP: Record<AbsentReason, (id: string) => string> = {
  removed: (id) =>
    `${id} was deleted. Deleting is recorded, not erased, so its steps are ` +
    `still here — drop the "removed" step to have it back.`,
  'not applied': (id) =>
    `${id} is created after the step the history is rolled back to, so the ` +
    `scene does not have it yet. Clear the rollback to build it.`,
  'not built': (id) =>
    `${id} is never created by the log as it now stands — its "created" ` +
    `step was dropped or moved after the steps that need it. Undo, or move ` +
    `a "created" step back to the front.`,
};

/** A glyph per kind of step, so the shape of a history reads at a glance. */
const OPERATION_ICONS: Record<string, string> = {
  create: 'add',
  remove: 'trash',
  reparent: 'type-hierarchy',
  move: 'move',
  position: 'pin',
  orientation: 'compass',
  rotate_from_angax: 'sync',
  rotate_from_rotvec: 'sync',
  duplicate_around: 'circuit-board',
  duplicate_along: 'symbol-array',
  mirror: 'split-horizontal',
};

/**
 * A scene's row: in Open Scenes, where it is picked, saved and closed, and as
 * a heading in Objects, when several are shown there.
 */
function sceneRowItem(
  root: SceneRoot,
  extensionUri: vscode.Uri,
  all: SceneRoot[],
  isFront: (doc: SceneDocument) => boolean,
  as: 'list' | 'heading',
  shown: (doc: SceneDocument) => boolean = () => true,
): vscode.TreeItem {
  const doc = root.doc;
  const name = root.uri.path.split('/').pop() || root.uri.path;
  const front = doc !== undefined && isFront(doc);
  const picked = doc !== undefined && shown(doc);
  // The scene in front is the one the views below and the commands act on:
  // its name is marked, as a match is in a list.
  const item = new vscode.TreeItem(
    front ? { label: name, highlights: [[0, name.length]] } : name,
    as === 'list'
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Expanded,
  );
  item.id = `${as}:${root.uri.toString()}`;
  const twins = all.filter(
    (other) =>
      other.uri.toString() !== root.uri.toString() && other.uri.path.split('/').pop() === name,
  );
  const folder = twins.length ? root.uri.path.split('/').slice(-2, -1)[0] : undefined;
  item.description = [
    doc?.dirty ? '•' : undefined,
    folder,
    doc ? undefined : 'not loaded',
    doc?.problem ? 'could not be read' : undefined,
    doc?.diskNote,
  ]
    .filter(Boolean)
    .join(' ');
  const where = root.uri.scheme === 'file' ? root.uri.fsPath : 'not saved yet';
  item.tooltip = new vscode.MarkdownString(
    `**${name}** — ${where}\n\n` +
      (!doc
        ? 'Not loaded yet: click to open it.'
        : front
          ? 'In front: the Variables, Inspector and Undo views show this scene, ' +
            'and the buttons on its rows act on it.'
          : 'Click to bring it in front.') +
      (as === 'list'
        ? picked
          ? '\n\nShown in Objects. Cmd/Ctrl-click another to show several.'
          : '\n\nClick to show it in Objects; Cmd/Ctrl-click to add it.'
        : '') +
      (doc?.dirty ? '\n\nUnsaved changes.' : ''),
  );
  // In colour, the scenes Objects shows; grey, the others: which is picked
  // reads at a glance, where a selection is faint once the focus is elsewhere.
  // A dark theme gets the logo without its white outline, the bird drawn light.
  const logo = picked ? 'magnet' : 'magnet-muted';
  item.iconPath = {
    light: vscode.Uri.joinPath(extensionUri, 'media', `${logo}.svg`),
    dark: vscode.Uri.joinPath(extensionUri, 'media', `${logo}-dark.svg`),
  };
  // Not /^magpy/, which every object menu matches. What the row offers
  // follows what the scene is: Revert needs a file, Save needs something
  // unsaved, Show the Whole Scene a history rolled back.
  item.contextValue = doc
    ? (as === 'list' ? 'sceneRow' : 'sceneHead') +
      (doc.untitled ? 'Untitled' : 'File') +
      (doc.dirty ? 'Unsaved' : '') +
      (doc.rolledBack ? 'RolledBack' : '')
    : 'unloadedSceneRow';
  item.command = {
    command: 'magpylib-studio.showScene',
    title: 'Show the Scene',
    arguments: [root],
  };
  return item;
}

/**
 * Open Scenes: a line per open scene, never longer than the number of scenes,
 * as Source Control lists its repositories. What is picked here is what
 * Objects shows; a click also brings the scene's tab forward.
 */
export class OpenScenesProvider implements vscode.TreeDataProvider<SceneRoot> {
  private emitter = new vscode.EventEmitter<SceneRoot | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** One row object per scene, for selecting it from outside. */
  private roots = new Map<string, SceneRoot>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly scenes: () => SceneRoot[],
    private readonly isFront: (doc: SceneDocument) => boolean,
    /** Whether Objects shows `doc`: its row's logo is in colour. */
    private readonly isShown: (doc: SceneDocument) => boolean,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  /** The row of `doc`, once listed. */
  rowOf(doc: SceneDocument): SceneRoot | undefined {
    return [...this.roots.values()].find((root) => root.doc === doc);
  }

  getTreeItem(root: SceneRoot): vscode.TreeItem {
    return sceneRowItem(
      root,
      this.extensionUri,
      this.scenes(),
      this.isFront,
      'list',
      this.isShown,
    );
  }

  getParent(): undefined {
    return undefined; // a flat list
  }

  getChildren(element?: SceneRoot): SceneRoot[] {
    if (element) {
      return [];
    }
    const scenes = this.scenes();
    const live = new Set(scenes.map((root) => root.uri.toString()));
    for (const key of [...this.roots.keys()]) {
      if (!live.has(key)) {
        this.roots.delete(key);
      }
    }
    return scenes.map((root) => {
      const key = root.uri.toString();
      const kept = this.roots.get(key);
      if (kept && kept.doc === root.doc) {
        kept.column = root.column;
        return kept;
      }
      this.roots.set(key, root);
      return root;
    });
  }
}

/**
 * Objects: the scenes picked in Open Scenes, each under its own heading with
 * its objects under it, as Source Control's Changes shows each repository
 * picked; one scene picked, its objects at the top. The engine reports a
 * scene's objects as a flat list with `parent` ids (depth-first); the scene's
 * row fetches and caches it, child calls slice it. Drag & drop reparents
 * within a scene: onto a Collection = move in, onto a plain object = move next
 * to it, onto the scene's heading or empty space = move to its root.
 */
export class SceneTreeProvider
  implements
    vscode.TreeDataProvider<SceneNode>,
    vscode.TreeDragAndDropController<SceneNode>
{
  private emitter = new vscode.EventEmitter<SceneNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly dragMimeTypes = [TREE_MIME];
  readonly dropMimeTypes = [TREE_MIME];
  /** Each scene's rows, as last read, and which need reading again. */
  private rows = new Map<
    SceneDocument,
    { objects: SceneObject[]; operations: SceneOperation[]; absent: SceneObject[] }
  >();
  private stale = new Set<SceneDocument>();
  /** One row object per scene, so that a scene's rows can be refreshed alone. */
  private roots = new Map<string, SceneRoot>();
  /** The one scene shown, its rows at the top rather than under a heading. */
  private single: SceneRoot | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly scenes: () => SceneRoot[],
    private readonly isFront: (doc: SceneDocument) => boolean,
    private readonly listObjects: (doc: SceneDocument) => Promise<SceneObject[]>,
    private readonly moveObject: (
      doc: SceneDocument,
      id: string,
      parent: string | null,
    ) => Promise<void>,
    private readonly listOperations: (doc: SceneDocument) => Promise<SceneOperation[]>,
    private readonly load: (root: SceneRoot) => void,
    /** Objects dropped on another scene: copied there, never moved. */
    private readonly copyObjects: (
      from: SceneDocument,
      objects: SceneObject[],
      into: SceneDocument,
      parent: string | null,
    ) => Promise<void>,
  ) {}

  /** Read `doc`'s rows again, and only its; with no scene, the scene rows
   *  themselves -- names, marks, which is in front. */
  refresh(doc?: SceneDocument): void {
    if (!doc) {
      this.emitter.fire();
      return;
    }
    this.stale.add(doc);
    // its rows are the tree's top when it is the one scene shown
    this.emitter.fire(this.single?.doc === doc ? undefined : this.roots.get(doc.uri.toString()));
  }

  getTreeItem(node: SceneNode): vscode.TreeItem {
    if (isSceneRoot(node)) {
      return this.sceneItem(node);
    }
    if (isHint(node)) {
      const item = new vscode.TreeItem('Add an object…');
      item.id = `${node.scene.key}/hint`;
      item.iconPath = new vscode.ThemeIcon('add');
      item.command = {
        command: 'magpylib-studio.addObject',
        title: 'Add Object…',
        arguments: [node],
      };
      return item;
    }
    return isOperation(node) ? this.operationItem(node) : this.objectItem(node);
  }

  private sceneItem(root: SceneRoot): vscode.TreeItem {
    return sceneRowItem(root, this.extensionUri, this.scenes(), this.isFront, 'heading');
  }

  /**
   * One step of the construction. Named for what it did rather than for the
   * call that did it - the call is in the tooltip, and in the script tab.
   */
  private operationItem(operation: SceneOperation): vscode.TreeItem {
    const item = new vscode.TreeItem(
      operation.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${operation.scene?.key}/op-${operation.id}`;
    item.tooltip = new vscode.MarkdownString(
      '`' + operation.source + '`' +
        (operation.error ? `\n\n$(error) ${operation.error}` : '') +
        (operation.pending ? '\n\nAfter the step the history is rolled back to.' : '') +
        '\n\n$(edit) Edit Step… shows its values in the Inspector.',
    );
    item.tooltip.supportThemeIcons = true;
    // The `Create` suffix earns a row of its own: on the step that brought an
    // object into being, "remove" has two readings — drop the step, so it was
    // never created, or delete the object, which is a step in its own right —
    // and only that row can offer both.
    item.contextValue = 'magpyOperation' + (operation.op === 'create' ? 'Create' : '');
    item.iconPath = operation.error
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
      : new vscode.ThemeIcon(
          OPERATION_ICONS[operation.op] ?? 'circle-small-filled',
          operation.pending
            ? new vscode.ThemeColor('disabledForeground')
            : undefined,
        );
    if (operation.pending) {
      item.description = 'not applied';
    }
    item.command = {
      command: 'magpylib-studio.selectOperation',
      title: 'Show this step',
      arguments: [operation],
    };
    return item;
  }

  private objectItem(obj: SceneObject): vscode.TreeItem {
    // Both halves of what getChildren returns: an object with no children of
    // its own still has the steps that built it, and a row with no chevron is
    // a row those steps cannot be reached from. Only what contains objects
    // opens on its own — steps wait to be asked for, so a ring of twelve does
    // not arrive as twenty-four rows.
    const rows = obj.scene && this.rows.get(obj.scene);
    const contains = rows?.objects.some((o) => o.parent === obj.id) ?? false;
    const steps = rows?.operations.some((op) => op.target === obj.id) ?? false;
    const item = new vscode.TreeItem(
      obj.label,
      contains
        ? vscode.TreeItemCollapsibleState.Expanded
        : steps
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${obj.scene?.key}/${obj.id}`;
    if (obj.absent) {
      // A headstone: the object is not in the scene, but its steps are still
      // in the log, and every one of them can be selected, edited, reordered
      // or dropped from here. Deleting an object is recorded rather than
      // erased, so without this row the step that deleted it — and the whole
      // story before it — could be neither seen nor undone.
      item.description = obj.absent;
      item.tooltip = ABSENT_TOOLTIP[obj.absent](obj.id);
      // outside the magpy* namespace, like a generated copy: the object
      // commands act on something the scene has, and this row is the
      // absence of one. Its steps carry their own menus.
      item.contextValue = 'absentObject';
      item.iconPath = new vscode.ThemeIcon(
        obj.absent === 'removed' ? 'circle-slash' : 'circle-outline',
        new vscode.ThemeColor('disabledForeground'),
      );
      return item;
    }
    if (obj.derived) {
      // A generated copy: real geometry, real field source, but no spec, so
      // no edit command can act on it — hence no context value (every menu
      // entry is gated on /^magpy/) and a dimmed icon. It *is* selectable
      // though: a row you can see and click that does nothing at all is
      // worse than one that opens read-only and says where to edit instead.
      item.description = `${obj.type} · copy of ${obj.derived}`;
      item.tooltip =
        `${obj.id} — generated by the duplicate event on ${obj.derived}. ` +
        `Edit the event or its variables, not the copy.`;
      item.command = {
        command: 'magpylib-studio.selectObject',
        title: 'Select in Studio',
        arguments: [obj.id, obj],
      };
      // deliberately outside the magpy* namespace: every scene-view menu
      // entry is gated on /^magpy/, so this matches none of them
      item.contextValue = 'derivedCopy';
      // Same glyph as anything else of its type. A copy of a cuboid is a
      // cuboid, and a ring of twelve reading as twelve anonymous dots hides
      // the one thing the tree is for — what the scene is made of. That it
      // is a copy is said in words, in the row it is said about.
      item.iconPath = iconFor(obj.type, this.extensionUri);
      markOverlaps(item, obj);
      return item;
    }
    const fault = obj.mesh && meshFault(obj.mesh);
    item.description = obj.visible ? obj.type : `${obj.type} · hidden`;
    item.tooltip = `${obj.id} — ${obj.type}${obj.visible ? '' : ' (hidden)'}`;
    if (obj.mesh) {
      // A mesh's row says where it came from, because that is what the object
      // is — the file, not the forty thousand numbers in it.
      item.description = `${obj.mesh.source ?? obj.type}${
        obj.visible ? '' : ' · hidden'
      }`;
      item.tooltip = new vscode.MarkdownString(
        [
          `**${obj.id}** — ${obj.type}`,
          obj.mesh.source ? `\n\n${obj.mesh.source}` : '',
          obj.mesh.vertices ? ` · ${obj.mesh.vertices} vertices` : '',
          fault
            ? `\n\n$(warning) This mesh is **${fault}**. magpylib computes a ` +
              `field for it anyway, and that field is not to be trusted.`
            : '',
          obj.mesh.flipped
            ? `\n\n${obj.mesh.flipped} faces were turned around on import ` +
              `to point outward.`
            : '',
          obj.mesh.changed
            ? `\n\n$(info) The file has changed since this scene was saved.`
            : '',
        ].join(''),
      );
      item.tooltip.supportThemeIcons = true;
    }
    // visibility is part of contextValue so the inline eye can flip its icon
    item.contextValue =
      (obj.type === 'Collection' ? 'magpyCollection' : 'magpyObject') +
      (obj.visible ? 'Visible' : 'Hidden');
    item.iconPath = obj.visible
      ? iconFor(obj.type, this.extensionUri)
      : new vscode.ThemeIcon('eye-closed', new vscode.ThemeColor('disabledForeground'));
    if (fault && obj.visible) {
      // The one thing that outranks knowing what shape it is: a source whose
      // field is wrong looks exactly like one whose field is right.
      item.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('problemsWarningIcon.foreground'),
      );
      item.description = `${obj.mesh?.source ?? obj.type} · ${fault}`;
    }
    markOverlaps(item, obj);
    item.command = {
      command: 'magpylib-studio.selectObject',
      title: 'Select in Studio',
      arguments: [obj.id, obj],
    };
    return item;
  }

  /**
   * Rows for the objects the log has a history for and the scene does not:
   * deleted, rolled back past, or no longer built. In log order, after the
   * scene proper — they are what the scene used to have, or does not have
   * yet, and either way not part of reading what is in front of you.
   */
  private absentObjects(
    scene: SceneDocument,
    objects: SceneObject[],
    operations: SceneOperation[],
  ): SceneObject[] {
    const live = new Set(objects.map((o) => o.id));
    const steps = new Map<string, SceneOperation[]>();
    for (const op of operations) {
      if (!live.has(op.target)) {
        const own = steps.get(op.target) ?? [];
        own.push(op);
        steps.set(op.target, own); // insertion order is log order
      }
    }
    return [...steps].map(([id, own]) => ({
      id,
      scene,
      type: '',
      label: id,
      parent: null,
      visible: false,
      // A `remove` that has itself been applied is the one that says why.
      // Everything else is a scene that has not been built that far: either
      // on purpose (rolled back) or not (the create no longer applies).
      absent: own.some((op) => op.op === 'remove' && !op.pending)
        ? ('removed' as const)
        : own.every((op) => op.pending)
          ? ('not applied' as const)
          : ('not built' as const),
    }));
  }

  async getChildren(element?: SceneNode): Promise<SceneNode[]> {
    if (!element) {
      const scenes = this.scenes();
      const live = new Set(scenes.map((root) => root.uri.toString()));
      for (const key of [...this.roots.keys()]) {
        if (!live.has(key)) {
          this.roots.delete(key);
        }
      }
      for (const doc of [...this.rows.keys()]) {
        if (!scenes.some((root) => root.doc === doc)) {
          this.rows.delete(doc);
        }
      }
      const roots = scenes.map((root) => {
        const key = root.uri.toString();
        const kept = this.roots.get(key);
        if (kept && kept.doc === root.doc) {
          kept.column = root.column;
          return kept;
        }
        this.roots.set(key, root);
        return root;
      });
      // one scene: its rows, the view's title naming it
      this.single = roots.length === 1 && roots[0].doc ? roots[0] : undefined;
      return this.single ? this.getChildren(this.single) : roots;
    }
    if (isSceneRoot(element)) {
      const doc = element.doc;
      if (!doc) {
        this.load(element); // opened, it is listed with its rows
        return [];
      }
      let rows = this.rows.get(doc);
      if (!rows || this.stale.has(doc)) {
        this.stale.delete(doc);
        const [objects, operations] = await Promise.all([
          this.listObjects(doc),
          this.listOperations(doc),
        ]);
        for (const row of [...objects, ...operations]) {
          row.scene = doc;
        }
        rows = { objects, operations, absent: this.absentObjects(doc, objects, operations) };
        this.rows.set(doc, rows);
      }
      const top = [...rows.objects.filter((o) => o.parent === null), ...rows.absent];
      return top.length ? top : [{ kind: 'hint', scene: doc }];
    }
    if (isOperation(element) || isHint(element) || !element.scene) {
      return [];
    }
    const rows = this.rows.get(element.scene);
    if (!rows) {
      return [];
    }
    // An object's own steps first, then whatever it contains: how this came
    // to be, before what is inside it.
    return [
      ...rows.operations.filter((op) => op.target === element.id),
      ...rows.objects.filter((o) => o.parent === element.id),
    ];
  }

  handleDrag(source: readonly SceneNode[], dataTransfer: vscode.DataTransfer): void {
    // Generated copies cannot be reparented: they are not in the document.
    // Nor can headstones: there is nothing in the scene to move. Steps are
    // not dragged either - they are reordered from their own menu, where
    // "earlier"/"later" says what moving one actually means.
    const movable = source.filter(
      (o): o is SceneObject => isObject(o) && !o.derived && !o.absent,
    );
    if (movable.length) {
      dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(movable));
    }
  }

  async handleDrop(
    target: SceneNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    const source = dataTransfer.get(TREE_MIME)?.value as SceneObject[] | undefined;
    // Dropping *onto* a headstone would read as "put it where that used to
    // be", which is not a place: the scene has no such parent to join.
    if (
      !source?.length ||
      (target && (isOperation(target) || isHint(target) || (isObject(target) && target.absent)))
    ) {
      return;
    }
    const scene = source[0].scene;
    const into = target === undefined ? scene : isSceneRoot(target) ? target.doc : target.scene;
    if (!scene || !into) {
      return;
    }
    const parent =
      target === undefined || isSceneRoot(target)
        ? null
        : target.type === 'Collection' && !target.derived
          ? target.id
          : target.parent;
    if (into !== scene) {
      // a drag across scenes copies: one that slipped would otherwise take
      // the object out of its scene (plans/several-scenes.md §5.1)
      await this.copyObjects(scene, source, into, parent);
      return;
    }
    for (const obj of source) {
      if (obj.id !== parent && (obj.parent ?? null) !== parent) {
        await this.moveObject(scene, obj.id, parent); // engine rejects cycles cleanly
      }
    }
  }
}
