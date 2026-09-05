/**
 * 應用狀態。
 *
 * 全部資料常駐記憶體，任何寫入都先進 IndexedDB 再更新記憶體並通知畫面重繪。
 * 順序刻意是「先落地、後更新」：如果資料庫寫入失敗（例如儲存空間爆掉），
 * 畫面不會顯示一筆實際上沒存進去的帳。
 */

import * as db from './db.js';
import { netWorth } from './lib/stats.js';
import {
  validateAccount, validateCategory, validateSnapshot, validateTransaction, newId,
} from './lib/schema.js';
import { todayISO } from './lib/dateutil.js';
import { computePositions, summarizePortfolio, validateTrade } from './lib/portfolio.js';

export const state = {
  accounts: [],
  categories: [],
  transactions: [],
  snapshots: [],
  settings: {},
  stockTrades: [],
  // 代號 → { symbol, close, date, source, updatedAt }
  quotes: {},
  ready: false,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error('畫面更新失敗', err);
    }
  }
}

export async function init() {
  await db.seedIfEmpty();
  const data = await db.loadAll();
  Object.assign(state, data, { ready: true });
  notify();
  return state;
}

export async function reload() {
  const data = await db.loadAll();
  Object.assign(state, data);
  notify();
}

// ------------------------------------------------------------- 查詢輔助

export function accountMap() {
  return new Map(state.accounts.map((a) => [a.id, a]));
}

export function categoryMap() {
  return new Map(state.categories.map((c) => [c.id, c]));
}

export function activeAccounts() {
  return state.accounts.filter((a) => !a.archived);
}

/**
 * 可以拿來記帳的帳戶。
 *
 * 手動估值的帳戶（股票、不動產、房貸）刻意排除在外：它們的餘額固定等於
 * 使用者填的估值，記在上面的收支完全不會改變餘額，那筆錢等於憑空消失。
 * 這類項目的正確做法是直接去「資產」頁更新估值。
 */
export function postableAccounts() {
  return state.accounts.filter((a) => !a.archived && a.valuationMode !== 'manual');
}

export function categoriesOfType(type) {
  return state.categories.filter((c) => c.type === type && !c.archived);
}

export function currentNetWorth() {
  return netWorth(state.accounts, state.transactions);
}

// ------------------------------------------------------------- 交易

export async function saveTransaction(input) {
  const result = validateTransaction(input, {
    accountIds: new Set(state.accounts.map((a) => a.id)),
    categoryIds: new Set(state.categories.map((c) => c.id)),
  });
  if (!result.ok) return result;

  await db.put(db.STORE.transactions, result.value);

  const index = state.transactions.findIndex((t) => t.id === result.value.id);
  if (index >= 0) state.transactions[index] = result.value;
  else state.transactions.push(result.value);

  notify();
  return result;
}

export async function deleteTransaction(id) {
  await db.remove(db.STORE.transactions, id);
  state.transactions = state.transactions.filter((t) => t.id !== id);
  notify();
}

export function findTransaction(id) {
  return state.transactions.find((t) => t.id === id) ?? null;
}

// ------------------------------------------------------------- 帳戶

export async function saveAccount(input) {
  const result = validateAccount({
    ...input,
    order: Number.isFinite(input.order) ? input.order : state.accounts.length,
  });
  if (!result.ok) return result;

  await db.put(db.STORE.accounts, result.value);

  const index = state.accounts.findIndex((a) => a.id === result.value.id);
  if (index >= 0) state.accounts[index] = result.value;
  else state.accounts.push(result.value);

  notify();
  return result;
}

/** 帳戶被交易引用時不允許刪除，否則那些交易會變成孤兒資料 */
export function accountUsage(id) {
  return state.transactions.filter((t) => t.accountId === id || t.toAccountId === id).length;
}

export async function deleteAccount(id) {
  if (accountUsage(id) > 0) {
    return { ok: false, error: '這個帳戶已有交易紀錄，請改用「封存」而不是刪除' };
  }
  await db.remove(db.STORE.accounts, id);
  state.accounts = state.accounts.filter((a) => a.id !== id);
  notify();
  return { ok: true };
}

// ------------------------------------------------------------- 分類

export async function saveCategory(input) {
  const result = validateCategory({
    ...input,
    order: Number.isFinite(input.order) ? input.order : state.categories.length,
  });
  if (!result.ok) return result;

  await db.put(db.STORE.categories, result.value);

  const index = state.categories.findIndex((c) => c.id === result.value.id);
  if (index >= 0) state.categories[index] = result.value;
  else state.categories.push(result.value);

  notify();
  return result;
}

export function categoryUsage(id) {
  return state.transactions.filter((t) => t.categoryId === id).length;
}

export async function deleteCategory(id) {
  if (categoryUsage(id) > 0) {
    return { ok: false, error: '這個分類已有交易紀錄，請改用「封存」而不是刪除' };
  }
  await db.remove(db.STORE.categories, id);
  state.categories = state.categories.filter((c) => c.id !== id);
  notify();
  return { ok: true };
}

// ------------------------------------------------------------- 淨資產快照

/**
 * 拍下目前的淨資產快照。
 * 同一天重複拍會覆蓋，避免一天內調整好幾次估值就產生一堆重複點把趨勢圖弄亂。
 */
export async function takeSnapshot(note = '', dateISO = todayISO()) {
  const nw = currentNetWorth();
  const existing = state.snapshots.find((s) => s.date === dateISO);

  const result = validateSnapshot({
    id: existing?.id ?? newId(),
    date: dateISO,
    assets: nw.assets,
    liabilities: nw.liabilities,
    net: nw.net,
    breakdown: nw.rows.map((r) => ({ accountId: r.accountId, name: r.name, balance: r.balance })),
    note,
    createdAt: existing?.createdAt,
  });
  if (!result.ok) return result;

  await db.put(db.STORE.snapshots, result.value);

  const index = state.snapshots.findIndex((s) => s.id === result.value.id);
  if (index >= 0) state.snapshots[index] = result.value;
  else state.snapshots.push(result.value);

  notify();
  return { ...result, replaced: Boolean(existing) };
}

export async function deleteSnapshot(id) {
  await db.remove(db.STORE.snapshots, id);
  state.snapshots = state.snapshots.filter((s) => s.id !== id);
  notify();
}

export function sortedSnapshots() {
  return [...state.snapshots].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ------------------------------------------------------------- 股票

export async function saveStockTrade(input) {
  const result = validateTrade(input);
  if (!result.ok) return result;
  if (!result.value.id) result.value.id = newId();

  await db.put(db.STORE.stockTrades, result.value);

  const i = state.stockTrades.findIndex((t) => t.id === result.value.id);
  if (i >= 0) state.stockTrades[i] = result.value;
  else state.stockTrades.push(result.value);

  notify();
  return result;
}

export async function deleteStockTrade(id) {
  await db.remove(db.STORE.stockTrades, id);
  state.stockTrades = state.stockTrades.filter((t) => t.id !== id);
  notify();
}

/** 刪除某一檔的全部交易紀錄（在持股列表上整檔移除時用） */
export async function deleteSymbol(symbol) {
  const ids = state.stockTrades.filter((t) => t.symbol === symbol).map((t) => t.id);
  for (const id of ids) await db.remove(db.STORE.stockTrades, id);
  await db.remove(db.STORE.quotes, symbol);

  state.stockTrades = state.stockTrades.filter((t) => t.symbol !== symbol);
  delete state.quotes[symbol];
  notify();
  return ids.length;
}

export function tradesOf(symbol) {
  return state.stockTrades.filter((t) => t.symbol === symbol);
}

/**
 * 記錄一檔的市價。
 * source 用來區分是使用者自己填的還是自動抓的 —— 畫面上要標示資料從哪來、有多舊。
 */
export async function setQuote(symbol, closeCents, { date = todayISO(), source = 'manual' } = {}) {
  const row = {
    symbol: String(symbol).trim().toUpperCase(),
    close: Math.round(closeCents),
    date,
    source,
    updatedAt: Date.now(),
  };
  await db.put(db.STORE.quotes, row);
  state.quotes[row.symbol] = row;
  notify();
  return row;
}

/** 目前所有持股部位（由交易紀錄推算，不另外儲存） */
export function stockPositions() {
  return computePositions(state.stockTrades);
}

/** 投資組合彙總，含市值與損益 */
export function portfolioSummary() {
  const prices = {};
  for (const [sym, q] of Object.entries(state.quotes)) prices[sym] = q.close;
  return summarizePortfolio(stockPositions(), prices);
}

// ------------------------------------------------------------- 設定

export async function setSetting(key, value) {
  await db.setMeta(key, value);
  state.settings[key] = value;
  notify();
}

export function getSetting(key, fallback = null) {
  return state.settings[key] ?? fallback;
}

// ------------------------------------------------------------- 備份

export function exportPayload() {
  return {
    accounts: state.accounts,
    categories: state.categories,
    transactions: state.transactions,
    snapshots: state.snapshots,
    settings: state.settings,
    stockTrades: state.stockTrades,
    quotes: state.quotes,
  };
}

export async function importReplace(data) {
  await db.replaceAllData(data);
  await reload();
}

export async function importMerge(data) {
  await db.mergeAllData(data);
  await reload();
}

export async function wipeEverything() {
  await db.wipeAll();
  await db.seedIfEmpty();
  await reload();
}
