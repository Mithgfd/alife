/* validate.js — long-horizon check of the shipped defaults.
 *
 *   node validate.js                  # 5 seeds x 40k ticks
 *   TICKS=80000 node validate.js      # longer
 *   SEXUAL=0 node validate.js         # force asexual
 *   SEXUAL=1 node validate.js         # force sexual
 *
 * Pass criteria, roughly: no run goes extinct, no run pins to maxPop for the
 * whole time, and the population stays in a band rather than collapsing.
 */
const A = require('./sim.js');

const TICKS = parseInt(process.env.TICKS || '40000', 10);
const SEEDS = (process.env.SEEDS || '1,2,3,4,5').split(',').map(Number);
const SEXUAL = process.env.SEXUAL === undefined ? undefined : process.env.SEXUAL === '1';
const burn = Math.floor(TICKS * 0.2);

console.log(`defaults: ${JSON.stringify({
  foodGrowth: A.DEFAULTS.foodGrowth,
  maxPop: A.DEFAULTS.maxPop,
  predation: A.DEFAULTS.predation,
  sexual: SEXUAL === undefined ? A.DEFAULTS.sexual : SEXUAL,
})}\n`);

let worstMin = Infinity;
for (const seed of SEEDS) {
  const opts = { seed };
  if (SEXUAL !== undefined) opts.sexual = SEXUAL;
  const w = new A.World(opts);
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
    `gen ${String(s.maxGen).padStart(3)}  species ${String(s.species).padStart(2)}  ` +
    `size ${s.size.toFixed(2)}  speed ${s.speed.toFixed(2)}  sense ${s.sense.toFixed(0)}  ` +
    `kills ${s.kills}  imm ${s.immigrants}`
  );
}

console.log(`\nworst population across runs: ${worstMin}`);
process.exit(worstMin === 0 ? 1 : 0);
