import fs from 'node:fs';
const H = 'c:/CRYPTO MONEY MAKER/skin-ledger/index.html';
const C = 'c:/CRYPTO MONEY MAKER/skin-ledger/styles.css';
let h = fs.readFileSync(H, 'utf8');
const old = '<span class="fine empty-note">Four dated scans, five routine changes, four daily logs. No API units.</span>';
const neu = '<span class="fine empty-note">4 dated scans · 5 routine changes · 4 daily logs · no API units</span>';
if (!h.includes(old)) { console.log('MISS note'); process.exit(1); }
h = h.split(old).join(neu);
fs.writeFileSync(H, h);

let c = fs.readFileSync(C, 'utf8');
c = c.replace('.empty-note { display: block; margin-top: 10px; text-align: center; max-width: 34ch; }', '');
c = c.replace('.empty-note { max-width: 38ch; }', '.empty-note { display: block; margin-top: 14px; text-align: center; max-width: none; white-space: nowrap; letter-spacing: .01em; }');
c = c.replace('.link-btn {\n  margin-top: 12px;', '.link-btn {\n  margin-top: 14px;');
fs.writeFileSync(C, c);
console.log('note:', c.includes('white-space: nowrap'));
