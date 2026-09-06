/**
 * 股價自動更新：FinMind 資料來源。
 *
 * ── 為什麼是 FinMind ──
 * 證交所 OpenAPI、證交所 MIS、櫃買中心、Yahoo Finance 全部沒有
 * Access-Control-Allow-Origin，瀏覽器直接抓一律被 CORS 擋下。
 * FinMind 是實測中唯一能從瀏覽器直接取得台股日線的來源，免 token。
 * （curl 抓得到不算數 —— curl 不受 CORS 限制。）
 *
 * ── 兩個必須認清的限制 ──
 * 1. 只有收盤價，沒有盤中即時價。tick 資料要付費 token。
 *    因此「自動更新」的意思是「最近一個交易日的收盤價」，盤中不會跳動。
 * 2. 不支援一次查多檔，每檔各一個請求。30 檔持股就是 30 個請求。
 *
 * ── 隱私 ──
 * 這個模組是整個 App 唯一會對外連線的地方，而且會把持股代號送出去。
 * 因此預設關閉，使用者要在設定頁看過說明後自行開啟。
 * 送出的只有代號，沒有股數、成本或任何個人資料 —— 但對方仍然看得出
 * 「有人持有這幾檔」，這一點必須讓使用者自己決定接不接受。
 */

export const FINMIND_URL = 'https://api.finmindtrade.com/api/v4/data';

/** 往回抓幾天的日線。要夠長才能跨過連假，取回來只用最新那一筆。 */
export const LOOKBACK_DAYS = 14;

/** 錯誤種類。fatal 的會讓整批停下來，其餘只影響單一檔。 */
export const QUOTE_ERROR = {
  NOT_FOUND: 'notFound',     // 查無此代號
  BAD_DATA: 'badData',       // 有回應但價格不合理
  NETWORK: 'network',        // 連不上
  RATE_LIMIT: 'rateLimit',   // 被限流（fatal）
};

const FATAL = new Set([QUOTE_ERROR.RATE_LIMIT]);

/** 這個錯誤該不該讓整批停下來 */
export function isFatalQuoteError(kind) {
  return FATAL.has(kind);
}

export const QUOTE_ERROR_TEXT = {
  [QUOTE_ERROR.NOT_FOUND]: '查無此代號',
  [QUOTE_ERROR.BAD_DATA]: '回傳的價格不合理',
  [QUOTE_ERROR.NETWORK]: '連不上資料來源',
  [QUOTE_ERROR.RATE_LIMIT]: '資料來源今日的查詢次數已用完',
};

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 組出查詢網址。
 * @param {string} symbol 股票代號
 * @param {number} [nowMs] 現在時間，測試時可注入
 */
export function buildQuoteUrl(symbol, nowMs = Date.now()) {
  const params = new URLSearchParams({
    dataset: 'TaiwanStockPrice',
    data_id: String(symbol).trim().toUpperCase(),
    start_date: isoDate(nowMs - LOOKBACK_DAYS * 86_400_000),
    end_date: isoDate(nowMs),
  });
  return `${FINMIND_URL}?${params}`;
}

/**
 * 解析 FinMind 的回應。
 *
 * 刻意分成純函式：抓網路的部分沒辦法在 node 裡測，
 * 但「回應長這樣時該得到什麼」是這個模組最容易出錯的地方，必須測得到。
 *
 * @returns {{ok:true, symbol:string, close:number, date:string}
 *         | {ok:false, kind:string}}
 */
export function parseQuoteResponse(json, symbol) {
  // FinMind 用回應內容裡的 status 表示配額問題，HTTP 狀態碼仍是 200
  if (json?.status === 402 || /limit/i.test(String(json?.msg ?? ''))) {
    return { ok: false, kind: QUOTE_ERROR.RATE_LIMIT };
  }

  const rows = Array.isArray(json?.data) ? json.data : null;
  if (!rows) return { ok: false, kind: QUOTE_ERROR.BAD_DATA };
  // 代號不存在時回的是空陣列而不是錯誤。這要明確講「查無此代號」，
  // 不能默默跳過 —— 使用者打錯代號時得知道是哪一檔沒更新到。
  if (rows.length === 0) return { ok: false, kind: QUOTE_ERROR.NOT_FOUND };

  // 取日期最大的那一筆，而不是陣列最後一筆：順序是對方決定的，不該假設
  let latest = null;
  for (const row of rows) {
    if (typeof row?.date !== 'string') continue;
    if (!latest || row.date > latest.date) latest = row;
  }
  if (!latest) return { ok: false, kind: QUOTE_ERROR.BAD_DATA };

  const close = Number(latest.close);
  // 停牌那天 close 會是 0。寫進去會讓那一檔的市值瞬間歸零，
  // 而且看起來像正常數字 —— 寧可保留舊價格。
  if (!Number.isFinite(close) || close <= 0) {
    return { ok: false, kind: QUOTE_ERROR.BAD_DATA };
  }

  return {
    ok: true,
    symbol: String(symbol).trim().toUpperCase(),
    close: Math.round(close * 100),   // 轉成「分」，與 App 其餘金額一致
    date: latest.date,
  };
}

/**
 * 逐檔抓取收盤價。
 *
 * 一檔一個請求（來源不支援多檔查詢），依序送出而不是併發：
 * 30 檔約兩秒，沒必要為了省一秒去冒被限流的風險。
 * 被限流時立刻停止剩下的請求 —— 繼續送只會讓情況更糟。
 *
 * 單一檔失敗不影響其他檔，失敗的會列在 errors 裡回報，
 * 不會靜靜少更新幾檔卻說成功。
 *
 * @param {string[]} symbols
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] 測試時可注入
 * @param {Function} [opts.onProgress] (done, total, symbol) => void
 * @param {number} [opts.nowMs]
 * @returns {Promise<{quotes:Array, errors:Array, stopped:boolean}>}
 */
export async function fetchQuotes(symbols, opts = {}) {
  const {
    fetchImpl = globalThis.fetch?.bind(globalThis),
    onProgress,
    nowMs = Date.now(),
  } = opts;

  const list = [...new Set((symbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  const quotes = [];
  const errors = [];
  let stopped = false;

  if (!fetchImpl) {
    return { quotes, errors: list.map((symbol) => ({ symbol, kind: QUOTE_ERROR.NETWORK })), stopped: true };
  }

  for (let i = 0; i < list.length; i += 1) {
    const symbol = list[i];
    let result;

    try {
      const res = await fetchImpl(buildQuoteUrl(symbol, nowMs));
      if (res.status === 402 || res.status === 429) {
        result = { ok: false, kind: QUOTE_ERROR.RATE_LIMIT };
      } else if (!res.ok) {
        result = { ok: false, kind: QUOTE_ERROR.NETWORK };
      } else {
        result = parseQuoteResponse(await res.json(), symbol);
      }
    } catch {
      result = { ok: false, kind: QUOTE_ERROR.NETWORK };
    }

    if (result.ok) quotes.push(result);
    else errors.push({ symbol, kind: result.kind });

    onProgress?.(i + 1, list.length, symbol);

    if (!result.ok && isFatalQuoteError(result.kind)) {
      // 剩下的沒送出，也要一併回報，否則使用者以為那些檔是更新成功的
      for (const rest of list.slice(i + 1)) errors.push({ symbol: rest, kind: result.kind });
      stopped = true;
      break;
    }
  }

  return { quotes, errors, stopped };
}

/** 把錯誤整理成一句話，重複的種類會合併 */
export function describeQuoteErrors(errors = []) {
  if (!errors.length) return '';
  const byKind = new Map();
  for (const e of errors) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind).push(e.symbol);
  }
  return [...byKind.entries()]
    .map(([kind, syms]) => `${syms.join('、')}：${QUOTE_ERROR_TEXT[kind] ?? kind}`)
    .join('；');
}
