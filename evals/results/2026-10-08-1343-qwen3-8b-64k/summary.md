# Agent evaluation, 2026-10-08-1343

Model `qwen3-8b-64k`, 1 run(s) per task and condition, checkout `619259b`. Tokens are input + output, cache reads included; time is the median run's, in seconds; no cost: a local model, at http://localhost:11434.

| task | condition | passed | turns | tokens | time s | cost $ | refusals | skill read |
| ---- | --------- | ------ | ----- | ------ | ------ | ------ | -------- | ---------- |
| field_above_magnet | plain | 0/1 | 2 | 29622 | 270 |  | 0 | 0/1 |
| field_above_magnet | studio | 0/1 | 4 | 46154 | 367 |  | 0 | 1/1 |

| condition | passed | cost $ |
| --------- | ------ | ------ |
| plain | 0/1 | 0.27 |
| studio | 0/1 | 0.37 |
