/* log.js — write per-sample population and trait means to CSV.
 *
 *   node log.js > run.csv
 *   TICKS=40000 SAMPLE=100 SEED=3 node log.js > run.csv
 *   SEXUAL=0 node log.js > asexual.csv
 *
 * Plots of size/speed/sense/enzyme over time make it easier to see whether
 * traits move more than drift.
 */
const A = require('./sim.js');

const TICKS = parseInt(process.env.TICKS || '40000', 10);
const SAMPLE = Math.max(1, parseInt(process.env.SAMPLE || '100', 10));
const SEED = parseInt(process.env.SEED || '1', 10);
const SEXUAL = process.env.SEXUAL === undefined ? undefined : process.env.SEXUAL === '1';

const opts = { seed: SEED };
if (SEXUAL !== undefined) opts.sexual = SEXUAL;
const w = new A.World(opts);

const cols = [
  'tick', 'pop', 'food', 'species', 'births', 'deaths', 'immigrants',
  'avgGen', 'maxGen', 'size', 'speed', 'sense', 'enzyme',
  'mutRate', 'reproE', 'biomass', 'maturity', 'cells',
  'gut', 'muscle', 'nerve', 'gonad', 'regActivity', 'kills',
];
console.log(cols.join(','));

function row(s) {
  const t = s.tissues || [0, 0, 0, 0];
  return [
    s.tick, s.pop, s.food, s.species, s.births, s.deaths, s.immigrants,
    s.avgGen.toFixed(3), s.maxGen, s.size.toFixed(5), s.speed.toFixed(5),
    s.sense.toFixed(5), s.enzyme.toFixed(5), s.mutRate.toFixed(5),
    s.reproE.toFixed(5), s.biomass.toFixed(5), s.maturity.toFixed(5),
    s.cells.toFixed(3), t[0].toFixed(5), t[1].toFixed(5), t[2].toFixed(5),
    t[3].toFixed(5), s.regActivity.toFixed(5), s.kills,
  ].join(',');
}

for (let t = 1; t <= TICKS; t++) {
  w.step();
  if (t % SAMPLE === 0 || t === TICKS) console.log(row(w.stats()));
}
