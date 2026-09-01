/**
 * Canvas 圖表。
 *
 * 刻意不引入 Chart.js 之類的套件：這個 App 要能完全離線運作，
 * 任何 CDN 相依都會在飛航模式下變成一片空白。三種圖自己畫也不過兩百行。
 *
 * 所有圖表都依 devicePixelRatio 放大畫布再縮回 CSS 尺寸，
 * 否則在手機的高解析度螢幕上線條會糊掉。
 */

import { formatAmount } from './lib/money.js';

/** 準備高解析度畫布，回傳 2D context 與 CSS 像素尺寸 */
function setupCanvas(canvas) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height || canvas.clientHeight || 180));

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** 讀取目前主題的 CSS 變數，讓圖表跟著深色模式走 */
function theme() {
  const style = getComputedStyle(document.documentElement);
  const get = (name, fallback) => (style.getPropertyValue(name) || '').trim() || fallback;
  return {
    text: get('--c-text', '#1f2937'),
    muted: get('--c-text-muted', '#6b7280'),
    grid: get('--c-border', '#e5e7eb'),
    income: get('--c-income', '#16a34a'),
    expense: get('--c-expense', '#dc2626'),
    accent: get('--c-accent', '#2563eb'),
    surface: get('--c-surface', '#ffffff'),
  };
}

function fontStack(size, weight = 400) {
  return `${weight} ${size}px system-ui, -apple-system, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
}

/** 座標軸金額標籤：太長會擠爆手機畫面，超過萬元就縮寫 */
function axisLabel(cents) {
  const units = Math.abs(cents) / 100;
  if (units >= 10000) return `${(units / 10000).toFixed(units >= 100000 ? 0 : 1)}萬`;
  if (units >= 1000) return `${Math.round(units / 1000)}k`;
  return formatAmount(cents, { decimals: 'never' });
}

/**
 * 月收支雙長條圖。
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{month:string, income:number, expense:number}>} rows
 * @param {{labels?:string[]}} [opt]
 */
export function drawMonthlyBars(canvas, rows, opt = {}) {
  const { ctx, width, height } = setupCanvas(canvas);
  const t = theme();
  const labels = opt.labels ?? rows.map((r) => r.month.slice(5).replace(/^0/, '') + '月');

  if (!rows.length) return drawEmpty(ctx, width, height, t, '尚無資料');

  const padding = { top: 16, right: 8, bottom: 26, left: 44 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const max = Math.max(1, ...rows.flatMap((r) => [r.income, r.expense]));
  const scale = plotH / (max * 1.1);

  // 水平格線與 Y 軸標籤
  ctx.strokeStyle = t.grid;
  ctx.fillStyle = t.muted;
  ctx.font = fontStack(10);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;

  for (let i = 0; i <= 2; i++) {
    const value = (max * 1.1 * i) / 2;
    const y = Math.round(padding.top + plotH - value * scale) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(axisLabel(value), padding.left - 6, y);
  }

  const slot = plotW / rows.length;
  const barW = Math.max(4, Math.min(14, slot / 3));
  const gap = 3;

  rows.forEach((row, i) => {
    const center = padding.left + slot * i + slot / 2;
    const baseline = padding.top + plotH;

    for (const [value, color, offset] of [
      [row.income, t.income, -(barW + gap) / 2],
      [row.expense, t.expense, (barW + gap) / 2],
    ]) {
      const h = Math.max(value > 0 ? 2 : 0, value * scale);
      if (h <= 0) continue;
      ctx.fillStyle = color;
      roundRect(ctx, center + offset - barW / 2, baseline - h, barW, h, Math.min(3, barW / 2));
      ctx.fill();
    }

    ctx.fillStyle = t.muted;
    ctx.font = fontStack(10);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(labels[i] ?? '', center, baseline + 7);
  });
}

/**
 * 分類佔比甜甜圈圖。
 * @param {Array<{label:string, value:number, color:string}>} slices
 * @param {{centerTop?:string, centerBottom?:string}} [opt] 圓心文字
 */
export function drawDonut(canvas, slices, opt = {}) {
  const { ctx, width, height } = setupCanvas(canvas);
  const t = theme();

  const data = (slices ?? []).filter((s) => s.value > 0);
  if (!data.length) return drawEmpty(ctx, width, height, t, '本月尚無資料');

  const total = data.reduce((a, s) => a + s.value, 0);
  const cx = width / 2;
  const cy = height / 2;
  const outer = Math.min(width, height) / 2 - 6;
  const inner = outer * 0.62;

  let angle = -Math.PI / 2; // 從 12 點鐘方向開始
  for (const slice of data) {
    const sweep = (slice.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, angle, angle + sweep);
    ctx.arc(cx, cy, inner, angle + sweep, angle, true);
    ctx.closePath();
    ctx.fillStyle = slice.color || t.accent;
    ctx.fill();
    // 分隔線讓相鄰同色系區塊不會糊在一起
    ctx.strokeStyle = t.surface;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    angle += sweep;
  }

  if (opt.centerTop) {
    ctx.fillStyle = t.muted;
    ctx.font = fontStack(11);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(opt.centerTop, cx, cy - 4);
  }
  if (opt.centerBottom) {
    ctx.fillStyle = t.text;
    ctx.font = fontStack(16, 600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(opt.centerBottom, cx, cy + 2);
  }
}

/**
 * 淨資產趨勢折線圖。
 * @param {Array<{label:string, value:number}>} points
 */
export function drawLine(canvas, points) {
  const { ctx, width, height } = setupCanvas(canvas);
  const t = theme();

  const data = points ?? [];
  if (data.length < 2) {
    return drawEmpty(ctx, width, height, t, data.length === 1 ? '至少需要兩筆快照才能畫趨勢' : '尚無淨資產快照');
  }

  const padding = { top: 14, right: 12, bottom: 24, left: 48 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const values = data.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1000; max += 1000; }
  const span = max - min;
  min -= span * 0.1;
  max += span * 0.1;

  const x = (i) => padding.left + (plotW * i) / (data.length - 1);
  const y = (v) => padding.top + plotH - ((v - min) / (max - min)) * plotH;

  // 格線 + Y 軸
  ctx.strokeStyle = t.grid;
  ctx.fillStyle = t.muted;
  ctx.font = fontStack(10);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const value = min + ((max - min) * i) / 2;
    const yy = Math.round(y(value)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padding.left, yy);
    ctx.lineTo(width - padding.right, yy);
    ctx.stroke();
    ctx.fillText(axisLabel(value), padding.left - 6, yy);
  }

  // 零軸畫成實線，讓「由正轉負」一眼看得出來
  if (min < 0 && max > 0) {
    const zeroY = Math.round(y(0)) + 0.5;
    ctx.strokeStyle = t.expense;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padding.left, zeroY);
    ctx.lineTo(width - padding.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 區域填色
  const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
  gradient.addColorStop(0, hexToRgba(t.accent, 0.28));
  gradient.addColorStop(1, hexToRgba(t.accent, 0));
  ctx.beginPath();
  ctx.moveTo(x(0), y(values[0]));
  data.forEach((p, i) => ctx.lineTo(x(i), y(p.value)));
  ctx.lineTo(x(data.length - 1), padding.top + plotH);
  ctx.lineTo(x(0), padding.top + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // 折線
  ctx.beginPath();
  data.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.value)) : ctx.lineTo(x(i), y(p.value))));
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 資料點
  ctx.fillStyle = t.accent;
  data.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(x(i), y(p.value), 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // X 軸標籤：點多時只標頭尾與中間，避免文字重疊
  ctx.fillStyle = t.muted;
  ctx.font = fontStack(10);
  ctx.textBaseline = 'top';
  const step = Math.max(1, Math.ceil(data.length / 4));
  data.forEach((p, i) => {
    if (i % step !== 0 && i !== data.length - 1) return;
    ctx.textAlign = i === 0 ? 'left' : i === data.length - 1 ? 'right' : 'center';
    ctx.fillText(p.label ?? '', x(i), padding.top + plotH + 7);
  });
}

function drawEmpty(ctx, width, height, t, message) {
  ctx.fillStyle = t.muted;
  ctx.font = fontStack(12);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return `rgba(37, 99, 235, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
