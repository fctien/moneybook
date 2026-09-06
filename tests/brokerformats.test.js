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

import {
  extractHoldings, suggestMapping, rowsToTrades, mergeBySymbol, FIELD,
} from '../js/lib/importparse.js';
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

// ── 表格被辨識成直行（iOS 即時文字對寬表格的實際行為）──────────

// 使用者實際貼上的內容：名稱擠成一個區塊、數字在另外幾個區塊，
// 每一列的對應關係在辨識階段就已經消失。
const COLUMN_SHUFFLED = `商品
交易別
庫存數量 現價
市值
主動凱基台灣
現股
元大台灣50
現股
富邦科技
元大高股息
元大美債20年
成本數量 成本金額
107,000
9.73
1,041,110
107,000
4,000
935,431
203,462
平均單價
8.7423
50.8655`;

test('表格被拆成直行時要能偵測出來，而不是硬猜', () => {
  const r = extractHoldings(COLUMN_SHUFFLED, opts);
  assert.ok(r.rows.length >= 3, '股票名稱仍然認得出來');
  assert.equal(r.layoutLost, true, '要標記出「行對應已消失」');
  assert.ok(r.rows.every((x) => x.numbers.length === 0), '沒有任何數字對得上');
});

test('正常的逐列排版不會被誤判為直行', () => {
  const r = extractHoldings(FULL_B, opts);
  assert.equal(r.layoutLost, false);
});

// ── 分次擷取窄欄位，用代號互補 ──────────────────────────────

test('兩批各給一部分欄位，用代號合併成完整的一筆', () => {
  // 寬表格辨識不出行對應時唯一可靠的做法：
  // 先貼「商品＋庫存數量」，再貼「商品＋成本金額」
  const rows = [
    { symbol: '2330', name: '台積電', shares: 1000, avgCost: null, totalCost: null, price: null },
    { symbol: '2330', name: '', shares: null, avgCost: null, totalCost: 848725, price: null },
  ];
  const { rows: merged, conflicts } = mergeBySymbol(rows);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].shares, 1000);
  assert.equal(merged[0].totalCost, 848725);
  assert.equal(merged[0].name, '台積電', '名稱從有值的那一批補上');
  assert.deepEqual(conflicts, []);
});

test('兩批給了不同的值時回報衝突，不擅自挑一個', () => {
  // 挑錯了畫面上看不出來，之後的損益全部跟著錯
  const rows = [
    { symbol: '2330', name: '台積電', shares: 1000, avgCost: null, totalCost: null, price: null },
    { symbol: '2330', name: '台積電', shares: 2000, avgCost: null, totalCost: null, price: null },
  ];
  const { rows: merged, conflicts } = mergeBySymbol(rows);

  assert.equal(merged.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].symbol, '2330');
  assert.equal(conflicts[0].field, 'shares');
  assert.deepEqual(conflicts[0].values, [1000, 2000]);
});

test('不同代號不會被合併', () => {
  const rows = [
    { symbol: '2330', name: '', shares: 1000, avgCost: null, totalCost: null, price: null },
    { symbol: '2317', name: '', shares: 2000, avgCost: null, totalCost: null, price: null },
  ];
  assert.equal(mergeBySymbol(rows).rows.length, 2);
});

test('mergeBySymbol 對空輸入安全', () => {
  assert.deepEqual(mergeBySymbol().rows, []);
  assert.deepEqual(mergeBySymbol([]).conflicts, []);
});

test('分三次擷取窄欄位，合併後成本與券商完全一致', () => {
  // 這是寬表格被辨識成直行時唯一可靠的流程：
  // 橫向捲動，一次只讓兩三欄入鏡，分次貼上，用代號合併
  const batches = [
    '商品 庫存數量\n主動凱基台灣 107,000\n大立光 11',
    '商品 成本金額\n主動凱基台灣 935,431\n大立光 37,806',
    '商品 現價\n主動凱基台灣 9.73\n大立光 7,400',
  ];

  const all = [];
  const mappings = [];
  for (const text of batches) {
    const r = extractHoldings(text, opts);
    const m = suggestMapping(r.rows, r.header);
    mappings.push(m);
    for (const row of r.rows) {
      const pick = (f) => {
        const k = m.indexOf(f);
        return k >= 0 ? row.numbers[k] ?? null : null;
      };
      all.push({
        ...row,
        shares: pick(FIELD.SHARES),
        avgCost: pick(FIELD.AVG_COST),
        totalCost: pick(FIELD.TOTAL_COST),
        price: pick(FIELD.PRICE),
      });
    }
  }

  // 只有兩欄的表頭也要認得。認不出來的話那一欄會退回數值判斷、
  // 被誤認成股數，兩批合併時就變成衝突而不是互補。
  assert.deepEqual(mappings, [[FIELD.SHARES], [FIELD.TOTAL_COST], [FIELD.PRICE]]);

  const { rows, conflicts } = mergeBySymbol(all);
  assert.deepEqual(conflicts, [], '各批帶不同欄位，不該有衝突');

  const positions = computePositions(
    rowsToTrades(rows, [], '2026-09-06').trades.map((t, i) => ({ ...t, tax: 0, amount: 0, createdAt: i })),
  );
  const by = Object.fromEntries(positions.map((p) => [p.symbol, p]));

  assert.equal(by['00407A'].shares, 107_000);
  assert.equal(by['00407A'].totalCost, 93_543_100, '成本 935,431 元');
  assert.equal(by['3008'].shares, 11);
  assert.equal(by['3008'].totalCost, 3_780_600, '成本 37,806 元');
});

// ── 一個欄位一行（iOS 即時文字對這張表的實際輸出）────────────

// 順序完好、只是每個儲存格單獨斷行。這種可以精確還原，
// 與「逐直行讀取」（對應關係已消失）是兩回事。
const FLATTENED = `單
商品

種類 即時數量 可下單數 現價


市值
持有成本
幣別
下單
主動凱基台灣
集保
107,000
107,000
9.73
1,041,110
935,431
台幣
下單
元大台灣50
集保
4,000
4,000
107.9
431,600
203,462
台幣
下單
友訊
集保
173
173
19.55
3,382.15
0
台幣`;

test('一個欄位一行：還原成一列一筆，不會被誤判為直行拆解', () => {
  const r = extractHoldings(FLATTENED, opts);
  assert.equal(r.layoutLost, false, '順序完好，可以還原');
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[0].numbers, [107000, 107000, 9.73, 1041110, 935431]);
});

test('一個欄位一行：表頭自動濾出數字欄的欄名', () => {
  // 表頭裡的「單／商品／種類／幣別」是文字欄，濾掉之後
  // 剩下的五個欄名剛好對上每一列的五個數字
  const r = extractHoldings(FLATTENED, opts);
  assert.deepEqual(r.header, ['即時數量', '可下單數', '現價', '市值', '持有成本']);
  assert.deepEqual(suggestMapping(r.rows, r.header), [
    FIELD.SHARES, FIELD.IGNORE, FIELD.PRICE, FIELD.IGNORE, FIELD.TOTAL_COST,
  ]);
});

test('一個欄位一行：成本與現價都與券商一致', () => {
  const r = extractHoldings(FLATTENED, opts);
  const out = rowsToTrades(r.rows, suggestMapping(r.rows, r.header), '2026-09-06');
  const by = Object.fromEntries(
    computePositions(out.trades.map((t, i) => ({ ...t, tax: 0, amount: 0, createdAt: i })))
      .map((p) => [p.symbol, p]),
  );

  assert.equal(by['00407A'].totalCost, 93_543_100, '935,431 元');
  assert.equal(by['0050'].totalCost, 20_346_200, '203,462 元');
  assert.equal(by['2332'].totalCost, 0, '友訊全部由配股取得');

  const quotes = Object.fromEntries(out.quotes.map((q) => [q.symbol, q.close]));
  assert.equal(quotes['00407A'], 973);
  assert.equal(quotes['0050'], 10790);
});

test('一個欄位一行：每列數字個數不一致時不硬做', () => {
  // 切段不可靠就退回原本的逐行處理，寧可少解出東西也不要對錯欄位
  const broken = `台積電
1,000
2,410
鴻海
1,000`;
  const r = extractHoldings(broken, opts);
  assert.ok(r.rows.every((x) => x.numbers.length !== 2 || x.symbol === '2330'),
    '不該把兩檔的數字混在一起');
});

// ── 實際資料裡的三個異常 ────────────────────────────────────

const MESSY = `下單
杏一
集保
73

73 51.8
3,781.4

台幣
下單
遠傳
集保
244
244
104
25,376
42,630
台幣
下單
無敵
集保
1
1
11.8
11.8
0
台幣
下單
YY0047
集保
21,700
21,700
0
0
0
台幣
下單
老四川
興櫃
52
52
20.8
1,081.6
0
台幣`;

const MESSY_WITH_HEADER = `單
商品

種類 即時數量 可下單數 現價


市值
持有成本
幣別
${MESSY}`;

test('「台幣」是欄位的值，不能被當成股票而把每一列切成兩半', () => {
  const r = extractHoldings(MESSY, opts);
  assert.equal(r.rows.length, 5, '五檔就是五列');
  assert.ok(!r.rows.some((x) => x.numbers.length === 0), '不該有整列沒有數字的');
});

test('沒收錄的代號仍當成一列，不會把數字併進前一檔', () => {
  // 一個沒收錄的代號拖垮整批，代價太高
  const r = extractHoldings(MESSY, opts);
  const yy = r.rows.find((x) => x.symbol === 'YY0047');
  assert.ok(yy, '查不到也要保留這一列');
  assert.deepEqual(yy.numbers, [21700, 21700, 0, 0, 0]);

  const prev = r.rows.find((x) => x.symbol === '9940' || x.name === '信義');
  if (prev) assert.equal(prev.numbers.length, 5, '前一檔的欄位數不該被撐大');
});

test('有表頭時，缺一格的列用「股數 × 現價 ＝ 市值」補回來', () => {
  // 杏一：73 股 × 51.8 元 = 3,781.4，因此缺的是最後的「持有成本」
  const r = extractHoldings(MESSY_WITH_HEADER, opts);
  const row = r.rows.find((x) => x.symbol === '4175');
  assert.deepEqual(row.numbers, [73, 73, 51.8, 3781.4, null]);
  assert.equal(row.realigned, true);
  assert.ok(!row.incomplete);
});

test('沒有表頭而補不回來時，標記為欄位數不一致', () => {
  // 無從得知缺的是哪一欄，硬按位置對應會讓成本跑到別的欄位
  const r = extractHoldings(MESSY, opts);
  const row = r.rows.find((x) => x.symbol === '4175');
  assert.equal(row.numbers.length, 4);
  assert.equal(row.incomplete, true);
});

test('補位後的欄位對應仍然正確，其餘各檔照常匯入', () => {
  const r = extractHoldings(MESSY_WITH_HEADER, opts);
  const m = suggestMapping(r.rows, r.header);
  assert.deepEqual(m, [FIELD.SHARES, FIELD.IGNORE, FIELD.PRICE, FIELD.IGNORE, FIELD.TOTAL_COST]);

  const resolved = r.rows.map((x) => ({
    ...x,
    shares: x.numbers[m.indexOf(FIELD.SHARES)],
    price: x.numbers[m.indexOf(FIELD.PRICE)],
    totalCost: x.numbers[m.indexOf(FIELD.TOTAL_COST)],
  }));
  const out = rowsToTrades(resolved, m, '2026-09-06');
  assert.equal(out.errors.length, 0);
  assert.equal(out.trades.length, 5);

  const by = Object.fromEntries(out.trades.map((t) => [t.symbol, t]));
  assert.equal(by['4904'].shares * by['4904'].price + by['4904'].fee, 4_263_000, '遠傳成本 42,630');
  assert.equal(by['4175'].costUnknown, true, '杏一的成本那一格本來就沒有值');
});

// ── 沒有表頭時，要分清楚「成本總額」與「每股成本」──────────

const NO_HEADER = `下單
主動凱基台灣
集保
107,000
107,000
9.73
1,041,110
935,431
台幣
下單
元大台灣50
集保
4,000
4,000
107.9
431,600
203,462
台幣
下單
大立光
集保
11
11
7,400
81,400
37,806
台幣`;

test('沒有表頭時，持有成本要被認成「成本總額」而不是「每股成本」', () => {
  // 這是沒有表頭時最容易踩到的坑：107,000 股的持有成本是 935,431。
  // 當成每股成本的話，均價會顯示 935,431 元、總成本膨脹到一千億，
  // 而畫面上只會看到一個很大的數字，不會有任何錯誤訊息。
  const r = extractHoldings(NO_HEADER, opts);
  assert.equal(r.header, null, '這份資料本來就沒有表頭');

  const m = suggestMapping(r.rows, r.header);
  assert.deepEqual(m, [
    FIELD.SHARES, FIELD.IGNORE, FIELD.PRICE, FIELD.IGNORE, FIELD.TOTAL_COST,
  ]);
});

test('沒有表頭時算出的均價仍與券商一致', () => {
  const r = extractHoldings(NO_HEADER, opts);
  const m = suggestMapping(r.rows, r.header);
  const resolved = r.rows.map((x) => ({
    ...x,
    shares: x.numbers[m.indexOf(FIELD.SHARES)],
    price: x.numbers[m.indexOf(FIELD.PRICE)],
    totalCost: x.numbers[m.indexOf(FIELD.TOTAL_COST)],
  }));

  const by = Object.fromEntries(
    computePositions(
      rowsToTrades(resolved, m, '2026-09-06').trades
        .map((t, i) => ({ ...t, tax: 0, amount: 0, createdAt: i })),
    ).map((p) => [p.symbol, p]),
  );

  // [代號, 券商均價, 券商成本]
  for (const [sym, avg, cost] of [
    ['00407A', 8.7423, 935_431],
    ['0050', 50.8655, 203_462],
    ['3008', 3436.9091, 37_806],
  ]) {
    assert.equal(by[sym].totalCost, Math.round(cost * 100), `${sym} 成本`);
    const mine = by[sym].totalCost / by[sym].shares / 100;
    assert.ok(Math.abs(mine - avg) < 0.0001, `${sym} 均價 ${mine} 應為 ${avg}`);
  }
});

test('每股成本欄位仍能被正確認出（別矯枉過正）', () => {
  // 這一份的成本是「每股」而非總額，不該被誤判成總額
  const perShare = `商品 庫存數量 現價 每股成本
台積電 1,000 2,410 848.725
鴻海 1,000 256 208.177`;
  const r = extractHoldings(perShare, opts);
  const m = suggestMapping(r.rows, r.header);
  assert.ok(!m.includes(FIELD.TOTAL_COST), '每股成本不該被當成總額');
});
