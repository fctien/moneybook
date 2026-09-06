/**
 * 台股代號查表：由名稱反查代號，或用關鍵字搜尋。
 *
 * 資料在 twstocks.js（約 65 KB，由 tools/make_stocklist.py 產生）。
 * 這一支負責把那條壓縮字串展開成可查詢的結構，並處理實務上的模糊比對。
 *
 * ── 為什麼「找不到唯一解就不自動填」──
 * 券商截圖裡的雜訊（「庫存查詢」「台灣」「合計」）很容易誤中一堆 ETF 的名字。
 * 自動填錯代號比留白危險得多：留白使用者一定會看到並補上，
 * 填錯了卻長得很正常，會一路錯到損益報表都對不起來。
 * 因此只有「唯一命中」才自動帶入，多重命中一律留給使用者選。
 */

import { RAW, INDUSTRIES, MARKETS } from './twstocks.js';

let index = null;

/** 第一次用到才展開，避免不需要匯入功能的人也付出解析成本 */
function build() {
  if (index) return index;

  const bySymbol = new Map();
  const byName = new Map();      // 完整名稱 → [entry]
  const all = [];

  for (const chunk of RAW.split(';')) {
    const [symbol, name, ind, mk] = chunk.split(',');
    if (!symbol || !name) continue;

    const entry = {
      symbol,
      name,
      industry: INDUSTRIES[Number(ind)] ?? '',
      market: MARKETS[Number(mk)] ?? '',
    };

    bySymbol.set(symbol, entry);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(entry);
    all.push(entry);
  }

  index = { bySymbol, byName, all };
  return index;
}

/** 代號查資料 */
export function findBySymbol(symbol) {
  const key = String(symbol ?? '').trim().toUpperCase();
  return build().bySymbol.get(key) ?? null;
}

/** 正規化名稱：拿掉空白與常見的雜訊字，讓「台積電 」與「台積電」視為相同 */
function normalize(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[（(].*?[）)]/g, '')   // 括號內容通常是代號或註記
    .replace(/(股份有限公司|公司|股票)$/, '')
    .trim();
}

/**
 * 由名稱找代號。只有唯一命中才回傳結果。
 *
 * 比對順序：完全相同 → 對照表的名稱包含輸入 → 輸入包含對照表的名稱。
 * 後兩種都要求命中數恰好為 1。
 *
 * @param {string} name
 * @returns {{symbol:string, name:string, industry:string, market:string} | null}
 */
export function findByName(name) {
  const q = normalize(name);
  // 一個字的名稱太容易誤中，直接放棄
  if (q.length < 2) return null;

  const { byName, all } = build();

  const exact = byName.get(q);
  if (exact) {
    // 同名不同代號時無法判斷是哪一檔，留給使用者
    return exact.length === 1 ? exact[0] : null;
  }

  const starts = all.filter((e) => e.name.startsWith(q));
  if (starts.length === 1) return starts[0];

  const contains = all.filter((e) => e.name.includes(q));
  if (contains.length === 1) return contains[0];

  // 反向：輸入比正式名稱長（例如「台積電股份」）
  if (q.length >= 3) {
    const reverse = all.filter((e) => e.name.length >= 2 && q.includes(e.name));
    if (reverse.length === 1) return reverse[0];
  }

  return null;
}

/**
 * 關鍵字搜尋，供輸入代號時即時提示。
 * 代號前綴相符的排前面，其次是名稱開頭相符，最後是名稱包含。
 *
 * @param {string} query
 * @param {number} limit
 */
export function search(query, limit = 20) {
  const q = String(query ?? '').trim().toUpperCase();
  if (!q) return [];

  const { all } = build();
  const nq = normalize(q);

  const byCode = [];
  const byStart = [];
  const byPart = [];

  for (const e of all) {
    if (e.symbol.startsWith(q)) byCode.push(e);
    else if (nq && e.name.startsWith(nq)) byStart.push(e);
    else if (nq && e.name.includes(nq)) byPart.push(e);
    if (byCode.length >= limit) break;
  }

  return [...byCode, ...byStart, ...byPart].slice(0, limit);
}

/** 供匯入解析使用的查詢函式：只回傳代號字串 */
export function nameToSymbol(name) {
  return findByName(name)?.symbol ?? null;
}

/** 資料表大小，用於顯示「收錄 N 檔」 */
export function tableSize() {
  return build().all.length;
}
