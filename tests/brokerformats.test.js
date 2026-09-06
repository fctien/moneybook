/**
 * 用真實券商截圖的排版驗證匯入解析。
 * 執行：node --test tests/brokerformats.test.js
 *
 * 測資取自使用者提供的兩張實際畫面（帳號等個資已移除），
 * 是券商 App 經 iOS 即時文字辨識後會產生的文字。
 *
 * 這一組的價值在於：它們暴露了四個用假資料完全看不出來的問題 ——
 * 「下單」被當成股票名稱、「市值」被當成股數、重複的數量欄被當成成本、
 * 以及兩種畫面其實都沒有成本價。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractHoldings, suggestMapping, rowsToTrades, FIELD } from '../js/lib/importparse.js';
import { nameToSymbol } from '../js/lib/stocklookup.js';
import { computePositions, summarizePortfolio } from '../js/lib/portfolio.js';

const opts = { lookup: nameToSymbol };

// 格式 A：證券－未實現損益
// 商品 | 交易別 | 庫存數量 | 現價 | 市值
const FORMAT_A = `商品 交易別 庫存數量 現價 市值
主動凱基台灣 現股 107,000 9.73 1,041,110
元大台灣50 現股 4,000 107.9 431,600
富邦科技 現股 26,000 62.7 1,630,200
元大高股息 現股 4,000 55.4 221,600
野村臺灣新科技50 現股 14,000 58.65 821,100
群益ESG投等債20+ 現股 5,000 14.3 71,500`;

// 格式 B：證券－即時庫存
// 下單 | 商品 | 交易別 | 庫存數量 | 可下單數量
const FORMAT_B = `下單 杏一 集保 73 73
下單 遠傳 集保 244 244
下單 合庫金 集保 14,598 14,598
下單 台灣虎航 集保 1,000 1,000
下單 無敵 集保 1 1
下單 老四川 興櫃 52 52
下單 高明鐵 興櫃 15,000 15,000`;

// ── 格式 A ──────────────────────────────────────────────────

test('格式 A：每一列都解析出來，表頭不算', () => {
  const { rows } = extractHoldings(FORMAT_A, opts);
  assert.equal(rows.length, 6);
});

test('格式 A：只有名稱也能查出代號，含異體字與債券 ETF', () => {
  const { rows } = extractHoldings(FORMAT_A, opts);
  const map = Object.fromEntries(rows.map((r) => [r.name, r.symbol]));
  assert.equal(map['元大台灣50'], '0050');
  assert.equal(map['富邦科技'], '0052');
  assert.equal(map['野村臺灣新科技50'], '00935', '「臺」與「台」的異體字要能對上');
  assert.equal(map['群益ESG投等債20+'], '00937B', '帶英文與加號的名稱也要對上');
});

test('格式 A：表頭的「商品」不會被查成股票', () => {
  // 「商品」剛好是某檔 ETF 名稱的一部分，若在濾雜訊前就拿去查表，
  // 整條表頭會變成一筆持股
  const { rows } = extractHoldings(FORMAT_A, opts);
  assert.ok(!rows.some((r) => r.name === '商品'), '表頭不該變成持股');
});

test('格式 A：「現股」不會被當成股票名稱', () => {
  const { rows } = extractHoldings(FORMAT_A, opts);
  assert.ok(!rows.some((r) => r.name === '現股'));
});

test('格式 A：市值欄要被認出來並排除，不能當成股數', () => {
  // 107,000 股 × 9.73 元 = 1,041,110 的市值也是整數，而且比股數還大。
  // 誤判的話會變成「持有 1,041,110 股」，畫面上看起來毫無異常。
  const { rows } = extractHoldings(FORMAT_A, opts);
  const m = suggestMapping(rows);
  assert.deepEqual(m, [FIELD.SHARES, FIELD.PRICE, FIELD.IGNORE]);
});

test('格式 A：匯入後股數與現價正確，成本標記為待補', () => {
  const { rows } = extractHoldings(FORMAT_A, opts);
  const m = suggestMapping(rows);
  for (const r of rows) {
    r.shares = r.numbers[m.indexOf(FIELD.SHARES)];
    r.price = r.numbers[m.indexOf(FIELD.PRICE)];
  }

  const out = rowsToTrades(rows, m, '2026-09-06');
  assert.equal(out.errors.length, 0, '沒有成本價不該讓整批失敗');
  assert.equal(out.trades.length, 6);

  const tsmc = out.trades.find((t) => t.symbol === '0050');
  assert.equal(tsmc.shares, 4000);
  assert.equal(tsmc.costUnknown, true);
  assert.equal(out.quotes.find((q) => q.symbol === '0050').close, 10790);
});

// ── 格式 B ──────────────────────────────────────────────────

test('格式 B：「下單」不會被當成股票名稱', () => {
  const { rows } = extractHoldings(FORMAT_B, opts);
  assert.equal(rows.length, 7);
  assert.ok(!rows.some((r) => r.name === '下單'), '每一列開頭都是「下單」按鈕');
});

test('格式 B：名稱正確對到代號，含興櫃股', () => {
  const { rows } = extractHoldings(FORMAT_B, opts);
  const map = Object.fromEntries(rows.map((r) => [r.name, r.symbol]));
  assert.equal(map['杏一'], '4175');
  assert.equal(map['遠傳'], '4904');
  assert.equal(map['合庫金'], '5880');
  assert.equal(map['台灣虎航'], '6757');
  assert.ok(map['老四川'], '興櫃股也要查得到');
});

test('格式 B：兩個相同的數量欄只取一個', () => {
  // 「庫存數量」與「可下單數量」多數時候一模一樣，
  // 第二欄若被指派成成本價，整批的成本都會等於股數
  const { rows } = extractHoldings(FORMAT_B, opts);
  const m = suggestMapping(rows);
  assert.deepEqual(m, [FIELD.SHARES, FIELD.IGNORE]);
});

test('格式 B：一股的零股也能正確處理', () => {
  const { rows } = extractHoldings(FORMAT_B, opts);
  const wudi = rows.find((r) => r.name === '無敵');
  assert.deepEqual(wudi.numbers, [1, 1]);
});

test('格式 B：查不到的代號會回報，不會無聲消失', () => {
  const text = `${FORMAT_B}\n下單 YY0047 集保 21,700 21,700`;
  const { rows, unresolved } = extractHoldings(text, opts);
  assert.equal(rows.length, 7);
  assert.deepEqual(unresolved, ['YY0047']);
});

// ── 完整欄位的兩種畫面（含成本）──────────────────────────────

// 即時庫存（完整）：下單｜商品｜種類｜即時數量｜可下單數｜現價｜市值｜持有成本｜幣別
const FULL_A = `下單 商品 種類 即時數量 可下單數 現價 市值 持有成本 幣別
下單 主動凱基台灣 集保 107,000 107,000 9.73 1,041,110 935,431 台幣
下單 元大台灣50 集保 4,000 4,000 107.9 431,600 203,462 台幣
下單 台積電 集保 1,000 1,000 2,410 2,410,000 848,725 台幣`;

// 未實現損益（完整）：13 欄，含成本金額、平均單價、損益、報酬率、無成本數量
const FULL_B = `商品 交易別 庫存數量 現價 市值 成本數量 成本金額 平均單價 利息費用 損益 報酬率 無成本數量 幣別
主動凱基台灣 現股 107,000 9.73 1,041,110 107,000 935,431 8.7423 0 103,155 11.03% 0 台幣
元大美債20年 現股 24,000 25.78 618,720 24,000 685,205 28.5502 0 -67,366 -9.83% 0 台幣
友訊 現股 173 19.55 3,382 0 0 0 0 3,352 0.00% 173 台幣
大立光 現股 11 7,400 81,400 11 37,806 3,436.9091 0 43,235 114.36% 0 台幣
中鋼 現股 1,000 19.1 19,100 1,000 36,831 36.831 0 -17,815 -48.37% 0 台幣`;

const tradesOf = (text) => {
  const r = extractHoldings(text, opts);
  const m = suggestMapping(r.rows, r.header);
  return { ...rowsToTrades(r.rows, m, '2026-09-06'), mapping: m, header: r.header };
};

test('完整版即時庫存：認得表頭，持有成本對到成本總額', () => {
  const { mapping, header } = tradesOf(FULL_A);
  assert.ok(header, '要偵測到表頭');
  assert.deepEqual(mapping, [
    FIELD.SHARES, FIELD.IGNORE, FIELD.PRICE, FIELD.IGNORE, FIELD.TOTAL_COST,
  ]);
});

test('完整版即時庫存：總成本精確還原，不因四捨五入失真', () => {
  // 935,431 / 107,000 = 8.74234…，直接取到分再乘回去會少 251 元。
  // 餘數放進 fee，總成本才能精確還原。
  const { trades } = tradesOf(FULL_A);
  const t = trades.find((x) => x.symbol === '00407A');
  assert.equal(t.shares * t.price + t.fee, 93_543_100, '總成本要剛好是 935,431 元');
  assert.equal(t.costUnknown, false);
});

test('完整版未實現損益：兩種成本欄並存時取「成本金額」', () => {
  // 平均單價是券商四捨五入後的顯示值，成本金額才是精確的原始數字
  const { mapping } = tradesOf(FULL_B);
  assert.ok(mapping.includes(FIELD.TOTAL_COST));
  assert.ok(!mapping.includes(FIELD.AVG_COST), '平均單價要讓位給成本金額');
});

test('完整版未實現損益：成本與均價與券商完全一致', () => {
  const { trades } = tradesOf(FULL_B);
  const positions = computePositions(trades.map((t, i) => ({ ...t, tax: 0, amount: 0, createdAt: i })));
  const by = Object.fromEntries(positions.map((p) => [p.symbol, p]));

  // [代號, 券商成本金額, 券商平均單價]
  for (const [sym, cost, avg] of [
    ['00407A', 935_431, 8.7423],
    ['00679B', 685_205, 28.5502],
    ['3008', 37_806, 3436.9091],
    ['2002', 36_831, 36.831],
  ]) {
    assert.equal(by[sym].totalCost, Math.round(cost * 100), `${sym} 成本要一致`);
    const mine = by[sym].totalCost / by[sym].shares / 100;
    assert.ok(Math.abs(mine - avg) < 0.0001, `${sym} 均價 ${mine} 應為 ${avg}`);
  }
});

test('全部由配股取得的零成本部位，不是「成本待補」', () => {
  // 友訊：成本數量 0、成本金額 0、無成本數量 173 —— 成本真的是零。
  // 「有成本欄位但值為 0」與「根本沒有成本欄位」必須分開處理。
  const { trades } = tradesOf(FULL_B);
  const t = trades.find((x) => x.symbol === '2332');
  assert.equal(t.shares, 173);
  assert.equal(t.price, 0);
  assert.equal(t.costUnknown, false, '有成本欄位且值為 0，是真的零成本');
});

test('高精度均價（大立光 3,436.9091）不會被截斷', () => {
  const { trades } = tradesOf(FULL_B);
  const t = trades.find((x) => x.symbol === '3008');
  assert.equal(t.shares * t.price + t.fee, 3_780_600, '總成本 37,806 元');
});

test('負數與百分比欄位不會讓欄位錯位', () => {
  // 「-9.83%」若被判定為非數字而丟掉，後面所有欄位都會位移
  const { trades } = tradesOf(FULL_B);
  const t = trades.find((x) => x.symbol === '00679B');
  assert.equal(t.shares, 24_000);
  assert.equal(t.shares * t.price + t.fee, 68_520_500);
});

test('沒有表頭時仍能靠數值特徵處理', () => {
  const noHeader = `下單 主動凱基台灣 集保 107,000 107,000 9.73 1,041,110 935,431 台幣`;
  const r = extractHoldings(noHeader, opts);
  const m = suggestMapping(r.rows, r.header);
  assert.equal(r.header, null);
  assert.ok(m.includes(FIELD.SHARES), '至少要認出股數');
});

// ── 成本待補的部位不會顯示假的損益 ──────────────────────────

test('成本待補的部位算得出市值，但不顯示損益', () => {
  const trades = [{
    date: '2026-09-06', symbol: '0050', name: '元大台灣50',
    action: 'opening', shares: 4000, price: 0, fee: 0, tax: 0,
    amount: 0, costUnknown: true, createdAt: 1,
  }];

  const p = computePositions(trades)[0];
  assert.equal(p.shares, 4000);
  assert.equal(p.unknownCostShares, 4000);

  const s = summarizePortfolio([p], { '0050': 10790 });
  assert.equal(s.marketValue, 43_160_000, '市值算得出來');
  assert.equal(s.rows[0].unrealized, null, '成本未知就不能算損益');
  assert.equal(s.rows[0].returnRate, null, '否則會顯示「賺了整個市值」');
  assert.equal(s.complete, false);
  assert.deepEqual(s.missingCost, ['0050']);
});

test('補上成本之後損益就恢復正常', () => {
  const trades = [{
    date: '2026-09-06', symbol: '0050', name: '元大台灣50',
    action: 'opening', shares: 4000, price: 9000, fee: 0, tax: 0,
    amount: 0, costUnknown: false, createdAt: 1,
  }];
  const s = summarizePortfolio(computePositions(trades), { '0050': 10790 });
  assert.equal(s.rows[0].unrealized, 4000 * (10790 - 9000));
  assert.equal(s.complete, true);
  assert.deepEqual(s.missingCost, []);
});

test('成本未知的部位不會污染整體損益總額', () => {
  const trades = [
    {
      date: '2026-09-06', symbol: '2330', name: '台積電', action: 'opening',
      shares: 1000, price: 60000, fee: 0, tax: 0, amount: 0, costUnknown: false, createdAt: 1,
    },
    {
      date: '2026-09-06', symbol: '0050', name: '元大台灣50', action: 'opening',
      shares: 4000, price: 0, fee: 0, tax: 0, amount: 0, costUnknown: true, createdAt: 2,
    },
  ];
  const s = summarizePortfolio(computePositions(trades), { 2330: 80000, '0050': 10790 });

  assert.equal(s.unrealized, 20_000_000, '只計入成本已知的那一檔');
  assert.equal(s.complete, false, '有部位算不出來就不是完整數字');
  assert.deepEqual(s.missingCost, ['0050']);
});
