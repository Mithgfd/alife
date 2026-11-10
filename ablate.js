/* ablate.js — compare evolved layers against neutral/random baselines.
 *
 *   node ablate.js
 *   TICKS=20000 SEEDS=1,2,3,4 node ablate.js
 *   IMMIGRATION_BELOW=0 node ablate.js   # test persistence without seed bank
 *
 * Variants:
 *   default        shipped model (evolved brain, regulation, development)
 *   no-reflex      founders/immigrants start with fully random brain weights (no innate reflex)
 *   scrambled-brain brain weights randomized every tick (no heritable/adaptive control)
 *   neutral-rg     regulatory genome forced to zero (structural traits only)
 *   fixed-alloc    developmental allocation fixed to an even adult body plan
 *
 * If a layer's variant performs about as well as default, that layer may not be
 * contributing much in the current environment. Compare population, persistence,
 * native/immigrant-descended fraction, and trait outcomes across seeds.
 */
const A = require('./sim.js');

const TICKS = parseInt(process.env.TICKS || '20000', 10);
const SEEDS = (process.env.SEEDS || '1,2,3,4').split(',').map(Number);
const IMMIGRATION_BELOW = process.env.IMMIGRATION_BELOW === undefined ? undefined : parseFloat(process.env.IMMIGRATION_BELOW);
const REALISTIC = process.env.REALISTIC === '1';
const burn = Math.floor(TICKS * 0.2);

function makeOpts(seed) {
  const opts = { seed };
  if (IMMIGRATION_BELOW !== undefined) opts.immigrationBelow = IMMIGRATION_BELOW;
  if (REALISTIC) opts.realisticMode = true;
  return opts;
}

function forceNoReflex(w) {
  // Remove the hand-seeded foraging reflex: founders/immigrants get fully
  // random brain weights (no innate food-seeking scaffold). Offspring still
  // inherit and mutate normally, so evolution must discover control from scratch.
  const orig = w.randomGenome.bind(w);
  w.randomGenome = () => {
    const g = orig(); // correct genes/rg/size; reflex-wired weights
    for (let i = 0; i < g.w.length; i++) g.w[i] = w.rng.normal() * 0.35;
    return g;
  };
  for (const c of w.creatures) { for (let i = 0; i < c.w.length; i++) c.w[i] = w.rng.normal() * 0.35; }
}

function forceScrambledBrain(w) {
  const scramble = (c) => { for (let i = 0; i < c.w.length; i++) c.w[i] = w.rng.normal() * 0.8; };
  const origStep = w.step.bind(w);
  w.step = () => { origStep(); for (const c of w.creatures) scramble(c); };
  // also randomize offspring at birth by scrambling after creation hooks
  const om = w.childOf.bind(w);
  w.childOf = (p) => { const c = om(p); scramble(c); return c; };
  const os = w.childOfSexual.bind(w);
  w.childOfSexual = (a, b) => { const c = os(a, b); scramble(c); return c; };
  for (const c of w.creatures) scramble(c);
}

function forceNeutralRg(w) {
  const zero = () => ({ base: new Array(4).fill(0), W: new Array(16).fill(0), V: new Array(24).fill(0), promBase: new Array(5).fill(0), promW: new Array(20).fill(0) });
  const fix = (c) => { c.genes.rg = zero(); c.reg.fill(0); w.computeTraits(c); };
  for (const c of w.creatures) fix(c);
  const orig = w.computeTraits.bind(w);
  w.computeTraits = (c) => { c.genes.rg = zero(); c.reg.fill(0); orig(c); };
  const om = w.childOf.bind(w);
  w.childOf = (p) => { const c = om(p); c.genes.rg = zero(); c.reg.fill(0); w.computeTraits(c); return c; };
  const os = w.childOfSexual.bind(w);
  w.childOfSexual = (a, b) => { const c = os(a, b); c.genes.rg = zero(); c.reg.fill(0); w.computeTraits(c); return c; };
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
  ['no-reflex', forceNoReflex],
  ['scrambled-brain', forceScrambledBrain],
  ['neutral-rg', forceNeutralRg],
  ['fixed-alloc', forceFixedAlloc],
];

for (const [name, setup] of VARIANTS) {
  console.log(`\n== ${name} ==`);
  for (const seed of SEEDS) {
    const w = new A.World(makeOpts(seed));
    if (setup) setup(w);
    let mn = Infinity, mx = 0, sum = 0, n = 0, imm0 = 0, extinctAt = 0;
    for (let t = 1; t <= TICKS; t++) {
      w.step();
      if (t === burn) imm0 = w.immigrants;
      if (t > burn) {
        const p = w.creatures.length;
        mn = Math.min(mn, p); mx = Math.max(mx, p); sum += p; n++;
        if (p === 0 && !extinctAt) extinctAt = t;
      }
    }
    const s = w.stats();
    console.log(
      `seed ${seed}  mean ${String(n ? Math.round(sum / n) : 0).padStart(3)}  min ${String(mn === Infinity ? 0 : mn).padStart(3)}  max ${String(mx).padStart(3)}  ` +
      `gen ${String(s.maxGen).padStart(3)}  sp ${String(s.species).padStart(2)}  native ${(100*(s.native??1)).toFixed(0)}% imm+ ${w.immigrants - imm0}  ` +
      `size ${s.size.toFixed(2)} spd ${s.speed.toFixed(2)} sns ${s.sense.toFixed(0)} enz ${s.enzyme.toFixed(2)} diet ${(s.diet??0).toFixed(2)} def ${(s.defense??0).toFixed(2)} reg ${s.regActivity.toFixed(2)}` +
      (extinctAt ? `  [extinct @${extinctAt}]` : '')
    );
  }
}
