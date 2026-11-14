import ast
import dataclasses
import functools
import hashlib
import inspect
import os
import pathlib
import sys
import typing

import magpylib as magpy
import numpy as np
from scipy.spatial.transform import Rotation

from magpylib_studio import choose, scene

TITLE = "Magnet balls, let go"

#: The toy's balls: 5 mm of NdFeB, magnetized along a diameter, 0.5 g each.
DIAMETER = 0.005
POLARIZATION = 1.2
DENSITY = 7500.0
MU0 = 4e-7 * np.pi

#: The runs the scene plays, by name: how many balls, and the seed that
#: scatters them. Worked out the first time the scene opens, and kept in
#: the user's cache (`runs`).
RUNS = {"eight": (8, 0), "twelve": (12, 2)}


@dataclasses.dataclass
class Run:
    """Balls let go: at each of `times`, where each one is and how it is
    turned, and the energy then, in joules: moving, and magnetic."""

    times: np.ndarray  # (f,)
    positions: np.ndarray  # (f, n, 3)
    turns: np.ndarray  # (f, n, 4): scipy quaternions turning +z to the pole
    kinetic: np.ndarray  # (f,)
    magnetic: np.ndarray  # (f,)


def _qmul(a, b):
    """Hamilton products of quaternions (..., 4) written (w, x, y, z)."""
    w1, x1, y1, z1 = np.moveaxis(a, -1, 0)
    w2, x2, y2, z2 = np.moveaxis(b, -1, 0)
    return np.stack(
        [
            w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
            w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
            w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
            w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        ],
        axis=-1,
    )


def _turned(q, v):
    """`v` turned by the unit quaternions `q` (w, x, y, z)."""
    w, xyz = q[..., :1], q[..., 1:]
    t = 2 * np.cross(xyz, v)
    return v + w * t + np.cross(xyz, t)


def pull(positions, moments):
    """The force and torque on each ball from all the others, and the field
    at its centre, for balls at `positions` with magnetic `moments` (n, 3).

    Outside a uniformly magnetized sphere the field is a point dipole's, and
    a sphere's energy in a field from outside it is its moment against the
    field at its centre, so these are exact for balls -- what magpylib's
    `getFT` gives, which the tests check -- and quick enough to call at every
    step of a run."""
    r = positions[None, :, :] - positions[:, None, :]  # r[i, j]: from i to j
    d = np.linalg.norm(r, axis=-1)
    np.fill_diagonal(d, np.inf)
    n = r / d[..., None]
    mi, mj = moments[:, None, :], moments[None, :, :]
    mi_n = np.sum(mi * n, -1)[..., None]
    mj_n = np.sum(mj * n, -1)[..., None]
    mi_mj = np.sum(mi * mj, -1)[..., None]
    on_j = (
        3
        * MU0
        / (4 * np.pi * d[..., None] ** 4)
        * (mi * mj_n + mj * mi_n + n * mi_mj - 5 * n * mi_n * mj_n)
    )
    field = np.sum(MU0 / (4 * np.pi * d[..., None] ** 3) * (3 * n * mi_n - mi), axis=0)
    return np.sum(on_j, axis=0), np.cross(moments, field), field


def let_go(
    positions,
    poles,
    *,
    duration,
    frames=200,
    friction=0.3,
    restitution=0.3,
    rolling=0.01,
    gravity=9.81,
):
    """Balls let go at rest on a table, at `positions` (n, 3), each north
    pole pointing along `poles` (n, 3), followed for `duration` seconds and
    sampled at `frames` even times.

    A ball is pushed and turned by the others (`pull`), pressed on the table
    by its weight, and where it touches the table or another ball, a stiff
    spring keeps them apart and friction drags on the slip between them;
    rolling costs a little too, so the balls come to rest. The spring lets a
    ball sink a few hundredths of a millimetre into another, which the
    frames take back: in them, balls that touch just touch."""
    x = np.array(positions, dtype=float)
    u = np.array(poles, dtype=float)
    u /= np.linalg.norm(u, axis=1, keepdims=True)
    radius = DIAMETER / 2
    volume = np.pi / 6 * DIAMETER**3
    mass = DENSITY * volume
    inertia = 0.4 * mass * radius**2
    moment = POLARIZATION * volume / MU0
    stiffness = 6e4  # N/m: sunk 0.07 mm under the 4 N two balls pull with
    log_e = np.log(restitution)
    damping = -2 * log_e * np.sqrt(stiffness * mass / 2) / np.hypot(np.pi, log_e)
    dt = 0.15 * np.sqrt(mass / stiffness)

    # each ball's turn from +z to its pole, as a quaternion (w, x, y, z)
    z = np.array([0.0, 0.0, 1.0])
    axis = np.cross(z, u)
    sin = np.linalg.norm(axis, axis=1)
    half = np.arctan2(sin, u @ z) / 2
    axis = np.where(
        sin[:, None] > 1e-12, axis / np.maximum(sin, 1e-12)[:, None], [1, 0, 0]
    )
    q = np.concatenate([np.cos(half)[:, None], np.sin(half)[:, None] * axis], axis=1)
    v = np.zeros_like(x)
    w = np.zeros_like(x)
    down = np.array([0.0, 0.0, -radius])

    steps = round(duration / dt)
    sample = np.round(np.linspace(0, steps, frames)).astype(int)
    record = {"times": [], "positions": [], "turns": [], "kinetic": [], "magnetic": []}
    at = 0
    for step in range(steps + 1):
        m = moment * _turned(q, z)
        force, torque, field = pull(x, m)
        # balls on balls
        r = x[None, :, :] - x[:, None, :]
        d = np.linalg.norm(r, axis=-1)
        np.fill_diagonal(d, np.inf)
        i, j = np.nonzero(np.triu(d < DIAMETER, 1))
        if len(i):
            n = r[i, j] / d[i, j, None]
            dv = v[j] - v[i]
            vn = np.sum(dv * n, -1)
            fn = np.maximum(stiffness * (DIAMETER - d[i, j]) - damping * vn, 0)
            slip = dv - vn[:, None] * n - np.cross(w[i] + w[j], n) * radius
            ft = _friction(slip, friction * fn, mass / 4 / dt)
            on_j = fn[:, None] * n + ft
            np.add.at(force, j, on_j)
            np.add.at(force, i, -on_j)
            np.add.at(torque, j, np.cross(-radius * n, ft))
            np.add.at(torque, i, np.cross(radius * n, -ft))
            roll = w[j] - w[i]
            resist = _rolling(roll, rolling * fn * radius)
            np.add.at(torque, j, resist)
            np.add.at(torque, i, -resist)
        # balls on the table
        force[:, 2] -= mass * gravity
        on = x[:, 2] < radius
        if np.any(on):
            fn = np.maximum(stiffness * (radius - x[on, 2]) - damping * v[on, 2], 0)
            slip = v[on] + np.cross(w[on], down)
            slip[:, 2] = 0
            ft = _friction(slip, friction * fn, mass / 2 / dt)
            force[on, 2] += fn
            force[on] += ft
            torque[on] += np.cross(down, ft) + _rolling(w[on], rolling * fn * radius)
        if step == sample[at]:
            record["times"].append(step * dt)
            record["positions"].append(_just_touching(x))
            record["turns"].append(q[:, [1, 2, 3, 0]].copy())
            record["kinetic"].append(
                0.5 * mass * np.sum(v**2) + 0.5 * inertia * np.sum(w**2)
            )
            record["magnetic"].append(-0.5 * np.sum(m * field))
            at += 1
        v += force / mass * dt
        w += torque / inertia * dt
        x += v * dt
        angle = np.linalg.norm(w, axis=1) * dt
        spin = w * dt / np.maximum(angle, 1e-300)[:, None]
        dq = np.concatenate(
            [np.cos(angle / 2)[:, None], np.sin(angle / 2)[:, None] * spin], axis=1
        )
        q = _qmul(dq, q)
        q /= np.linalg.norm(q, axis=1, keepdims=True)
    return Run(**{key: np.array(value) for key, value in record.items()})


def _friction(slip, most, stop):
    """Friction against `slip` (k, 3): at most `most` (Coulomb), and no more
    than stops it in one step (`stop` times its speed), so a ball at rest
    stays put rather than jittering."""
    speed = np.linalg.norm(slip, axis=-1)
    size = np.minimum(most, stop * speed)
    return -size[:, None] * slip / np.maximum(speed, 1e-12)[:, None]


def _rolling(spin, most):
    """Rolling resistance against `spin` (k, 3), at most `most`, smoothed
    near rest."""
    return -most[:, None] * spin / (np.linalg.norm(spin, axis=-1, keepdims=True) + 1e-2)


def _just_touching(x, rounds=500):
    """`x` with balls that sink into each other or the table pushed back to
    just touching -- a few hundredths of a millimetre, the spring's give.
    Magpylib adds the magnetizations where magnets overlap, and the studio
    says so, which a contact is not."""
    x = x.copy()
    gap = 1e-7  # above the studio's overlap tolerance
    radius = DIAMETER / 2
    for _ in range(rounds):
        low = x[:, 2] < radius + gap
        x[low, 2] = radius + 2 * gap
        r = x[None, :, :] - x[:, None, :]
        d = np.linalg.norm(r, axis=-1)
        np.fill_diagonal(d, np.inf)
        i, j = np.nonzero(np.triu(d < DIAMETER + gap, 1))
        if not len(i) and not np.any(low):
            break
        for a, b in zip(i, j, strict=True):
            n = (x[b] - x[a]) / np.linalg.norm(x[b] - x[a])
            short = DIAMETER + 2 * gap - np.linalg.norm(x[b] - x[a])
            if short <= 0:
                continue
            x[a] -= short / 2 * n
            x[b] += short / 2 * n
    return x


# --- the start --------------------------------------------------------------------


def scattered(count=8, seed=0, spread=0.03):
    """`count` balls dropped at random on the table, at least a ball's
    width apart, each pointing its own way along the table."""
    rng = np.random.default_rng(seed)
    spots = []
    for _ in range(1000 * count):
        if len(spots) == count:
            break
        spot = rng.uniform(-spread, spread, 2)
        if all(np.linalg.norm(spot - other) > 2.2 * DIAMETER for other in spots):
            spots.append(spot)
    else:
        if len(spots) < count:
            msg = f"{count} balls do not fit {2 * spread * 1e3:g} mm square"
            raise ValueError(msg)
    angle = rng.uniform(0, 2 * np.pi, count)
    positions = np.c_[spots, np.full(count, DIAMETER / 2)]
    poles = np.c_[np.cos(angle), np.sin(angle), np.zeros(count)]
    return positions, poles


#: What decides a run: the simulation and the start, as this module wrote
#: them.
_DECIDING = (_qmul, _turned, pull, let_go, _friction, _rolling, _just_touching)
_DECIDING += (scattered,)


def made_by():
    """A stamp of what decides the runs: the source of the simulation and
    of the start, and the balls' numbers. The cache is named by it, so a
    change to any of them works the runs out again."""
    # the code as parsed, not as written: a reformat or a comment changes
    # no run, so it changes no stamp
    parts = [ast.dump(ast.parse(inspect.getsource(f))) for f in _DECIDING]
    parts += [repr(RUNS), repr((DIAMETER, POLARIZATION, DENSITY))]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def cache_dir():
    """Where the runs are kept between sessions: `MAGPYLIB_STUDIO_CACHE` if
    set, else the platform's own place for caches."""
    if folder := os.environ.get("MAGPYLIB_STUDIO_CACHE"):
        return pathlib.Path(folder)
    home = pathlib.Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Caches" / "magpylib-studio"
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local"
        return pathlib.Path(local) / "magpylib-studio" / "Cache"
    return pathlib.Path(os.environ.get("XDG_CACHE_HOME") or home / ".cache") / (
        "magpylib-studio"
    )


@functools.cache
def runs():
    """The runs of `RUNS`, by name: from the cache, or worked out -- some
    seconds -- and kept there for next time. A cache that cannot be read or
    written is passed by: the runs are worked out again, in this session
    once."""
    path = cache_dir() / f"magnet_balls-{made_by()[:16]}.npz"
    try:
        with np.load(path) as data:
            return {
                name: Run(
                    **{
                        f.name: data[f"{name}/{f.name}"]
                        for f in dataclasses.fields(Run)
                    }
                )
                for name in RUNS
            }
    except (OSError, KeyError, ValueError):
        pass
    made = {
        name: let_go(*scattered(count, seed), duration=0.3, frames=120)
        for name, (count, seed) in RUNS.items()
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # written aside and moved in whole, so a session reading meanwhile
        # never sees half a file
        part = path.with_name(f"{path.name}.{os.getpid()}.part")
        with part.open("wb") as file:
            np.savez_compressed(
                file,
                **{
                    f"{name}/{key}": value
                    for name, run in made.items()
                    for key, value in dataclasses.asdict(run).items()
                },
            )
        part.replace(path)
    except OSError:
        pass
    return made


def spheres(run, into, label="ball"):
    """The balls of `run` as magpylib spheres in the collection `into`, each
    following its path: where it is and how it is turned at every frame.
    `into` takes a choice's branch too, as `(switch, name)`."""
    out = []
    for k in range(run.positions.shape[1]):
        ball = magpy.magnet.Sphere(
            diameter=DIAMETER,
            polarization=(0, 0, POLARIZATION),
            style_label=label,
            style_path_show=False,
        )
        if isinstance(into, tuple):
            into[0].add(into[1], ball)
        else:
            into.add(ball)
        ball.position = run.positions[:, k]
        ball.orientation = Rotation.from_quat(run.turns[:, k])
        out.append(ball)
    return out


def table(run, margin=0.01):
    """A table under every place the balls of `run` go, `margin` beyond:
    drawn, it fields nothing."""
    xy = run.positions[..., :2].reshape(-1, 2)
    low, high = xy.min(0) - margin, xy.max(0) + margin
    return magpy.magnet.Cuboid(
        dimension=(*(high - low), 0.002),
        polarization=(0, 0, 0),
        position=(*((low + high) / 2), -0.001),
        style_label="table",
    )


@scene(
    model_unit="mm",
    field_unit="mT",
    variants={name: {"balls": name} for name in RUNS},
)
def magnet_balls(balls: typing.Literal["eight", "twelve"] = "eight"):
    """Magnet balls dropped at random on a table and left to themselves:
    they turn, roll and snap into a chain, and none is pushed away.

    Each is a run, worked out from the forces and torques between the
    balls -- exact for spheres -- with their weight, the table, and friction
    where they touch: press play at the foot of the view. A ball turns
    toward its neighbours long before it moves, so the pairs that meet meet
    south to north and snap; head to tail is the strongest way two balls
    hold, so they make a chain.

    The runs are worked out the first time the scene opens, some seconds,
    and kept in the user's cache after that; `let_go` makes any other, as
    the notebook does.
    """
    choice = choose(balls, style_label="balls")
    for name, run in runs().items():
        spheres(run, into=(choice, name))
        choice.add(name, table(run))
    return choice
