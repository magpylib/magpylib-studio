# Agent evaluation, 2026-10-07/08, first pass

Model `sonnet`, 1 run(s) per task and condition, checkout
`ad08dae + this change`. Tokens are input + output, cache reads included; cost
is what Claude Code reported.

| task               | condition | passed | turns | tokens | cost $ | refusals | skill read |
| ------------------ | --------- | ------ | ----- | ------ | ------ | -------- | ---------- |
| checkerboard       | plain     | 1/1    | 4     | 43103  | 0.053  | 0        | 0/1        |
| checkerboard       | studio    | 1/1    | 7     | 94589  | 0.098  | 0        | 1/1        |
| coil_target        | plain     | 1/1    | 3     | 29646  | 0.054  | 0        | 0/1        |
| coil_target        | studio    | 1/1    | 6     | 52946  | 0.079  | 0        | 1/1        |
| field_above_magnet | plain     | 1/1    | 3     | 41807  | 0.045  | 0        | 0/1        |
| field_above_magnet | studio    | 1/1    | 5     | 69851  | 0.071  | 0        | 1/1        |
| halbach_stack      | plain     | 1/1    | 3     | 31272  | 0.067  | 0        | 0/1        |
| halbach_stack      | studio    | 1/1    | 22    | 305580 | 0.236  | 0        | 1/1        |
| halbach_twelve     | plain     | 1/1    | 4     | 44156  | 0.053  | 0        | 0/1        |
| halbach_twelve     | studio    | 1/1    | 8     | 107033 | 0.112  | 0        | 1/1        |
| halbach_uniformity | plain     | 1/1    | 3     | 44244  | 0.053  | 0        | 0/1        |
| halbach_uniformity | studio    | 1/1    | 6     | 73140  | 0.063  | 0        | 1/1        |
| make_parametric    | studio    | 1/1    | 7     | 72140  | 0.076  | 0        | 1/1        |
| repair_refused     | studio    | 1/1    | 7     | 91636  | 0.082  | 0        | 1/1        |
| sensor_at_field    | plain     | 1/1    | 3     | 42500  | 0.048  | 0        | 0/1        |
| sensor_at_field    | studio    | 1/1    | 4     | 59009  | 0.056  | 0        | 0/1        |
| sweep_gap          | plain     | 1/1    | 7     | 75652  | 0.069  | 0        | 0/1        |
| sweep_gap          | studio    | 1/1    | 10    | 140084 | 0.107  | 0        | 1/1        |

| condition | passed | cost $ |
| --------- | ------ | ------ |
| plain     | 8/8    | 0.44   |
| studio    | 10/10  | 0.98   |
