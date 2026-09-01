/**
 * 備份匯出 / 匯入 / CSV 產生。
 *
 * 這是這個 App 最重要的模組之一：資料只存在手機本機，
 * 沒有雲端副本，備份檔就是唯一的保險。
 * 因此匯入端做嚴格驗證，寧可跳過壞資料也不要把資料庫寫壞。
 */

import { SCHEMA_VERSION, validateAccount, validateCategory, validateSnapshot, validateTransaction } from './schema.js';

export const BACKUP_MAGIC = 'MoneyBook';

/**
 * 產生備份物件。
 * @param {{accounts:Array, categories:Array, transactions:Array, snapshots:Array, settings:object}} data
 * @param {string} [exportedAt] ISO 時間字串；測試時可注入固定值
 */
export function buildBackup(data, exportedAt) {
  const accounts = data.accounts ?? [];
  const categories = data.categories ?? [];
  const transactions = data.transactions ?? [];
  const snapshots = data.snapshots ?? [];

  return {
    app: BACKUP_MAGIC,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: exportedAt ?? new Date().toISOString(),
    counts: {
      accounts: accounts.length,
      categories: categories.length,
      transactions: transactions.length,
      snapshots: snapshots.length,
    },
    data: { accounts, categories, transactions, snapshots, settings: data.settings ?? {} },
  };
}

export function serializeBackup(data, exportedAt) {
  return JSON.stringify(buildBackup(data, exportedAt), null, 2);
}

/**
 * 解析並驗證備份檔內容。
 * 逐筆驗證，壞掉的項目記進 skipped 而不是整包拒絕 —— 使用者手上可能只有這一份備份，
 * 能救回九成資料遠比「格式不符，拒絕匯入」有用。
 *
 * @returns {{ok:true, data:object, counts:object, skipped:Array<string>}
 *         | {ok:false, error:string}}
 */
export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '檔案不是有效的 JSON，可能已損毀或選錯檔案' };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: '備份檔內容格式不正確' };
  }
  if (raw.app !== BACKUP_MAGIC) {
    return { ok: false, error: '這不是 MoneyBook 的備份檔' };
  }
  if (Number(raw.schemaVersion) > SCHEMA_VERSION) {
    return { ok: false, error: `備份檔版本 (${raw.schemaVersion}) 比目前 App 版本新，請先更新 App` };
  }

  const src = raw.data ?? {};
  const skipped = [];

  const accounts = pick(src.accounts, validateAccount, 'accounts', skipped);
  const categories = pick(src.categories, validateCategory, 'categories', skipped);
  const snapshots = pick(src.snapshots, validateSnapshot, 'snapshots', skipped);

  const accountIds = new Set(accounts.map((a) => a.id));
  const categoryIds = new Set(categories.map((c) => c.id));
  const transactions = pick(
    src.transactions,
    (item) => validateTransaction(item, { accountIds, categoryIds }),
    'transactions',
    skipped,
  );

  return {
    ok: true,
    data: {
      accounts,
      categories,
      transactions,
      snapshots,
      settings: typeof src.settings === 'object' && src.settings ? src.settings : {},
    },
    counts: {
      accounts: accounts.length,
      categories: categories.length,
      transactions: transactions.length,
      snapshots: snapshots.length,
    },
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
    skipped,
  };
}

/**
 * 把匯入資料與現有資料合併（以 id 為準，匯入的覆蓋現有的）。
 * 用於「合併匯入」模式，避免使用者換手機時把新記的帳蓋掉。
 */
export function mergeCollections(existing, incoming) {
  const map = new Map();
  for (const item of existing ?? []) if (item?.id) map.set(item.id, item);
  let added = 0;
  let replaced = 0;
  for (const item of incoming ?? []) {
    if (!item?.id) continue;
    if (map.has(item.id)) replaced++;
    else added++;
    map.set(item.id, item);
  }
  return { list: [...map.values()], added, replaced };
}

/** 建議的備份檔名：moneybook-backup-2026-09-01.json */
export function backupFilename(dateISO) {
  return `moneybook-backup-${dateISO}.json`;
}

/**
 * 交易明細轉 CSV。
 * 開頭加 UTF-8 BOM，否則 Excel 開啟中文會變亂碼。
 */
export function transactionsToCSV(transactions, { accounts = [], categories = [] } = {}) {
  const accountName = new Map((accounts ?? []).map((a) => [a.id, a.name]));
  const categoryName = new Map((categories ?? []).map((c) => [c.id, c.name]));
  const TYPE_LABEL = { income: '收入', expense: '支出', transfer: '轉帳' };

  const header = ['日期', '類型', '金額', '分類', '帳戶', '轉入帳戶', '備註'];
  const rows = [header];

  const sorted = [...(transactions ?? [])].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );

  for (const tx of sorted) {
    rows.push([
      tx.date ?? '',
      TYPE_LABEL[tx.type] ?? tx.type ?? '',
      // CSV 給 Excel 用，金額還原成「元」比較直覺
      (Math.round(Number(tx.amount) || 0) / 100).toFixed(2),
      categoryName.get(tx.categoryId) ?? '',
      accountName.get(tx.accountId) ?? '',
      accountName.get(tx.toAccountId) ?? '',
      tx.note ?? '',
    ]);
  }

  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** 淨資產快照轉 CSV */
export function snapshotsToCSV(snapshots) {
  const header = ['日期', '總資產', '總負債', '淨資產', '備註'];
  const rows = [header];
  const sorted = [...(snapshots ?? [])].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const s of sorted) {
    rows.push([
      s.date ?? '',
      (Math.round(Number(s.assets) || 0) / 100).toFixed(2),
      (Math.round(Number(s.liabilities) || 0) / 100).toFixed(2),
      (Math.round(Number(s.net) || 0) / 100).toFixed(2),
      s.note ?? '',
    ]);
  }
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** CSV 逸出：含逗號、引號、換行時用雙引號包起來，內部引號加倍 */
export function csvCell(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function pick(list, validator, label, skipped) {
  const out = [];
  if (!Array.isArray(list)) return out;
  list.forEach((item, index) => {
    const result = validator(item);
    if (result.ok) out.push(result.value);
    else skipped.push(`${label}[${index}]: ${result.error}`);
  });
  return out;
}
