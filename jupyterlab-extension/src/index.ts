/**
 * Prototype: a `.magpy.json` scene opens in JupyterLab as a Magpylib Studio
 * tab -- the package's editable notebook widget, in a document of its own.
 *
 * What it tries: whether JupyterLab can be a studio host with a thin shell.
 * The kernel runs `SceneWidget(path, editable=True)`, as a notebook cell
 * would, in the document's own kernel; the tab gets the widget manager
 * JupyterLab makes for a notebook (`registerWidgetManager`, exported), which
 * knows every registered widget module, anywidget's among them. The scene's
 * document goes to JupyterLab's own model after each settled edit, over a
 * comm, so JupyterLab does the rest: the unsaved mark, Save, Revert, the file
 * changed on disk, autosave. A revert, or the file reloaded, goes back to the
 * kernel as one undo step.
 */
import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { PathExt } from '@jupyterlab/coreutils';
import {
  ABCWidgetFactory,
  DocumentRegistry,
  DocumentWidget,
} from '@jupyterlab/docregistry';
import { OutputArea, OutputAreaModel, SimplifiedOutputArea } from '@jupyterlab/outputarea';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { registerWidgetManager } from '@jupyter-widgets/jupyterlab-manager';

const WIDGET_VIEW = 'application/vnd.jupyter.widget-view+json';
import { Panel } from '@lumino/widgets';

const FILE_TYPE = 'magpylib-scene';
const FACTORY = 'Magpylib Studio';
const COMM = 'magpylib-studio.document';

/** What the kernel runs for a tab: the view, and the comm its document goes
 *  out on whenever an edit settles (`revision`). `__mstudio_take` puts a
 *  document the tab was given -- a revert, the file reloaded -- back into the
 *  scene, as one undo step. */
function kernelCode(name: string): string {
  return `
import json as _json
from comm import create_comm as _create_comm
from IPython.display import display as _display
from magpylib_studio.widget import SceneWidget as _SceneWidget

__mstudio = _SceneWidget(${JSON.stringify(name)}, editable=True, height=640)
__mstudio_comm = _create_comm(target_name=${JSON.stringify(COMM)})

def __mstudio_text():
    return _json.dumps(__mstudio._editing("save").to_dict(), indent=2) + "\\n"

def __mstudio_sync(_change=None):
    __mstudio_comm.send({"text": __mstudio_text()})

def __mstudio_take(text):
    if text == __mstudio_text():
        return
    session = __mstudio._editing("revert")
    result = session.replace_scene(_json.loads(text), label="changed on disk")
    if not result.get("ok"):
        raise ValueError(result.get("error"))
    __mstudio._show({"by": "replace"})

__mstudio.observe(__mstudio_sync, "revision")
_display(__mstudio)
`;
}

class SceneTab extends DocumentWidget<Panel> {}

class SceneFactory extends ABCWidgetFactory<SceneTab> {
  constructor(
    options: DocumentRegistry.IWidgetFactoryOptions<SceneTab>,
    private readonly app: JupyterFrontEnd,
    private readonly rendermime: IRenderMimeRegistry,
  ) {
    super(options);
  }

  protected createNewWidget(context: DocumentRegistry.Context): SceneTab {
    const content = new Panel();
    content.addClass('mstudio-scene-tab');
    content.node.style.overflow = 'auto';
    const tab = new SceneTab({ context, content });
    this.start(context, tab).catch((err: unknown) => {
      content.node.textContent = `Magpylib Studio cannot draw this scene: ${err}`;
    });
    return tab;
  }

  private async start(context: DocumentRegistry.Context, tab: SceneTab): Promise<void> {
    // The document's own session: the factory prefers a kernel, so JupyterLab
    // starts one where the file is, and shuts it down with the tab.
    const { sessionContext } = context;
    await context.ready;
    // A text document's session is not started for it, and has no language to
    // choose a kernel by: started here, on the default kernel.
    await sessionContext.initialize();
    if (!sessionContext.session?.kernel) {
      const specs = this.app.serviceManager.kernelspecs;
      await specs.ready;
      await sessionContext.changeKernel({ name: specs.specs?.default ?? 'python3' });
    }
    const kernel = sessionContext.session?.kernel;
    if (!kernel) {
      throw new Error('no kernel for the scene');
    }

    // The widget manager JupyterLab makes for a notebook, with every
    // registered widget module. It reads saved widget state off the model's
    // metadata, which a text document has none of: it is shown a model with
    // none, the rest of the context as it is.
    const rendermime = this.rendermime.clone();
    const widgetContext = Object.create(context, {
      model: {
        value: { getMetadata: () => undefined, setMetadata: () => undefined, dirty: false },
      },
    });
    const placeholder = rendermime.getFactory(WIDGET_VIEW);
    const managed = registerWidgetManager(widgetContext, rendermime, [][Symbol.iterator]());
    tab.disposed.connect(() => managed.dispose());
    // It binds the widget renderer once it has found its kernel, a moment
    // later: an output drawn before then is drawn as text.
    for (let i = 0; i < 100 && rendermime.getFactory(WIDGET_VIEW) === placeholder; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // The scene's document, into JupyterLab's model, after each settled edit.
    let ours = false;
    kernel.registerCommTarget(COMM, (comm) => {
      comm.onMsg = (msg) => {
        const text = (msg.content.data as { text?: string }).text;
        if (typeof text === 'string' && text !== context.model.toString()) {
          ours = true;
          context.model.fromString(text);
          context.model.dirty = true; // the tab's unsaved mark
          ours = false;
        }
      };
    });
    // A text the model took from elsewhere -- Revert, the file reloaded --
    // goes back to the scene.
    context.model.contentChanged.connect(() => {
      if (ours) {
        return;
      }
      const text = context.model.toString();
      void kernel.requestExecute({
        code: `__mstudio_take(${JSON.stringify(text)})`,
        silent: true,
        store_history: false,
      }).done;
    });

    // Trusted, as a notebook's own outputs are: the widget's renderer is not a
    // safe one, and an untrusted output falls back to its text.
    const area = new SimplifiedOutputArea({
      model: new OutputAreaModel({ trusted: true }),
      rendermime,
    });
    tab.content.addWidget(area);
    await OutputArea.execute(kernelCode(PathExt.basename(context.path)), area, sessionContext);
  }
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'magpylib-studio-jupyterlab:scene',
  description: 'Open a .magpy.json scene as a Magpylib Studio tab.',
  autoStart: true,
  requires: [IRenderMimeRegistry],
  activate: (app: JupyterFrontEnd, rendermime: IRenderMimeRegistry) => {
    app.docRegistry.addFileType({
      name: FILE_TYPE,
      displayName: 'Magpylib scene',
      extensions: ['.magpy.json'],
      mimeTypes: ['application/json'],
      contentType: 'file',
      fileFormat: 'text',
    });
    const factory = new SceneFactory(
      {
        name: FACTORY,
        fileTypes: [FILE_TYPE],
        defaultFor: [FILE_TYPE],
        modelName: 'text',
        preferKernel: true,
        canStartKernel: true,
        shutdownOnClose: true, // the scene's kernel is the tab's
      },
      app,
      rendermime,
    );
    app.docRegistry.addWidgetFactory(factory);
  },
};

export default plugin;
