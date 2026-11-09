/* repro.js — determinism and RNG-isolation checks.
 *
 *   node repro.js
 *
 * 1. Two worlds with the same seed must be byte-identical after N ticks.
 * 2. Different seeds must diverge.
 * 3. The sim must never call Math.random once a world has been seeded.
 */
const A = require('./sim.js');

const TICKS = parseInt(process.env.TICKS || '20000', 10);

function run(seed) {
  const w = new A.World({ seed });
  for (let t = 0; t < TICKS; t++) w.step();
  return JSON.stringify(w.serialize());
}

let failed = false;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed = true;
}

const a = run(1234);
const b = run(1234);
const c = run(4321);

check('same seed is identical', a === b, `${a.length} bytes`);
check('different seed diverges', a !== c);

const w = new A.World({ seed: 99 });
const realRandom = Math.random;
let used = false;
Math.random = () => { used = true; return realRandom(); };
try {
  for (let t = 0; t < 2000; t++) w.step();
} finally {
  Math.random = realRandom;
}
check('sim does not use Math.random', !used);

// Save/load must round-trip exactly: a loaded world has to continue the same
// run, not merely resemble it.
const original = new A.World({ seed: 77 });
for (let t = 0; t < 5000; t++) original.step();
const loaded = A.World.fromJSON(JSON.parse(JSON.stringify(original.serialize())));
check('save/load snapshot is identical',
  JSON.stringify(original.serialize()) === JSON.stringify(loaded.serialize()));
for (let t = 0; t < 2000; t++) { original.step(); loaded.step(); }
check('save/load resumes identically',
  JSON.stringify(original.serialize()) === JSON.stringify(loaded.serialize()));

process.exit(failed ? 1 : 0);
