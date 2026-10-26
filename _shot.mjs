import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome' });
const p = await (await b.newContext({ viewport: { width: 1180, height: 940 }, deviceScaleFactor: 1 })).newPage();
await p.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await p.waitForTimeout(700);
const info = await p.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const btns = [...document.querySelectorAll('#capture button')].filter(vis).map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.id || el.textContent.trim().slice(0, 22), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: el.textContent.trim().slice(0, 26) };
  });
  const cap = document.querySelector('#capture').getBoundingClientRect();
  return { btns, cap: { w: Math.round(cap.width), h: Math.round(cap.height) }, scrollW: document.documentElement.scrollWidth };
});
console.log(JSON.stringify(info, null, 1));
await p.locator('#capture').screenshot({ path: 'c:/CRYPTO MONEY MAKER/skin-ledger/shots/08-capture-tidy.png' });
await b.close();
