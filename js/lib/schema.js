/**
 * 資料結構定義、預設值與驗證。
 *
 * 這裡的驗證函式同時被「新增/編輯表單」與「備份匯入」使用，
 * 確保從外部檔案讀回來的資料不會把資料庫弄髒。
 */

export const SCHEMA_VERSION = 1;

/** 帳戶種類。side 只是預設傾向，實際正負由餘額決定 */
export const ACCOUNT_KINDS = [
  { id: 'cash', label: '現金', icon: '💵', side: 'asset', defaultMode: 'tracked' },
  { id: 'bank', label: '銀行帳戶', icon: '🏦', side: 'asset', defaultMode: 'tracked' },
  { id: 'ewallet', label: '電子支付', icon: '📱', side: 'asset', defaultMode: 'tracked' },
  { id: 'credit', label: '信用卡', icon: '💳', side: 'liability', defaultMode: 'tracked' },
  { id: 'investment', label: '投資', icon: '📈', side: 'asset', defaultMode: 'manual' },
  { id: 'insurance', label: '保單', icon: '🛡', side: 'asset', defaultMode: 'manual' },
  { id: 'property', label: '不動產', icon: '🏠', side: 'asset', defaultMode: 'manual' },
  { id: 'receivable', label: '應收借出', icon: '🤝', side: 'asset', defaultMode: 'manual' },
  { id: 'loan', label: '貸款', icon: '📉', side: 'liability', defaultMode: 'manual' },
  { id: 'other', label: '其他', icon: '📦', side: 'asset', defaultMode: 'manual' },
];

export function accountKind(id) {
  return ACCOUNT_KINDS.find((k) => k.id === id) ?? ACCOUNT_KINDS[ACCOUNT_KINDS.length - 1];
}

/** 首次啟動時建立的預設分類 */
export const DEFAULT_CATEGORIES = [
  { name: '飲食', type: 'expense', icon: '🍜', color: '#f97316' },
  { name: '交通', type: 'expense', icon: '🚌', color: '#0ea5e9' },
  { name: '居住', type: 'expense', icon: '🏠', color: '#8b5cf6' },
  { name: '生活用品', type: 'expense', icon: '🧴', color: '#14b8a6' },
  { name: '醫療', type: 'expense', icon: '💊', color: '#ef4444' },
  { name: '教育', type: 'expense', icon: '📚', color: '#6366f1' },
  { name: '娛樂', type: 'expense', icon: '🎬', color: '#ec4899' },
  { name: '人情往來', type: 'expense', icon: '🎁', color: '#f59e0b' },
  { name: '保險', type: 'expense', icon: '🛡', color: '#64748b' },
  { name: '稅金', type: 'expense', icon: '🧾', color: '#78716c' },
  { name: '其他支出', type: 'expense', icon: '📦', color: '#94a3b8' },
  { name: '薪資', type: 'income', icon: '💼', color: '#22c55e' },
  { name: '獎金', type: 'income', icon: '🎉', color: '#84cc16' },
  { name: '投資收益', type: 'income', icon: '📈', color: '#10b981' },
  { name: '兼職', type: 'income', icon: '🛠', color: '#06b6d4' },
  { name: '其他收入', type: 'income', icon: '➕', color: '#a3a3a3' },
];

/** 首次啟動時建立的預設帳戶 */
export const DEFAULT_ACCOUNTS = [
  { name: '現金', kind: 'cash', valuationMode: 'tracked', openingBalance: 0 },
  { name: '銀行帳戶', kind: 'bank', valuationMode: 'tracked', openingBalance: 0 },
];

/**
 * 產生唯一 ID。優先用 crypto.randomUUID（現代手機瀏覽器都有），
 * 沒有就退回時間戳 + 亂數，避免舊環境整個掛掉。
 */
export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 驗證並正規化一筆交易。
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function validateTransaction(input, ctx = {}) {
  const { accountIds = null, categoryIds = null } = ctx;
  const tx = { ...input };

  if (!['income', 'expense', 'transfer'].includes(tx.type)) {
    return fail('交易類型必須是收入、支出或轉帳');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date ?? '')) {
    return fail('日期格式必須是 YYYY-MM-DD');
  }
  const amount = Math.round(Number(tx.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail('金額必須大於 0');
  }
  if (!tx.accountId) return fail('請選擇帳戶');
  if (accountIds && !accountIds.has(tx.accountId)) return fail('帳戶不存在');

  if (tx.type === 'transfer') {
    if (!tx.toAccountId) return fail('轉帳必須選擇轉入帳戶');
    if (tx.toAccountId === tx.accountId) return fail('轉出與轉入不能是同一個帳戶');
    if (accountIds && !accountIds.has(tx.toAccountId)) return fail('轉入帳戶不存在');
  } else {
    tx.toAccountId = null;
    if (!tx.categoryId) return fail('請選擇分類');
    if (categoryIds && !categoryIds.has(tx.categoryId)) return fail('分類不存在');
  }

  const now = Date.now();
  return {
    ok: true,
    value: {
      id: tx.id || newId(),
      date: tx.date,
      type: tx.type,
      amount,
      accountId: tx.accountId,
      toAccountId: tx.toAccountId ?? null,
      categoryId: tx.type === 'transfer' ? null : tx.categoryId,
      note: String(tx.note ?? '').slice(0, 200),
      createdAt: Number.isFinite(tx.createdAt) ? tx.createdAt : now,
      updatedAt: now,
    },
  };
}

export function validateAccount(input) {
  const acc = { ...input };
  const name = String(acc.name ?? '').trim();
  if (!name) return fail('帳戶名稱不能空白');
  if (name.length > 30) return fail('帳戶名稱最多 30 個字');
  if (!ACCOUNT_KINDS.some((k) => k.id === acc.kind)) return fail('帳戶種類無效');
  const mode = acc.valuationMode === 'manual' ? 'manual' : 'tracked';

  return {
    ok: true,
    value: {
      id: acc.id || newId(),
      name,
      kind: acc.kind,
      valuationMode: mode,
      openingBalance: toInt(acc.openingBalance),
      manualValue: toInt(acc.manualValue),
      note: String(acc.note ?? '').slice(0, 200),
      archived: Boolean(acc.archived),
      order: Number.isFinite(acc.order) ? acc.order : 0,
      updatedAt: Date.now(),
    },
  };
}

export function validateCategory(input) {
  const cat = { ...input };
  const name = String(cat.name ?? '').trim();
  if (!name) return fail('分類名稱不能空白');
  if (name.length > 20) return fail('分類名稱最多 20 個字');
  if (!['income', 'expense'].includes(cat.type)) return fail('分類必須屬於收入或支出');

  return {
    ok: true,
    value: {
      id: cat.id || newId(),
      name,
      type: cat.type,
      icon: String(cat.icon ?? '📌').slice(0, 4),
      color: /^#[0-9a-fA-F]{6}$/.test(cat.color ?? '') ? cat.color : '#94a3b8',
      archived: Boolean(cat.archived),
      order: Number.isFinite(cat.order) ? cat.order : 0,
    },
  };
}

export function validateSnapshot(input) {
  const s = { ...input };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date ?? '')) return fail('快照日期格式錯誤');
  return {
    ok: true,
    value: {
      id: s.id || newId(),
      date: s.date,
      assets: toInt(s.assets),
      liabilities: toInt(s.liabilities),
      net: toInt(s.net),
      breakdown: Array.isArray(s.breakdown)
        ? s.breakdown.map((b) => ({
            accountId: String(b.accountId ?? ''),
            name: String(b.name ?? ''),
            balance: toInt(b.balance),
          }))
        : [],
      note: String(s.note ?? '').slice(0, 200),
      createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
    },
  };
}

function fail(error) {
  return { ok: false, error };
}

function toInt(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
}
