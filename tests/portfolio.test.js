/**
 * 股票持股與損益計算的自我測試。
 * 執行：node --test tests/portfolio.test.js
 *
 * 金額與股價都是「分」為單位的整數（65.7 元 = 6570）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION, computePositions, averageCost, valuePosition,
  summarizePortfolio, byMarketValue, validateTrade,
  estimateFee, estimateTax, MIN_FEE,
} from '../js/lib/portfolio.js';

/** 建立一筆交易，補齊預設值讓測試讀起來乾淨 */
const tr = (o) => ({
  date: '2026-01-01', symbol: '2330', action: ACTION.BUY,
  shares: 0, price: 0, fee: 0, tax: 0, amount: 0, createdAt: 0, ...o,
});

const pos = (trades, symbol = '2330') =>
  computePositions(trades).find((p) => p.symbol === symbol);

// ── 費用試算 ────────────────────────────────────────────────

test('手續費為成交金額的 0.1425%', () => {
  // 100 股 × 600 元 = 60000 元 = 6,000,000 分 → 8550 分（85.5 元）
  assert.equal(estimateFee(6_000_000), 8550);
});

test('手續費有最低 20 元的門檻', () => {
  // 小額交易算出來不到 20 元，要墊到 20 元
  assert.equal(estimateFee(100_000), MIN_FEE);
});

test('手續費折扣會反映在金額上', () => {
  assert.equal(estimateFee(6_000_000, 0.6), 5130);
});

test('證交稅為 0.3%，且只有賣出才用到', () => {
  assert.equal(estimateTax(6_000_000), 18_000);
  assert.equal(estimateTax(0), 0);
});

// ── 基本買賣 ────────────────────────────────────────────────

test('單筆買進：成本含手續費', () => {
  const p = pos([tr({ action: ACTION.BUY, shares: 1000, price: 60_000, fee: 8550 })]);
  assert.equal(p.shares, 1000);
  assert.equal(p.totalCost, 1000 * 60_000 + 8550);
  assert.equal(p.realized, 0);
});

test('兩次買進採加權平均成本', () => {
  const p = pos([
    tr({ date: '2026-01-01', shares: 1000, price: 60_000 }),
    tr({ date: '2026-02-01', shares: 1000, price: 80_000 }),
  ]);
  assert.equal(p.shares, 2000);
  assert.equal(p.totalCost, 140_000_000);
  assert.equal(averageCost(p), 70_000, '平均成本為 700 元');
});

test('期初持股與買進的處理方式相同', () => {
  const p = pos([tr({ action: ACTION.OPENING, shares: 500, price: 80_000 })]);
  assert.equal(p.shares, 500);
  assert.equal(p.totalCost, 40_000_000);
});

// ── 賣出與已實現損益 ────────────────────────────────────────

test('部分賣出：成本依比例攤，已實現損益正確', () => {
  const p = pos([
    tr({ date: '2026-01-01', shares: 2000, price: 60_000 }),           // 成本 1.2 億分
    tr({ date: '2026-03-01', action: ACTION.SELL, shares: 1000, price: 80_000 }),
  ]);
  assert.equal(p.shares, 1000);
  assert.equal(p.totalCost, 60_000_000, '剩下一半的成本');
  assert.equal(p.realized, 80_000_000 - 60_000_000, '賣價減掉該批成本');
});

test('賣出的手續費與證交稅會扣減已實現損益', () => {
  const p = pos([
    tr({ date: '2026-01-01', shares: 1000, price: 60_000 }),
    tr({ date: '2026-03-01', action: ACTION.SELL, shares: 1000, price: 60_000, fee: 8550, tax: 18_000 }),
  ]);
  assert.equal(p.shares, 0);
  assert.equal(p.realized, -(8550 + 18_000), '平買平賣，只虧手續費與稅');
});

test('全部賣光後成本歸零，不留四捨五入的零頭', () => {
  const p = pos([
    tr({ date: '2026-01-01', shares: 3, price: 33_333 }),
    tr({ date: '2026-02-01', action: ACTION.SELL, shares: 3, price: 40_000 }),
  ]);
  assert.equal(p.shares, 0);
  assert.equal(p.totalCost, 0);
});

test('賣超過持股數會提出警告，且不會出現負股數', () => {
  const p = pos([
    tr({ date: '2026-01-01', shares: 100, price: 10_000 }),
    tr({ date: '2026-02-01', action: ACTION.SELL, shares: 500, price: 12_000 }),
  ]);
  assert.equal(p.shares, 0, '不能變成負數');
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /只持有 100 股/);
});

// ── 股利 ────────────────────────────────────────────────────

test('現金股利計入已實現收益，不影響成本', () => {
  const p = pos([
    tr({ date: '2026-01-01', shares: 1000, price: 60_000 }),
    tr({ date: '2026-07-01', action: ACTION.DIVIDEND, amount: 1_400_000 }),
  ]);
  assert.equal(p.totalCost, 60_000_000, '成本不變');
  assert.equal(p.realized, 1_400_000);
  assert.equal(p.dividends, 1_400_000);
});

test('股票股利增加股數但不增加成本，平均成本因此被稀釋', () => {
  const p = pos([
    tr({ date: '2026-01-01', shares: 1000, price: 60_000 }),
    tr({ date: '2026-07-01', action: ACTION.STOCK_DIV, shares: 100 }),
  ]);
  assert.equal(p.shares, 1100);
  assert.equal(p.totalCost, 60_000_000);
  assert.ok(averageCost(p) < 60_000, '平均成本要下降');
});

// ── 交易順序 ────────────────────────────────────────────────

test('交易輸入順序顛倒不影響結果', () => {
  const trades = [
    tr({ date: '2026-03-01', action: ACTION.SELL, shares: 1000, price: 80_000 }),
    tr({ date: '2026-01-01', shares: 2000, price: 60_000 }),
  ];
  const p = pos(trades);
  assert.equal(p.shares, 1000);
  assert.equal(p.realized, 20_000_000);
  assert.equal(p.warnings.length, 0, '排序後不該出現賣超警告');
});

test('同一天的買進會排在賣出之前', () => {
  const p = pos([
    tr({ date: '2026-01-01', action: ACTION.SELL, shares: 500, price: 70_000, createdAt: 1 }),
    tr({ date: '2026-01-01', action: ACTION.BUY, shares: 1000, price: 60_000, createdAt: 2 }),
  ]);
  assert.equal(p.shares, 500);
  assert.equal(p.warnings.length, 0, '當沖也不該被判定為賣超');
});

// ── 多檔與彙總 ──────────────────────────────────────────────

test('不同代號各自獨立計算', () => {
  const list = computePositions([
    tr({ symbol: '2330', shares: 1000, price: 60_000 }),
    tr({ symbol: '2317', shares: 2000, price: 20_000 }),
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((p) => p.symbol), ['2317', '2330'], '依代號排序');
});

test('valuePosition 算出市值、未實現損益與報酬率', () => {
  const p = pos([tr({ shares: 1000, price: 60_000 })]);
  const v = valuePosition(p, 80_000);
  assert.equal(v.marketValue, 80_000_000);
  assert.equal(v.unrealized, 20_000_000);
  assert.ok(Math.abs(v.returnRate - 1 / 3) < 1e-9);
});

test('沒有報價時市值與損益回傳 null，而不是 0', () => {
  const p = pos([tr({ shares: 1000, price: 60_000 })]);
  const v = valuePosition(p, null);
  assert.equal(v.marketValue, null, '0 會被誤讀成「這檔歸零了」');
  assert.equal(v.unrealized, null);
  assert.equal(v.returnRate, null);
});

test('彙總：全部有報價時標記為完整', () => {
  const positions = computePositions([
    tr({ symbol: '2330', shares: 1000, price: 60_000 }),
    tr({ symbol: '2317', shares: 1000, price: 20_000 }),
  ]);
  const s = summarizePortfolio(positions, { 2330: 80_000, 2317: 25_000 });
  assert.equal(s.complete, true);
  assert.equal(s.marketValue, 105_000_000);
  assert.equal(s.unrealized, 25_000_000);
  assert.deepEqual(s.missingQuotes, []);
});

test('彙總：少一檔報價時標記為不完整並列出缺哪些', () => {
  const positions = computePositions([
    tr({ symbol: '2330', shares: 1000, price: 60_000 }),
    tr({ symbol: '2317', shares: 1000, price: 20_000 }),
  ]);
  const s = summarizePortfolio(positions, { 2330: 80_000 });
  assert.equal(s.complete, false, '少算一檔卻照樣顯示總額會誤導');
  assert.deepEqual(s.missingQuotes, ['2317']);
  assert.equal(s.pricedCount, 1);
  assert.equal(s.heldCount, 2);
});

test('彙總把已實現損益與股利一併加總', () => {
  const positions = computePositions([
    tr({ symbol: '2330', date: '2026-01-01', shares: 2000, price: 60_000 }),
    tr({ symbol: '2330', date: '2026-03-01', action: ACTION.SELL, shares: 1000, price: 80_000 }),
    tr({ symbol: '2317', date: '2026-07-01', action: ACTION.DIVIDEND, amount: 500_000 }),
  ]);
  const s = summarizePortfolio(positions, {});
  assert.equal(s.realized, 20_000_000 + 500_000);
  assert.equal(s.dividends, 500_000);
});

test('已全部賣出的部位不列入持股，但已實現損益仍保留', () => {
  const positions = computePositions([
    tr({ date: '2026-01-01', shares: 1000, price: 60_000 }),
    tr({ date: '2026-03-01', action: ACTION.SELL, shares: 1000, price: 80_000 }),
  ]);
  const s = summarizePortfolio(positions, { 2330: 90_000 });
  assert.equal(s.heldCount, 0);
  assert.equal(s.totalCost, 0);
  assert.equal(s.realized, 20_000_000, '賣掉了不代表這筆獲利要消失');
});

test('byMarketValue 依市值排序，沒有報價的排最後', () => {
  const positions = computePositions([
    tr({ symbol: '2330', shares: 100, price: 60_000 }),
    tr({ symbol: '2317', shares: 100, price: 20_000 }),
    tr({ symbol: '1301', shares: 100, price: 10_000 }),
  ]);
  const rows = summarizePortfolio(positions, { 2330: 80_000, 1301: 12_000 }).rows;
  const order = byMarketValue(rows).map((r) => r.symbol);
  assert.deepEqual(order, ['2330', '1301', '2317']);
});

// ── 驗證 ────────────────────────────────────────────────────

test('validateTrade 接受合法輸入並正規化代號大小寫', () => {
  const r = validateTrade({ date: '2026-01-01', symbol: ' 2330 ', action: ACTION.BUY, shares: 1000, price: 60_000 });
  assert.equal(r.ok, true);
  assert.equal(r.value.symbol, '2330');
});

test('validateTrade 擋掉缺代號、錯日期、非整數股數與零價格', () => {
  const base = { date: '2026-01-01', symbol: '2330', action: ACTION.BUY, shares: 100, price: 100 };
  assert.match(validateTrade({ ...base, symbol: '' }).error, /代號/);
  assert.match(validateTrade({ ...base, date: '2026/01/01' }).error, /日期/);
  assert.match(validateTrade({ ...base, shares: 1.5 }).error, /整數/);
  assert.match(validateTrade({ ...base, shares: 0 }).error, /股數/);
  assert.match(validateTrade({ ...base, price: 0 }).error, /價格/);
  assert.match(validateTrade({ ...base, action: 'nope' }).error, /種類/);
});

test('validateTrade 對股利有各自的規則', () => {
  const d = { date: '2026-01-01', symbol: '2330', action: ACTION.DIVIDEND };
  assert.equal(validateTrade({ ...d, amount: 1000 }).ok, true);
  assert.match(validateTrade({ ...d, amount: 0 }).error, /股利/);

  const s = { date: '2026-01-01', symbol: '2330', action: ACTION.STOCK_DIV };
  assert.equal(validateTrade({ ...s, shares: 100 }).ok, true, '配股不需要價格');
  assert.match(validateTrade({ ...s, shares: 0 }).error, /配股/);
});

test('空輸入不會拋例外', () => {
  assert.equal(validateTrade(null).ok, false);
  assert.equal(validateTrade({}).ok, false);
  assert.deepEqual(computePositions(), []);
  assert.deepEqual(computePositions([]), []);
});

// ── 不會累積誤差 ────────────────────────────────────────────

test('反覆進出後成本仍然精確歸零', () => {
  // 除不盡的價格，刻意做二十次一買一賣
  const trades = [];
  for (let i = 0; i < 20; i += 1) {
    trades.push(tr({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, shares: 7, price: 33_333, createdAt: i * 2 }));
    trades.push(tr({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      action: ACTION.SELL, shares: 7, price: 33_333, createdAt: i * 2 + 1,
    }));
  }
  const p = pos(trades);
  assert.equal(p.shares, 0);
  assert.equal(p.totalCost, 0);
  assert.equal(p.realized, 0, '平買平賣二十次，損益必須剛好是 0');
});
