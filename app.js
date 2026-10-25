const $ = (id) => document.getElementById(id);
const KEY_RECORDS = 'skinledger.records.v4';
const KEY_CHANGES = 'skinledger.changes.v4';
const KEY_FACTORS = 'skinledger.factors.v1';
const KEY_THEME = 'skinledger.theme';
const STAGE = 440, OUT = 1024;

const stage = $('stage'), shot = $('shot'), guide = $('guide'), empty = $('empty');
const zoomEl = $('zoom'), zoomOut = $('zoomOut'), hint = $('hint');
const veil = $('veil'), veilText = $('veilText'), progress = $('progress');
const progressStage = $('progressStage'), progressTime = $('progressTime');
const cam = $('cam'), camVideo = $('camVideo'), ghost = $('ghost');

let records = load(KEY_RECORDS, []);
let changes = load(KEY_CHANGES, []);
let factors = load(KEY_FACTORS, []);
let queue = [], zoom = 1, pan = { x: 0, y: 0 }, loaded = false;
let baselineIdx = 0, autoReframed = false, busy = false, camStream = null, qTimer = null;
let activeMask = null;

function load(k, f) { try { return JSON.parse(localStorage.getItem(k)) || f; } catch (e) { return f; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
function saveRecords() {
  if (save(KEY_RECORDS, records)) return;
  for (let i = 0; i < records.length - 1; i++) delete records[i].img;
  save(KEY_RECORDS, records);
}
const fmt = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const day = (ts) => new Date(ts).toLocaleDateString();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pretty = (k) => k.replace(/_/g, ' ');
const uid = () => Math.random().toString(36).slice(2, 9);
function say(t, k) { hint.textContent = t || ''; hint.className = 'hint' + (k ? ' ' + k : ''); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* theme */
function paintTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === mode)));
}
document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => {
  const m = b.getAttribute('data-theme-set');
  try { localStorage.setItem(KEY_THEME, m); } catch (e) {}
  paintTheme(m);
}));
paintTheme(document.documentElement.getAttribute('data-theme') || 'system');

/* api */
async function health() {
  try {
    const j = await (await fetch('/api/health')).json();
    $('status').textContent = j.mode === 'live' ? 'API live' : 'API mock';
    $('status').style.color = j.mode === 'live' ? 'var(--accent)' : 'var(--warn)';
  } catch (e) { $('status').textContent = 'API offline'; $('status').style.color = 'var(--bad)'; }
}

const ERROR_TEXT = {
  error_src_face_too_small: 'Your face fills too little of the frame. Zoom in until your face fills the dashed circle.',
  error_large_face_angle: 'Your head is turned or tilted too far. Face the camera straight on and try again.',
  error_below_min_image_size: 'That photo is too small to analyse. Use a larger image.',
  error_face_not_found: 'No face found in that photo. Try a clear, front-facing shot.',
  error_download_image: 'The upload did not reach the analysis service. Try again.'
};
const humanError = (c) => ERROR_TEXT[c] || 'The analysis service rejected that photo. Try a straight-on, well-lit shot with your face filling the circle.';

/* framing */
const baseScale = () => Math.max(STAGE / shot.naturalWidth, STAGE / shot.naturalHeight);
function layout() {
  if (!loaded) return;
  const s = baseScale() * zoom, dw = shot.naturalWidth * s, dh = shot.naturalHeight * s;
  const maxX = Math.max(0, (dw - STAGE) / 2), maxY = Math.max(0, (dh - STAGE) / 2);
  pan.x = clamp(pan.x, -maxX, maxX); pan.y = clamp(pan.y, -maxY, maxY);
  shot.style.width = dw + 'px'; shot.style.height = dh + 'px';
  shot.style.left = (STAGE / 2 + pan.x - dw / 2) + 'px';
  shot.style.top = (STAGE / 2 + pan.y - dh / 2) + 'px';
  zoomOut.textContent = zoom.toFixed(2) + '\u00d7';
}
function cropDataUrl() {
  const s = baseScale() * zoom, dw = shot.naturalWidth * s, dh = shot.naturalHeight * s;
  const left = STAGE / 2 + pan.x - dw / 2, top = STAGE / 2 + pan.y - dh / 2, sw = STAGE / s;
  const c = document.createElement('canvas'); c.width = OUT; c.height = OUT;
  c.getContext('2d').drawImage(shot, -left / s, -top / s, sw, sw, 0, 0, OUT, OUT);
  return c.toDataURL('image/jpeg', 0.92);
}
function loadImage(url) {
  return new Promise((res, rej) => {
    shot.onload = () => {
      loaded = true; autoReframed = false;
      shot.hidden = false; guide.hidden = false; empty.hidden = true;
      zoom = 1; pan = { x: 0, y: 0 }; zoomEl.value = 100; zoomEl.disabled = false;
      $('run').disabled = false; layout(); res();
    };
    shot.onerror = () => rej(new Error('That file could not be read as an image.'));
    shot.src = url;
  });
}
function readFile(f) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error('could not read file'));
    fr.readAsDataURL(f);
  });
}
function downscale(url, size) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = size; c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      res(c.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = () => res('');
    img.src = url;
  });
}

/* intake */
async function takeFiles(list) {
  const files = Array.prototype.slice.call(list || []);
  const added = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try { added.push({ id: uid(), name: f.name || 'photo', dataUrl: await readFile(f), status: 'pending', error: '', scores: null }); } catch (e) {}
  }
  if (!added.length) { say('None of those files were images.', 'error'); return; }
  queue = queue.concat(added);
  renderQueue();
  if (queue.length === 1) { await loadImage(added[0].dataUrl); say('Framed. Drag to move, scroll or slide to zoom, then run the scan.'); }
  else say(added.length + ' photo' + (added.length > 1 ? 's' : '') + ' queued. Press Scan queue to run them one by one.');
}
$('pick').addEventListener('click', () => $('file').click());
empty.addEventListener('click', () => $('file').click());
stage.addEventListener('click', () => { if (!loaded) $('file').click(); });
$('file').addEventListener('change', async (e) => { await takeFiles(e.target.files); e.target.value = ''; });
zoomEl.addEventListener('input', () => { zoom = Number(zoomEl.value) / 100; layout(); });
stage.addEventListener('wheel', (e) => {
  if (!loaded || busy) return;
  e.preventDefault();
  zoom = clamp(zoom + (e.deltaY > 0 ? -0.08 : 0.08), 1, 3.2);
  zoomEl.value = String(Math.round(zoom * 100)); layout();
}, { passive: false });
let drag = null;
stage.addEventListener('pointerdown', (e) => {
  if (!loaded || busy) return;
  drag = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  stage.classList.add('dragging');
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  pan.x = drag.px + (e.clientX - drag.x); pan.y = drag.py + (e.clientY - drag.y); layout();
});
const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

/* camera */
const KEY_GHOST = 'skinledger.ghostalpha';
function ghostBaseline() {
  for (let i = records.length - 1; i >= 0; i--) if (records[i] && records[i].img) return records[i];
  return null;
}
function paintGhost() {
  const alpha = clamp(Number($('ghostAlpha').value) || 0, 0, 60) / 100;
  ghost.style.opacity = String(alpha);
  ghost.classList.toggle('off', $('ghostToggle').getAttribute('aria-pressed') !== 'true');
}
function setupGhost() {
  const base = ghostBaseline();
  if (!base) {
    $('camGhost').hidden = true;
    ghost.hidden = true;
    say('No baseline photo yet - this first capture becomes your baseline.');
    return;
  }
  let saved = 30;
  try {
    const raw = localStorage.getItem(KEY_GHOST);
    const v = raw === null ? NaN : Number(raw);
    if (Number.isFinite(v) && v >= 0) saved = v;
  } catch (e) {}
  $('ghostAlpha').value = String(saved);
  $('ghostMeta').textContent = 'baseline ' + day(base.ts);
  $('camGhost').hidden = false;
  ghost.src = base.img;
  ghost.hidden = false;
  paintGhost();
}
function stopCam() {
  if (qTimer) clearInterval(qTimer);
  qTimer = null;
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  camVideo.srcObject = null;
  cam.hidden = true;
  ghost.hidden = true;
  empty.hidden = loaded;
}
async function openCam() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say('This browser has no camera API.', 'error'); return; }
  cam.hidden = false;
  empty.hidden = true;
  try { stage.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { stage.scrollIntoView(); }
  setupGhost();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
    camVideo.srcObject = camStream;
    await camVideo.play().catch(() => {});
    qTimer = setInterval(checkQuality, 450);
  } catch (e) {
    say('Camera unavailable: ' + (e.message || e.name) + '. Use Choose photo instead.', 'error');
    stopCam();
  }
}
function checkQuality() {
  if (!camVideo.videoWidth) return;
  const w = 72, h = 72;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(camVideo, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let lum = 0, skin = 0, edge = 0, n = 0;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = y; lum += y; n++;
    const cx = i % w, cy = (i / w) | 0;
    const inOval = Math.pow((cx - w / 2) / (w * 0.34), 2) + Math.pow((cy - h / 2) / (h * 0.42), 2) < 1;
    if (inOval && r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 12) skin++;
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    edge += Math.abs(4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]);
  }
  lum = lum / n; const sharp = edge / (n * 40); const skinRatio = skin / n;
  const lightOk = lum > 55 && lum < 205;
  const focusOk = sharp > 1.6;
  const frameOk = skinRatio > 0.18;
  setBadge('light', lightOk, lum < 55 ? 'too dark' : lum > 205 ? 'too bright' : 'light ok');
  setBadge('focus', focusOk, focusOk ? 'focus ok' : 'blurry');
  setBadge('frame', frameOk, frameOk ? 'face in frame' : 'move closer');
  $('camShot').disabled = !(lightOk && frameOk);
}
function setBadge(k, ok, text) {
  const el = document.querySelector('[data-b="' + k + '"]');
  if (!el) return;
  el.textContent = text;
  el.className = ok ? 'ok' : 'warn';
}
$('camOpen').addEventListener('click', openCam);
$('ghostToggle').addEventListener('click', () => {
  const b = $('ghostToggle');
  b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  paintGhost();
});
$('ghostAlpha').addEventListener('input', () => {
  try { localStorage.setItem(KEY_GHOST, $('ghostAlpha').value); } catch (e) {}
  paintGhost();
});
$('camClose').addEventListener('click', stopCam);
$('camShot').addEventListener('click', async () => {
  if (!camVideo.videoWidth) return;
  const size = Math.min(camVideo.videoWidth, camVideo.videoHeight);
  const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
  const sx = (camVideo.videoWidth - size) / 2, sy = (camVideo.videoHeight - size) / 2;
  c.getContext('2d').drawImage(camVideo, sx, sy, size, size, 0, 0, 1024, 1024);
  const url = c.toDataURL('image/jpeg', 0.92);
  stopCam();
  queue.push({ id: uid(), name: 'camera capture', dataUrl: url, status: 'pending', error: '', scores: null });
  renderQueue();
  await loadImage(url);
  say('Captured. Adjust the zoom, then run the scan.');
});

/* progress */
let ticker = null;
function startProgress(label) {
  progress.hidden = false; progress.classList.add('indet'); veil.hidden = false;
  veilText.textContent = label || 'Reading your skin';
  const t0 = Date.now();
  progressStage.textContent = label || 'Analysing'; progressTime.textContent = '0.0s';
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    progressTime.textContent = s.toFixed(1) + 's';
    if (s > 6 && !label) progressStage.textContent = 'Still working';
    if (s > 14 && !label) progressStage.textContent = 'Slow response from the API';
  }, 100);
}
function stopProgress() {
  if (ticker) clearInterval(ticker);
  ticker = null; progress.hidden = true; progress.classList.remove('indet'); veil.hidden = true;
}

/* analysis */
async function post(image) {
  const r = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image }) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, body: j };
}
async function analyseFramed(label) {
  startProgress(label);
  let res = await post(cropDataUrl());
  if (!res.ok && res.body && res.body.error === 'error_src_face_too_small' && !autoReframed) {
    autoReframed = true;
    progressStage.textContent = 'Reframing';
    zoom = clamp(zoom * 1.3, 1, 3.2); zoomEl.value = String(Math.round(zoom * 100)); layout();
    await new Promise((r) => setTimeout(r, 350));
    res = await post(cropDataUrl());
  }
  if (!res.ok) { const e = new Error(humanError(res.body && res.body.error)); e.code = res.body && res.body.error; throw e; }
  const scores = {};
  Object.keys(res.body.results || {}).forEach((k) => {
    const v = res.body.results[k];
    const n = Number(v && v.score !== undefined ? v.score : v);
    if (Number.isFinite(n)) scores[k] = n;
  });
  if (!Object.keys(scores).length) throw new Error('The API returned no scores.');
  return { scores, mock: !!res.body.mock, assets: res.body.assets || null };
}
async function commit(scores, mock, framed, assets) {
  records.push({ ts: Date.now(), scores, thumb: await downscale(framed, 96), img: await downscale(framed, 512), assets, mock });
  saveRecords();
  baselineIdx = 0;
  render();
}
$('run').addEventListener('click', async () => {
  if (!loaded || busy) return;
  busy = true; const btn = $('run'); btn.disabled = true; btn.textContent = 'Scanning';
  say('Sending the framed square to YouCam Skin AI.');
  try {
    const framed = cropDataUrl();
    const out = await analyseFramed();
    await commit(out.scores, out.mock, framed, out.assets);
    say(autoReframed ? 'Face was too small, so I zoomed in and retried. Saved.' : 'Saved. Run another scan after you change something to get a real delta.', 'good');
    $('today').scrollIntoView({ block: 'start' });
  } catch (e) { say(e.message, 'error'); }
  finally { stopProgress(); busy = false; btn.disabled = false; btn.textContent = 'Run scan'; }
});

/* queue */
async function runQueue() {
  if (busy) return;
  const pending = queue.filter((q) => q.status === 'pending');
  if (!pending.length) { say('Nothing pending in the queue.', 'error'); return; }
  busy = true; $('queueRun').disabled = true; $('pick').disabled = true; $('run').disabled = true;
  let done = 0, failed = 0;
  try {
    for (const item of queue) {
      if (item.status !== 'pending') continue;
      item.status = 'running'; renderQueue();
      const label = 'Photo ' + (done + failed + 1) + ' of ' + pending.length;
      try {
        await loadImage(item.dataUrl);
        const framed = cropDataUrl();
        const out = await analyseFramed(label);
        await commit(out.scores, out.mock, framed, out.assets);
        item.status = 'done'; item.scores = out.scores; done++;
      } catch (e) { item.status = 'error'; item.error = e.message; failed++; }
      stopProgress(); renderQueue(); render();
    }
  } finally {
    stopProgress(); busy = false; $('queueRun').disabled = false; $('pick').disabled = false; $('run').disabled = false;
    say(done + ' scanned' + (failed ? ', ' + failed + ' rejected' : '') + '.', failed ? 'error' : 'good');
  }
}
function renderQueue() {
  $('queueCard').hidden = queue.length === 0;
  const pending = queue.filter((q) => q.status === 'pending').length;
  const done = queue.filter((q) => q.status === 'done').length;
  $('queueCount').textContent = queue.length + ' in queue \u00b7 ' + done + ' done \u00b7 ' + pending + ' pending';
  $('queueRun').disabled = pending === 0 || busy;
  $('queueRun').textContent = pending > 1 ? 'Scan ' + pending + ' photos' : 'Scan queue';
  $('queue').innerHTML = queue.map((q, i) => {
    const st = q.status === 'done' ? '<span class="qstatus ok">8 scores</span>'
      : q.status === 'error' ? '<span class="qstatus bad">rejected</span>'
      : q.status === 'running' ? '<span class="qstatus run">scanning</span>' : '<span class="qstatus">pending</span>';
    const detail = q.status === 'error' ? '<span class="qerr">' + escapeHtml(q.error) + '</span>'
      : q.status === 'done' ? '<span class="qerr">' + Object.keys(q.scores).length + ' concerns</span>'
      : '<span class="qerr">' + escapeHtml(q.name) + '</span>';
    return '<div class="qrow"><img src="' + q.dataUrl + '" alt="" /><span class="qname">' + escapeHtml(q.name) + '</span>' + detail + st +
      '<button type="button" class="qdrop" data-drop="' + i + '" aria-label="Remove">&times;</button></div>';
  }).join('');
  document.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', () => {
    queue.splice(Number(b.getAttribute('data-drop')), 1); renderQueue();
  }));
}
$('queueRun').addEventListener('click', runQueue);
$('queueClear').addEventListener('click', () => { queue = []; renderQueue(); });

const maskCache = {};
async function colorizeMask(url) {
  if (maskCache[url]) return maskCache[url];
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("mask load failed"));
    i.src = url;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const y = (p[i] + p[i + 1] + p[i + 2]) / 3;
    const a = Math.min(255, Math.round(y * 3.2));
    const t = Math.min(1, y / 150);
    p[i] = 255;
    p[i + 1] = Math.round(186 - 130 * t);
    p[i + 2] = Math.round(40 - 14 * t);
    p[i + 3] = a;
  }
  ctx.putImageData(d, 0, 0);
  const out = c.toDataURL("image/png");
  maskCache[url] = out;
  return out;
}

/* render */
function spark(vals) {
  if (vals.length < 2) return '';
  const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), span = Math.max(1, max - min);
  const pts = vals.map((v, i) => ((i / (vals.length - 1)) * 100).toFixed(1) + ',' + (18 - ((v - min) / span) * 16).toFixed(1)).join(' ');
  return '<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none"><polyline points="' + pts + '"/></svg>';
}
function render() {
  const last = records[records.length - 1];
  $('today').hidden = !last;
  $('split').hidden = records.length === 0;
  $('mapCard').hidden = !(last && last.assets);
  $('baCard').hidden = records.length < 2 || !records[0].img || !last.img;
  $('corrCard').hidden = factors.length === 0 && records.length === 0;
  $('attribCard').hidden = changes.length === 0 || records.length === 0;
  $('historyCard').hidden = records.length === 0;

  if (last) {
    $('stamp').textContent = fmt(last.ts) + (last.mock ? '  \u00b7  mock scores' : '');
    const keys = Object.keys(last.scores).sort((a, b) => last.scores[b] - last.scores[a]);
    $('scores').innerHTML = keys.map((k) => {
      const series = records.map((r) => r.scores[k]).filter((v) => Number.isFinite(v));
      return '<div class="score"><div class="k">' + pretty(k) + '</div><div class="v">' + Math.round(last.scores[k]) + '</div>' + spark(series) + '</div>';
    }).join('');
    const sel = $('baseline');
    sel.innerHTML = records.map((r, i) => '<option value="' + i + '"' + (i === baselineIdx ? ' selected' : '') + '>' + day(r.ts) + '</option>').join('');
    sel.disabled = records.length < 2;
    renderDelta(); renderMap(); renderBA();
  }
  renderCompare(); renderAttrib(); renderCorr(); renderHistory();
  $('changes').innerHTML = changes.slice().reverse().map((c) => '<li>' + fmt(c.ts) + ' \u2014 ' + escapeHtml(c.what) + '</li>').join('');
}
function renderDelta() {
  const last = records[records.length - 1], base = records[baselineIdx] || records[0];
  if (!last || !base) return;
  if (base.ts === last.ts) { $('delta').innerHTML = '<p class="fine">That is the scan you are looking at. Pick an earlier date.</p>'; return; }
  $('delta').innerHTML = Object.keys(last.scores).map((k) => {
    const b = base.scores[k]; if (!Number.isFinite(b)) return '';
    const d = Math.round(last.scores[k] - b);
    const cls = Math.abs(d) < 3 ? 'flat' : d > 0 ? 'up' : 'down';
    const txt = Math.abs(d) < 3 ? 'flat' : (d > 0 ? '+' : '\u2212') + Math.abs(d);
    return '<div class="drow"><span>' + pretty(k) + '</span><span class="' + cls + '">' + txt + '</span></div>';
  }).join('');
}
function renderMap() {
  const last = records[records.length - 1];
  if (!last || !last.assets) return;
  $('mapBase').src = last.assets.image || last.img || '';
  const keys = Object.keys(last.assets.masks || {});
  if (!keys.length) { $('maskChips').innerHTML = '<span class="fine">No masks returned for this scan.</span>'; return; }
  if (!activeMask || !last.assets.masks[activeMask]) activeMask = keys[0];
  $('maskChips').innerHTML = keys.map((k) => '<button type="button" class="chip' + (k === activeMask ? ' active' : '') + '" data-mask="' + k + '">' + pretty(k) + ' ' + Math.round(last.scores[k] || 0) + '</button>').join('');
  document.querySelectorAll('[data-mask]').forEach((b) => b.addEventListener('click', () => { activeMask = b.getAttribute('data-mask'); renderMap(); }));
  const m = $('mapMask');
  m.hidden = false;
  m.style.opacity = String(Number($('maskOpacity').value) / 100);
  colorizeMask(last.assets.masks[activeMask]).then((src) => { m.src = src; }).catch(() => { m.src = last.assets.masks[activeMask]; });
}
$('maskOpacity').addEventListener('input', () => { $('mapMask').style.opacity = String(Number($('maskOpacity').value) / 100); });
function renderBA() {
  const first = records[0], last = records[records.length - 1];
  if (!first.img || !last.img) return;
  $('baBefore').src = first.img; $('baAfter').src = last.img;
  $('baStamp').textContent = day(first.ts) + '  \u2192  ' + day(last.ts);
  setSplit(50);
}
function setSplit(pct) {
  const ba = $('ba');
  ba.style.setProperty('--x', pct + '%');
}
let baDrag = false;
function baMove(e) {
  const ba = $('ba'); const r = ba.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 100;
  setSplit(clamp(x, 2, 98));
}
$('ba').addEventListener('pointerdown', (e) => { baDrag = true; baMove(e); try { $('ba').setPointerCapture(e.pointerId); } catch (err) {} });
$('ba').addEventListener('pointermove', (e) => { if (baDrag) baMove(e); });
$('ba').addEventListener('pointerup', () => { baDrag = false; });
$('ba').addEventListener('pointercancel', () => { baDrag = false; });

function renderCompare() {
  if (records.length < 2) return;
  const a = $('cmpA'), b = $('cmpB');
  if (a.options.length !== records.length) {
    const o = records.map((r, i) => '<option value="' + i + '">' + day(r.ts) + '</option>').join('');
    a.innerHTML = o; b.innerHTML = o; a.value = String(records.length - 2); b.value = String(records.length - 1);
  }
  const A = records[Number(a.value)] || records[records.length - 2];
  const B = records[Number(b.value)] || records[records.length - 1];
  $('compare').innerHTML = Object.keys(B.scores).map((k) => {
    const va = A.scores[k], vb = B.scores[k];
    if (!Number.isFinite(va) || !Number.isFinite(vb)) return '';
    const d = Math.round(vb - va);
    const cls = Math.abs(d) < 3 ? 'flat' : d > 0 ? 'up' : 'down';
    const w = Math.min(50, Math.abs(d) * 2);
    const bar = Math.abs(d) < 3 ? '' : '<i class="' + cls + '" style="width:' + w + '%"></i>';
    const txt = Math.abs(d) < 3 ? 'flat' : (d > 0 ? '+' : '\u2212') + Math.abs(d);
    return '<div class="crow"><span class="cl">' + pretty(k) + '</span><span class="ca">' + Math.round(va) + '</span><span class="cbar">' + bar + '</span><span class="cb">' + Math.round(vb) + '</span><span class="cd ' + cls + '">' + txt + '</span></div>';
  }).join('');
}
function renderAttrib() {
  if (!changes.length || !records.length) return;
  $('attrib').innerHTML = changes.slice().reverse().map((c) => {
    const before = records.filter((r) => r.ts <= c.ts), after = records.filter((r) => r.ts > c.ts).slice(0, 3);
    const head = '<div class="ahead"><span class="awhat">' + escapeHtml(c.what) + '</span><span class="adate">' + day(c.ts) + '</span></div>';
    if (!before.length) return '<div class="arow">' + head + '<p class="an">Logged before your first scan.</p></div>';
    if (!after.length) return '<div class="arow">' + head + '<p class="an">No scan since this change yet.</p></div>';
    const base = before[before.length - 1];
    const chips = Object.keys(base.scores).map((k) => {
      const vals = after.map((r) => r.scores[k]).filter((v) => Number.isFinite(v));
      if (!vals.length || !Number.isFinite(base.scores[k])) return null;
      const d = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length - base.scores[k]);
      const cls = Math.abs(d) < 3 ? 'flat' : d > 0 ? 'up' : 'down';
      const txt = Math.abs(d) < 3 ? pretty(k) + ' flat' : pretty(k) + ' ' + (d > 0 ? '+' : '\u2212') + Math.abs(d);
      return { d: Math.abs(d), html: '<span class="chip ' + cls + '">' + txt + '</span>' };
    }).filter(Boolean).sort((x, y) => y.d - x.d).map((x) => x.html).join('');
    return '<div class="arow">' + head + '<div class="chips">' + chips + '</div><p class="an">Average of ' + after.length + ' scan' + (after.length > 1 ? 's' : '') + ' after the change, against ' + day(base.ts) + '.</p></div>';
  }).join('');
}
function renderHistory() {
  $('history').innerHTML = records.slice().reverse().map((r, i) => {
    const prev = records[records.length - 2 - i];
    let sum = 'baseline';
    if (prev) {
      let up = 0, down = 0, flat = 0;
      Object.keys(r.scores).forEach((k) => {
        const p = prev.scores[k]; if (!Number.isFinite(p)) return;
        const d = r.scores[k] - p;
        if (Math.abs(d) < 3) flat++; else if (d > 0) up++; else down++;
      });
      sum = '<b>' + up + '</b> up \u00b7 <b>' + down + '</b> down \u00b7 ' + flat + ' flat';
    }
    const bars = Object.keys(r.scores).sort().map((k) => '<i class="on" style="height:' + Math.max(3, Math.round((r.scores[k] / 100) * 26)) + 'px"></i>').join('');
    return '<div class="hrow"><span class="hdate">' + day(r.ts) + '</span>' + (r.thumb ? '<img src="' + r.thumb + '" alt="" />' : '<span></span>') +
      '<span class="hsum">' + sum + '</span><span class="hbars">' + bars + '</span></div>';
  }).join('');
}

/* correlation */
function renderCorr() {
  const sel = $('corrConcern');
  const keys = records.length ? Object.keys(records[records.length - 1].scores) : [];
  if (!keys.length) { $('corrChart').innerHTML = ''; return; }
  if (!sel.options.length || sel.options.length !== keys.length) {
    sel.innerHTML = keys.map((k) => '<option value="' + k + '">' + pretty(k) + '</option>').join('');
  }
  const concern = sel.value || keys[0];
  const factor = $('corrFactor').value;
  const pts = [];
  records.forEach((r) => {
    const f = factors.filter((x) => Math.abs(x.ts - r.ts) < 36 * 3600 * 1000).pop();
    if (f && Number.isFinite(f[factor]) && Number.isFinite(r.scores[concern])) pts.push({ t: r.ts, s: r.scores[concern], f: f[factor] });
  });
  if (pts.length < 2) {
    $('corrChart').innerHTML = '';
    $('corrNote').textContent = 'Log a factor on the same day as a scan. With two matching days the chart appears.';
    return;
  }
  const W = 600, H = 170, pad = 18;
  const xs = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const sMin = Math.min.apply(null, pts.map((p) => p.s)), sMax = Math.max.apply(null, pts.map((p) => p.s));
  const fMin = Math.min.apply(null, pts.map((p) => p.f)), fMax = Math.max.apply(null, pts.map((p) => p.f));
  const ys = (v) => H - pad - ((v - sMin) / Math.max(1, sMax - sMin)) * (H - pad * 2);
  const yf = (v) => H - pad - ((v - fMin) / Math.max(0.1, fMax - fMin)) * (H - pad * 2);
  const lineA = pts.map((p, i) => xs(i) + ',' + ys(p.s)).join(' ');
  const lineB = pts.map((p, i) => xs(i) + ',' + yf(p.f)).join(' ');
  $('corrChart').innerHTML =
    '<polyline class="lineA" points="' + lineA + '"/>' +
    '<polyline class="lineB" points="' + lineB + '"/>' +
    pts.map((p, i) => '<circle class="dotA" cx="' + xs(i) + '" cy="' + ys(p.s) + '" r="3"/>').join('');
  $('corrNote').textContent = pts.length + ' matched days. Solid line: ' + pretty(concern) + '. Dashed: ' + factor + '. A pattern is not a cause.';
}
$('corrConcern').addEventListener('change', renderCorr);
$('corrFactor').addEventListener('change', renderCorr);
$('factorForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = Number($('fSleep').value), w = Number($('fWater').value);
  if (!Number.isFinite(s) && !Number.isFinite(w)) return;
  factors.push({ ts: Date.now(), sleep: Number.isFinite(s) ? s : null, water: Number.isFinite(w) ? w : null });
  save(KEY_FACTORS, factors);
  $('fSleep').value = ''; $('fWater').value = '';
  renderCorr();
});

/* chat */
function chatPush(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  $('chatLog').appendChild(d);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return d;
}
async function ask(question) {
  chatPush('user', question);
  const pending = chatPush('bot', 'Reading the ledger\u2026');
  pending.classList.add('pending');
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question,
        ledger: {
          records: records.slice(-8).map((x) => ({ ts: x.ts, scores: x.scores })),
          changes: changes.slice(-6).map((x) => ({ ts: x.ts, what: x.what }))
        }
      })
    });
    const j = await r.json();
    pending.classList.remove('pending');
    pending.textContent = j.answer || 'No answer came back.';
    $('chatEngine').textContent = j.engine === 'model' ? 'language model \u00b7 numbers only' : 'offline fallback';
  } catch (e) {
    pending.classList.remove('pending');
    pending.textContent = 'The assistant is unreachable right now.';
  }
}
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('chatInput').value.trim();
  if (!q) return;
  $('chatInput').value = '';
  ask(q);
});
const QUICK = ['Explain today\u2019s record in plain language', 'Which change is actually real?', 'What should I change next?'];
$('chatQuick').innerHTML = QUICK.map((q) => '<button type="button" class="chip" data-q="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>').join('');
document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => ask(b.getAttribute('data-q'))));

/* ocr */
const ACTIVES = ['niacinamide', 'retinol', 'salicylic acid', 'hyaluronic acid', 'ascorbic acid', 'vitamin c', 'glycolic acid', 'azelaic acid', 'ceramide', 'benzoyl peroxide', 'tranexamic acid', 'arbutin', 'lactic acid', 'panthenol', 'squalane', 'peptide', 'zinc oxide', 'urea'];
$('ocrOpen').addEventListener('click', () => $('ocrFile').click());
$('ocrFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const out = $('ocrOut');
  out.hidden = false;
  out.innerHTML = '<h3>Reading label</h3><p class="raw">Loading the OCR engine\u2026 first run downloads about 2 MB.</p>';
  try {
    if (!window.Tesseract) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        s.onload = res; s.onerror = () => rej(new Error('OCR engine could not load'));
        document.head.appendChild(s);
      });
    }
    const dataUrl = await readFile(f);
    const res = await window.Tesseract.recognize(dataUrl, 'eng');
    const text = (res.data && res.data.text) || '';
    const low = text.toLowerCase();
    const found = [];
    ACTIVES.forEach((a) => {
      const at = low.indexOf(a);
      if (at < 0) return;
      // read the percentage that FOLLOWS the name, never the one before it
      const tail = low.slice(at + a.length, at + a.length + 22);
      const m = tail.match(/(\d+(?:\.\d+)?)\s*%/);
      found.push({ name: a, pct: m ? m[1] : null });
    });
    if (!found.length) {
      out.innerHTML = '<h3>No actives found</h3><p class="raw">' + escapeHtml(text.slice(0, 160) || 'The label text was not readable.') + '</p>';
      return;
    }
    out.innerHTML = '<h3>Detected on the label</h3><div class="chips">' +
      found.map((x) => '<span class="chip up">' + escapeHtml(x.name) + (x.pct ? ' ' + x.pct + '%' : '') + '</span>').join('') +
      '</div><button type="button" class="btn ghost tiny" id="ocrAdd">Add to change log</button>';
    $('ocrAdd').addEventListener('click', () => {
      const label = found.map((x) => x.name + (x.pct ? ' ' + x.pct + '%' : '')).join(', ');
      $('what').value = ('Started ' + label).slice(0, 80);
      out.hidden = true;
      say('Prefilled from the label. Press Add to record it.', 'good');
    });
  } catch (err) {
    out.innerHTML = '<h3>OCR failed</h3><p class="raw">' + escapeHtml(err.message) + '</p>';
  }
});

/* misc */
$('baseline').addEventListener('change', (e) => { baselineIdx = Number(e.target.value); renderDelta(); });
$('cmpA').addEventListener('change', renderCompare);
$('cmpB').addEventListener('change', renderCompare);
$('change').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('what').value.trim();
  if (!v) return;
  changes.push({ ts: Date.now(), what: v });
  save(KEY_CHANGES, changes); $('what').value = ''; render();
});
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('export').addEventListener('click', () => download('skin-ledger.json', JSON.stringify({ exported_at: new Date().toISOString(), records, changes, factors }, null, 2), 'application/json'));
$('csv').addEventListener('click', () => {
  const keys = Object.keys(records[0].scores);
  const lines = [['timestamp'].concat(keys).concat(['mock']).join(',')].concat(records.map((r) =>
    [new Date(r.ts).toISOString()].concat(keys.map((k) => (Number.isFinite(r.scores[k]) ? r.scores[k] : ''))).concat([r.mock ? 1 : 0]).join(',')));
  download('skin-ledger.csv', lines.join('\n'), 'text/csv');
});
$('print').addEventListener('click', () => window.print());
$('reset').addEventListener('click', () => {
  if (!confirm('Delete every scan, change and factor on this machine?')) return;
  records = []; changes = []; factors = []; baselineIdx = 0;
  save(KEY_RECORDS, records); save(KEY_CHANGES, changes); save(KEY_FACTORS, factors);
  render(); say('Ledger cleared.');
});

health();
render();
renderQueue();
