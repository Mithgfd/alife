/* ablate.js — compare evolved layers against neutral baselines.
 *
 *   node ablate.js
 *   TICKS=20000 SEEDS=1,2,3,4 node ablate.js
 *
 * Variants:
 *   default      shipped model
 *   neutral-rg   regulatory genomes forced to zero (structural traits expressed)
 *   fixed-alloc  developmental allocation fixed to an even adult body plan
 *
 * This is a coarse diagnostic: if a layer never changes outcomes versus its
 * neutral baseline, it may not be under selection in the current environment.
 */
const A = require('./sim.js');

const TICKS = parseInt(process.env.TICKS || '20000', 10);
const SEEDS = (process.env.SEEDS || '1,2,3,4').split(',').map(Number);
const burn = Math.floor(TICKS * 0.2);

function forceNeutralRg(w) {
  const zero = () => ({
    base: new Array(4).fill(0),
    W: new Array(16).fill(0),
    V: new Array(24).fill(0),
    promBase: new Array(5).fill(0),
    promW: new Array(20).fill(0),
  });
  const fix = (c) => {
    c.genes.rg = zero();
    c.reg.fill(0);
    w.computeTraits(c);
  };
  for (const c of w.creatures) fix(c);
  const orig = w.computeTraits.bind(w);
  w.computeTraits = (c) => { c.genes.rg = zero(); c.reg.fill(0); orig(c); };
  const om = w.childOf.bind(w);
  w.childOf = (p) => { const c = om(p); c.genes.rg = zero(); return c; };
  const os = w.childOfSexual.bind(w);
  w.childOfSexual = (a, b) => { const c = os(a, b); c.genes.rg = zero(); return c; };
}

function forceFixedAlloc(w) {
  const fix = (c) => {
    c.genes.allocGut = 0.25; c.genes.allocMuscle = 0.25;
    c.genes.allocNerve = 0.25; c.genes.allocGonad = 0.25;
    c.genes.devTiming = 0.60;
    w.computeTraits(c);
  };
  for (const c of w.creatures) fix(c);
  const om = w.childOf.bind(w);
  w.childOf = (p) => { const c = om(p); fix(c); return c; };
  const os = w.childOfSexual.bind(w);
  w.childOfSexual = (a, b) => { const c = os(a, b); fix(c); return c; };
}

const VARIANTS = [
  ['default', null],
  ['neutral-rg', forceNeutralRg],
  ['fixed-alloc', forceFixedAlloc],
];

for (const [name, setup] of VARIANTS) {
  console.log(`\n== ${name} ==`);
  for (const seed of SEEDS) {
    const w = new A.World({ seed });
    if (setup) setup(w);
    let mn = Infinity, mx = 0, sum = 0, n = 0, imm0 = 0;
    for (let t = 1; t <= TICKS; t++) {
      w.step();
      if (t === burn) imm0 = w.immigrants;
      if (t > burn) {
        const p = w.creatures.length;
        mn = Math.min(mn, p); mx = Math.max(mx, p); sum += p; n++;
      }
    }
    const s = w.stats();
    console.log(
      `seed ${seed}  mean ${String(Math.round(sum / n)).padStart(3)}  min ${String(mn).padStart(3)}  max ${String(mx).padStart(3)}  ` +
      `gen ${String(s.maxGen).padStart(3)}  sp ${String(s.species).padStart(2)}  imm+ ${w.immigrants - imm0}  ` +
      `size ${s.size.toFixed(2)} spd ${s.speed.toFixed(2)} sns ${s.sense.toFixed(0)} enz ${s.enzyme.toFixed(2)} reg ${s.regActivity.toFixed(2)}`
    );
  }
}
