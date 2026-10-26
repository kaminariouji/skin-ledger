import fs from 'node:fs';
const H = 'c:/CRYPTO MONEY MAKER/skin-ledger/index.html';
const C = 'c:/CRYPTO MONEY MAKER/skin-ledger/styles.css';
let h = fs.readFileSync(H, 'utf8');
const start = h.indexOf('<div class="controls">');
const end = h.indexOf('</div>', h.indexOf('id="run"')) + 6;
if (start < 0 || end < 6) { console.log('MISS controls'); process.exit(1); }
const block = `<div class="controls">
        <label class="zoom" for="zoom">
          <span class="zoom-label">Zoom</span>
          <input type="range" id="zoom" min="100" max="320" value="100" step="1" disabled />
          <output id="zoomOut" class="zoom-out">1.00×</output>
        </label>
        <div class="controls-right">
          <button type="button" id="pick" class="btn ghost">Choose photo</button>
          <button type="button" id="camOpen" class="btn ghost">Use camera</button>
          <div class="tier" role="group" aria-label="Analysis depth">
            <button type="button" data-tier="sd" aria-pressed="true">Standard 8</button>
            <button type="button" data-tier="hd" aria-pressed="false">HD 16</button>
          </div>
          <button type="button" id="run" class="btn solid" disabled>Run scan</button>
        </div>
      </div>`;
h = h.slice(0, start) + block + h.slice(end);
fs.writeFileSync(H, h);
console.log('controls dirapikan');

let c = fs.readFileSync(C, 'utf8');
c = c.replace('.controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }',
  '.controls { display: flex; align-items: center; gap: 12px; flex-wrap: nowrap; }\n.controls-right { display: flex; align-items: center; gap: 10px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }');
fs.writeFileSync(C, c);
console.log('css controls:', c.includes('.controls-right'));
