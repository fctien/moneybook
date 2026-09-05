/**
 * IndexedDB 資料層。
 *
 * 設計取捨：個人記帳的資料量很小（記十年也就幾萬筆），
 * 因此採用「開啟時一次全部載入記憶體」的策略，所有統計都在記憶體中用純函式算完。
 * 換來的好處是畫面切換零延遲，也不必為了查詢而維護一堆索引。
 *
 * 選 IndexedDB 而非 localStorage 的理由：後者上限約 5MB 且為同步 API，
 * 資料一多會卡住 UI 執行緒。
 */

import {
  DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES,
  validateAccount, validateCategory, newId,
} from './lib/schema.js';

export const DB_NAME = 'moneybook';
export const DB_VERSION = 2;

export const STORE = {
  accounts: 'accounts',
  categories: 'categories',
  transactions: 'transactions',
  snapshots: 'snapshots',
  meta: 'meta',
  stockTrades: 'stockTrades',
  quotes: 'quotes',
};

const ALL_STORES = [
  STORE.accounts, STORE.categories, STORE.transactions, STORE.snapshots,
  STORE.meta, STORE.stockTrades, STORE.quotes,
];

let dbPromise = null;
let activeName = DB_NAME;

/**
 * 切換要使用的資料庫名稱。
 * 唯一的用途是讓 test.html 在獨立的資料庫上跑破壞性測試，
 * 絕不能碰到使用者真正的帳。正式流程不會呼叫這個函式。
 */
export function useDatabase(name) {
  resetConnection();
  activeName = name || DB_NAME;
}

export function currentDatabaseName() {
  return activeName;
}

/** 開啟資料庫（單例，重複呼叫共用同一個連線） */
export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('這個瀏覽器不支援 IndexedDB，無法儲存資料'));
      return;
    }

    const req = indexedDB.open(activeName, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.accounts)) {
        db.createObjectStore(STORE.accounts, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.categories)) {
        db.createObjectStore(STORE.categories, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.transactions)) {
        const s = db.createObjectStore(STORE.transactions, { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('accountId', 'accountId');
        s.createIndex('categoryId', 'categoryId');
      }
      if (!db.objectStoreNames.contains(STORE.snapshots)) {
        const s = db.createObjectStore(STORE.snapshots, { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains(STORE.meta)) {
        db.createObjectStore(STORE.meta, { keyPath: 'key' });
      }
      // v2：股票模組。每個 store 都是先檢查再建立，
      // 因此舊使用者從 v1 升上來只會多出這兩個，既有資料完全不動。
      if (!db.objectStoreNames.contains(STORE.stockTrades)) {
        const s = db.createObjectStore(STORE.stockTrades, { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('symbol', 'symbol');
      }
      if (!db.objectStoreNames.contains(STORE.quotes)) {
        // 以代號為主鍵：一檔只留最新一筆報價，不需要歷史價位
        db.createObjectStore(STORE.quotes, { keyPath: 'symbol' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // 另一個分頁觸發版本升級時先關掉這個連線，否則會把對方卡住
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('無法開啟資料庫'));
    req.onblocked = () => reject(new Error('資料庫被其他分頁鎖住，請關閉其他開著本 App 的分頁'));
  });

  return dbPromise;
}

/** 關閉並重設連線 */
export function resetConnection() {
  if (dbPromise) {
    dbPromise.then((db) => db.close()).catch(() => {});
    dbPromise = null;
  }
}

/** 測試收尾用：整個刪掉目前的資料庫 */
export function deleteDatabase() {
  resetConnection();
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(activeName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // 有其他分頁開著時會延後刪除，不視為失敗
  });
}

function makeTx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('資料庫寫入失敗'));
    t.onabort = () => reject(t.error ?? new Error('資料庫操作被中止'));
  });
  return { t, done };
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(storeName) {
  const db = await openDB();
  const { t } = makeTx(db, [storeName], 'readonly');
  return request(t.objectStore(storeName).getAll());
}

export async function put(storeName, value) {
  const db = await openDB();
  const { t, done } = makeTx(db, [storeName], 'readwrite');
  t.objectStore(storeName).put(value);
  await done;
  return value;
}

export async function bulkPut(storeName, values) {
  if (!values?.length) return 0;
  const db = await openDB();
  const { t, done } = makeTx(db, [storeName], 'readwrite');
  const store = t.objectStore(storeName);
  for (const v of values) store.put(v);
  await done;
  return values.length;
}

export async function remove(storeName, key) {
  const db = await openDB();
  const { t, done } = makeTx(db, [storeName], 'readwrite');
  t.objectStore(storeName).delete(key);
  await done;
}

export async function clearStore(storeName) {
  const db = await openDB();
  const { t, done } = makeTx(db, [storeName], 'readwrite');
  t.objectStore(storeName).clear();
  await done;
}

/** 一次載入所有資料到記憶體 */
export async function loadAll() {
  const [accounts, categories, transactions, snapshots, metaRows, stockTrades, quoteRows] = await Promise.all([
    getAll(STORE.accounts),
    getAll(STORE.categories),
    getAll(STORE.transactions),
    getAll(STORE.snapshots),
    getAll(STORE.meta),
    getAll(STORE.stockTrades),
    getAll(STORE.quotes),
  ]);

  const settings = {};
  for (const row of metaRows) settings[row.key] = row.value;

  accounts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'zh-Hant'));
  categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'zh-Hant'));

  const quotes = {};
  for (const row of quoteRows) quotes[row.symbol] = row;

  return { accounts, categories, transactions, snapshots, settings, stockTrades, quotes };
}

export async function getMeta(key, fallback = null) {
  const db = await openDB();
  const { t } = makeTx(db, [STORE.meta], 'readonly');
  const row = await request(t.objectStore(STORE.meta).get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put(STORE.meta, { key, value });
}

/**
 * 首次啟動時建立預設帳戶與分類。
 * 已經有資料就什麼都不做，避免重複塞入。
 */
export async function seedIfEmpty() {
  const [accounts, categories] = await Promise.all([
    getAll(STORE.accounts),
    getAll(STORE.categories),
  ]);

  const seeded = { accounts: 0, categories: 0 };

  if (accounts.length === 0) {
    const rows = DEFAULT_ACCOUNTS
      .map((a, i) => validateAccount({ ...a, id: newId(), order: i }))
      .filter((r) => r.ok)
      .map((r) => r.value);
    await bulkPut(STORE.accounts, rows);
    seeded.accounts = rows.length;
  }

  if (categories.length === 0) {
    const rows = DEFAULT_CATEGORIES
      .map((c, i) => validateCategory({ ...c, id: newId(), order: i }))
      .filter((r) => r.ok)
      .map((r) => r.value);
    await bulkPut(STORE.categories, rows);
    seeded.categories = rows.length;
  }

  return seeded;
}

/**
 * 用備份資料覆蓋整個資料庫（匯入的「取代」模式）。
 * 清空與寫入放在同一個 transaction，中途失敗會整批回滾，
 * 不會留下清到一半的資料庫。
 */
export async function replaceAllData(data) {
  const db = await openDB();
  const { t, done } = makeTx(db, ALL_STORES, 'readwrite');

  for (const name of ALL_STORES) t.objectStore(name).clear();

  for (const a of data.accounts ?? []) t.objectStore(STORE.accounts).put(a);
  for (const c of data.categories ?? []) t.objectStore(STORE.categories).put(c);
  for (const x of data.transactions ?? []) t.objectStore(STORE.transactions).put(x);
  for (const s of data.snapshots ?? []) t.objectStore(STORE.snapshots).put(s);
  for (const x of data.stockTrades ?? []) t.objectStore(STORE.stockTrades).put(x);
  for (const q of Object.values(data.quotes ?? {})) t.objectStore(STORE.quotes).put(q);
  for (const [key, value] of Object.entries(data.settings ?? {})) {
    t.objectStore(STORE.meta).put({ key, value });
  }

  await done;
}

/** 合併匯入：以 id 為準覆蓋同 id 的項目，不刪除現有資料 */
export async function mergeAllData(data) {
  const db = await openDB();
  const stores = [STORE.accounts, STORE.categories, STORE.transactions, STORE.snapshots, STORE.stockTrades];
  const { t, done } = makeTx(db, stores, 'readwrite');

  for (const a of data.accounts ?? []) t.objectStore(STORE.accounts).put(a);
  for (const c of data.categories ?? []) t.objectStore(STORE.categories).put(c);
  for (const x of data.transactions ?? []) t.objectStore(STORE.transactions).put(x);
  for (const s of data.snapshots ?? []) t.objectStore(STORE.snapshots).put(s);
  for (const x of data.stockTrades ?? []) t.objectStore(STORE.stockTrades).put(x);

  await done;
}

/** 刪光所有資料（設定頁的「清除全部資料」） */
export async function wipeAll() {
  const db = await openDB();
  const { t, done } = makeTx(db, ALL_STORES, 'readwrite');
  for (const name of ALL_STORES) t.objectStore(name).clear();
  await done;
}

/** 估算已用儲存空間，讓使用者知道離瀏覽器配額還有多遠 */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage ?? 0, quota: quota ?? 0 };
  } catch {
    return null;
  }
}

/**
 * 要求瀏覽器把資料標記為「持續保存」。
 * Android Chrome 在裝置儲存空間不足時會優先清掉未標記的網站資料。
 * iOS 已加到主畫面的 PWA 本身就不受 7 天未使用清除規則影響。
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return null;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}
