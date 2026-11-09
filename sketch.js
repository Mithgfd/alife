/* sketch.js — p5 viewer.
 *
 * All simulation state lives in ALife.World. This file only reads it and
 * draws. The only things it feeds back are UI toggles and the speed control.
 */

const W = 900;
const H = 700;
const PH = H + 72;               // panel is taller than the world stage
const PAD = 14;
const PANEL = 320;

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

  background(226, 24, 7);
  push();
  translate(PAD, PAD);
  drawWorld();
  pop();
  drawPanel();
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
function drawWorld() {
  noStroke();
  fill(226, 30, 10);
  rect(0, 0, W, H, 10);

  noFill();
  stroke(226, 16, 20);
  strokeWeight(1);
  rect(0.5, 0.5, W - 1, H - 1, 10);
  noStroke();

  // food — one fill call for all of it
  fill(112, 65, 58, 85);
  for (let i = 0; i < world.food.length; i++) {
    const f = world.food[i];
    circle(f.x, f.y, 3.6);
  }

  // bodies, brightness = energy
  noStroke();
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i];
    const hue = (colorBy === 'species' ? c.speciesHue : c.genes.hue) * 360;
    const e = clamp01(c.energy / c.threshold);
    fill(hue, 55, 46 + 46 * e, 90);
    circle(c.x, c.y, c.radius * 2);
  }

  // tissue rings: body composition as four coloured arcs around each body
  const tissueHue = [120, 0, 210, 300];
  noFill();
  strokeWeight(1.4);
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i];
    if (c.cells < 4) continue;
    const r = c.radius + 1.5;
    let a = c.heading;
    for (let k = 0; k < 4; k++) {
      const span = c.tissues[k] * TAU;
      if (span > 0.06) {
        stroke(tissueHue[k], 60, 82, 65);
        arc(c.x, c.y, r * 2, r * 2, a + 0.03, a + span - 0.03, OPEN, 5);
      }
      a += span;
    }
  }
  noStroke();

  // heading ticks
  strokeWeight(1);
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i];
    stroke((colorBy === 'species' ? c.speciesHue : c.genes.hue) * 360, 45, 100, 85);
    const r = c.radius;
    line(c.x, c.y, c.x + Math.cos(c.heading) * r * 2, c.y + Math.sin(c.heading) * r * 2);
  }
  noStroke();

  if (selected) {
    noFill();
    stroke(0, 0, 100, 85);
    strokeWeight(1.5);
    circle(selected.x, selected.y, selected.radius * 2 + 8);
    stroke(0, 0, 100, 18);
    strokeWeight(1);
    circle(selected.x, selected.y, selected.traits.sense * 2);
    noStroke();
  }

  if (flashMsg && millis() < flashUntil) {
    textAlign(CENTER);
    textSize(11);
    const tw = textWidth(flashMsg) + 26;
    noStroke();
    fill(226, 40, 8, 82);
    rect(W / 2 - tw / 2, H - 46, tw, 26, 13);
    fill(0, 0, 95);
    text(flashMsg, W / 2, H - 28);
    textAlign(LEFT);
  }
}

// ------------------------------------------------------------------ panel --
function drawPanel() {
  const s = world.stats();
  push();
  translate(PAD * 2 + W, PAD);

  noStroke();
  fill(226, 26, 12);
  rect(0, 0, PANEL, PH, 10);

  textAlign(LEFT);
  fill(0, 0, 100);
  textSize(14);
  textStyle(BOLD);
  text('ALIFE', 18, 30);
  textStyle(NORMAL);
  fill(0, 0, 50);
  textSize(10);
  text('evolving foragers', 18, 46);

  textAlign(RIGHT);
  fill(0, 0, 36);
  textSize(9);
  text('seed ' + world.seed, PANEL - 18, 46);
  textAlign(LEFT);

  fill(paused ? 45 : 120, 65, 95);
  circle(PANEL - 24, 26, 8);

  let y = 78;
  y = section('WORLD', y);
  y = row('tick', s.tick.toLocaleString(), y);
  y = row('population', s.pop + ' / ' + world.p.maxPop, y);
  y = row('food', s.food + ' / ' + world.p.foodCap, y);
  y = row('generation', s.maxGen + '  (avg ' + s.avgGen.toFixed(1) + ')', y);
  y = row('species', String(s.species), y);
  y = row('births / deaths', s.births + ' / ' + s.deaths, y);
  y = row('kills / immigrants', s.kills + ' / ' + s.immigrants, y);
  y = row('reproduction', s.mode, y);

  y += 10;
  y = section('GENOME  (mean)', y);
  y = bar('size', s.size, 0.55, 2.1, y, 200);
  y = bar('speed', s.speed, 0.2, 2.2, y, 150);
  y = bar('sense', s.sense, 12, 110, y, 55);
  y = bar('enzyme', s.enzyme, 0.25, 2.0, y, 90);
  y = bar('mutation', s.mutRate, 0.02, 0.6, y, 300);

  y += 12;
  y = section('POPULATION', y, s.species + ' species');
  drawGraph(18, y, PANEL - 36, 84);
  y += 96;

  const spRec = selected && world.allSpecies ? world.allSpecies.find((r) => r.id === selected.species) : null;
  section('SELECTED CREATURE', y, selected ? ('#' + selected.id + '  sp ' + selected.species) : '');
  if (selected) {
    const c = selected;
    let sy = y + 20;
    let reg = 0;
    if (c.reg) for (let i = 0; i < c.reg.length; i++) reg += Math.abs(c.reg[i]);
    const regAvg = c.reg && c.reg.length ? reg / c.reg.length : 0;
    const spState = spRec ? (spRec.count > 0 ? 'alive' : 'extinct') : '';
    sy = rowSmall('identity', 'gen ' + c.gen + '  age ' + c.age + '  children ' + c.children, sy);
    sy = rowSmall('species', '#' + c.species + (spState ? '  ' + spState : '') + (spRec ? '  peak ' + spRec.peak : ''), sy);
    sy = rowSmall('position', c.x.toFixed(0) + ', ' + c.y.toFixed(0) + '  v ' + Math.sqrt(c.vx * c.vx + c.vy * c.vy).toFixed(2), sy);

    sy = meter('ATP', Math.max(0, c.energy), 0, c.threshold || 1, sy, 120);
    sy = meter('nutrient', c.nutrient || 0, 0, c.gutCap || 1, sy, 45);
    sy = meter('biomass', c.biomass || 0, 0, c.targetMass || 1, sy, 200);
    sy = rowSmall('body', 'cells ' + (c.cells || 0) + '  mature ' + (c.biomass >= c.matureBiomass ? 'yes' : (100 * c.biomass / (c.targetMass || 1)).toFixed(0) + '%') +
      '  target ' + (c.targetMass || 0).toFixed(2), sy);

    if (c.tissues) {
      sy = rowSmall('tissues', 'gut ' + c.tissues[0].toFixed(2) + '  mus ' + c.tissues[1].toFixed(2) +
        '  ner ' + c.tissues[2].toFixed(2) + '  gon ' + c.tissues[3].toFixed(2), sy);
    }
    if (c.genes) {
      sy = rowSmall('development', 'alloc g' + (c.genes.allocGut || 0).toFixed(2) + ' m' + (c.genes.allocMuscle || 0).toFixed(2) +
        ' n' + (c.genes.allocNerve || 0).toFixed(2) + ' o' + (c.genes.allocGonad || 0).toFixed(2) +
        '  timing ' + (c.genes.devTiming || 0).toFixed(2), sy);
    }

    if (c.traits && c.genes) {
      sy = rowSmall('speed', c.traits.speedMax.toFixed(2) + ' realized  /  ' + c.genes.speedMax.toFixed(2) + ' gene', sy);
      sy = rowSmall('sense', c.traits.sense.toFixed(0) + ' realized  /  ' + c.genes.sense.toFixed(0) + ' gene', sy);
      sy = rowSmall('enzyme', c.traits.enzyme.toFixed(2) + ' realized  /  ' + c.genes.enzyme.toFixed(2) + ' gene', sy);
      sy = rowSmall('mut / repro', c.traits.mutRate.toFixed(2) + ' / ' + c.traits.reproE.toFixed(0) +
        '  (genes ' + c.genes.mutRate.toFixed(2) + ' / ' + c.genes.reproE.toFixed(0) + ')', sy);
    }
    sy = rowSmall('behavior', 'eaten ' + c.eaten + '  kills ' + c.kills + '  reg ' + regAvg.toFixed(2) +
      (c.matedTick === world.tick ? '  mated' : ''), sy);
  } else {
    fill(0, 0, 38);
    textSize(10);
    text('click a creature to inspect it', 18, y + 24);
    textSize(9);
    fill(0, 0, 30);
    text('open Species catalog for lineage history', 18, y + 40);
  }

  pop();
}

function section(name, y, right) {
  textAlign(LEFT);
  textStyle(BOLD);
  textSize(9);
  fill(0, 0, 34);
  text(name, 18, y);
  if (right) {
    textAlign(RIGHT);
    fill(0, 0, 34);
    text(right, PANEL - 18, y);
    textAlign(LEFT);
  }
  textStyle(NORMAL);
  stroke(226, 16, 26);
  strokeWeight(1);
  line(18, y + 8, PANEL - 18, y + 8);
  noStroke();
  return y + 22;
}

function row(name, value, y, step) {
  const dy = step || 17;
  textSize(10);
  textAlign(LEFT);
  fill(0, 0, 50);
  text(name, 18, y);
  fill(0, 0, 92);
  textAlign(RIGHT);
  text(value, PANEL - 18, y);
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
  textSize(10);
  textAlign(LEFT);
  fill(0, 0, 50);
  text(name, 18, y);
  fill(0, 0, 92);
  textAlign(RIGHT);
  text(v < 10 ? v.toFixed(2) : v.toFixed(0), PANEL - 18, y);
  textAlign(LEFT);

  const f = clamp01((v - lo) / (hi - lo));
  noStroke();
  fill(226, 20, 20);
  rect(18, y + 5, PANEL - 36, 3, 2);
  fill(hue, 55, 82, 80);
  rect(18, y + 5, (PANEL - 36) * f, 3, 2);
  return y + 21;
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
  const wx = mouseX - PAD;
  const wy = mouseY - PAD;
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
}

function touchStarted() {
  mousePressed();
  return false;
}

// -------------------------------------------------------------------- UI --
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
  $('btn-share').onclick = shareLink;
  $('btn-save').onclick = saveRun;
  $('btn-load').onclick = () => $('file').click();
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
  $('seed-label').textContent = 'seed ' + world.seed;
}

function renderSpeciesCatalog() {
  const list = document.getElementById('species-list');
  const title = document.getElementById('species-title');
  if (!list || !world) return;
  const all = (world.allSpecies || []).slice().sort((a, b) => {
    const da = a.count > 0 ? 0 : 1;
    const db = b.count > 0 ? 0 : 1;
    if (da !== db) return da - db;
    if (b.peak !== a.peak) return b.peak - a.peak;
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
