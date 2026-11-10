/* sim.js — headless artificial-life core.
 *
 * No p5, no DOM, no globals beyond `ALife`. The browser sketch (sketch.js)
 * only reads state out of a World and draws it. That separation means you can
 * run thousands of ticks in node and actually measure whether the dynamics are
 * stable instead of squinting at the canvas.
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const wrap = (v, m) => { v %= m; return v < 0 ? v + m : v; };
  function wrapDelta(d, m) {
    if (d > m / 2) d -= m;
    else if (d < -m / 2) d += m;
    return d;
  }

  // Deterministic habitat fields (no RNG). Returns fertility/hazard ~0..1.
  function habitatAt(x, y, p, hs) {
    const s = p.habitatScale || 0.009;
    const a = Math.sin((x + hs * 0.13) * s) * Math.cos((y - hs * 0.07) * s * 1.3);
    const b = Math.cos((x * 0.7 - y * 0.9 + hs * 0.21) * s * 0.73);
    const v = (a + b) * 0.5; // ~ -1..1
    const fert = clamp(0.5 + v * (p.habitatStrength || 0.55), 0.05, 1);
    const hazard = clamp(0.5 - v * (p.hazardStrength || 0.30), 0, 1);
    return { fertility: fert, hazard: hazard };
  }

  // ---------------------------------------------------------------- random --
  // One RNG per World, so a seed fully determines a run and two worlds can
  // exist side by side without stealing each other's random numbers.
  class Rng {
    constructor(seed) {
      this.state = (seed >>> 0) || 0x9e3779b9;
      this._spare = null;
    }
    next() {
      let a = this.state;
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      this.state = a;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(a, b) { return a + this.next() * (b - a); }
    int(n) { return (this.next() * n) | 0; }
    pick(arr) { return arr[(this.next() * arr.length) | 0]; }
    normal() {
      if (this._spare !== null) { const s = this._spare; this._spare = null; return s; }
      let u, v, s;
      do {
        u = this.next() * 2 - 1;
        v = this.next() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const m = Math.sqrt(-2 * Math.log(s) / s);
      this._spare = v * m;
      return u * m;
    }
  }

  // Module-level normal, kept for the dev scripts. Worlds never use it.
  let spare = null;
  function randn() {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u, v, s;
    do {
      u = Math.random() * 2 - 1;
      v = Math.random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m;
    return u * m;
  }

  // ---------------------------------------------------------------- genome --
  // 14 inputs -> 6 tanh hidden -> 3 outputs (turn, thrust, effort). 117 weights.
  // Inputs are egocentric/local: food vec+prox+type, creature vec+threat cue,
  // energy, speed, gut fill, fertility, hazard, season, condition.
  const IN = 14, HID = 6, OUT = 3;
  const NW = IN * HID + HID + HID * OUT + OUT;
  const NW_8_2 = 8 * HID + HID + HID * 2 + 2;
  const NW_12_2 = 12 * HID + HID + HID * 2 + 2;

  function migrateWeights(oldW) {
    const w = new Float32Array(NW);
    if (!oldW) return w;
    let oldIn = 0, oldOut = 0;
    if (oldW.length === NW) return Float32Array.from(oldW);
    if (oldW.length === NW_8_2) { oldIn = 8; oldOut = 2; }
    else if (oldW.length === NW_12_2) { oldIn = 12; oldOut = 2; }
    else if (oldW.length === IN * HID + HID + HID * 2 + 2) { oldIn = IN; oldOut = 2; }
    else return w;
    const src = oldW;
    const inN = Math.min(oldIn, IN);
    for (let j = 0; j < HID; j++) for (let i = 0; i < inN; i++) w[j * IN + i] = +src[j * oldIn + i] || 0;
    for (let j = 0; j < HID; j++) w[IN * HID + j] = +src[oldIn * HID + j] || 0;
    const hbOld = oldIn * HID + HID, hbNew = IN * HID + HID;
    const outN = Math.min(oldOut, OUT);
    for (let o = 0; o < outN; o++) for (let j = 0; j < HID; j++) w[hbNew + o * HID + j] = +src[hbOld + o * HID + j] || 0;
    const obOld = hbOld + HID * oldOut, obNew = hbNew + HID * OUT;
    for (let o = 0; o < outN; o++) w[obNew + o] = +src[obOld + o] || 0;
    if (OUT > oldOut) w[obNew + 2] = 0.35; // effort: moderate default
    return w;
  }

  // Each gene is a scalar with a hard range. `sigma` is the mutation step at
  // the reference mutation rate (0.15); actual step scales with the creature's
  // own mutRate gene, so evolvability itself is heritable.
  const GENE_DEFS = [
    { key: 'size',     min: 0.55, max: 2.10, sigma: 0.10 },
    { key: 'speedMax', min: 0.20, max: 2.20, sigma: 0.10 },
    { key: 'sense',    min: 12,   max: 110,  sigma: 7    },
    { key: 'hue',      min: 0,    max: 1,    sigma: 0.02, wrap: true },
    { key: 'mutRate',  min: 0.02, max: 0.60, sigma: 0.02 },
    { key: 'reproE',   min: 20,   max: 80,   sigma: 4    },
    { key: 'enzyme',   min: 0.25, max: 2.00, sigma: 0.08 },
    // Developmental allocation: relative biomass investment in each tissue.
    // These are normalised into fractions that sum to one, so only their
    // ratios matter. `devTiming` is the maturity fraction at which the adult
    // allocation fully replaces the juvenile allocation.
    { key: 'allocGut',    min: 0.05, max: 1.00, sigma: 0.03 },
    { key: 'allocMuscle', min: 0.05, max: 1.00, sigma: 0.03 },
    { key: 'allocNerve',  min: 0.05, max: 1.00, sigma: 0.03 },
    { key: 'allocGonad',  min: 0.05, max: 1.00, sigma: 0.03 },
    { key: 'devTiming',   min: 0.30, max: 0.90, sigma: 0.03 },
  ];
  const GENE_BY_KEY = {};
  const GENE_DEFAULT = {};
  for (let i = 0; i < GENE_DEFS.length; i++) {
    const d = GENE_DEFS[i];
    GENE_BY_KEY[d.key] = d;
    GENE_DEFAULT[d.key] = (d.min + d.max) * 0.5;
  }
  // Neutral development: equal allocation and an adult switch at 60% maturity.
  // Old saves predate these loci; filling these values keeps their creatures
  // phenotypically unchanged.
  const DEV_KEYS = ['allocGut', 'allocMuscle', 'allocNerve', 'allocGonad'];
  for (let i = 0; i < DEV_KEYS.length; i++) GENE_DEFAULT[DEV_KEYS[i]] = 0.25;
  GENE_DEFAULT.devTiming = 0.60;

  function normalizeGenes(genes) {
    for (let i = 0; i < GENE_DEFS.length; i++) {
      const d = GENE_DEFS[i];
      let v = +genes[d.key];
      if (!Number.isFinite(v)) v = GENE_DEFAULT[d.key];
      genes[d.key] = d.wrap ? wrap(v, 1) : clamp(v, d.min, d.max);
    }
    return genes;
  }

  // Species / mating distance uses the functional genes. `hue` is deliberately
  // excluded: it is a neutral marker, so including it would split lineages
  // every time colour drifted.
  const SPECIES_KEYS = ['size', 'speedMax', 'sense', 'mutRate', 'reproE', 'enzyme'];
  const SPECIES_RANGES = SPECIES_KEYS.map((k) => GENE_BY_KEY[k].max - GENE_BY_KEY[k].min);

  function genesToVec(genes) {
    const v = new Array(SPECIES_KEYS.length);
    for (let i = 0; i < SPECIES_KEYS.length; i++) {
      const g = GENE_BY_KEY[SPECIES_KEYS[i]];
      v[i] = (genes[g.key] - g.min) / (g.max - g.min);
    }
    return v;
  }

  function vecDistance(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      s += d * d;
    }
    return Math.sqrt(s / a.length);
  }

  function genomeDistance(a, b) {
    return vecDistance(genesToVec(a), genesToVec(b));
  }

  // --------------------------------------------------------- regulation --
  // A small recurrent gene-regulatory network. The scalar genes are the
  // structural loci; this network decides how strongly each one is expressed
  // given the creature's internal state. Regulators and promoters are
  // heritable and mutate like anything else, so regulation itself evolves.
  const REG_GENES = ['speedMax', 'sense', 'mutRate', 'reproE', 'enzyme'];
  const REG_N = 4;      // regulatory proteins
  const ENV_N = 6;      // environmental / internal inputs
  const NG = REG_GENES.length;
  const RG_BOUND = 4;

  function zeroRg() {
    return {
      base: new Array(REG_N).fill(0),
      W: new Array(REG_N * REG_N).fill(0),
      V: new Array(REG_N * ENV_N).fill(0),
      promBase: new Array(NG).fill(0),
      promW: new Array(NG * REG_N).fill(0),
    };
  }

  // Missing fields default to zero, which gives neutral expression: the
  // realised trait equals the structural gene. That keeps v1/v2 saves loadable.
  function normalizeRg(rg) {
    const z = zeroRg();
    if (!rg) return z;
    const copy = (src, dst) => {
      if (!src) return;
      for (let i = 0; i < dst.length; i++) {
        if (Number.isFinite(src[i])) dst[i] = +src[i];
      }
    };
    copy(rg.base, z.base);
    copy(rg.W, z.W);
    copy(rg.V, z.V);
    copy(rg.promBase, z.promBase);
    copy(rg.promW, z.promW);
    return z;
  }

  function randomRg(rng) {
    const rg = zeroRg();
    const f = () => rng.normal() * 0.35;
    for (let i = 0; i < rg.base.length; i++) rg.base[i] = f();
    for (let i = 0; i < rg.W.length; i++) rg.W[i] = f();
    for (let i = 0; i < rg.V.length; i++) rg.V[i] = f();
    for (let i = 0; i < rg.promBase.length; i++) rg.promBase[i] = f();
    for (let i = 0; i < rg.promW.length; i++) rg.promW[i] = f();
    return rg;
  }

  function mutateRg(parent, rng, scale) {
    const rg = zeroRg();
    const mut = (dst, src) => {
      for (let i = 0; i < dst.length; i++) {
        const v = (src ? src[i] : 0) + rng.normal() * 0.30 * scale;
        dst[i] = clamp(v, -RG_BOUND, RG_BOUND);
      }
    };
    mut(rg.base, parent.base);
    mut(rg.W, parent.W);
    mut(rg.V, parent.V);
    mut(rg.promBase, parent.promBase);
    mut(rg.promW, parent.promW);
    return rg;
  }

  function crossoverRg(a, b, rng, scale) {
    const rg = zeroRg();
    const mix = (dst, x, y) => {
      for (let i = 0; i < dst.length; i++) {
        let v = rng.next() < 0.5 ? x[i] : y[i];
        if (rng.next() < 0.25) v = (x[i] + y[i]) * 0.5;
        dst[i] = clamp(v + rng.normal() * 0.30 * scale, -RG_BOUND, RG_BOUND);
      }
    };
    mix(rg.base, a.base, b.base);
    mix(rg.W, a.W, b.W);
    mix(rg.V, a.V, b.V);
    mix(rg.promBase, a.promBase, b.promBase);
    mix(rg.promW, a.promW, b.promW);
    return rg;
  }

  // ------------------------------------------------------------ development --
  // Growth is cell division plus differentiation. New biomass is allocated
  // across four tissues by a heritable program: juveniles bias investment
  // toward gut and nerve, adults toward the adult allocation encoded in the
  // structural genes. Tissue fractions then modulate realised traits, so
  // body composition is visible in how a creature lives.
  const TISSUE_N = 4; // gut, muscle, nerve, gonad

  // Relative to an even 25% allocation, which is exactly neutral (factor 1).
  function tissueFactor(f) {
    return clamp(0.6 + 1.6 * f, 0.6, 1.5);
  }
  function gonadFactor(f) {
    return clamp(1.3 - 1.2 * f, 0.7, 1.3);
  }
  const smoothstep = (u) => u * u * (3 - 2 * u);

  // ---------------------------------------------------------------- params --
  const DEFAULTS = {
    width: 900,
    height: 700,

    // Two resource types create dietary niches. `flora` (type 0) is common;
    // `fauna` (type 1) is richer but rarer and harder to digest without enzyme.
    foodCap: 450,
    foodGrowth: 1.8,
    foodEnergy: 28,
    foodEnergyFauna: 42,
    faunaChance: 0.18,
    foodRadius: 2.2,
    seedFood: 0.7,

    // Food is patchy: most spawns cluster around a few slowly drifting
    // "meadows". Uniform scatter is boring; patchiness creates territories.
    patchCount: 5,
    patchSpread: 120,
    patchBias: 0.7,

    // Habitat: deterministic spatial fertility/hazard fields (sampled by x,y).
    // Fertility boosts local regrowth and flora quality; hazard adds stress.
    habitatScale: 0.009,
    habitatStrength: 0.55,
    hazardStrength: 0.30,
    hazardCost: 0.025,      // extra ATP drain per hazard * mass^0.75
    senescenceAge: 3000,
    senescenceCost: 0.015,  // extra basal drain fraction over senescence age
    alertSenseBoost: 0.25,  // how much vigilance (effort) expands perception
    senseCost: 0.012,       // ATP cost of active sensing per (radius/80)^2 * mass^0.75

    startPop: 70,
    maxPop: 600,          // hard CPU / stability ceiling
    immigrationBelow: 20, // if the population crashes, trickle in random genomes
    immigrationRate: 0.30,

    // Predation: any creature can eat one much smaller than itself. This is
    // the counter-pressure that stops "be tiny and cheap" from being the only
    // viable strategy. Turn off for a pure foraging world.
    predation: true,
    preySizeRatio: 1.45,
    preyEnergyGain: 0.5,
    preyMassGain: 12,

    // Metabolism. The fixed `basal` term and the `thresholdBase` in the
    // reproduction threshold are what stop "be as small as possible" from
    // being strictly optimal.
    basal: 0.05,
    basalMass: 0.04,
    moveCost: 0.10,
    sprintCost: 2.5,      // extra cost at full speed (sprint); cruise is much cheaper
    idleDamp: 0.10,       // thrust multiplier when no food/creature is sensed (wait/stop)
    senseDrive: 0.35,     // movement drive when a creature is sensed but no food is
    thresholdBase: 30,

    // Digestion: nutrient -> ATP + biomass (Michaelis-Menten). Food type
    // modifies yields/digestibility: fauna is richer but needs higher enzyme.
    digestRate: 5.0,      // max nutrient processed per tick at enzyme = 1
    digestKm: 12,         // nutrient level at half-maximal digestion
    atpYield: 1.0,        // ATP per nutrient (flora)
    biomassYield: 0.030,  // biomass per nutrient (flora)
    faunaAtpYield: 1.12,
    faunaBiomassYield: 0.042,
    faunaDigestBase: 0.55,
    faunaDigestEnzyme: 0.45, // digestibility = base + enzymeScale*clamp(enzyme/2,0,1)
    growthCost: 5.0,      // ATP spent per biomass synthesized
    catabolism: 3.0,      // ATP released per biomass burned while starving
    gutBase: 18,          // gut capacity = gutBase + gutSize * size
    gutSize: 14,
    birthMassFrac: 0.05,  // offspring biomass as a fraction of adult mass
    matureFrac: 0.72,     // fraction of adult mass needed to reproduce
    minBiomass: 0.02,     // below this a starving creature dies
    cellMass: 0.02,       // biomass per cell; growth is cell division

    // Gene regulation. Regulators relax toward their network target each tick;
    // lower values make expression sluggish, higher values make it twitchy.
    regRelax: 0.35,

    maxTurn: 0.28,   // radians per tick at full turn output
    steer: 0.25,     // velocity smoothing toward heading
    reproCost: 0.52, // fraction of threshold the parent spends
    reproShare: 0.42,// fraction of threshold the child receives

    // Species are rebuilt every `speciesInterval` ticks by clustering the
    // functional genes. `speciesRadius` is a normalized distance (0..1).
    speciesInterval: 90,
    speciesRadius: 0.22,
    speciesGrace: 900,
    maxSpecies: 12,

    // Sexual reproduction is opt-in. Two compatible, well-fed creatures within
    // `mateRange` pay the cost together and the child gets a crossover of both
    // genomes. `mateRadius` is the compatibility distance; lowering it turns
    // the population into reproductively isolated species.
    sexual: true,
    mateRange: 160,
    mateRadius: 0.80,
    mateMinEnergy: 0.60,
  };

  // ------------------------------------------------------------------ grid --
  // Uniform bucket grid with toroidal wrap. Queries return candidates; callers
  // do the exact distance test. Reused arrays mean no per-tick allocation.
  class Grid {
    constructor(w, h, cell) {
      this.cols = Math.max(1, Math.ceil(w / cell));
      this.rows = Math.max(1, Math.ceil(h / cell));
      this.cw = w / this.cols;
      this.ch = h / this.rows;
      this.buckets = new Array(this.cols * this.rows);
      for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
    }
    clear() {
      for (let i = 0; i < this.buckets.length; i++) this.buckets[i].length = 0;
    }
    insert(o) {
      const cx = clamp(Math.floor(o.x / this.cw), 0, this.cols - 1);
      const cy = clamp(Math.floor(o.y / this.ch), 0, this.rows - 1);
      this.buckets[cy * this.cols + cx].push(o);
    }
    query(x, y, r, out) {
      out.length = 0;
      const x0 = Math.floor((x - r) / this.cw);
      const x1 = Math.floor((x + r) / this.cw);
      const y0 = Math.floor((y - r) / this.ch);
      const y1 = Math.floor((y + r) / this.ch);
      for (let gy = y0; gy <= y1; gy++) {
        const ry = ((gy % this.rows) + this.rows) % this.rows;
        for (let gx = x0; gx <= x1; gx++) {
          const rx = ((gx % this.cols) + this.cols) % this.cols;
          const b = this.buckets[ry * this.cols + rx];
          for (let i = 0; i < b.length; i++) out.push(b[i]);
        }
      }
      return out;
    }
  }

  // ----------------------------------------------------------------- world --
  class World {
    constructor(opts) {
      const p = (this.p = Object.assign({}, DEFAULTS, opts || {}));
      this.w = p.width;
      this.h = p.height;
      this.tick = 0;
      this.nextId = 1;
      this.food = [];
      this.creatures = [];
      this.born = [];
      this.spawnAcc = 0;
      this.immigrants = 0;
      this.deaths = 0;
      this.births = 0;
      this.sexualBirths = 0;
      this.asexualBirths = 0;

      this.seed = (opts && opts.seed !== undefined && opts.seed !== null)
        ? (opts.seed >>> 0)
        : ((Math.random() * 4294967296) >>> 0);
      this.rng = new Rng(this.seed);
      this.habitatSeed = (this.seed ^ 0x5bf03635) >>> 0;

      this.nextSpeciesId = 1;
      this.species = [];
      this.allSpecies = [];       // permanent record of every species that ever appeared

      this.foodGrid = new Grid(this.w, this.h, 64);
      this.creatureGrid = new Grid(this.w, this.h, 64);

      // scratch, reused every tick
      this._candA = [];
      this._candB = [];
      this._candM = [];
      this._in = new Float32Array(IN);
      this._hid = new Float32Array(HID);
      this._out = new Float32Array(OUT);
      this._reg = new Float32Array(REG_N);
      this._env = new Float32Array(ENV_N);

      this.patches = [];
      for (let i = 0; i < p.patchCount; i++) {
        this.patches.push({
          x: this.rng.next() * this.w,
          y: this.rng.next() * this.h,
          vx: this.rng.normal() * 0.05,
          vy: this.rng.normal() * 0.05,
        });
      }

      for (let i = 0; i < p.startPop; i++) this.creatures.push(this.randomCreature());
      for (let i = 0; i < p.foodCap * p.seedFood; i++) this.spawnFood();

      this.rebuildSpecies();
    }

    // -------------------------------------------------------------- factory --
    randomGenome() {
      const genes = {};
      for (let i = 0; i < GENE_DEFS.length; i++) {
        const g = GENE_DEFS[i];
        genes[g.key] = g.min + this.rng.next() * (g.max - g.min);
      }
      // Founders start with a near-neutral body plan instead of a random
      // allocation that would starve or explode. Mutation can still explore
      // the whole range from here.
      for (let i = 0; i < DEV_KEYS.length; i++) {
        genes[DEV_KEYS[i]] = clamp(0.25 + this.rng.normal() * 0.04, 0.08, 0.6);
      }
      genes.devTiming = clamp(0.60 + this.rng.normal() * 0.04, 0.35, 0.85);
      const w = new Float32Array(NW);
      for (let i = 0; i < NW; i++) w[i] = this.rng.normal() * 0.35;

      // Innate foraging reflex. Hid 0 steers toward food; hid 1 drives thrust
      // from food cues; out 2 (effort) starts moderate so behavior is evolvable.
      // Low thrust bias means founders rest when idle; costs/drive reinforce it.
      const jitter = () => 0.6 + this.rng.next() * 0.8;
      const hb = IN * HID, ho = IN * HID + HID, ob = IN * HID + HID + HID * OUT;
      w[0 * IN + 1] = 1.5 * jitter();          // food right -> hid 0 (turn)
      w[hb + 0] = 0;
      w[ho + 0 * OUT?0:0 + 0] = 0; // placeholder, fixed below
      w[ho + 0 * HID + 0] = 1.8 * jitter();    // hid 0 -> turn (out 0)
      // hid 1: thrust
      w[1 * IN + 0] = 1.8 * jitter();          // food ahead
      w[1 * IN + 2] = 1.4 * jitter();          // food proximity
      w[1 * IN + 8] = 0.6 * jitter();          // gut fill awareness
      w[1 * IN + 12] = 0.3 * jitter();         // season/condition (input 12)
      w[hb + 1] = 0;
      w[ho + 1 * HID + 1] = 1.6 * jitter();    // hid 1 -> thrust (out 1)
      // hid 2: effort/vigilance from energy, threat, hazard
      w[2 * IN + 5] = 0.8 * jitter();          // energy
      w[2 * IN + 10] = -0.5 * jitter();        // hazard -> caution
      w[2 * IN + 13] = -0.4 * jitter();        // threat cue
      w[hb + 2] = 0;
      w[ho + 2 * HID + 2] = 0.8 * jitter();    // hid 2 -> effort (out 2)
      w[ob + 1] = -0.25;                       // thrust bias (rest when idle)
      w[ob + 2] = 0.35;                        // effort bias (moderate)
      genes.rg = randomRg(this.rng);
      return { genes, w };
    }

    randomCreature() {
      const g = this.randomGenome();
      const c = this.makeCreature(
        g.genes, g.w, 0,
        this.rng.next() * this.w, this.rng.next() * this.h,
        this.rng.next() * TAU
      );
      // Founders and immigrants arrive as adults; only offspring start small.
      this.setBiomass(c, c.targetMass);
      return c;
    }

    // Body size follows accumulated biomass, so juveniles are genuinely small
    // and become both faster and more conspicuous as they grow.
    setBiomass(c, biomass) {
      c.biomass = Math.max(this.p.minBiomass, biomass);
      c.mass = c.biomass;
      c.mass075 = Math.pow(c.mass, 0.75);
      c.radius = 2 + Math.sqrt(c.mass) * 2.2;
    }

    // Realised traits are the structural genes filtered through the current
    // regulatory state, then through body composition. `size` stays
    // structural (it sets the adult target); the rest can be up- or
    // down-regulated within 0.5x..1.5x of the gene.
    computeTraits(c) {
      const rg = c.genes.rg;
      const t = c.traits;
      const g = c.genes;
      t.size = g.size;
      for (let i = 0; i < NG; i++) {
        const key = REG_GENES[i];
        let z = rg.promBase[i];
        for (let j = 0; j < REG_N; j++) z += rg.promW[i * REG_N + j] * c.reg[j];
        const e = 1 / (1 + Math.exp(-z));
        const d = GENE_BY_KEY[key];
        const norm = (g[key] - d.min) / (d.max - d.min);
        t[key] = d.min + (d.max - d.min) * clamp(norm * (0.5 + e), 0, 1);
      }

      // ---- development ----
      // Allocate body biomass across tissues. Juvenile weights bias gut and
      // nerve; adult weights are the heritable allocation. The switch happens
      // smoothly over `devTiming` of the way to adult mass.
      const sum = g.allocGut + g.allocMuscle + g.allocNerve + g.allocGonad;
      const aG = g.allocGut / sum, aM = g.allocMuscle / sum;
      const aN = g.allocNerve / sum, aGo = g.allocGonad / sum;
      const jG = g.allocGut * 1.6, jM = g.allocMuscle * 0.5;
      const jN = g.allocNerve * 1.4, jGo = g.allocGonad * 0.15;
      const jsum = jG + jM + jN + jGo;
      const m = clamp(c.biomass / c.targetMass, 0, 1);
      const u = clamp(m / g.devTiming, 0, 1);
      const s = smoothstep(u);
      const tis = c.tissues;
      tis[0] = (jG / jsum) + (aG - jG / jsum) * s;
      tis[1] = (jM / jsum) + (aM - jM / jsum) * s;
      tis[2] = (jN / jsum) + (aN - jN / jsum) * s;
      tis[3] = (jGo / jsum) + (aGo - jGo / jsum) * s;

      const gf = tissueFactor(tis[0]);
      const mf = tissueFactor(tis[1]);
      const nf = tissueFactor(tis[2]);
      const gof = gonadFactor(tis[3]);
      t.enzyme *= gf;
      t.speedMax *= mf;
      t.sense *= nf;

      c.gutCap = (this.p.gutBase + this.p.gutSize * g.size) * gf;
      if (c.nutrient > c.gutCap) c.nutrient = c.gutCap;
      // Cell count is a developmental readout: every offspring starts as one
      // cell, and division tracks progress from birth mass to adult mass.
      const birthB = c.targetMass * this.p.birthMassFrac;
      const df = clamp((c.biomass - birthB) / (c.targetMass - birthB), 0, 1);
      const adultCells = Math.max(2, Math.round(c.targetMass / this.p.cellMass));
      c.cells = 1 + Math.round(df * (adultCells - 1));
      c.threshold = (this.p.thresholdBase + t.reproE * c.targetMass) * gof;
      c.maxEnergy = c.threshold * 1.7;

      // Functional morphology (derived): inertia limits turning for large
      // bodies; muscle improves maneuver/propulsion; drag rises with size and
      // falls with muscle; defense combines mass, muscle, and nerve (evasion).
      const inertia = 0.55 + 0.45 * Math.sqrt(c.mass);
      c.turnRate = (this.p.maxTurn || 0.28) * (0.65 + 0.7 * mf) / inertia;
      c.defense = clamp(0.08 + 0.22 * Math.sqrt(c.mass) + 0.35 * mf + 0.15 * nf, 0, 0.85);
      c.drag = clamp(1.05 - 0.18 * mf + 0.10 * Math.sqrt(c.mass), 0.7, 1.45);
      // Vigilance: brain effort + nerve tissue raise alertness; fatigue lowers it.
      // Updated after the brain reads inputs; used for sensing radius next tick.
      const alertBase = c.alert != null ? c.alert : 0.4;
      c.alert = clamp(alertBase * 0.6 + 0.4 * (0.5 * clamp(c.energy / (c.threshold || 1), 0, 1.2) + 0.3 * nf + 0.2), 0.1, 1);
    }

    updateRegulation(c, fprox, crowding) {
      const rg = c.genes.rg;
      const env = this._env;
      env[0] = clamp(c.nutrient / c.gutCap, 0, 1);
      env[1] = clamp(c.energy / c.threshold, 0, 1.5) / 1.5;
      env[2] = clamp(c.biomass / c.targetMass, 0, 1);
      env[3] = clamp(crowding / 8, 0, 1);
      env[4] = clamp(fprox, 0, 1);
      env[5] = clamp(c.age / 500, 0, 1);

      const reg = c.reg;
      const next = this._reg;
      for (let i = 0; i < REG_N; i++) {
        let s = rg.base[i];
        for (let j = 0; j < REG_N; j++) s += rg.W[i * REG_N + j] * reg[j];
        for (let k = 0; k < ENV_N; k++) s += rg.V[i * ENV_N + k] * env[k];
        next[i] = Math.tanh(s);
      }
      const a = this.p.regRelax;
      for (let i = 0; i < REG_N; i++) reg[i] += (next[i] - reg[i]) * a;
      this.computeTraits(c);
    }

    makeCreature(genes, weights, gen, x, y, heading) {
      const p = this.p;
      normalizeGenes(genes);
      if (!genes.rg) genes.rg = zeroRg();
      const targetMass = genes.size * genes.size;
      const c = {
        id: this.nextId++,
        genes,
        w: weights,
        gen,
        x, y, heading,
        vx: 0,
        vy: 0,
        targetMass,
        mass: targetMass,
        radius: 2 + genes.size * 2.2,
        eaten: 0,
        kills: 0,
        children: 0,
        age: 0,
        dead: false,
        species: 0,
        speciesHue: 0,
        matedTick: -1,
        huntCooldown: 0,
        alert: 0.4, // 0..1 vigilance; updated from brain effort each tick
        origin: 0, // 0 founder/native lineage, 1 immigrant lineage (propagates)
        nutrient: 0,
        diet: 0, // EMA of food type eaten: 0 flora, 1 fauna
        biomass: targetMass,
        gutCap: p.gutBase + p.gutSize * genes.size,
        reg: new Float32Array(REG_N),
        tissues: new Float32Array(TISSUE_N),
        traits: { size: genes.size },
        cells: 1,
      };
      c.mass075 = Math.pow(c.mass, 0.75);
      c.threshold = p.thresholdBase + genes.reproE * targetMass;
      c.maxEnergy = c.threshold * 1.7;
      c.matureBiomass = targetMass * p.matureFrac;
      this.setBiomass(c, targetMass * p.birthMassFrac);
      this.computeTraits(c);
      c.energy = c.threshold * 0.55;
      return c;
    }

    // Mutation. Gene steps scale with the parent's mutRate, so lineages can
    // evolve to be conservative or exploratory. Weights get the same scaling.
    childOf(parent) {
      const p = this.p;
      const g = parent.genes;
      const scale = clamp(parent.traits.mutRate, 0.02, 0.6) / 0.15;

      const genes = {};
      for (let i = 0; i < GENE_DEFS.length; i++) {
        const d = GENE_DEFS[i];
        let v = g[d.key] + this.rng.normal() * d.sigma * (d.key === 'mutRate' ? 1 : scale);
        v = d.wrap ? wrap(v, 1) : clamp(v, d.min, d.max);
        genes[d.key] = v;
      }
      genes.rg = mutateRg(g.rg || zeroRg(), this.rng, scale);

      const w = new Float32Array(NW);
      for (let i = 0; i < NW; i++) {
        w[i] = clamp(parent.w[i] + this.rng.normal() * 0.3 * scale, -6, 6);
      }

      const angle = this.rng.next() * TAU;
      const child = this.makeCreature(
        genes, w, parent.gen + 1,
        wrap(parent.x + Math.cos(angle) * parent.radius * 1.5, this.w),
        wrap(parent.y + Math.sin(angle) * parent.radius * 1.5, this.h),
        angle
      );
      child.energy = parent.threshold * p.reproShare;
      child.origin = parent.origin ? 1 : 0;
      return child;
    }

    // Crossover: each gene and each weight is inherited from one parent, with
    // occasional averaging of weights, then mutated at the parents' mean rate.
    childOfSexual(a, b) {
      const p = this.p;
      const meanMut = clamp((a.traits.mutRate + b.traits.mutRate) * 0.5, 0.02, 0.6);
      const scale = meanMut / 0.15;

      const genes = {};
      for (let i = 0; i < GENE_DEFS.length; i++) {
        const d = GENE_DEFS[i];
        let v = this.rng.next() < 0.5 ? a.genes[d.key] : b.genes[d.key];
        v += this.rng.normal() * d.sigma * (d.key === 'mutRate' ? 1 : scale);
        v = d.wrap ? wrap(v, 1) : clamp(v, d.min, d.max);
        genes[d.key] = v;
      }
      genes.rg = crossoverRg(a.genes.rg || zeroRg(), b.genes.rg || zeroRg(), this.rng, scale);

      const w = new Float32Array(NW);
      for (let i = 0; i < NW; i++) {
        let v = this.rng.next() < 0.5 ? a.w[i] : b.w[i];
        if (this.rng.next() < 0.3) v = (a.w[i] + b.w[i]) * 0.5;
        w[i] = clamp(v + this.rng.normal() * 0.3 * scale, -6, 6);
      }

      const angle = this.rng.next() * TAU;
      const child = this.makeCreature(
        genes, w, Math.max(a.gen, b.gen) + 1,
        wrap((a.x + b.x) * 0.5 + Math.cos(angle) * 10, this.w),
        wrap((a.y + b.y) * 0.5 + Math.sin(angle) * 10, this.h),
        angle
      );
      child.energy = Math.min(a.threshold, b.threshold) * p.reproShare;
      child.origin = (a.origin || b.origin) ? 1 : 0;
      return child;
    }

    // ----------------------------------------------------------------- food --
    spawnFood() {
      const p = this.p;
      let x, y;
      if (this.patches.length && this.rng.next() < p.patchBias) {
        const q = this.patches[this.rng.int(this.patches.length)];
        x = wrap(q.x + this.rng.normal() * p.patchSpread, this.w);
        y = wrap(q.y + this.rng.normal() * p.patchSpread, this.h);
      } else {
        x = this.rng.next() * this.w;
        y = this.rng.next() * this.h;
      }
      const hab = habitatAt(x, y, p, this.habitatSeed);
      const faunaP = clamp((p.faunaChance || 0) * (0.65 + 0.7 * hab.fertility), 0, 0.6);
      const type = this.rng.next() < faunaP ? 1 : 0;
      const eBase = type ? (p.foodEnergyFauna != null ? p.foodEnergyFauna : p.foodEnergy * 1.5) : p.foodEnergy;
      const qual = type ? (0.85 + 0.3 * hab.fertility) : (0.7 + 0.6 * hab.fertility);
      this.food.push({ x, y, e: eBase * qual, type, dead: false });
    }

    // --------------------------------------------------------------- species --
    // Greedy clustering over the functional genes. Existing species keep their
    // id and colour while they have members; new clusters get the next id.
    // This is a visual/statistical lens, not something the creatures can sense.
    rebuildSpecies() {
      const t = this.tick;
      const list = this.creatures;
      const old = this.species;
      for (let i = 0; i < old.length; i++) {
        old[i].count = 0;
        old[i].sum.fill(0);
      }

      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const v = genesToVec(c.genes);
        let best = null;
        let bestD = this.p.speciesRadius;
        for (let k = 0; k < old.length; k++) {
          const sp = old[k];
          const d = vecDistance(v, sp.centroid);
          if (d < bestD) { bestD = d; best = sp; }
        }
        if (!best) {
          best = {
            id: this.nextSpeciesId++,
            hue: 0,
            centroid: v.slice(),
            sum: new Float64Array(v.length),
            count: 0,
            firstSeen: t,
            lastSeen: t,
            peak: 0,
          };
          best.hue = ((best.id * 137.508) % 360) / 360;
          old.push(best);
        }
        best.count++;
        for (let k = 0; k < v.length; k++) best.sum[k] += v[k];
        c.species = best.id;
        c.speciesHue = best.hue;
      }

      for (let i = 0; i < old.length; i++) {
        const sp = old[i];
        if (sp.count > 0) {
          for (let k = 0; k < sp.centroid.length; k++) sp.centroid[k] = sp.sum[k] / sp.count;
          sp.lastSeen = t;
          if (sp.count > sp.peak) sp.peak = sp.count;
        }
      }

      let kept = old.filter((sp) => sp.count > 0 || t - sp.lastSeen <= this.p.speciesGrace);

      if (kept.length > this.p.maxSpecies) {
        kept.sort((a, b) => b.count - a.count);
        kept = kept.slice(0, this.p.maxSpecies);
        const ids = new Set(kept.map((sp) => sp.id));
        const fallback = kept[0];
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (!ids.has(c.species)) {
            c.species = fallback.id;
            c.speciesHue = fallback.hue;
          }
        }
        for (let i = 0; i < kept.length; i++) kept[i].count = 0;
        for (let i = 0; i < list.length; i++) {
          const sp = kept.find((s) => s.id === list[i].species);
          if (sp) sp.count++;
        }
      }

      this.species = kept;
      this.recordSpeciesHistory(t);
    }

    // Persist every species that has ever existed so the UI can show a full
    // lineage catalog. Centroid values are normalized (SPECIES_KEYS order).
    recordSpeciesHistory(tick) {
      for (let i = 0; i < this.species.length; i++) {
        const sp = this.species[i];
        let rec = this.allSpecies.find((r) => r.id === sp.id);
        if (!rec) {
          rec = {
            id: sp.id, hue: sp.hue, centroid: sp.centroid.slice(),
            count: sp.count, peak: sp.peak,
            firstSeen: sp.firstSeen != null ? sp.firstSeen : tick,
            lastSeen: sp.lastSeen,
          };
          this.allSpecies.push(rec);
        } else {
          rec.centroid = sp.centroid.slice();
          rec.count = sp.count;
          rec.peak = Math.max(rec.peak, sp.peak);
          rec.lastSeen = sp.lastSeen;
        }
      }
      const active = new Set(this.species.map((s) => s.id));
      for (let i = 0; i < this.allSpecies.length; i++) {
        if (!active.has(this.allSpecies[i].id)) this.allSpecies[i].count = 0;
      }
    }

    speciesTraits(rec) {
      const t = {};
      for (let i = 0; i < SPECIES_KEYS.length; i++) {
        const key = SPECIES_KEYS[i];
        const d = GENE_BY_KEY[key];
        const n = rec.centroid && rec.centroid[i] != null ? rec.centroid[i] : 0.5;
        t[key] = d.min + n * (d.max - d.min);
      }
      return t;
    }

    // ----------------------------------------------------------- reproduction --
    reproduceAsexual(c) {
      c.energy -= c.threshold * this.p.reproCost;
      const child = this.childOf(c);
      c.children++;
      this.asexualBirths++;
      this.born.push(child);
    }

    findMate(c) {
      const p = this.p;
      const r = p.mateRange;
      const r2 = r * r;
      const cand = this.creatureGrid.query(c.x, c.y, r, this._candM);
      let best = null;
      let bestD = r2;
      for (let i = 0; i < cand.length; i++) {
        const o = cand[i];
        if (o === c || o.dead || o.matedTick === this.tick) continue;
        if (o.biomass < o.matureBiomass) continue;
        if (o.energy < o.threshold * p.mateMinEnergy) continue;
        const dx = wrapDelta(o.x - c.x, this.w);
        const dy = wrapDelta(o.y - c.y, this.h);
        const d = dx * dx + dy * dy;
        if (d >= bestD) continue;
        if (genomeDistance(c.genes, o.genes) > p.mateRadius) continue;
        best = o;
        bestD = d;
      }
      return best;
    }

    reproduceSexual(a, b) {
      const p = this.p;
      // Each parent pays half, so two-parent reproduction costs the same total
      // energy as one-parent reproduction. Without this, sex is a 2x tax and
      // the population collapses whenever mates are scarce.
      const share = p.reproCost * 0.5;
      a.energy -= a.threshold * share;
      b.energy -= b.threshold * share;
      a.matedTick = this.tick;
      b.matedTick = this.tick;
      a.children++;
      b.children++;
      this.sexualBirths++;
      this.born.push(this.childOfSexual(a, b));
    }

    // ------------------------------------------------------------------ step --
    step() {
      const p = this.p;
      const list = this.creatures;
      this.tick++;

      for (let i = 0; i < this.patches.length; i++) {
        const q = this.patches[i];
        q.x = wrap(q.x + q.vx, this.w);
        q.y = wrap(q.y + q.vy, this.h);
      }

      this.foodGrid.clear();
      for (let i = 0; i < this.food.length; i++) this.foodGrid.insert(this.food[i]);
      this.creatureGrid.clear();
      for (let i = 0; i < list.length; i++) this.creatureGrid.insert(list[i]);

      // logistic regrowth
      const seasonG = 0.72 + 0.56 * (0.5 + 0.5 * Math.sin(this.tick * 0.0017));
      this.spawnAcc += p.foodGrowth * seasonG * (1 - this.food.length / p.foodCap);
      while (this.spawnAcc >= 1 && this.food.length < p.foodCap) {
        this.spawnFood();
        this.spawnAcc -= 1;
      }
      if (this.food.length >= p.foodCap) this.spawnAcc = 0;

      this.born.length = 0;
      for (let i = 0; i < list.length; i++) this.updateCreature(list[i]);

      for (let i = 0; i < this.born.length; i++) {
        if (list.length >= p.maxPop) break;
        list.push(this.born[i]);
        this.births++;
      }

      // compact out the dead. A creature survives on ATP or on remaining body
      // mass; a predation kill is marked dead with energy -1 and cannot pay.
      let k = 0;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const alive = c.energy > 0 || (c.energy >= 0 && c.biomass > p.minBiomass);
        if (alive) {
          // `dead` is a per-tick marker set by predation. A creature can be
          // marked dead and still eat later in the same tick, so it may
          // survive; clear the marker or it would stay invisible to sensing,
          // predation and mating forever.
          c.dead = false;
          list[k++] = c;
        } else {
          this.deaths++;
        }
      }
      list.length = k;

      k = 0;
      for (let i = 0; i < this.food.length; i++) {
        const f = this.food[i];
        if (!f.dead) this.food[k++] = f;
      }
      this.food.length = k;

      // seed bank: never let the world go permanently sterile
      if (list.length < p.immigrationBelow) {
        const chance = p.immigrationRate * (1 - list.length / p.immigrationBelow);
        if (this.rng.next() < chance) {
          const imm = this.randomCreature();
          imm.origin = 1;
          list.push(imm);
          this.immigrants++;
        }
      }

      if (this.tick % p.speciesInterval === 0) this.rebuildSpecies();
    }

    updateCreature(c) {
      const p = this.p;
      const alertEff = c.alert != null ? c.alert : 0.4;
      const sense = c.traits.sense * (1 + (p.alertSenseBoost || 0) * alertEff);
      const sense2 = sense * sense;

      // ---- nearest food ----
      let fx = 0, fy = 0, fprox = 0;
      const cand = this.foodGrid.query(c.x, c.y, sense, this._candA);
      let bestF = null, bestFD = sense2;
      for (let i = 0; i < cand.length; i++) {
        const f = cand[i];
        if (f.dead) continue;
        const dx = wrapDelta(f.x - c.x, this.w);
        const dy = wrapDelta(f.y - c.y, this.h);
        const d = dx * dx + dy * dy;
        if (d < bestFD) { bestFD = d; bestF = f; fx = dx; fy = dy; }
      }
      if (bestF) {
        const dist = Math.sqrt(bestFD);
        fprox = 1 - dist / sense;
        fx /= sense;
        fy /= sense;
      }

      // ---- nearest creature + soft separation ----
      let ox = 0, oy = 0, nearCue = 0;
      const sepR = Math.max(sense, c.radius * 4);
      const cand2 = this.creatureGrid.query(c.x, c.y, sepR, this._candB);
      let bestCD = Infinity;
      let px = 0, py = 0;
      for (let i = 0; i < cand2.length; i++) {
        const o = cand2[i];
        if (o === c || o.dead) continue;
        const dx = wrapDelta(o.x - c.x, this.w);
        const dy = wrapDelta(o.y - c.y, this.h);
        const d = dx * dx + dy * dy;

        // Predation: capture depends on size, speed/condition, and prey defense.
        // Failed attacks cost energy and create handling time; prey may escape.
        if (p.predation && c.huntCooldown <= 0 && c.mass > o.mass * p.preySizeRatio) {
          const touch = c.radius + o.radius;
          if (d < touch * touch) {
            const ratio = c.mass / (o.mass + 1e-6);
            const cSpd = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
            const oSpd = Math.sqrt(o.vx * o.vx + o.vy * o.vy);
            const spdAdv = clamp((cSpd - oSpd) / ((c.traits.speedMax || 1) + 0.5) + 0.5, 0, 1);
            const preyDef = o.defense != null ? o.defense : clamp((o.tissues ? o.tissues[1] * 0.5 + o.tissues[2] * 0.5 : 0.25), 0, 1);
            const cond = clamp(c.energy / (c.threshold || 1), 0, 1.2);
            let pCatch = clamp(0.18 + 0.22 * (ratio - p.preySizeRatio) + 0.22 * spdAdv + 0.10 * cond - 0.28 * preyDef, 0.05, 0.95);
            if (this.rng.next() < pCatch) {
              const gain = Math.max(0, o.energy) * p.preyEnergyGain + o.mass * p.preyMassGain;
              c.energy = Math.min(c.maxEnergy, c.energy + gain);
              c.kills++;
              o.energy = -1;
              o.dead = true;
              c.huntCooldown = 6 + Math.min(18, ((ratio - 1) * 4) | 0);
              break;
            } else {
              c.huntCooldown = 4;
              c.energy -= Math.max(0.5, c.threshold * 0.01);
              const dist = Math.sqrt(Math.max(d, 1e-6));
              const nx = dx / dist, ny = dy / dist;
              o.vx += nx * 0.6; o.vy += ny * 0.6; // escape impulse
              o.energy -= Math.max(0.2, o.threshold * 0.004);
            }
          }
        }

        const minD = c.radius + o.radius;
        if (d < minD * minD && d > 1e-6) {
          const dist = Math.sqrt(d);
          const push = (minD - dist) * 0.35;
          px -= (dx / dist) * push;
          py -= (dy / dist) * push;
        }
        if (d < bestCD && d <= sense2) {
          bestCD = d; ox = dx; oy = dy;
          nearCue = clamp((o.mass - c.mass) / (c.mass + 1e-6), -1.5, 1.5);
        }
      }
      if (px !== 0 || py !== 0) {
        c.x = wrap(c.x + clamp(px, -2, 2), this.w);
        c.y = wrap(c.y + clamp(py, -2, 2), this.h);
      }
      if (bestCD < Infinity) {
        ox /= sense;
        oy /= sense;
      }

      // ---- gene regulation ----
      // Internal state and local conditions feed the regulatory network; the
      // resulting protein levels decide how strongly each trait is expressed.
      this.updateRegulation(c, fprox, cand2.length);

      // ---- brain ----
      // Inputs are egocentric: forward/right relative to heading, not world
      // x/y. That makes "turn toward food" a single positive weight, which
      // evolution can actually find. World-frame inputs make it a moving
      // target the network has no heading to solve.
      const season = 0.5 + 0.5 * Math.sin(this.tick * 0.0017 + (this.habitatSeed & 0xff) * 0.01);
      const hab0 = habitatAt(c.x, c.y, p, this.habitatSeed);
      const hab = {
        fertility: clamp(hab0.fertility * (0.75 + 0.5 * season), 0.03, 1),
        hazard: clamp(hab0.hazard * (0.82 + 0.35 * (1 - season)), 0, 1),
      };
      const fType = bestF ? (bestF.type | 0) : 0;
      const ch = Math.cos(c.heading), sh = Math.sin(c.heading);
      const inp = this._in;
      inp[0] = (fx * ch + fy * sh);          // food, forward
      inp[1] = (-fx * sh + fy * ch);         // food, right
      inp[2] = fprox;                        // food proximity 0..1
      inp[3] = (ox * ch + oy * sh);          // creature, forward
      inp[4] = (-ox * sh + oy * ch);         // creature, right
      inp[5] = clamp(c.energy / c.threshold, 0, 1.6) * 0.75;
      inp[6] = clamp(Math.sqrt(c.vx * c.vx + c.vy * c.vy) / (c.traits.speedMax || 1), 0, 1);
      inp[7] = 1;                            // bias
      inp[8] = clamp(c.nutrient / (c.gutCap || 1), 0, 1);
      inp[9] = hab.fertility;
      inp[10] = hab.hazard;
      inp[11] = bestF ? fType : 0;
      inp[12] = season;
      inp[13] = clamp(nearCue / 1.5, -1, 1);

      const w = c.w;
      const hid = this._hid;
      let p0 = 0;
      for (let j = 0; j < HID; j++) {
        let s = w[IN * HID + j];
        for (let i = 0; i < IN; i++) s += inp[i] * w[p0++];
        hid[j] = Math.tanh(s);
      }
      let q0 = IN * HID + HID;
      const out = this._out;
      for (let o = 0; o < OUT; o++) {
        let s = w[IN * HID + HID + HID * OUT + o];
        for (let j = 0; j < HID; j++) s += hid[j] * w[q0++];
        out[o] = Math.tanh(s);
      }

      if (c.huntCooldown > 0) c.huntCooldown--;
      // ---- act ----
      const turn = out[0];
      const thrust = (out[1] + 1) * 0.5;
      const effort = (out[2] + 1) * 0.5; // 0..1 brain-controlled exertion
      c.alert = clamp(0.35 * (c.alert != null ? c.alert : 0.4) + 0.65 * (0.6 * effort + 0.25 * (c.tissues ? c.tissues[2] : 0.25) + 0.15 * clamp(c.energy / (c.threshold || 1), 0, 1)), 0.08, 1);
      c.heading = wrap(c.heading + turn * (c.turnRate || p.maxTurn), TAU);

      // Move with ecological context: sensed resources raise drive, but effort
      // lets creatures choose to search or conserve; sprinting is costly.
      // Drag/inertia from morphology shape effective propulsion and turning.
      const driveBase = Math.max(fprox, bestCD < Infinity ? p.senseDrive : 0);
      const motivation = clamp(driveBase + effort * (0.55 - 0.30 * hab.hazard), 0, 1);
      const idleDamp = p.idleDamp != null ? p.idleDamp : 0.10;
      const tv = thrust * c.traits.speedMax * (idleDamp + (1 - idleDamp) * motivation) / (c.drag || 1);
      c.vx += (Math.cos(c.heading) * tv - c.vx) * p.steer;
      c.vy += (Math.sin(c.heading) * tv - c.vy) * p.steer;
      c.x = wrap(c.x + c.vx, this.w);
      c.y = wrap(c.y + c.vy, this.h);
      c.age++;

      const v2 = c.vx * c.vx + c.vy * c.vy;
      const spd = Math.sqrt(v2);
      const sprint = c.traits.speedMax > 1e-6 ? clamp(spd / c.traits.speedMax, 0, 1) : 0;
      const sprintCost = p.sprintCost != null ? p.sprintCost : 2.5;
      const senAge = p.senescenceAge || 3000;
      const sen = c.age > senAge ? (c.age - senAge) / senAge * (p.senescenceCost || 0) : 0;
      const hazardDrain = (p.hazardCost || 0) * (hab ? hab.hazard : 0) * c.mass075;
      const senseCost = (p.senseCost || 0) * alertEff * Math.pow(Math.max(0, sense) / 80, 2) * c.mass075;
      c.energy -= p.basal * (1 + sen) + p.basalMass * c.mass + p.moveCost * c.mass075 * v2 * (1 + sprintCost * sprint * sprint) + hazardDrain + senseCost;

      // ---- eat (one item per tick, nearest first) ----
      // Food is nutrient, not usable energy. A full gut means the creature
      // leaves the food alone until it has digested what it already has.
      const eatR = c.radius + p.foodRadius + 2;
      const near = this.foodGrid.query(c.x, c.y, eatR, this._candA);
      let meal = null, mealD = eatR * eatR;
      if (c.nutrient < c.gutCap) {
        for (let i = 0; i < near.length; i++) {
          const f = near[i];
          if (f.dead) continue;
          const dx = wrapDelta(f.x - c.x, this.w);
          const dy = wrapDelta(f.y - c.y, this.h);
          const d = dx * dx + dy * dy;
          if (d < mealD) { mealD = d; meal = f; }
        }
        if (meal) {
          meal.dead = true;
          c.nutrient = Math.min(c.gutCap, c.nutrient + meal.e);
          c.diet = (c.diet || 0) * 0.72 + ((meal.type | 0) ? 1 : 0) * 0.28;
          c.eaten++;
        }
      }

      // ---- metabolism ----
      // Michaelis-Menten digestion. The enzyme gene sets catalyst abundance;
      // nutrient becomes ATP and biomass. Growth is paid for in ATP, so body
      // size and reproduction compete for the same budget.
      if (c.nutrient > 0) {
        const diet = clamp(c.diet || 0, 0, 1);
        const faunaDig = (p.faunaDigestBase != null ? p.faunaDigestBase : 0.55) + (p.faunaDigestEnzyme != null ? p.faunaDigestEnzyme : 0.45) * clamp(c.traits.enzyme / 2, 0, 1);
        const dig = 1 * (1 - diet) + faunaDig * diet;
        const atpY = (p.atpYield != null ? p.atpYield : 1) * (1 - diet) + (p.faunaAtpYield != null ? p.faunaAtpYield : 1.12) * diet;
        const bioY = (p.biomassYield != null ? p.biomassYield : 0.03) * (1 - diet) + (p.faunaBiomassYield != null ? p.faunaBiomassYield : 0.042) * diet;
        const flux = p.digestRate * c.traits.enzyme * dig * c.nutrient / (c.nutrient + p.digestKm);
        const used = Math.min(flux, c.nutrient);
        c.nutrient -= used;
        c.energy += used * atpY;

        if (c.biomass < c.targetMass) {
          const biomassGain = used * bioY;
          const affordable = Math.max(0, c.energy) / p.growthCost;
          const grow = Math.min(biomassGain, c.targetMass - c.biomass, affordable);
          if (grow > 0) {
            this.setBiomass(c, c.biomass + grow);
            c.energy -= grow * p.growthCost;
            this.computeTraits(c);
          }
        }
      }

      // ---- starvation ----
      // ATP debt is paid by burning biomass; run out of body and you die.
      if (c.energy < 0) {
        const burn = Math.min(c.biomass, -c.energy / p.catabolism);
        c.biomass -= burn;
        c.energy += burn * p.catabolism;
        if (c.biomass <= p.minBiomass) {
          c.energy = -1;
        } else {
          this.setBiomass(c, c.biomass);
          this.computeTraits(c);
        }
      }

      // ---- reproduce ----
      if (
        c.energy >= c.threshold &&
        c.biomass >= c.matureBiomass &&
        c.matedTick !== this.tick &&
        this.creatures.length + this.born.length < p.maxPop
      ) {
        if (p.sexual) {
          const mate = this.findMate(c);
          if (mate) this.reproduceSexual(c, mate);
        } else {
          this.reproduceAsexual(c);
        }
      }

      if (c.energy > c.maxEnergy) c.energy = c.maxEnergy;
    }

    // ------------------------------------------------------------ serialize --
    serialize() {
      return {
        version: 7,
        seed: this.seed,
        habitatSeed: this.habitatSeed >>> 0,
        rng: this.rng.state >>> 0,
        // Rng.normal() keeps one sample in reserve; without it a resumed run
        // draws a different sequence than the saved one.
        rngSpare: this.rng._spare,
        tick: this.tick,
        nextId: this.nextId,
        nextSpeciesId: this.nextSpeciesId,
        // Fractional progress toward the next food spawn; without it a
        // resumed world spawns food one tick out of phase and diverges.
        spawnAcc: this.spawnAcc,
        births: this.births,
        deaths: this.deaths,
        immigrants: this.immigrants,
        sexualBirths: this.sexualBirths,
        asexualBirths: this.asexualBirths,
        params: this.p,
        patches: this.patches.map((q) => ({ x: q.x, y: q.y, vx: q.vx, vy: q.vy })),
        food: this.food.map((f) => ({ x: f.x, y: f.y, e: f.e, type: f.type | 0 })),
        species: this.species.map((sp) => ({
          id: sp.id,
          hue: sp.hue,
          centroid: Array.from(sp.centroid),
          count: sp.count,
          firstSeen: sp.firstSeen | 0,
          lastSeen: sp.lastSeen,
          peak: sp.peak,
        })),
        allSpecies: this.allSpecies.map((sp) => ({
          id: sp.id,
          hue: sp.hue,
          centroid: Array.from(sp.centroid || []),
          count: sp.count | 0,
          firstSeen: sp.firstSeen | 0,
          lastSeen: sp.lastSeen | 0,
          peak: sp.peak | 0,
        })),
        creatures: this.creatures.map((c) => ({
          id: c.id,
          gen: c.gen,
          genes: c.genes,
          w: Array.from(c.w),
          x: c.x, y: c.y, heading: c.heading,
          vx: c.vx, vy: c.vy,
          energy: c.energy,
          nutrient: c.nutrient,
          diet: +c.diet || 0,
          biomass: c.biomass,
          eaten: c.eaten,
          kills: c.kills,
          children: c.children,
          age: c.age,
          matedTick: c.matedTick | 0,
          huntCooldown: c.huntCooldown | 0,
          origin: c.origin | 0,
          species: c.species,
          speciesHue: c.speciesHue,
          // Current regulatory state. Without it a resumed creature would
          // re-express from zero and its traits would jump on load.
          reg: Array.from(c.reg),
        })),
      };
    }

    static fromJSON(obj) {
      if (!obj || (obj.version !== 1 && obj.version !== 2 && obj.version !== 3 && obj.version !== 4 && obj.version !== 5 && obj.version !== 6 && obj.version !== 7)) {
        throw new Error('Unsupported save file');
      }
      const params = Object.assign({}, obj.params || {});
      const w = new World(Object.assign({}, params, {
        seed: obj.seed,
        startPop: 0,
        seedFood: 0,
      }));

      w.p.startPop = params.startPop !== undefined ? params.startPop : DEFAULTS.startPop;
      w.p.seedFood = params.seedFood !== undefined ? params.seedFood : DEFAULTS.seedFood;

      w.tick = obj.tick | 0;
      w.nextId = obj.nextId | 0;
      w.nextSpeciesId = obj.nextSpeciesId | 0;
      w.spawnAcc = Number.isFinite(obj.spawnAcc) ? +obj.spawnAcc : 0;
      w.births = obj.births | 0;
      w.deaths = obj.deaths | 0;
      w.immigrants = obj.immigrants | 0;
      w.sexualBirths = obj.sexualBirths | 0;
      w.asexualBirths = obj.asexualBirths | 0;
      w.rng.state = (obj.rng >>> 0) || 1;
      w.rng._spare = (typeof obj.rngSpare === 'number' && Number.isFinite(obj.rngSpare))
        ? obj.rngSpare
        : null;

      if (obj.habitatSeed != null) w.habitatSeed = obj.habitatSeed >>> 0;
      w.patches = (obj.patches || []).map((q) => ({
        x: +q.x, y: +q.y, vx: +q.vx || 0, vy: +q.vy || 0,
      }));
      w.food = (obj.food || []).map((f) => ({
        x: +f.x, y: +f.y, e: +f.e, type: f.type | 0, dead: false,
      }));
      w.creatures = (obj.creatures || []).map((c) => {
        if (!c.genes || !Array.isArray(c.w)) {
          throw new Error('Invalid creature in save file');
        }
        let weights;
        if (c.w.length === NW) weights = Float32Array.from(c.w);
        else if (c.w.length === NW_8_2 || c.w.length === NW_12_2 || c.w.length === IN * HID + HID + HID * 2 + 2) weights = migrateWeights(c.w);
        else throw new Error('Invalid creature in save file');
        // v1/v2 saves have no regulatory genome or state; normalizing fills
        // zeros, which express the structural genes unchanged. v1-v3 saves
        // also predate developmental allocation, so those loci default to an
        // even body plan.
        normalizeGenes(c.genes);
        c.genes.rg = normalizeRg(c.genes.rg);
        const cr = w.makeCreature(c.genes, weights, c.gen | 0,
          +c.x, +c.y, +c.heading);
        cr.id = c.id | 0;
        cr.vx = +c.vx || 0;
        cr.vy = +c.vy || 0;
        cr.energy = +c.energy || 0;
        cr.eaten = c.eaten | 0;
        cr.kills = c.kills | 0;
        cr.children = c.children | 0;
        cr.age = c.age | 0;
        cr.matedTick = c.matedTick == null ? -1 : (c.matedTick | 0);
        cr.huntCooldown = c.huntCooldown | 0;
        cr.origin = c.origin | 0;
        cr.species = c.species | 0;
        cr.speciesHue = +c.speciesHue || 0;
        cr.diet = Number.isFinite(c.diet) ? clamp(+c.diet, 0, 1) : 0;
        // v1 saves predate the metabolism layer; treat their creatures as
        // adults with an empty gut.
        w.setBiomass(cr, Number.isFinite(c.biomass) ? c.biomass : cr.targetMass);
        cr.nutrient = Number.isFinite(c.nutrient) ? c.nutrient : 0;
        // Restore regulatory activity and re-derive realised traits from it.
        if (Array.isArray(c.reg)) {
          for (let i = 0; i < REG_N; i++) {
            if (Number.isFinite(c.reg[i])) cr.reg[i] = +c.reg[i];
          }
        }
        w.computeTraits(cr);
        return cr;
      });

      let maxId = 0;
      for (let i = 0; i < w.creatures.length; i++) maxId = Math.max(maxId, w.creatures[i].id);
      // makeCreature() bumped w.nextId once per restored creature, so take the
      // saved value (not the bumped one) and guarantee it clears every id.
      w.nextId = Math.max(obj.nextId | 0, maxId + 1);

      // Restore the exact species table rather than re-clustering. Rebuilding
      // here would invent fresh ids and centroids, so a loaded world would not
      // be the same world. Older save files have no species field; fall back.
      const savedSpecies = Array.isArray(obj.species) ? obj.species : null;
      if (savedSpecies) {
        w.species = savedSpecies.map((sp) => {
          const centroid = Array.from(sp.centroid || [], Number);
          const count = sp.count | 0;
          const sum = new Float64Array(centroid.length);
          for (let k = 0; k < centroid.length; k++) sum[k] = centroid[k] * count;
          return {
            id: sp.id | 0,
            hue: +sp.hue || 0,
            centroid,
            sum,
            count,
            firstSeen: sp.firstSeen | 0,
            lastSeen: sp.lastSeen | 0,
            peak: sp.peak | 0,
          };
        });
        let maxSpecies = 0;
        for (let i = 0; i < w.species.length; i++) {
          maxSpecies = Math.max(maxSpecies, w.species[i].id);
        }
        w.nextSpeciesId = Math.max(w.nextSpeciesId, maxSpecies + 1);
        if (Array.isArray(obj.allSpecies) && obj.allSpecies.length) {
          w.allSpecies = obj.allSpecies.map((sp) => ({
            id: sp.id | 0,
            hue: +sp.hue || 0,
            centroid: Array.from(sp.centroid || [], Number),
            count: sp.count | 0,
            firstSeen: sp.firstSeen | 0,
            lastSeen: sp.lastSeen | 0,
            peak: sp.peak | 0,
          }));
        } else {
          // v1-4 saves: seed the permanent catalog from the active table.
          w.allSpecies = w.species.map((sp) => ({
            id: sp.id, hue: sp.hue, centroid: sp.centroid.slice(),
            count: sp.count, firstSeen: sp.firstSeen || 0,
            lastSeen: sp.lastSeen, peak: sp.peak,
          }));
        }
      } else {
        w.rebuildSpecies();
      }
      return w;
    }

    // ----------------------------------------------------------------- stats --
    stats() {
      const n = this.creatures.length;
      let size = 0, speed = 0, sense = 0, mut = 0, repro = 0, gen = 0, energy = 0, kills = 0;
      let enzyme = 0, biomass = 0, maturity = 0, nutrient = 0, regActivity = 0, diet = 0, defense = 0, immDesc = 0, alert = 0;
      let hueSin = 0, hueCos = 0;
      let cells = 0, gut = 0, muscle = 0, nerve = 0, gonad = 0;
      for (let i = 0; i < n; i++) {
        const c = this.creatures[i];
        const t = c.traits;
        size += t.size;
        speed += t.speedMax;
        sense += t.sense;
        mut += t.mutRate;
        repro += t.reproE;
        enzyme += t.enzyme;
        diet += c.diet || 0;
        defense += c.defense || 0;
        alert += c.alert != null ? c.alert : 0;
        if (c.origin) immDesc++;
        const ha = (c.genes.hue || 0) * TAU;
        hueSin += Math.sin(ha); hueCos += Math.cos(ha);
        for (let j = 0; j < REG_N; j++) regActivity += Math.abs(c.reg[j]);
        cells += c.cells;
        gut += c.tissues[0];
        muscle += c.tissues[1];
        nerve += c.tissues[2];
        gonad += c.tissues[3];
        kills += c.kills;
        gen += c.gen;
        energy += c.energy / c.threshold;
        biomass += c.biomass / c.targetMass;
        maturity += c.biomass >= c.matureBiomass ? 1 : 0;
        nutrient += c.nutrient;
      }
      const d = n || 1;
      let dominant = 0;
      for (let i = 0; i < this.species.length; i++) {
        if (this.species[i].count > dominant) dominant = this.species[i].count;
      }
      let faunaFood = 0;
      for (let i = 0; i < this.food.length; i++) if (this.food[i].type) faunaFood++;
      const hR = Math.sqrt((hueSin / d) * (hueSin / d) + (hueCos / d) * (hueCos / d));
      let hueMean = Math.atan2(hueSin / d, hueCos / d) / TAU;
      if (hueMean < 0) hueMean += 1;
      return {
        tick: this.tick,
        pop: n,
        food: this.food.length,
        faunaFood,
        season: 0.5 + 0.5 * Math.sin(this.tick * 0.0017),
        diet: diet / d,
        defense: defense / d,
        alert: alert / d,
        hue: hueMean,
        hueSpread: 1 - hR, // 0 concentrated, 1 uniform/drifted
        births: this.births,
        deaths: this.deaths,
        immigrants: this.immigrants,
        immDesc: immDesc / d,
        native: 1 - immDesc / d,
        avgGen: gen / d,
        maxGen: n ? this.creatures.reduce((m, c) => (c.gen > m ? c.gen : m), 0) : 0,
        size: size / d,
        speed: speed / d,
        sense: sense / d,
        mutRate: mut / d,
        reproE: repro / d,
        enzyme: enzyme / d,
        biomass: biomass / d,
        maturity: maturity / d,
        nutrient: nutrient / d,
        regActivity: regActivity / (d * REG_N),
        cells: cells / d,
        tissues: [gut / d, muscle / d, nerve / d, gonad / d],
        kills,
        fill: energy / d,
        species: this.species.length,
        dominant,
        sexualBirths: this.sexualBirths,
        asexualBirths: this.asexualBirths,
        mode: this.p.sexual ? 'sexual' : 'asexual',
      };
    }
  }

  root.ALife = {
    World, Grid, Rng, DEFAULTS, GENE_DEFS,
    IN, HID, OUT, NW,
    SPECIES_KEYS, genesToVec, vecDistance, genomeDistance,
    randn, clamp, wrap, wrapDelta, TAU,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ALife;
})(typeof globalThis !== 'undefined' ? globalThis : this);
