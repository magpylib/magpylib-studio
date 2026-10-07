"""Edit a scene with the package alone, as someone who only pip-installed it.

    python tools/check-package-alone.py

Run by CI's `package alone` job, from outside the checkout, in an environment
where the wheel is all there is of this repository: no node, no
`vscode-extension/`, and nothing of the source tree on the path. The editable
widget has to work there (`docs/editable-widget.md` §2), and a dependency on
the extension that crept in -- a file the bundle fetches, a module only the
checkout has -- would pass every other check, because every other check runs
in the checkout.

Only the python half can be driven here, and it is: the view's calls go to
`SceneWidget._on_message` as the kernel connection would deliver them. The
browser half is `check-widget-browser.mjs`'s; what it is handed is the bundle
this checks the wheel carries.
"""

import pathlib
import sys

import magpylib as magpy

import magpylib_studio
from magpylib_studio.widget import SceneWidget


def fail(message):
    sys.exit(f"check-package-alone: {message}")


package = pathlib.Path(magpylib_studio.__file__).resolve().parent
if "site-packages" not in package.parts:
    fail(f"magpylib_studio came from {package}, not from an installed wheel")
for name in ("widget.js", "widget.css"):
    if not (package / "static" / name).is_file():
        fail(f"the wheel has no static/{name}")
# The agent skill ships inside the package, where `uvx library-skills` looks
# for it; a dot-folder is the kind of thing a build backend quietly leaves out.
skill = package / ".agents" / "skills" / "magpylib-studio"
for name in ("SKILL.md", "references/api.md"):
    if not (skill / name).is_file():
        fail(f"the wheel has no .agents/skills/magpylib-studio/{name}")

magnet = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01))
probe = magpy.Sensor(position=(0, 0, 0.02))
studio = SceneWidget(magnet, probe, editable=True)

sent = []
studio.send = lambda message, buffers=None: sent.append(message)


def ask(method, **params):
    request = {"kind": "rpc", "id": len(sent), "method": method, "params": params}
    studio._on_message(studio, request, [])
    answer = sent[-1]
    if "error" in answer:
        fail(f"{method}: {answer['error']}")
    return answer["result"]


revision = studio.revision
ask("begin_interaction")
for x in (0.005, 0.01):
    ask("apply_edits", edits=[{"objectId": "probe", "position": [x, 0, 0.02]}])
ask("end_interaction")
if list(studio.objects["probe"].position) != [0.01, 0, 0.02]:
    fail(f"the drag left the probe at {studio.objects['probe'].position}")
if studio.revision != revision + 1:
    fail("the notebook was not told of the drag once, at its end")
if "probe.position = (0.01, 0.0, 0.02)" not in studio.to_script():
    fail("the script does not say the probe moved")
ask("undo")
if list(studio.objects["probe"].position) != [0, 0, 0.02]:
    fail("undo did not take the drag back")
if "magpy-widget" not in studio.to_html():
    fail("a saved page does not carry the widget")
print(f"check-package-alone: a scene edited with {package} alone")
