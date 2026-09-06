/**
 * 基金持份與損益計算的自我測試。
 * 執行：node --test tests/funds.test.js
 *
 * 單位數與淨值都是 ×10^4 的整數，匯率是 ×10^6 的整數，金額是「分」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FUND_ACTION, UNIT_SCALE, NAV_SCALE, FX_SCALE, TWD_RATE,
  toForeignCents, toTwdCents,
  parseUnits, parseNav, parseRate, unitsToNumber,
  validateFundTrade, computeFundPositions,
  averageNav, valueFundPosition, summarizeFunds, byFundValue, usedCurrencies,
} from '../js/lib/funds.js';

const U = (n) => Math.round(n * UNIT_SCALE);   // 單位數 → 內部整數
const N = (n) => Math.round(n * NAV_SCALE);    // 淨值 → 內部整數
const R = (n) => Math.round(n * FX_SCALE);     // 匯率 → 內部整數

/** 建立一筆交易，補齊預設值讓測試讀起來乾淨 */
const tr = (o) => ({
  date: '2026-01-01', fundId: 'F1', name: '測試基金', currency: 'TWD',
  action: FUND_ACTION.BUY, units: 0, nav: 0, fxRate: TWD_RATE,
  fee: 0, amount: 0, createdAt: 0, ...o,
});

const pos = (trades, fundId = 'F1') =>
  computeFundPositions(trades).find((p) => p.fundId === fundId);

// ── 數值精度 ──────────────────────────────────────────────
// 這一組是整個模組的地基。倍率選錯會讓大額部位無聲失真，
// 而且失真之後畫面上仍是一個看起來很正常的數字。

test('單位數 × 淨值換算成原幣分', () => {
  // 1000.5 單位 × 12.3456 = 12,351.7728 元 → 1,235,177 分
  assert.equal(toForeignCents(U(1000.5), N(12.3456)), 1_235_177);
});

test('千萬單位 × 淨值 1000 仍在安全整數範圍內', () => {
  const cents = toForeignCents(U(10_000_000), N(1000));
  assert.equal(cents, 1_000_000_000_000);
  assert.ok(Number.isSafeInteger(cents));

  const twd = toTwdCents(cents, R(32.5));
  assert.equal(twd, 32_500_000_000_000);
  assert.ok(Number.isSafeInteger(twd));
});

test('直接把兩個高倍率整數相乘會爆掉 —— 這就是倍率只取 10^4 的原因', () => {
  // 記錄反例：units 用 10^4 倍、nav 若用 10^6 倍，10 萬單位 × 淨值 15 的乘積
  const naive = U(100_000) * (15 * 1_000_000);
  assert.ok(!Number.isSafeInteger(naive), '反例本身要真的超出安全範圍，這個測試才有意義');
  // 現行做法同樣的輸入不會失真：100,000 單位 × 15 = 1,500,000 元
  assert.equal(toForeignCents(U(100_000), N(15)), 150_000_000);
});

test('換台幣時先把匯率除回一般數值，順序顛倒會失真', () => {
  const foreign = 1_000_000_000_000;          // 100 億分
  assert.equal(toTwdCents(foreign, R(32.5)), 32_500_000_000_000);
  // 顛倒順序的反例：先乘 10^6 倍的匯率
  assert.ok(!Number.isSafeInteger(foreign * R(32.5)));
});

test('小數單位數用整數累加，不會出現 0.1 + 0.2 的誤差', () => {
  const p = pos([
    tr({ units: U(0.1), nav: N(10) }),
    tr({ units: U(0.2), nav: N(10), createdAt: 1 }),
  ]);
  assert.equal(p.units, U(0.3));
  assert.equal(unitsToNumber(p.units), 0.3);
});

test('沒有匯率時換算回 null，不會偷偷當成 1', () => {
  assert.equal(toTwdCents(100, null), null);
  assert.equal(toTwdCents(100, 0), null);
});

// ── 輸入解析 ──────────────────────────────────────────────

test('解析單位數、淨值、匯率', () => {
  assert.equal(parseUnits('1,234.5678'), 12_345_678);
  assert.equal(parseNav('12.3456'), 123_456);
  assert.equal(parseRate('32.456789'), 32_456_789);
});

test('空白或非數字回 null，不回 0', () => {
  // 回 0 會讓「沒填」與「填了 0」變成同一件事
  assert.equal(parseUnits(''), null);
  assert.equal(parseNav('abc'), null);
  assert.equal(parseRate(null), null);
});

// ── 驗證 ─────────────────────────────────────────────────

test('沒有代碼不能存', () => {
  const r = validateFundTrade({ fundId: '  ', action: FUND_ACTION.BUY, date: '2026-01-01' });
  assert.equal(r.ok, false);
});

test('幣別統一轉大寫', () => {
  const r = validateFundTrade({
    fundId: 'F1', action: FUND_ACTION.BUY, date: '2026-01-01',
    currency: 'usd', units: U(1), nav: N(10), fxRate: R(32),
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.currency, 'USD');
});

test('幣別要是三個英文字母', () => {
  const r = validateFundTrade({
    fundId: 'F1', action: FUND_ACTION.BUY, date: '2026-01-01',
    currency: 'US', units: U(1), nav: N(10), fxRate: R(32),
  });
  assert.equal(r.ok, false);
});

test('外幣沒填匯率會被擋下，錯誤訊息要講是哪一種幣別', () => {
  const r = validateFundTrade({
    fundId: 'F1', action: FUND_ACTION.BUY, date: '2026-01-01',
    currency: 'USD', units: U(1), nav: N(10),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /USD/);
});

test('台幣基金不必填匯率，程式自己補 1', () => {
  const r = validateFundTrade({
    fundId: 'F1', action: FUND_ACTION.BUY, date: '2026-01-01',
    currency: 'TWD', units: U(1), nav: N(10),
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.fxRate, TWD_RATE);
});

test('台幣基金就算填了別的匯率也會被改回 1', () => {
  const r = validateFundTrade({
    fundId: 'F1', action: FUND_ACTION.BUY, date: '2026-01-01',
    currency: 'TWD', units: U(1), nav: N(10), fxRate: R(32),
  });
  assert.equal(r.value.fxRate, TWD_RATE);
});

test('單位數要大於 0', () => {
  const r = validateFundTrade({
    fundId: 'F1', action: FUND_ACTION.BUY, date: '2026-01-01', units: 0, nav: N(10),
  });
  assert.equal(r.ok, false);
});

test('申購的淨值要大於 0，但期初持份可以是 0', () => {
  const buy = validateFundTrade({
    fundId: 'F1', action: FUND_ACTION.BUY, date: '2026-01-01', units: U(1), nav: 0,
  });
  assert.equal(buy.ok, false);

  // 整批都由配息再投資取得時，成本真的就是零
  const opening = validateFundTrade({
    fundId: 'F1', action: FUND_ACTION.OPENING, date: '2026-01-01', units: U(1), nav: 0,
  });
  assert.equal(opening.ok, true);
});

test('配息金額要大於 0', () => {
  const r = validateFundTrade({
    fundId: 'F1', action: FUND_ACTION.DIVIDEND, date: '2026-01-01', amount: 0,
  });
  assert.equal(r.ok, false);
});

test('costUnknown 只有期初持份才成立', () => {
  const buy = validateFundTrade({
    fundId: 'F1', action: FUND_ACTION.BUY, date: '2026-01-01',
    units: U(1), nav: N(10), costUnknown: true,
  });
  assert.equal(buy.value.costUnknown, false);
});

// ── 成本累加與加權平均 ─────────────────────────────────────

test('申購手續費計入成本', () => {
  // 1000 單位 × 10 元 = 10,000 元，加 100 元手續費
  const p = pos([tr({ units: U(1000), nav: N(10), fee: 10_000 })]);
  assert.equal(p.totalCostForeign, 1_010_000);
  assert.equal(averageNav(p), 10.1);
});

test('兩次申購取加權平均', () => {
  const p = pos([
    tr({ units: U(1000), nav: N(10) }),
    tr({ date: '2026-02-01', units: U(1000), nav: N(20) }),
  ]);
  assert.equal(p.units, U(2000));
  assert.equal(p.totalCostForeign, 3_000_000);   // 10,000 + 20,000 元
  assert.equal(averageNav(p), 15);
});

test('外幣基金的原幣成本與台幣成本各自累加', () => {
  // 1000 單位 × 10 USD，匯率 30 → 10,000 USD / 300,000 元
  const p = pos([tr({ currency: 'USD', units: U(1000), nav: N(10), fxRate: R(30) })]);
  assert.equal(p.totalCostForeign, 1_000_000);
  assert.equal(p.totalCostTwd, 30_000_000);
});

test('同一檔用兩種匯率申購，台幣成本按各自當日匯率累加', () => {
  const p = pos([
    tr({ currency: 'USD', units: U(1000), nav: N(10), fxRate: R(30) }),
    tr({ date: '2026-06-01', currency: 'USD', units: U(1000), nav: N(10), fxRate: R(32) }),
  ]);
  assert.equal(p.totalCostForeign, 2_000_000);              // 20,000 USD
  assert.equal(p.totalCostTwd, 30_000_000 + 32_000_000);    // 620,000 元
});

// ── 贖回 ─────────────────────────────────────────────────

test('贖回時原幣與台幣成本依同一比例攤提', () => {
  const p = pos([
    tr({ currency: 'USD', units: U(1000), nav: N(10), fxRate: R(30) }),
    tr({
      date: '2026-06-01', currency: 'USD', action: FUND_ACTION.SELL,
      units: U(400), nav: N(12), fxRate: R(32),
    }),
  ]);
  assert.equal(p.units, U(600));
  assert.equal(p.totalCostForeign, 600_000);     // 剩 6,000 USD
  assert.equal(p.totalCostTwd, 18_000_000);      // 剩 180,000 元

  // 原幣：480,000 收入 − 400,000 成本
  assert.equal(p.realizedForeign, 80_000);
  // 台幣：15,360,000 收入（今日匯率）− 12,000,000 成本（申購日匯率），匯兌損益自然含在裡面
  assert.equal(p.realizedTwd, 3_360_000);
});

test('全部贖回後成本歸零，不留四捨五入的零頭', () => {
  const p = pos([
    tr({ units: U(333), nav: N(3.3333) }),
    tr({ date: '2026-06-01', action: FUND_ACTION.SELL, units: U(333), nav: N(4) }),
  ]);
  assert.equal(p.units, 0);
  assert.equal(p.totalCostForeign, 0);
  assert.equal(p.totalCostTwd, 0);
});

test('贖回超過持有量會留下警告，而不是算出負的持份', () => {
  const p = pos([
    tr({ units: U(100), nav: N(10) }),
    tr({ date: '2026-06-01', action: FUND_ACTION.SELL, units: U(150), nav: N(12) }),
  ]);
  assert.equal(p.units, 0);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /只持有 100 單位/);
});

test('贖回手續費從收入扣除', () => {
  const p = pos([
    tr({ units: U(1000), nav: N(10) }),
    tr({ date: '2026-06-01', action: FUND_ACTION.SELL, units: U(1000), nav: N(12), fee: 5_000 }),
  ]);
  // 1,200,000 − 50 元手續費 − 1,000,000 成本
  assert.equal(p.realizedForeign, 1_200_000 - 5_000 - 1_000_000);
});

// ── 配息 ─────────────────────────────────────────────────

test('現金配息計入已實現，不沖減成本；總報酬在配息當下不變', () => {
  // 淨值 10 時持有 1000 單位、成本 10,000 元；配息 500 元後淨值降到 9.5
  const p = pos([
    tr({ units: U(1000), nav: N(10) }),
    tr({ date: '2026-06-01', action: FUND_ACTION.DIVIDEND, amount: 50_000 }),
  ]);
  assert.equal(p.totalCostForeign, 1_000_000, '配息不沖減成本');
  assert.equal(p.realizedTwd, 50_000);

  const v = valueFundPosition(p, N(9.5), TWD_RATE);
  assert.equal(v.unrealized, -50_000);
  assert.equal(v.totalReturn, 0, '配息不會讓人憑空變富或變窮');
});

test('配息再投資：成本與已實現同時增加，總報酬當下不變', () => {
  // 淨值 10 → 配息每單位 0.5 元 → 淨值 9.5，500 元用 9.5 換成 52.6316 單位
  const p = pos([
    tr({ units: U(1000), nav: N(10) }),
    tr({ date: '2026-06-01', action: FUND_ACTION.REINVEST, units: U(52.6316), nav: N(9.5) }),
  ]);
  assert.equal(p.units, U(1052.6316));
  assert.equal(p.totalCostForeign, 1_050_000, '再投資的部分要進成本');
  assert.equal(p.realizedTwd, 50_000, '同時也是一筆配息收入');
  assert.equal(p.dividendsTwd, 50_000);

  const v = valueFundPosition(p, N(9.5), TWD_RATE);
  assert.equal(v.unrealized, -50_000);
  assert.equal(v.totalReturn, 0);
});

// ── 評價：原幣與台幣兩種報酬率 ──────────────────────────────

test('外幣基金同時給出原幣報酬率與台幣報酬率', () => {
  // 成本 10,000 USD @ 30；現值 12,000 USD @ 32
  const p = pos([tr({ currency: 'USD', units: U(1000), nav: N(10), fxRate: R(30) })]);
  const v = valueFundPosition(p, N(12), R(32));

  assert.equal(v.marketValueForeign, 1_200_000);
  assert.equal(v.marketValue, 38_400_000);          // 384,000 元
  assert.equal(v.unrealizedForeign, 200_000);       // +2,000 USD
  assert.equal(v.unrealized, 8_400_000);            // +84,000 元
  assert.equal(v.returnRateForeign, 0.2);           // 基金本身漲 20%
  assert.equal(v.returnRate, 0.28);                 // 換回台幣賺 28%
});

test('匯兌損益 = 原幣成本 × 匯率變動', () => {
  const p = pos([tr({ currency: 'USD', units: U(1000), nav: N(10), fxRate: R(30) })]);
  const v = valueFundPosition(p, N(12), R(32));
  // 10,000 USD 的成本部位，匯率從 30 漲到 32 → 20,000 元
  assert.equal(v.fxEffect, 2_000_000);
  // 台幣損益 = 基金績效（以今日匯率計）＋ 匯兌損益
  assert.equal(v.unrealized, toTwdCents(v.unrealizedForeign, R(32)) + v.fxEffect);
});

test('匯率下跌時基金賺錢也可能換回台幣是虧的', () => {
  // 成本 10,000 USD @ 35；現值 10,500 USD @ 31
  const p = pos([tr({ currency: 'USD', units: U(1000), nav: N(10), fxRate: R(35) })]);
  const v = valueFundPosition(p, N(10.5), R(31));
  assert.ok(v.returnRateForeign > 0, '原幣是賺的');
  assert.ok(v.returnRate < 0, '換回台幣是虧的');
});

test('台幣基金不需要匯率表也算得出來', () => {
  const p = pos([tr({ units: U(1000), nav: N(10) })]);
  const v = valueFundPosition(p, N(12), null);
  assert.equal(v.marketValue, 1_200_000);
  assert.equal(v.unrealized, 200_000);
});

test('外幣基金缺匯率時市值是 null，不是 0', () => {
  const p = pos([tr({ currency: 'USD', units: U(1000), nav: N(10), fxRate: R(30) })]);
  const v = valueFundPosition(p, N(12), null);
  assert.equal(v.marketValueForeign, 1_200_000, '原幣市值仍算得出來');
  assert.equal(v.marketValue, null, '缺匯率就不能給台幣數字');
  assert.equal(v.unrealized, null);
});

test('缺淨值時市值是 null', () => {
  const p = pos([tr({ units: U(1000), nav: N(10) })]);
  const v = valueFundPosition(p, null, TWD_RATE);
  assert.equal(v.marketValue, null);
  assert.equal(v.unrealized, null);
});

test('成本未知的持份算得出市值，但不給損益', () => {
  const p = pos([tr({
    action: FUND_ACTION.OPENING, units: U(1000), nav: 0, costUnknown: true,
  })]);
  const v = valueFundPosition(p, N(12), TWD_RATE);
  assert.equal(v.costUnknown, true);
  assert.equal(v.marketValue, 1_200_000);
  assert.equal(v.unrealized, null, '成本是 0 不代表賺了整個市值');
  assert.equal(v.returnRate, null);
});

// ── 幣別一致性 ────────────────────────────────────────────

test('同一檔基金出現兩種幣別會留下警告，並沿用第一筆', () => {
  const p = pos([
    tr({ currency: 'USD', units: U(1000), nav: N(10), fxRate: R(30) }),
    tr({ date: '2026-06-01', currency: 'EUR', units: U(100), nav: N(10), fxRate: R(35) }),
  ]);
  assert.equal(p.currency, 'USD');
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /EUR/);
});

// ── 組合彙總 ──────────────────────────────────────────────

const twoFunds = [
  tr({ fundId: 'A', name: '台幣基金', units: U(1000), nav: N(10) }),
  tr({ fundId: 'B', name: '美元基金', currency: 'USD', units: U(1000), nav: N(10), fxRate: R(30) }),
];

test('彙總的金額一律是台幣', () => {
  const s = summarizeFunds(computeFundPositions(twoFunds), { A: N(12), B: N(11) }, { USD: R(32) });
  // A：1000 × 12 = 12,000 元；B：1000 × 11 USD × 32 = 352,000 元
  assert.equal(s.marketValue, 1_200_000 + 35_200_000);
  assert.equal(s.totalCost, 1_000_000 + 30_000_000);
  assert.equal(s.complete, true);
});

test('缺淨值與缺匯率要分開講，因為要補的東西不一樣', () => {
  const s = summarizeFunds(computeFundPositions(twoFunds), { B: N(11) }, {});
  assert.deepEqual(s.missingNav, ['A'], 'A 沒有淨值');
  assert.deepEqual(s.missingRate, ['USD'], 'B 有淨值但沒有匯率');
  assert.equal(s.complete, false);
});

test('算不出來的部位不併進總額，也不當成 0', () => {
  const s = summarizeFunds(computeFundPositions(twoFunds), { A: N(12) }, {});
  assert.equal(s.marketValue, 1_200_000, '只含算得出來的 A');
  assert.equal(s.pricedCount, 1);
  assert.equal(s.heldCount, 2);
});

test('報酬率的分母只算有報價的部位', () => {
  const s = summarizeFunds(computeFundPositions(twoFunds), { A: N(12) }, {});
  // 只有 A：成本 10,000 元、現值 12,000 元
  assert.equal(s.unrealized, 200_000);
  assert.equal(s.returnRate, 0.2);
});

test('全部贖回的基金仍留在列表裡，已實現損益不會消失', () => {
  const rows = computeFundPositions([
    tr({ units: U(1000), nav: N(10) }),
    tr({ date: '2026-06-01', action: FUND_ACTION.SELL, units: U(1000), nav: N(12) }),
  ]);
  const s = summarizeFunds(rows, {}, {});
  assert.equal(s.heldCount, 0);
  assert.equal(s.realized, 200_000);
  assert.equal(s.rows.length, 1);
});

test('依台幣市值排序，沒有市值的排最後', () => {
  const s = summarizeFunds(computeFundPositions(twoFunds), { A: N(12), B: N(11) }, { USD: R(32) });
  const sorted = byFundValue(s.rows);
  assert.deepEqual(sorted.map((r) => r.fundId), ['B', 'A']);

  const partial = summarizeFunds(computeFundPositions(twoFunds), { A: N(12) }, {});
  assert.deepEqual(byFundValue(partial.rows).map((r) => r.fundId), ['A', 'B']);
});

test('只列出真正持有的外幣幣別，匯率表才不會叫人填用不到的', () => {
  const positions = computeFundPositions([
    ...twoFunds,
    tr({ fundId: 'C', currency: 'EUR', units: U(10), nav: N(10), fxRate: R(35) }),
    tr({ fundId: 'C', date: '2026-06-01', currency: 'EUR', action: FUND_ACTION.SELL, units: U(10), nav: N(11), fxRate: R(35) }),
  ]);
  // A 是台幣不必填；C 已經全部贖回，也不必填
  assert.deepEqual(usedCurrencies(positions), ['USD']);
});

// ── 交易順序 ──────────────────────────────────────────────

test('同一天的申購排在贖回前面，不會出現贖回還沒買的單位', () => {
  const p = pos([
    tr({ date: '2026-03-01', action: FUND_ACTION.SELL, units: U(500), nav: N(12), createdAt: 2 }),
    tr({ date: '2026-03-01', action: FUND_ACTION.BUY, units: U(1000), nav: N(10), createdAt: 1 }),
  ]);
  assert.equal(p.units, U(500));
  assert.equal(p.warnings.length, 0);
});

test('輸入順序顛倒不影響結果', () => {
  const trades = [
    tr({ date: '2026-01-01', units: U(1000), nav: N(10) }),
    tr({ date: '2026-06-01', units: U(1000), nav: N(20) }),
  ];
  const a = pos(trades);
  const b = pos([...trades].reverse());
  assert.equal(a.totalCostForeign, b.totalCostForeign);
  assert.equal(a.units, b.units);
});
