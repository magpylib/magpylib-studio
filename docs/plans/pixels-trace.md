# Pixels from magpylib's `pixels` trace: what is left

**Status:** built on `pixels-trace`, 2026-10-30; what it decided is
[0041](../decisions.md#0041-sensor-pixels-come-from-magpylib-as-data), and how
it works is in [architecture.md](../architecture.md). It needs magpylib 6.1, not
yet on PyPI, so CI installs magpylib's main meanwhile.

## Left, once magpylib 6.1 is on PyPI

- Delete `.github/magpylib-main.txt` and `UV_OVERRIDE` in `ci.yml`.
- Lock it: `uv lock --upgrade-package magpylib`.
- Mark the pull request ready.

## Done when

Those are done, and this plan is deleted.
