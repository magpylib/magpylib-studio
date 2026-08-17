"""magpylib-studio: a headless magpylib editing engine for GUI/LLM frontends."""

__all__ = ["MagpylibStudioSession"]


def __getattr__(name):
    """Resolve the session on first use rather than on import (PEP 562).

    `backend.py` is a magpylib entry point, and magpylib loads entry points
    while something asks it about a backend name -- so whatever is reachable
    from that module is paid for by anyone who gets that far. Reaching it goes
    through this one, and importing the session here brought the whole engine
    with it -- the same cost that keeping `viewer.py` apart from
    `plotly_view.py` was meant to avoid.
    """
    if name == "MagpylibStudioSession":
        from magpylib_studio.session import MagpylibStudioSession

        return MagpylibStudioSession
    msg = f"module {__name__!r} has no attribute {name!r}"
    raise AttributeError(msg)
