/**
 * 股票持股與損益計算。
 *
 * 成本採「加權平均法」—— 台灣券商對帳單的標準做法，數字能跟券商 App 對得起來。
 * 這個選擇之後不要改：換成 FIFO 會讓已輸入的歷史損益全部變成另一組數字。
 *
 * ── 為什麼不另外儲存「持股部位」 ──
 * 部位一律由交易紀錄推算，不存第二份。存兩份遲早會對不起來，
 * 而且對不起來時你無法判斷哪一份才是對的。這與本專案「金額用整數分儲存」
 * 是同一種考量：把誤差來源從根本上移除，而不是事後對帳。
 *
 * ── 數值單位 ──
 * 金額與股價一律是「分」為單位的整數（65.7 元 = 6570）。
 * 股數是整數（台股零股最小單位為 1 股）。
 * 平均成本會除不盡，因此 totalCost 才是真實來源，avgCost 只是顯示用的浮點數。
 */

/** 交易種類 */
export const ACTION = {
  OPENING: 'opening',   // 期初持股：直接給股數與平均成本
  BUY: 'buy',
  SELL: 'sell',
  DIVIDEND: 'dividend', // 現金股利
  STOCK_DIV: 'stockDiv', // 股票股利／無償配股
};

const ACTIONS = new Set(Object.values(ACTION));

/** 台股預設費率，實際成交金額仍以使用者填入的為準 */
export const FEE_RATE = 0.001425;   // 手續費 0.1425%
export const TAX_RATE = 0.003;      // 證交稅 0.3%（賣出才收）
export const MIN_FEE = 2000;        // 最低手續費 20 元（＝2000 分）

/**
 * 試算手續費（分）。券商折扣不同，這只是預設值，使用者可覆寫。
 * @param {number} amountCents 成交金額
 * @param {number} discount 折扣，例如 6 折填 0.6
 */
export function estimateFee(amountCents, discount = 1) {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  const raw = Math.round(amountCents * FEE_RATE * discount);
  return Math.max(raw, Math.min(MIN_FEE, amountCents));
}

/** 試算證交稅（分），只有賣出才收 */
export function estimateTax(amountCents) {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  return Math.round(amountCents * TAX_RATE);
}

/**
 * 驗證並正規化一筆股票交易。
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function validateTrade(input) {
  const t = input ?? {};
  const symbol = String(t.symbol ?? '').trim().toUpperCase();
  if (!symbol) return { ok: false, error: '請輸入股票代號' };

  if (!ACTIONS.has(t.action)) return { ok: false, error: '交易種類不正確' };

  const date = String(t.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: '日期格式不正確' };

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const shares = num(t.shares) ?? 0;
  const price = num(t.price) ?? 0;
  const fee = Math.max(0, num(t.fee) ?? 0);
  const tax = Math.max(0, num(t.tax) ?? 0);
  const amount = num(t.amount) ?? 0;

  if (t.action === ACTION.DIVIDEND) {
    if (amount <= 0) return { ok: false, error: '現金股利金額要大於 0' };
  } else if (t.action === ACTION.STOCK_DIV) {
    if (!Number.isInteger(shares) || shares <= 0) {
      return { ok: false, error: '配股股數要是大於 0 的整數' };
    }
  } else {
    if (!Number.isInteger(shares) || shares <= 0) {
      return { ok: false, error: '股數要是大於 0 的整數' };
    }
    if (price <= 0) return { ok: false, error: '價格要大於 0' };
  }

  return {
    ok: true,
    value: {
      id: t.id,
      date,
      symbol,
      name: String(t.name ?? '').trim(),
      action: t.action,
      shares: Math.trunc(shares),
      price: Math.round(price),
      fee: Math.round(fee),
      tax: Math.round(tax),
      amount: Math.round(amount),
      note: String(t.note ?? '').trim(),
      createdAt: t.createdAt ?? Date.now(),
    },
  };
}

/** 交易要照時間順序套用，否則賣出可能發生在買進之前 */
function sortTrades(trades) {
  return [...trades].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    // 同一天：期初與買進要排在賣出前面，否則會出現「賣掉還沒買的股票」
    const rank = { [ACTION.OPENING]: 0, [ACTION.BUY]: 1, [ACTION.STOCK_DIV]: 2, [ACTION.DIVIDEND]: 3, [ACTION.SELL]: 4 };
    const ra = rank[a.action] ?? 9;
    const rb = rank[b.action] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

function emptyPosition(symbol) {
  return {
    symbol,
    name: '',
    shares: 0,
    totalCost: 0,     // 目前持股的總成本（分）
    realized: 0,      // 已實現損益（分），含股利
    dividends: 0,     // 其中來自現金股利的部分
    tradeCount: 0,
    lastDate: null,
    warnings: [],
  };
}

/**
 * 由交易紀錄推算每一檔的持股部位。
 *
 * @param {object[]} trades
 * @returns {object[]} 依代號排序，已清空的部位仍會保留（才看得到已實現損益）
 */
export function computePositions(trades = []) {
  const map = new Map();

  for (const t of sortTrades(trades)) {
    if (!map.has(t.symbol)) map.set(t.symbol, emptyPosition(t.symbol));
    const p = map.get(t.symbol);

    if (t.name) p.name = t.name;
    p.tradeCount += 1;
    p.lastDate = t.date;

    switch (t.action) {
      case ACTION.OPENING:
      case ACTION.BUY: {
        // 買進成本含手續費 —— 手續費是取得這批股票必須付出的代價
        p.shares += t.shares;
        p.totalCost += t.shares * t.price + t.fee;
        break;
      }

      case ACTION.SELL: {
        if (t.shares > p.shares) {
          p.warnings.push(`${t.date} 賣出 ${t.shares} 股，但當時只持有 ${p.shares} 股`);
        }
        const sold = Math.min(t.shares, p.shares);
        // 賣掉部分的成本 = 平均成本 × 賣出股數。
        // 用 totalCost 依比例攤，而不是先算出 avgCost 再乘回去 —— 後者會累積除不盡的誤差。
        const costOfSold = p.shares > 0 ? Math.round(p.totalCost * (sold / p.shares)) : 0;
        const proceeds = sold * t.price - t.fee - t.tax;

        p.realized += proceeds - costOfSold;
        p.totalCost -= costOfSold;
        p.shares -= sold;

        // 全部賣光時把成本歸零，避免留下四捨五入的零頭
        if (p.shares === 0) p.totalCost = 0;
        break;
      }

      case ACTION.DIVIDEND: {
        // 現金股利計入已實現收益，不沖減成本 —— 與券商對帳單的呈現一致
        p.realized += t.amount;
        p.dividends += t.amount;
        break;
      }

      case ACTION.STOCK_DIV: {
        // 無償配股：股數增加、總成本不變，平均成本因此自然被稀釋
        p.shares += t.shares;
        break;
      }

      default:
        p.warnings.push(`${t.date} 有無法辨識的交易種類：${t.action}`);
    }
  }

  return [...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** 平均成本（分，浮點）。totalCost 才是真實來源，這個值只用於顯示。 */
export function averageCost(position) {
  if (!position || position.shares <= 0) return 0;
  return position.totalCost / position.shares;
}

/**
 * 加上市價後的評價。
 * @param {object} position computePositions 的結果
 * @param {number|null} priceCents 每股市價（分）；沒有報價時傳 null
 */
export function valuePosition(position, priceCents) {
  const shares = position?.shares ?? 0;
  const cost = position?.totalCost ?? 0;
  const hasPrice = Number.isFinite(priceCents) && priceCents > 0;

  const marketValue = hasPrice ? Math.round(shares * priceCents) : null;
  const unrealized = hasPrice ? marketValue - cost : null;

  return {
    ...position,
    price: hasPrice ? priceCents : null,
    avgCost: averageCost(position),
    marketValue,
    unrealized,
    // 報酬率以「目前持股成本」為分母；成本為 0（已全部賣出）時沒有意義
    returnRate: hasPrice && cost > 0 ? unrealized / cost : null,
    totalReturn: hasPrice ? unrealized + position.realized : null,
  };
}

/**
 * 整個投資組合的彙總。
 *
 * @param {object[]} positions computePositions 的結果
 * @param {Record<string, number>} quotes 代號 → 每股市價（分）
 */
export function summarizePortfolio(positions = [], quotes = {}) {
  const rows = positions.map((p) => valuePosition(p, quotes[p.symbol] ?? null));

  const held = rows.filter((r) => r.shares > 0);
  const totalCost = held.reduce((a, r) => a + r.totalCost, 0);
  const priced = held.filter((r) => r.marketValue !== null);

  const marketValue = priced.reduce((a, r) => a + r.marketValue, 0);
  const realized = rows.reduce((a, r) => a + r.realized, 0);
  const dividends = rows.reduce((a, r) => a + r.dividends, 0);

  // 只有全部持股都有報價時，未實現損益才是完整的數字。
  // 少算一檔卻照樣顯示總額，會讓使用者以為自己虧損 —— 這種誤導比沒有數字更糟。
  const complete = held.length > 0 && priced.length === held.length;
  const costOfPriced = priced.reduce((a, r) => a + r.totalCost, 0);
  const unrealized = priced.reduce((a, r) => a + r.unrealized, 0);

  return {
    rows,
    held,
    totalCost,
    marketValue,
    unrealized,
    realized,
    dividends,
    returnRate: costOfPriced > 0 ? unrealized / costOfPriced : null,
    pricedCount: priced.length,
    heldCount: held.length,
    missingQuotes: held.filter((r) => r.marketValue === null).map((r) => r.symbol),
    complete,
  };
}

/** 依市值排序，供圓餅圖與列表使用；沒有報價的排最後 */
export function byMarketValue(rows) {
  return [...rows]
    .filter((r) => r.shares > 0)
    .sort((a, b) => (b.marketValue ?? -1) - (a.marketValue ?? -1));
}
