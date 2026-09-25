// OCR 探針：用真實楓之谷樣本驗證 paddleocr-js 在瀏覽器 (WASM) 的讀值準確度與速度
import { PaddleOCR } from '@paddleocr/paddleocr-js';

const logEl = document.getElementById('log');
const lines = [];
function log(s) { lines.push(String(s)); logEl.textContent = lines.join('\n'); window.__probeLog = lines; console.log(s); }
const ms = (t) => Math.round(performance.now() - t);

const full = document.createElement('canvas');

function cropCanvas(sx, sy, sw, sh, scale = 3, pad = 4, bg = '#000') {
  const w = sw + pad * 2, h = sh + pad * 2;
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(full, sx - pad, sy - pad, w, h, 0, 0, c.width, c.height);
  return c;
}

async function main() {
  window.__probeDone = false;
  const report = {};
  const t0 = performance.now();
  log('建立引擎…');
  const ocr = await PaddleOCR.create({
    worker: true,
    lang: 'ch',
    textDetectionModelName: 'PP-OCRv6_tiny_det',
    textRecognitionModelName: 'PP-OCRv6_small_rec',
    textDetectionBatchSize: 1,
    textRecognitionBatchSize: 1,
    ortOptions: {
      backend: 'wasm',
      wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
      numThreads: 1,
      simd: true,
      proxy: false
    }
  });
  report.engineMs = ms(t0);
  log(`引擎就緒 ${report.engineMs}ms`);

  const url = new URLSearchParams(location.search).get('img') || './maple_story_ui_patched_1366x768.png';
  const img = new Image();
  img.src = url;
  await img.decode();
  full.width = img.naturalWidth; full.height = img.naturalHeight;
  full.getContext('2d').drawImage(img, 0, 0);
  log(`樣本 ${url} ${full.width}x${full.height}`);

  const predict = async (canvas, label) => {
    const t = performance.now();
    const [r] = await ocr.predict(canvas, { textDetLimitSideLen: Math.min(2400, Math.max(canvas.width, canvas.height)) });
    const took = ms(t);
    if (label) log(`  ${label} ${took}ms → ${r.items.map(i => `「${i.text}」${i.score.toFixed(2)}`).join(' ')}`);
    return { took, items: r.items, metrics: r.metrics };
  };

  // --- 階段 1：全圖（模擬「首次定位」）---
  log('階段1 全圖 predict…');
  const whole = await predict(full, '全圖');
  report.fullMs = whole.took;
  report.fullItems = whole.items.map(i => i.text);

  // --- 階段 2：底部帶 12%（模擬 kafuffu20 的 EXP 搜尋）---
  log('階段2 底部帶(12%) predict…');
  const by = Math.round(full.height * 0.88);
  const band = document.createElement('canvas');
  band.width = full.width; band.height = full.height - by;
  band.getContext('2d').drawImage(full, 0, by, full.width, band.height, 0, 0, band.width, band.height);
  const bandRes = await predict(band, '底部帶');
  report.bandMs = bandRes.took;

  // --- 階段 3：從階段 2 的結果推出各欄位的框 ---
  const boxOf = (pred) => {
    const it = bandRes.items.find(i => pred(i.text));
    if (!it) return null;
    const xs = it.poly.map(p => p[0]), ys = it.poly.map(p => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys) + by, x1: Math.max(...xs), y1: Math.max(...ys) + by };
  };
  const expLabel = boxOf(t => /^EXP/i.test(t));
  const lvLabel = boxOf(t => /^LV\.?$/i.test(t));
  const hpLabel = boxOf(t => /^HP/i.test(t));
  const mpLabel = boxOf(t => /^MP/i.test(t));
  log(`定位：EXP=${JSON.stringify(expLabel)} LV=${JSON.stringify(lvLabel)} HP=${JSON.stringify(hpLabel)} MP=${JSON.stringify(mpLabel)}`);

  // 值框：從標籤框往右抓固定寬度（實作時會用偵測到的下一個標籤邊界）
  const boxes = {
    EXP: expLabel && { x: expLabel.x1 + 2, y: expLabel.y - 4, w: 120, h: 22 },
    LV: lvLabel && { x: lvLabel.x1 + 2, y: lvLabel.y - 4, w: 60, h: 22 },
    HP: hpLabel && { x: hpLabel.x1 + 2, y: hpLabel.y - 4, w: 80, h: 22 },
    MP: mpLabel && { x: mpLabel.x1 + 2, y: mpLabel.y - 4, w: 90, h: 22 }
  };

  // --- 階段 4：只讀小框 ×3 輪（模擬實際運行的每 tick 讀取）---
  const reads = {};
  for (const [name, b] of Object.entries(boxes)) {
    if (!b) { log(`${name} 沒有框，跳過`); continue; }
    reads[name] = [];
    for (let i = 0; i < 3; i++) {
      for (const scale of (i === 0 ? [3, 4, 6] : [reads[name][0].scale])) {
        const c = cropCanvas(b.x, b.y, b.w, b.h, scale);
        const r = await predict(c, `${name} s${scale}`);
        reads[name].push({ scale, ms: r.took, text: r.items.map(x => x.text).join(' '), avg: r.items.length ? r.items.reduce((a, x) => a + x.score, 0) / r.items.length : 0 });
        if (i === 0 && /EXP/.test(name) && /%/.test(reads[name][reads[name].length - 1].text)) break;
      }
    }
  }
  report.reads = reads;

  // --- 解析比對 ---
  const norm = (s) => String(s).normalize('NFKC').replace(/[\s,]/g, (m) => (m === ',' ? '' : ' ')).trim();
  const vals = {};
  for (const [k, arr] of Object.entries(reads)) {
    const best = arr.filter(a => a.avg > 0.7).sort((a, b) => a.ms - b.ms)[0] || arr[0];
    vals[k] = best && best.text;
  }
  report.parsed = vals;
  log('解析結果：' + JSON.stringify(vals, null, 0));

  const expText = norm(vals.EXP || '');
  const m = expText.match(/(\d{1,12})\s*[\[(]\s*(\d{1,4})\s*[.\s]\s*(\d{1,3})\s*%/);
  const exp = m ? { cur: +m[1], pct: +(m[2] + '.' + m[3]) } : null;
  const lv = (norm(vals.LV || '').match(/\d{1,3}/) || [])[0];
  log(`比對真值 LV.47 / EXP 456903 / 82.22% / HP 629-812 / MP 3024-3024 → 讀到 LV=${lv} EXP=${exp ? exp.cur : '?'} ${exp ? exp.pct : '?'}%`);
  report.verdict = { lv: +lv, exp, expected: { lv: 47, exp: 456903, pct: 82.22 } };
  report.summary = `引擎 ${report.engineMs}ms｜全圖 ${report.fullMs}ms｜底部帶 ${report.bandMs}ms｜小框 ${Object.entries(reads).map(([k, a]) => k + '=' + Math.min(...a.map(x => x.ms)) + 'ms').join(' ')}`;

  log('=== 摘要：' + report.summary);
  window.__probeReport = report;
  log('done');
  window.__probeDone = true;
}

main().catch(e => { log('ERROR: ' + (e && e.stack || e)); window.__probeDone = true; });
