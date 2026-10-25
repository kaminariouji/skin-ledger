import http from 'node:http';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT || 4173);
const MOCK = process.env.MOCK === '1' || !process.env.YOUCAM_API_KEY;
const KEY = process.env.YOUCAM_API_KEY || '';
const BASE = 'https://yce-api-01.makeupar.com';
const ACTIONS = ['wrinkle', 'pore', 'texture', 'acne', 'oiliness', 'redness', 'radiance', 'moisture'];

const ASSETS = new Map();
const MAX_ASSETS = 24;

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

// Minimal ZIP reader: the results archive stores one JSON plus per-action PNG masks.
function unzipEntries(buf) {
  const out = new Map();
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nlen).toString('utf8');
    const start = i + 30 + nlen + elen;
    const data = buf.slice(start, start + csize);
    try { out.set(name, method === 0 ? data : zlib.inflateRawSync(data)); } catch {}
    i = start + csize;
  }
  return out;
}

async function analyseOnce(buffer, contentType) {
  const up = await yce('/s2s/v2.0/file', {
    method: 'POST',
    body: JSON.stringify({
      files: [{
        content_type: contentType,
        file_name: 'upload.' + (contentType.split('/')[1] || 'jpg'),
        file_size: buffer.length,
        file_data: buffer.toString('base64'),
      }],
    }),
  });
  const file = up?.data?.files?.[0];
  if (!file) throw new Error('no file entry in upload response');

  const put = file.requests?.[0];
  if (!put) throw new Error('no upload request returned');
  const putRes = await fetch(put.url, { method: put.method || 'PUT', headers: put.headers || {}, body: buffer });
  if (putRes.status >= 300) throw new Error('binary upload failed: ' + putRes.status);
  // The analysis worker fetches the object we just wrote; give S3 a beat to make it readable.
  await new Promise((r) => setTimeout(r, 700));

  const task = await yce('/s2s/v2.0/task/skin-analysis', {
    method: 'POST',
    body: JSON.stringify({ src_file_id: file.file_id, dst_actions: ACTIONS }),
  });
  const taskId = task?.data?.task_id;
  if (!taskId) throw new Error('no task_id');

  let done = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await yce('/s2s/v2.0/task/skin-analysis/' + encodeURIComponent(taskId));
    const status = poll?.data?.task_status;
    if (status === 'success') { done = poll; break; }
    if (status === 'error') { const e = new Error('task failed'); e.code = poll?.data?.error || 'error_unknown'; throw e; }
  }
  if (!done) throw new Error('task timed out');
  return { done, taskId };
}

async function liveAnalysis(buffer, contentType) {
  let attempt = null;
  for (let i = 0; i < 2; i++) {
    try {
      attempt = await analyseOnce(buffer, contentType);
      break;
    } catch (e) {
      // A failed S3 fetch is infrastructure, not the photo: retry exactly once.
      if (e.code === 'error_download_image' && i === 0) continue;
      throw e;
    }
  }
  const { done, taskId } = attempt;
  const url = done?.data?.results?.url;
  if (!url) throw new Error('no results url');
  const zip = Buffer.from(await (await fetch(url)).arrayBuffer());
  const entries = unzipEntries(zip);
  let scoreJson = null;
  for (const [name, content] of entries) {
    if (name.endsWith('score_info.json')) { scoreJson = JSON.parse(content.toString('utf8')); break; }
  }
  if (!scoreJson) throw new Error('score_info.json missing from results');

  const results = {};
  for (const a of ACTIONS) {
    const v = scoreJson[a];
    if (!v) continue;
    const score = Number(v.ui_score ?? v.raw_score ?? NaN);
    if (Number.isFinite(score)) results[a] = { score: Math.round(score) };
  }
  const id = Math.random().toString(36).slice(2, 10);
  const files = new Map();
  for (const [name, content] of entries) files.set(name.replace('skinanalysisResult/', ''), content);
  ASSETS.set(id, files);
  if (ASSETS.size > MAX_ASSETS) ASSETS.delete(ASSETS.keys().next().value);
  const masks = {};
  for (const a of ACTIONS) if (files.has(a + '_output.png')) masks[a] = '/api/asset/' + id + '/' + a + '_output.png';
  const image = files.has('resize_image.jpg') ? '/api/asset/' + id + '/resize_image.jpg' : null;
  return { results, mock: false, taskId, assets: { id, image, masks } };
}

// Deterministic mock so the demo is stable and the UI can be developed without a key.
function mockAnalysis(seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 100000;
  const rnd = (i) => ((h >> i) % 37) / 37;
  const out = {};
  ACTIONS.forEach((a, i) => {
    const score = Math.round(52 + rnd(i + 1) * 40);
    out[a] = { score };
  });
  return { results: out, mock: true };
}

function buildBrief(records, changes) {
  const rows = records.map((r) => {
    const scores = Object.keys(r.scores || {}).map((k) => k + ' ' + Math.round(r.scores[k])).join(', ');
    return new Date(r.ts).toISOString().slice(0, 10) + ': ' + scores;
  });
  const log = changes.map((c) => new Date(c.ts).toISOString().slice(0, 10) + ': ' + c.what);
  return { rows, log, n: records.length };
}

function promptFor(brief, question) {
  const data = brief.rows.length ? brief.rows.join('\n') : 'No scans yet.';
  const log = brief.log.length ? brief.log.join('\n') : 'No changes logged.';
  return [
    'You are the analyst inside Skin Ledger, a personal skin-tracking app.',
    'You only see numbers the user already has: dated YouCam Skin AI scores from 0 to 100 where higher is better, and a log of routine changes.',
    'Rules:',
    '- Answer in at most 90 words, plain prose, no headings.',
    '- Use the actual numbers and dates.',
    '- If a move is under 3 points, call it noise. If there are fewer than 2 scans, say the data is too thin.',
    '- Never diagnose, never name prescription drugs, never promise an outcome. Suggest seeing a professional for anything that looks medical.',
    'SCANS:', data, 'CHANGE LOG:', log, 'QUESTION:', question
  ].join('\n');
}

async function askModel(brief, question) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 35000);
  try {
    const r = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai', messages: [{ role: 'user', content: promptFor(brief, question) }], max_tokens: 260 }),
      signal: ctl.signal
    });
    if (!r.ok) return null;
    const raw = await r.text();
    let text = raw;
    try {
      const j = JSON.parse(raw);
      text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    } catch (e) {}
    text = String(text).trim();
    if (!text || text.length < 12) return null;
    if (/reached its budget|not available/i.test(text.slice(0, 80))) return null;
    return text.slice(0, 1200);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function localAnswer(brief, question) {
  if (!brief.n) return 'There are no scans in the ledger yet. Run one first, then ask again.';
  return 'The language model is unreachable right now. The Compare panel shows the exact per-concern deltas, and any move under 3 points is noise.';
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
      if (raw.length > 12 * 1024 * 1024) return json(res, 413, { error: 'image too large (max 12MB)' });
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8')); } catch {}
      const image = String(payload.image || '');
      if (!image.startsWith('data:image/')) return json(res, 400, { error: 'image must be a data URL' });

      if (MOCK) return json(res, 200, mockAnalysis(image.slice(0, 400)));

      const header = image.slice(0, image.indexOf(','));
      const contentType = header.slice(5, header.indexOf(';')) || 'image/jpeg';
      const buffer = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
      const out = await liveAnalysis(buffer, contentType);
      return json(res, 200, out);
    }

    if (url.pathname.startsWith('/api/asset/')) {
      const parts = url.pathname.split('/');
      const id = parts[3] || '';
      const name = parts[4] || '';
      const files = ASSETS.get(id);
      if (!files || !files.has(name)) return json(res, 404, { error: 'asset not found' });
      const buf = files.get(name);
      const type = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600' });
      return res.end(buf);
    }

    // Ledger analyst. Only numbers travel: never the image.
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8')); } catch {}
      const question = String(payload.question || '').slice(0, 400).trim();
      if (!question) return json(res, 400, { error: 'question required' });
      const ledger = payload.ledger || {};
      const records = Array.isArray(ledger.records) ? ledger.records.slice(-12) : [];
      const changes = Array.isArray(ledger.changes) ? ledger.changes.slice(-12) : [];
      const brief = buildBrief(records, changes);
      let answer = null, engine = 'local';
      try {
        const out = await askModel(brief, question);
        if (out) { answer = out; engine = 'model'; }
      } catch (e) {}
      if (!answer) answer = localAnswer(brief, question);
      return json(res, 200, { answer, engine });
    }

    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(process.cwd(), p));
    if (!file.startsWith(process.cwd())) return json(res, 403, { error: 'forbidden' });
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch (e) {
    if (e && e.code) return json(res, 422, { error: e.code, message: 'the analysis service rejected the image' });
    json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('skin-ledger on http://127.0.0.1:' + PORT + ' (' + (MOCK ? 'mock' : 'live') + ')');
});
