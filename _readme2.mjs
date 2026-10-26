import fs from 'node:fs';
const F = 'c:/CRYPTO MONEY MAKER/skin-ledger/README.md';
let s = fs.readFileSync(F, 'utf8');
if (s.includes('## Demo')) { console.log('sudah ada'); process.exit(0); }
const L = [
  '## Demo',
  '',
  '[demo.mp4](demo.mp4) — 58 seconds, no narration, the shipped UI end to end: four dated scans,',
  'the baseline comparison, what changed and what followed, daily factors, a label photo parsed',
  'into a composition, and the copilot answering from the dated numbers only. Captions in [demo.srt](demo.srt).',
  '',
  'The app runs locally with no YouCam units spent:',
  '',
  '    npm install',
  '    npm start          # http://localhost:4173',
  '',
  'Set YOUCAM_API_KEY to hit the real API; without it the app runs on the bundled sample record.',
  '',
  ''
];
s = s.replace('## Screenshots', L.join('\n') + '## Screenshots');
fs.writeFileSync(F, s);
console.log('README: bagian Demo ditambahkan');
