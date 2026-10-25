import http from 'node:http';
import zlib from 'node:zlib';
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

async function liveAnalysis(buffer, contentType) {
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
    if (status === 'error') throw new Error('task failed: ' + (poll?.data?.error || 'unknown'));
  }
  if (!done) throw new Error('task timed out');

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
  return { results, mock: false, taskId };
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

    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(process.cwd(), p));
    if (!file.startsWith(process.cwd())) return json(res, 403, { error: 'forbidden' });
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch (e) {
    json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('skin-ledger on http://127.0.0.1:' + PORT + ' (' + (MOCK ? 'mock' : 'live') + ')');
});
