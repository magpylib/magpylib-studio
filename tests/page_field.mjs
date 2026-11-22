// The page's side of tests/test_page_field.py (#176): what a saved page
// works out for a dragged sensor, by `magpylib_studio/static/pagefield.mjs`,
// for the python test to hold against `fieldlines.py`.
//
//   node tests/page_field.mjs <kernels folder> <cases.json> <answers.json>
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  fieldAt,
  frameOf,
  gridAround,
  holds,
  insideAt,
  pointsOf,
  prepared,
  seedsAt,
  slide,
} from "../magpylib_studio/static/pagefield.mjs";

const [folder, casesPath, answersPath] = process.argv.slice(2);
const kernels = await import(pathToFileURL(`${folder}/mmr_kernels.js`).href);
await kernels.default({
  module_or_path: readFileSync(`${folder}/mmr_kernels_bg.wasm`),
});
const { field, key, cases } = JSON.parse(readFileSync(casesPath, "utf8"));
const ready = prepared(kernels, field);
const sensor = field.sensors[key];

const answers = cases.map(({ pose, points, flat, from }) => {
  const seeds = seedsAt(sensor, pose);
  const frame = flat === false ? frameOf({}, pose) : frameOf(sensor, pose);
  const grid = gridAround(ready.centres, seeds, points, frame);
  const at = pointsOf(grid);
  const answer = {
    seeds,
    grid,
    points: Array.from(at),
    inside: Array.from(insideAt(ready, at)),
    field: Array.from(fieldAt(ready, at, sensor.kind, 0)),
    holds: holds(grid, seedsAt(sensor, from), field.rules.held_margin),
  };
  const slid = slide(grid, seeds, seedsAt(sensor, from));
  answer.slid = slid && { grid: slid[0], was: Array.from(slid[1]) };
  return answer;
});
writeFileSync(answersPath, JSON.stringify(answers));
