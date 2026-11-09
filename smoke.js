/* Headless smoke test: load index.html, let it run, then ask the page what
 * happened. Verifies no JS errors, the sim is ticking, the canvas has been
 * painted, and the new controls (species colour, reproduction toggle, save
 * round-trip) actually work. */
const { spawn } = require('child_process');

const CHROME = process.env.CHROME || 'chromium';
const URL = process.env.URL || 'file:///home/flo/alife/index.html';
const PORT = 9333;

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1300,860', `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetURL() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('devtools never came up');
}

(async () => {
  const ws = new WebSocket(await targetURL());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.text + ': ' +
        (m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression });
    return r.result?.result?.value;
  };
  const key = async (k, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(3000);
  await evaluate('stepsPerFrame = 64');
  await sleep(6000);

  const probe = await evaluate(`(() => {
    const c = document.querySelector('canvas');
    if (!c) return { error: 'no canvas element' };
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0, samples = 0;
    const colors = new Set();
    for (let i = 0; i < d.length; i += 4 * 61) {
      samples++;
      if (d[i] > 30 || d[i + 1] > 30 || d[i + 2] > 30) lit++;
      colors.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
    }
    const w = (typeof world !== 'undefined') ? world : null;
    return {
      canvas: [c.width, c.height],
      viewport: [innerWidth, innerHeight],
      tick: w ? w.tick : null,
      pop: w ? w.creatures.length : null,
      food: w ? w.food.length : null,
      births: w ? w.births : null,
      maxGen: w ? w.stats().maxGen : null,
      species: w ? w.species.length : null,
      speciesSamples: typeof speciesHist !== 'undefined' ? speciesHist.length : null,
      sexual: w ? w.p.sexual : null,
      litFraction: +(lit / samples).toFixed(3),
      distinctColors: colors.size,
      buttons: document.querySelectorAll('#toolbar button').length,
      stageChildren: document.getElementById('stage').children.length,
    };
  })()`);
  console.log('page state:', JSON.stringify(probe, null, 2));

  // species colour + sexual toggle via keyboard
  await key('c', 'KeyC', 67);
  await sleep(300);
  const afterColor = await evaluate('colorBy');
  await key('s', 'KeyS', 83);
  await sleep(300);
  const afterSex = await evaluate('world.p.sexual');
  await key('s', 'KeyS', 83);

  // pause before selecting so the creature cannot die under us
  await key(' ', 'Space', 32);
  await sleep(200);

  // select a creature and toggle predation via the toolbar
  await evaluate('selected = world.creatures[0]');
  await sleep(200);
  const selectedId = await evaluate('selected ? selected.id : null');
  await evaluate(`document.getElementById('btn-predation').click()`);
  await sleep(300);
  const afterPredation = await evaluate('world.p.predation');

  // save/load round-trip in the page itself
  const roundTrip = await evaluate(`(() => {
    const before = world;
    const json = JSON.parse(JSON.stringify(before.serialize()));
    const after = ALife.World.fromJSON(json);
    return {
      sameTick: after.tick === before.tick,
      samePop: after.creatures.length === before.creatures.length,
      sameSeed: after.seed === before.seed,
      sameSpecies: after.species.length === before.species.length,
    };
  })()`);

  // reset should produce a fresh world and update the URL seed
  const beforeSeed = await evaluate('world.seed');
  await key('r', 'KeyR', 82);
  await sleep(500);
  const afterReset = await evaluate(`({
    seed: world.seed,
    tick: world.tick,
    urlHasSeed: new URL(location.href).searchParams.has('seed'),
  })`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('/tmp/alife.png', Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot -> /tmp/alife.png');

  const checks = [
    ['no canvas', probe && probe.canvas],
    ['sim advanced', probe && probe.tick > 1000],
    ['canvas painted', probe && probe.litFraction > 0.05],
    ['species tracked', probe && probe.species > 0],
    ['species graph sampled', probe && probe.speciesSamples > 0],
    ['sexual is default', probe && probe.sexual === true],
    ['toolbar rendered', probe && probe.buttons >= 10],
    ['colour key works', afterColor === 'species'],
    ['sex key works', afterSex === false],
    ['creature selected', selectedId !== null],
    ['predation toggle works', afterPredation === false],
    ['save/load tick', roundTrip && roundTrip.sameTick],
    ['save/load pop', roundTrip && roundTrip.samePop],
    ['save/load seed', roundTrip && roundTrip.sameSeed],
    ['save/load species', roundTrip && roundTrip.sameSpecies],
    ['reset ran', afterReset && afterReset.tick < 500],
    ['reset changed seed', afterReset && afterReset.seed !== beforeSeed],
    ['url has seed', afterReset && afterReset.urlHasSeed],
  ];
  let failed = 0;
  console.log('\nchecks:');
  for (const [name, ok] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  }

  if (errors.length) {
    console.log('\nERRORS:');
    for (const e of errors) console.log(' -', e);
    failed += errors.length;
  } else {
    console.log('\nno console errors or exceptions');
  }

  ws.close();
  chrome.kill('SIGKILL');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  chrome.kill('SIGKILL');
  process.exit(1);
});
