const $ = (id) => document.getElementById(id);
const KEY_RECORDS = 'skinledger.records.v1';
const KEY_CHANGES = 'skinledger.changes.v1';

let records = load(KEY_RECORDS, []);
let changes = load(KEY_CHANGES, []);
let pending = null;

function load(k, fallback) {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
}
function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
const fmt = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pct = (n) => Math.round(n);

async function health() {
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    $('status').textContent = j.mode === 'live' ? 'YouCam API · live' : 'YouCam API · mock mode';
    $('status').style.color = j.mode === 'live' ? 'var(--accent)' : 'var(--warn)';
    if (j.mode === 'mock') $('hint').textContent = 'Running on deterministic mock scores — set YOUCAM_API_KEY to run live analysis.';
  } catch {
    $('status').textContent = 'API offline';
    $('status').style.color = 'var(--bad)';
  }
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('could not read file'));
    fr.readAsDataURL(file);
  });
}

$('drop').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  if (!f.type.startsWith('image/')) { $('hint').textContent = 'Pick an image file.'; return; }
  pending = await readFile(f);
  $('shot').src = pending;
  $('preview').hidden = false;
  $('drop').hidden = true;
  $('run').disabled = false;
  $('hint').textContent = '';
});

$('clear').addEventListener('click', () => {
  pending = null;
  $('preview').hidden = true;
  $('drop').hidden = false;
  $('run').disabled = true;
  $('file').value = '';
});

$('run').addEventListener('click', async () => {
  if (!pending) return;
  $('run').disabled = true;
  $('run').textContent = 'Analysing…';
  $('hint').textContent = 'Sending the image for analysis. This can take a few seconds.';
  try {
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: pending }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'analysis failed');
    const scores = {};
    for (const [k, v] of Object.entries(j.results || {})) {
      const n = Number(v?.score ?? v);
      if (Number.isFinite(n)) scores[k] = n;
    }
    if (!Object.keys(scores).length) throw new Error('no scores returned');
    const rec = { ts: Date.now(), scores, thumb: await thumbnail(pending), mock: !!j.mock };
    records.push(rec);
    save(KEY_RECORDS, records);
    render();
    $('hint').textContent = 'Record saved. Run another scan next week to see a real delta.';
  } catch (e) {
    $('hint').textContent = 'Could not finish: ' + e.message;
  } finally {
    $('run').disabled = false;
    $('run').textContent = 'Run dated scan';
  }
});

function thumbnail(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = 128;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

function render() {
  const today = records[records.length - 1];
  $('today').hidden = !today;
  $('historyCard').hidden = records.length === 0;
  if (today) {
    $('stamp').textContent = fmt(today.ts) + (today.mock ? ' · mock' : '');
    $('scores').innerHTML = Object.entries(today.scores)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<div class="score"><div class="k">${k.replace(/_/g, ' ')}</div><div class="v">${pct(v)}</div></div>`)
      .join('');
    const base = records[0];
    const rows = Object.keys(today.scores).map((k) => {
      const b = base.scores[k];
      if (!Number.isFinite(b)) return '';
      const d = today.scores[k] - b;
      const cls = Math.abs(d) < 3 ? 'flat' : d > 0 ? 'up' : 'down';
      const sign = d > 0 ? '+' : '';
      return `<div class="drow"><span>${k.replace(/_/g, ' ')}</span><span class="${cls}">${Math.abs(d) < 3 ? 'flat' : sign + pct(d)}</span></div>`;
    }).join('');
    $('delta').innerHTML = rows || '<p class="note">First record — this is your baseline.</p>';
  }
  renderChanges();
  renderHistory();
}

function renderChanges() {
  $('changes').innerHTML = changes.slice().reverse().map((c) => `<li>${fmt(c.ts)} — ${escapeHtml(c.what)}</li>`).join('');
}

function renderHistory() {
  const max = 100;
  $('history').innerHTML = records.slice().reverse().map((r) => {
    const avg = Object.values(r.scores).reduce((a, b) => a + b, 0) / Object.keys(r.scores).length;
    const bars = Object.values(r.scores).map((v) => `<div class="bar" style="height:${Math.max(4, (v / max) * 46)}px"></div>`).join('');
    return `<div class="hrow">
      <img src="${r.thumb || ''}" alt="" />
      <div><div>${fmt(r.ts)}</div><div class="meta">average ${pct(avg)} · ${Object.keys(r.scores).length} concerns${r.mock ? ' · mock' : ''}</div></div>
      <div class="bars">${bars}</div>
    </div>`;
  }).join('');
}

$('change').addEventListener('submit', (e) => {
  e.preventDefault();
  const what = $('what').value.trim();
  if (!what) return;
  changes.push({ ts: Date.now(), what });
  save(KEY_CHANGES, changes);
  $('what').value = '';
  renderChanges();
});

$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), records, changes }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'skin-ledger.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('reset').addEventListener('click', () => {
  if (!confirm('Clear all records on this device?')) return;
  records = []; changes = [];
  save(KEY_RECORDS, records); save(KEY_CHANGES, changes);
  render();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

health();
render();
