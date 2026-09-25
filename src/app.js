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
  lv: null, exp: null, hp: null, mp: null,
  session: null, readings: []
};

// ---------- 畫面來源 ----------
const video = $('video');
const frame = document.createElement('canvas');
const frameCtx = frame.getContext('2d', { willReadFrequently: true });
const scratch = document.createElement('canvas');

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
  setStatus(found.length ? `定位完成：${found.join(' / ')}` : '找不到狀態列——請確認遊戲畫面下方看得到 EXP 那條狀態列');
  return found.length > 0;
}

// ---------- 統計 ----------
const timing = { lastExp: null, gain: 0, startedAt: 0, elapsedMs: 0, samples: [], lastLevel: null };

function recordExp(cur, pct) {
  const now = performance.now();
  if (!timing.startedAt) { timing.startedAt = now; timing.lastExp = cur; return; }
  if (timing.lastExp == null) { timing.lastExp = cur; return; }
  let delta = cur - timing.lastExp;
  // 升級：經驗倒退但等級 +1 → 把跨級的量補回來
  if (delta < 0 && state.lv && timing.lastLevel && state.lv === timing.lastLevel + 1) {
    const total = expToNext(timing.lastLevel) || 0;
    delta = total - timing.lastExp + cur;
  }
  if (delta < 0 || delta > 5_000_000) { timing.lastExp = cur; return; } // 明顯是誤讀，只用來校正基準
  timing.gain += delta;
  timing.lastExp = cur;
  timing.elapsedMs = now - timing.startedAt;
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
  $('rate').textContent = Number.isFinite(rate) && rate > 0 ? fmtNum(Math.round(rate)) : '—';

  const total = state.exp ? (expToNext(state.lv) ?? null) : null;
  const remain = total && state.exp ? Math.max(0, total - state.exp.cur) : null;
  $('eta').textContent = remain && Number.isFinite(rate) && rate > 0 ? fmtDuration(remain / rate * 3600000) : '—';
  $('elapsed').textContent = fmtDuration(timing.elapsedMs);
  $('ticks').textContent = String(state.tick);
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
    timing.lastExp = null; timing.gain = 0; timing.startedAt = 0; timing.elapsedMs = 0;
    timing.samples = []; timing.lastLevel = null; state.tick = 0; render();
  });
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
