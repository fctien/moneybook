/**
 * 持股匯入的解析器：把「貼上的文字」或「CSV 檔」變成可預覽的表格。
 *
 * ── 為什麼不直接解析 PDF ──
 * 集保 e 手掌握匯出的是帶數位簽章的 PDF，券商 App 則根本沒有匯出功能。
 * 引入 PDF 解析函式庫要多背 1 MB 以上，而「開啟 PDF → 選取文字 → 拷貝」
 * 和「截圖 → iOS 即時文字 → 拷貝」都是系統內建、零成本。
 * 因此統一走「貼上文字」這一條路，任何來源都適用。
 *
 * ── 為什麼不自動判斷欄位就直接匯入 ──
 * 各券商排版差異極大，任何啟發式判斷都有猜錯的時候。
 * 這裡只負責「切成表格」與「提出建議」，最終欄位對應由使用者在預覽畫面確認。
 * 猜錯了使用者看得到並能改；默默寫進錯誤的成本價則會一路污染後續所有損益數字。
 */

/** 台股代號：一般 4 碼，ETF 為 00 開頭的 5～6 碼，權證可能帶一個英文字母 */
const SYMBOL_RE = /^\d{4,6}[A-Z]?$/;

/** 可辨識的欄位角色 */
export const FIELD = {
  IGNORE: 'ignore',
  SHARES: 'shares',
  AVG_COST: 'avgCost',
  PRICE: 'price',
};

// --------------------------------------------------------------------------
// 編碼
// --------------------------------------------------------------------------

/**
 * 把檔案位元組解成文字。
 *
 * 券商匯出的 CSV 十之八九是 Big5。先試 UTF-8，出現替換字元就改用 Big5 ——
 * 與發票條碼那邊是同一個坑：中文編碼猜錯不會拋錯，只會得到一整片亂碼。
 */
export function decodeText(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // BOM 開頭就一定是 UTF-8
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }

  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('�')) return utf8;

  try {
    return new TextDecoder('big5').decode(bytes);
  } catch {
    return utf8;
  }
}

// --------------------------------------------------------------------------
// CSV
// --------------------------------------------------------------------------

/**
 * 把「1,234」這種千分位逗號拿掉，只在「判斷是不是表格」時使用。
 *
 * 這是實測踩到的坑：券商庫存的股數幾乎一定帶千分位，
 * 若直接用「有沒有逗號」判斷是不是 CSV，
 * 「2330 台積電 1,000 600.00」會被當成 CSV 從逗號切開，代號就再也找不到了。
 *
 * 刻意不用 lookbehind 寫法 —— 舊版 iOS Safari 不支援，
 * 而那是語法錯誤，會讓整個檔案載入失敗，不只是這個函式壞掉。
 */
function stripThousands(text) {
  let out = String(text ?? '');
  let prev;
  do {
    prev = out;
    out = out.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  } while (out !== prev);
  return out;
}

/** 猜分隔符號：逗號、Tab 或分號 */
export function detectDelimiter(text) {
  const line = stripThousands(String(text ?? '')).split(/\r?\n/).find((l) => l.trim()) ?? '';
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/**
 * 解析 CSV／TSV 成二維陣列。
 * 自己寫是因為要處理引號內的分隔符號與換行，而 split(',') 會在這種資料上壞掉。
 */
export function parseCSV(text, delimiter = null) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const d = delimiter ?? detectDelimiter(src);

  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; }  // 跳脫的雙引號
        else inQuote = false;
      } else cell += ch;
      continue;
    }

    if (ch === '"') inQuote = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }

  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ''));
}

// --------------------------------------------------------------------------
// 數字與代號
// --------------------------------------------------------------------------

/** 把「1,234.50」「＄1,234」這類字串轉成數字；不是數字回傳 null */
export function toNumber(token) {
  if (token == null) return null;
  const cleaned = String(token)
    .replace(/[,\s＄$元股]/g, '')
    // 全形數字與小數點
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, '.');
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 從一段文字裡找出股票代號。支援「2330」「台積電(2330)」「2330 台積電」 */
export function findSymbol(tokens) {
  const paren = tokens.join(' ').match(/[（(](\d{4,6}[A-Z]?)[）)]/);
  if (paren) return paren[1];

  for (const t of tokens) {
    const clean = String(t).trim();
    // 帶千分位或小數點的一定是金額，不會是代號
    if (/[.,]/.test(clean)) continue;
    if (SYMBOL_RE.test(clean)) return clean;
  }
  return null;
}

/** 取出中文或英文的股票名稱（不含代號與數字） */
function findName(tokens, symbol) {
  for (const t of tokens) {
    const clean = String(t).replace(/[（(]\d{4,6}[A-Z]?[）)]/g, '').trim();
    if (!clean || clean === symbol) continue;
    if (toNumber(clean) !== null) continue;
    if (/[一-鿿]|[A-Za-z]{2,}/.test(clean)) return clean;
  }
  return '';
}

// --------------------------------------------------------------------------
// 主要解析
// --------------------------------------------------------------------------

/**
 * 從貼上的文字或 CSV 表格抽出持股列。
 *
 * 以「股票代號」當錨點：找到代號的那一列就是一筆持股，
 * 同列其餘的數字依序收進 numbers，由使用者決定哪一欄是股數、成本、現價。
 *
 * 券商 App 截圖經過文字辨識後，同一筆常被拆成兩行（第一行代號與名稱、
 * 第二行才是數字），因此找不到數字時會往下一行借。
 *
 * @param {string} text
 * @returns {{rows: object[], skipped: number}}
 */
export function extractHoldings(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  // 先拿掉千分位再判斷，否則「1,000」會讓純文字被誤認成 CSV
  const looksTabular = /[\t;]/.test(src) || /,/.test(stripThousands(src));

  const lines = looksTabular
    ? parseCSV(src)
    : src.split('\n').map((l) => l.trim().split(/\s{1,}/).filter(Boolean));

  const rows = [];
  let skipped = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const tokens = lines[i].filter((t) => String(t).trim() !== '');
    if (!tokens.length) continue;

    const symbol = findSymbol(tokens);
    if (!symbol) { skipped += 1; continue; }

    let numbers = tokens
      .filter((t) => String(t).trim() !== symbol)
      .map(toNumber)
      .filter((n) => n !== null);

    // 數字在下一行：截圖辨識常見的斷行方式
    if (!numbers.length && lines[i + 1]) {
      const next = lines[i + 1].filter((t) => String(t).trim() !== '');
      if (!findSymbol(next)) {
        numbers = next.map(toNumber).filter((n) => n !== null);
        i += 1; // 這一行已經用掉了
      }
    }

    rows.push({
      symbol,
      name: findName(tokens, symbol),
      numbers,
    });
  }

  return { rows, skipped };
}

/**
 * 依欄位數量猜一組對應。只是「建議值」，使用者仍要在預覽畫面確認。
 *
 * 台灣券商庫存表最常見的排法是「股數、成本價、現價」，
 * 而股數幾乎一定是整數、單價幾乎一定有小數 —— 用這個特徵來猜。
 *
 * @param {object[]} rows extractHoldings 的結果
 * @returns {string[]} 每個數字欄位對應到的 FIELD
 */
export function suggestMapping(rows = []) {
  const width = Math.max(0, ...rows.map((r) => r.numbers.length));
  if (!width) return [];

  const mapping = new Array(width).fill(FIELD.IGNORE);

  // 每一欄是不是「整數」與其典型大小
  const isInt = [];
  const medians = [];
  for (let c = 0; c < width; c += 1) {
    const vals = rows.map((r) => r.numbers[c]).filter((v) => Number.isFinite(v));
    isInt[c] = vals.length > 0 && vals.every((v) => Number.isInteger(v));
    const sorted = [...vals].sort((a, b) => a - b);
    medians[c] = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  // 股數：整數欄裡數值最大的那一欄（庫存動輒上千股，單價通常只有兩三位數）
  let sharesCol = -1;
  for (let c = 0; c < width; c += 1) {
    if (!isInt[c]) continue;
    if (sharesCol === -1 || medians[c] > medians[sharesCol]) sharesCol = c;
  }
  if (sharesCol >= 0) mapping[sharesCol] = FIELD.SHARES;

  // 其餘欄位由左至右指派為成本價、現價
  const rest = [];
  for (let c = 0; c < width; c += 1) if (mapping[c] === FIELD.IGNORE) rest.push(c);
  if (rest[0] !== undefined) mapping[rest[0]] = FIELD.AVG_COST;
  if (rest[1] !== undefined) mapping[rest[1]] = FIELD.PRICE;

  return mapping;
}

/**
 * 合併多批貼上的內容（庫存分好幾頁時）。
 *
 * 同一檔重複出現時「不」自動相加 —— 最常見的原因是使用者不小心貼了同一頁兩次，
 * 自動相加會讓股數憑空變成兩倍而且很難察覺。
 * 這裡標記出來，由使用者決定要相加還是只留一筆。
 *
 * @param {object[][]} batches 每一次貼上解析出的列
 * @returns {{rows: object[], duplicates: string[]}}
 */
export function mergeBatches(batches = []) {
  const seen = new Map();
  const duplicates = new Set();

  for (const batch of batches) {
    for (const row of batch ?? []) {
      if (seen.has(row.symbol)) {
        duplicates.add(row.symbol);
        // 保留第一次出現的那筆，重複的另外標記
        seen.get(row.symbol).duplicateOf = (seen.get(row.symbol).duplicateOf ?? 0) + 1;
        continue;
      }
      seen.set(row.symbol, { ...row });
    }
  }

  return { rows: [...seen.values()], duplicates: [...duplicates] };
}

/**
 * 把重複出現的同一檔合併成一筆（例如同一檔分別放在兩家券商）。
 *
 * 股數相加，但成本必須走「加權平均」而不是把成本價直接相加或取平均 ——
 * 1000 股成本 600 與 100 股成本 900 合起來不是 750，是 627.27。
 * 取簡單平均會讓成本高估，之後所有損益數字都跟著錯。
 *
 * @param {object[]} rows
 * @param {string[]} mapping
 * @returns {object[]} 合併後的列，數字欄位以 shares/avgCost/price 覆寫值呈現
 */
export function combineDuplicates(rows = [], mapping = []) {
  const idxOf = (field) => mapping.indexOf(field);
  const get = (row, field) => {
    if (row[field] != null) return row[field];
    const i = idxOf(field);
    return i >= 0 ? row.numbers?.[i] ?? null : null;
  };

  const acc = new Map();

  for (const row of rows) {
    const shares = get(row, FIELD.SHARES);
    const cost = get(row, FIELD.AVG_COST);
    const price = get(row, FIELD.PRICE);

    if (!acc.has(row.symbol)) {
      acc.set(row.symbol, {
        symbol: row.symbol,
        name: row.name ?? '',
        numbers: row.numbers ?? [],
        shares: Number.isFinite(shares) ? shares : null,
        avgCost: Number.isFinite(cost) ? cost : null,
        price: Number.isFinite(price) ? price : null,
        mergedFrom: 1,
      });
      continue;
    }

    const cur = acc.get(row.symbol);
    cur.mergedFrom += 1;
    if (!cur.name && row.name) cur.name = row.name;
    if (Number.isFinite(price)) cur.price = price; // 市價取最後看到的

    if (Number.isFinite(shares) && shares > 0) {
      const addCost = Number.isFinite(cost) ? cost : cur.avgCost;
      if (Number.isFinite(cur.shares) && Number.isFinite(cur.avgCost) && Number.isFinite(addCost)) {
        const totalCost = cur.shares * cur.avgCost + shares * addCost;
        cur.shares += shares;
        cur.avgCost = totalCost / cur.shares;
      } else {
        cur.shares = (cur.shares ?? 0) + shares;
      }
    }
  }

  return [...acc.values()];
}

/**
 * 把預覽表轉成可寫入的期初交易與報價。
 *
 * @param {object[]} rows
 * @param {string[]} mapping 每個數字欄位的角色
 * @param {string} date 期初日期
 * @returns {{trades: object[], quotes: object[], errors: string[]}}
 */
export function rowsToTrades(rows = [], mapping = [], date) {
  const trades = [];
  const quotes = [];
  const errors = [];

  const pick = (row, field) => {
    const idx = mapping.indexOf(field);
    return idx >= 0 ? row.numbers[idx] ?? null : null;
  };

  for (const row of rows) {
    if (row.skip) continue;

    const shares = row.shares ?? pick(row, FIELD.SHARES);
    const avgCost = row.avgCost ?? pick(row, FIELD.AVG_COST);
    const price = row.price ?? pick(row, FIELD.PRICE);

    if (!Number.isFinite(shares) || shares <= 0) {
      errors.push(`${row.symbol}：股數不正確`);
      continue;
    }
    if (!Number.isFinite(avgCost) || avgCost <= 0) {
      errors.push(`${row.symbol}：成本價不正確`);
      continue;
    }

    trades.push({
      date,
      symbol: row.symbol,
      name: row.name ?? '',
      action: 'opening',
      // 金額一律以「分」為單位的整數儲存
      shares: Math.round(shares),
      price: Math.round(avgCost * 100),
    });

    if (Number.isFinite(price) && price > 0) {
      quotes.push({ symbol: row.symbol, close: Math.round(price * 100) });
    }
  }

  return { trades, quotes, errors };
}
