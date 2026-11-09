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
  // 8 inputs -> 6 tanh hidden -> 2 outputs. 68 weights.
  const IN = 8, HID = 6, OUT = 2;
  const NW = IN * HID + HID + HID * OUT + OUT;

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
  ];
  const GENE_BY_KEY = {};
  for (let i = 0; i < GENE_DEFS.length; i++) GENE_BY_KEY[GENE_DEFS[i].key] = GENE_DEFS[i];

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

  // ---------------------------------------------------------------- params --
  const DEFAULTS = {
    width: 900,
    height: 700,

    // Food is the only resource. Growth is logistic toward foodCap, so a
    // stripped world regrows fast and a full world stops producing.
    foodCap: 450,
    foodGrowth: 1.8,
    foodEnergy: 28,
    foodRadius: 2.2,
    seedFood: 0.7,

    // Food is patchy: most spawns cluster around a few slowly drifting
    // "meadows". Uniform scatter is boring; patchiness creates territories.
    patchCount: 5,
    patchSpread: 120,
    patchBias: 0.7,

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
    moveCost: 0.12,
    thresholdBase: 30,

    // Digestion: food is nutrient, not usable energy. The enzyme gene sets the
    // catalyst level; nutrient is converted to ATP (usable energy) and biomass
    // (body material) at a Michaelis-Menten rate. Growing biomass costs ATP, so
    // growth and reproduction compete for the same budget.
    digestRate: 5.0,      // max nutrient processed per tick at enzyme = 1
    digestKm: 12,         // nutrient level at half-maximal digestion
    atpYield: 1.0,        // ATP per nutrient
    biomassYield: 0.030,  // biomass per nutrient
    growthCost: 5.0,      // ATP spent per biomass synthesized
    catabolism: 3.0,      // ATP released per biomass burned while starving
    gutBase: 18,          // gut capacity = gutBase + gutSize * size
    gutSize: 14,
    birthMassFrac: 0.16,  // offspring biomass as a fraction of adult mass
    matureFrac: 0.72,     // fraction of adult mass needed to reproduce
    minBiomass: 0.02,     // below this a starving creature dies

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

      this.nextSpeciesId = 1;
      this.species = [];

      this.foodGrid = new Grid(this.w, this.h, 64);
      this.creatureGrid = new Grid(this.w, this.h, 64);

      // scratch, reused every tick
      this._candA = [];
      this._candB = [];
      this._candM = [];
      this._in = new Float32Array(IN);
      this._hid = new Float32Array(HID);
      this._out = new Float32Array(OUT);

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
      const w = new Float32Array(NW);
      for (let i = 0; i < NW; i++) w[i] = this.rng.normal() * 0.35;

      // Innate foraging reflex, so generation 0 is not a coin flip that dies
      // before it can reproduce. Hidden unit 0 steers toward food (food-right
      // -> turn); hidden unit 1 drives thrust from food-ahead + proximity.
      // These weights are ordinary genes: mutation can weaken, invert or
      // rewire them like anything else.
      const jitter = () => 0.6 + this.rng.next() * 0.8;
      w[0 * IN + 1] = 1.5 * jitter();          // food right -> hid 0
      w[48 + 0] = 0;
      w[54 + 0] = 1.8 * jitter();              // hid 0 -> turn
      w[1 * IN + 0] = 1.5 * jitter();          // food ahead -> hid 1
      w[1 * IN + 2] = 1.0 * jitter();          // food proximity -> hid 1
      w[48 + 1] = 0;
      w[54 + HID + 1] = 1.5 * jitter();        // hid 1 -> thrust
      w[IN * HID + HID + HID * OUT + 1] = 0.6; // thrust bias
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

    makeCreature(genes, weights, gen, x, y, heading) {
      const p = this.p;
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
        nutrient: 0,
        biomass: targetMass,
        gutCap: p.gutBase + p.gutSize * genes.size,
      };
      c.mass075 = Math.pow(c.mass, 0.75);
      c.threshold = p.thresholdBase + genes.reproE * targetMass;
      c.maxEnergy = c.threshold * 1.7;
      c.matureBiomass = targetMass * p.matureFrac;
      this.setBiomass(c, targetMass * p.birthMassFrac);
      c.energy = c.threshold * 0.55;
      return c;
    }

    // Mutation. Gene steps scale with the parent's mutRate, so lineages can
    // evolve to be conservative or exploratory. Weights get the same scaling.
    childOf(parent) {
      const p = this.p;
      const g = parent.genes;
      const scale = clamp(g.mutRate, 0.02, 0.6) / 0.15;

      const genes = {};
      for (let i = 0; i < GENE_DEFS.length; i++) {
        const d = GENE_DEFS[i];
        let v = g[d.key] + this.rng.normal() * d.sigma * (d.key === 'mutRate' ? 1 : scale);
        v = d.wrap ? wrap(v, 1) : clamp(v, d.min, d.max);
        genes[d.key] = v;
      }

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
      return child;
    }

    // Crossover: each gene and each weight is inherited from one parent, with
    // occasional averaging of weights, then mutated at the parents' mean rate.
    childOfSexual(a, b) {
      const p = this.p;
      const meanMut = clamp((a.genes.mutRate + b.genes.mutRate) * 0.5, 0.02, 0.6);
      const scale = meanMut / 0.15;

      const genes = {};
      for (let i = 0; i < GENE_DEFS.length; i++) {
        const d = GENE_DEFS[i];
        let v = this.rng.next() < 0.5 ? a.genes[d.key] : b.genes[d.key];
        v += this.rng.normal() * d.sigma * (d.key === 'mutRate' ? 1 : scale);
        v = d.wrap ? wrap(v, 1) : clamp(v, d.min, d.max);
        genes[d.key] = v;
      }

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
      this.food.push({ x, y, e: p.foodEnergy, dead: false });
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
      this.spawnAcc += p.foodGrowth * (1 - this.food.length / p.foodCap);
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
          list.push(this.randomCreature());
          this.immigrants++;
        }
      }

      if (this.tick % p.speciesInterval === 0) this.rebuildSpecies();
    }

    updateCreature(c) {
      const p = this.p;
      const sense = c.genes.sense;
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
      let ox = 0, oy = 0;
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

        // Predation: any creature can eat one much smaller than itself. Size
        // is the trait, so there's no gene "valley" to cross: being big is
        // immediately worth something, and being small is immediately risky.
        // One prey per tick models handling time and stops a single predator
        // from clearing a whole shoal in one step.
        if (p.predation && c.mass > o.mass * p.preySizeRatio) {
          const touch = c.radius + o.radius;
          if (d < touch * touch) {
            const gain = Math.max(0, o.energy) * p.preyEnergyGain + o.mass * p.preyMassGain;
            c.energy = Math.min(c.maxEnergy, c.energy + gain);
            c.kills++;
            o.energy = -1;
            o.dead = true;
            break;
          }
        }

        const minD = c.radius + o.radius;
        if (d < minD * minD && d > 1e-6) {
          const dist = Math.sqrt(d);
          const push = (minD - dist) * 0.35;
          px -= (dx / dist) * push;
          py -= (dy / dist) * push;
        }
        if (d < bestCD && d <= sense2) { bestCD = d; ox = dx; oy = dy; }
      }
      if (px !== 0 || py !== 0) {
        c.x = wrap(c.x + clamp(px, -2, 2), this.w);
        c.y = wrap(c.y + clamp(py, -2, 2), this.h);
      }
      if (bestCD < Infinity) {
        ox /= sense;
        oy /= sense;
      }

      // ---- brain ----
      // Inputs are egocentric: forward/right relative to heading, not world
      // x/y. That makes "turn toward food" a single positive weight, which
      // evolution can actually find. World-frame inputs make it a moving
      // target the network has no heading to solve.
      const ch = Math.cos(c.heading), sh = Math.sin(c.heading);
      const inp = this._in;
      inp[0] = (fx * ch + fy * sh);          // food, forward
      inp[1] = (-fx * sh + fy * ch);         // food, right
      inp[2] = fprox;                        // food proximity 0..1
      inp[3] = (ox * ch + oy * sh);          // creature, forward
      inp[4] = (-ox * sh + oy * ch);         // creature, right
      inp[5] = clamp(c.energy / c.threshold, 0, 1.6) * 0.75;
      inp[6] = clamp(Math.sqrt(c.vx * c.vx + c.vy * c.vy) / c.genes.speedMax, 0, 1);
      inp[7] = 1;

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

      // ---- act ----
      const turn = out[0];
      const thrust = (out[1] + 1) * 0.5;
      c.heading = wrap(c.heading + turn * p.maxTurn, TAU);

      const tv = thrust * c.genes.speedMax;
      c.vx += (Math.cos(c.heading) * tv - c.vx) * p.steer;
      c.vy += (Math.sin(c.heading) * tv - c.vy) * p.steer;
      c.x = wrap(c.x + c.vx, this.w);
      c.y = wrap(c.y + c.vy, this.h);
      c.age++;

      const v2 = c.vx * c.vx + c.vy * c.vy;
      c.energy -= p.basal + p.basalMass * c.mass + p.moveCost * c.mass075 * v2;

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
          c.eaten++;
        }
      }

      // ---- metabolism ----
      // Michaelis-Menten digestion. The enzyme gene sets catalyst abundance;
      // nutrient becomes ATP and biomass. Growth is paid for in ATP, so body
      // size and reproduction compete for the same budget.
      if (c.nutrient > 0) {
        const flux = p.digestRate * c.genes.enzyme * c.nutrient / (c.nutrient + p.digestKm);
        const used = Math.min(flux, c.nutrient);
        c.nutrient -= used;
        c.energy += used * p.atpYield;

        if (c.biomass < c.targetMass) {
          const biomassGain = used * p.biomassYield;
          const affordable = Math.max(0, c.energy) / p.growthCost;
          const grow = Math.min(biomassGain, c.targetMass - c.biomass, affordable);
          if (grow > 0) {
            this.setBiomass(c, c.biomass + grow);
            c.energy -= grow * p.growthCost;
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
        version: 2,
        seed: this.seed,
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
        food: this.food.map((f) => ({ x: f.x, y: f.y, e: f.e })),
        species: this.species.map((sp) => ({
          id: sp.id,
          hue: sp.hue,
          centroid: Array.from(sp.centroid),
          count: sp.count,
          lastSeen: sp.lastSeen,
          peak: sp.peak,
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
          biomass: c.biomass,
          eaten: c.eaten,
          kills: c.kills,
          children: c.children,
          age: c.age,
          species: c.species,
          speciesHue: c.speciesHue,
        })),
      };
    }

    static fromJSON(obj) {
      if (!obj || (obj.version !== 1 && obj.version !== 2)) {
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

      w.patches = (obj.patches || []).map((q) => ({
        x: +q.x, y: +q.y, vx: +q.vx || 0, vy: +q.vy || 0,
      }));
      w.food = (obj.food || []).map((f) => ({
        x: +f.x, y: +f.y, e: +f.e, dead: false,
      }));
      w.creatures = (obj.creatures || []).map((c) => {
        if (!c.genes || !Array.isArray(c.w) || c.w.length !== NW) {
          throw new Error('Invalid creature in save file');
        }
        const cr = w.makeCreature(c.genes, Float32Array.from(c.w), c.gen | 0,
          +c.x, +c.y, +c.heading);
        cr.id = c.id | 0;
        cr.vx = +c.vx || 0;
        cr.vy = +c.vy || 0;
        cr.energy = +c.energy || 0;
        cr.eaten = c.eaten | 0;
        cr.kills = c.kills | 0;
        cr.children = c.children | 0;
        cr.age = c.age | 0;
        cr.species = c.species | 0;
        cr.speciesHue = +c.speciesHue || 0;
        // v1 saves predate the metabolism layer; treat their creatures as
        // adults with an empty gut.
        w.setBiomass(cr, Number.isFinite(c.biomass) ? c.biomass : cr.targetMass);
        cr.nutrient = Number.isFinite(c.nutrient) ? c.nutrient : 0;
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
            lastSeen: sp.lastSeen | 0,
            peak: sp.peak | 0,
          };
        });
        let maxSpecies = 0;
        for (let i = 0; i < w.species.length; i++) {
          maxSpecies = Math.max(maxSpecies, w.species[i].id);
        }
        w.nextSpeciesId = Math.max(w.nextSpeciesId, maxSpecies + 1);
      } else {
        w.rebuildSpecies();
      }
      return w;
    }

    // ----------------------------------------------------------------- stats --
    stats() {
      const n = this.creatures.length;
      let size = 0, speed = 0, sense = 0, mut = 0, repro = 0, gen = 0, energy = 0, kills = 0;
      let enzyme = 0, biomass = 0, maturity = 0, nutrient = 0;
      for (let i = 0; i < n; i++) {
        const c = this.creatures[i];
        size += c.genes.size;
        speed += c.genes.speedMax;
        sense += c.genes.sense;
        mut += c.genes.mutRate;
        repro += c.genes.reproE;
        enzyme += c.genes.enzyme;
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
      return {
        tick: this.tick,
        pop: n,
        food: this.food.length,
        births: this.births,
        deaths: this.deaths,
        immigrants: this.immigrants,
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
