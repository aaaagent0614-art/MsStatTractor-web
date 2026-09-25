// 用 Playwright 跑 app 的開發模式（靜態圖片當畫面來源），驗證整條管線
import { createRequire } from 'node:module';
const require = createRequire('/home/alex/.hermes/hermes-agent/');
const { chromium } = require('playwright');

const PORT = process.env.PROBE_PORT || 8123;
const IMG = process.env.PROBE_IMG || 'maple_story_ui_patched_1366x768.png';

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { const t = m.text(); if (/error|Error/i.test(t)) console.log('[page]', t); });

const snap = async (label) => {
  const v = await page.evaluate(`(() => {
    const g = (id) => document.getElementById(id).textContent.trim();
    return { lv: g('lv'), expCur: g('expCur'), expPct: g('expPct'), hp: g('hp'), mp: g('mp'),
             gain: g('gain'), rate: g('rate'), eta: g('eta'), ticks: g('ticks'), status: g('status'), raw: g('raw') };
  })()`);
  console.log(`--- ${label} ---`);
  for (const [k, val] of Object.entries(v)) if (val) console.log(`  ${k}: ${val}`);
  return v;
};

await page.goto(`http://127.0.0.1:${PORT}/index.html?img=./${IMG}`, { waitUntil: 'commit', timeout: 60000 });
try {
  await page.waitForFunction("document.getElementById('expCur').textContent !== '—'", null, { timeout: 150000 });
} catch { console.log('!! 等不到 EXP 讀值'); }

const first = await snap('第一次定位後');
await page.waitForTimeout(12000);
await snap('再跑 12 秒後');

const want = { lv: '47', expCur: '456,903', expPct: '82.22%', hp: '629 / 812', mp: '3,024 / 3,024' };
const bad = Object.entries(want).filter(([k, v]) => first[k] !== v);
console.log(bad.length
  ? `VERDICT: 不符預期 → ${bad.map(([k, v]) => `${k} 應為 ${v}，實際 ${first[k]}`).join('；')}`
  : 'VERDICT: PASS（LV 47 / EXP 456,903 / 82.22% / HP 629-812 / MP 3024-3024 全對）');
await browser.close();
