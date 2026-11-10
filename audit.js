/* audit.js — coarse matter/energy accounting diagnostic.
 *
 *   node audit.js
 *   TICKS=10000 SEED=1 node audit.js
 *
 * Tracks approximate energy/nutrient/mass flows: food spawned (world input),
 * creature stores (ATP + nutrient + biomass-equivalent), detritus, and losses.
 * In a closed loop, "created" should be explained by world food growth and
 * decomposition/recycling, not spontaneous gains. This is a diagnostic, not a
 * perfect physical ledger (conversion constants differ by process).
 */
const A = require('./sim.js');

const TICKS = parseInt(process.env.TICKS || '10000', 10);
const SEED = parseInt(process.env.SEED || '1', 10);
const REALISTIC = process.env.REALISTIC === '1';
const opts = { seed: SEED };
if (REALISTIC) opts.realisticMode = true;
const w = new A.World(opts);

let spawnedFoodE = 0;
const origSpawn = w.spawnFood.bind(w);
w.spawnFood = function () { const before = this.food.length; origSpawn(); const f = this.food[this.food.length - 1]; if (f) spawnedFoodE += f.e || 0; };

function totals() {
  let ce = 0, cn = 0, cb = 0;
  for (const c of w.creatures) { ce += Math.max(0, c.energy); cn += Math.max(0, c.nutrient); cb += Math.max(0, c.biomass); }
  let fe = 0; for (const f of w.food) if (!f.dead) fe += f.e || 0;
  let dn = 0; for (const d of (w.detritus||[])) dn += d.n || 0;
  return { ce, cn, cb, fe, dn };
}

const t0 = totals();
for (let t = 1; t <= TICKS; t++) w.step();
const t1 = totals();

const bioToN = 12; // matches dropRemains conversion
const stored0 = t0.ce + t0.cn + t0.cb * bioToN + t0.fe + t0.dn;
const stored1 = t1.ce + t1.cn + t1.cb * bioToN + t1.fe + t1.dn;
console.log(JSON.stringify({
  seed: SEED, ticks: TICKS, realistic: REALISTIC,
  spawnedFoodE: +spawnedFoodE.toFixed(2),
  start: t0, end: t1,
  stored0: +stored0.toFixed(2), stored1: +stored1.toFixed(2),
  deltaStored: +(stored1 - stored0).toFixed(2),
  note: 'Approximate ledger: compares world-spawned food input to stored ATP+nutrient+food+detritus+biomass-equivalent. Metabolism converts/loses energy (heat, lossy catabolism, costs), so deltaStored < spawnedFoodE is expected in a dissipative system; large unexplained gains indicate leaks.'
}, null, 2));
