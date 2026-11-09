/* test.js — run the sim with no browser and report whether the ecosystem
 * actually holds together.
 *
 *   node test.js            # 40k ticks, default params, seed 1
 *   node test.js 100000     # longer run
 *   SEED=7 node test.js     # a different world
 */
const A = require('./sim.js');

const TICKS = parseInt(process.argv[2] || '40000', 10);
const SEED = parseInt(process.env.SEED || '1', 10);
const world = new A.World({ seed: SEED });

let popMin = Infinity, popMax = 0, popSum = 0, popN = 0;
let zeroTicks = 0;
let prevPop = world.creatures.length;
let crashes = 0;

const t0 = Date.now();
const samples = [];

for (let t = 1; t <= TICKS; t++) {
  world.step();
  const pop = world.creatures.length;

  // ignore the first 10% as burn-in
  if (t > TICKS * 0.1) {
    popMin = Math.min(popMin, pop);
    popMax = Math.max(popMax, pop);
    popSum += pop;
    popN++;
    if (pop === 0) zeroTicks++;
    // a "crash" = losing >60% of the population in one sample window
    if (prevPop > 40 && pop < prevPop * 0.4) crashes++;
  }
  prevPop = pop;

  if (t % Math.max(1, Math.floor(TICKS / 10)) === 0) {
    const s = world.stats();
    samples.push({ t, pop, food: s.food });
    console.log(
      `t=${String(t).padStart(6)}  pop=${String(pop).padStart(3)}  food=${String(s.food).padStart(3)}` +
      `  gen=${s.maxGen.toFixed(0)}  species=${s.species}` +
      `  size=${s.size.toFixed(2)}  spd=${s.speed.toFixed(2)}` +
      `  sense=${s.sense.toFixed(0)}  enz=${s.enzyme.toFixed(2)}` +
      `  bio=${s.biomass.toFixed(2)}  mature=${(100 * s.maturity).toFixed(0)}%` +
      `  mut=${s.mutRate.toFixed(3)}  repro=${s.reproE.toFixed(0)}` +
      `  imm=${s.immigrants}`
    );
  }
}

const dt = Date.now() - t0;
const mean = popSum / (popN || 1);

// oscillation: mean absolute change between consecutive samples, relative to mean
let osc = 0;
for (let i = 1; i < samples.length; i++) {
  osc += Math.abs(samples[i].pop - samples[i - 1].pop);
}
osc = samples.length > 1 ? osc / (samples.length - 1) / (mean || 1) : 0;

console.log('\n--- summary ---');
console.log(`seed             ${SEED}  (${world.p.sexual ? 'sexual' : 'asexual'})`);
console.log(`ticks            ${TICKS}  (${(dt / TICKS).toFixed(3)} ms/tick, ${(TICKS / (dt / 1000)).toFixed(0)} ticks/s)`);
console.log(`population       mean ${mean.toFixed(1)}  min ${popMin}  max ${popMax}`);
console.log(`species          ${world.stats().species} current, ${world.species.map((s) => s.peak).reduce((a, b) => Math.max(a, b), 0)} peak`);
console.log(`extinction ticks ${zeroTicks}`);
console.log(`crash events     ${crashes}`);
console.log(`oscillation      ${(osc * 100).toFixed(1)}% of mean between samples`);
console.log(`immigrants       ${world.immigrants}`);
console.log(`births/deaths    ${world.births}/${world.deaths}  (sexual ${world.sexualBirths} / asexual ${world.asexualBirths})`);
