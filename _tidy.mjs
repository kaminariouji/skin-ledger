import fs from 'node:fs';
const H = 'c:/CRYPTO MONEY MAKER/skin-ledger/index.html';
const C = 'c:/CRYPTO MONEY MAKER/skin-ledger/styles.css';
let h = fs.readFileSync(H, 'utf8');

const oldRow = `          <div class="empty-actions">
            <button type="button" class="btn solid" id="emptyCam">Use camera</button>
            <button type="button" class="btn ghost" id="emptyPick">Choose a photo</button>
            <button type="button" class="btn ghost" id="emptyDemo">Load a sample record</button>
          </div>
          <span class="fine empty-note">The sample uses four dated scans, five routine changes and four daily logs - no API units.</span>`;
const newRow = `          <div class="empty-actions">
            <button type="button" class="btn solid" id="emptyCam">Use camera</button>
            <button type="button" class="btn ghost" id="emptyPick">Choose a photo</button>
          </div>
          <button type="button" class="link-btn" id="emptyDemo">Or load a sample record</button>
          <span class="fine empty-note">Four dated scans, five routine changes, four daily logs. No API units.</span>`;
if (!h.includes(oldRow)) { console.log('MISS baris empty'); process.exit(1); }
h = h.split(oldRow).join(newRow);
fs.writeFileSync(H, h);
console.log('empty state dirapikan');

let c = fs.readFileSync(C, 'utf8');
const add = `
/* --- empty state: satu baris aksi, sample sebagai link --- */
.link-btn {
  margin-top: 12px;
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  font-size: 12.5px;
  color: var(--muted);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.link-btn:hover { color: var(--ink-2); }
.link-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 2px; }
.empty-note { max-width: 38ch; }
/* sembunyikan tombol pilih di toolbar selama stage masih kosong */
.capture:has(#empty:not([hidden])) #pick,
.capture:has(#empty:not([hidden])) #camOpen { display: none; }
`;
if (c.includes('.link-btn')) { console.log('CSS sudah ada'); } else { fs.writeFileSync(C, c.trimEnd() + add); console.log('CSS ditambahkan'); }
