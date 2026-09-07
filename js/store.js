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
import { todayISO, taipeiDateISO, isAfterMarketClose } from './lib/dateutil.js';
import { computePositions, summarizePortfolio, validateTrade } from './lib/portfolio.js';
import {
  computeFundPositions, summarizeFunds, validateFundTrade, usedCurrencies,
} from './lib/funds.js';
import { fetchQuotes } from './lib/quotesource.js';

export const state = {
  accounts: [],
  categories: [],
  transactions: [],
  snapshots: [],
  settings: {},
  stockTrades: [],
  // 代號 → { symbol, close, date, source, updatedAt }
  quotes: {},
  fundTrades: [],
  // 基金代碼 → { fundId, nav, date, source, updatedAt }
  navs: {},
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

  await syncStockValueToAccount();
  notify();
  return result;
}

export async function deleteStockTrade(id) {
  await db.remove(db.STORE.stockTrades, id);
  state.stockTrades = state.stockTrades.filter((t) => t.id !== id);
  await syncStockValueToAccount();
  notify();
}

/** 刪除某一檔的全部交易紀錄（在持股列表上整檔移除時用） */
export async function deleteSymbol(symbol) {
  const ids = state.stockTrades.filter((t) => t.symbol === symbol).map((t) => t.id);
  for (const id of ids) await db.remove(db.STORE.stockTrades, id);
  await db.remove(db.STORE.quotes, symbol);

  state.stockTrades = state.stockTrades.filter((t) => t.symbol !== symbol);
  delete state.quotes[symbol];
  await syncStockValueToAccount();
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
  await syncStockValueToAccount();
  notify();
  return row;
}

/**
 * 投資模組與帳戶的綁定。
 *
 * 用「綁定一個帳戶」而不是直接把市值加進淨資產，是為了避免重複計算 ——
 * 多數人早就用「手動估值」開了證券或基金帳戶，兩邊各算一次，
 * 淨資產會憑空多出一份，而且使用者不會發現。
 *
 * 股票與基金各綁各的帳戶：兩者在資產頁是獨立的區塊、獨立的清單，
 * 綁在一起會讓「這個帳戶到底代表什麼」變得說不清楚。
 */
const MODULES = {
  stock: {
    key: 'stockAccountId',
    summary: () => portfolioSummary(),
    // 缺股價的代號，用來在畫面上講清楚這個數字少了什麼
    missing: (s) => s.missingQuotes,
  },
  fund: {
    key: 'fundAccountId',
    summary: () => fundSummary(),
    // 基金可能缺淨值，也可能缺匯率 —— 兩者要補的東西不一樣，但對「少算了什麼」來說是同一件事
    missing: (s) => [...s.missingNav, ...s.missingRate],
  },
};

/** 哪一個帳戶要接收股票市值。空字串代表不計入淨資產。 */
export const STOCK_ACCOUNT_KEY = MODULES.stock.key;
/** 哪一個帳戶要接收基金市值。空字串代表不計入淨資產。 */
export const FUND_ACCOUNT_KEY = MODULES.fund.key;

/**
 * 把某個投資模組的市值同步到它綁定的帳戶。
 *
 * 只把「算得出台幣市值」的部位算進去。算不出來的會回報出來，
 * 讓畫面能講清楚少了什麼 —— 少算幾檔卻不說，比沒有數字更糟。
 *
 * @param {'stock'|'fund'} moduleName
 * @returns {{synced:boolean, value:number, missing:string[]}}
 */
export async function syncModuleValueToAccount(moduleName) {
  const mod = MODULES[moduleName];
  if (!mod) throw new Error(`未知的投資模組：${moduleName}`);

  const summary = mod.summary();
  const missing = mod.missing(summary);
  const accountId = getSetting(mod.key, '');

  if (!accountId) return { synced: false, value: summary.marketValue, missing };

  const account = state.accounts.find((a) => a.id === accountId);
  // 帳戶被刪掉或改成自動累算了，就把設定清掉，免得一直對著不存在的目標寫
  if (!account || account.valuationMode !== 'manual') {
    await setSetting(mod.key, '');
    return { synced: false, value: summary.marketValue, missing };
  }

  if (account.manualValue !== summary.marketValue) {
    await saveAccount({ ...account, manualValue: summary.marketValue });
  }
  return { synced: true, value: summary.marketValue, missing };
}

export function syncStockValueToAccount() {
  return syncModuleValueToAccount('stock');
}

export function syncFundValueToAccount() {
  return syncModuleValueToAccount('fund');
}

/**
 * 一次寫入多筆報價。
 *
 * 不是把 setQuote 呼叫 N 次：那會觸發 N 次帳戶同步與 N 次畫面重繪，
 * 30 檔就是 30 次全畫面重算，而且中途的每一次都是「更新到一半」的數字。
 */
export async function setQuotes(rows, { source = 'manual' } = {}) {
  for (const r of rows ?? []) {
    const row = {
      symbol: String(r.symbol).trim().toUpperCase(),
      close: Math.round(r.close),
      date: r.date ?? todayISO(),
      source: r.source ?? source,
      updatedAt: Date.now(),
    };
    await db.put(db.STORE.quotes, row);
    state.quotes[row.symbol] = row;
  }
  await syncStockValueToAccount();
  notify();
  return rows?.length ?? 0;
}

// ------------------------------------------------- 股價自動更新

/** 使用者是否同意連線抓股價。預設 false —— 這是整個 App 唯一的對外連線。 */
export const AUTO_QUOTE_KEY = 'autoQuoteEnabled';
/** 上次自動更新的台北日期，用來確保一天只跑一次 */
export const AUTO_QUOTE_RUN_KEY = 'autoQuoteLastRun';

export function autoQuoteEnabled() {
  return getSetting(AUTO_QUOTE_KEY, false) === true;
}

export async function setAutoQuoteEnabled(on) {
  await setSetting(AUTO_QUOTE_KEY, on === true);
  // 關掉再打開時應該要能立刻重抓，所以把「今天跑過了」的紀錄一併清掉
  if (!on) await setSetting(AUTO_QUOTE_RUN_KEY, '');
  notify();
}

/**
 * 抓取全部持股的收盤價並寫回。
 *
 * 只抓「還有持股」的代號 —— 已經賣光的沒有市值可言，
 * 多送幾個代號出去只是多洩漏一點資訊。
 *
 * 抓完若每一檔都有價格，順手存一張淨資產快照（也就是「計總」）。
 * 有任何一檔缺價就不存：那張快照會是一個偏低的數字，
 * 之後在趨勢圖上會看起來像資產真的掉了一塊，而且事後無從分辨。
 *
 * @returns {Promise<object>} 結果摘要，交給畫面決定怎麼說
 */
export async function updateAllQuotes({ onProgress, auto = false } = {}) {
  const symbols = stockPositions().filter((p) => p.shares > 0).map((p) => p.symbol);
  if (!symbols.length) {
    return { ok: true, updated: 0, total: 0, errors: [], stopped: false, snapshot: null };
  }

  const { quotes, errors, stopped } = await fetchQuotes(symbols, { onProgress });
  if (quotes.length) await setQuotes(quotes, { source: 'finmind' });

  // 不論成敗都記下「今天跑過了」，否則一直連不上時每次開 App 都會再試一輪
  if (auto) await setSetting(AUTO_QUOTE_RUN_KEY, taipeiDateISO());

  const summary = portfolioSummary();
  let snapshot = null;
  if (summary.pricedCount === summary.heldCount && summary.heldCount > 0) {
    const date = taipeiDateISO();
    // 同一天已有快照時沿用原本的備註 —— 使用者自己寫的字不該被系統訊息蓋掉
    const existing = state.snapshots.find((x) => x.date === date);
    const r = await takeSnapshot(existing?.note || '收盤後自動計總', date);
    if (r?.ok) snapshot = r;
  }

  return {
    ok: quotes.length > 0 || errors.length === 0,
    updated: quotes.length,
    total: symbols.length,
    quoteDate: quotes.length ? quotes.map((q) => q.date).sort().at(-1) : null,
    errors,
    stopped,
    snapshot,
    // 缺價的檔數，用來說明為什麼沒有存快照
    missing: summary.heldCount - summary.pricedCount,
  };
}

/**
 * 開啟 App 時的自動更新。
 *
 * PWA 在關閉時無法執行程式 —— iOS Safari 沒有背景定期同步，
 * Android 的 Periodic Background Sync 也不保證會被排到。
 * 因此「每日自動」的實際意思是：收盤後你開啟 App 時，自動抓一次。
 *
 * 三個條件都成立才會跑，任何一個不成立就安靜地什麼都不做：
 *   1. 使用者已同意
 *   2. 台北時間已過 14:00（13:30 收盤，資料要一點時間整理）
 *   3. 今天還沒跑過
 */
export async function maybeAutoUpdateQuotes(opts = {}) {
  if (!autoQuoteEnabled()) return { ran: false, reason: 'disabled' };
  if (!isAfterMarketClose()) return { ran: false, reason: 'beforeClose' };
  if (getSetting(AUTO_QUOTE_RUN_KEY, '') === taipeiDateISO()) {
    return { ran: false, reason: 'alreadyRan' };
  }
  if (!stockPositions().some((p) => p.shares > 0)) return { ran: false, reason: 'noHoldings' };

  const result = await updateAllQuotes({ ...opts, auto: true });
  return { ran: true, ...result };
}

/** 上次成功抓價的時間，供畫面標示資料有多舊 */
export function lastQuoteUpdate() {
  let latest = null;
  for (const q of Object.values(state.quotes)) {
    if (!latest || (q.updatedAt ?? 0) > (latest.updatedAt ?? 0)) latest = q;
  }
  return latest;
}

/** 移除某一檔的報價（改代號時把舊的清掉，免得留下對不到任何持股的孤兒） */
export async function deleteQuote(symbol) {
  await db.remove(db.STORE.quotes, symbol);
  delete state.quotes[symbol];
  notify();
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

// ------------------------------------------------------------- 基金

export async function saveFundTrade(input) {
  const result = validateFundTrade(input);
  if (!result.ok) return result;
  if (!result.value.id) result.value.id = newId();

  await db.put(db.STORE.fundTrades, result.value);

  const i = state.fundTrades.findIndex((t) => t.id === result.value.id);
  if (i >= 0) state.fundTrades[i] = result.value;
  else state.fundTrades.push(result.value);

  await syncFundValueToAccount();
  notify();
  return result;
}

export async function deleteFundTrade(id) {
  await db.remove(db.STORE.fundTrades, id);
  state.fundTrades = state.fundTrades.filter((t) => t.id !== id);
  await syncFundValueToAccount();
  notify();
}

/** 刪除某一檔基金的全部交易紀錄（在持份列表上整檔移除時用） */
export async function deleteFund(fundId) {
  const ids = state.fundTrades.filter((t) => t.fundId === fundId).map((t) => t.id);
  for (const id of ids) await db.remove(db.STORE.fundTrades, id);
  await db.remove(db.STORE.navs, fundId);

  state.fundTrades = state.fundTrades.filter((t) => t.fundId !== fundId);
  delete state.navs[fundId];
  await syncFundValueToAccount();
  notify();
  return ids.length;
}

export function fundTradesOf(fundId) {
  return state.fundTrades.filter((t) => t.fundId === fundId);
}

/**
 * 記錄一檔基金的最新淨值（原幣，×10^4）。
 * source 用來區分是使用者自己填的還是自動抓的 —— 畫面上要標示資料從哪來、有多舊。
 */
export async function setNav(fundId, nav, { date = todayISO(), source = 'manual' } = {}) {
  const row = {
    fundId: String(fundId).trim(),
    nav: Math.round(nav),
    date,
    source,
    updatedAt: Date.now(),
  };
  await db.put(db.STORE.navs, row);
  state.navs[row.fundId] = row;
  await syncFundValueToAccount();
  notify();
  return row;
}

/** 移除某一檔的淨值（改代碼時把舊的清掉） */
export async function deleteNav(fundId) {
  await db.remove(db.STORE.navs, fundId);
  delete state.navs[fundId];
  notify();
}

/** 匯率表：幣別 → 匯率（×10^6）。手動維護，之後才做自動抓。 */
export const FX_RATES_KEY = 'fxRates';

export function fxRates() {
  const raw = getSetting(FX_RATES_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

export async function setFxRate(currency, rate) {
  const code = String(currency).trim().toUpperCase();
  const next = { ...fxRates(), [code]: Math.round(rate) };
  await setSetting(FX_RATES_KEY, next);
  await syncFundValueToAccount();
  notify();
  return next;
}

export async function removeFxRate(currency) {
  const next = { ...fxRates() };
  delete next[String(currency).trim().toUpperCase()];
  await setSetting(FX_RATES_KEY, next);
  await syncFundValueToAccount();
  notify();
  return next;
}

/** 目前所有基金持份（由交易紀錄推算，不另外儲存） */
export function fundPositions() {
  return computeFundPositions(state.fundTrades);
}

/** 基金組合彙總，金額一律是台幣 */
export function fundSummary() {
  const navs = {};
  for (const [id, row] of Object.entries(state.navs)) navs[id] = row.nav;
  return summarizeFunds(fundPositions(), navs, fxRates());
}

/** 目前持有、而且還沒填匯率的外幣幣別 */
export function currenciesNeedingRate() {
  const rates = fxRates();
  return usedCurrencies(fundPositions()).filter((c) => !(rates[c] > 0));
}

// ------------------------------------------------------------- 設定

/**
 * @param {object} [opts]
 * @param {boolean} [opts.silent] 不觸發畫面通知。
 *   呼叫端自己已經重畫過時用得上 —— 純介面偏好（例如目前停在哪個分頁）
 *   再觸發一次全域通知，只是把整份列表重畫第二次。
 */
export async function setSetting(key, value, { silent = false } = {}) {
  await db.setMeta(key, value);
  state.settings[key] = value;
  if (!silent) notify();
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
    fundTrades: state.fundTrades,
    navs: state.navs,
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
