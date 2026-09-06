/**
 * 股價自動更新的自我測試。
 * 執行：node --test tests/quotesource.test.js
 *
 * 抓網路那一段沒辦法在 node 裡真的跑，因此把「回應長這樣時該得到什麼」
 * 拆成純函式測到底 —— 那才是這個模組最容易出錯的地方。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUOTE_ERROR, LOOKBACK_DAYS,
  buildQuoteUrl, parseQuoteResponse, fetchQuotes,
  isFatalQuoteError, describeQuoteErrors,
} from '../js/lib/quotesource.js';

import { taipeiNow, taipeiDateISO, isAfterMarketClose } from '../js/lib/dateutil.js';

/** FinMind 的一筆日線 */
const bar = (date, close) => ({
  date, stock_id: '2330', open: close, max: close, min: close, close,
  Trading_Volume: 1, Trading_money: 1, spread: 0, Trading_turnover: 1,
});

const okResponse = (rows) => ({ msg: 'success', status: 200, data: rows });

// ── 網址 ─────────────────────────────────────────────────

test('查詢網址帶入代號與往回 14 天的區間', () => {
  const now = Date.parse('2026-09-06T10:00:00Z');
  const url = new URL(buildQuoteUrl('2330', now));
  const q = url.searchParams;

  assert.equal(q.get('dataset'), 'TaiwanStockPrice');
  assert.equal(q.get('data_id'), '2330');
  assert.equal(q.get('end_date'), '2026-09-06');
  assert.equal(q.get('start_date'), '2026-08-23');
  assert.equal(LOOKBACK_DAYS, 14);
});

test('代號一律轉大寫並去空白', () => {
  const url = new URL(buildQuoteUrl('  00679b  '));
  assert.equal(url.searchParams.get('data_id'), '00679B');
});

// ── 解析 ─────────────────────────────────────────────────

test('取回日線後換算成「分」', () => {
  const r = parseQuoteResponse(okResponse([bar('2026-09-04', 2410)]), '2330');
  assert.equal(r.ok, true);
  assert.equal(r.close, 241_000);
  assert.equal(r.date, '2026-09-04');
  assert.equal(r.symbol, '2330');
});

test('小數價格不會因為浮點誤差而算錯一分', () => {
  // 9.73 * 100 在 JavaScript 裡是 972.9999999999999
  assert.equal(parseQuoteResponse(okResponse([bar('2026-09-04', 9.73)]), 'X').close, 973);
  assert.equal(parseQuoteResponse(okResponse([bar('2026-09-04', 25.78)]), 'X').close, 2578);
  assert.equal(parseQuoteResponse(okResponse([bar('2026-09-04', 107.9)]), 'X').close, 10_790);
});

test('取日期最大的那一筆，不是陣列的最後一筆', () => {
  // 順序是對方決定的，不該假設它一定由舊排到新
  const r = parseQuoteResponse(okResponse([
    bar('2026-09-04', 2410),
    bar('2026-09-02', 2390),
    bar('2026-09-03', 2400),
  ]), '2330');
  assert.equal(r.date, '2026-09-04');
  assert.equal(r.close, 241_000);
});

test('查無代號回傳空陣列，要明講而不是靜靜跳過', () => {
  // 使用者打錯代號時得知道是哪一檔沒更新到
  const r = parseQuoteResponse(okResponse([]), '9999');
  assert.equal(r.ok, false);
  assert.equal(r.kind, QUOTE_ERROR.NOT_FOUND);
});

test('停牌那天收盤價是 0，不能寫進去', () => {
  // 寫 0 會讓那一檔的市值瞬間歸零，而且看起來像正常數字
  const r = parseQuoteResponse(okResponse([bar('2026-09-04', 0)]), '2330');
  assert.equal(r.ok, false);
  assert.equal(r.kind, QUOTE_ERROR.BAD_DATA);
});

test('價格不是數字或為負一律當成壞資料', () => {
  assert.equal(parseQuoteResponse(okResponse([bar('2026-09-04', null)]), 'X').kind, QUOTE_ERROR.BAD_DATA);
  assert.equal(parseQuoteResponse(okResponse([bar('2026-09-04', 'abc')]), 'X').kind, QUOTE_ERROR.BAD_DATA);
  assert.equal(parseQuoteResponse(okResponse([bar('2026-09-04', -5)]), 'X').kind, QUOTE_ERROR.BAD_DATA);
});

test('data 不是陣列時當成壞資料，不會爆掉', () => {
  assert.equal(parseQuoteResponse({ data: null }, 'X').kind, QUOTE_ERROR.BAD_DATA);
  assert.equal(parseQuoteResponse({}, 'X').kind, QUOTE_ERROR.BAD_DATA);
  assert.equal(parseQuoteResponse(null, 'X').kind, QUOTE_ERROR.BAD_DATA);
});

test('配額用完時 HTTP 仍是 200，要靠回應內容判斷', () => {
  const byStatus = parseQuoteResponse({ status: 402, msg: 'Requests reach the upper limit.', data: [] }, 'X');
  assert.equal(byStatus.kind, QUOTE_ERROR.RATE_LIMIT);

  const byMsg = parseQuoteResponse({ status: 200, msg: 'Requests reach the upper limit', data: [] }, 'X');
  assert.equal(byMsg.kind, QUOTE_ERROR.RATE_LIMIT);
});

test('只有限流會讓整批停下來', () => {
  assert.equal(isFatalQuoteError(QUOTE_ERROR.RATE_LIMIT), true);
  assert.equal(isFatalQuoteError(QUOTE_ERROR.NOT_FOUND), false);
  assert.equal(isFatalQuoteError(QUOTE_ERROR.NETWORK), false);
});

// ── 逐檔抓取 ──────────────────────────────────────────────

/** 假的 fetch：依代號決定回什麼 */
function fakeFetch(table) {
  return async (url) => {
    const id = new URL(url).searchParams.get('data_id');
    const entry = table[id];
    if (entry === 'throw') throw new Error('boom');
    if (entry === 'http500') return { ok: false, status: 500, json: async () => ({}) };
    if (entry === 'http402') return { ok: false, status: 402, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => okResponse(entry ?? []) };
  };
}

test('逐檔抓取，成功與失敗分開回報', async () => {
  const r = await fetchQuotes(['2330', '9999', '2317'], {
    fetchImpl: fakeFetch({
      2330: [bar('2026-09-04', 2410)],
      2317: [bar('2026-09-04', 256)],
      // 9999 沒有資料
    }),
  });

  assert.equal(r.quotes.length, 2);
  assert.deepEqual(r.quotes.map((q) => q.symbol), ['2330', '2317']);
  assert.deepEqual(r.errors, [{ symbol: '9999', kind: QUOTE_ERROR.NOT_FOUND }]);
  assert.equal(r.stopped, false);
});

test('單一檔連不上不影響其他檔', async () => {
  const r = await fetchQuotes(['2330', '2317'], {
    fetchImpl: fakeFetch({ 2330: 'throw', 2317: [bar('2026-09-04', 256)] }),
  });
  assert.equal(r.quotes.length, 1);
  assert.deepEqual(r.errors, [{ symbol: '2330', kind: QUOTE_ERROR.NETWORK }]);
});

test('被限流時立刻停止，沒送出的也要一併回報', async () => {
  // 沒送出的若不回報，使用者會以為那些檔是更新成功的
  let calls = 0;
  const impl = async (url) => {
    calls += 1;
    const id = new URL(url).searchParams.get('data_id');
    if (id === '2317') return { ok: true, status: 200, json: async () => ({ status: 402, msg: 'limit', data: [] }) };
    return { ok: true, status: 200, json: async () => okResponse([bar('2026-09-04', 100)]) };
  };

  const r = await fetchQuotes(['2330', '2317', '2454', '3008'], { fetchImpl: impl });

  assert.equal(calls, 2, '限流之後不該再送出任何請求');
  assert.equal(r.stopped, true);
  assert.equal(r.quotes.length, 1);
  assert.deepEqual(
    r.errors.map((e) => e.symbol),
    ['2317', '2454', '3008'],
  );
  assert.ok(r.errors.every((e) => e.kind === QUOTE_ERROR.RATE_LIMIT));
});

test('HTTP 402 與 429 也視為限流', async () => {
  const r = await fetchQuotes(['2330', '2317'], { fetchImpl: fakeFetch({ 2330: 'http402' }) });
  assert.equal(r.stopped, true);
  assert.equal(r.errors[0].kind, QUOTE_ERROR.RATE_LIMIT);
});

test('其他 HTTP 錯誤只影響單一檔', async () => {
  const r = await fetchQuotes(['2330', '2317'], {
    fetchImpl: fakeFetch({ 2330: 'http500', 2317: [bar('2026-09-04', 256)] }),
  });
  assert.equal(r.stopped, false);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.errors[0].kind, QUOTE_ERROR.NETWORK);
});

test('重複的代號只抓一次', async () => {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => okResponse([bar('2026-09-04', 100)]) };
  };
  const r = await fetchQuotes(['2330', '2330', ' 2330 '], { fetchImpl: impl });
  assert.equal(calls, 1);
  assert.equal(r.quotes.length, 1);
});

test('沒有 fetch 可用時全部回報連線失敗，不會靜靜回空的', async () => {
  const r = await fetchQuotes(['2330', '2317'], { fetchImpl: null });
  assert.equal(r.quotes.length, 0);
  assert.equal(r.errors.length, 2);
  assert.ok(r.errors.every((e) => e.kind === QUOTE_ERROR.NETWORK));
});

test('進度回報帶出已完成筆數', async () => {
  const seen = [];
  await fetchQuotes(['2330', '2317'], {
    fetchImpl: fakeFetch({ 2330: [bar('2026-09-04', 1)], 2317: [bar('2026-09-04', 2)] }),
    onProgress: (done, total) => seen.push(`${done}/${total}`),
  });
  assert.deepEqual(seen, ['1/2', '2/2']);
});

test('錯誤訊息把同一種原因的代號合併起來', () => {
  const text = describeQuoteErrors([
    { symbol: '9999', kind: QUOTE_ERROR.NOT_FOUND },
    { symbol: '8888', kind: QUOTE_ERROR.NOT_FOUND },
    { symbol: '2330', kind: QUOTE_ERROR.NETWORK },
  ]);
  assert.match(text, /9999、8888：查無此代號/);
  assert.match(text, /2330：連不上資料來源/);
});

test('沒有錯誤時不產生訊息', () => {
  assert.equal(describeQuoteErrors([]), '');
});

// ── 台北時區與收盤判斷 ─────────────────────────────────────

test('收盤時間用台北時區判斷，不受裝置時區影響', () => {
  // 使用者出國時裝置時區會變，但台股仍然是 13:30 收盤
  const before = new Date('2026-09-04T05:00:00Z');   // 台北 13:00
  const after = new Date('2026-09-04T06:00:00Z');    // 台北 14:00

  assert.equal(taipeiNow(before).hour, 13);
  assert.equal(isAfterMarketClose(before), false);

  assert.equal(taipeiNow(after).hour, 14);
  assert.equal(isAfterMarketClose(after), true);
});

test('台北的日期會跨過 UTC 的日界', () => {
  // UTC 9/4 16:00 已經是台北的 9/5 凌晨
  assert.equal(taipeiDateISO(new Date('2026-09-04T16:00:00Z')), '2026-09-05');
  assert.equal(taipeiDateISO(new Date('2026-09-04T15:59:00Z')), '2026-09-04');
});

test('台北午夜的小時是 0 而不是 24', () => {
  const midnight = taipeiNow(new Date('2026-09-04T16:00:00Z'));
  assert.equal(midnight.hour, 0);
  assert.equal(isAfterMarketClose(new Date('2026-09-04T16:00:00Z')), false);
});
