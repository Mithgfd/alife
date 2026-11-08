/* Headless smoke test: load index.html, let it run, then ask the page what
 * happened. Verifies no JS errors, the sim is ticking, and the canvas has
 * actually been painted. */
const { spawn } = require('child_process');

const CHROME = process.env.CHROME || 'chromium';
const URL = 'file:///home/flo/alife/index.html';
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

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(3000);
  await send('Runtime.evaluate', { expression: 'stepsPerFrame = 64' });
  await sleep(6000);

  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
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
        tick: w ? w.tick : null,
        pop: w ? w.creatures.length : null,
        food: w ? w.food.length : null,
        births: w ? w.births : null,
        maxGen: w ? w.stats().maxGen : null,
        litFraction: +(lit / samples).toFixed(3),
        distinctColors: colors.size,
        stageChildren: document.getElementById('stage').children.length,
      };
    })()`,
  });

  console.log('page state:', JSON.stringify(probe.result?.result?.value, null, 2));

  // exercise the selected-creature panel and the predation toggle
  await send('Runtime.evaluate', { expression: 'selected = world.creatures[0]' });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
  await sleep(700);
  const probe2 = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: '({ selectedId: selected && selected.id, predation: world.p.predation, tick: world.tick })',
  });
  console.log('interaction:', JSON.stringify(probe2.result?.result?.value));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('/tmp/alife.png', Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot -> /tmp/alife.png');

  if (errors.length) {
    console.log('\nERRORS:');
    for (const e of errors) console.log(' -', e);
  } else {
    console.log('\nno console errors or exceptions');
  }

  ws.close();
  chrome.kill('SIGKILL');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  chrome.kill('SIGKILL');
  process.exit(1);
});
