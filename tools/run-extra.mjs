// 驗證暫停記錄／小浮窗按鈕不會壞（PiP 在 headless 可能不支援，允許顯示提示）
import { createRequire } from 'node:module';
const require = createRequire('/home/alex/.hermes/hermes-agent/');
const { chromium } = require('playwright');

const PORT = process.env.PROBE_PORT || 8123;
const IMG = process.env.PROBE_IMG || 'maple_story_ui_patched_1366x768.png';

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (/error/i.test(m.text())) errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/index.html?img=./${IMG}`, { waitUntil: 'commit', timeout: 60000 });
await page.waitForFunction("document.getElementById('expCur').textContent !== '—'", null, { timeout: 150000 });

console.log('PiP 支援:', await page.evaluate("String('documentPictureInPicture' in window)"));

await page.click('#pause');
console.log('暫停後按鈕文字:', await page.evaluate("document.getElementById('pause').textContent"));
console.log('狀態列:', await page.evaluate("document.getElementById('status').textContent"));
await page.waitForTimeout(3000);
await page.click('#pause');
console.log('恢復後按鈕文字:', await page.evaluate("document.getElementById('pause').textContent"));

await page.click('#pip');
await page.waitForTimeout(1500);
console.log('點小浮窗後狀態:', await page.evaluate("document.getElementById('status').textContent"));
console.log('按鈕文字:', await page.evaluate("document.getElementById('pip').textContent"));

console.log('有效記錄時間:', await page.evaluate("document.getElementById('elapsed').textContent"));
const d1 = await page.evaluate('({ ms: window.__diag.timing.elapsedMs, tick: window.__diag.state.tick, paused: window.__diag.state.paused })');
console.log('diag#1:', JSON.stringify(d1));
await page.waitForTimeout(8000);
const d2 = await page.evaluate('({ ms: window.__diag.timing.elapsedMs, tick: window.__diag.state.tick, paused: window.__diag.state.paused })');
console.log('diag#2:', JSON.stringify(d2));
console.log('有效記錄時間(後):', await page.evaluate("document.getElementById('elapsed').textContent"));
console.log(errors.length ? 'JS 錯誤:\n  ' + errors.join('\n  ') : '沒有 JS 錯誤');
await browser.close();
