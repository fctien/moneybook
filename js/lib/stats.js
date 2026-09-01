/**
 * 統計與彙總。全部是純函式，不碰 DB、不碰 DOM，方便用 node --test 驗證。
 *
 * 重要規則：
 * 1. transaction.amount 一律為正數，方向由 type 決定。
 * 2. type === 'transfer' 只是把錢從一個帳戶搬到另一個，
 *    不計入收入也不計入支出，否則月報表會被還卡費、轉存這類動作灌水。
 * 3. 帳戶餘額為有號數：資產為正、負債為負。淨資產 = 所有餘額直接相加。
 */

import { sumCents } from './money.js';

export const TX_TYPES = ['income', 'expense', 'transfer'];

/**
 * 計算每個帳戶的目前餘額。
 * - valuationMode 'manual'：直接採用使用者填的估值（不動產、投資部位、房貸餘額等）
 * - valuationMode 'tracked'：期初餘額 + 交易累積（現金、銀行、信用卡）
 * @returns {Map<string, number>} accountId → cents（有號）
 */
export function accountBalances(accounts, transactions) {
  const balances = new Map();
  for (const acc of accounts ?? []) {
    const opening = acc.valuationMode === 'manual'
      ? toInt(acc.manualValue)
      : toInt(acc.openingBalance);
    balances.set(acc.id, opening);
  }

  for (const tx of transactions ?? []) {
    const amount = toInt(tx.amount);
    if (amount <= 0) continue;

    if (tx.type === 'income') {
      bump(balances, tx.accountId, amount);
    } else if (tx.type === 'expense') {
      bump(balances, tx.accountId, -amount);
    } else if (tx.type === 'transfer') {
      bump(balances, tx.accountId, -amount);
      bump(balances, tx.toAccountId, amount);
    }
  }

  // manual 帳戶不受交易影響，交易算完後蓋回去
  for (const acc of accounts ?? []) {
    if (acc.valuationMode === 'manual') balances.set(acc.id, toInt(acc.manualValue));
  }

  return balances;
}

/**
 * 淨資產。
 * @returns {{assets:number, liabilities:number, net:number, rows:Array}}
 *          liabilities 為正數（顯示用的欠款總額），net = assets - liabilities
 */
export function netWorth(accounts, transactions) {
  const balances = accountBalances(accounts, transactions);
  let assets = 0;
  let liabilities = 0;
  const rows = [];

  for (const acc of accounts ?? []) {
    if (acc.archived) continue;
    const balance = balances.get(acc.id) ?? 0;
    if (balance >= 0) assets += balance;
    else liabilities += -balance;
    rows.push({ accountId: acc.id, name: acc.name, kind: acc.kind, balance });
  }

  rows.sort((a, b) => b.balance - a.balance);
  return { assets, liabilities, net: assets - liabilities, rows };
}

/** 篩出指定月份（'YYYY-MM'）的交易 */
export function filterByMonth(transactions, key) {
  if (!key) return [...(transactions ?? [])];
  return (transactions ?? []).filter((tx) => typeof tx.date === 'string' && tx.date.slice(0, 7) === key);
}

/** 收支小計。transfer 不計入。 */
export function summarize(transactions) {
  let income = 0;
  let expense = 0;
  let count = 0;
  for (const tx of transactions ?? []) {
    const amount = toInt(tx.amount);
    if (amount <= 0) continue;
    if (tx.type === 'income') { income += amount; count++; }
    else if (tx.type === 'expense') { expense += amount; count++; }
  }
  return { income, expense, net: income - expense, count };
}

/**
 * 依分類彙總（圓餅圖 / 排行榜用），由金額大到小排序。
 * @param {'income'|'expense'} type
 * @returns {Array<{categoryId:string, total:number, count:number, pct:number}>} pct 為 0~100
 */
export function groupByCategory(transactions, type = 'expense') {
  const map = new Map();
  let total = 0;

  for (const tx of transactions ?? []) {
    if (tx.type !== type) continue;
    const amount = toInt(tx.amount);
    if (amount <= 0) continue;
    const key = tx.categoryId || '__uncategorized__';
    const entry = map.get(key) ?? { categoryId: key, total: 0, count: 0, pct: 0 };
    entry.total += amount;
    entry.count += 1;
    map.set(key, entry);
    total += amount;
  }

  const rows = [...map.values()].sort((a, b) => b.total - a.total || a.categoryId.localeCompare(b.categoryId));
  for (const row of rows) row.pct = total > 0 ? (row.total / total) * 100 : 0;
  return rows;
}

/**
 * 依月份彙總（趨勢圖用）。
 * @param {string[]} [months] 指定要輸出的月份清單；沒給就用資料中出現過的月份（由舊到新）
 */
export function groupByMonth(transactions, months) {
  const map = new Map();
  for (const tx of transactions ?? []) {
    const key = typeof tx.date === 'string' ? tx.date.slice(0, 7) : '';
    if (!key) continue;
    const amount = toInt(tx.amount);
    if (amount <= 0) continue;
    const entry = map.get(key) ?? { month: key, income: 0, expense: 0, net: 0 };
    if (tx.type === 'income') entry.income += amount;
    else if (tx.type === 'expense') entry.expense += amount;
    entry.net = entry.income - entry.expense;
    map.set(key, entry);
  }

  const keys = months ?? [...map.keys()].sort();
  return keys.map((key) => map.get(key) ?? { month: key, income: 0, expense: 0, net: 0 });
}

/**
 * 依日期分組（明細頁的分日清單）。日期新的在前，同日內建立時間新的在前。
 * @returns {Array<{date:string, income:number, expense:number, items:Array}>}
 */
export function groupByDay(transactions) {
  const map = new Map();
  for (const tx of transactions ?? []) {
    const date = typeof tx.date === 'string' ? tx.date : '';
    if (!date) continue;
    const entry = map.get(date) ?? { date, income: 0, expense: 0, items: [] };
    const amount = toInt(tx.amount);
    if (tx.type === 'income') entry.income += amount;
    else if (tx.type === 'expense') entry.expense += amount;
    entry.items.push(tx);
    map.set(date, entry);
  }

  const days = [...map.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const day of days) {
    day.items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  return days;
}

/** 分類使用頻率排行，讓記帳畫面把最常用的分類排前面 */
export function categoryFrequency(transactions, type) {
  const map = new Map();
  for (const tx of transactions ?? []) {
    if (type && tx.type !== type) continue;
    if (!tx.categoryId) continue;
    map.set(tx.categoryId, (map.get(tx.categoryId) ?? 0) + 1);
  }
  return map;
}

/** 該月每日平均支出（以「已過的天數」為分母，當月則用今天的日數，避免月初被稀釋） */
export function dailyAverageExpense(transactions, monthKey, todayISO) {
  const { expense } = summarize(filterByMonth(transactions, monthKey));
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) return 0;
  const daysInMonth = new Date(year, month, 0).getDate();
  let divisor = daysInMonth;
  if (typeof todayISO === 'string' && todayISO.slice(0, 7) === monthKey) {
    divisor = Math.max(1, Number(todayISO.slice(8, 10)));
  }
  return Math.round(expense / divisor);
}

/** 全體交易的總筆數與金額（設定頁顯示用） */
export function overallTotals(transactions) {
  return {
    count: (transactions ?? []).length,
    amount: sumCents(transactions ?? [], (tx) => toInt(tx.amount)),
  };
}

function bump(map, key, delta) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + delta);
}

function toInt(v) {
  return Number.isFinite(v) ? Math.round(v) : 0;
}
