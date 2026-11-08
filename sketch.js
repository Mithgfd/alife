/* sketch.js — p5 viewer.
 *
 * All simulation state lives in ALife.World. This file only reads it and
 * draws. Nothing here feeds back into the sim except the speed control.
 */

const W = 900;
const H = 700;
const PAD = 14;
const PANEL = 320;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

let world;
let stepsPerFrame = 4;
let paused = false;
let selected = null;
let popHist = [];
let foodHist = [];
let sampleClock = 0;

function setup() {
  const cnv = createCanvas(W + PANEL + PAD * 3, H + PAD * 2);
  cnv.parent('stage');
  pixelDensity(1);
  colorMode(HSB, 360, 100, 100, 100);
  textFont('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace');
  resetWorld();
}

function resetWorld() {
  world = new ALife.World();
  selected = null;
  popHist = [];
  foodHist = [];
  sampleClock = 0;
}

function draw() {
  if (!paused) {
    for (let i = 0; i < stepsPerFrame; i++) world.step();

    sampleClock++;
    if (sampleClock >= 4) {
      sampleClock = 0;
      popHist.push(world.creatures.length);
      foodHist.push(world.food.length);
      if (popHist.length > 340) {
        popHist.shift();
        foodHist.shift();
      }
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
    const hue = c.genes.hue * 360;
    const e = clamp01(c.energy / c.threshold);
    fill(hue, 55, 46 + 46 * e, 90);
    circle(c.x, c.y, c.radius * 2);
  }

  // heading ticks
  strokeWeight(1);
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i];
    stroke(c.genes.hue * 360, 45, 100, 85);
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
    circle(selected.x, selected.y, selected.genes.sense * 2);
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
  rect(0, 0, PANEL, H, 10);

  textAlign(LEFT);
  fill(0, 0, 100);
  textSize(14);
  textStyle(BOLD);
  text('ALIFE', 18, 30);
  textStyle(NORMAL);
  fill(0, 0, 50);
  textSize(10);
  text('evolving foragers', 18, 46);

  fill(paused ? 45 : 120, 65, 95);
  circle(PANEL - 24, 26, 8);

  let y = 78;
  y = section('WORLD', y);
  y = row('tick', s.tick.toLocaleString(), y);
  y = row('population', s.pop + ' / ' + world.p.maxPop, y);
  y = row('food', s.food + ' / ' + world.p.foodCap, y);
  y = row('generation', s.maxGen + '  (avg ' + s.avgGen.toFixed(1) + ')', y);
  y = row('births / deaths', s.births + ' / ' + s.deaths, y);
  y = row('immigrants', String(s.immigrants), y);
  y = row('kills', String(s.kills), y);
  y = row('speed', paused ? 'paused' : stepsPerFrame + 'x', y);

  y += 10;
  y = section('GENOME  (mean)', y);
  y = bar('size', s.size, 0.55, 2.1, y, 200);
  y = bar('speed', s.speed, 0.2, 2.2, y, 150);
  y = bar('sense', s.sense, 12, 110, y, 55);
  y = bar('mutation', s.mutRate, 0.02, 0.6, y, 300);

  y += 12;
  y = section('POPULATION', y);
  drawGraph(18, y, PANEL - 36, 84);
  y += 96;

  section('SELECTED', y);
  if (selected) {
    const c = selected;
    let sy = y + 22;
    sy = row('id / gen', '#' + c.id + '  gen ' + c.gen, sy);
    sy = row('energy', Math.max(0, c.energy).toFixed(0) + ' / ' + c.threshold.toFixed(0), sy);
    sy = energyBar(c, sy);
    sy = row('eaten / kills', c.eaten + ' / ' + c.kills, sy);
    sy = row('children / age', c.children + ' / ' + c.age, sy);
    sy = row('size / speed', c.genes.size.toFixed(2) + ' / ' + c.genes.speedMax.toFixed(2), sy);
    sy = row('sense / mut', c.genes.sense.toFixed(0) + ' / ' + c.genes.mutRate.toFixed(2), sy);
  } else {
    fill(0, 0, 38);
    textSize(10);
    text('click a creature to inspect it', 18, y + 24);
  }

  pop();
}

function section(name, y) {
  textAlign(LEFT);
  textStyle(BOLD);
  textSize(9);
  fill(0, 0, 34);
  text(name, 18, y);
  textStyle(NORMAL);
  stroke(226, 16, 26);
  strokeWeight(1);
  line(18, y + 8, PANEL - 18, y + 8);
  noStroke();
  return y + 22;
}

function row(name, value, y) {
  textSize(10);
  textAlign(LEFT);
  fill(0, 0, 50);
  text(name, 18, y);
  fill(0, 0, 92);
  textAlign(RIGHT);
  text(value, PANEL - 18, y);
  textAlign(LEFT);
  return y + 18;
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

  // population, scaled to the ceiling
  stroke(0, 0, 92, 90);
  strokeWeight(1.5);
  beginShape();
  for (let i = 0; i < n; i++) {
    vertex(gx + (i / (n - 1)) * gw, gy + gh - (popHist[i] / world.p.maxPop) * gh);
  }
  endShape();
  noStroke();
}

// --------------------------------------------------------------- controls --
function keyPressed() {
  if (key === ' ') paused = !paused;
  if (key === '1') stepsPerFrame = 1;
  if (key === '2') stepsPerFrame = 4;
  if (key === '3') stepsPerFrame = 16;
  if (key === '4') stepsPerFrame = 64;
  if (key === 'r' || key === 'R') resetWorld();
  if (key === 'p' || key === 'P') {
    world.p.predation = !world.p.predation;
    flash('predation ' + (world.p.predation ? 'on' : 'off'));
  }
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

let flashMsg = '';
let flashUntil = 0;

function flash(msg) {
  flashMsg = msg;
  flashUntil = millis() + 1200;
}
