/* validate.js — long-horizon check of the shipped defaults.
 *
 *   node validate.js            # 5 seeds x 80k ticks
 *   TICKS=200000 node validate.js
 *
 * Pass criteria, roughly: no run goes extinct, no run pins to maxPop for the
 * whole time, and the population stays in a band rather than collapsing.
 */
const A = require('./sim.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TICKS = parseInt(process.env.TICKS || '80000', 10);
const SEEDS = (process.env.SEEDS || '1,2,3,4,5').split(',').map(Number);
const burn = Math.floor(TICKS * 0.2);

console.log(`defaults: ${JSON.stringify({ foodGrowth: A.DEFAULTS.foodGrowth, maxPop: A.DEFAULTS.maxPop, predation: A.DEFAULTS.predation })}\n`);

let worstMin = Infinity;
for (const seed of SEEDS) {
  Math.random = mulberry32(seed);
  const w = new A.World();
  let mn = Infinity, mx = 0, sum = 0, n = 0, zero = 0, pinned = 0;
  for (let t = 1; t <= TICKS; t++) {
    w.step();
    if (t > burn) {
      const p = w.creatures.length;
      mn = Math.min(mn, p); mx = Math.max(mx, p); sum += p; n++;
      if (p === 0) zero++;
      if (p >= w.p.maxPop) pinned++;
    }
  }
  worstMin = Math.min(worstMin, mn);
  const s = w.stats();
  console.log(
    `seed ${String(seed).padStart(2)}  pop mean ${(sum / n).toFixed(0).padStart(3)}  ` +
    `min ${String(mn).padStart(3)}  max ${String(mx).padStart(3)}  ` +
    `zero ${String(zero).padStart(4)}  pinned ${String(pinned).padStart(4)}  ` +
    `gen ${String(s.maxGen).padStart(3)}  size ${s.size.toFixed(2)}  ` +
    `speed ${s.speed.toFixed(2)}  sense ${s.sense.toFixed(0)}  kills ${s.kills}`
  );
}

console.log(`\nworst population across runs: ${worstMin}`);
process.exit(worstMin === 0 ? 1 : 0);
