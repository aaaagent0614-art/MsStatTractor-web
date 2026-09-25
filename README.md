# MsStatTractor Web（瀏覽器版）

楓之谷練功追蹤工具的**網頁版**：不裝任何 exe、沒有背景程式、不注入遊戲、不讀取記憶體，
只用瀏覽器內建的「視窗擷取」加本機 OCR，讀畫面上的 LV / EXP / HP / MP，統計練功效率與升級預估。

畫面（frames）只在你自己的瀏覽器裡處理，不會上傳到任何伺服器。

> 為什麼要做網頁版：遊戲官方會偵測後台開著的其他執行檔，而網頁版沒有任何自己的程式在跑。

## 用法

1. 用**電腦版 Chrome 或 Edge** 開這個頁面。
2. 按「選擇遊戲視窗」，在清單裡選**楓之谷**（如果你用 Magpie 之類的放大工具，就選放大後的那個視窗）。
3. 第一次會下載約 30MB 的辨識模型（之後靠瀏覽器快取，不會再下載）。
4. 頁面保持開著即可；遊戲視窗被其他視窗蓋住也讀得到。

## 開發

```bash
npm install
npm run build      # 產出 dist/
npm run serve      # 本機起 http server 看 build 結果
```

驗證用的探針（餵靜態樣本圖跑整條管線，不需要真的開遊戲）：

```bash
node tools/run-app.mjs    # 需要一個 http server 服務 dist/（見 tools/serve.mjs）
```

## 技術組成

- 畫面擷取：`navigator.mediaDevices.getDisplayMedia()` + `ImageCapture.grabFrame()`
- OCR：[`@paddleocr/paddleocr-js`](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js)（PaddleOCR 官方瀏覽器 SDK，ONNX Runtime Web / WASM，跑在 Web Worker）
- 模型：PP-OCRv6 tiny det + small rec（PaddleOCR 官方模型，Apache-2.0）
- 定位：先掃畫面底部 12% 找 `EXP` / `LV.` / `HP` / `MP` 標籤，再推出各欄位的讀取框
- 統計、等級經驗表：`src/levels.js`（社群資料，非官方）

## 檔案

- `index.html` / `src/app.js`：主程式
- `src/detect.js`：OCR 文字解析 + 欄位定位
- `src/levels.js`：各等級升級所需經驗值
- `tools/`：開發／驗證用（probe = 引擎與讀值探針、run-app = 整條管線測試）
