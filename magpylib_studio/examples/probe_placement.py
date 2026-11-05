"""A probe over a magnet, and the patch it might land in.

A Hall sensor is never placed exactly where the drawing says: it lands somewhere
within a tolerance. Whether a design meets its spec depends on how much the
field varies across that patch. Here the probe's pixels are that patch,
`tolerance` either side of the nominal place, and each pixel is an arrow
coloured by what it reads. `gap` is measured from the magnet's face, as an air
gap is quoted.
"""

from typing import Annotated

import magpylib as magpy

from magpylib_studio import Length, scene

_STEPS = [k / 3 for k in range(-3, 4)]  # 7 across, -1 to 1

TITLE = "Probe placement"
SUMMARY = (
    "A probe over a magnet and the patch it might be misplaced within, coloured "
    "by the field — drag the tolerance and read what it costs"
)


@scene
def probe_placement(
    mag: Annotated[float, Length(0.0005, 0.1, slider=(0.005, 0.03))] = 0.01,
    gap: Annotated[float, Length(0.0002, 0.05, slider=(0.001, 0.02))] = 0.005,
    tolerance: Annotated[float, Length(0.0001, 0.02, slider=(0.0005, 0.006))] = 0.002,
):
    """A cube of side `mag`, and a 7 by 7 patch of pixels `gap` above its
    face, `tolerance` either side of the axis."""
    magnet = magpy.magnet.Cuboid(
        dimension=(mag, mag, mag), polarization=(0, 0, 1.3), style_label="Magnet"
    )
    probe = magpy.Sensor(
        position=(0, 0, mag / 2 + gap),
        # rows of pixels, not a run of points: a field map reads it as a grid
        pixel=[[(u * tolerance, v * tolerance, 0) for u in _STEPS] for v in _STEPS],
        style={
            "label": "Where the probe might sit",
            "pixel": {
                "field": {"source": "B", "symbol": "arrow3d", "colormap": "Viridis"}
            },
        },
    )
    return magnet, probe
