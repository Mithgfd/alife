/* sweep.js — multi-seed parameter sweep.
 *
 * Single runs of this system are chaotic, so comparing configs from one run is
 * meaningless. This seeds Math.random, runs each config several times, and
 * reports the distribution. That's the only honest way to tune it.
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

const TICKS = parseInt(process.env.TICKS || '25000', 10);
const SEEDS = (process.env.SEEDS || '1,2,3').split(',').map(Number);

const configs = [];
for (const fg of [1.0, 1.3, 1.6]) {
  for (const pred of [false, true]) {
    configs.push({ label: `fg=${fg} pred=${pred ? 'on ' : 'off'}`, opts: { foodGrowth: fg, predation: pred } });
  }
}

const rows = [];
for (const cfg of configs) {
  const runs = [];
  for (const seed of SEEDS) {
    Math.random = mulberry32(seed);
    const w = new A.World(Object.assign({ maxPop: 600 }, cfg.opts));
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
    runs.push({ mean: sum / n, mn, mx, zero, gen: s.maxGen, size: s.size, speed: s.speed, carn: s.carn });
  }
  const avg = (k) => runs.reduce((a, r) => a + r[k], 0) / runs.length;
  rows.push({
    label: cfg.label,
    mean: avg('mean').toFixed(0),
    min: Math.min(...runs.map(r => r.mn)),
    max: Math.max(...runs.map(r => r.mx)),
    zero: runs.reduce((a, r) => a + r.zero, 0),
    gen: avg('gen').toFixed(0),
    size: avg('size').toFixed(2),
    speed: avg('speed').toFixed(2),
    carn: avg('carn').toFixed(2),
  });
}

console.log(`ticks=${TICKS} seeds=${SEEDS.join(',')}\n`);
const head = ['config', 'popMean', 'popMin', 'popMax', 'extTicks', 'gen', 'size', 'speed', 'carn'];
const widths = [22, 8, 7, 7, 9, 5, 6, 6, 6];
console.log(head.map((h, i) => h.padEnd(widths[i])).join(''));
for (const r of rows) {
  const vals = [r.label, r.mean, r.min, r.max, r.zero, r.gen, r.size, r.speed, r.carn];
  console.log(vals.map((v, i) => String(v).padEnd(widths[i])).join(''));
}
