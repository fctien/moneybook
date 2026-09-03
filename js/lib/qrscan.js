/**
 * 從一張照片裡找出 QR Code。
 *
 * 為什麼不用即時相機（getUserMedia）：
 * iOS 上安裝成主畫面 App 後，getUserMedia 的權限不會被記住、會反覆跳授權，
 * iOS 26 還有畫面轉 90 度的問題。改用 <input type="file" capture> 叫出系統相機
 * 拍一張靜態照片，再從照片解碼，完全避開這些坑，也不需要任何權限提示。
 *
 * 為什麼不用瀏覽器內建的 BarcodeDetector：
 * Safari 不支援，而這個 App 的主要使用情境就是 iPhone。
 *
 * 一張電子發票上有「兩個」QR，jsQR 一次只回傳一個，因此找到第一個之後
 * 把它的位置塗白再掃一次，才拿得到第二個。
 */

const JSQR_SRC = './js/lib/jsqr.js';
const MAX_QR_PER_IMAGE = 2;

// 解析度太低會掃不到小尺寸的 QR，太高則在手機上慢得離譜。
// 由小往大試，多數情況第一輪就會成功。
const SCAN_WIDTHS = [1280, 1920, 2560];

let loadingPromise = null;

/**
 * 延遲載入 jsQR。
 *
 * 這支函式庫是 UMD 格式，會把自己掛到 window.jsQR，所以用傳統 script 標籤載入
 * 而不是 import —— 這樣就不必修改第三方原始碼。只有使用者真的按下「掃發票」
 * 才會載入，不影響 App 啟動速度；檔案本身列在 APP_SHELL 裡，離線時也讀得到。
 */
function loadJsQR() {
  if (globalThis.jsQR) return Promise.resolve(globalThis.jsQR);
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = JSQR_SRC;
    script.async = true;
    script.onload = () => {
      if (globalThis.jsQR) resolve(globalThis.jsQR);
      else reject(new Error('jsQR 載入了但沒有註冊到全域'));
    };
    script.onerror = () => reject(new Error('QR 解碼元件載入失敗'));
    document.head.append(script);
  }).catch((err) => {
    loadingPromise = null; // 允許重試
    throw err;
  });

  return loadingPromise;
}

/** 把 File 讀成可以畫到 canvas 的圖片 */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('讀不到這張照片')); };
    img.src = url;
  });
}

/** 依目標寬度把圖片畫到 canvas，回傳 2D context */
function drawToCanvas(img, targetWidth) {
  const scale = Math.min(1, targetWidth / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return ctx;
}

/** 把已經找到的 QR 區域塗白，避免下一輪又掃到同一個 */
function maskFound(ctx, location) {
  const pts = [
    location.topLeftCorner, location.topRightCorner,
    location.bottomRightCorner, location.bottomLeftCorner,
  ].filter(Boolean);
  if (pts.length < 3) return;

  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  // 稍微外擴，避免殘留的定位圖案又被辨識成 QR
  ctx.lineWidth = 12;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

/**
 * 在單一解析度下盡量掃出多個 QR。
 * @returns {{text:string, bytes:Uint8Array}[]}
 */
function scanAll(jsQR, ctx) {
  const { width, height } = ctx.canvas;
  const found = [];

  for (let i = 0; i < MAX_QR_PER_IMAGE; i += 1) {
    const imageData = ctx.getImageData(0, 0, width, height);
    // inversionAttempts: 熱感應紙有時偏灰，兩種都試命中率較高
    const code = jsQR(imageData.data, width, height, { inversionAttempts: 'attemptBoth' });
    if (!code) break;

    found.push({
      text: code.data,
      bytes: code.binaryData ? Uint8Array.from(code.binaryData) : null,
    });

    if (!code.location) break;
    maskFound(ctx, code.location);
  }

  return found;
}

/**
 * 從照片中掃出所有 QR Code。
 *
 * @param {File|Blob} file 使用者拍的照片
 * @returns {Promise<{text:string, bytes:Uint8Array|null}[]>} 依找到順序排列
 */
export async function scanQRCodesFromImage(file) {
  if (!file) throw new Error('沒有選到照片');

  const [jsQR, img] = await Promise.all([loadJsQR(), loadImage(file)]);

  let best = [];
  for (const width of SCAN_WIDTHS) {
    // 原圖比目標還小就不必再往上試
    if (best.length && width > img.naturalWidth) break;

    const ctx = drawToCanvas(img, width);
    const found = scanAll(jsQR, ctx);
    if (found.length > best.length) best = found;
    if (best.length >= MAX_QR_PER_IMAGE) break;
    if (width >= img.naturalWidth) break;
  }

  return best;
}

/**
 * 叫出系統相機（或相簿）讓使用者拍一張照片。
 *
 * capture="environment" 在手機上會直接開後鏡頭；桌機瀏覽器會退化成選檔案，
 * 兩邊都能用，因此不需要為桌機另外寫一套。
 *
 * @returns {Promise<File|null>} 取消時回傳 null
 */
export function capturePhoto() {
  return new Promise((resolve) => {
    const input = el();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // 使用者按取消時不會觸發 change，靠視窗重新取得焦點來收尾，
    // 否則這個 Promise 會永遠掛著
    globalThis.addEventListener('focus', () => setTimeout(() => finish(input.files?.[0] ?? null), 600), { once: true });

    document.body.append(input);
    input.click();
  });

  function el() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    return input;
  }
}
