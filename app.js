const $ = (id) => document.getElementById(id);
const KEY_RECORDS = 'skinledger.records.v4';
const KEY_CHANGES = 'skinledger.changes.v4';
const KEY_FACTORS = 'skinledger.factors.v1';
const KEY_THEME = 'skinledger.theme';
const STAGE = 440, OUT = 1024, OUT_HD = 2048;
let tier = 'sd';
try { const t = localStorage.getItem('skinledger.tier'); if (t === 'hd' || t === 'sd') tier = t; } catch (e) {}

const stage = $('stage'), shot = $('shot'), guide = $('guide'), empty = $('empty');
const zoomEl = $('zoom'), zoomOut = $('zoomOut'), hint = $('hint');
const veil = $('veil'), veilText = $('veilText'), progress = $('progress');
const progressStage = $('progressStage'), progressTime = $('progressTime');
const cam = $('cam'), camVideo = $('camVideo'), ghost = $('ghost');

let records = load(KEY_RECORDS, []);
let changes = load(KEY_CHANGES, []);
let factors = load(KEY_FACTORS, []);
let queue = [], zoom = 1, pan = { x: 0, y: 0 }, loaded = false;
let baselineIdx = 0, busy = false, camStream = null, qTimer = null, stageK = 1, camFrames = 0, badStreak = 0, lastSig = -1, stillFrames = 0;
let activeMask = null;

function load(k, f) { try { return JSON.parse(localStorage.getItem(k)) || f; } catch (e) { return f; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
function saveRecords() {
  if (save(KEY_RECORDS, records)) return;
  for (let i = 0; i < records.length - 1; i++) delete records[i].img;
  if (!save(KEY_RECORDS, records)) say('Storage is full. Delete an old scan before adding another.', 'error');
  else say('Storage was full, so older photos were dropped. Scores are kept.', 'error');
}
const fmt = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const day = (ts) => {
  const d = new Date(ts);
  const base = d.toLocaleDateString();
  const twin = records.some((r) => r.ts !== ts && new Date(r.ts).toLocaleDateString() === base);
  return twin ? base + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : base;
};
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

/* depth switch */
function paintTier() {
  document.querySelectorAll('[data-tier]').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-tier') === tier)));
  const note = $('tierNote');
  if (note) note.textContent = tier === 'hd'
    ? '16 concerns, with a score for each region of the face. Slower, 22 units per scan.'
    : '8 concerns — the quick check. 16 adds per-region detail.';
}
document.querySelectorAll('[data-tier]').forEach((b) => b.addEventListener('click', () => {
  tier = b.getAttribute('data-tier');
  try { localStorage.setItem('skinledger.tier', tier); } catch (e) {}
  paintTier();
  say(tier === 'hd' ? 'HD selected: 16 concerns plus per-region scores, slower and 22 units per scan.' : 'Standard selected: 8 concerns, 12 units per scan.');
}));
paintTier();

/* api */

/* the framing stage keeps its 440-unit coordinate space; on narrow screens it is scaled, not re-measured, so the crop stays exactly what the user framed */
function fitStage() {
  const scaler = $('stageScaler');
  if (!scaler) return;
  const w = scaler.clientWidth || STAGE;
  stageK = Math.min(1, w / STAGE);
  stage.style.transform = stageK < 1 ? 'scale(' + stageK + ')' : '';
  scaler.style.height = Math.round(STAGE * stageK) + 'px';
}
window.addEventListener('resize', fitStage);
fitStage();

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
  error_download_image: 'The upload did not reach the analysis service. Try again.',
  image_too_small_hd: 'HD needs a photo at least 2048px on the short side. Use a larger image.',
  busy: 'An analysis is already running. Wait for it to finish, then try again.',
  task_pending: 'The service is still working on that scan. Give it a minute before running another one.',
  upstream_error: 'The analysis service did not answer properly. Try again in a moment.'
};
const humanError = (c, body) => (c === 'image_too_small_hd' && body && body.message) ? String(body.message) : (ERROR_TEXT[c] || 'The analysis service rejected that photo. Try a straight-on, well-lit shot with your face filling the circle.');

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
function cropDataUrl(size) {
  const s = baseScale() * zoom, dw = shot.naturalWidth * s, dh = shot.naturalHeight * s;
  const left = STAGE / 2 + pan.x - dw / 2, top = STAGE / 2 + pan.y - dh / 2, sw = STAGE / s;
  const c = document.createElement('canvas'); c.width = size || OUT; c.height = size || OUT;
  c.getContext('2d').drawImage(shot, -left / s, -top / s, sw, sw, 0, 0, size || OUT, size || OUT);
  return c.toDataURL('image/jpeg', 0.92);
}
function cropForTier() { return cropDataUrl(tier === 'hd' ? OUT_HD : OUT); }
function loadImage(url) {
  return new Promise((res, rej) => {
    shot.onload = () => {
      loaded = true;
      shot.hidden = false; guide.hidden = false; empty.hidden = true; $('shotClear').hidden = false;
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
$('emptyPick').addEventListener('click', (e) => { e.stopPropagation(); $('file').click(); });
$('emptyDemo').addEventListener('click', async () => {
  const btn = $('emptyDemo');
  btn.disabled = true;
  try {
    const r = await fetch('demo.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('the sample record is unavailable');
    const d = await r.json();
    records = d.records || [];
    changes = d.changes || [];
    factors = d.factors || [];
    baselineIdx = 0;
    save(KEY_RECORDS, records);
    save(KEY_CHANGES, changes);
    save(KEY_FACTORS, factors);
    render();
    const card = $('compareCard');
    if (card) try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { card.scrollIntoView(); }
  } catch (err) {
    btn.disabled = false;
    say('Could not load the sample: ' + err.message, 'error');
  }
});
$('emptyCam').addEventListener('click', (e) => { e.stopPropagation(); openCam(); });
empty.addEventListener('click', () => $('file').click());
stage.addEventListener('click', (e) => { if (e.target.closest('button, input, select, label, .cam')) return; if (!loaded) $('file').click(); });
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragging'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
stage.addEventListener('drop', (e) => {
  e.preventDefault(); stage.classList.remove('dragging');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) takeFiles(e.dataTransfer.files);
});
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
  // Pointer capture retargets the following click to #stage, so the × button never fired.
  if (e.target.closest('button, input, select, label, .cam')) return;
  drag = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  stage.classList.add('dragging');
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  pan.x = drag.px + (e.clientX - drag.x) / stageK; pan.y = drag.py + (e.clientY - drag.y) / stageK; layout();
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
  camFrames = 0; badStreak = 0; lastSig = -1; stillFrames = 0;
  $("camBadges").hidden = true;
  $("camOval").className = "cam-oval";
}
function clearShot() {
  const cur = shot.getAttribute('src');
  loaded = false;
  shot.hidden = true; shot.removeAttribute('src');
  guide.hidden = true; empty.hidden = false;
  zoom = 1; pan = { x: 0, y: 0 }; zoomEl.value = 100; zoomEl.disabled = true;
  $('run').disabled = true; $('shotClear').hidden = true;
  if (cur) { queue = queue.filter((q) => q.dataUrl !== cur); renderQueue(); }
  say('');
}
$('shotClear').addEventListener('click', (e) => { e.stopPropagation(); clearShot(); });
async function openCam() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say('This browser has no camera API.', 'error'); return; }
  if (camStream) return;
  cam.hidden = false;
  empty.hidden = true;
  camFrames = 0; badStreak = 0; lastSig = -1; stillFrames = 0;
  $("camBadges").hidden = true;
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
  const w = 96, h = 96;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(camVideo, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let lum = 0, skin = 0; const n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = y; lum += y;
    const cx = i % w, cy = (i / w) | 0;
    const inOval = Math.pow((cx - w / 2) / (w * 0.34), 2) + Math.pow((cy - h / 2) / (h * 0.42), 2) < 1;
    if (inOval && r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 12) skin++;
  }
  // Laplacian variance separates a sharp 96px face (~470) from a 2px-soft one (~11).
  // The old edge-per-pixel score peaked at 0.31 on a razor-sharp photo, so it always said blurry.
  let lap = 0, lap2 = 0; const m = (w - 2) * (h - 2);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
    lap += l; lap2 += l * l;
  }
  const lapVar = lap2 / m - Math.pow(lap / m, 2);
  lum = lum / n; const skinRatio = skin / n;
  const lightOk = lum > 55 && lum < 205;
  const focusJudge = lum > 45;
  const focusOk = focusJudge && lapVar > 40;
  const frameOk = skinRatio > 0.18;

  // Nothing is judged until the sensor has settled: the first frames are black while exposure ramps.
  // A frozen track (covered lens, camera held by another app) must not be judged as a bad face.
  let sig = 0; for (let i = 0; i < n; i += 13) sig += gray[i];
  if (Math.abs(sig - lastSig) < 1) stillFrames++; else stillFrames = 0;
  lastSig = sig;
  camFrames++;
  if (camFrames <= 3) { $('camShot').disabled = true; return; }
  if (stillFrames >= 3 && lum < 40) { $('camBadges').hidden = true; $('camShot').disabled = true; $('camOval').className = 'cam-oval'; return; }
  $('camBadges').hidden = false;
  setBadge('light', lightOk, lum < 55 ? 'too dark' : lum > 205 ? 'too bright' : 'light ok');
  if (!focusJudge) setBadge('focus', false, 'low light', true);
  else setBadge('focus', focusOk, focusOk ? 'focus ok' : 'soft focus');
  setBadge('frame', frameOk, frameOk ? 'face in frame' : 'move closer');
  const oval = $('camOval');
  if (!lightOk) { oval.className = 'cam-oval'; badStreak = 0; }
  else if (frameOk) { oval.className = 'cam-oval ok'; badStreak = 0; }
  else { badStreak++; oval.className = 'cam-oval' + (badStreak >= 3 ? ' bad' : ''); }
  $('camShot').disabled = !(lightOk && frameOk);
}
function setBadge(k, ok, text, muted) {
  const el = document.querySelector('[data-b="' + k + '"]');
  if (!el) return;
  el.textContent = text;
  el.className = muted ? 'muted' : ok ? 'ok' : 'warn';
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
$('camClose').addEventListener('click', (e) => { e.stopPropagation(); stopCam(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('cam').hidden) stopCam(); });
$('camShot').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!camVideo.videoWidth) return;
  const size = Math.min(camVideo.videoWidth, camVideo.videoHeight);
  const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
  const sx = (camVideo.videoWidth - size) / 2, sy = (camVideo.videoHeight - size) / 2;
  const g2 = c.getContext('2d');
  // The preview is mirrored so framing feels natural; mirror the capture the same way so the photo matches what you framed.
  g2.translate(1024, 0); g2.scale(-1, 1);
  g2.drawImage(camVideo, sx, sy, size, size, 0, 0, 1024, 1024);
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
async function post(image, useTier) {
  const cropPx = shot.naturalWidth ? Math.round(STAGE / (baseScale() * zoom)) : 0;
  const r = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image, tier: useTier || 'sd', cropPx }) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, body: j };
}
async function analyseFramed(label) {
  startProgress(label);
  let res = await post(cropForTier(), tier);
  if (!res.ok) { const e = new Error(humanError(res.body && res.body.error, res.body)); e.code = res.body && res.body.error; throw e; }
  const scores = {};
  Object.keys(res.body.results || {}).forEach((k) => {
    const v = res.body.results[k];
    const n = Number(v && v.score !== undefined ? v.score : v);
    if (Number.isFinite(n)) scores[k] = n;
  });
  if (!Object.keys(scores).length) throw new Error('The API returned no scores.');
  return {
    scores, mock: !!res.body.mock, assets: res.body.assets || null,
    tier: res.body.tier || tier,
    regions: Array.isArray(res.body.regions) ? res.body.regions : [],
    skinType: res.body.skin_type || null,
    skinAge: Number.isFinite(res.body.skin_age) ? res.body.skin_age : null,
    overall: Number.isFinite(res.body.overall) ? res.body.overall : null
  };
}
async function commit(scores, mock, framed, assets, extra) {
  records.push({
    ts: Date.now(), scores, thumb: await downscale(framed, 96), img: await downscale(framed, 512), assets, mock,
    tier: (extra && extra.tier) || 'sd',
    regions: (extra && extra.regions) || [],
    skinType: (extra && extra.skinType) || null,
    skinAge: (extra && extra.skinAge) || null,
    overall: (extra && extra.overall) || null
  });
  saveRecords();
  baselineIdx = 0;
  render();
}
function markQueueDone(dataUrl, scores) {
  let hit = false;
  queue.forEach((q) => {
    if (dataUrl && q.dataUrl === dataUrl && q.status !== 'done') { q.status = 'done'; q.scores = scores; q.error = ''; hit = true; }
  });
  if (hit) renderQueue();
}
$('run').addEventListener('click', async () => {
  if (!loaded || busy) return;
  busy = true; const btn = $('run'); btn.disabled = true; btn.textContent = 'Scanning';
  say('Sending the framed square to YouCam Skin AI.');
  try {
    const framed = cropForTier();
    const cur = shot.getAttribute('src');
    const out = await analyseFramed();
    await commit(out.scores, out.mock, framed, out.assets, out);
    markQueueDone(cur, out.scores);
    say('Saved. Run another scan after you change something to get a real delta.', 'good');
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
        const framed = cropForTier();
        const out = await analyseFramed(label);
        await commit(out.scores, out.mock, framed, out.assets, out);
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
    const st = q.status === 'done' ? '<span class="qstatus ok">' + Object.keys(q.scores).length + ' scores</span>'
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
  // The API ships a plain mask. Map its intensity onto a warm ramp so a weak
  // reading stays amber and a strong one turns magenta.
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
    const v = Math.max(a, lum);
    if (v < 0.05) { px[i + 3] = 0; continue; }
    const t = Math.min(1, (v - 0.05) / 0.95);
    px[i] = Math.round(255 * (1 - 0.15 * t));
    px[i + 1] = Math.round(255 * (0.62 - 0.5 * t));
    px[i + 2] = Math.round(255 * (0.12 + 0.62 * t));
    px[i + 3] = Math.round(255 * Math.min(1, 0.2 + 0.8 * t));
  }
  ctx.putImageData(data, 0, 0);
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
  $('compareCard').hidden = records.length < 2;

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
  renderReport();
  renderCompare(); renderAttrib(); renderCorr(); renderHistory();
  $('changes').innerHTML = changes.length ? changes.slice().reverse().map((c) => '<li>' + fmt(c.ts) + ' \u2014 ' + escapeHtml(c.what) + (c.note ? '<span class=\"chg-note\">' + escapeHtml(c.note) + '</span>' : '') + '</li>').join('') : '<li class="fine">No changes logged yet. Add what you started - the next scan is compared against it.</li>';
}
function renderReport() {
  const last = records[records.length - 1];
  const head = $('recordHeading');
  if (head && last) head.textContent = new Date(last.ts).toDateString() === new Date().toDateString() ? "Today's record" : 'Record from ' + day(last.ts);
  const has = !!(last && last.regions && last.regions.length);
  $('reportCard').hidden = !has;
  if (!has) return;
  $('reportStamp').textContent = (last.tier === 'hd' ? 'HD' : 'Standard') + ' \u00b7 ' + last.regions.length + ' regional readings';
  const stats = [];
  if (Number.isFinite(last.overall)) stats.push(['Overall', Math.round(last.overall)]);
  if (Number.isFinite(last.skinAge)) stats.push(['Skin age', Math.round(last.skinAge)]);
  if (last.skinType) stats.push(['Skin type', last.skinType]);
  $('reportTop').innerHTML = stats.map((s) => '<div class="stat"><span class="k">' + s[0] + '</span><span class="v">' + s[1] + '</span></div>').join('');
  const byType = {};
  last.regions.forEach((r) => { (byType[r.type] = byType[r.type] || []).push(r); });
  const rows = Object.keys(byType).map((t) => {
    const whole = byType[t].filter((r) => r.region === 'whole')[0];
    const score = whole ? whole.score : last.scores[t];
    return { t, score: Number.isFinite(score) ? score : -1, regions: byType[t].filter((r) => r.region !== 'whole') };
  }).sort((a, b) => a.score - b.score);
  $('reportTable').innerHTML = rows.map((row) => {
    const chips = row.regions.length ? '<span class="rregions">' + row.regions.map((r) => '<span class="rchip">' + pretty(r.region) + ' <b>' + Math.round(r.score) + '</b></span>').join('') + '</span>' : '';
    return '<div class="rrow"><span class="rname">' + pretty(row.t) + '</span><span class="rscore">' + (row.score >= 0 ? Math.round(row.score) : '\u2014') + '</span>' + chips + '</div>';
  }).join('');
}
function renderDelta() {
  const last = records[records.length - 1], base = records[baselineIdx] || records[0];
  if (!last || !base) return;
  if (base.ts === last.ts) {
    $('delta').innerHTML = '<p class="fine">' + (records.length < 2 ? 'This is your baseline. Run a second scan and this panel shows exactly what moved.' : 'Both sides point at the same scan. Pick an earlier date to compare against.') + '</p>';
    return;
  }
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
    const headNote = c.note ? '<p class="anote">' + escapeHtml(c.note) + '</p>' : '';
    if (!before.length) return '<div class="arow">' + head + headNote + '<p class="an">Logged before your first scan.</p></div>';
    if (!after.length) return '<div class="arow">' + head + headNote + '<p class="an">No scan since this change yet.</p></div>';
    const base = before[before.length - 1];
    const chips = Object.keys(base.scores).map((k) => {
      const vals = after.map((r) => r.scores[k]).filter((v) => Number.isFinite(v));
      if (!vals.length || !Number.isFinite(base.scores[k])) return null;
      const d = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length - base.scores[k]);
      const cls = Math.abs(d) < 3 ? 'flat' : d > 0 ? 'up' : 'down';
      const txt = Math.abs(d) < 3 ? pretty(k) + ' flat' : pretty(k) + ' ' + (d > 0 ? '+' : '\u2212') + Math.abs(d);
      return { d: Math.abs(d), html: '<span class="chip ' + cls + '">' + txt + '</span>' };
    }).filter(Boolean).sort((x, y) => y.d - x.d).map((x) => x.html).join('');
    return '<div class="arow">' + head + headNote + '<div class="chips">' + chips + '</div><p class="an">Average of ' + after.length + ' scan' + (after.length > 1 ? 's' : '') + ' after the change, against ' + day(base.ts) + '.</p></div>';
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
      sum = '<span class="sum-up"><b>' + up + '</b> up</span> \u00b7 <span class="sum-down"><b>' + down + '</b> down</span> \u00b7 <span class="sum-flat">' + flat + ' flat</span>';
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
  if (!keys.length) { $('corrChart').innerHTML = ''; $('corrChart').hidden = true; return; }
  if (!sel.options.length || sel.options.length !== keys.length) {
    sel.innerHTML = keys.map((k) => '<option value="' + k + '">' + pretty(k) + '</option>').join('');
  }
  const concern = sel.value || keys[0];
  const factor = $('corrFactor').value;
  const pts = [];
  records.forEach((r) => {
    // Nearest factor, not the last one: several logs can sit inside the 36h window.
    const near = factors.filter((x) => Math.abs(x.ts - r.ts) < 36 * 3600 * 1000).sort((a, b) => Math.abs(a.ts - r.ts) - Math.abs(b.ts - r.ts));
    const f = near[0];
    if (f && Number.isFinite(f[factor]) && Number.isFinite(r.scores[concern])) pts.push({ t: r.ts, s: r.scores[concern], f: f[factor] });
  });
  if (pts.length < 2) {
    $('corrChart').innerHTML = '';
    $('corrChart').hidden = true;
    $('corrNote').textContent = 'Log a factor on the same day as a scan. With two matching days the chart appears.';
    return;
  }
  const W = 600, H = 170, pad = 18;
  const xs = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const sMin = Math.min.apply(null, pts.map((p) => p.s)), sMax = Math.max.apply(null, pts.map((p) => p.s));
  const fMin = Math.min.apply(null, pts.map((p) => p.f)), fMax = Math.max.apply(null, pts.map((p) => p.f));
  const ys = (v) => H - pad - ((v - sMin) / Math.max(1, sMax - sMin)) * (H - pad * 2);
  const yf = (v) => H - pad - ((v - fMin) / Math.max(0.1, fMax - fMin)) * (H - pad * 2);
  $('corrChart').hidden = false;
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
  const s = $('fSleep').value === '' ? NaN : Number($('fSleep').value);
  const w = $('fWater').value === '' ? NaN : Number($('fWater').value);
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
          changes: changes.slice(-6).map((x) => ({ ts: x.ts, what: x.what, note: x.note || '' })),
          factors: factors.slice(-8).map((x) => ({ ts: x.ts, sleep: x.sleep, water: x.water }))
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
const QUICK = ['Explain today\u2019s record in plain language', 'Which change is actually real?', 'What should I change next?', 'Why did acne improve?'];
$('chatQuick').innerHTML = QUICK.map((q) => '<button type="button" class="chip" data-q="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>').join('');
document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => ask(b.getAttribute('data-q'))));

/* quick nav (mobile) */
(function quickNav() {
  const nav = $('quickNav');
  if (!nav) return;
  const links = Array.from(nav.querySelectorAll('[data-goto]'));
  const items = links.map((link) => ({ link, el: $(link.getAttribute('data-goto')) })).filter((x) => x.el);

  links.forEach((link) => link.addEventListener('click', (e) => {
    const el = $(link.getAttribute('data-goto'));
    e.preventDefault();
    if (!el) return;
    if (el.hidden) { say(link.getAttribute('data-goto') === 'compareCard' ? 'Run two scans and this panel opens.' : 'This panel appears after your first scan.', 'error'); return; }
    try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (err) { el.scrollIntoView(); }
  }));

  const top = $('quickTop');
  if (top) top.addEventListener('click', () => {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (err) { window.scrollTo(0, 0); }
  });

  if (!items.length || !('IntersectionObserver' in window)) return;

  function mark() {
    const probe = window.innerHeight * 0.32;
    let best = null, bestDist = Infinity;
    items.forEach(({ el }) => {
      if (el.hidden) return;
      const box = el.getBoundingClientRect();
      if (box.bottom < 90 || box.top > window.innerHeight - 90) return;
      const dist = Math.abs(box.top - probe);
      if (dist < bestDist) { bestDist = dist; best = el; }
    });
    items.forEach(({ link, el }) => {
      if (el === best) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }

  const io = new IntersectionObserver(mark, { rootMargin: '-72px 0px -110px 0px', threshold: [0, 0.25, 0.5, 1] });
  items.forEach(({ el }) => io.observe(el));
  mark();
})();

/* ocr */
const ACTIVES = ['niacinamide', 'retinol', 'salicylic acid', 'hyaluronic acid', 'ascorbic acid', 'vitamin c', 'glycolic acid', 'azelaic acid', 'ceramide', 'benzoyl peroxide', 'tranexamic acid', 'arbutin', 'lactic acid', 'panthenol', 'squalane', 'peptide', 'zinc oxide', 'urea'];
let ocrStream = null;
let ocrTrack = null;
let ocrTorch = false;
async function openOcrCam() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('ocrFile').click(); return; }
  if (ocrStream) return;
  $('ocrCam').hidden = false;
  $('ocrZoom').value = '100'; $('ocrZoomOut').textContent = '1.0\u00d7';
  try {
    ocrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
    $('ocrVideo').srcObject = ocrStream;
    await $('ocrVideo').play().catch(() => {});
    ocrTrack = ocrStream.getVideoTracks()[0] || null;
    const caps = (ocrTrack && ocrTrack.getCapabilities) ? ocrTrack.getCapabilities() : {};
    ocrTorch = false;
    $('ocrTorch').hidden = !caps.torch;
    $('ocrTorch').setAttribute('aria-pressed', 'false');
  } catch (e) {
    stopOcrCam();
    say('Camera unavailable: ' + (e.message || e.name) + '. Choose a photo instead.', 'error');
  }
}
function stopOcrCam() {
  if (ocrStream) ocrStream.getTracks().forEach((t) => t.stop());
  ocrStream = null; ocrTrack = null; ocrTorch = false;
  $('ocrVideo').srcObject = null;
  $('ocrCam').hidden = true;
}
async function toggleTorch() {
  if (!ocrTrack) return;
  try {
    ocrTorch = !ocrTorch;
    await ocrTrack.applyConstraints({ advanced: [{ torch: ocrTorch }] });
    $('ocrTorch').setAttribute('aria-pressed', String(ocrTorch));
  } catch (e) { ocrTorch = false; }
}
$('ocrZoom').addEventListener('input', () => { $('ocrZoomOut').textContent = (Number($('ocrZoom').value) / 100).toFixed(1) + '\u00d7'; });
function captureOcr() {
  const v = $('ocrVideo');
  if (!v.videoWidth) return;
  // The preview is object-fit: cover, so grab exactly the rectangle the user sees:
  // a centred crop whose aspect ratio is the element's, not the sensor's.
  const box = v.getBoundingClientRect();
  const z = Math.max(1, Number($('ocrZoom').value) / 100);
  const vw = v.videoWidth, vh = v.videoHeight;
  const boxAspect = box.width / Math.max(1, box.height);
  let cw = vw, ch = vh;
  if (boxAspect < vw / vh) cw = Math.round(vh * boxAspect); else ch = Math.round(vw / boxAspect);
  const sw = Math.round(cw / z), sh = Math.round(ch / z);
  const sx = Math.round((vw - sw) / 2), sy = Math.round((vh - sh) / 2);
  const target = Math.min(2400, Math.max(1400, Math.round(sw * 1.4)));
  const c = document.createElement('canvas');
  c.width = target; c.height = Math.round(target * sh / sw);
  const ctx = c.getContext('2d');
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);

  const url = c.toDataURL('image/jpeg', 0.94);
  stopOcrCam();
  runOcr(url);
}
$('ocrOpen').addEventListener('click', openOcrCam);
$('ocrPick').addEventListener('click', () => $('ocrFile').click());
$('ocrShot').addEventListener('click', captureOcr);
$('ocrCancel').addEventListener('click', stopOcrCam);
$('ocrTorch').addEventListener('click', toggleTorch);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('ocrCam').hidden) stopOcrCam(); });

// Stems tolerate OCR typos ("Methoxycinnamse", "Tocophery!") without full fuzzy search.
const ACTIVE_PATTERNS = [
  ['niacinamide', /niacinamid|niasinamid/],
  ['retinol', /retin(?:ol|al)/],
  ['salicylic acid', /salicyl|asam salisilat/],
  ['hyaluronic acid', /hyaluron|asam hialuronat/],
  ['ascorbic acid', /ascorb|asam askorbat/],
  ['vitamin c', /vitamin\s*c/],
  ['glycolic acid', /glycolic|asam glikolat/],
  ['azelaic acid', /azelaic|asam azelat/],
  ['ceramide', /ceramid/],
  ['benzoyl peroxide', /benzoyl|benzoil peroksida/],
  ['tranexamic acid', /tranexam|asam traneksamat/],
  ['arbutin', /arbutin/],
  ['lactic acid', /lactic|asam laktat/],
  ['panthenol', /panthenol/],
  ['squalane', /squalan/],
  ['peptide', /peptid|peptida/],
  ['zinc oxide', /zinc|seng oksida/],
  ['titanium dioxide', /titanium|titan dioksida/],
  ['centella asiatica', /centella/],
  ['octinoxate', /methoxycinnam|octinoxate/],
  ['avobenzone', /avobenzone|methoxydibenzoyl/],
  ['octocrylene', /octocrylene/],
  ['tocopherol', /tocopher/],
  ['allantoin', /allantoin/],
  ['bisabolol', /bisabolol/],
  ['madecassoside', /madecassosid/],
  ['adenosine', /adenosin/],
  ['caffeine', /caffein/],
  ['urea', /\burea\b/]
];
function findActives(text) {
  const low = text.toLowerCase();
  const found = [];
  ACTIVE_PATTERNS.forEach((pair) => {
    const m = low.match(pair[1]);
    if (!m) return;
    const tail = low.slice(m.index + m[0].length, m.index + m[0].length + 30).split(/[,\n]/)[0];
    const pct = tail.match(/(\d+(?:\.\d+)?)\s*%/);
    found.push({ name: pair[0], pct: pct ? pct[1] : null });
  });
  return found;
}
let pendingNote = '';
async function compressForLabel(dataUrl) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const k = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(img, 0, 0, c.width, c.height);
  let q = 0.86, out = c.toDataURL('image/jpeg', q);
  while (out.length > 900000 && q > 0.5) { q -= 0.12; out = c.toDataURL('image/jpeg', q); }
  return out;
}
async function runOcr(dataUrl) {
  const out = $('ocrOut');
  pendingNote = '';
  out.hidden = false;
  const t0 = Date.now();
  out.innerHTML = '<h3>Reading the label</h3><p class="raw" id="ocrStep">Sending the photo to the label reader\u2026</p>';
  const tick = setInterval(() => { const el = $('ocrStep'); if (el) el.textContent = 'Reading\u2026 ' + Math.round((Date.now() - t0) / 1000) + 's. The reader takes about 5s, the model that names the ingredients another 10-25s.'; }, 1000);
  const shot = '<div class="ocr-shot"><img src="' + dataUrl + '" alt="Captured label" /></div>';
  const again = '<button type="button" class="btn ghost tiny" id="ocrAgain">Scan again</button>';
  let text = '', parsed = null;
  try {
    const r = await fetch('/api/label', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: await compressForLabel(dataUrl) })
    });
    let j = null;
    try { j = await r.json(); } catch {}
    clearInterval(tick);
    if (!r.ok) throw new Error((j && (j.message || j.error)) || ('the label reader answered ' + r.status));
    text = String((j && j.text) || '').trim();
    parsed = (j && j.parsed) || null;
    if (!text) throw new Error((j && j.message) || 'The label came back empty.');
  } catch (err) {
    clearInterval(tick);
    pendingNote = '';
    out.innerHTML = '<h3>Could not read the label</h3><p class="raw">' + escapeHtml(err.message) + '</p>' + shot +
      '<div class="ocr-actions">' + again + '</div>';
    $('ocrAgain').addEventListener('click', openOcrCam);
    return;
  }
  const clean = (s) => s.replace(/[^A-Za-z0-9 %+./-]/g, ' ').replace(/\s+/g, ' ').trim();
  const solvent = /^(water|aqua|eau|aqua\/water)$/i;
  const listed = (parsed && parsed.ingredients) || [];
  let found = (listed.length ? listed.map((x) => ({ name: x.name, pct: x.pct != null ? String(x.pct) : null })) : findActives(text))
    .filter((x) => !solvent.test(String(x.name).trim()));
  const chipsHtml = (arr) => '<div class="chips" id="ocrChips">' + arr.map((x) => '<span class="chip up">' + escapeHtml(x.name) + (x.pct ? ' ' + x.pct + '%' : '') + '</span>').join('') + '</div>';
  const noteFor = (arr) => arr.map((x) => x.name + (x.pct ? ' ' + x.pct + '%' : '')).join(', ').slice(0, 240);
  const product = (parsed && parsed.product) || '';
  pendingNote = noteFor(found);
  const lines = text.split('\n').map(clean).filter((s) => s.replace(/[^A-Za-z]/g, '').length >= 6);
  const suggestion = (product || lines[0] || '').slice(0, 80);
  const raw = '<details class="ocr-raw"><summary>Text read from the photo (' + text.length + ' chars)</summary><pre>' + escapeHtml(text) + '</pre></details>';
  const warn = found.length
    ? 'Every ingredient printed on the label, taken straight from the text. The product name and any spelling repair arrive a moment later.'
    : 'The text was read but no ingredient list was found in it. Move closer to the list and scan again.';
  out.innerHTML = '<h3 id="ocrHead">' + escapeHtml(product || (found.length ? 'Composition found' : 'Text read from the label')) + '</h3>' +
    '<p class="raw">' + warn + '</p>' + shot +
    '<p class="raw" id="ocrSummary" hidden></p>' + chipsHtml(found) +
    '<div class="ocr-edit"><label for="ocrText">Product</label><input id="ocrText" maxlength="80" placeholder="Type the product name" value="' + escapeHtml(suggestion) + '" /></div>' +
    '<p class="ocr-warn" id="ocrWarn" hidden></p>' +
    '<div class="ocr-actions"><button type="button" class="btn ghost tiny" id="ocrAdd">Add to change log</button>' + again +
    '<a class="btn ghost tiny" download="label.jpg" href="' + dataUrl + '">Save photo</a></div>' + raw;
  let dirty = false;
  $('ocrText').addEventListener('input', () => { dirty = true; });
  $('ocrAdd').addEventListener('click', () => {
    const v = $('ocrText').value.trim();
    if (!v) { const w = $('ocrWarn'); w.textContent = 'Type the product name first, then press Add.'; w.hidden = false; $('ocrText').focus(); return; }
    changes.push({ ts: Date.now(), what: v.slice(0, 80), ...(pendingNote ? { note: pendingNote } : {}) });
    save(KEY_CHANGES, changes);
    pendingNote = '';
    out.hidden = true;
    render();
    say('Logged: ' + v.slice(0, 60), 'good');
  });
  // The model only polishes: a title, up to six name repairs, one line of context.
  fetch('/api/label/enrich', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    .then((r) => r.json())
    .then((j) => {
      if (!j || !j.ok || !j.enrich) return;
      const e = j.enrich, fixes = e.fixes || {}, keys = Object.keys(fixes);
      found = found.map((x) => {
        const hit = keys.find((k) => k.toLowerCase() === x.name.toLowerCase() || x.name.toLowerCase().startsWith(k.toLowerCase()));
        return hit ? { name: fixes[hit], pct: x.pct } : x;
      });
      pendingNote = noteFor(found);
      const head = $('ocrHead'), chips = $('ocrChips'), sum = $('ocrSummary'), input = $('ocrText');
      if (head && e.product) head.textContent = e.product;
      if (chips) chips.outerHTML = chipsHtml(found);
      if (sum && e.summary) { sum.textContent = 'Notable: ' + e.summary; sum.hidden = false; }
      if (input && e.product && !dirty) input.value = e.product.slice(0, 80);
    })
    .catch(() => {});
  $('ocrAgain').addEventListener('click', openOcrCam);
}
$('ocrFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  runOcr(await readFile(f));
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
