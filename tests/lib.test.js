/**
 * 核心邏輯自我測試。
 * 執行：npm test   （等同 node --test tests/）
 *
 * 這裡只測純函式（金額、日期、統計、備份），不碰 IndexedDB。
 * IndexedDB 的部分由瀏覽器端的 test.html 負責。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAmount, formatAmount, formatCurrency, groupDigits, sumCents, evaluateExpression } from '../js/lib/money.js';
import {
  toISODate, fromISODate, isValidISODate, monthKey, shiftMonth, monthRange,
  recentMonths, formatMonthLabel, formatRelativeDay, daysBetween, isWithin,
} from '../js/lib/dateutil.js';
import {
  accountBalances, netWorth, filterByMonth, summarize, groupByCategory,
  groupByMonth, groupByDay, dailyAverageExpense,
} from '../js/lib/stats.js';
import { validateTransaction, validateAccount, validateCategory, newId, DEFAULT_CATEGORIES } from '../js/lib/schema.js';
import { buildBackup, serializeBackup, parseBackup, mergeCollections, transactionsToCSV, csvCell } from '../js/lib/backup.js';

// ---------------------------------------------------------------- money

test('parseAmount 解析各種輸入格式', () => {
  assert.equal(parseAmount('100'), 10000);
  assert.equal(parseAmount('1,234.5'), 123450);
  assert.equal(parseAmount(' 99.99 '), 9999);
  assert.equal(parseAmount('-50'), -5000);
  assert.equal(parseAmount('１２３'), 12300, '全形數字要能解析');
  assert.equal(parseAmount('12．5'), 1250, '全形句點要視為小數點');
  assert.equal(parseAmount(0.1), 10);
});

test('parseAmount 對無效輸入回傳 null 而不是 0', () => {
  // 回傳 0 會讓使用者以為記了一筆 0 元的帳，必須明確失敗
  for (const bad of ['', '   ', 'abc', '1.2.3', '-', '.', '12a', null, undefined, {}, NaN]) {
    assert.equal(parseAmount(bad), null, `輸入 ${JSON.stringify(bad)} 應為 null`);
  }
});

test('parseAmount 避免浮點誤差', () => {
  assert.equal(parseAmount('19.99'), 1999);
  assert.equal(parseAmount('0.07'), 7);
  assert.equal(parseAmount('8.29'), 829);
  // 這幾個數字直接乘 100 會得到 1998.9999999999998 之類的結果
  assert.equal(parseAmount('1.15'), 115);
  assert.equal(parseAmount('1.005'), 101);
});

test('formatAmount 千分位與小數處理', () => {
  assert.equal(formatAmount(123450), '1,234.50');
  assert.equal(formatAmount(10000), '100', 'auto 模式整數不顯示 .00');
  assert.equal(formatAmount(10000, { decimals: 'always' }), '100.00');
  assert.equal(formatAmount(-123456789), '-1,234,567.89');
  assert.equal(formatAmount(10000, { sign: true }), '+100');
  assert.equal(formatAmount(0), '0');
  assert.equal(formatAmount(NaN), '—');
  assert.equal(formatAmount(99, { decimals: 'never' }), '1', '0.99 四捨五入為 1');
});

test('formatCurrency 負號在貨幣符號之前', () => {
  assert.equal(formatCurrency(-500000), '-NT$5,000');
  assert.equal(formatCurrency(500000), 'NT$5,000');
});

test('groupDigits 與 sumCents', () => {
  assert.equal(groupDigits(0), '0');
  assert.equal(groupDigits(999), '999');
  assert.equal(groupDigits(1000), '1,000');
  assert.equal(groupDigits(1234567), '1,234,567');
  assert.equal(sumCents([{ v: 100 }, { v: 250 }, { v: NaN }], (x) => x.v), 350);
  assert.equal(sumCents([]), 0);
});

test('evaluateExpression 支援記帳時的簡單四則運算', () => {
  assert.equal(evaluateExpression('35+50'), 8500);
  assert.equal(evaluateExpression('100-30'), 7000);
  assert.equal(evaluateExpression('35+50*2'), 13500, '乘法優先');
  assert.equal(evaluateExpression('120/4'), 3000);
  assert.equal(evaluateExpression('1200'), 120000);
  assert.equal(evaluateExpression('10/0'), null, '除以零要擋掉');
  assert.equal(evaluateExpression('1++2'), null);
  assert.equal(evaluateExpression('alert(1)'), null, '不能執行任意程式碼');
});

// ---------------------------------------------------------------- dateutil

test('toISODate 使用本地時區，不會因 UTC 位移而跳日', () => {
  // 台灣時間凌晨 1 點，用 toISOString() 會變成前一天
  const d = new Date(2026, 8, 1, 1, 0, 0);
  assert.equal(toISODate(d), '2026-09-01');
  assert.equal(toISODate(new Date(2026, 0, 5)), '2026-01-05');
});

test('fromISODate 擋掉不存在的日期', () => {
  assert.equal(fromISODate('2025-02-30'), null);
  assert.equal(fromISODate('2025-13-01'), null);
  assert.equal(fromISODate('2025-1-1'), null, '必須補零');
  assert.equal(fromISODate('abc'), null);
  assert.ok(fromISODate('2024-02-29'), '閏年 2/29 有效');
  assert.equal(isValidISODate('2025-02-28'), true);
});

test('shiftMonth 跨年正確', () => {
  assert.equal(shiftMonth('2025-01', -1), '2024-12');
  assert.equal(shiftMonth('2025-12', 1), '2026-01');
  assert.equal(shiftMonth('2025-11', 3), '2026-02');
  assert.equal(shiftMonth('2025-03', -15), '2023-12');
  assert.equal(shiftMonth('2025-06', 0), '2025-06');
});

test('monthRange 處理各月天數與閏年', () => {
  assert.deepEqual(monthRange('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(monthRange('2025-02'), { start: '2025-02-01', end: '2025-02-28' });
  assert.deepEqual(monthRange('2025-04'), { start: '2025-04-01', end: '2025-04-30' });
  assert.deepEqual(monthRange('2025-12'), { start: '2025-12-01', end: '2025-12-31' });
});

test('recentMonths / formatMonthLabel / daysBetween / isWithin', () => {
  assert.deepEqual(recentMonths('2025-02', 4), ['2024-11', '2024-12', '2025-01', '2025-02']);
  assert.equal(monthKey('2025-07-15'), '2025-07');
  assert.equal(formatMonthLabel('2025-07'), '2025年7月');
  assert.equal(daysBetween('2025-01-01', '2025-01-31'), 30);
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2, '閏年跨月');
  assert.equal(daysBetween('bad', '2025-01-01'), null);
  assert.equal(isWithin('2025-05-10', '2025-05-01', '2025-05-31'), true);
  assert.equal(isWithin('2025-06-01', '2025-05-01', '2025-05-31'), false);
});

test('formatRelativeDay 顯示今天與昨天', () => {
  const now = new Date(2026, 8, 1);
  assert.equal(formatRelativeDay('2026-09-01', now), '今天');
  assert.equal(formatRelativeDay('2026-08-31', now), '昨天');
  assert.equal(formatRelativeDay('2026-08-30', now), '8/30 (日)');
});

// ---------------------------------------------------------------- stats

const ACCOUNTS = [
  { id: 'cash', name: '現金', kind: 'cash', valuationMode: 'tracked', openingBalance: 500000 },
  { id: 'bank', name: '銀行', kind: 'bank', valuationMode: 'tracked', openingBalance: 10000000 },
  { id: 'card', name: '信用卡', kind: 'credit', valuationMode: 'tracked', openingBalance: 0 },
  { id: 'house', name: '房子', kind: 'property', valuationMode: 'manual', manualValue: 1200000000 },
  { id: 'mortgage', name: '房貸', kind: 'loan', valuationMode: 'manual', manualValue: -800000000 },
];

const TXS = [
  { id: 't1', date: '2026-08-05', type: 'expense', amount: 12000, accountId: 'cash', categoryId: 'food', createdAt: 1 },
  { id: 't2', date: '2026-08-05', type: 'expense', amount: 30000, accountId: 'card', categoryId: 'food', createdAt: 2 },
  { id: 't3', date: '2026-08-10', type: 'income', amount: 8000000, accountId: 'bank', categoryId: 'salary', createdAt: 3 },
  { id: 't4', date: '2026-08-15', type: 'expense', amount: 150000, accountId: 'bank', categoryId: 'rent', createdAt: 4 },
  { id: 't5', date: '2026-08-20', type: 'transfer', amount: 100000, accountId: 'bank', toAccountId: 'cash', createdAt: 5 },
  { id: 't6', date: '2026-07-03', type: 'expense', amount: 25000, accountId: 'cash', categoryId: 'food', createdAt: 6 },
];

test('accountBalances 正確累加各類交易', () => {
  const b = accountBalances(ACCOUNTS, TXS);
  // 現金: 5000 - 120 - 250(七月) + 1000(轉入) = 5630
  assert.equal(b.get('cash'), 500000 - 12000 - 25000 + 100000);
  // 銀行: 100000 + 80000 - 1500 - 1000(轉出) = 177500
  assert.equal(b.get('bank'), 10000000 + 8000000 - 150000 - 100000);
  // 信用卡刷了 300 → 負債 -300
  assert.equal(b.get('card'), -30000);
});

test('manual 帳戶不受交易影響', () => {
  const txsHittingHouse = [
    ...TXS,
    { id: 'x', date: '2026-08-01', type: 'expense', amount: 999999, accountId: 'house', categoryId: 'food' },
  ];
  const b = accountBalances(ACCOUNTS, txsHittingHouse);
  assert.equal(b.get('house'), 1200000000, '手動估值帳戶固定採用使用者填的數字');
  assert.equal(b.get('mortgage'), -800000000);
});

test('netWorth 資產負債分開統計', () => {
  const nw = netWorth(ACCOUNTS, TXS);
  const balances = accountBalances(ACCOUNTS, TXS);
  const expectedAssets = balances.get('cash') + balances.get('bank') + balances.get('house');
  assert.equal(nw.assets, expectedAssets);
  assert.equal(nw.liabilities, 30000 + 800000000, '信用卡欠款 + 房貸，以正數表示');
  assert.equal(nw.net, nw.assets - nw.liabilities);
  assert.equal(nw.rows[0].accountId, 'house', 'rows 依餘額由大到小');
});

test('netWorth 忽略已封存的帳戶', () => {
  const withArchived = [...ACCOUNTS, { id: 'old', name: '舊戶', kind: 'bank', valuationMode: 'manual', manualValue: 99900000, archived: true }];
  const a = netWorth(ACCOUNTS, TXS);
  const b = netWorth(withArchived, TXS);
  assert.equal(a.net, b.net);
});

test('summarize 不把轉帳算成收入或支出', () => {
  const aug = filterByMonth(TXS, '2026-08');
  assert.equal(aug.length, 5);
  const s = summarize(aug);
  assert.equal(s.income, 8000000);
  assert.equal(s.expense, 12000 + 30000 + 150000);
  assert.equal(s.net, s.income - s.expense);
  assert.equal(s.count, 4, '轉帳不計入筆數');
});

test('filterByMonth 只取指定月份', () => {
  assert.equal(filterByMonth(TXS, '2026-07').length, 1);
  assert.equal(filterByMonth(TXS, '2026-09').length, 0);
  assert.equal(filterByMonth(TXS, null).length, TXS.length);
});

test('groupByCategory 依金額排序且百分比合計為 100', () => {
  const rows = groupByCategory(filterByMonth(TXS, '2026-08'), 'expense');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].categoryId, 'rent');
  assert.equal(rows[0].total, 150000);
  assert.equal(rows[1].categoryId, 'food');
  assert.equal(rows[1].total, 42000);
  assert.equal(rows[1].count, 2);
  const pctSum = rows.reduce((a, r) => a + r.pct, 0);
  assert.ok(Math.abs(pctSum - 100) < 1e-9);
});

test('groupByCategory 空資料不會除以零', () => {
  const rows = groupByCategory([], 'expense');
  assert.deepEqual(rows, []);
});

test('groupByMonth 補齊沒有交易的月份', () => {
  const rows = groupByMonth(TXS, recentMonths('2026-09', 3));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.month), ['2026-07', '2026-08', '2026-09']);
  assert.equal(rows[2].income, 0, '沒有資料的月份補 0，圖表才不會斷線');
  assert.equal(rows[1].expense, 192000);
});

test('groupByDay 日期新的在前，同日內新建的在前', () => {
  const days = groupByDay(filterByMonth(TXS, '2026-08'));
  assert.deepEqual(days.map((d) => d.date), ['2026-08-20', '2026-08-15', '2026-08-10', '2026-08-05']);
  const firstDay = days[days.length - 1];
  assert.equal(firstDay.items[0].id, 't2', '同一天內 createdAt 大的排前面');
});

test('dailyAverageExpense 當月以今天的日數為分母', () => {
  // 八月支出 1920 元，若以 31 天算會被稀釋
  assert.equal(dailyAverageExpense(TXS, '2026-08', '2026-08-10'), Math.round(192000 / 10));
  assert.equal(dailyAverageExpense(TXS, '2026-08', '2026-09-01'), Math.round(192000 / 31), '非當月用整月天數');
});

// ---------------------------------------------------------------- schema

test('validateTransaction 拒絕金額為 0 或負數', () => {
  const base = { type: 'expense', date: '2026-09-01', accountId: 'cash', categoryId: 'food' };
  assert.equal(validateTransaction({ ...base, amount: 0 }).ok, false);
  assert.equal(validateTransaction({ ...base, amount: -100 }).ok, false);
  assert.equal(validateTransaction({ ...base, amount: 100 }).ok, true);
});

test('validateTransaction 檢查日期、類型與必填欄位', () => {
  const base = { type: 'expense', date: '2026-09-01', amount: 100, accountId: 'cash', categoryId: 'food' };
  assert.equal(validateTransaction({ ...base, date: '2026-9-1' }).ok, false);
  assert.equal(validateTransaction({ ...base, type: 'foo' }).ok, false);
  assert.equal(validateTransaction({ ...base, accountId: '' }).ok, false);
  assert.equal(validateTransaction({ ...base, categoryId: '' }).ok, false);
});

test('validateTransaction 轉帳規則', () => {
  const t = { type: 'transfer', date: '2026-09-01', amount: 100, accountId: 'a', toAccountId: 'b' };
  const ok = validateTransaction(t);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.categoryId, null, '轉帳不需要分類');
  assert.equal(validateTransaction({ ...t, toAccountId: 'a' }).ok, false, '不能轉給自己');
  assert.equal(validateTransaction({ ...t, toAccountId: '' }).ok, false);
});

test('validateTransaction 比對已存在的帳戶與分類 ID', () => {
  const ctx = { accountIds: new Set(['cash']), categoryIds: new Set(['food']) };
  const base = { type: 'expense', date: '2026-09-01', amount: 100, accountId: 'cash', categoryId: 'food' };
  assert.equal(validateTransaction(base, ctx).ok, true);
  assert.equal(validateTransaction({ ...base, accountId: 'ghost' }, ctx).ok, false);
  assert.equal(validateTransaction({ ...base, categoryId: 'ghost' }, ctx).ok, false);
});

test('validateAccount 與 validateCategory', () => {
  assert.equal(validateAccount({ name: '', kind: 'cash' }).ok, false);
  assert.equal(validateAccount({ name: '測試', kind: '不存在' }).ok, false);
  const acc = validateAccount({ name: ' 郵局 ', kind: 'bank', openingBalance: '123' });
  assert.equal(acc.ok, true);
  assert.equal(acc.value.name, '郵局', '名稱要 trim');
  assert.equal(acc.value.valuationMode, 'tracked', '未指定時預設為 tracked');

  assert.equal(validateCategory({ name: '午餐', type: 'expense' }).ok, true);
  assert.equal(validateCategory({ name: '午餐', type: 'transfer' }).ok, false);
  assert.equal(validateCategory({ name: '午餐', type: 'expense', color: 'red' }).value.color, '#94a3b8', '無效色碼退回預設值');
});

test('newId 產生唯一值', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(newId());
  assert.equal(ids.size, 1000);
});

test('預設分類涵蓋收入與支出', () => {
  assert.ok(DEFAULT_CATEGORIES.some((c) => c.type === 'income'));
  assert.ok(DEFAULT_CATEGORIES.filter((c) => c.type === 'expense').length >= 5);
});

// ---------------------------------------------------------------- backup

const SAMPLE = {
  accounts: [{ id: 'cash', name: '現金', kind: 'cash', valuationMode: 'tracked', openingBalance: 0 }],
  categories: [{ id: 'food', name: '飲食', type: 'expense', icon: '🍜', color: '#f97316' }],
  transactions: [{ id: 't1', date: '2026-09-01', type: 'expense', amount: 12000, accountId: 'cash', categoryId: 'food', note: '午餐', createdAt: 1 }],
  snapshots: [{ id: 's1', date: '2026-09-01', assets: 100, liabilities: 0, net: 100, breakdown: [] }],
  settings: { currency: 'TWD' },
};

test('備份匯出後可以完整還原', () => {
  const text = serializeBackup(SAMPLE, '2026-09-01T00:00:00.000Z');
  const result = parseBackup(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.counts.transactions, 1);
  assert.equal(result.data.transactions[0].note, '午餐');
  assert.equal(result.data.transactions[0].amount, 12000);
  assert.equal(result.data.accounts[0].name, '現金');
  assert.equal(result.data.settings.currency, 'TWD');
});

test('buildBackup 標頭資訊正確', () => {
  const b = buildBackup(SAMPLE, '2026-09-01T00:00:00.000Z');
  assert.equal(b.app, 'MoneyBook');
  assert.equal(b.schemaVersion, 1);
  assert.equal(b.exportedAt, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(b.counts, { accounts: 1, categories: 1, transactions: 1, snapshots: 1 });
});

test('parseBackup 拒絕壞檔案', () => {
  assert.equal(parseBackup('not json').ok, false);
  assert.equal(parseBackup('null').ok, false);
  assert.equal(parseBackup('{"app":"OtherApp"}').ok, false);
  assert.equal(parseBackup('{"app":"MoneyBook","schemaVersion":99}').ok, false, '版本比 App 新要擋下來');
});

test('parseBackup 跳過壞資料但保留好資料', () => {
  const dirty = JSON.stringify({
    app: 'MoneyBook',
    schemaVersion: 1,
    data: {
      accounts: SAMPLE.accounts,
      categories: SAMPLE.categories,
      transactions: [
        SAMPLE.transactions[0],
        { id: 'bad1', date: '亂寫', type: 'expense', amount: 100, accountId: 'cash', categoryId: 'food' },
        { id: 'bad2', date: '2026-09-01', type: 'expense', amount: -5, accountId: 'cash', categoryId: 'food' },
        { id: 'bad3', date: '2026-09-01', type: 'expense', amount: 100, accountId: '不存在的帳戶', categoryId: 'food' },
      ],
    },
  });
  const result = parseBackup(dirty);
  assert.equal(result.ok, true);
  assert.equal(result.counts.transactions, 1, '只有一筆合法');
  assert.equal(result.skipped.length, 3);
  assert.ok(result.skipped[0].includes('transactions[1]'));
});

test('mergeCollections 以 id 去重，匯入的覆蓋現有的', () => {
  const existing = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  const incoming = [{ id: 'b', v: 2 }, { id: 'c', v: 2 }];
  const { list, added, replaced } = mergeCollections(existing, incoming);
  assert.equal(list.length, 3);
  assert.equal(added, 1);
  assert.equal(replaced, 1);
  assert.equal(list.find((x) => x.id === 'b').v, 2);
});

test('transactionsToCSV 產出可被 Excel 正確開啟的內容', () => {
  const csv = transactionsToCSV(SAMPLE.transactions, { accounts: SAMPLE.accounts, categories: SAMPLE.categories });
  assert.ok(csv.startsWith('﻿'), '必須有 BOM，否則 Excel 開中文會亂碼');
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '﻿日期,類型,金額,分類,帳戶,轉入帳戶,備註');
  assert.equal(lines[1], '2026-09-01,支出,120.00,飲食,現金,,午餐');
});

test('csvCell 正確逸出特殊字元', () => {
  assert.equal(csvCell('一般'), '一般');
  assert.equal(csvCell('含,逗號'), '"含,逗號"');
  assert.equal(csvCell('含"引號'), '"含""引號"');
  assert.equal(csvCell('含\n換行'), '"含\n換行"');
  assert.equal(csvCell(null), '');
});
