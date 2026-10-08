# qwen3-8b-64k smoke test, 2026-10-08

One run per condition, task `field_above_magnet`, local Ollama (num_ctx requested 65536, clamped to the
model's native 40960). Both conditions failed; about 270 s (plain) and 367 s (studio) per run.

- Claude Code could drive the model's tools: both runs made tool calls and wrote `answer.json`.
- The `cost $` column in `summary.md` is bogus for a local model; ignore it.
- Cause of the failures: the model never ran Python or magpylib. It computed a point-dipole estimate by
  hand, read the 1.2 T polarization as 1.2 A/m, and wrote the number (plain 0.7213 mT, studio 8890 mT;
  expected 206.8 mT).
- Studio run: it invoked the skill once but passed a Python one-liner (a made-up `Dipole` call) as the
  skill's `args`, then ignored the loaded skill text and answered by hand.
- Reading: a model limit (8B does not follow "run Python"), not a harness or skill bug. Next: gpt-oss:20b.
