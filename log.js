/* log.js — write per-sample population and trait means to CSV.
 *
 *   node log.js > run.csv
 *   TICKS=40000 SAMPLE=100 SEED=3 node log.js > run.csv
 *   IMMIGRATION_BELOW=0 node log.js > no-seedbank.csv
 *   SEXUAL=0 node log.js > asexual.csv
 *
 * `hue` is a neutral marker (it does not affect fitness). Compare directional
 * change in functional traits (size, speed, sense, enzyme, diet, defense, ...)
 * against `hue`/`hueSpread`: change much larger than hue drift suggests
 * selection; change similar to hue drift suggests mostly drift.
 * `immDesc`/`native` track what fraction of the living population descends from
 * injected immigrants (seed bank), so runs with `immigrationBelow=0` show pure
 * evolutionary persistence.
 */
const A = require('./sim.js');

const TICKS = parseInt(process.env.TICKS || '40000', 10);
const SAMPLE = Math.max(1, parseInt(process.env.SAMPLE || '100', 10));
const SEED = parseInt(process.env.SEED || '1', 10);
const SEXUAL = process.env.SEXUAL === undefined ? undefined : process.env.SEXUAL === '1';
const IMMIGRATION_BELOW = process.env.IMMIGRATION_BELOW === undefined ? undefined : parseFloat(process.env.IMMIGRATION_BELOW);
const REALISTIC = process.env.REALISTIC === '1';

const opts = { seed: SEED };
if (SEXUAL !== undefined) opts.sexual = SEXUAL;
if (IMMIGRATION_BELOW !== undefined) opts.immigrationBelow = IMMIGRATION_BELOW;
if (REALISTIC) opts.realisticMode = true;
const w = new A.World(opts);

const cols = [
  'tick', 'pop', 'food', 'faunaFood', 'season', 'species', 'births', 'deaths', 'immigrants', 'immDesc', 'native',
  'avgGen', 'maxGen', 'size', 'speed', 'sense', 'enzyme', 'diet', 'defense', 'alert',
  'mutRate', 'reproE', 'biomass', 'maturity', 'cells',
  'gut', 'muscle', 'nerve', 'gonad', 'regActivity', 'kills',
  'hue', 'hueSpread',
];
console.log(cols.join(','));

function row(s) {
  const t = s.tissues || [0, 0, 0, 0];
  return [
    s.tick, s.pop, s.food, s.faunaFood ?? 0, (s.season ?? 0).toFixed(5), s.species, s.births, s.deaths, s.immigrants,
    (s.immDesc ?? 0).toFixed(5), (s.native ?? 1).toFixed(5),
    s.avgGen.toFixed(3), s.maxGen, s.size.toFixed(5), s.speed.toFixed(5),
    s.sense.toFixed(5), s.enzyme.toFixed(5), (s.diet ?? 0).toFixed(5), (s.defense ?? 0).toFixed(5), (s.alert ?? 0).toFixed(5),
    s.mutRate.toFixed(5), s.reproE.toFixed(5), s.biomass.toFixed(5), s.maturity.toFixed(5),
    s.cells.toFixed(3), t[0].toFixed(5), t[1].toFixed(5), t[2].toFixed(5),
    t[3].toFixed(5), s.regActivity.toFixed(5), s.kills,
    (s.hue ?? 0).toFixed(5), (s.hueSpread ?? 0).toFixed(5),
  ].join(',');
}

for (let t = 1; t <= TICKS; t++) {
  w.step();
  if (t % SAMPLE === 0 || t === TICKS) console.log(row(w.stats()));
}
