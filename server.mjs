import http from 'node:http';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Serve only from this folder, never from whatever directory the process was started in.
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STATIC_ALLOW = /^[a-z0-9][a-z0-9._-]*\.(html|js|css|json|svg|png|jpg|jpeg|webp|mp4|ico)$/i;

// Read a local .env when present so `npm start` behaves the same in every shell.
try {
  const text = await readFile(new URL('.env', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = Number(process.env.PORT || 4173);
const LAN = process.env.LAN === '1';
const MOCK = process.env.MOCK === '1' || !process.env.YOUCAM_API_KEY;
const KEY = process.env.YOUCAM_API_KEY || '';
const BASE = process.env.YOUCAM_BASE || 'https://yce-api-01.makeupar.com';
const ACTIONS = ['wrinkle', 'pore', 'texture', 'acne', 'oiliness', 'redness', 'radiance', 'moisture'];
const HD_ACTIONS = ['hd_wrinkle', 'hd_pore', 'hd_texture', 'hd_acne', 'hd_redness', 'hd_oiliness', 'hd_moisture', 'hd_radiance', 'hd_firmness', 'hd_dark_circle', 'hd_eye_bag', 'hd_tear_trough', 'hd_droopy_upper_eyelid', 'hd_droopy_lower_eyelid', 'hd_age_spot', 'hd_skin_type'];
// HD rejects anything under 2048px on the short side; the client upscales when we tell it to.
const HD_MIN_PX = 1080;
// HD lives on the 2.1 task path; SD stays on 2.0. Same body, different version.
const SD_TASK_PATH = '/s2s/v2.0/task/skin-analysis';
const HD_TASK_PATH = '/s2s/v2.1/task/skin-analysis';

const ASSETS = new Map();
const MAX_ASSETS = 24;
let inflight = false;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 12 * 1024 * 1024) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > limit) { const e = new Error('body too large'); e.status = 413; throw e; }
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limit) { const e = new Error('body too large'); e.status = 413; throw e; }
    chunks.push(c);
  }
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
  if (!r.ok) { const e = new Error('yce ' + r.status); e.yceStatus = r.status; e.yceBody = text.slice(0, 200); throw e; }
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

// Dimensions straight from the JPEG/PNG header: the repo stays dependency-free.
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      let marker = buf[i + 1];
      while (marker === 0xff) { i++; marker = buf[i + 1]; }
      if (marker === 0x01 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      if (marker === 0xda) return null;
      i += 2 + len;
    }
    return null;
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return null;
}

// HD returns one element per region; the app wants one number per concern plus the full map.
function parseHdOutput(output) {
  const regions = [];
  const maskByType = new Map();
  let skinType = null, skinAge = null, overall = null, imageUrl = null;
  for (const e of Array.isArray(output) ? output : []) {
    const type = String((e && e.type) || '');
    if (!type) continue;
    if (type === 'all') {
      const n = Number(e.score);
      if (Number.isFinite(n)) overall = Math.round(n * 100) / 100;
      continue;
    }
    if (type === 'skin_age') {
      const n = Number(e.score);
      if (Number.isFinite(n)) skinAge = Math.round(n);
      continue;
    }
    if (type === 'resize_image') {
      imageUrl = (Array.isArray(e.mask_urls) && e.mask_urls[0]) || e.url || null;
      continue;
    }
    if (type === 'hd_skin_type') {
      if (skinType === null && (e.region === 'whole' || !e.region) && e.skin_type) skinType = String(e.skin_type);
      continue;
    }
    const n = Number(e.ui_score ?? e.raw_score);
    if (!Number.isFinite(n)) continue;
    const name = type.replace(/^hd_/, '');
    const region = String(e.region || 'whole');
    const score = Math.round(n);
    regions.push({ type: name, region, score });
    const mask = (Array.isArray(e.mask_urls) && e.mask_urls[0]) || null;
    if (mask && (!maskByType.has(name) || region === 'whole')) maskByType.set(name, mask);
  }
  regions.sort((a, b) => a.type.localeCompare(b.type) || a.region.localeCompare(b.region));
  const results = {};
  for (const r of regions) if (results[r.type] === undefined) results[r.type] = r.score;
  for (const r of regions) if (r.region === 'whole') results[r.type] = r.score;
  return { results, regions, skin_type: skinType, skin_age: skinAge, overall, maskByType, imageUrl };
}

// HD masks and the resized photo are short-lived S3 URLs: pull them in so /api/asset can serve them.
async function storeHdAssets(parsed) {
  const files = new Map();
  const grab = (url, name) => fetch(url, { signal: AbortSignal.timeout(20000) })
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((b) => { if (b) files.set(name, Buffer.from(b)); })
    .catch(() => {});
  const jobs = [];
  for (const [name, url] of parsed.maskByType) jobs.push(grab(url, name + '_output.png'));
  if (parsed.imageUrl) jobs.push(grab(parsed.imageUrl, 'resize_image.jpg'));
  await Promise.all(jobs);
  const id = Math.random().toString(36).slice(2, 10);
  if (files.size) {
    ASSETS.set(id, files);
    if (ASSETS.size > MAX_ASSETS) ASSETS.delete(ASSETS.keys().next().value);
  }
  const masks = {};
  for (const name of parsed.maskByType.keys()) {
    if (files.has(name + '_output.png')) masks[name] = '/api/asset/' + id + '/' + name + '_output.png';
  }
  return { id: files.size ? id : null, image: files.has('resize_image.jpg') ? '/api/asset/' + id + '/resize_image.jpg' : null, masks };
}

async function analyseOnce(buffer, contentType, actions, taskPath, tier) {
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

  const body = { src_file_id: file.file_id, dst_actions: actions };
  // HD only returns the per-region array when asked for json; the default is a zip.
  if (tier === 'hd') body.format = 'json';
  const task = await yce(taskPath, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const taskId = task?.data?.task_id;
  if (!taskId) throw new Error('no task_id');

  let done = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await yce(taskPath + '/' + encodeURIComponent(taskId));
    const status = poll?.data?.task_status;
    if (status === 'success') { done = poll; break; }
    if (status === 'error') { const e = new Error('task failed'); e.code = poll?.data?.error || 'error_unknown'; throw e; }
  }
  if (!done) { const e = new Error('task timed out'); e.code = 'task_pending'; e.taskId = taskId; throw e; }
  return { done, taskId };
}

async function liveAnalysis(buffer, contentType, tier) {
  const actions = tier === 'hd' ? HD_ACTIONS : ACTIONS;
  const taskPath = tier === 'hd' ? HD_TASK_PATH : SD_TASK_PATH;
  let attempt = null;
  for (let i = 0; i < 2; i++) {
    try {
      attempt = await analyseOnce(buffer, contentType, actions, taskPath, tier);
      break;
    } catch (e) {
      // A failed S3 fetch is infrastructure, not the photo: retry exactly once.
      if (e.code === 'error_download_image' && i === 0) continue;
      throw e;
    }
  }
  const { done, taskId } = attempt;

  if (tier === 'hd') {
    const output = done?.data?.results?.output;
    if (!Array.isArray(output)) throw new Error('no output in results');
    const parsed = parseHdOutput(output);
    const assets = await storeHdAssets(parsed);
    return {
      results: parsed.results,
      regions: parsed.regions,
      skin_type: parsed.skin_type,
      skin_age: parsed.skin_age,
      overall: parsed.overall,
      tier: 'hd',
      mock: false,
      taskId,
      assets,
    };
  }

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
  return { results, regions: null, skin_type: null, skin_age: null, overall: null, tier: 'sd', mock: false, taskId, assets: { id, image, masks } };
}

// Deterministic mock so the demo is stable and the UI can be developed without a key.
function mockAnalysis(seed, tier) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 100000;
  const rnd = (i) => ((h >> i) % 37) / 37;
  if (tier === 'hd') {
    const names = HD_ACTIONS.map((a) => a.replace(/^hd_/, '')).filter((a) => a !== 'skin_type');
    const results = {};
    const regions = [];
    names.forEach((name, i) => {
      const score = Math.round(55 + rnd(i + 1) * 42);
      results[name] = score;
      regions.push({ type: name, region: 'whole', score });
      const extra = name === 'wrinkle' ? ['forehead', 'nasolabial'] : name === 'pore' ? ['forehead', 'nose', 'cheek'] : [];
      for (const region of extra) regions.push({ type: name, region, score: Math.max(20, score - Math.round(rnd(i + region.length) * 18)) });
    });
    regions.sort((a, b) => a.type.localeCompare(b.type) || a.region.localeCompare(b.region));
    const mean = names.reduce((sum, n) => sum + results[n], 0) / names.length;
    const types = ['Normal', 'Dry', 'Oily'];
    return {
      results,
      regions,
      skin_type: types[Math.floor(rnd(3) * 3) % 3],
      skin_age: 24 + Math.round(rnd(2) * 12),
      overall: Math.round(mean * 100) / 100,
      tier: 'hd',
      mock: true,
      taskId: 'mock-hd',
      assets: { id: null, image: null, masks: {} },
    };
  }
  const out = {};
  ACTIONS.forEach((a, i) => {
    const score = Math.round(52 + rnd(i + 1) * 40);
    out[a] = { score };
  });
  return { results: out, regions: null, skin_type: null, skin_age: null, overall: null, tier: 'sd', mock: true, taskId: 'mock', assets: null };
}

// Local calendar day. The UI prints day(ts) in the browser timezone, so UTC here
// made the model say 2026-10-25 while every date on screen read 10/26/2026.
function ymd(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function buildBrief(records, changes, factors) {
  const rows = records.map((r) => {
    const scores = Object.keys(r.scores || {}).map((k) => k + ' ' + Math.round(r.scores[k])).join(', ');
    return ymd(r.ts) + ': ' + scores;
  });
  const log = changes.map((c) => ymd(c.ts) + ': ' + c.what + (c.note ? ' [' + c.note + ']' : ''));
  const fac = (factors || []).map((f) => ymd(f.ts) + ': sleep ' + (Number.isFinite(f.sleep) ? f.sleep + 'h' : '-') + ', water ' + (Number.isFinite(f.water) ? f.water + ' glasses' : '-'));
  return { rows, log, fac, n: records.length };
}

function promptFor(brief, question) {
  const data = brief.rows.length ? brief.rows.join('\n') : 'No scans yet.';
  const log = brief.log.length ? brief.log.join('\n') : 'No changes logged.';
  const fac = brief.fac && brief.fac.length ? brief.fac.join('\n') : 'No daily factors logged.';
  return [
    'You are the analyst inside Skin Ledger, a personal skin-tracking app.',
    'You only see numbers the user already has: dated YouCam Skin AI scores from 0 to 100 where higher is better, and a log of routine changes.',
    'Rules:',
    '- Answer in at most 90 words, plain prose, no headings.',
    '- Use the actual numbers and dates. Today is ' + ymd(Date.now()) + '.',
    '- Numbers or percentages inside a product or routine name belong to the label. Never read them as a score, a delta, or a change.',
    '- Daily sleep and water entries are self-reported. Mention them only as associations, never as causes.',
    '- Only moves under 3 points are noise; never call a larger move noise. If there are fewer than 2 scans, say the data is too thin.',
    '- Never diagnose, never name prescription drugs, never promise an outcome. Suggest seeing a professional for anything that looks medical.',
    'SCANS:', data, 'CHANGE LOG:', log, 'DAILY FACTORS:', fac, 'QUESTION:', question
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
function localAnswer(records, changes) {
  if (!records.length) return 'There are no scans in the ledger yet. Run one first, then ask again.';
  if (records.length < 2) return 'There is one scan so far. A single score has nothing to compare against - run a second scan and ask again.';
  const prev = records[records.length - 2], last = records[records.length - 1];
  const moves = Object.keys(last.scores)
    .filter((k) => Number.isFinite(prev.scores[k]) && Number.isFinite(last.scores[k]))
    .map((k) => ({ k, d: Math.round(last.scores[k] - prev.scores[k]) }))
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  const top = moves.slice(0, 2).map((m) => m.k + ' ' + (m.d > 0 ? '+' : '') + m.d).join(' and ');
  const lastChange = changes.length ? changes[changes.length - 1].what : '';
  return 'The language model is unreachable, so this is the raw ledger: between your last two scans, ' + (top || 'nothing moved') +
    '. Anything under 3 points is noise.' + (lastChange ? ' The last change logged was "' + lastChange + '".' : '');
}

/* ---------- label reading: cloud OCR, then a model that writes the composition ---------- */
const OCR_KEY = process.env.OCR_SPACE_KEY || 'helloworld';
const LABEL_LIMIT = 1.4 * 1024 * 1024; // the free reader key takes files up to 1 MB; leave headroom for the JSON body
const TICK = String.fromCharCode(96);

async function readLabelText(buffer, contentType) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: contentType }), 'label.jpg');
  fd.append('language', 'eng');
  fd.append('OCREngine', '2');
  fd.append('scale', 'true');
  fd.append('isOverlayRequired', 'false');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch('https://api.ocr.space/parse/image', { method: 'POST', headers: { apikey: OCR_KEY }, body: fd, signal: ctl.signal });
    const raw = await r.text();
    let j = null;
    try { j = JSON.parse(raw); } catch {}
    if (!j) throw new Error('the reader answered ' + r.status + ' without JSON');
    if (j.IsErroredOnProcessing) {
      const msg = [].concat(j.ErrorMessage || []).join(' ').trim();
      throw new Error(msg || 'the reader could not open that photo');
    }
    return (j.ParsedResults || []).map((x) => x.ParsedText || '').join('\n').trim();
  } finally {
    clearTimeout(timer);
  }
}

const LABEL_RULES = [
  'You read skincare labels from OCR text. OCR mangles INCI names.',
  'Return ONLY minified JSON, one object, no prose:',
  '{"product":"brand plus product name, or null","fixes":{"damaged name":"real INCI name"},"summary":"one line under 90 characters"}',
  'Rules:',
  '- fixes holds ONLY names the OCR damaged, at most 6 entries: Tocophery -> Tocopherol, Methoxycinnamse -> Ethylhexyl Methoxycinnamate.',
  '- Never list a name that is already correct.',
  '- summary names the 2-3 most notable actives and nothing else.',
  '- If the text is not a label at all, return {"product":null,"fixes":{},"summary":""}.',
].join('\n');

function looseJson(text) {
  let t = String(text || '').trim();
  t = t.split(TICK).join('').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const JUNK = /\b(apply|apply to|use |warning|avoid|keep out|store|directions|caution|for external|patch test|www\.|http|made in|distributed|net wt|ml\b|fl oz)\b/i;

// The OCR already returns the printed list. Splitting it here is instant and complete,
// so the model is only asked to fix names and title the product.
// Local spelling repair. The model does this well but is not always reachable,
// and a garbled INCI name in the log is worse than a slow one.
const INCI_DICT = ["Aqua","Water","Glycerin","Niacinamide","Panthenol","Sodium Hyaluronate","Hyaluronic Acid","Butylene Glycol","Propanediol","Betaine","Allantoin","Bisabolol","Madecassoside","Asiaticoside","Centella Asiatica Extract","Camellia Sinensis Leaf Extract","Tocopherol","Tocopheryl Acetate","Squalane","Ceramide NP","Phytosphingosine","Cholesterol","Adenosine","Caffeine","Urea","Lactic Acid","Citric Acid","Sodium Citrate","Xanthan Gum","Carbomer","Polysorbate 20","Phenoxyethanol","Ethylhexylglycerin","Disodium EDTA","Parfum","Fragrance","Cocamidopropyl Betaine","Sodium Lauroyl Methyl Isethionate","Salicylic Acid","Melaleuca Alternifolia Leaf Oil","Octyl Methoxycinnamate","Ethylhexyl Methoxycinnamate","Avobenzone","Octocrylene","Titanium Dioxide","Zinc Oxide","Azelaic Acid","Glycolic Acid","Tranexamic Acid","Arbutin","Stearic Acid","Propylparaben","Methylparaben","Dimethicone","Caprylyl Glycol","Sodium Benzoate","Potassium Sorbate","Limonene","Linalool","Citronellol","Geraniol","Aloe Barbadensis Leaf Juice","Hamamelis Virginiana Extract","Rosmarinus Officinalis Leaf Extract","Chamomilla Recutita Flower Extract","Lavandula Angustifolia Oil","Sodium Chloride","Magnesium Sulfate","Cetearyl Alcohol","Cetyl Alcohol","Stearyl Alcohol","Glyceryl Stearate","Sorbitan Olivate","Cetearyl Olivate","Caprylic/Capric Triglyceride","Simmondsia Chinensis Seed Oil","Argania Spinosa Kernel Oil","Rosa Canina Fruit Oil","Vitis Vinifera Seed Oil","Helianthus Annuus Seed Oil","Butyrospermum Parkii Butter","Ascorbic Acid","Ascorbyl Glucoside","Ferulic Acid","Resveratrol","Ubiquinone","Trehalose","Sorbitol","Serine","Glycine","Arginine","Proline","Ectoin","Dipotassium Glycyrrhizate","Glycyrrhiza Glabra Root Extract","Zinc PCA","Palmitoyl Tripeptide-1","Acetyl Hexapeptide-8","Hydroxyethylcellulose","Sodium Hydroxide","BHT","EDTA"];
const INCI_CANON = (() => {
  const map = new Map();
  INCI_DICT.forEach((n) => n.split(/[^A-Za-z0-9]+/).forEach((w) => {
    if (w.length >= 4 && !map.has(w.toLowerCase())) map.set(w.toLowerCase(), w);
  }));
  return map;
})();
const INCI_WORDS = Array.from(INCI_CANON.keys());

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function repairName(name) {
  return String(name).split(/(\s+)/).map((w) => {
    const low = w.toLowerCase();
    if (low.length < 6 || !/^[a-z]+$/.test(low)) return w;
    if (INCI_CANON.has(low)) return INCI_CANON.get(low);
    let best = null, bestD = 99, tie = false;
    for (const cand of INCI_WORDS) {
      if (Math.abs(cand.length - low.length) > 2) continue;
      const d = editDistance(low, cand);
      if (d < bestD) { bestD = d; best = cand; tie = false; }
      else if (d === bestD) tie = true;
    }
    const limit = low.length >= 9 ? 2 : 1;
    if (!best || tie || bestD > limit) return w;
    return INCI_CANON.get(best) || best;
  }).join('');
}

function parseIngredients(text) {
  const lines = String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { product: null, ingredients: [] };
  const commas = (l) => (l.match(/,/g) || []).length;
  let best = -1;
  lines.forEach((l, i) => { if (commas(l) >= 3 && (best < 0 || commas(l) > commas(lines[best]))) best = i; });
  if (best < 0) return { product: lines[0].slice(0, 80), ingredients: [] };
  let list = lines[best];
  // A printed list often wraps: keep pulling the next line while it still looks like one.
  for (let i = best + 1; i < lines.length && commas(list) < 40; i++) {
    const nxt = lines[i];
    if (JUNK.test(nxt)) break;
    // A wrap can land mid-name ("Xanthan" / "Gum"), so keep the original commas and join with a space.
    if (commas(nxt) >= 2 || /^[A-Za-z][A-Za-z0-9 ().%+-]{2,40}$/.test(nxt)) list += ' ' + nxt;
    else break;
  }
  const HEAD = /^(ingredients?|composition|ingr[\u00e9e]dients?|bahan|komposisi)\b/i;
  const before = lines.slice(0, best).filter((l) => l.length >= 3 && l.length <= 80 && !JUNK.test(l) && !HEAD.test(l));
  let product = before.length ? before[before.length - 1] : null;
  // A brand line in caps sits right above the product name; keep both.
  const brand = before.length > 1 ? before[before.length - 2] : null;
  if (product && brand && brand.length <= 24 && brand === brand.toUpperCase() && product !== product.toUpperCase()) product = brand + ' ' + product;
  const ingredients = list
    .replace(/^[^:]{0,30}:\s*/, '')
    .split(',')
    .map((x) => x.replace(/\s+/g, ' ').replace(/[.;]+$/, '').trim())
    .filter((x) => x.length >= 3 && x.length <= 70 && !JUNK.test(x) && /[A-Za-z]/.test(x))
    .slice(0, 40)
    .map((x) => {
      const m = x.match(/^(.*?)\s+(\d+(?:\.\d+)?)\s*%$/);
      return m ? { name: repairName(m[1].trim()), pct: Number(m[2]) } : { name: repairName(x), pct: null };
    });
  return { product, ingredients };
}

async function callModel(text, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai', messages: [{ role: 'user', content: LABEL_RULES + '\n\nLABEL TEXT:\n' + text.slice(0, 2200) }], max_tokens: 240 }),
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const raw = await r.text();
    let content = raw;
    try { const j = JSON.parse(raw); content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''; } catch {}
    const obj = looseJson(content);
    if (!obj || typeof obj !== 'object') return null;
    const fixes = {};
    Object.keys(obj.fixes || {}).slice(0, 8).forEach((k) => {
      const v = String(obj.fixes[k] || '').slice(0, 60);
      if (k && v) fixes[String(k).slice(0, 60)] = v;
    });
    return {
      product: obj.product ? String(obj.product).slice(0, 80) : null,
      fixes,
      summary: obj.summary ? String(obj.summary).slice(0, 120) : '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// One quick try, then one retry. If both miss, the caller still has the full local list.
async function enrichLabel(text) {
  return (await callModel(text, 7000)) || (await callModel(text, 7000));
}

const server = http.createServer(async (req, res) => {
  // The catch below is outside the route blocks, so remember the tier here.
  let tierHint = 'sd';
  try {
    const url = new URL(req.url, 'http://localhost');
    // Local-only: reject DNS-rebinding attempts that reach us under another name.
    const hostHeader = String(req.headers.host || '');
    const lanHost = LAN && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]+:\d+$/.test(hostHeader);
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(hostHeader) && !lanHost) return json(res, 403, { error: 'forbidden host' });

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, mode: MOCK ? 'mock' : 'live', actions: ACTIONS, tiers: ['sd', 'hd'] });
    }

    // Accepts a base64 data URL, returns normalised scores. /api/analyse is the same endpoint under its British spelling.
    if ((url.pathname === '/api/analyze' || url.pathname === '/api/analyse') && req.method === 'POST') {
      const raw = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8')); } catch {}
      const image = String(payload.image || '');
      if (!image.startsWith('data:image/')) return json(res, 400, { error: 'image must be a data URL' });
      const tier = payload.tier === 'hd' ? 'hd' : 'sd';
      tierHint = tier;

      // The first 400 base64 chars are only the JPEG header, so two different faces
      // used to score identically. Seed on the whole payload instead.
      if (MOCK) return json(res, 200, mockAnalysis(image.slice(0, 400) + image.slice(-400) + image.length + tier, tier));

      const header = image.slice(0, image.indexOf(','));
      const contentType = header.slice(5, header.indexOf(';')) || 'image/jpeg';
      const buffer = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');

      if (tier === 'hd') {
        const cropPx = Number(payload.cropPx || 0);
        if (cropPx && cropPx < 900) return json(res, 422, { error: 'image_too_small_hd', message: 'This crop carries only ' + Math.round(cropPx) + 'px of real detail. Use a larger photo or zoom out, then run again.', minSize: 1080 });
        const dim = imageSize(buffer);
        if (dim && Math.min(dim.width, dim.height) < HD_MIN_PX) {
          return json(res, 422, {
            error: 'image_too_small_hd',
            message: 'HD Skin AI needs at least ' + HD_MIN_PX + 'px on the short side. This photo is ' + dim.width + 'x' + dim.height + '. Upscale it and try again.',
            width: dim.width,
            height: dim.height,
            minSize: 1080,
          });
        }
      }

      if (inflight) return json(res, 429, { error: 'busy', message: 'An analysis is already running. Wait for it to finish before starting another one.' });
      let out;
      inflight = true;
      try { out = await liveAnalysis(buffer, contentType, tier); } finally { inflight = false; }
      return json(res, 200, out);
    }

    // Label reader: photo in, ingredient list out. Nothing is stored on this machine.
    if (url.pathname === '/api/label' && req.method === 'POST') {
      const raw = await readBody(req, 8 * 1024 * 1024);
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8')); } catch {}
      const image = String(payload.image || '');
      if (!image.startsWith('data:image/')) return json(res, 400, { error: 'image must be a data URL' });
      const header = image.slice(0, image.indexOf(','));
      const contentType = header.slice(5, header.indexOf(';')) || 'image/jpeg';
      const buffer = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
      if (buffer.length > LABEL_LIMIT) {
        return json(res, 413, { error: 'photo_too_large', message: 'That photo is ' + Math.round(buffer.length / 1024) + ' KB and the reader takes up to 1.4 MB. Step back a little and try again.' });
      }
      const t0 = Date.now();
      let text = '';
      try {
        text = await readLabelText(buffer, contentType);
      } catch (e) {
        console.error('label reader: ' + String((e && e.message) || e).slice(0, 200));
        return json(res, 502, { error: 'ocr_failed', message: 'The label reader could not open that photo. Fill the frame with the ingredient list and try again.' });
      }
      if (!text) return json(res, 200, { text: '', parsed: null, engine: 'local', ms: Date.now() - t0, message: 'No text was read. Fill the frame with the ingredient list and try again.' });
      const local = parseIngredients(text);
      return json(res, 200, { text, parsed: { product: local.product, ingredients: local.ingredients, summary: '' }, engine: 'local', ms: Date.now() - t0 });
    }

    // Optional polish: title, typo repairs, one-line summary. The client never waits for this.
    if (url.pathname === '/api/label/enrich' && req.method === 'POST') {
      const raw = await readBody(req, 64 * 1024);
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8')); } catch {}
      const text = String(payload.text || '').slice(0, 2200);
      if (!text) return json(res, 400, { error: 'text required' });
      const t0 = Date.now();
      const out = await enrichLabel(text);
      return json(res, 200, { ok: !!out, enrich: out, ms: Date.now() - t0 });
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
      const raw = await readBody(req, 64 * 1024);
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8')); } catch {}
      const question = String(payload.question || '').slice(0, 400).trim();
      if (!question) return json(res, 400, { error: 'question required' });
      const ledger = payload.ledger || {};
      const records = Array.isArray(ledger.records) ? ledger.records.slice(-12) : [];
      const changes = Array.isArray(ledger.changes) ? ledger.changes.slice(-12) : [];
      const factors = Array.isArray(ledger.factors) ? ledger.factors.slice(-8) : [];
      const brief = buildBrief(records, changes, factors);
      let answer = null, engine = 'local';
      try {
        const out = await askModel(brief, question);
        if (out) { answer = out; engine = 'model'; }
      } catch (e) {}
      if (!answer) answer = localAnswer(records, changes);
      return json(res, 200, { answer, engine });
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    if (!STATIC_ALLOW.test(rel) || rel === 'server.mjs') return json(res, 404, { error: 'not found' });
    const file = resolve(ROOT, rel);
    const inside = relative(ROOT, file);
    if (!inside || inside.startsWith('..')) return json(res, 404, { error: 'not found' });
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch (e) {
    if (e && e.status === 413) return json(res, 413, { error: 'request_too_large', message: 'That upload is larger than 12MB.' });
    if (e && e.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    if (e && e.code === 'task_pending') return json(res, 504, { error: 'task_pending', taskId: e.taskId || null, message: 'The analysis is still running upstream. Wait a minute before scanning again; a second scan costs another ' + (tierHint === 'hd' ? 22 : 12) + ' units.' });
    if (e && e.code === 'error_below_min_image_size') {
      const min = tierHint === 'hd' ? HD_MIN_PX : 480;
      return json(res, 422, {
        error: 'image_too_small',
        message: (tierHint === 'hd' ? 'HD' : 'Standard') + ' Skin AI needs at least ' + min + 'px on the short side. Upscale the photo and try again.',
        minSize: min,
      });
    }
    if (e && e.yceStatus) {
      console.error('yce ' + e.yceStatus + ' ' + String(e.yceBody || '').slice(0, 120));
      return json(res, 502, { error: 'upstream_error', retryable: e.yceStatus >= 500 });
    }
    if (e && typeof e.code === 'string' && e.code.startsWith('error_')) return json(res, 422, { error: e.code, message: 'the analysis service rejected the image' });
    console.error(String((e && e.stack) || e).slice(0, 300));
    json(res, 500, { error: 'analysis failed' });
  }
});

server.on('error', (e) => {
  console.error(e && e.code === 'EADDRINUSE' ? 'port ' + PORT + ' is already in use - stop the other instance first.' : String((e && e.message) || e));
  process.exit(1);
});
server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  console.log('skin-ledger on http://' + (LAN ? '0.0.0.0' : '127.0.0.1') + ':' + PORT + ' (' + (MOCK ? 'mock' : 'live') + (LAN ? ', LAN' : '') + ')');
});
