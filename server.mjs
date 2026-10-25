import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT || 4173);
const MOCK = process.env.MOCK === '1' || !process.env.YOUCAM_API_KEY;
const KEY = process.env.YOUCAM_API_KEY || '';
const BASE = 'https://yce-api-01.makeupar.com';
const ACTIONS = ['wrinkle', 'pore', 'texture', 'acne', 'oiliness', 'redness', 'radiance', 'moisture'];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function yce(path, init) {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error('yce ' + r.status + ' ' + text.slice(0, 180));
  return data;
}

// Deterministic mock so the demo is stable and the UI can be developed without a key.
function mockAnalysis(seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 100000;
  const rnd = (i) => ((h >> i) % 37) / 37;
  const out = {};
  ACTIONS.forEach((a, i) => {
    const score = Math.round(52 + rnd(i + 1) * 40);
    out[a] = { score, ui_score: score, raw_score: score };
  });
  return { results: out, mock: true };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, mode: MOCK ? 'mock' : 'live', actions: ACTIONS });
    }

    // Accepts a base64 data URL, returns normalised scores.
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8')); } catch {}
      const image = String(payload.image || '');
      if (!image.startsWith('data:image/')) return json(res, 400, { error: 'image must be a data URL' });
      if (raw.length > 8 * 1024 * 1024) return json(res, 413, { error: 'image too large (max 8MB)' });

      if (MOCK) return json(res, 200, mockAnalysis(image.slice(0, 400)));

      const base64 = image.split(',')[1];
      const up = await yce('/v2.0/file', { method: 'POST', body: JSON.stringify({ file: base64 }) });
      const fileId = up?.data?.file_id || up?.file_id;
      if (!fileId) throw new Error('no file_id in upload response');

      const task = await yce('/v2.0/task/skin-analysis', {
        method: 'POST',
        body: JSON.stringify({ src_file_id: fileId, dst_actions: ACTIONS }),
      });
      const taskId = task?.data?.task_id || task?.task_id;
      if (!taskId) throw new Error('no task_id');

      let result = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const poll = await yce('/v2.0/task/skin-analysis/' + encodeURIComponent(taskId));
        const status = poll?.data?.task_status || poll?.task_status;
        if (status === 'success' || status === 'done') { result = poll; break; }
        if (status === 'error' || status === 'failed') throw new Error('task failed: ' + JSON.stringify(poll).slice(0, 160));
      }
      if (!result) throw new Error('task timed out');
      return json(res, 200, { raw: result, results: normalise(result) });
    }

    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(process.cwd(), p));
    if (!file.startsWith(process.cwd())) return json(res, 403, { error: 'forbidden' });
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch (e) {
    json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});

function normalise(poll) {
  const d = poll?.data || poll || {};
  const results = d.results || d.output || d.scores || {};
  const out = {};
  for (const a of ACTIONS) {
    const v = results[a];
    if (v == null) continue;
    const score = typeof v === 'number' ? v : Number(v.ui_score ?? v.score ?? v.raw_score ?? NaN);
    if (Number.isFinite(score)) out[a] = { score };
  }
  return out;
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('skin-ledger on http://127.0.0.1:' + PORT + ' (' + (MOCK ? 'mock' : 'live') + ')');
});
