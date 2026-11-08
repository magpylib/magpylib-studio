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
 * view's.
 */
import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ISessionContext, showErrorMessage } from '@jupyterlab/apputils';
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

/** What the kernel runs for a file: the view, and the comm its document goes
 *  out on whenever an edit settles (`revision`). */
function sceneCode(name: string, height: number): string {
  return `
from comm import create_comm as _create_comm
from magpylib_studio.widget import SceneWidget as _SceneWidget

__mstudio = _SceneWidget(${JSON.stringify(name)}, editable=True, height=${height})
__mstudio_comm = _create_comm(target_name=${JSON.stringify(COMM)})
__mstudio.observe(lambda _change: __mstudio_comm.send({"text": __mstudio.document}), "revision")
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
  /** The text last read or written: what the file holds, as far as the tab knows. */
  private saved: string;
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
    this.saved = context.model.toString();
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
    await scene.boot();
    return scene;
  }

  /** Make the scene in the kernel, and show it in every view: at the start,
   *  and again when the kernel is restarted or another is chosen, which
   *  takes the scene with it. */
  private boot(): Promise<void> {
    this.booting = this.booting.then(async () => {
      const kernel = this.context.sessionContext.session?.kernel;
      if (!kernel) {
        return;
      }
      kernel.registerCommTarget(COMM, (comm) => {
        comm.onMsg = (msg) => this.took((msg.content.data as { text?: string }).text);
      });
      await run(kernel, sceneCode(PathExt.basename(this.context.path), this.height));
      for (const view of this.views) {
        await this.show(view.area);
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
        this.boot().catch((err) => this.say(err));
      }
    });
    sessionContext.kernelChanged.connect((_, { newValue }) => {
      if (newValue) {
        this.boot().catch((err) => this.say(err));
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
        this.saved = this.context.model.toString();
      }
    });
  }

  /** A document from the kernel, after a settled edit. */
  private took(text: string | undefined): void {
    const { model } = this.context;
    if (typeof text !== 'string' || this.refused) {
      return;
    }
    if (canonical(text) === canonical(model.toString())) {
      return; // the same scene, written another way: nothing to save
    }
    this.ours = true;
    try {
      model.fromString(text);
      // the tab's unsaved mark: off again when the edit is undone
      model.dirty = canonical(text) !== canonical(this.saved);
    } finally {
      this.ours = false;
    }
  }

  /** A document from the file, for the scene. One this package cannot read
   *  is said, and the tab then writes nothing over it: the file stays what
   *  it is, and the scene what it was. */
  private async give(text: string): Promise<void> {
    this.saved = text;
    const kernel = this.context.sessionContext.session?.kernel;
    if (!kernel) {
      return;
    }
    try {
      await run(kernel, `__mstudio.take_document(${JSON.stringify(text)})`);
      this.refused = false;
    } catch (err) {
      this.refused = true;
      void showErrorMessage(
        'Magpylib Studio: the file was not taken in',
        `${err instanceof Error ? err.message : err}\n\nThe tab shows the scene it had, ` +
          'and writes nothing over the file until it is reloaded with one it can read.',
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
    new ResizeObserver(() => {
      clearTimeout(sizing);
      sizing = setTimeout(() => {
        const height = viewHeight(tab.content.node.clientHeight);
        const kernel = this.context.sessionContext.session?.kernel;
        if (tab.isDisposed || !tab.content.node.clientHeight || height === this.height || !kernel) {
          return;
        }
        this.height = height;
        run(kernel, `__mstudio.height = ${height}`).catch(() => undefined);
      }, 150);
    }).observe(tab.content.node);
    await this.booting;
    await this.show(area);
  }

  private async show(area: SimplifiedOutputArea): Promise<void> {
    area.model.clear();
    await OutputArea.execute(
      'from IPython.display import display as _display\n_display(__mstudio)',
      area,
      this.context.sessionContext,
    );
  }

  private say(err: unknown): void {
    void showErrorMessage(
      'Magpylib Studio: the scene could not be drawn again',
      String(err instanceof Error ? err.message : err),
    );
  }
}

class SceneFactory extends ABCWidgetFactory<SceneTab> {
  constructor(
    options: DocumentRegistry.IWidgetFactoryOptions<SceneTab>,
    private readonly rendermime: IRenderMimeRegistry,
  ) {
    super(options);
  }

  protected createNewWidget(context: DocumentRegistry.Context): SceneTab {
    const content = new Panel();
    content.addClass('mstudio-scene-tab');
    content.node.style.overflow = 'hidden';
    const tab = new SceneTab({ context, content });
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
  activate: (app: JupyterFrontEnd, rendermime: IRenderMimeRegistry) => {
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
      ),
    );
  },
};

export default plugin;
