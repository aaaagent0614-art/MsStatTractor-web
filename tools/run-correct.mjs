// 驗證校正介面：預覽畫框、手動框選、記住框（localStorage）
import { createRequire } from 'node:module';
const require = createRequire('/home/alex/.hermes/hermes-agent/');
const { chromium } = require('playwright');

const PORT = process.env.PROBE_PORT || 8123;
const IMG = process.env.PROBE_IMG || 'maple_story_ui_patched_1366x768.png';
const URL_ = `http://127.0.0.1:${PORT}/index.html?img=./${IMG}`;

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (/error/i.test(m.text())) console.log('[page]', m.text()); });

await page.goto(URL_, { waitUntil: 'commit', timeout: 60000 });
await page.waitForFunction("document.getElementById('expCur').textContent !== '—'", null, { timeout: 150000 });

const previewSize = await page.evaluate("(() => { const c = document.getElementById('preview'); return c.width + 'x' + c.height; })()");
console.log('預覽尺寸:', previewSize);

// 預覽上是否真的畫了東西（非全黑）
const painted = await page.evaluate(`(() => {
  const c = document.getElementById('preview');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let nonBlack = 0;
  for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 60) nonBlack++;
  return nonBlack;
})()`);
console.log('預覽非黑像素樣本數:', painted);

// 手動框選：按「EXP」→ 在預覽上拖一個框（圈左下角那條狀態列）
const before = await page.evaluate("JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('msstattractor.boxes')) || 'null') || '{}')");
console.log('框選前 EXP 框:', JSON.stringify(before.EXP));

await page.click('button[data-field="EXP"]');
const box = await page.locator('#preview').boundingBox();
await page.mouse.move(box.x + 300, box.y + box.height - 30);
await page.mouse.down();
await page.mouse.move(box.x + 480, box.y + box.height - 8, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(500);

const after = await page.evaluate("JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('msstattractor.boxes')) || 'null') || '{}')");
console.log('框選後 EXP 框:', JSON.stringify(after.EXP));
console.log('狀態列:', await page.evaluate("document.getElementById('status').textContent"));

const changed = after.EXP && before.EXP && (after.EXP.x !== before.EXP.x || after.EXP.x1 !== before.EXP.x1);
console.log(changed ? 'VERDICT: PASS（手動框選已生效並寫入 localStorage）' : 'VERDICT: 框選沒有生效');
await browser.close();
