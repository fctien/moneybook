/**
 * 基金持份與損益計算。
 *
 * 與 portfolio.js（股票）刻意分開，不是重複造輪子：
 *   - 股票的「股數必須是整數」是一層防護（台股本來就是整數股），
 *     不該為了基金的小數單位數把它拆掉
 *   - 語意不同：股 vs 單位、股價 vs 淨值。硬合併會讓兩邊的欄位名稱都變模糊
 * 共用的是「加權平均、賣出依比例攤提成本」這套算式，不是同一個檔案。
 *
 * ── 幣別只活在這裡 ──
 * 外幣基金的幣別與匯率封裝在本模組內部，對外只吐台幣市值。
 * 記帳、帳戶、統計、報表一律是台幣，不因為基金而改變。
 *
 * ── 為什麼成本要存兩份 ──
 * 外幣基金的報酬率有兩個都正確但不同的答案：
 *   原幣報酬率 = 基金本身績效（基金公司對帳單給的）
 *   台幣報酬率 = 你實際賺了多少台幣（含匯兌損益）
 * 只存台幣總成本會永久失去算出原幣績效的能力，因此原幣與台幣成本各存一份，
 * 各自累加、贖回時各自依比例攤。多存一個數字換不可逆的資訊，划算。
 *
 * ── 數值單位 ──
 * 單位數  units  ×10^4（4 位小數）
 * 淨值    nav    ×10^4（原幣，4 位小數）
 * 匯率    fxRate ×10^6（原幣→台幣）
 * 金額           「分」為單位的整數，原幣與台幣都是
 *
 * 這些倍率不是隨便挑的，見 toForeignCents() 的說明。
 */

/** 交易種類 */
export const FUND_ACTION = {
  OPENING: 'opening',    // 期初持份：直接給單位數與成本
  BUY: 'buy',            // 申購
  SELL: 'sell',          // 贖回
  DIVIDEND: 'dividend',  // 現金配息
  REINVEST: 'reinvest',  // 配息再投資（配息換成單位數）
};

const ACTIONS = new Set(Object.values(FUND_ACTION));

export const UNIT_SCALE = 10_000;    // 單位數的倍率
export const NAV_SCALE = 10_000;     // 淨值的倍率
export const FX_SCALE = 1_000_000;   // 匯率的倍率

/** 台幣對台幣的匯率，永遠是 1 */
export const TWD_RATE = FX_SCALE;

/**
 * 單位數 × 淨值 → 原幣金額（分）。
 *
 * 這裡是整個模組最容易靜靜出錯的地方，所以不直接把兩個整數相乘：
 * 若 units 用 10^4 倍、nav 用 10^6 倍，10 萬單位 × 淨值 15 的乘積約 1.5e16，
 * 已經超過 Number.MAX_SAFE_INTEGER（約 9.0e15），從那一刻起數字會無聲失真。
 *
 * 因此兩者都只用 10^4 倍，相乘前先各自還原成一般數值，
 * 結果立刻 round 回「分」的整數。中間過程容許浮點、結果一律落回整數 ——
 * 與 portfolio.js「totalCost 是整數分、avgCost 只是顯示用浮點」是同一種紀律。
 */
export function toForeignCents(units, nav) {
  if (!Number.isFinite(units) || !Number.isFinite(nav)) return 0;
  return Math.round((units / UNIT_SCALE) * (nav / NAV_SCALE) * 100);
}

/**
 * 原幣金額（分）→ 台幣金額（分）。
 *
 * 先把匯率除回一般數值再乘，順序不能顛倒：
 * 原幣金額本身可能到 1e13，先乘 10^6 倍的匯率會直接衝破安全整數上限。
 */
export function toTwdCents(foreignCents, fxRate) {
  if (!Number.isFinite(foreignCents)) return 0;
  if (!Number.isFinite(fxRate) || fxRate <= 0) return null;
  return Math.round(foreignCents * (fxRate / FX_SCALE));
}

/** 把使用者輸入的單位數轉成內部整數；無法解析時回 null */
export function parseUnits(value) {
  return scaleInput(value, UNIT_SCALE);
}

/** 把使用者輸入的淨值轉成內部整數；無法解析時回 null */
export function parseNav(value) {
  return scaleInput(value, NAV_SCALE);
}

/** 把使用者輸入的匯率轉成內部整數；無法解析時回 null */
export function parseRate(value) {
  return scaleInput(value, FX_SCALE);
}

function scaleInput(value, scale) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * scale);
}

/** 內部整數 → 顯示用的一般數值 */
export function unitsToNumber(units) { return (units ?? 0) / UNIT_SCALE; }
export function navToNumber(nav) { return (nav ?? 0) / NAV_SCALE; }
export function rateToNumber(rate) { return (rate ?? 0) / FX_SCALE; }

/**
 * 驗證並正規化一筆基金交易。
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function validateFundTrade(input) {
  const t = input ?? {};

  const fundId = String(t.fundId ?? '').trim();
  if (!fundId) return { ok: false, error: '請輸入基金代碼或自訂名稱' };

  if (!ACTIONS.has(t.action)) return { ok: false, error: '交易種類不正確' };

  const date = String(t.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: '日期格式不正確' };

  const currency = String(t.currency ?? 'TWD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: '幣別要是三個英文字母，例如 TWD、USD' };

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const units = Math.trunc(num(t.units) ?? 0);
  const nav = Math.round(num(t.nav) ?? 0);
  const fee = Math.max(0, Math.round(num(t.fee) ?? 0));
  const amount = Math.round(num(t.amount) ?? 0);

  // 台幣基金的匯率只可能是 1。讓使用者填、或讓程式沿用上一筆，都是多一個出錯的機會。
  const fxRate = currency === 'TWD' ? TWD_RATE : Math.round(num(t.fxRate) ?? 0);
  if (fxRate <= 0) {
    return { ok: false, error: `請輸入 ${currency} 對台幣的匯率` };
  }

  // 基金平台的庫存畫面常常只有單位數與淨值、沒有成本。
  // 允許先把持份建起來並標記「成本待補」，但這種部位不顯示損益 ——
  // 用 0 當成本會得到「賺了整個市值」這種荒謬的報酬率。
  const costUnknown = Boolean(t.costUnknown) && t.action === FUND_ACTION.OPENING;

  if (t.action === FUND_ACTION.DIVIDEND) {
    if (amount <= 0) return { ok: false, error: '配息金額要大於 0' };
  } else {
    if (units <= 0) return { ok: false, error: '單位數要大於 0' };
    // 期初持份的成本可以是 0（整筆都由配息再投資取得時，成本真的就是零）。
    // 申購、贖回、再投資仍然要求淨值大於 0。
    if (nav <= 0 && t.action !== FUND_ACTION.OPENING) {
      return { ok: false, error: '淨值要大於 0' };
    }
  }

  return {
    ok: true,
    value: {
      id: t.id,
      date,
      fundId,
      name: String(t.name ?? '').trim(),
      currency,
      action: t.action,
      units,
      nav,
      fxRate,
      fee,
      amount,
      note: String(t.note ?? '').trim(),
      costUnknown,
      createdAt: t.createdAt ?? Date.now(),
    },
  };
}

/** 交易要照時間順序套用，否則贖回可能發生在申購之前 */
function sortTrades(trades) {
  const rank = {
    [FUND_ACTION.OPENING]: 0,
    [FUND_ACTION.BUY]: 1,
    [FUND_ACTION.REINVEST]: 2,
    [FUND_ACTION.DIVIDEND]: 3,
    [FUND_ACTION.SELL]: 4,
  };
  return [...trades].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ra = rank[a.action] ?? 9;
    const rb = rank[b.action] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

function emptyPosition(fundId) {
  return {
    fundId,
    name: '',
    currency: '',
    units: 0,
    totalCostForeign: 0,   // 目前持份的原幣總成本（分）
    totalCostTwd: 0,       // 同一批持份的台幣總成本（分），用申購當日匯率換算
    unknownCostUnits: 0,   // 其中成本未知的單位數
    realizedForeign: 0,    // 已實現損益（原幣分），含配息
    realizedTwd: 0,        // 已實現損益（台幣分）
    dividendsForeign: 0,   // 其中來自配息的部分
    dividendsTwd: 0,
    tradeCount: 0,
    lastDate: null,
    warnings: [],
  };
}

/**
 * 由交易紀錄推算每一檔基金的持份。
 * 部位一律由交易推算、不存第二份 —— 存兩份遲早會對不起來，
 * 而且對不起來時你無法判斷哪一份才是對的。
 *
 * @param {object[]} trades
 * @returns {object[]} 依代碼排序；已贖回完的仍會保留（才看得到已實現損益）
 */
export function computeFundPositions(trades = []) {
  const map = new Map();

  // validateFundTrade 保證 fxRate > 0，所以這裡走到 null 代表資料是繞過驗證進來的
  // （舊備份、手動改過的匯出檔）。與其默默當成 0 讓台幣成本短少，不如講出來。
  const twdOf = (foreignCents, t, p) => {
    const v = toTwdCents(foreignCents, t.fxRate);
    if (v === null) {
      p.warnings.push(`${t.date} 缺少 ${t.currency} 的匯率，這筆的台幣金額無法計算`);
      return 0;
    }
    return v;
  };

  for (const t of sortTrades(trades)) {
    if (!map.has(t.fundId)) map.set(t.fundId, emptyPosition(t.fundId));
    const p = map.get(t.fundId);

    if (t.name) p.name = t.name;
    if (!p.currency) {
      p.currency = t.currency;
    } else if (t.currency && t.currency !== p.currency) {
      // 同一檔基金出現兩種幣別是資料錯誤。沿用第一筆並講出來，
      // 總比默默換算成另一種幣別、讓成本從此對不起來好。
      p.warnings.push(`${t.date} 的幣別是 ${t.currency}，與先前的 ${p.currency} 不一致`);
    }
    p.tradeCount += 1;
    p.lastDate = t.date;

    switch (t.action) {
      case FUND_ACTION.OPENING:
      case FUND_ACTION.BUY: {
        // 申購手續費計入成本 —— 那是取得這批單位數必須付出的代價
        const costForeign = toForeignCents(t.units, t.nav) + t.fee;
        p.units += t.units;
        p.totalCostForeign += costForeign;
        p.totalCostTwd += twdOf(costForeign, t, p);
        if (t.costUnknown) p.unknownCostUnits += t.units;
        break;
      }

      case FUND_ACTION.REINVEST: {
        // 配息再投資：收到配息、當場換成單位數。
        // 記成「配息收入 ＋ 等額申購」，成本與已實現收益同時增加，
        // 兩者相抵使總報酬在再投資的那一刻不變 —— 本來就不該憑空多賺或少賺。
        const gross = toForeignCents(t.units, t.nav);
        const grossTwd = twdOf(gross, t, p);
        p.units += t.units;
        p.totalCostForeign += gross;
        p.totalCostTwd += grossTwd;
        p.realizedForeign += gross;
        p.realizedTwd += grossTwd;
        p.dividendsForeign += gross;
        p.dividendsTwd += grossTwd;
        break;
      }

      case FUND_ACTION.SELL: {
        if (t.units > p.units) {
          p.warnings.push(
            `${t.date} 贖回 ${unitsToNumber(t.units)} 單位，但當時只持有 ${unitsToNumber(p.units)} 單位`,
          );
        }
        const sold = Math.min(t.units, p.units);
        // 用 totalCost 依比例攤，而不是先算平均成本再乘回去 —— 後者會累積除不盡的誤差
        const ratio = p.units > 0 ? sold / p.units : 0;
        const costForeign = Math.round(p.totalCostForeign * ratio);
        const costTwd = Math.round(p.totalCostTwd * ratio);

        const proceedsForeign = toForeignCents(sold, t.nav) - t.fee;
        const proceedsTwd = twdOf(proceedsForeign, t, p);

        p.realizedForeign += proceedsForeign - costForeign;
        // 台幣的已實現損益用「贖回當日匯率的收入」減「申購當日匯率的成本」，
        // 匯兌損益自然含在裡面，不必另外算一份
        p.realizedTwd += proceedsTwd - costTwd;

        p.totalCostForeign -= costForeign;
        p.totalCostTwd -= costTwd;
        if (p.unknownCostUnits > 0 && p.units > 0) {
          p.unknownCostUnits = Math.max(0, Math.round(p.unknownCostUnits * (1 - ratio)));
        }
        p.units -= sold;

        // 全部贖回時把成本歸零，避免留下四捨五入的零頭
        if (p.units === 0) {
          p.totalCostForeign = 0;
          p.totalCostTwd = 0;
          p.unknownCostUnits = 0;
        }
        break;
      }

      case FUND_ACTION.DIVIDEND: {
        // 現金配息計入已實現收益，不沖減成本 —— 與對帳單的呈現一致
        const twd = twdOf(t.amount, t, p);
        p.realizedForeign += t.amount;
        p.realizedTwd += twd;
        p.dividendsForeign += t.amount;
        p.dividendsTwd += twd;
        break;
      }

      default:
        p.warnings.push(`${t.date} 有無法辨識的交易種類：${t.action}`);
    }
  }

  return [...map.values()].sort((a, b) => a.fundId.localeCompare(b.fundId));
}

/** 平均成本（原幣分，浮點）。totalCostForeign 才是真實來源，這個值只用於顯示。 */
export function averageCostForeign(position) {
  if (!position || position.units <= 0) return 0;
  return position.totalCostForeign / unitsToNumber(position.units);
}

/** 平均每單位淨值成本（原幣元，浮點），即對帳單上的「平均申購淨值」 */
export function averageNav(position) {
  return averageCostForeign(position) / 100;
}

/**
 * 加上淨值與匯率後的評價。
 *
 * @param {object} position computeFundPositions 的結果
 * @param {number|null} nav 目前每單位淨值（原幣，×10^4）；沒有就傳 null
 * @param {number|null} fxRate 目前匯率（×10^6）；沒有就傳 null
 */
export function valueFundPosition(position, nav, fxRate) {
  const units = position?.units ?? 0;
  const costForeign = position?.totalCostForeign ?? 0;
  const costTwd = position?.totalCostTwd ?? 0;

  const hasNav = Number.isFinite(nav) && nav > 0;
  // 台幣基金不需要匯率表也能算，否則使用者得為了 TWD 去填一個永遠是 1 的數字
  const rate = position?.currency === 'TWD' ? TWD_RATE : fxRate;
  const hasRate = Number.isFinite(rate) && rate > 0;

  // 由庫存畫面匯入時常常沒有成本。這種部位算得出市值，但算不出損益。
  const costUnknown = (position?.unknownCostUnits ?? 0) > 0;

  const marketValueForeign = hasNav ? toForeignCents(units, nav) : null;
  const marketValue = hasNav && hasRate ? toTwdCents(marketValueForeign, rate) : null;

  const computable = hasNav && !costUnknown;
  const unrealizedForeign = computable ? marketValueForeign - costForeign : null;
  const unrealized = computable && hasRate ? marketValue - costTwd : null;

  return {
    ...position,
    nav: hasNav ? nav : null,
    fxRate: hasRate ? rate : null,
    avgNav: averageNav(position),
    costUnknown,
    marketValueForeign,
    marketValue,
    unrealizedForeign,
    unrealized,
    // 兩種報酬率都給：原幣是基金本身的績效，台幣是你實際的損益
    returnRateForeign: unrealizedForeign !== null && costForeign > 0
      ? unrealizedForeign / costForeign : null,
    returnRate: unrealized !== null && costTwd > 0 ? unrealized / costTwd : null,
    // 匯兌損益 = 台幣未實現 −（原幣未實現換成今天的台幣）
    // 展開後等於「原幣成本 × 匯率變動」，也就是台幣損益中不是基金績效的那一塊
    fxEffect: unrealized !== null && unrealizedForeign !== null
      ? unrealized - toTwdCents(unrealizedForeign, rate) : null,
    totalReturn: unrealized !== null ? unrealized + position.realizedTwd : null,
  };
}

/**
 * 整個基金組合的彙總。對外的金額一律是台幣。
 *
 * @param {object[]} positions computeFundPositions 的結果
 * @param {Record<string, number>} navs 代碼 → 目前淨值（原幣，×10^4）
 * @param {Record<string, number>} fxRates 幣別 → 匯率（×10^6）
 */
export function summarizeFunds(positions = [], navs = {}, fxRates = {}) {
  const rows = positions.map((p) => valueFundPosition(
    p, navs[p.fundId] ?? null, fxRates[p.currency] ?? null,
  ));

  const held = rows.filter((r) => r.units > 0);
  const priced = held.filter((r) => r.marketValue !== null);

  const marketValue = priced.reduce((a, r) => a + r.marketValue, 0);
  const totalCost = held.reduce((a, r) => a + r.totalCostTwd, 0);
  const realized = rows.reduce((a, r) => a + r.realizedTwd, 0);
  const dividends = rows.reduce((a, r) => a + r.dividendsTwd, 0);

  // 損益只能用「有淨值、有匯率、而且成本已知」的部位來算。
  // 少算一檔卻照樣顯示總額，會讓使用者以為自己虧損 —— 這種誤導比沒有數字更糟。
  const computable = priced.filter((r) => r.unrealized !== null);
  const costOfPriced = computable.reduce((a, r) => a + r.totalCostTwd, 0);
  const unrealized = computable.reduce((a, r) => a + r.unrealized, 0);

  const costUnknownRows = held.filter((r) => r.costUnknown);

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
    // 分開講「缺淨值」與「缺匯率」：兩者要補的東西不一樣，
    // 混在一起講會讓使用者不知道該去填哪一個
    missingNav: held.filter((r) => r.nav === null).map((r) => r.fundId),
    missingRate: [...new Set(held.filter((r) => r.nav !== null && r.fxRate === null)
      .map((r) => r.currency))],
    missingCost: costUnknownRows.map((r) => r.fundId),
    complete: held.length > 0 && priced.length === held.length && costUnknownRows.length === 0,
  };
}

/** 依台幣市值排序，供列表與圖表使用；沒有市值的排最後 */
export function byFundValue(rows) {
  return [...rows]
    .filter((r) => r.units > 0)
    .sort((a, b) => (b.marketValue ?? -1) - (a.marketValue ?? -1));
}

/** 目前持有的外幣幣別，供匯率表只顯示需要填的那幾種 */
export function usedCurrencies(positions = []) {
  const set = new Set();
  for (const p of positions) {
    if (p.units > 0 && p.currency && p.currency !== 'TWD') set.add(p.currency);
  }
  return [...set].sort();
}
