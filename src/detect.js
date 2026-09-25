// 文字解析 + 欄位定位（從 OCR 的文字塊推出 EXP / LV / HP / MP 的讀取框）

/** OCR 常把 82.22% 讀成「82 22%」、或把逗號吃掉。這裡全部容錯。 */
export function parseExp(text) {
  const v = String(text).normalize('NFKC')
    .replace(/[【〔［]/g, '[').replace(/[】〕］]/g, ']')
    .replace(/,/g, '').replace(/\s+/g, ' ').trim();
  const m = v.match(/(\d{1,12})\s*[\[(]\s*(\d{1,4})(?:\s*[.。·:：]\s*(\d{1,3})|\s+(\d{1,3}))?\s*%/);
  if (!m) return null;
  const dec = m[3] ?? m[4];
  const pct = dec != null ? Number(`${m[2]}.${dec}`) : Number(m[2]);
  const cur = Number(m[1]);
  if (!Number.isSafeInteger(cur) || cur < 0) return null;
  if (!(pct >= 0 && pct < 100)) return null;
  return { cur, pct };
}

/** 'HP [629/812]' / '[629/812]' / '629/812' → {cur, max} */
export function parseHpMp(text) {
  const v = String(text).normalize('NFKC').replace(/,/g, '').replace(/\s+/g, ' ').trim();
  const m = v.match(/(\d{1,9})\s*\/\s*(\d{1,9})/);
  if (!m) return null;
  const cur = Number(m[1]), max = Number(m[2]);
  if (!Number.isSafeInteger(cur) || !Number.isSafeInteger(max) || max <= 0) return null;
  return { cur, max };
}

/** '47' / 'LV. 47' / 'LV.47' → 47 */
export function parseLv(text) {
  const v = String(text).normalize('NFKC').replace(/\s+/g, ' ').trim();
  const m = v.match(/(?:L\s*V\.?\s*[.:]?\s*)?(\d{1,3})(?!\d)/i) || v.match(/(\d{1,3})/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : null;
}

/**
 * 從「底部帶」的 OCR 結果找出四個欄位的讀取框。
 * items 的座標是相對底部帶；bandY 是帶在全圖中的 y 起點。
 * 回傳像素框（相對於整張 frame），找不到的欄位不會出現。
 */
export function findFieldBoxes(items, bandY) {
  const abs = items.map((it) => {
    const xs = it.poly.map((p) => p[0]);
    const ys = it.poly.map((p) => p[1]);
    return {
      text: it.text, score: it.score,
      x0: Math.min(...xs), x1: Math.max(...xs),
      y0: Math.min(...ys) + bandY, y1: Math.max(...ys) + bandY
    };
  });

  // 同一種標籤可能出現多次（怪物名牌、聊天訊息），取最下面那一個——狀態列一定在畫面底部
  const lowest = (re) => abs.filter((a) => re.test(a.text.trim())).sort((a, b) => b.y0 - a.y0)[0];
  const labels = {
    EXP: lowest(/^EXP/i),
    LV: lowest(/^L\s*V\.?\s*[.:]?\s*\d{0,3}$/i) || lowest(/^L\s*V/i),
    HP: lowest(/^HP\b/i),
    MP: lowest(/^MP\b/i)
  };

  const boxes = {};
  for (const [key, lab] of Object.entries(labels)) {
    if (!lab) continue;
    const h = Math.max(6, lab.y1 - lab.y0);
    const padY = Math.max(3, Math.round(h * 0.35));
    // 標籤自己就跟數字黏在一起（'HP [629/812]'、'EXP 456903[82.22%]'）→ 直接讀那一塊，
    // 不能再去右邊找值（會撈到隔壁 MP 的數字）
    if (/\d/.test(lab.text)) {
      boxes[key] = {
        x: Math.round(lab.x0 - 4), y: Math.round(lab.y0 - padY),
        x1: Math.round(lab.x1 + 24), y1: Math.round(lab.y1 + padY)
      };
      continue;
    }
    const midY = (lab.y0 + lab.y1) / 2;
    // 同一行、緊鄰標籤右邊的文字塊就是它的值：太遠的（例如隔壁的 HP 數字）不能算
    const near = Math.max(70, h * 5);
    const value = abs
      .filter((a) => a !== lab && a.x0 >= lab.x1 - 2 && a.x0 - lab.x1 < near
        && Math.abs((a.y0 + a.y1) / 2 - midY) < h * 1.2 && /\d/.test(a.text))
      .sort((a, b) => a.x0 - b.x0)[0];
    if (value) {
      boxes[key] = {
        x: Math.round(lab.x1 + 1), y: Math.round(Math.min(lab.y0, value.y0) - padY),
        x1: Math.round(Math.max(value.x1, lab.x1 + 40) + 20), y1: Math.round(Math.max(lab.y1, value.y1) + padY)
      };
    } else {
      // 值沒被偵測到（小字常常整個漏掉）：往右留一段該欄位夠用的固定寬度
      const w = { EXP: 220, LV: 90, HP: 130, MP: 130 }[key] ?? 150;
      boxes[key] = {
        x: Math.round(lab.x1 + 1), y: Math.round(lab.y0 - padY),
        x1: Math.round(lab.x1 + w), y1: Math.round(lab.y1 + padY)
      };
    }
  }
  return boxes;
}
