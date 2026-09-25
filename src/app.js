// MsStatTractor Web — PoC
// 瀏覽器擷取遊戲視窗畫面，用本機 OCR 讀 LV / EXP / HP / MP，統計練功效率。
// 不注入遊戲、不讀記憶體、不送出任何操作；畫面只在這台電腦的瀏覽器裡處理。
import { PaddleOCR } from '@paddleocr/paddleocr-js';
import { expToNext, levelExperience } from './levels.js';
import { parseExp, parseHpMp, parseLv, findFieldBoxes } from './detect.js';

const $ = (id) => document.getElementById(id);
const DEV_IMG = new URLSearchParams(location.search).get('img'); // 開發用：餵靜態圖片當畫面來源
const rawTexts = {}; // 每個欄位最近一次的原始 OCR 讀值（診斷用）

const state = {
  engine: null, engineLoading: null,
  stream: null, grabber: null, grabberTrack: null,
  frameW: 0, frameH: 0, boxes: null, boxFrameW: 0, boxFrameH: 0,
  tick: 0, busy: false, running: false, timer: null,
  selecting: null, paused: false, pip: null,
  lv: null, exp: null, hp: null, mp: null,
  session: null, readings: []
};

// ---------- 畫面來源 ----------
const video = $('video');
const frame = document.createElement('canvas');
const frameCtx = frame.getContext('2d', { willReadFrequently: true });
const scratch = document.createElement('canvas');

// ---------- 校正預覽與手動框選 ----------
const preview = $('preview');
const previewCtx = preview.getContext('2d');
const FIELD_COLORS = { EXP: '#4da3ff', LV: '#7cff7c', HP: '#ff7c7c', MP: '#c07cff' };
const boxKey = (w, h) => `msstattractor.boxes.${w}x${h}`;
let dragRect = null;

function saveBoxes() {
  if (!state.boxes || !state.frameW) return;
  try { localStorage.setItem(boxKey(state.frameW, state.frameH), JSON.stringify(state.boxes)); } catch { /* 無痕模式 */ }
}
function loadBoxes(w, h) {
  try {
    const parsed = JSON.parse(localStorage.getItem(boxKey(w, h)) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}
function forgetBoxes(w, h) {
  try { localStorage.removeItem(boxKey(w, h)); } catch { /* ignore */ }
}

function drawPreview() {
  if (!state.frameW || !state.frameH) return;
  const scale = Math.min(1, 880 / state.frameW);
  preview.width = Math.round(state.frameW * scale);
  preview.height = Math.round(state.frameH * scale);
  previewCtx.drawImage(frame, 0, 0, preview.width, preview.height);
  previewCtx.lineWidth = 2;
  previewCtx.font = '12px ui-monospace, monospace';
  for (const [key, b] of Object.entries(state.boxes || {})) {
    const color = key === state.selecting ? '#ffd400' : (FIELD_COLORS[key] || '#fff');
    previewCtx.strokeStyle = color;
    previewCtx.strokeRect(b.x * scale, b.y * scale, (b.x1 - b.x) * scale, (b.y1 - b.y) * scale);
    previewCtx.fillStyle = color;
    previewCtx.fillText(key, b.x * scale, Math.max(12, b.y * scale - 3));
  }
  if (dragRect) {
    previewCtx.strokeStyle = '#ffd400';
    previewCtx.setLineDash([4, 3]);
    previewCtx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
    previewCtx.setLineDash([]);
  }
}

preview.addEventListener('mousedown', (e) => {
  if (!state.selecting) return;
  const r = preview.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  dragRect = { x0: x, y0: y, x, y, w: 0, h: 0 };
  e.preventDefault();
});
preview.addEventListener('mousemove', (e) => {
  if (!dragRect) return;
  const r = preview.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  dragRect = {
    x0: dragRect.x0, y0: dragRect.y0,
    x: Math.min(dragRect.x0, x), y: Math.min(dragRect.y0, y),
    w: Math.abs(x - dragRect.x0), h: Math.abs(y - dragRect.y0)
  };
  drawPreview();
});
window.addEventListener('mouseup', () => {
  if (!dragRect || !state.selecting) return;
  const scale = state.frameW / preview.width;
  const box = {
    x: Math.round(dragRect.x * scale), y: Math.round(dragRect.y * scale),
    x1: Math.round((dragRect.x + dragRect.w) * scale), y1: Math.round((dragRect.y + dragRect.h) * scale)
  };
  if (box.x1 - box.x > 4 && box.y1 - box.y > 4) {
    state.boxes = state.boxes || {};
    state.boxes[state.selecting] = box;
    saveBoxes();
    setStatus(`已框選 ${state.selecting}（${box.x1 - box.x}×${box.y1 - box.y}）`);
  }
  state.selecting = null;
  dragRect = null;
  render();
});

function setStatus(text, kind = '') { $('status').textContent = text; $('status').className = kind; }

async function grabFrame() {
  if (DEV_IMG) {
    if (frame.width !== state.frameW || frame.height !== state.frameH) { frame.width = state.frameW; frame.height = state.frameH; }
    frameCtx.drawImage(devImage, 0, 0);
    return true;
  }
  const track = state.stream?.getVideoTracks()[0];
  if (track && track.readyState === 'live' && typeof ImageCapture === 'function') {
    try {
      if (state.grabberTrack !== track) { state.grabber = new ImageCapture(track); state.grabberTrack = track; }
      // 直接用擷取串流拿 frame：頁面被遊戲視窗蓋住時 <video> 會停止重繪，讀值會凍住
      const bmp = await state.grabber.grabFrame();
      if (frame.width !== bmp.width || frame.height !== bmp.height) { frame.width = bmp.width; frame.height = bmp.height; }
      frameCtx.drawImage(bmp, 0, 0);
      state.frameW = bmp.width; state.frameH = bmp.height;
      bmp.close?.();
      return true;
    } catch { /* 退回 video 元素 */ }
  }
  if (video.readyState >= 2 && video.videoWidth) {
    if (frame.width !== video.videoWidth || frame.height !== video.videoHeight) { frame.width = video.videoWidth; frame.height = video.videoHeight; }
    frameCtx.drawImage(video, 0, 0);
    state.frameW = video.videoWidth; state.frameH = video.videoHeight;
    return true;
  }
  return false;
}

// ---------- OCR ----------
async function engine() {
  if (state.engine) return state.engine;
  if (!state.engineLoading) {
    state.engineLoading = (async () => {
      setStatus('正在準備 OCR 模型（第一次約 30MB，之後會用瀏覽器快取）…');
      const t0 = performance.now();
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
          numThreads: 1, simd: true, proxy: false
        }
      });
      state.engine = ocr;
      setStatus(`OCR 就緒（${Math.round((performance.now() - t0) / 1000)} 秒）`);
      return ocr;
    })().catch((e) => { state.engineLoading = null; throw e; });
  }
  return state.engineLoading;
}

async function predict(image, limitSideLen) {
  const [r] = await engine().then((o) => o.predict(image, { textDetLimitSideLen: limitSideLen }));
  return r;
}

function cropCanvas(box, scale = 3, pad = 4) {
  const w = box.x1 - box.x, h = box.y1 - box.y;
  scratch.width = Math.round((w + pad * 2) * scale);
  scratch.height = Math.round((h + pad * 2) * scale);
  const ctx = scratch.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, scratch.width, scratch.height);
  ctx.drawImage(frame, box.x - pad, box.y - pad, w + pad * 2, h + pad * 2, 0, 0, scratch.width, scratch.height);
  return scratch;
}

async function readBox(box, scale = 3) {
  if (!box) return '';
  const c = cropCanvas(box, scale);
  const r = await predict(c, Math.min(2400, Math.max(c.width, c.height)));
  return r.items.map((i) => i.text).join(' ');
}

/** 首次定位：掃畫面底部 12% 那條狀態列，找出四個欄位的位置。 */
async function locate() {
  // 這個解析度上次記住的框優先（自動定位成功或使用者框選過都會存下來）
  const remembered = loadBoxes(state.frameW, state.frameH);
  if (remembered && Object.keys(remembered).length) {
    state.boxes = remembered;
    state.boxFrameW = state.frameW; state.boxFrameH = state.frameH;
    setStatus(`使用這個解析度記住的框：${Object.keys(remembered).join(' / ')}`);
    return true;
  }
  setStatus('正在找狀態列（LV / EXP / HP / MP）…');
  const bandY = Math.round(state.frameH * 0.88);
  const band = document.createElement('canvas');
  band.width = state.frameW;
  band.height = state.frameH - bandY;
  band.getContext('2d').drawImage(frame, 0, bandY, state.frameW, band.height, 0, 0, band.width, band.height);
  const r = await predict(band, Math.min(2400, Math.max(band.width, band.height)));
  const boxes = findFieldBoxes(r.items, bandY);
  state.boxes = boxes;
  state.boxFrameW = state.frameW; state.boxFrameH = state.frameH;
  const found = Object.keys(boxes);
  if (found.length) saveBoxes();
  setStatus(found.length ? `定位完成：${found.join(' / ')}` : '找不到狀態列——請確認遊戲畫面下方看得到 EXP 那條狀態列，或用下面的「框選」自己圈起來');
  return found.length > 0;
}

// ---------- 統計 ----------
const timing = { lastExp: null, gain: 0, elapsedMs: 0, samples: [], lastLevel: null, lastTickAt: 0 };

/** 有效記錄時間：暫停期間不累加 */
function tickClock() {
  const now = performance.now();
  if (!timing.lastTickAt) { timing.lastTickAt = now; return; }
  if (!state.paused) timing.elapsedMs += now - timing.lastTickAt;
  timing.lastTickAt = now;
}

function recordExp(cur, pct) {
  if (state.paused) { timing.lastExp = cur; return; }
  if (!Number.isFinite(timing.lastExp)) { timing.lastExp = cur; timing.lastLevel = state.lv; return; }
  let delta = cur - timing.lastExp;
  // 升級：經驗倒退但等級 +1 → 把跨級的量補回來
  if (delta < 0 && state.lv && timing.lastLevel && state.lv === timing.lastLevel + 1) {
    const total = expToNext(timing.lastLevel) || 0;
    delta = total - timing.lastExp + cur;
  }
  if (delta < 0 || delta > 5_000_000) { timing.lastExp = cur; timing.lastLevel = state.lv; return; } // 明顯是誤讀，只校正基準
  timing.gain += delta;
  timing.lastExp = cur;
  timing.lastLevel = state.lv;
  timing.samples.push({ t: Math.round(timing.elapsedMs / 1000), gain: timing.gain });
  if (timing.samples.length > 720) timing.samples.shift();
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} 小時 ${m} 分` : `${m} 分 ${s % 60} 秒`;
}

function fmtNum(n) { return Number.isFinite(n) ? n.toLocaleString('zh-TW') : '—'; }

async function readField(name, parser, scales = [3, 4]) {
  const box = state.boxes?.[name];
  if (!box) { rawTexts[name] = '（沒有框）'; return null; }
  let text = '';
  for (const s of scales) {
    text = await readBox(box, s);
    rawTexts[name] = `${text || '(空)'} @${s}x`;
    const v = parser(text);
    if (v) return v;
  }
  return null;
}

// ---------- 主迴圈 ----------
async function tick() {
  if (state.busy || !state.running) return;
  state.busy = true;
  try {
    if (!(await grabFrame())) { setStatus('抓不到畫面（視窗共享可能已停止）', 'bad'); return; }
    // 視窗尺寸變了（換解析度／改視窗大小）→ 重新定位
    if (!state.boxes || state.frameW !== state.boxFrameW || state.frameH !== state.boxFrameH) {
      if (!(await locate())) { state.busy = false; return; }
    }
    state.tick++;

    const exp = await readField('EXP', parseExp);
    if (exp) { state.exp = exp; recordExp(exp.cur, exp.pct); }

    if (state.tick % 3 === 1) {
      const lv = await readField('LV', parseLv);
      if (lv) state.lv = lv;
    }
    if (state.tick % 5 === 1) {
      const hp = await readField('HP', parseHpMp);
      const mp = await readField('MP', parseHpMp);
      if (hp) state.hp = hp;
      if (mp) state.mp = mp;
    }
    render();
  } catch (e) {
    setStatus('讀取錯誤：' + e.message, 'bad');
  } finally {
    tickClock();
    state.busy = false;
  }
}

function render() {
  $('lv').textContent = state.lv ?? '—';
  $('expCur').textContent = state.exp ? fmtNum(state.exp.cur) : '—';
  $('expPct').textContent = state.exp ? state.exp.pct.toFixed(2) + '%' : '—';
  $('hp').textContent = state.hp ? `${fmtNum(state.hp.cur)} / ${fmtNum(state.hp.max)}` : '—';
  $('mp').textContent = state.mp ? `${fmtNum(state.mp.cur)} / ${fmtNum(state.mp.max)}` : '—';
  $('raw').textContent = Object.entries(rawTexts).map(([k, v]) => `${k}「${v}」`).join('　');

  const hours = timing.elapsedMs / 3600000;
  const rate = hours > 0 ? timing.gain / hours : NaN;
  $('gain').textContent = timing.gain ? fmtNum(timing.gain) : '0';
  $('rate').textContent = pipRateText();

  $('eta').textContent = pipEtaText();
  $('elapsed').textContent = fmtDuration(timing.elapsedMs);
  $('ticks').textContent = String(state.tick);
  drawPreview();
  updatePip();
}

// ---------- 置頂小浮窗（子母畫面）----------
const PIP_HTML = `<style>
  body { margin:0; padding:12px; background:#12141a; color:#e8eaf0;
         font-family:"Segoe UI",system-ui,"Microsoft JhengHei",sans-serif }
  .k { font-size:10.5px; color:#8b93a7; margin-top:9px }
  .v { font-size:20px; font-weight:600; font-variant-numeric:tabular-nums }
  .v.big { font-size:28px; color:#8fd0ff }
</style>
<div class="k" style="margin-top:0">EXP / 小時</div><div class="v big" id="pRate">—</div>
<div class="k">本次經驗收益</div><div class="v" id="pGain">0</div>
<div class="k">預計升級</div><div class="v" id="pEta">—</div>
<div class="k">等級 / 經驗</div><div class="v" id="pLv">—</div>
<div class="k">有效記錄時間</div><div class="v" id="pTime">0 分 0 秒</div>`;

function pipRateText() {
  const hours = timing.elapsedMs / 3600000;
  const rate = hours > 0 ? timing.gain / hours : NaN;
  return Number.isFinite(rate) && rate > 0 ? fmtNum(Math.round(rate)) : '—';
}
function pipEtaText() {
  const total = state.exp ? expToNext(state.lv) : null;
  const remain = total && state.exp ? Math.max(0, total - state.exp.cur) : null;
  const hours = timing.elapsedMs / 3600000;
  const rate = hours > 0 ? timing.gain / hours : NaN;
  return remain && Number.isFinite(rate) && rate > 0 ? fmtDuration(remain / rate * 3600000) : '—';
}

async function togglePip() {
  if (state.pip) { state.pip.close(); state.pip = null; $('pip').textContent = '開啟小浮窗'; return; }
  if (!('documentPictureInPicture' in window)) {
    setStatus('這個瀏覽器不支援置頂小浮窗（需要電腦版 Chrome / Edge 116 以上）', 'bad');
    return;
  }
  try {
    const win = await documentPictureInPicture.requestWindow({ width: 240, height: 320 });
    win.document.title = 'MsStatTractor';
    win.document.body.innerHTML = PIP_HTML;
    win.addEventListener('pagehide', () => { state.pip = null; $('pip').textContent = '開啟小浮窗'; });
    state.pip = win;
    $('pip').textContent = '關閉小浮窗';
    updatePip();
  } catch (e) {
    setStatus('開啟小浮窗失敗：' + e.message, 'bad');
  }
}

function updatePip() {
  if (!state.pip) return;
  const d = state.pip.document;
  d.getElementById('pRate').textContent = pipRateText();
  d.getElementById('pGain').textContent = fmtNum(timing.gain);
  d.getElementById('pEta').textContent = pipEtaText();
  d.getElementById('pLv').textContent = `${state.lv ?? '—'}　${state.exp ? state.exp.pct.toFixed(2) + '%' : '—'}`;
  d.getElementById('pTime').textContent = fmtDuration(timing.elapsedMs);
}

function every(fn, ms) {
  // Chrome 會把被蓋住／背景分頁的 timer 降到約 1 分鐘一次，用 Worker 的 timer 驅動才穩定
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = fn;
    return w;
  } catch { return setInterval(fn, ms); }
}

// ---------- 連線 ----------
async function connect() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus('這個瀏覽器不支援視窗共享，請用電腦版 Chrome 或 Edge', 'bad');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 2, max: 5 } }, audio: false });
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', () => { stop(); setStatus('視窗共享已停止'); });
    await engine();
    state.running = true;
    state.timer = state.timer || every(tick, 1000);
    tick();
    render();
  } catch (e) {
    setStatus(e.name === 'NotAllowedError' ? '你取消了視窗選擇' : '無法共享視窗：' + e.message, 'bad');
  }
}

function stop() {
  state.running = false;
  const s = state.stream;
  state.stream = null;
  s?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  state.boxes = null;
}

// ---------- 啟動 ----------
let devImage = null;
(async function boot() {
  $('pick').addEventListener('click', connect);
  $('reset').addEventListener('click', () => {
    timing.lastExp = null; timing.gain = 0; timing.lastTickAt = 0; timing.elapsedMs = 0;
    timing.samples = []; timing.lastLevel = null; state.tick = 0; render();
  });
  $('pause').addEventListener('click', () => {
    state.paused = !state.paused;
    $('pause').textContent = state.paused ? '繼續記錄' : '暫停記錄';
    setStatus(state.paused ? '已暫停記錄（畫面仍持續讀取，暫停期間不計入收益）' : '繼續記錄');
  });
  $('pip').addEventListener('click', togglePip);
  document.querySelectorAll('button[data-field]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.frameW) { setStatus('先按「選擇遊戲視窗」才能框選', 'bad'); return; }
      state.selecting = btn.dataset.field;
      setStatus(`請在下面的畫面上拖曳，框住「${btn.textContent.trim()}」的數字`);
      render();
    });
  });
  $('relocate').addEventListener('click', () => {
    forgetBoxes(state.frameW, state.frameH);
    state.boxes = null;
    setStatus('已清除記住的框，下一輪重新自動定位');
    render();
  });
  window.__diag = { state, timing }; // 除錯用：測試腳本可讀內部狀態
  if (DEV_IMG) {
    // 開發模式：用靜態圖片當畫面來源，驗證整條管線（沒有 getDisplayMedia）
    devImage = new Image();
    devImage.src = DEV_IMG;
    await devImage.decode();
    state.frameW = devImage.naturalWidth; state.frameH = devImage.naturalHeight;
    frame.width = state.frameW; frame.height = state.frameH;
    $('pick').textContent = '開發模式：使用靜態圖片';
    await engine();
    state.running = true;
    state.timer = state.timer || every(tick, 1200);
    tick();
  } else {
    setStatus('先按「選擇遊戲視窗」');
    // ?preload=1：先把模型抓好（頁面剛開就先下載，之後按下去就能直接開始）
    if (new URLSearchParams(location.search).has('preload')) {
      engine()
        .then(() => setStatus('OCR 模型已就緒，可以按「選擇遊戲視窗」開始'))
        .catch((e) => setStatus('模型載入失敗：' + e.message, 'bad'));
    }
  }
})();
