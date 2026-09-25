// 用 Playwright（headless Chromium）跑探針頁，驗證瀏覽器端 OCR 讀值
import { createRequire } from 'node:module';
const require = createRequire('/home/alex/.hermes/hermes-agent/');
const { chromium } = require('playwright');

const PORT = process.env.PROBE_PORT || 8123;
const IMG = process.env.PROBE_IMG || 'maple_story_ui_patched_1366x768.png';

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (!/^\[vite\]/.test(t)) console.log('[page]', t); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('requestfailed', r => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText));

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/tools/probe.html?img=../${IMG}`, { waitUntil: 'commit', timeout: 60000 });
try {
  await page.waitForFunction('window.__probeDone === true', null, { timeout: 420000 });
} catch (e) {
  console.log('TIMEOUT after', Math.round((Date.now() - t0) / 1000), 's');
}
const log = await page.evaluate('(window.__probeLog||["<no log>"]).join("\\n")');
console.log(log);
console.log(`--- 總耗時 ${Math.round((Date.now() - t0) / 1000)}s ---`);
await browser.close();
