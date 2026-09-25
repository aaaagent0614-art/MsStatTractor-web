// 驗證線上（GitHub Pages）版本：頁面載入、資源取得、OCR 引擎初始化
import { createRequire } from 'node:module';
const require = createRequire('/home/alex/.hermes/hermes-agent/');
const { chromium } = require('playwright');

const URL_ = process.env.URL || 'https://aaaagent0614-art.github.io/MsStatTractor-web/';

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (/error/i.test(m.text())) errors.push('console: ' + m.text()); });
page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url().slice(0, 100) + ' ' + r.failure()?.errorText));

const t0 = Date.now();
await page.goto(URL_ + '?preload=1', { waitUntil: 'load', timeout: 60000 });
console.log('標題:', await page.title());

try {
  await page.waitForFunction("document.getElementById('status').textContent.includes('就緒')", null, { timeout: 180000 });
  console.log('引擎初始化: OK');
} catch {
  console.log('引擎初始化: 逾時');
}
console.log('狀態列:', await page.evaluate("document.getElementById('status').textContent"));
console.log('按鈕:', await page.evaluate("document.getElementById('pick').textContent"));
console.log(`耗時 ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(errors.length ? '問題:\n  ' + errors.slice(0, 10).join('\n  ') : '沒有任何 JS 錯誤 / 資源載入失敗');
await browser.close();
