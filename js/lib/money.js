/**
 * 金額處理。
 *
 * 內部一律以「分」(cents) 為單位的整數儲存，避免浮點誤差
 * （0.1 + 0.2 !== 0.3 這種問題在記帳程式裡會累積成對不起來的帳）。
 *
 * 解析輸入時走純字串路徑，完全不做 value * 100 這種浮點乘法，
 * 因為 19.995 * 100 在 IEEE 754 下會得到 1999.4999999999998。
 *
 * 有號數規則：資產為正、負債為負。淨資產 = 所有帳戶餘額直接相加。
 */

/** 一元 = 100 分 */
export const CENTS_PER_UNIT = 100;

/** 整數部分超過這個位數就視為輸入錯誤，避免超出 Number 安全整數範圍 */
const MAX_WHOLE_DIGITS = 15;

/**
 * 把使用者輸入的字串或數字解析成 cents。
 * 接受 "1234"、"1,234"、"1234.5"、"-99.99"、全形數字、開頭結尾空白。
 * 解析失敗回傳 null（呼叫端負責顯示錯誤，不要用 0 蓋掉，
 * 否則使用者會以為自己記了一筆 0 元的帳）。
 */
export function parseAmount(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input * CENTS_PER_UNIT) : null;
  }
  if (typeof input !== 'string') return null;

  const s = normalizeNumeric(input);
  if (s === '') return null;

  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;

  const whole = m[2] ?? '';
  const frac = m[3] ?? '';
  if (whole === '' && frac === '') return null; // 只打了 "-" 或 "."
  if (whole.length > MAX_WHOLE_DIGITS) return null;

  const sign = m[1] === '-' ? -1 : 1;
  const wholeCents = (whole === '' ? 0 : Number(whole)) * CENTS_PER_UNIT;
  const fracCents = Number((frac[0] ?? '0') + (frac[1] ?? '0'));
  const carry = Number(frac[2] ?? '0') >= 5 ? 1 : 0; // 第三位小數四捨五入

  return sign * (wholeCents + fracCents + carry);
}

/**
 * cents 轉顯示字串。
 * @param {number} cents
 * @param {{ sign?: boolean, decimals?: 'auto'|'always'|'never', grouping?: boolean }} [opt]
 *        sign      - true 時正數也加上 "+"
 *        decimals  - auto: 整數不顯示小數（台幣日常情境）; always: 固定兩位; never: 四捨五入到整數
 *        grouping  - 是否加千分位，預設 true
 */
export function formatAmount(cents, opt = {}) {
  const { sign = false, decimals = 'auto', grouping = true } = opt;
  if (!Number.isFinite(cents)) return '—';

  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));

  let whole = Math.floor(abs / CENTS_PER_UNIT);
  const frac = abs % CENTS_PER_UNIT;

  if (decimals === 'never' && frac >= CENTS_PER_UNIT / 2) whole += 1;

  let body = grouping ? groupDigits(whole) : String(whole);
  if (decimals === 'always' || (decimals === 'auto' && frac !== 0)) {
    body += '.' + String(frac).padStart(2, '0');
  }

  const prefix = negative ? '-' : sign ? '+' : '';
  return prefix + body;
}

/** 加上貨幣符號的顯示字串，負號放在符號之前（-NT$5,000） */
export function formatCurrency(cents, opt = {}) {
  const { symbol = 'NT$' } = opt;
  if (!Number.isFinite(cents)) return '—';
  const negative = cents < 0;
  const body = formatAmount(Math.abs(cents), { ...opt, sign: false });
  return (negative ? '-' : opt.sign && cents > 0 ? '+' : '') + symbol + body;
}

/** 千分位，只處理非負整數 */
export function groupDigits(n) {
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

/** 安全加總，忽略非數字項目 */
export function sumCents(list, pick = (x) => x) {
  let total = 0;
  for (const item of list ?? []) {
    const v = pick(item);
    if (Number.isFinite(v)) total += Math.round(v);
  }
  return total;
}

/**
 * 給記帳輸入框用的四則運算（常需要「35+50+120」直接算總額）。
 * 只支援 + - * / 與小數，不支援括號，並且刻意不用 eval，
 * 避免使用者貼進來的字串變成可執行程式碼。
 * 解析失敗回傳 null。
 */
export function evaluateExpression(input) {
  if (typeof input !== 'string') return null;
  const s = normalizeNumeric(input).replace(/×/g, '*').replace(/÷/g, '/');
  if (s === '') return null;
  if (!/^-?\d*\.?\d+(?:[+\-*/]\d*\.?\d+)*$/.test(s)) return null;

  // 注意：這裡的數字樣式刻意不含負號。若寫成 /-?\d+/，"100-30" 會被切成
  // ["100", "-30"] 兩個數字而少掉運算子，導致算式解析失敗。
  const tokens = s.match(/\d*\.?\d+|[+\-*/]/g);
  if (!tokens || tokens.length === 0) return null;

  let i = 0;
  let leadingSign = 1;
  if (tokens[0] === '-') {
    leadingSign = -1;
    i = 1;
  }
  const first = Number(tokens[i++]);
  if (!Number.isFinite(first)) return null;

  // 先把 * / 就地算掉，剩下的項目最後相加即完成 + - 的運算
  const terms = [leadingSign * first];
  while (i < tokens.length) {
    const op = tokens[i++];
    const num = Number(tokens[i++]);
    if (!Number.isFinite(num)) return null;

    if (op === '*') terms.push(terms.pop() * num);
    else if (op === '/') {
      if (num === 0) return null;
      terms.push(terms.pop() / num);
    } else if (op === '+') terms.push(num);
    else if (op === '-') terms.push(-num);
    else return null;
  }

  const result = terms.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(result)) return null;
  return Math.round(result * CENTS_PER_UNIT);
}

/** 全形轉半形、去掉千分位與空白，統一成可解析的數字字串 */
function normalizeNumeric(input) {
  return String(input)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[－ー―−]/g, '-')
    .replace(/[，,\s]/g, '')
    .trim();
}
