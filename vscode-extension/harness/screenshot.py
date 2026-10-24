"""The Python half of `screenshot.mjs`.

    python harness/screenshot.py scene OUT EXAMPLE
    python harness/screenshot.py join FRAMES COUNT X Y PNG GIF

``scene`` writes OUT, a ``.magpy.json``: the Halbach design of the marimo
notebook EXAMPLE, its cell run alone, its ``density`` at the top of its slider
and the field lines on. Denser than that, the pixels are closer than the view
fills the plane with lines in its 400 (``FIELD_LINES_MOST``), which then stop
short of the rings.

``join`` cuts each pair FRAMES/dark-K.png, FRAMES/light-K.png (K from 0 to
COUNT - 1, one period of the flow) along a diagonal through X, Y (fractions of
the width and height): light to its left, dark to its right. The first pair
becomes PNG in 256 colours, and every pair a frame of GIF, smaller, one palette
for all, looping.
"""

import ast
import json
import pathlib
import sys
from typing import Annotated

#: The flow's period, as `scene3d.mjs` runs it: 0.8 pulses a second.
PERIOD_MS = 1250
#: The GIF's width; the picture is 2400 wide. A README shows it about 880
#: wide, twice that on a sharp screen.
GIF_WIDTH = 1600
#: How far the cut leans: its foot this fraction of the width left of its top.
LEAN = 0.2


def scene(out, example):
    import magpylib as magpy

    import magpylib_studio

    # the cell that defines `halbach`, run as a script with what marimo
    # would hand it
    cell = next(
        node
        for node in ast.parse(example.read_text()).body
        if isinstance(node, ast.FunctionDef)
        and any(
            isinstance(inner, ast.FunctionDef) and inner.name == "halbach"
            for inner in node.body
        )
    )
    given = {"Annotated": Annotated, "magpy": magpy}
    names = {
        arg.arg: given.get(arg.arg) or getattr(magpylib_studio, arg.arg)
        for arg in cell.args.args
    }
    body = [node for node in cell.body if not isinstance(node, ast.Return)]
    exec(compile(ast.Module(body, []), example, "exec"), names)  # noqa: S102
    session = names["halbach"].build().session
    session.set_variable(
        "density", session.to_dict()["variable_bounds"]["density"]["soft_max"]
    )
    session.set_field_lines(True)
    out.write_text(json.dumps(session.to_dict(), indent=2))


def join(frames, count, x, y, png, gif):
    from PIL import Image, ImageDraw

    def cut(k):
        dark = Image.open(frames / f"dark-{k}.png").convert("RGB")
        light = Image.open(frames / f"light-{k}.png").convert("RGB")
        return Image.composite(light, dark, mask)

    w, h = Image.open(frames / "dark-0.png").size
    # drawn at four times the size and reduced, so the cut's edge is smooth
    s = 4
    top = (x + LEAN * y) * w * s
    foot = (x - LEAN * (1 - y)) * w * s
    mask = Image.new("L", (w * s, h * s), 0)
    ImageDraw.Draw(mask).polygon(
        [(0, 0), (top, 0), (foot, h * s), (0, h * s)], fill=255
    )
    mask = mask.resize((w, h), Image.Resampling.LANCZOS)

    first = cut(0)
    first.quantize(
        256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG
    ).save(png, optimize=True)

    size = (GIF_WIDTH, round(h * GIF_WIDTH / w))
    shown = [first.resize(size, Image.Resampling.LANCZOS)]
    shown += [cut(k).resize(size, Image.Resampling.LANCZOS) for k in range(1, count)]
    # one palette from three frames side by side, and no dithering: what
    # stands still is then the same in every frame, and the GIF stores only
    # what moves
    sample = Image.new("RGB", (size[0] * 3, size[1]))
    for i, k in enumerate((0, count // 3, 2 * count // 3)):
        sample.paste(shown[k], (i * size[0], 0))
    palette = sample.quantize(256, method=Image.Quantize.MEDIANCUT)
    indexed = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in shown]
    indexed[0].save(
        gif,
        save_all=True,
        append_images=indexed[1:],
        duration=round(PERIOD_MS / count / 10) * 10,
        loop=0,
    )


if __name__ == "__main__":
    command, *args = sys.argv[1:]
    if command == "scene":
        scene(pathlib.Path(args[0]), pathlib.Path(args[1]))
    else:
        frames, count, x, y, png, gif = args
        join(pathlib.Path(frames), int(count), float(x), float(y), png, gif)
