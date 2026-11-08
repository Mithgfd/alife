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

  // Box-Muller, with one cached spare so we don't waste the second normal.
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
  ];

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
    preyMassGain: 22,

    // Metabolism. The fixed `basal` term and the `thresholdBase` in the
    // reproduction threshold are what stop "be as small as possible" from
    // being strictly optimal.
    basal: 0.05,
    basalMass: 0.04,
    moveCost: 0.12,
    thresholdBase: 30,

    maxTurn: 0.28,   // radians per tick at full turn output
    steer: 0.25,     // velocity smoothing toward heading
    reproCost: 0.52, // fraction of threshold the parent spends
    reproShare: 0.42,// fraction of threshold the child receives
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

      this.foodGrid = new Grid(this.w, this.h, 64);
      this.creatureGrid = new Grid(this.w, this.h, 64);

      // scratch, reused every tick
      this._candA = [];
      this._candB = [];
      this._in = new Float32Array(IN);
      this._hid = new Float32Array(HID);
      this._out = new Float32Array(OUT);

      this.patches = [];
      for (let i = 0; i < p.patchCount; i++) {
        this.patches.push({
          x: Math.random() * this.w,
          y: Math.random() * this.h,
          vx: randn() * 0.05,
          vy: randn() * 0.05,
        });
      }

      for (let i = 0; i < p.startPop; i++) this.creatures.push(this.randomCreature());
      for (let i = 0; i < p.foodCap * p.seedFood; i++) this.spawnFood();
    }

    // -------------------------------------------------------------- factory --
    randomGenome() {
      const genes = {};
      for (let i = 0; i < GENE_DEFS.length; i++) {
        const g = GENE_DEFS[i];
        genes[g.key] = g.min + Math.random() * (g.max - g.min);
      }
      const w = new Float32Array(NW);
      for (let i = 0; i < NW; i++) w[i] = randn() * 0.35;

      // Innate foraging reflex, so generation 0 is not a coin flip that dies
      // before it can reproduce. Hidden unit 0 steers toward food (food-right
      // -> turn); hidden unit 1 drives thrust from food-ahead + proximity.
      // These weights are ordinary genes: mutation can weaken, invert or
      // rewire them like anything else.
      const jitter = () => 0.6 + Math.random() * 0.8;
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
      return this.makeCreature(
        g.genes, g.w, 0,
        Math.random() * this.w, Math.random() * this.h,
        Math.random() * TAU
      );
    }

    makeCreature(genes, weights, gen, x, y, heading) {
      const c = {
        id: this.nextId++,
        genes,
        w: weights,
        gen,
        x, y, heading,
        vx: 0,
        vy: 0,
        mass: genes.size * genes.size,
        radius: 2 + genes.size * 2.2,
        eaten: 0,
        kills: 0,
        children: 0,
        age: 0,
      };
      c.mass075 = Math.pow(c.mass, 0.75);
      c.threshold = this.p.thresholdBase + genes.reproE * c.mass;
      c.maxEnergy = c.threshold * 1.7;
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
        let v = g[d.key] + randn() * d.sigma * (d.key === 'mutRate' ? 1 : scale);
        v = d.wrap ? wrap(v, 1) : clamp(v, d.min, d.max);
        genes[d.key] = v;
      }

      const w = new Float32Array(NW);
      for (let i = 0; i < NW; i++) {
        w[i] = clamp(parent.w[i] + randn() * 0.3 * scale, -6, 6);
      }

      const angle = Math.random() * TAU;
      const child = this.makeCreature(
        genes, w, parent.gen + 1,
        wrap(parent.x + Math.cos(angle) * parent.radius * 1.5, this.w),
        wrap(parent.y + Math.sin(angle) * parent.radius * 1.5, this.h),
        angle
      );
      child.energy = parent.threshold * p.reproShare;
      return child;
    }

    // ----------------------------------------------------------------- food --
    spawnFood() {
      const p = this.p;
      let x, y;
      if (this.patches.length && Math.random() < p.patchBias) {
        const q = this.patches[(Math.random() * this.patches.length) | 0];
        x = wrap(q.x + randn() * p.patchSpread, this.w);
        y = wrap(q.y + randn() * p.patchSpread, this.h);
      } else {
        x = Math.random() * this.w;
        y = Math.random() * this.h;
      }
      this.food.push({ x, y, e: p.foodEnergy, dead: false });
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

      // compact out the dead
      let k = 0;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.energy > 0) list[k++] = c;
        else this.deaths++;
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
        if (Math.random() < chance) {
          list.push(this.randomCreature());
          this.immigrants++;
        }
      }
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
        if (p.predation && c.mass > o.mass * p.preySizeRatio) {
          const touch = c.radius + o.radius;
          if (d < touch * touch) {
            const gain = Math.max(0, o.energy) * p.preyEnergyGain + o.mass * p.preyMassGain;
            c.energy = Math.min(c.maxEnergy, c.energy + gain);
            c.kills++;
            o.energy = -1;
            o.dead = true;
            continue;
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
      const eatR = c.radius + p.foodRadius + 2;
      const near = this.foodGrid.query(c.x, c.y, eatR, this._candA);
      let meal = null, mealD = eatR * eatR;
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
        c.energy = Math.min(c.maxEnergy, c.energy + meal.e);
        c.eaten++;
      }

      // ---- reproduce ----
      if (
        c.energy >= c.threshold &&
        this.creatures.length + this.born.length < p.maxPop
      ) {
        c.energy -= c.threshold * p.reproCost;
        const child = this.childOf(c);
        c.children++;
        this.born.push(child);
      }

      if (c.energy > c.maxEnergy) c.energy = c.maxEnergy;
    }

    // ----------------------------------------------------------------- stats --
    stats() {
      const n = this.creatures.length;
      let size = 0, speed = 0, sense = 0, mut = 0, repro = 0, gen = 0, energy = 0, kills = 0;
      for (let i = 0; i < n; i++) {
        const c = this.creatures[i];
        size += c.genes.size;
        speed += c.genes.speedMax;
        sense += c.genes.sense;
        mut += c.genes.mutRate;
        repro += c.genes.reproE;
        kills += c.kills;
        gen += c.gen;
        energy += c.energy / c.threshold;
      }
      const d = n || 1;
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
        kills,
        fill: energy / d,
      };
    }
  }

  root.ALife = {
    World, Grid, DEFAULTS, GENE_DEFS,
    IN, HID, OUT, NW,
    randn, clamp, wrap, wrapDelta, TAU,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ALife;
})(typeof globalThis !== 'undefined' ? globalThis : this);
