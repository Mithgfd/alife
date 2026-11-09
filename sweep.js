/* sweep.js — multi-seed parameter sweep.
 *
 * Single runs of this system are chaotic, so comparing configs from one run is
 * meaningless. This runs each config across seeds and reports the distribution.
 * That's the only honest way to tune it.
 *
 *   node sweep.js
 *   TICKS=40000 SEEDS=1,2,3,4,5 node sweep.js
 */
const A = require('./sim.js');

const TICKS = parseInt(process.env.TICKS || '25000', 10);
const SEEDS = (process.env.SEEDS || '1,2,3').split(',').map(Number);

const configs = [];
for (const fg of [1.6, 1.8, 2.0]) {
  for (const sexual of [false, true]) {
    configs.push({
      label: `fg=${fg} ${sexual ? 'sexual' : 'asexual'}`,
      opts: { foodGrowth: fg, sexual },
    });
  }
}

const rows = [];
for (const cfg of configs) {
  const runs = [];
  for (const seed of SEEDS) {
    const w = new A.World(Object.assign({ seed }, cfg.opts));
    let mn = 1e9, mx = 0, sum = 0, n = 0, zero = 0;
    for (let t = 1; t <= TICKS; t++) {
      w.step();
      if (t > TICKS * 0.3) {
        const p = w.creatures.length;
        mn = Math.min(mn, p); mx = Math.max(mx, p); sum += p; n++;
        if (p === 0) zero++;
      }
    }
    const s = w.stats();
    runs.push({ mean: sum / n, mn, mx, zero, gen: s.maxGen, species: s.species, size: s.size, speed: s.speed });
  }
  const avg = (k) => runs.reduce((a, r) => a + r[k], 0) / runs.length;
  rows.push({
    label: cfg.label,
    mean: avg('mean').toFixed(0),
    min: Math.min(...runs.map((r) => r.mn)),
    max: Math.max(...runs.map((r) => r.mx)),
    zero: runs.reduce((a, r) => a + r.zero, 0),
    gen: avg('gen').toFixed(0),
    species: avg('species').toFixed(1),
    size: avg('size').toFixed(2),
    speed: avg('speed').toFixed(2),
  });
}

console.log(`ticks=${TICKS} seeds=${SEEDS.join(',')}\n`);
const head = ['config', 'popMean', 'popMin', 'popMax', 'extTicks', 'gen', 'species', 'size', 'speed'];
const widths = [22, 8, 7, 7, 9, 5, 8, 6, 6];
console.log(head.map((h, i) => h.padEnd(widths[i])).join(''));
for (const r of rows) {
  const vals = [r.label, r.mean, r.min, r.max, r.zero, r.gen, r.species, r.size, r.speed];
  console.log(vals.map((v, i) => String(v).padEnd(widths[i])).join(''));
}
