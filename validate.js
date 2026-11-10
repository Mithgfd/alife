/* validate.js — long-horizon check of the shipped defaults.
 *
 *   node validate.js                      # 5 seeds x 40k ticks
 *   IMMIGRATION_BELOW=0 node validate.js  # no seed bank; tests evolutionary persistence
 *   TICKS=80000 node validate.js          # longer
 *   SEXUAL=0 node validate.js             # force asexual
 *   STRICT=1 node validate.js             # also fail on seed-bank dependence
 *
 * Pass criteria (default): no run goes extinct. With `IMMIGRATION_BELOW=0`,
 * persistence means lineages survived without injected random genomes. Reports
 * immigrant-descended fraction (`native%`) so seed-bank dependence is visible.
 */
const A = require('./sim.js');

const TICKS = parseInt(process.env.TICKS || '40000', 10);
const SEEDS = (process.env.SEEDS || '1,2,3,4,5').split(',').map(Number);
const SEXUAL = process.env.SEXUAL === undefined ? undefined : process.env.SEXUAL === '1';
const IMMIGRATION_BELOW = process.env.IMMIGRATION_BELOW === undefined ? undefined : parseFloat(process.env.IMMIGRATION_BELOW);
const REALISTIC = process.env.REALISTIC === '1';
const STRICT = process.env.STRICT === '1';
const burn = Math.floor(TICKS * 0.2);

console.log(`defaults: ${JSON.stringify({
  foodGrowth: A.DEFAULTS.foodGrowth,
  maxPop: A.DEFAULTS.maxPop,
  predation: A.DEFAULTS.predation,
  sexual: SEXUAL === undefined ? A.DEFAULTS.sexual : SEXUAL,
  immigrationBelow: REALISTIC ? 0 : (IMMIGRATION_BELOW === undefined ? A.DEFAULTS.immigrationBelow : IMMIGRATION_BELOW),
  realistic: REALISTIC,
  strict: STRICT,
})}\n`);

let worstMin = Infinity;
let failed = false;
for (const seed of SEEDS) {
  const opts = { seed };
  if (SEXUAL !== undefined) opts.sexual = SEXUAL;
  if (IMMIGRATION_BELOW !== undefined) opts.immigrationBelow = IMMIGRATION_BELOW;
  if (REALISTIC) opts.realisticMode = true;
  const w = new A.World(opts);
  let mn = Infinity, mx = 0, sum = 0, n = 0, zero = 0, pinned = 0, low = 0;
  let immAtBurn = 0;
  for (let t = 1; t <= TICKS; t++) {
    w.step();
    if (t === burn) immAtBurn = w.immigrants;
    if (t > burn) {
      const p = w.creatures.length;
      mn = Math.min(mn, p); mx = Math.max(mx, p); sum += p; n++;
      if (p === 0) zero++;
      if (p >= w.p.maxPop) pinned++;
      if (p < w.p.immigrationBelow) low++;
    }
  }
  worstMin = Math.min(worstMin, mn);
  const s = w.stats();
  const immAfter = Math.max(0, w.immigrants - immAtBurn);
  const birthsAfter = Math.max(1, w.births); // cumulative; ratio is a coarse dependence hint
  const immShare = (w.immigrants / birthsAfter) * 100;
  const dependent = immAfter > 20 || (low / n) > 0.05;
  if (STRICT && (zero > 0 || pinned === n || dependent)) failed = true;
  console.log(
    `seed ${String(seed).padStart(2)}  pop mean ${(sum / n).toFixed(0).padStart(3)}  ` +
    `min ${String(mn).padStart(3)}  max ${String(mx).padStart(3)}  ` +
    `zero ${String(zero).padStart(4)}  pinned ${String(pinned).padStart(4)}  ` +
    `gen ${String(s.maxGen).padStart(3)}  sp ${String(s.species).padStart(2)}  ` +
    `native ${(100 * (s.native ?? 1)).toFixed(0)}% imm ${s.immigrants} (+${immAfter}, ${immShare.toFixed(1)}%)  ` +
    `size ${s.size.toFixed(2)} spd ${s.speed.toFixed(2)} sns ${s.sense.toFixed(0)} enz ${s.enzyme.toFixed(2)} diet ${(s.diet ?? 0).toFixed(2)} def ${(s.defense ?? 0).toFixed(2)}` +
    (dependent ? '  [seed-bank dependent]' : '')
  );
}

console.log(`\nworst population across runs: ${worstMin}`);
process.exit(worstMin === 0 || failed ? 1 : 0);
