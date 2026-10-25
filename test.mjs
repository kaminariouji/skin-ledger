// Smoke test: boots the server in mock mode and checks the contract the UI depends on.
// No network, no API key, no units. Run with: npm test
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';

const PORT = 4399;
const BASE = 'http://127.0.0.1:' + PORT;
const child = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT), MOCK: '1', YOUCAM_API_KEY: '' },
  stdio: 'ignore',
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return;
    } catch {}
    await wait(150);
  }
  throw new Error('server did not start');
}

const img = (n) => 'data:image/png;base64,' + Buffer.from('fake-image-' + n).toString('base64');
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ' — ' + e.message); }
};

try {
  await up();

  await check('health reports mock mode', async () => {
    const j = await (await fetch(BASE + '/api/health')).json();
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'mock');
  });

  await check('index.html is served', async () => {
    const r = await fetch(BASE + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
  });

  await check('sample record is served', async () => {
    const j = await (await fetch(BASE + '/demo.json')).json();
    assert.equal(j.records.length, 4);
    assert.ok(j.changes.length >= 4);
    assert.ok(j.factors.length >= 3);
  });

  await check('a scan returns eight scores', async () => {
    const r = await fetch(BASE + '/api/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: img('a'), tier: 'sd' }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(Object.keys(j.results).length, 8);
  });

  await check('two different photos do not score identically', async () => {
    const one = await (await fetch(BASE + '/api/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: img('face-one'), tier: 'sd' }),
    })).json();
    const two = await (await fetch(BASE + '/api/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: img('face-two'), tier: 'sd' }),
    })).json();
    assert.notDeepEqual(one.results, two.results);
  });

  await check('the copilot answers without a key', async () => {
    const r = await fetch(BASE + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: 'what changed?',
        ledger: {
          records: [
            { ts: Date.now() - 7 * 86400000, scores: { acne: 70, redness: 80 } },
            { ts: Date.now(), scores: { acne: 62, redness: 79 } },
          ],
          changes: [{ ts: Date.now() - 86400000, what: 'Started azelaic acid' }],
          factors: [],
        },
      }),
    });
    const j = await r.json();
    assert.ok(j.answer && j.answer.length > 20, 'answer too short');
  });

  await check('server.mjs is not downloadable', async () => {
    const r = await fetch(BASE + '/server.mjs');
    assert.equal(r.status, 404);
  });

  await check('path traversal is refused', async () => {
    const r = await fetch(BASE + '/../server.mjs');
    assert.equal(r.status, 404);
  });

  await check('unknown host is refused', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/health', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
} finally {
  child.kill();
}

console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
process.exit(failed ? 1 : 0);
