/**
 * 日期工具。
 *
 * 全部以本地時區的 'YYYY-MM-DD' 字串為主要表示法。
 * 刻意不使用 Date.toISOString()，因為它會轉成 UTC，在台灣（UTC+8）
 * 會讓凌晨 8 點前記的帳掉到前一天。
 */

const MONTH_LABEL = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'];

/** Date 物件 → 'YYYY-MM-DD'（本地時區） */
export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' → 本地時區的 Date（當天 00:00） */
export function fromISODate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 擋掉 2025-02-30 這種會被 Date 自動進位的無效日期
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return null;
  }
  return d;
}

export function isValidISODate(iso) {
  return fromISODate(iso) !== null;
}

export function todayISO(now = new Date()) {
  return toISODate(now);
}

/** 'YYYY-MM-DD' → 'YYYY-MM' */
export function monthKey(iso) {
  return typeof iso === 'string' && iso.length >= 7 ? iso.slice(0, 7) : '';
}

export function currentMonthKey(now = new Date()) {
  return monthKey(toISODate(now));
}

/** 月份位移，delta 可為負。'2025-01' + (-1) → '2024-12' */
export function shiftMonth(key, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? '');
  if (!m) return key;
  let year = Number(m[1]);
  let month = Number(m[2]) - 1 + delta;
  year += Math.floor(month / 12);
  month = ((month % 12) + 12) % 12;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** 該月的第一天與最後一天（含），皆為 'YYYY-MM-DD' */
export function monthRange(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const last = new Date(year, month, 0).getDate();
  return { start: `${key}-01`, end: `${key}-${String(last).padStart(2, '0')}` };
}

/** 產生從 endKey 往回數 count 個月的清單（由舊到新） */
export function recentMonths(endKey, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(shiftMonth(endKey, -i));
  return out;
}

/** '2025-03' → '2025年3月' */
export function formatMonthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? '');
  if (!m) return key ?? '';
  return `${m[1]}年${Number(m[2])}月`;
}

/** '2025-03' → '3月'（圖表軸用，跨年時補上年份） */
export function formatMonthShort(key, withYear = false) {
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? '');
  if (!m) return key ?? '';
  const label = MONTH_LABEL[Number(m[2]) - 1];
  return withYear ? `${m[1].slice(2)}/${Number(m[2])}` : label;
}

/** '2025-03-09' → '3/9 (日)' */
export function formatDayLabel(iso) {
  const d = fromISODate(iso);
  if (!d) return iso ?? '';
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAY_LABEL[d.getDay()]})`;
}

/** 相對描述：今天 / 昨天 / 3/9 (日) */
export function formatRelativeDay(iso, now = new Date()) {
  const today = toISODate(now);
  if (iso === today) return '今天';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (iso === toISODate(yesterday)) return '昨天';
  return formatDayLabel(iso);
}

/** 兩個 ISO 日期相差幾天（b - a），無效輸入回傳 null */
export function daysBetween(a, b) {
  const da = fromISODate(a);
  const db = fromISODate(b);
  if (!da || !db) return null;
  return Math.round((db - da) / 86400000);
}

/** iso 是否落在 [start, end] 之間（字串比較即可，因為格式固定寬度） */
export function isWithin(iso, start, end) {
  if (typeof iso !== 'string') return false;
  if (start && iso < start) return false;
  if (end && iso > end) return false;
  return true;
}
