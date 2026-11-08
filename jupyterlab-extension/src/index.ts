/**
 * A `.magpy.json` scene opens in JupyterLab as a Magpylib Studio tab: the
 * package's editable notebook widget, in a document of its own
 * (docs/decisions.md, 0058).
 *
 * The kernel runs `SceneWidget(path, editable=True)`, as a notebook cell
 * would, in the document's own session; the tab gets the widget manager
 * JupyterLab makes for a notebook (`registerWidgetManager`, exported), which
 * knows every registered widget module, anywidget's among them. The scene's
 * document goes to JupyterLab's model after each settled edit, over a comm,
 * so JupyterLab does the rest: the unsaved mark, Save, Reload from Disk, its
 * check that the file changed since it was read, autosave. A text the model
 * takes from disk goes back to the kernel as one undo step.
 *
 * One scene per file: a second view of it (New View for File) shows the same
 * widget, and the kernel, the comm and the manager are the file's, not a
 * view's. The views share the widget's height: the last resized sets it.
 */
import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import {
  ISessionContext,
  ISessionContextDialogs,
  showErrorMessage,
  Toolbar,
} from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import {
  ABCWidgetFactory,
  DocumentRegistry,
  DocumentWidget,
  TextModelFactory,
} from '@jupyterlab/docregistry';
import { OutputArea, OutputAreaModel, SimplifiedOutputArea } from '@jupyterlab/outputarea';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Kernel } from '@jupyterlab/services';
import { registerWidgetManager } from '@jupyter-widgets/jupyterlab-manager';
import { Panel } from '@lumino/widgets';

const FILE_TYPE = 'magpylib-scene';
const FACTORY = 'Magpylib Studio';
const COMM = 'magpylib-studio.document';
const WIDGET_VIEW = 'application/vnd.jupyter.widget-view+json';

/** A text model of its own name, so that the tab's document is not the one
 *  Open With › Editor shares: what is typed there is not sent to the scene a
 *  keystroke at a time, and comes in, as from any other editor, when saved. */
class SceneModelFactory extends TextModelFactory {
  get name(): string {
    return FILE_TYPE;
  }
}

/** What the kernel runs for a file: the view of the tab's own text -- saved
 *  or not, so that a restarted kernel draws what the tab holds -- and the
 *  comm its document goes out on whenever an edit settles (`revision`). Its
 *  names are the file's (`name`): two files may share a kernel. A relative
 *  mesh path is relative to the folder the kernel started in, the file's. */
function sceneCode(name: string, text: string, height: number): string {
  return `
import os as _os
from comm import create_comm as _create_comm
from magpylib_studio.widget import SceneWidget as _SceneWidget

${name} = _SceneWidget.from_document(${JSON.stringify(text)}, base_dir=_os.getcwd(), height=${height})
${name}_comm = _create_comm(target_name=${JSON.stringify(`${COMM}.${name}`)})
${name}.observe(lambda _change: ${name}_comm.send({"text": ${name}.document}), "revision")
`;
}

/** The view's height in a tab of `height` pixels: the tab, less the output
 *  area's own margin. */
const viewHeight = (height: number) => Math.max(240, Math.floor(height) - 12);

/** A document's text, the same whatever its spacing and order of keys: two
 *  that read as one scene are one. */
function canonical(text: string): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as object)
              .sort()
              .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
          )
        : value;
  try {
    return JSON.stringify(sorted(JSON.parse(text)));
  } catch {
    return text;
  }
}

/** Run `code` in `kernel`; a Python error comes back as a thrown one. */
async function run(kernel: Kernel.IKernelConnection, code: string): Promise<void> {
  let error: string | undefined;
  const future = kernel.requestExecute({ code, silent: false, store_history: false });
  future.onIOPub = (msg) => {
    if (msg.header.msg_type === 'error') {
      error = (msg.content as { evalue: string }).evalue;
    }
  };
  await future.done;
  if (error !== undefined) {
    throw new Error(error);
  }
}

class SceneTab extends DocumentWidget<Panel> {}

/** The scene of one file, which every view of it shows. */
class Scene {
  private static readonly started = new WeakMap<DocumentRegistry.Context, Promise<Scene>>();

  private readonly views = new Set<{ tab: SceneTab; area: SimplifiedOutputArea }>();
  /** The scene's name in the kernel: the file's own, as two may share one. */
  private readonly name = `__mstudio_${Math.random().toString(36).slice(2, 10)}`;
  /** What the file holds, as far as the tab knows -- the text last read or
   *  written -- in the form a scene compares in (`canonical`). */
  private saved: string;
  /** The text the scene in the kernel holds: what a boot starts from when the
   *  model holds one it refused. */
  private scene: string;
  /** Set while the model takes a document from the kernel. */
  private ours = false;
  /** A file this package could not read: the tab writes nothing over it. */
  private refused = false;
  private height = 640;
  private booting: Promise<void> = Promise.resolve();

  private constructor(
    private readonly context: DocumentRegistry.Context,
    private readonly rendermime: IRenderMimeRegistry,
  ) {
    this.saved = canonical(context.model.toString());
    this.scene = context.model.toString();
  }

  /** The scene of `context`, started once for every view of the file. */
  static of(
    context: DocumentRegistry.Context,
    rendermime: IRenderMimeRegistry,
    firstHeight: number,
  ): Promise<Scene> {
    let scene = Scene.started.get(context);
    if (!scene) {
      scene = Scene.start(context, rendermime, firstHeight);
      Scene.started.set(context, scene);
    }
    return scene;
  }

  private static async start(
    context: DocumentRegistry.Context,
    base: IRenderMimeRegistry,
    firstHeight: number,
  ): Promise<Scene> {
    await context.ready;
    // The document's own session, on the default kernel (`autoStartDefault`:
    // a text file names no language to choose one by), stopped with the file.
    const { sessionContext } = context;
    await sessionContext.ready;
    if (!sessionContext.session?.kernel) {
      throw new Error('no kernel was started for the scene');
    }
    // The widget manager JupyterLab makes for a notebook, with every
    // registered widget module. It reads saved widget state off the model's
    // metadata, which a text document has none of: it is shown a model with
    // none, the rest of the context as it is.
    const rendermime = base.clone();
    const placeholder = rendermime.getFactory(WIDGET_VIEW);
    const widgetContext = Object.create(context, {
      model: {
        value: { getMetadata: () => undefined, setMetadata: () => undefined, dirty: false },
      },
    });
    const managed = registerWidgetManager(widgetContext, rendermime, [][Symbol.iterator]());
    context.disposed.connect(() => managed.dispose());
    // It binds the widget renderer once it has found its kernel, a moment
    // later: an output drawn before then is drawn as text.
    for (let i = 0; i < 100 && rendermime.getFactory(WIDGET_VIEW) === placeholder; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const scene = new Scene(context, rendermime);
    scene.height = firstHeight;
    scene.watch(sessionContext);
    // A scene that cannot be made yet -- a kernel without the package -- is
    // said in the tab, and made when another kernel is chosen.
    scene.boot().catch(() => undefined);
    return scene;
  }

  /** Make the scene in the kernel, and show it in every view: at the start,
   *  and again when the kernel is restarted or another is chosen, which
   *  takes the scene with it. A boot that failed does not stop the next. */
  private boot(): Promise<void> {
    this.booting = this.booting
      .catch(() => undefined)
      .then(async () => {
        const kernel = this.context.sessionContext.session?.kernel;
        if (!kernel) {
          return;
        }
        kernel.registerCommTarget(`${COMM}.${this.name}`, (comm) => {
          comm.onMsg = (msg) => this.took((msg.content.data as { text?: string }).text);
        });
        const text = this.refused ? this.scene : this.context.model.toString();
        try {
          await run(kernel, sceneCode(this.name, text, this.height));
          this.scene = text;
          if (this.refused) {
            await run(kernel, `${this.name}.editable = False`);
          }
        } finally {
          // every view says what came of it: the scene, or the error
          for (const view of this.views) {
            await this.show(view.area);
          }
        }
      });
    return this.booting;
  }

  private watch(sessionContext: ISessionContext): void {
    let restarting = false;
    sessionContext.statusChanged.connect((_, status) => {
      if (status === 'restarting' || status === 'autorestarting') {
        restarting = true;
      } else if (status === 'idle' && restarting) {
        restarting = false;
        this.boot().catch(() => undefined); // said in each view
      }
    });
    sessionContext.kernelChanged.connect((_, { newValue }) => {
      if (newValue) {
        this.boot().catch(() => undefined); // said in each view
      }
    });
    // A text the model took from elsewhere -- Reload from Disk -- goes back to
    // the scene.
    this.context.model.contentChanged.connect(() => {
      if (!this.ours) {
        void this.give(this.context.model.toString());
      }
    });
    this.context.saveState.connect((_, state) => {
      if (state === 'completed') {
        this.saved = canonical(this.context.model.toString());
      }
    });
  }

  /** A document from the kernel, after a settled edit. */
  private took(text: string | undefined): void {
    const { model } = this.context;
    if (typeof text !== 'string' || this.refused) {
      return; // refused, the view is read only: nothing is written over the file
    }
    this.scene = text;
    const now = canonical(text);
    if (now === canonical(model.toString())) {
      return; // the same scene, written another way: nothing to save
    }
    this.ours = true;
    try {
      model.fromString(text);
      // the tab's unsaved mark: off again when the edit is undone
      model.dirty = now !== this.saved;
    } finally {
      this.ours = false;
    }
  }

  /** A document from the file, for the scene, once any boot is done. One
   *  this package cannot read is said, and the view is then read only, so
   *  that nothing is written over the file -- it stays what it is, and the
   *  scene what it was -- until a file it can read is reloaded. */
  private async give(text: string): Promise<void> {
    this.saved = canonical(text);
    await this.booting.catch(() => undefined);
    const kernel = this.context.sessionContext.session?.kernel;
    if (!kernel) {
      return;
    }
    try {
      await run(kernel, `${this.name}.take_document(${JSON.stringify(text)})`);
      if (this.refused) {
        this.refused = false;
        await run(kernel, `${this.name}.editable = True`);
      }
      this.scene = text;
    } catch (err) {
      this.refused = true;
      await run(kernel, `${this.name}.editable = False`).catch(() => undefined);
      void showErrorMessage(
        'Magpylib Studio: the file was not taken in',
        `${err instanceof Error ? err.message : err}\n\nThe view shows the scene it had, ` +
          'read only, and nothing is written over the file until it is reloaded with one ' +
          'this magpylib-studio can read.',
      );
    }
  }

  /** Show the scene in `tab`, following its height. */
  async add(tab: SceneTab): Promise<void> {
    const area = new SimplifiedOutputArea({
      // Trusted, as a notebook's own outputs are: the widget's renderer is
      // not a safe one, and an untrusted output falls back to its text.
      model: new OutputAreaModel({ trusted: true }),
      rendermime: this.rendermime,
    });
    tab.content.addWidget(area);
    const view = { tab, area };
    this.views.add(view);
    tab.disposed.connect(() => this.views.delete(view));
    let sizing: ReturnType<typeof setTimeout> | undefined;
    const sized = new ResizeObserver(() => {
      clearTimeout(sizing);
      sizing = setTimeout(() => {
        const height = viewHeight(tab.content.node.clientHeight);
        const kernel = this.context.sessionContext.session?.kernel;
        if (tab.isDisposed || !tab.content.node.clientHeight || height === this.height || !kernel) {
          return;
        }
        this.height = height;
        run(kernel, `${this.name}.height = ${height}`).catch(() => undefined);
      }, 150);
    });
    sized.observe(tab.content.node);
    tab.disposed.connect(() => {
      sized.disconnect();
      clearTimeout(sizing);
    });
    await this.booting.catch(() => undefined);
    await this.show(area);
  }

  private async show(area: SimplifiedOutputArea): Promise<void> {
    area.model.clear();
    await OutputArea.execute(
      `from IPython.display import display as _display\n_display(${this.name})`,
      area,
      this.context.sessionContext,
    );
  }
}

class SceneFactory extends ABCWidgetFactory<SceneTab> {
  constructor(
    options: DocumentRegistry.IWidgetFactoryOptions<SceneTab>,
    private readonly rendermime: IRenderMimeRegistry,
    private readonly dialogs: ISessionContext.IDialogs | null,
  ) {
    super(options);
  }

  protected createNewWidget(context: DocumentRegistry.Context): SceneTab {
    const content = new Panel();
    content.addClass('mstudio-scene-tab');
    content.node.style.overflow = 'hidden';
    const tab = new SceneTab({ context, content });
    // The scene's kernel, as a notebook's toolbar shows it: its name, which
    // picks another -- one with magpylib-studio, where the default has none
    // -- a restart, and whether it is busy. The scene is made again in it.
    const { sessionContext } = context;
    const dialogs = this.dialogs ?? undefined;
    tab.toolbar.addItem('spacer', Toolbar.createSpacerItem());
    tab.toolbar.addItem('restart', Toolbar.createRestartButton(sessionContext, dialogs));
    tab.toolbar.addItem('kernelName', Toolbar.createKernelNameItem(sessionContext, dialogs));
    tab.toolbar.addItem('kernelStatus', Toolbar.createKernelStatusItem(sessionContext));
    Scene.of(context, this.rendermime, viewHeight(content.node.clientHeight || 652))
      .then((scene) => scene.add(tab))
      .catch((err: unknown) => {
        content.node.textContent = `Magpylib Studio cannot draw this scene: ${
          err instanceof Error ? err.message : err
        }`;
      });
    return tab;
  }
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'magpylib-studio-jupyterlab:scene',
  description: 'Open a .magpy.json scene as a Magpylib Studio tab.',
  autoStart: true,
  requires: [IRenderMimeRegistry],
  optional: [ISessionContextDialogs],
  activate: (
    app: JupyterFrontEnd,
    rendermime: IRenderMimeRegistry,
    dialogs: ISessionContext.IDialogs | null,
  ) => {
    app.docRegistry.addModelFactory(new SceneModelFactory());
    app.docRegistry.addFileType({
      name: FILE_TYPE,
      displayName: 'Magpylib scene',
      extensions: ['.magpy.json'],
      mimeTypes: ['application/json'],
      contentType: 'file',
      fileFormat: 'text',
    });
    app.docRegistry.addWidgetFactory(
      new SceneFactory(
        {
          name: FACTORY,
          fileTypes: [FILE_TYPE],
          defaultFor: [FILE_TYPE],
          modelName: FILE_TYPE,
          preferKernel: true,
          canStartKernel: true,
          autoStartDefault: true, // a text file names no language to pick one by
          shutdownOnClose: true, // the scene's kernel is the file's
        },
        rendermime,
        dialogs,
      ),
    );
  },
};

export default plugin;
