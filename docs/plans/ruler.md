# A ruler in the view: what is left

**Status:** built on #151, 2026-11-07; what it decided is
[0053](../decisions.md#0053-the-ruler-measures-features-in-every-pane), and how
it works is in [architecture.md](../architecture.md). This plan keeps only what
is not built.

## Open

- **A value per variant**: `view.measurements` reads the scene's view alone, for
  a notebook to plot a gap per variant it would need each pane's value.
- **The legend's gap folded into the ruler**, once the ruler measures object to
  object as well as feature to feature.
