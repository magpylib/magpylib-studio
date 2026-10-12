"""Scripts run outside the engine (`magpylib_studio.runner`): what one does to
its own process stays there, and the open scene is left as it was."""

import magpylib as magpy

from magpylib_studio import session as session_module
from magpylib_studio.session import MagpylibStudioSession
from tests.test_meshes import cube_stl  # noqa: F401


def opened():
    session = MagpylibStudioSession()
    session.load_example("pair")
    return session


def script(tmp_path, text):
    path = tmp_path / "script.py"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_a_script_that_never_returns_is_stopped(tmp_path, monkeypatch):
    monkeypatch.setattr(session_module, "SCRIPT_SECONDS", 2)
    session = opened()
    before = session.to_dict()
    result = session.load_script(script(tmp_path, "while True:\n    pass\n"))
    assert result["ok"] is False
    assert "still running after 2 s" in result["error"]
    assert session.to_dict() == before


def test_a_script_that_ends_its_process_ends_only_its_own(tmp_path):
    session = opened()
    result = session.load_script(script(tmp_path, "import os\nos._exit(3)\n"))
    assert result["ok"] is False
    assert "ended its process (exit code 3)" in result["error"]
    assert session.list_objects()  # the engine, and its scene, carry on


def test_a_script_that_exits_says_so(tmp_path):
    session = opened()
    result = session.load_script(script(tmp_path, "import sys\nsys.exit(2)\n"))
    assert result["ok"] is False
    assert "exited with 2" in result["error"]


def test_what_a_script_sets_on_magpylib_stays_in_its_process(tmp_path):
    """`magpy.defaults` is the process's: set by a script run here, it was
    every scene's from then on."""
    was = magpy.defaults.display.style.magnet.magnetization.show
    text = (
        "import magpylib as magpy\n"
        f"magpy.defaults.display.style.magnet.magnetization.show = {not was}\n"
        "magpy.show(magpy.magnet.Cuboid(dimension=(1, 1, 1), polarization=(0, 0, 1)))\n"
    )
    assert opened().load_script(script(tmp_path, text))["ok"]
    assert magpy.defaults.display.style.magnet.magnetization.show == was


def test_what_a_script_prints_is_its_own(tmp_path, capfd):
    """On stderr: stdout is the channel the engine answers on."""
    text = (
        "import magpylib as magpy\n"
        "print('hello from the script')\n"
        "magpy.show(magpy.magnet.Cuboid(dimension=(1, 1, 1), polarization=(0, 0, 1)))\n"
    )
    assert opened().load_script(script(tmp_path, text))["ok"]
    printed = capfd.readouterr()
    assert "hello from the script" in printed.err
    assert "hello from the script" not in printed.out


def test_a_part_a_script_reads_is_checked_once(tmp_path, cube_stl):  # noqa: F811
    """The meshes the script's process resolved come back to the engine, and
    go with the next script: a part is checked once, not on every save."""
    (tmp_path / "cube.stl").write_bytes(cube_stl.read_bytes())
    text = (
        "import magpylib as magpy\n"
        "from magpylib_studio import TriangularMesh, scene\n"
        "@scene\n"
        "def design():\n"
        "    part = TriangularMesh.from_file(\n"
        "        path='cube.stl', scale=0.001, polarization=(0, 0, 1)\n"
        "    )\n"
    )
    session = MagpylibStudioSession()
    assert session.load_script(script(tmp_path, text))["ok"]
    assert len(session._mesh_cache) == 1
    key = next(iter(session._mesh_cache))
    assert key[0] == "file" and key[1].endswith("cube.stl")


def test_a_script_given_less_time_is_stopped_sooner(tmp_path):
    session = opened()
    result = session.load_script(script(tmp_path, "while True:\n    pass\n"), timeout=1)
    assert result["ok"] is False
    assert "still running after 1 s" in result["error"]


def test_what_reaches_stdout_besides_the_answer_is_not_taken_for_it(tmp_path):
    """Output a C library writes past Python's print, without a newline."""
    text = (
        "import os\n"
        "import magpylib as magpy\n"
        "os.write(1, b'noise without a newline')\n"
        "magpy.show(magpy.magnet.Cuboid(dimension=(1, 1, 1), polarization=(0, 0, 1)))\n"
    )
    assert opened().load_script(script(tmp_path, text))["ok"]
