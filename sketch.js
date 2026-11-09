/* sketch.js — p5 viewer.
 *
 * All simulation state lives in ALife.World. This file only reads it and
 * draws. The only things it feeds back are UI toggles and the speed control.
 */

const W = 920;
const H = 700;
const PH = H + 140;              // room for optional details without overlap
const PAD = 14;
const PANEL = 290;
const TAU = Math.PI * 2;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

let world;
let stepsPerFrame = 4;
let paused = false;
let selected = null;
let colorBy = 'genes';          // 'genes' | 'species'
let popHist = [];
let foodHist = [];
let speciesHist = [];
let sampleClock = 0;
let catalogClock = 0;
let showSpeciesCatalog = false;
let speciesSort = 'id';
let showPanelDetails = false;
let showHelp = false;
let worldOnly = false;
let viewScale = 1, viewOx = 0, viewOy = 0;
let camX = W / 2, camY = H / 2, camZ = 1;
let focusSpeciesId = 0;
let flashMsg = '';
let flashUntil = 0;

function setup() {
  const cnv = createCanvas(W + PANEL + PAD * 3, PH + PAD * 2);
  cnv.parent('stage');
  pixelDensity(1);
  colorMode(HSB, 360, 100, 100, 100);
  textFont('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace');

  const q = new URLSearchParams(location.search);
  const opts = {};
  if (q.has('seed')) {
    const n = Number(q.get('seed'));
    if (Number.isFinite(n)) opts.seed = n >>> 0;
  }
  if (q.get('predation') === '0') opts.predation = false;
  if (q.get('sexual') === '0') opts.sexual = false;
  if (q.get('sexual') === '1') opts.sexual = true;
  if (q.get('paused') === '1') paused = true;
  if (q.get('color') === 'species') colorBy = 'species';
  const sp = Number(q.get('speed'));
  if (Number.isFinite(sp)) stepsPerFrame = Math.max(1, Math.min(128, Math.round(sp)));

  world = new ALife.World(opts);
  setupUI();
  syncUI();
}

function resetWorld(seed) {
  const opts = {};
  opts.seed = seed !== undefined ? (seed >>> 0) : ((Math.random() * 4294967296) >>> 0);
  if (world) {
    opts.predation = world.p.predation;
    opts.sexual = world.p.sexual;
  }
  world = new ALife.World(opts);
  selected = null;
  popHist = [];
  foodHist = [];
  speciesHist = [];
  sampleClock = 0;
  catalogClock = 0;
  clearCamera();
  syncUI();
  renderSpeciesCatalog();
  try {
    const url = new URL(location.href);
    url.searchParams.set('seed', opts.seed);
    history.replaceState(null, '', url);
  } catch (_) { /* file:// may forbid this; harmless */ }
}

function draw() {
  if (!paused) {
    for (let i = 0; i < stepsPerFrame; i++) world.step();

    sampleClock++;
    if (sampleClock >= 4) {
      sampleClock = 0;
      sampleWorld();
    }
  }
  if (showSpeciesCatalog) {
    catalogClock++;
    if (catalogClock >= 30) {
      catalogClock = 0;
      renderSpeciesCatalog();
    }
  }

  if (selected && (selected.dead || selected.energy <= 0)) selected = null;

  background(worldOnly ? color(226, 28, 8) : color(226, 24, 7));
  const vt = getWorldTransform();
  push();
  if (!worldOnly) {
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(PAD, PAD, W, H);
    drawingContext.clip();
  }
  translate(vt.ox, vt.oy);
  scale(vt.scale);
  drawWorld();
  if (!worldOnly) drawingContext.restore();
  pop();
  if (!worldOnly) drawPanel();
  else if (selected) drawWorldOnlyInspector(selected);
}

function sampleWorld() {
  popHist.push(world.creatures.length);
  foodHist.push(world.food.length);

  const counts = new Map();
  const hues = new Map();
  for (let i = 0; i < world.species.length; i++) hues.set(world.species[i].id, world.species[i].hue);
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i];
    counts.set(c.species, (counts.get(c.species) || 0) + 1);
  }
  const sample = [];
  counts.forEach((count, id) => {
    const hue = hues.has(id) ? hues.get(id) : ((id * 137.508) % 360) / 360;
    sample.push({ id, count, hue });
  });
  speciesHist.push(sample);

  if (popHist.length > 360) {
    popHist.shift();
    foodHist.shift();
    speciesHist.shift();
  }
}

// ------------------------------------------------------------------ world --
function hash01(a, b, c) {
  let x = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= Math.imul((b | 0) ^ 0xc2b2ae35, 0x27d4eb2d);
  x ^= Math.imul((c | 0) ^ 0x165667b1, 0x85ebca6b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  return ((x >>> 0) % 10000) / 10000;
}

function drawFoodItem(f) {
  const h1 = hash01((f.x * 10) | 0, (f.y * 10) | 0, 1);
  const h2 = hash01((f.x * 10) | 0, (f.y * 10) | 0, 2);
  const h3 = hash01((f.x * 10) | 0, (f.y * 10) | 0, 3);
  push();
  translate(f.x, f.y);
  rotate(h1 * TAU);
  const kind = (h2 * 4) | 0;
  const r = 1.7 + h3 * 1.4;
  noStroke();
  if (kind === 0) {
    fill(105 + h1 * 30, 45, 52, 45);
    ellipse(0, 0, r * 2.2, r * 1.4);
  } else if (kind === 1) {
    fill(88 + h1 * 25, 55, 56, 42);
    circle(0, 0, r * 2);
    fill(115, 35, 70, 35);
    circle(r * 0.25, -r * 0.2, r * 0.7);
  } else if (kind === 2) {
    fill(70 + h1 * 35, 50, 58, 42);
    beginShape();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const rr = r * (i % 2 ? 0.55 : 1.05);
      vertex(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    endShape(CLOSE);
  } else {
    fill(125 + h1 * 20, 35, 48, 40);
    rect(-r * 0.9, -r * 0.35, r * 1.8, r * 0.7, r * 0.35);
    stroke(95, 30, 45, 35);
    strokeWeight(0.8);
    line(-r * 0.2, 0, r * 0.5, 0);
    noStroke();
  }
  pop();
}

function drawCreatureModel(c) {
  const hue = (colorBy === 'species' ? c.speciesHue : c.genes.hue) * 360;
  const e = clamp01(c.energy / c.threshold);
  const t = c.tissues || [0.25, 0.25, 0.25, 0.25];
  const muscle = t[1], nerve = t[2], gut = t[0], gonad = t[3];
  const spd = c.traits && c.traits.speedMax ? c.traits.speedMax : (c.genes.speedMax || 1);
  const sns = c.traits && c.traits.sense ? c.traits.sense : (c.genes.sense || 40);
  const idh = hash01(c.id, (c.genes.hue * 1000) | 0, c.gen | 0);
  const r = c.radius;
  const len = r * (1.05 + muscle * 0.55 + spd * 0.08);
  const wid = r * (0.78 + gut * 0.45 - muscle * 0.12);
  const sat = 52 + gonad * 18;
  const bri = 48 + 44 * e;

  push();
  translate(c.x, c.y);
  rotate(c.heading);

  // tail / propulsion (muscle, speed)
  const tailN = 1 + (muscle > 0.32 ? 1 : 0) + (spd > 1.6 ? 1 : 0);
  for (let i = 0; i < tailN; i++) {
    const ang = (i - (tailN - 1) / 2) * (0.28 + muscle * 0.15);
    const tl = len * (0.55 + muscle * 0.35 + (idh * 0.15));
    stroke(hue, sat - 8, bri - 10, 70);
    strokeWeight(1 + muscle * 1.2);
    line(-len * 0.55, 0, -len * 0.55 - Math.cos(ang) * tl, Math.sin(ang) * tl);
  }
  noStroke();

  // body
  fill(hue, sat, bri, 95);
  ellipse(0, 0, len * 2, wid * 2);
  // dorsal shading
  fill(hue, sat - 10, bri - 14, 35);
  ellipse(-len * 0.05, -wid * 0.18, len * 1.35, wid * 0.85);
  // gut/belly highlight
  fill(45 + gut * 25, 30 + gut * 20, bri + 6, 28);
  ellipse(len * 0.05, wid * 0.12, len * (0.7 + gut * 0.4), wid * (0.45 + gut * 0.2));

  // segments (development/cells)
  if (c.cells >= 4) {
    stroke(hue, sat - 15, bri - 18, 22);
    strokeWeight(1);
    const segs = Math.min(6, 1 + ((c.cells / 12) | 0));
    for (let i = 1; i < segs; i++) {
      const sx = -len * 0.7 + (i / segs) * len * 1.4;
      const sy = wid * Math.sqrt(Math.max(0, 1 - (sx * sx) / (len * len)));
      line(sx, -sy * 0.7, sx, sy * 0.7);
    }
    noStroke();
  }

  // antennae / sensors (nerve, sense)
  const antN = sns > 70 ? 2 : sns > 35 ? 1 : 0;
  if (antN > 0) {
    stroke(hue, 35, 92, 75);
    strokeWeight(1);
    for (let i = 0; i < antN; i++) {
      const side = antN === 1 ? -1 : (i === 0 ? -1 : 1);
      const al = r * (0.45 + nerve * 0.7);
      const ax = len * 0.55;
      const ay = side * wid * 0.35;
      line(ax, ay, ax + al * 0.8, ay + side * al);
      noStroke();
      fill(55, 50, 95, 80);
      circle(ax + al * 0.8, ay + side * al, 1.8 + nerve * 1.2);
      stroke(hue, 35, 92, 75);
      strokeWeight(1);
    }
    noStroke();
  }

  // eye
  const ex = len * 0.45, ey = -wid * 0.22;
  fill(0, 0, 100, 90);
  circle(ex, ey, 2.2 + nerve * 1.8);
  fill(220, 60, 20, 90);
  circle(ex + 0.4, ey, 1 + nerve * 0.8);

  // gonad markings
  if (gonad > 0.28) {
    fill(hue + 40, 40, 95, 18 + gonad * 30);
    const dots = gonad > 0.38 ? 3 : 2;
    for (let i = 0; i < dots; i++) {
      circle(-len * 0.1 + i * len * 0.22, wid * 0.38, 1.5 + gonad * 1.5);
    }
  }

  pop();

  // subtle tissue composition ring (kept informative but lighter)
  if (c.cells >= 4) {
    const tissueHue = [120, 0, 210, 300];
    noFill();
    strokeWeight(1);
    const rr = c.radius + 1.2;
    let a = c.heading;
    for (let k = 0; k < 4; k++) {
      const span = t[k] * TAU;
      if (span > 0.08) {
        stroke(tissueHue[k], 45, 75, 35);
        arc(c.x, c.y, rr * 2, rr * 2, a + 0.04, a + span - 0.04);
      }
      a += span;
    }
    noStroke();
  }
}

function drawWorld() {
  noStroke();
  fill(226, 30, 10);
  rect(0, 0, W, H, 10);

  noFill();
  stroke(226, 16, 20);
  strokeWeight(1);
  rect(0.5, 0.5, W - 1, H - 1, 10);
  noStroke();

  // food — varied procedural models
  for (let i = 0; i < world.food.length; i++) drawFoodItem(world.food[i]);

  // creatures — procedural models driven by genes and tissues
  for (let i = 0; i < world.creatures.length; i++) drawCreatureModel(world.creatures[i]);

  if (selected) {
    noFill();
    stroke(0, 0, 100, 85);
    strokeWeight(1.5);
    circle(selected.x, selected.y, selected.radius * 2 + 10);
    stroke(0, 0, 100, 18);
    strokeWeight(1);
    circle(selected.x, selected.y, selected.traits.sense * 2);
    stroke(140, 55, 95, 55);
    const r = selected.radius;
    line(selected.x, selected.y, selected.x + Math.cos(selected.heading) * r * 2.8, selected.y + Math.sin(selected.heading) * r * 2.8);
    noStroke();
  }

  if (flashMsg && millis() < flashUntil) {
    textAlign(CENTER);
    textSize(12);
    const tw = textWidth(flashMsg) + 26;
    noStroke();
    fill(226, 40, 8, 82);
    rect(W / 2 - tw / 2, H - 46, tw, 28, 14);
    fill(0, 0, 96);
    text(flashMsg, W / 2, H - 27);
    textAlign(LEFT);
  }
}

let detailsHit = null;

function drawWorldOnlyInspector(c) {
  if (!c) return;
  push();
  const pad = 14, w = 280, x = width - w - pad, y = pad + 42; // below exit button
  const lh = 18;
  let reg = 0;
  if (c.reg) for (let i = 0; i < c.reg.length; i++) reg += Math.abs(c.reg[i]);
  const regAvg = c.reg && c.reg.length ? reg / c.reg.length : 0;
  const spRec = world.allSpecies ? world.allSpecies.find((r) => r.id === c.species) : null;
  const spState = spRec ? (spRec.count > 0 ? 'alive' : 'extinct') : '';

  const lines = [
    ['id / gen / sp', '#' + c.id + '  gen ' + c.gen + '  sp #' + c.species + (spState ? ' ' + spState : '')],
    ['age / children', c.age + '  /  ' + c.children],
    ['ATP', Math.max(0, c.energy).toFixed(0) + ' / ' + c.threshold.toFixed(0)],
    ['nutrient / gut', (c.nutrient || 0).toFixed(0) + ' / ' + (c.gutCap || 0).toFixed(0)],
    ['biomass', (c.biomass || 0).toFixed(2) + ' / ' + (c.targetMass || 0).toFixed(2) + '  ' + (c.biomass >= c.matureBiomass ? 'mature' : ((100 * c.biomass / (c.targetMass || 1)).toFixed(0) + '%'))],
    ['cells', String(c.cells || 0)],
  ];
  if (c.tissues) lines.push(['tissues', 'gut ' + c.tissues[0].toFixed(2) + '  mus ' + c.tissues[1].toFixed(2) + '  ner ' + c.tissues[2].toFixed(2) + '  gon ' + c.tissues[3].toFixed(2)]);
  if (c.traits && c.genes) {
    lines.push(['speed', c.traits.speedMax.toFixed(2) + '  (gene ' + c.genes.speedMax.toFixed(2) + ')']);
    lines.push(['sense', c.traits.sense.toFixed(0) + '  (gene ' + c.genes.sense.toFixed(0) + ')']);
    lines.push(['enzyme', c.traits.enzyme.toFixed(2) + '  (gene ' + c.genes.enzyme.toFixed(2) + ')']);
    lines.push(['mut / repro', c.traits.mutRate.toFixed(2) + ' / ' + c.traits.reproE.toFixed(0)]);
  }
  lines.push(['eaten / kills', c.eaten + ' / ' + c.kills + '  reg ' + regAvg.toFixed(2)]);

  const h = 34 + lines.length * lh + 10;
  noStroke();
  fill(226, 28, 10, 82);
  rect(x, y, w, h, 10);
  stroke(226, 18, 30, 70);
  strokeWeight(1);
  noFill();
  rect(x, y, w, h, 10);
  noStroke();

  textAlign(LEFT);
  fill(0, 0, 100);
  textSize(13);
  textStyle(BOLD);
  text('Selected creature', x + 12, y + 20);
  textStyle(NORMAL);

  let ty = y + 38;
  for (let i = 0; i < lines.length; i++) {
    textSize(11);
    fill(0, 0, 64);
    text(lines[i][0], x + 12, ty);
    fill(0, 0, 96);
    textAlign(RIGHT);
    text(lines[i][1], x + w - 12, ty);
    textAlign(LEFT);
    ty += lh;
  }
  pop();
}

// ------------------------------------------------------------------ panel --
function drawPanel() {
  const s = world.stats();
  detailsHit = null;
  push();
  translate(PAD * 2 + W, PAD);

  noStroke();
  fill(226, 24, 13);
  rect(0, 0, PANEL, PH, 10);

  textAlign(LEFT);
  fill(0, 0, 100);
  textSize(15);
  textStyle(BOLD);
  text('ALIFE', 16, 28);
  textStyle(NORMAL);
  fill(paused ? 45 : 120, 65, 95);
  circle(PANEL - 18, 23, 8);

  // key stats (always visible)
  fill(0, 0, 96);
  textSize(13);
  const key = 'pop ' + s.pop + '   gen ' + s.maxGen + '   species ' + s.species;
  text(key, 16, 52);

  // details toggle
  textAlign(RIGHT);
  textSize(11);
  fill(140, 45, 85);
  const tog = showPanelDetails ? '[hide details]' : '[details]';
  text(tog, PANEL - 16, 52);
  detailsHit = { x: PAD * 2 + W + PANEL - 96, y: PAD + 40, w: 90, h: 18 };
  textAlign(LEFT);

  let y = 74;
  if (showPanelDetails) {
    y = section('World', y);
    y = row('tick', s.tick.toLocaleString(), y);
    y = row('population', s.pop + ' / ' + world.p.maxPop, y);
    y = row('food', s.food + ' / ' + world.p.foodCap, y);
    y = row('generation', s.maxGen + '  (avg ' + s.avgGen.toFixed(1) + ')', y);
    y = row('births / deaths', s.births + ' / ' + s.deaths, y);
    y = row('kills / immigrants', s.kills + ' / ' + s.immigrants, y);
    y = row('reproduction', s.mode, y);
    y += 8;
    y = section('Genome (mean, realized)', y);
    y = bar('size', s.size, 0.55, 2.1, y, 200);
    y = bar('speed', s.speed, 0.2, 2.2, y, 150);
    y = bar('sense', s.sense, 12, 110, y, 55);
    y = bar('enzyme', s.enzyme, 0.25, 2.0, y, 90);
    y = bar('mutation', s.mutRate, 0.02, 0.6, y, 300);
    y += 8;
  }

  y = section('Population', y, s.species + ' species');
  drawGraph(16, y, PANEL - 32, 76);
  y += 92; // fixed graph height + margin; prevents overlap

  const spRec = selected && world.allSpecies ? world.allSpecies.find((r) => r.id === selected.species) : null;
  section('Selected creature', y, selected ? ('#' + selected.id) : '');
  if (selected) {
    const c = selected;
    let sy = y + 20;
    let reg = 0;
    if (c.reg) for (let i = 0; i < c.reg.length; i++) reg += Math.abs(c.reg[i]);
    const regAvg = c.reg && c.reg.length ? reg / c.reg.length : 0;
    const spState = spRec ? (spRec.count > 0 ? 'alive' : 'extinct') : 'species ' + c.species;
    sy = row('status', 'gen ' + c.gen + '  age ' + c.age + '  ' + spState, sy);
    sy = row('vitals', 'ATP ' + Math.max(0, c.energy).toFixed(0) + '/' + c.threshold.toFixed(0) +
      '  nut ' + (c.nutrient || 0).toFixed(0) + '/' + (c.gutCap || 0).toFixed(0), sy);
    sy = row('body', 'bio ' + (c.biomass || 0).toFixed(2) + '/' + (c.targetMass || 0).toFixed(2) +
      '  cells ' + (c.cells || 0) + '  ' + (c.biomass >= c.matureBiomass ? 'mature' : (100 * c.biomass / (c.targetMass || 1)).toFixed(0) + '%'), sy);
    if (c.tissues) {
      sy = row('tissues', 'gut ' + c.tissues[0].toFixed(2) + ' mus ' + c.tissues[1].toFixed(2) +
        ' ner ' + c.tissues[2].toFixed(2) + ' gon ' + c.tissues[3].toFixed(2), sy);
    }
    if (c.traits && c.genes) {
      sy = row('speed', c.traits.speedMax.toFixed(2) + ' (gene ' + c.genes.speedMax.toFixed(2) + ')', sy);
      sy = row('sense', c.traits.sense.toFixed(0) + ' (gene ' + c.genes.sense.toFixed(0) + ')', sy);
      sy = row('enzyme', c.traits.enzyme.toFixed(2) + ' (gene ' + c.genes.enzyme.toFixed(2) + ')', sy);
      sy = row('mut / repro', c.traits.mutRate.toFixed(2) + ' / ' + c.traits.reproE.toFixed(0), sy);
    }
    sy = row('behavior', 'eaten ' + c.eaten + '  kills ' + c.kills + '  children ' + c.children + '  reg ' + regAvg.toFixed(2), sy);
  } else {
    fill(0, 0, 62);
    textSize(12);
    text('Click a creature to inspect it.', 16, y + 24);
  }

  pop();
}

function section(name, y, right) {
  textAlign(LEFT);
  textStyle(NORMAL);
  textSize(11);
  fill(0, 0, 72);
  text(name, 16, y);
  if (right) {
    textAlign(RIGHT);
    fill(0, 0, 56);
    textSize(11);
    text(right, PANEL - 16, y);
    textAlign(LEFT);
  }
  noStroke();
  fill(226, 14, 24);
  rect(16, y + 6, PANEL - 32, 1);
  return y + 20;
}

function row(name, value, y, step) {
  const dy = step || 19;
  textSize(12);
  textAlign(LEFT);
  fill(0, 0, 62);
  text(name, 16, y);
  fill(0, 0, 96);
  textAlign(RIGHT);
  text(value, PANEL - 16, y);
  textAlign(LEFT);
  return y + dy;
}

function rowSmall(name, value, y) {
  textSize(9);
  textAlign(LEFT);
  fill(0, 0, 44);
  text(name, 18, y);
  fill(0, 0, 84);
  textAlign(RIGHT);
  text(value, PANEL - 18, y);
  textAlign(LEFT);
  return y + 14;
}

function meter(name, v, lo, hi, y, hue) {
  textSize(9);
  textAlign(LEFT);
  fill(0, 0, 48);
  text(name, 18, y);
  fill(0, 0, 88);
  textAlign(RIGHT);
  text(v < 10 ? v.toFixed(2) : v.toFixed(0), PANEL - 18, y);
  textAlign(LEFT);
  const f = clamp01((v - lo) / (hi - lo));
  noStroke();
  fill(226, 20, 20);
  rect(18, y + 4, PANEL - 36, 3, 2);
  fill(hue, 55, 82, 80);
  rect(18, y + 4, (PANEL - 36) * f, 3, 2);
  return y + 17;
}

function bar(name, v, lo, hi, y, hue) {
  textSize(12);
  textAlign(LEFT);
  fill(0, 0, 64);
  text(name, 16, y);
  fill(0, 0, 96);
  textAlign(RIGHT);
  text(v < 10 ? v.toFixed(2) : v.toFixed(0), PANEL - 16, y);
  textAlign(LEFT);

  const f = clamp01((v - lo) / (hi - lo));
  const bx = 16, bw = PANEL - 32;
  noStroke();
  fill(226, 18, 22);
  rect(bx, y + 5, bw, 4, 2);
  fill(hue, 55, 82, 85);
  rect(bx, y + 5, bw * f, 4, 2);
  // scale markers
  fill(0, 0, 44);
  textSize(9);
  text(v < 10 ? lo.toFixed(2) : lo.toFixed(0), bx, y + 18);
  textAlign(RIGHT);
  text(v < 10 ? hi.toFixed(2) : hi.toFixed(0), bx + bw, y + 18);
  textAlign(LEFT);
  return y + 26;
}

function energyBar(c, y) {
  const f = clamp01(c.energy / c.threshold);
  noStroke();
  fill(226, 20, 20);
  rect(18, y - 8, PANEL - 36, 4, 2);
  fill(120 * f, 60, 85, 85);
  rect(18, y - 8, (PANEL - 36) * f, 4, 2);
  return y + 12;
}

function drawGraph(gx, gy, gw, gh) {
  noStroke();
  fill(226, 22, 15);
  rect(gx, gy, gw, gh, 4);

  stroke(226, 16, 26);
  strokeWeight(1);
  line(gx, gy + gh / 2, gx + gw, gy + gh / 2);
  noStroke();

  const n = popHist.length;
  if (n < 2) return;

  // food, scaled to its own cap
  stroke(112, 60, 60, 60);
  strokeWeight(1);
  noFill();
  beginShape();
  for (let i = 0; i < n; i++) {
    vertex(gx + (i / (n - 1)) * gw, gy + gh - (foodHist[i] / world.p.foodCap) * gh);
  }
  endShape();

  // stacked species, scaled to the visible peak
  let peak = 1;
  for (let i = 0; i < n; i++) if (popHist[i] > peak) peak = popHist[i];
  const scale = Math.max(40, peak * 1.15);

  const hues = new Map();
  for (let i = 0; i < speciesHist.length; i++) {
    const sample = speciesHist[i];
    for (let j = 0; j < sample.length; j++) {
      if (!hues.has(sample[j].id)) hues.set(sample[j].id, sample[j].hue);
    }
  }
  const ids = Array.from(hues.keys()).sort((a, b) => a - b);
  const base = new Array(n).fill(0);

  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    const hue = hues.get(id);
    noStroke();
    fill(hue * 360, 55, 72, 55);
    beginShape();
    for (let i = 0; i < n; i++) {
      const cnt = countOf(speciesHist[i], id);
      vertex(gx + (i / (n - 1)) * gw, gy + gh - ((base[i] + cnt) / scale) * gh);
    }
    for (let i = n - 1; i >= 0; i--) {
      vertex(gx + (i / (n - 1)) * gw, gy + gh - (base[i] / scale) * gh);
    }
    endShape(CLOSE);
    for (let i = 0; i < n; i++) base[i] += countOf(speciesHist[i], id);
  }

  // total population
  stroke(0, 0, 94, 90);
  strokeWeight(1.5);
  noFill();
  beginShape();
  for (let i = 0; i < n; i++) {
    vertex(gx + (i / (n - 1)) * gw, gy + gh - (popHist[i] / scale) * gh);
  }
  endShape();
  noStroke();
}

function countOf(sample, id) {
  for (let i = 0; i < sample.length; i++) if (sample[i].id === id) return sample[i].count;
  return 0;
}

// --------------------------------------------------------------- controls --
function keyPressed() {
  if (key === ' ') { paused = !paused; syncUI(); return false; }
  if (key === '1') stepsPerFrame = 1;
  else if (key === '2') stepsPerFrame = 4;
  else if (key === '3') stepsPerFrame = 16;
  else if (key === '4') stepsPerFrame = 64;
  else if (key === 'r' || key === 'R') resetWorld();
  else if (key === 'p' || key === 'P') {
    world.p.predation = !world.p.predation;
    flash('predation ' + (world.p.predation ? 'on' : 'off'));
  } else if (key === 'c' || key === 'C') {
    colorBy = colorBy === 'genes' ? 'species' : 'genes';
    flash('colour: ' + colorBy);
  } else if (key === 's' || key === 'S') {
    world.p.sexual = !world.p.sexual;
    flash('reproduction: ' + (world.p.sexual ? 'sexual' : 'asexual'));
  } else if (key === 'd' || key === 'D') {
    saveRun();
  } else if (key === 'l' || key === 'L') {
    const f = document.getElementById('file');
    if (f) f.click();
  }
  syncUI();
}

function mousePressed() {
  if (!worldOnly && detailsHit && mouseX >= detailsHit.x && mouseX <= detailsHit.x + detailsHit.w &&
      mouseY >= detailsHit.y && mouseY <= detailsHit.y + detailsHit.h) {
    showPanelDetails = !showPanelDetails;
    return;
  }
  const vt = getWorldTransform();
  const wx = (mouseX - vt.ox) / vt.scale;
  const wy = (mouseY - vt.oy) / vt.scale;
  if (!worldOnly && (mouseX < PAD || mouseX >= PAD + W || mouseY < PAD || mouseY >= PAD + H)) return;
  if (wx < 0 || wx >= W || wy < 0 || wy >= H) return;

  let best = null;
  let bestD = 22 * 22;
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i];
    const dx = c.x - wx;
    const dy = c.y - wy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = c; }
  }
  selected = best;
  if (!best && focusSpeciesId) clearCamera();
}

function touchStarted() {
  mousePressed();
  return false;
}

// -------------------------------------------------------------------- UI --
function clearCamera() {
  camX = W / 2; camY = H / 2; camZ = 1; focusSpeciesId = 0;
}

function focusOnSpecies(id) {
  focusSpeciesId = id | 0;
  updateCameraFocus();
  if (focusSpeciesId) {
    const rec = world && world.allSpecies ? world.allSpecies.find((r) => r.id === focusSpeciesId) : null;
    flash('focused species #' + focusSpeciesId + (rec && rec.count === 0 ? ' (extinct view)' : ''));
  }
}

function updateCameraFocus() {
  if (!focusSpeciesId || !world) return;
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i];
    if (c.species !== focusSpeciesId) continue;
    const score = c.energy + c.biomass * 10;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (best) {
    camX = best.x;
    camY = best.y;
  }
  if (worldOnly) {
    const base = Math.min(width / W, height / H);
    camZ = Math.max(base * 1.8, Math.min(width, height) / 180);
  } else {
    camZ = 2.6;
  }
}

function getWorldTransform() {
  // returns {ox, oy, scale} mapping world coords -> canvas coords
  if (worldOnly) {
    if (focusSpeciesId) {
      updateCameraFocus();
      return { ox: width / 2 - camX * camZ, oy: height / 2 - camY * camZ, scale: camZ };
    }
    return { ox: viewOx, oy: viewOy, scale: viewScale };
  }
  if (focusSpeciesId) {
    updateCameraFocus();
    return { ox: PAD + W / 2 - camX * camZ, oy: PAD + H / 2 - camY * camZ, scale: camZ };
  }
  return { ox: PAD, oy: PAD, scale: 1 };
}

function updateWorldOnlyView() {
  if (!worldOnly || typeof resizeCanvas !== 'function') return;
  const w = Math.max(1, window.innerWidth || W);
  const h = Math.max(1, window.innerHeight || H);
  resizeCanvas(w, h);
  // cover: fill all corners (may crop edges of the torus view)
  viewScale = Math.max(w / W, h / H);
  viewOx = (w - W * viewScale) / 2;
  viewOy = (h - H * viewScale) / 2;
}

function setWorldOnly(on) {
  worldOnly = !!on;
  const body = document.body;
  if (body) body.classList.toggle('world-only', worldOnly);
  if (typeof resizeCanvas === 'function') {
    if (worldOnly) updateWorldOnlyView();
    else resizeCanvas(W + PANEL + PAD * 3, PH + PAD * 2);
  }
  if (focusSpeciesId) updateCameraFocus();
  const exit = document.getElementById('btn-exit-world');
  if (exit) exit.style.display = worldOnly ? 'block' : '';
  syncUI();
}

function windowResized() {
  if (worldOnly) updateWorldOnlyView();
}

function toggleFullscreenWorld() {
  if (worldOnly) {
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) {}
    setWorldOnly(false);
    return;
  }
  setWorldOnly(true);
  try {
    const root = document.documentElement;
    if (!document.fullscreenElement && root && root.requestFullscreen) {
      const p = root.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    }
  } catch (_) { /* world-only still works without Fullscreen API */ }
}

if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && worldOnly) setWorldOnly(false);
  });
}

function setupUI() {
  const $ = (id) => document.getElementById(id);
  if (!$('btn-pause')) return;

  $('btn-pause').onclick = () => { paused = !paused; syncUI(); };
  const speed = $('speed');
  if (speed) {
    speed.oninput = () => {
      stepsPerFrame = Math.max(1, Math.min(128, +speed.value || 1));
      paused = false;
      syncUI();
    };
  }
  $('btn-reset').onclick = () => resetWorld();
  const closeMore = () => { const m = document.getElementById('more-menu'); if (m) m.open = false; };
  $('btn-share').onclick = () => { closeMore(); shareLink(); };
  $('btn-save').onclick = () => { closeMore(); saveRun(); };
  $('btn-load').onclick = () => { closeMore(); $('file').click(); };
  $('file').onchange = loadRun;
  $('btn-predation').onclick = () => {
    world.p.predation = !world.p.predation;
    flash('predation ' + (world.p.predation ? 'on' : 'off'));
    syncUI();
  };
  $('btn-color').onclick = () => {
    colorBy = colorBy === 'genes' ? 'species' : 'genes';
    flash('colour: ' + colorBy);
    syncUI();
  };
  $('btn-sexual').onclick = () => {
    world.p.sexual = !world.p.sexual;
    flash('reproduction: ' + (world.p.sexual ? 'sexual' : 'asexual'));
    syncUI();
  };
  const toggleSpecies = () => {
    showSpeciesCatalog = !showSpeciesCatalog;
    const panel = $('species-panel');
    if (panel) {
      panel.classList.toggle('open', showSpeciesCatalog);
      panel.setAttribute('aria-hidden', showSpeciesCatalog ? 'false' : 'true');
    }
    if (showSpeciesCatalog) renderSpeciesCatalog();
    syncUI();
  };
  if ($('btn-species')) $('btn-species').onclick = toggleSpecies;
  if ($('btn-species-fab')) $('btn-species-fab').onclick = toggleSpecies;
  const speciesSortSel = $('species-sort');
  if (speciesSortSel) {
    speciesSortSel.value = speciesSort;
    speciesSortSel.onchange = () => {
      speciesSort = speciesSortSel.value || 'id';
      renderSpeciesCatalog();
    };
  }
  const showHelpModal = (show) => {
    const m = $('help-modal');
    if (!m) return;
    m.classList.toggle('open', !!show);
    m.setAttribute('aria-hidden', show ? 'false' : 'true');
    if ($('btn-help')) $('btn-help').classList.toggle('on', !!show);
  };
  const dismissHelp = () => {
    try { localStorage.setItem('alife-help-dismissed', '1'); } catch (_) {}
    showHelpModal(false);
  };
  if ($('btn-help')) $('btn-help').onclick = () => showHelpModal(true);
  if ($('btn-help-ok')) $('btn-help-ok').onclick = dismissHelp;
  if ($('help-modal')) {
    $('help-modal').addEventListener('click', (e) => { if (e.target && e.target.id === 'help-modal') dismissHelp(); });
  }
  try {
    if (localStorage.getItem('alife-help-dismissed') !== '1') showHelpModal(true);
  } catch (_) {
    // In restricted contexts, show once per load; it can be dismissed.
    showHelpModal(true);
  }
  if ($('btn-fullscreen')) $('btn-fullscreen').onclick = toggleFullscreenWorld;
  if ($('btn-exit-world')) $('btn-exit-world').onclick = toggleFullscreenWorld;
  $('seed-label').onclick = shareLink;
}

function syncUI() {
  const $ = (id) => document.getElementById(id);
  if (!$('btn-pause')) return;

  $('btn-pause').textContent = paused ? 'resume' : 'pause';
  $('btn-pause').classList.toggle('on', paused);
  const speed = $('speed');
  const speedValue = $('speed-value');
  if (speed) speed.value = String(Math.max(1, Math.min(128, Math.round(stepsPerFrame))));
  if (speedValue) speedValue.textContent = Math.round(stepsPerFrame) + '\u00d7';
  $('btn-predation').textContent = 'predation: ' + (world.p.predation ? 'on' : 'off');
  $('btn-predation').classList.toggle('on', world.p.predation);
  $('btn-color').textContent = 'colour: ' + colorBy;
  $('btn-color').classList.toggle('on', colorBy === 'species');
  $('btn-sexual').textContent = 'sexual: ' + (world.p.sexual ? 'on' : 'off');
  $('btn-sexual').classList.toggle('on', world.p.sexual);
  if ($('btn-species')) $('btn-species').classList.toggle('on', showSpeciesCatalog);
  if ($('btn-species-fab')) $('btn-species-fab').classList.toggle('on', showSpeciesCatalog);
  if ($('btn-fullscreen')) {
    $('btn-fullscreen').textContent = worldOnly ? 'exit world view' : 'fullscreen';
    $('btn-fullscreen').classList.toggle('on', worldOnly);
  }
  $('seed-label').textContent = 'seed ' + world.seed;
}

function renderSpeciesCatalog() {
  const list = document.getElementById('species-list');
  const title = document.getElementById('species-title');
  if (!list || !world) return;
  const allRaw = (world.allSpecies || []).slice();
  const traitOf = (rec, key) => {
    const tr = world.speciesTraits ? world.speciesTraits(rec) : {};
    return tr[key] != null ? tr[key] : -Infinity;
  };
  const all = allRaw.sort((a, b) => {
    if (speciesSort === 'speed') {
      const d = traitOf(b, 'speedMax') - traitOf(a, 'speedMax');
      if (d) return d;
    } else if (speciesSort === 'size') {
      const d = traitOf(b, 'size') - traitOf(a, 'size');
      if (d) return d;
    } else if (speciesSort === 'sense') {
      const d = traitOf(b, 'sense') - traitOf(a, 'sense');
      if (d) return d;
    }
    return a.id - b.id;
  });
  const alive = all.filter((s) => s.count > 0).length;
  if (title) title.textContent = 'Species catalog \u2014 ' + alive + ' alive / ' + all.length + ' total';
  list.textContent = '';
  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'species-card';
    empty.textContent = 'No species data yet.';
    list.appendChild(empty);
    return;
  }
  for (let i = 0; i < all.length; i++) {
    const sp = all[i];
    const tr = world.speciesTraits ? world.speciesTraits(sp) : {};
    const card = document.createElement('div');
    card.className = 'species-card' + (sp.count > 0 ? ' alive' : '');
    card.title = 'Focus view on species #' + sp.id;
    card.onclick = () => focusOnSpecies(sp.id);

    const head = document.createElement('div');
    head.className = 'species-head';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = 'hsl(' + ((sp.hue * 360) | 0) + ' 65% 62%)';
    const id = document.createElement('span');
    id.className = 'species-id';
    id.textContent = 'Species #' + sp.id;
    const state = document.createElement('span');
    state.className = 'species-state' + (sp.count > 0 ? ' on' : '');
    state.textContent = sp.count > 0 ? sp.count + ' alive' : 'extinct';
    head.append(swatch, id, state);

    const traits = document.createElement('div');
    traits.className = 'species-traits';
    const items = [
      ['peak', String(sp.peak || 0)],
      ['first/last', (sp.firstSeen || 0) + '/' + (sp.lastSeen || 0)],
      ['size', tr.size != null ? tr.size.toFixed(2) : '-'],
      ['speed', tr.speedMax != null ? tr.speedMax.toFixed(2) : '-'],
      ['sense', tr.sense != null ? tr.sense.toFixed(0) : '-'],
      ['enzyme', tr.enzyme != null ? tr.enzyme.toFixed(2) : '-'],
      ['mutRate', tr.mutRate != null ? tr.mutRate.toFixed(2) : '-'],
      ['reproE', tr.reproE != null ? tr.reproE.toFixed(0) : '-'],
    ];
    for (let j = 0; j < items.length; j++) {
      const s = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = items[j][1];
      s.textContent = items[j][0] + ' ';
      s.appendChild(b);
      traits.appendChild(s);
    }
    card.append(head, traits);
    list.appendChild(card);
  }
}

function shareLink() {
  const url = new URL(location.href);
  url.searchParams.set('seed', world.seed);
  url.searchParams.set('speed', stepsPerFrame);
  if (colorBy === 'species') url.searchParams.set('color', 'species');
  else url.searchParams.delete('color');
  if (!world.p.predation) url.searchParams.set('predation', '0');
  else url.searchParams.delete('predation');
  if (!world.p.sexual) url.searchParams.set('sexual', '0');
  else url.searchParams.delete('sexual');

  const link = url.toString();
  try { history.replaceState(null, '', link); } catch (_) { /* file:// */ }

  const fallback = () => prompt('Copy this link:', link);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(() => flash('link copied'), fallback);
  } else {
    fallback();
  }
}

function saveRun() {
  const name = 'alife-' + world.seed + '-' + world.tick + '.json';
  saveJSON(world.serialize(), name);
  flash('saved ' + name);
}

function loadRun(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const next = ALife.World.fromJSON(JSON.parse(reader.result));
      world = next;
      selected = null;
      popHist = [];
      foodHist = [];
      speciesHist = [];
      sampleClock = 0;
      catalogClock = 0;
      clearCamera();
      paused = false;
      syncUI();
      renderSpeciesCatalog();
      flash('loaded seed ' + next.seed);
    } catch (err) {
      console.error(err);
      flash('load failed: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function flash(msg) {
  flashMsg = msg;
  flashUntil = millis() + 1600;
}
