"""Units for variables: what a number measures, said beside it, never in it.

The document stays bare SI -- metres, tesla, amperes -- and degrees for
angles, which is how magpylib turns things. A variable may say what kind of
quantity it is (`docs/decisions.md#0008-units-are-metadata`), stored beside `integer` in its limits:

    "variable_bounds": {"gap": {"min": 0.001, "max": 0.06, "unit": "length"}}

and a document may say which length unit it is shown in (`model_unit`:
metres, SI like everything else, when it says nothing), and which unit a
field is (`field_unit`: tesla when it says nothing). From those a view shows
`gap: 0.015 m`, and reads `0.015`, `15 mm` or `1.5 cm` back as 0.015: a
number typed bare is in the unit shown, and one with a unit in its own. A
scene shown in mm reads a bare `15` as 15 mm. Nothing else changes: an
expression still computes in SI, and `"5mm"` typed into a document is still a
string, which is what keeps `"z"` an axis name.

What this does not do is check dimensions. `gap * current` is not caught;
magpylib does not catch it either, and an algebra of units to serve what is a
question of display would be the tail wagging the dog.
"""

from __future__ import annotations

import math
import re
from decimal import Decimal, InvalidOperation

#: Each kind: the unit the document holds it in, and the units a value may
#: be typed in, as how many of the document's unit one of them is. Written as
#: decimal text so that 1.1 mm is 0.0011 and not the float 1.1 * 0.001.
KINDS = {
    "length": (
        "m",
        {"m": "1", "cm": "0.01", "mm": "0.001", "µm": "1e-6", "um": "1e-6"},
    ),
    "angle": ("deg", {"°": "1", "deg": "1", "rad": None}),  # rad: 180/π, not decimal
    "field": ("T", {"T": "1", "mT": "0.001", "µT": "1e-6", "uT": "1e-6"}),
    "current": ("A", {"A": "1", "mA": "0.001", "kA": "1000"}),
    "dimensionless": ("", {}),
}

#: What each kind is called in prose, for a script's comment and a menu.
NAMES = {
    "length": "metres",
    "angle": "degrees",
    "field": "tesla",
    "current": "amperes",
    "dimensionless": "a pure number",
}

#: The length units a document may be shown in, and the one it is shown in
#: when it says nothing: SI, as the numbers are. Millimetres are a choice to
#: make (Length Unit...), or a unit to type: `15 mm`.
MODEL_UNITS = ("m", "cm", "mm", "µm")
DEFAULT_MODEL_UNIT = "m"

#: The units a field -- a polarization, a flux density -- may be shown in, and
#: the one it is shown in when the document says nothing.
FIELD_UNITS = ("T", "mT", "µT")
DEFAULT_FIELD_UNIT = "T"

#: A number, then perhaps a unit and nothing else: `15`, `15 mm`, `1.5cm`,
#: `-90°`. `2*gap` is not one -- it is an expression.
QUANTITY = re.compile(
    r"^\s*(?P<number>[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*"
    r"(?P<symbol>[A-Za-zµμ°]+)?\s*$"
)


def model_unit(doc):
    """The length unit `doc` is drawn in. One the studio does not know -- a
    file from a newer version, or edited by hand -- is carried, not shown in:
    its lengths are shown in metres, the numbers they are."""
    unit = doc.get("model_unit")
    return unit if unit in MODEL_UNITS else DEFAULT_MODEL_UNIT


def field_unit(doc):
    """The unit `doc` shows a field in, tesla unless it says otherwise -- or
    says something the studio does not know, which is carried, as above."""
    unit = doc.get("field_unit")
    return unit if unit in FIELD_UNITS else DEFAULT_FIELD_UNIT


def _symbol(kind, model, field):
    """The unit a value of `kind` is shown in."""
    return {"length": model, "angle": "°", "field": field}.get(kind, KINDS[kind][0])


def shown(kind, model, field=DEFAULT_FIELD_UNIT):
    """How a view shows a value of `kind`: its unit's symbol, and how many of
    that unit one of the document's is -- or None for a kind it does not know,
    which it then shows as the bare number it is."""
    if kind not in KINDS:
        return None
    symbol = _symbol(kind, model, field)
    per = KINDS[kind][1].get(symbol)
    return {"symbol": symbol, "scale": float(Decimal(1) / Decimal(per)) if per else 1.0}


def in_shown(value, kind, model, field=DEFAULT_FIELD_UNIT):
    """A document's number as a view shows it, in decimal: 0.0234 m is 23.4 mm
    and not 23.400000000000002, for a label that says it in words. A value
    that is no number -- an expression -- is what it is."""
    if kind not in KINDS or isinstance(value, bool):
        return value
    if not isinstance(value, int | float) or not math.isfinite(value):
        return value
    per = KINDS[kind][1].get(_symbol(kind, model, field))
    if per in (None, "1"):
        return value
    exact = Decimal(repr(float(value))) / Decimal(per)
    return int(exact) if exact == exact.to_integral_value() else float(exact)


def parse(text, kind, model, field=DEFAULT_FIELD_UNIT):
    """Typed text as a number in the document's unit: `15` in the unit the
    value is shown in, or `15 mm` in the one it names. Raises ValueError
    saying what it would have taken."""
    # Greek mu and the micro sign look alike and are typed alike
    match = QUANTITY.match(str(text).replace("\u03bc", "µ"))
    if not match:
        raise ValueError(f"{text!r} is not a number, or a number and a unit")
    number, symbol = match["number"], match["symbol"]
    if kind not in KINDS:
        if symbol:
            raise ValueError(
                f"this variable has no unit, so {symbol!r} means nothing to it: "
                "give it one (Variable Properties), or type the bare number"
            )
        return _finite(_number(number), text)
    document, accepted = KINDS[kind]
    if not symbol:
        symbol = _symbol(kind, model, field)
    if symbol not in accepted and symbol != document:
        known = ", ".join(s for s in accepted if s not in ("um", "uT")) or "none"
        raise ValueError(f"{symbol!r} is not a unit of {kind} ({known})")
    factor = accepted.get(symbol, "1")
    if factor is None:  # radians: the one factor no decimal says exactly
        return _finite(float(number) * 180 / math.pi, text)
    exact = Decimal(number) * Decimal(factor)
    # a whole number typed as one stays one: `0` in mm is 0, not 0.0
    if re.fullmatch(r"[-+]?\d+", number) and exact == exact.to_integral_value():
        return int(exact)
    return _finite(float(exact), text)


def to_document(value, kind, model, field=DEFAULT_FIELD_UNIT):
    """A number as a view shows it, in the document's unit -- a slider's
    position, say. Through decimal text, so 23.4 mm is 0.0234."""
    view = shown(kind, model, field)
    if view is None or view["scale"] == 1:
        return value
    return parse(repr(float(value)), kind, model, field)


def describe():
    """The kinds and the units each is typed in, for a menu or a reference."""
    return {
        "kinds": [
            {
                "kind": kind,
                "name": NAMES[kind],
                "units": [s for s in accepted if s not in ("um", "uT")]
                or ([document] if document else []),
            }
            for kind, (document, accepted) in KINDS.items()
        ],
        "model_units": list(MODEL_UNITS),
        "default_model_unit": DEFAULT_MODEL_UNIT,
        "field_units": list(FIELD_UNITS),
        "default_field_unit": DEFAULT_FIELD_UNIT,
    }


def _number(text):
    """Decimal text as the number a document holds: a whole number typed as
    one stays an int, as the panel has always sent `10`."""
    try:
        exact = Decimal(text)
    except InvalidOperation as e:  # the pattern lets nothing else through
        raise ValueError(f"{text!r} is not a number") from e
    whole = exact == exact.to_integral_value() and re.fullmatch(r"[-+]?\d+", text)
    return int(exact) if whole else float(exact)


def _finite(value, text):
    """`value`, unless `1e400` made it infinite: a document holds JSON, which
    has no infinity, and a view waiting for the reply would wait forever."""
    try:
        finite = math.isfinite(value)
    except OverflowError:  # a whole number with four hundred digits
        finite = False
    if not finite:
        raise ValueError(f"{text!r} is too large a number")
    return value
