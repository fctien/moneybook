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
  AVG_COST: 'avgCost',     // 每股平均成本
  TOTAL_COST: 'totalCost', // 成本總額（券商多半給這個，而不是每股）
  PRICE: 'price',
};

/**
 * 券商表頭的欄名對照。有表頭就直接照欄名對應，
 * 這比從數值特徵猜可靠得多 —— 猜錯了畫面上看不出來。
 */
const HEADER_FIELD = new Map([
  ['庫存數量', FIELD.SHARES], ['即時數量', FIELD.SHARES], ['股數', FIELD.SHARES],
  ['庫存股數', FIELD.SHARES], ['持有數量', FIELD.SHARES],
  ['現價', FIELD.PRICE], ['市價', FIELD.PRICE], ['成交價', FIELD.PRICE], ['參考價', FIELD.PRICE],
  ['平均單價', FIELD.AVG_COST], ['成本單價', FIELD.AVG_COST], ['成本價', FIELD.AVG_COST],
  ['均價', FIELD.AVG_COST], ['買進均價', FIELD.AVG_COST],
  ['成本金額', FIELD.TOTAL_COST], ['持有成本', FIELD.TOTAL_COST], ['總成本', FIELD.TOTAL_COST],
  // 以下是刻意標成不使用的：市值與損益都能由前面幾欄推算，
  // 讓它們參與對應只會增加猜錯的機會
  ['市值', FIELD.IGNORE], ['參考市值', FIELD.IGNORE], ['可下單數', FIELD.IGNORE],
  ['可下單數量', FIELD.IGNORE], ['成本數量', FIELD.IGNORE], ['利息費用', FIELD.IGNORE],
  ['損益', FIELD.IGNORE], ['未實現損益', FIELD.IGNORE], ['報酬率', FIELD.IGNORE],
  ['無成本數量', FIELD.IGNORE], ['幣別', FIELD.IGNORE], ['漲跌', FIELD.IGNORE],
]);

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
    // 百分比也要當成數字解析。若直接判定為「非數字」而丟掉，
    // 「報酬率」那一欄就會從 numbers 裡消失，後面所有欄位跟著錯位。
    .replace(/[,\s＄$元股%％]/g, '')
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

/**
 * 券商庫存畫面上會出現、但不是股票名稱的欄位。
 *
 * 實際截圖裡「下單」按鈕排在商品名稱前面，「現股」「集保」排在後面。
 * 不濾掉的話，第一個非數字欄位會被當成股票名稱，整批就解析不出東西。
 */
const NOISE = new Set([
  '下單', '買進', '賣出', '現買', '現賣',
  '現股', '集保', '興櫃', '零股', '融資', '融券', '借券', '定期定額',
  '商品', '股票', '名稱', '股票名稱', '交易別', '庫存數量', '可下單數量',
  '現價', '市值', '成本', '成本價', '均價', '參考市值', '損益', '未實現損益',
  '合計', '小計', '總計', '總市值', '股數',
]);

/** 取出所有可能是股票名稱的字串，依出現順序排列 */
function nameCandidates(tokens, symbol) {
  const out = [];
  for (const t of tokens) {
    const clean = String(t).replace(/[（(]\d{4,6}[A-Z]?[）)]/g, '').trim();
    if (!clean || clean === symbol) continue;
    if (toNumber(clean) !== null) continue;
    if (!/[一-鿿]|[A-Za-z]{2,}/.test(clean)) continue;
    out.push(clean);
  }
  return out;
}

/** 取出中文或英文的股票名稱（不含代號與數字） */
function findName(tokens, symbol) {
  const cands = nameCandidates(tokens, symbol);
  // 優先挑不在雜訊清單裡的，全都是雜訊時才退回第一個
  return cands.find((c) => !NOISE.has(c)) ?? cands[0] ?? '';
}

/**
 * 這一列看起來像不像一筆持股資料（而不是標題或頁尾）。
 *
 * 兩種都算：同一行就帶數字，或名稱單獨一行、數字全在下一行 ——
 * 後者是券商截圖經文字辨識後最常見的排版。
 */
function looksLikeDataRow(tokens, nextTokens) {
  if (tokens.some((t) => toNumber(t) !== null)) return true;
  const next = (nextTokens ?? []).filter((t) => String(t).trim() !== '');
  return next.length > 0 && next.every((t) => toNumber(t) !== null);
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
 * 有些券商的庫存畫面只顯示名稱而不顯示代號，這種情況會用 lookup
 * 由名稱反查代號；查不到就整列略過，並在 unresolved 回報，
 * 讓使用者知道是「有這一列但認不出來」而不是「沒讀到東西」。
 *
 * @param {string} text
 * @param {{lookup?: (name:string) => string|null}} [opts]
 * @returns {{rows: object[], skipped: number, unresolved: string[]}}
 */
export function extractHoldings(text, opts = {}) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  // 先拿掉千分位再判斷，否則「1,000」會讓純文字被誤認成 CSV
  const looksTabular = /[\t;]/.test(src) || /,/.test(stripThousands(src));

  const lines = looksTabular
    ? parseCSV(src)
    : src.split('\n').map((l) => l.trim().split(/\s{1,}/).filter(Boolean));

  const lookup = typeof opts.lookup === 'function' ? opts.lookup : null;
  const rows = [];
  const unresolved = [];
  let header = null;
  let skipped = 0;

  // 表頭：整列都是已知欄名的那一行。找到就能直接照欄名對應，
  // 不必從數值特徵猜 —— 猜錯了畫面上完全看不出來。
  for (const line of lines) {
    const toks = line.filter((t) => String(t).trim() !== '');
    if (toks.length < 2) continue;
    // 表頭不會有數字。這一條比「至少要有幾個已知欄名」可靠得多 ——
    // 分次擷取窄欄位時，表頭可能只有「商品 成本金額」兩欄，
    // 用數量門檻會整個認不出來，那一欄就會被誤判成股數。
    if (toks.some((t) => toNumber(t) !== null)) continue;
    if (toks.some((t) => HEADER_FIELD.has(String(t).trim()))) { header = toks; break; }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const tokens = lines[i].filter((t) => String(t).trim() !== '');
    if (!tokens.length) continue;

    let symbol = findSymbol(tokens);
    let resolvedBy = 'code';

    // 只顯示名稱、沒有代號的排版：由名稱反查。
    // 查不到就記進 unresolved 而不是靜靜丟掉 —— 使用者要能分辨
    // 「這一列沒讀到」與「這一列讀到了但認不出是哪一檔」。
    if (!symbol && lookup) {
      // 逐一試每個非數字欄位，第一個查得到的就是股票名稱。
      // 這比「取第一個非數字欄位」穩健得多 —— 券商在名稱前後各塞了
      // 「下單」「現股」「集保」等欄位，位置又隨畫面而異。
      // 雜訊字要在查表「之前」濾掉。「商品」剛好是某檔 ETF 名稱的一部分，
      // 拿去查會查出代號，整條表頭就被當成一筆持股。
      const cands = nameCandidates(tokens, '').filter((c) => !NOISE.has(c));
      let matchedName = '';
      for (const c of cands) {
        const hit = lookup(c);
        if (hit) { symbol = hit; matchedName = c; break; }
      }

      const candidate = matchedName || findName(tokens, '');
      if (symbol) {
        resolvedBy = 'name';
      } else if (candidate && !NOISE.has(candidate)) {
        if (looksLikeDataRow(tokens, lines[i + 1])) {
          // 只在「這一列看起來真的是一筆持股」時才回報，
          // 否則「庫存明細」這種標題也會被當成認不出的股票，警告就變成雜訊
          unresolved.push(candidate);
        }
      }
    }

    if (!symbol) { skipped += 1; continue; }

    const numbers = [];
    let numberIndices = [];
    tokens.forEach((t, idx) => {
      if (String(t).trim() === symbol) return;
      const n = toNumber(t);
      if (n === null) return;
      numbers.push(n);
      numberIndices.push(idx);
    });

    // 數字在下一行：截圖辨識常見的斷行方式
    if (!numbers.length && lines[i + 1]) {
      const next = lines[i + 1].filter((t) => String(t).trim() !== '');
      // 下一行本身若是另一檔股票就不能借，否則會把兩檔混成一筆
      const nextIsAnother = findSymbol(next) || (lookup && lookup(findName(next, '')));
      if (!nextIsAnother) {
        numberIndices = [];
        next.forEach((t, idx) => {
          const n = toNumber(t);
          if (n === null) return;
          numbers.push(n);
          numberIndices.push(idx);
        });
        i += 1; // 這一行已經用掉了
      }
    }

    rows.push({
      symbol,
      name: findName(tokens, symbol),
      numbers,
      // 數字在原始欄位中的位置。有表頭時要靠它把欄名對上數字欄，
      // 因為 numbers 已經濾掉了商品名稱、種類、幣別這些非數字欄。
      numberAt: numberIndices,
      tokens,
      resolvedBy,
    });
  }

  // 偵測「表格被拆成直行」：iOS 即時文字對寬表格常常逐直行讀取，
  // 名稱擠成一個區塊、數字在另外幾個區塊，行與行的對應在辨識時就沒了。
  // 這種情況要明講，不能靠順序去猜對應 —— 猜錯一格，之後每一檔的成本
  // 都會掛到別人身上，而且看起來完全正常。
  const withNumbers = rows.filter((r) => r.numbers.length > 0).length;
  const layoutLost = rows.length >= 3 && withNumbers <= rows.length / 3;

  return { rows, skipped, unresolved, header, layoutLost };
}

/**
 * 依股票代號把多批資料合併成一筆，欄位互補。
 *
 * 這是「分次擷取窄欄位」的關鍵：先貼「商品＋庫存數量」，再貼「商品＋成本金額」，
 * 兩批用代號對起來就湊成完整的一筆。寬表格辨識不出行對應時，這是唯一可靠的做法。
 *
 * 兩批對同一個欄位給了不同的值時不會擅自挑一個，而是回報衝突讓使用者決定。
 *
 * @param {object[]} rows 已攤平成 shares/avgCost/totalCost/price 的列
 * @returns {{rows: object[], conflicts: {symbol:string, field:string, values:number[]}[]}}
 */
export function mergeBySymbol(rows = []) {
  const FIELDS = ['shares', 'avgCost', 'totalCost', 'price'];
  const map = new Map();
  const conflicts = [];

  for (const row of rows) {
    if (!map.has(row.symbol)) {
      map.set(row.symbol, { ...row, mergedFrom: 1 });
      continue;
    }

    const cur = map.get(row.symbol);
    cur.mergedFrom += 1;
    if (!cur.name && row.name) cur.name = row.name;

    for (const f of FIELDS) {
      const a = cur[f];
      const b = row[f];
      if (b == null) continue;
      if (a == null) { cur[f] = b; continue; }
      if (a !== b) conflicts.push({ symbol: row.symbol, field: f, values: [a, b] });
    }
  }

  return { rows: [...map.values()], conflicts };
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
export function suggestMapping(rows = [], header = null) {
  // 有表頭就照欄名對應。這是最可靠的一條路 ——
  // 數值特徵的判斷再怎麼小心，遇到沒見過的排版還是會猜錯，
  // 而猜錯的結果（例如把市值當成股數）在畫面上完全看不出異常。
  const byHeader = mapByHeader(rows, header);
  if (byHeader) return byHeader;

  return suggestByShape(rows);
}

/**
 * 依表頭欄名產生對應。
 * numbers 已經濾掉非數字欄，因此要靠 numberAt 把欄名對回數字欄。
 */
function mapByHeader(rows, header) {
  if (!Array.isArray(header) || !header.length) return null;

  const sample = rows.find((r) => Array.isArray(r.numberAt) && r.numberAt.length);
  if (!sample) return null;
  // 欄數對不上就不能靠位置對應，寧可退回數值判斷
  if (sample.tokens?.length !== header.length) return null;

  const mapping = sample.numberAt.map((idx) => {
    const name = String(header[idx] ?? '').trim();
    return HEADER_FIELD.get(name) ?? FIELD.IGNORE;
  });

  // 只要認出任何一個有意義的欄位就採用。
  // 不能硬性要求「必須有股數」—— 分次擷取窄欄位時，某一批可能只帶成本，
  // 擋掉的話那一欄會退回數值判斷、被誤認成股數，兩批合併時就變成衝突。
  const meaningful = [FIELD.SHARES, FIELD.AVG_COST, FIELD.TOTAL_COST, FIELD.PRICE];
  if (!mapping.some((m) => meaningful.includes(m))) return null;

  // 兩種成本欄位同時存在時，留「成本總額」而不是「平均單價」。
  // 平均單價是券商四捨五入後的顯示值：8.7423 × 107,000 = 935,326，
  // 但實際成本金額是 935,431，差了 105 元。總額才是精確的原始數字。
  if (mapping.includes(FIELD.AVG_COST) && mapping.includes(FIELD.TOTAL_COST)) {
    mapping[mapping.indexOf(FIELD.AVG_COST)] = FIELD.IGNORE;
  }
  return mapping;
}

/** 沒有表頭時，退回用數值特徵判斷 */
function suggestByShape(rows = []) {
  const width = Math.max(0, ...rows.map((r) => r.numbers.length));
  if (!width) return [];

  const mapping = new Array(width).fill(FIELD.IGNORE);
  const col = (c) => rows.map((r) => r.numbers[c]).filter((v) => Number.isFinite(v));

  const isInt = [];
  const medians = [];
  for (let c = 0; c < width; c += 1) {
    const vals = col(c);
    isInt[c] = vals.length > 0 && vals.every((v) => Number.isInteger(v));
    const sorted = [...vals].sort((a, b) => a - b);
    medians[c] = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  const excluded = new Set();

  // 「市值」欄要先排除。它是股數 × 現價，數值往往比股數還大而且也是整數，
  // 不排掉的話會被當成股數 —— 107,000 股 × 9.73 元的市值 1,041,110
  // 會變成「持有 1,041,110 股」，而畫面上看起來毫無異常。
  // 用「這一欄約等於另外兩欄相乘」來認它，比猜欄位順序可靠得多。
  let priceCol = -1;
  let sharesCol = -1;
  outer:
  for (let c = 0; c < width; c += 1) {
    for (let a = 0; a < width; a += 1) {
      for (let b = 0; b < width; b += 1) {
        if (c === a || c === b || a === b) continue;
        const va = col(a); const vb = col(b); const vc = col(c);
        const n = Math.min(va.length, vb.length, vc.length);
        if (n < 1) continue;

        let hit = 0;
        for (let i = 0; i < n; i += 1) {
          const prod = va[i] * vb[i];
          if (vc[i] > 0 && Math.abs(prod - vc[i]) / vc[i] < 0.02) hit += 1;
        }
        if (hit === n) {
          excluded.add(c);
          // 兩個因數中，整數的是股數、有小數的是價格
          if (isInt[a] && !isInt[b]) { sharesCol = a; priceCol = b; }
          else if (isInt[b] && !isInt[a]) { sharesCol = b; priceCol = a; }
          else { sharesCol = medians[a] >= medians[b] ? a : b; priceCol = sharesCol === a ? b : a; }
          break outer;
        }
      }
    }
  }

  // 完全重複的欄位只留第一個。券商的「庫存數量」與「可下單數量」
  // 多數時候一模一樣，第二欄若被指派成成本價會整批算錯。
  for (let c = 1; c < width; c += 1) {
    if (excluded.has(c)) continue;
    for (let p = 0; p < c; p += 1) {
      const vc = col(c); const vp = col(p);
      if (vc.length && vc.length === vp.length && vc.every((v, i) => v === vp[i])) {
        excluded.add(c);
        break;
      }
    }
  }

  if (sharesCol < 0) {
    // 沒有市值可比對時，退回原本的判斷：整數欄裡數值最大的是股數
    for (let c = 0; c < width; c += 1) {
      if (!isInt[c] || excluded.has(c)) continue;
      if (sharesCol === -1 || medians[c] > medians[sharesCol]) sharesCol = c;
    }
  }
  if (sharesCol >= 0) mapping[sharesCol] = FIELD.SHARES;
  if (priceCol >= 0) mapping[priceCol] = FIELD.PRICE;

  // 其餘欄位由左至右指派為成本價、現價
  for (let c = 0; c < width; c += 1) {
    if (mapping[c] !== FIELD.IGNORE || excluded.has(c)) continue;
    if (!mapping.includes(FIELD.AVG_COST)) mapping[c] = FIELD.AVG_COST;
    else if (!mapping.includes(FIELD.PRICE)) mapping[c] = FIELD.PRICE;
  }

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
    const totalCost = row.totalCost ?? pick(row, FIELD.TOTAL_COST);
    const price = row.price ?? pick(row, FIELD.PRICE);

    if (!Number.isFinite(shares) || shares <= 0) {
      errors.push(`${row.symbol}：股數不正確`);
      continue;
    }

    const n = Math.round(shares);
    let priceCents = 0;
    let feeCents = 0;
    // 「成本欄位存在但值是 0」與「根本沒有成本欄位」是兩回事。
    // 前者是真的零成本（全部由配股取得），後者才是待補。
    let costUnknown = true;

    if (Number.isFinite(avgCost)) {
      priceCents = Math.round(avgCost * 100);
      costUnknown = false;
    } else if (Number.isFinite(totalCost)) {
      // 券商多半只給成本總額。直接除以股數再四捨五入會失真：
      // 935,431 / 107,000 = 8.74234…，取到分之後乘回去會少掉 251 元。
      // 因此把除不盡的餘數放進 fee —— 成本模型本來就是 股數×單價＋費用，
      // 這樣總成本能精確還原。
      const totalCents = Math.round(totalCost * 100);
      priceCents = Math.floor(totalCents / n);
      feeCents = totalCents - priceCents * n;
      costUnknown = false;
    }

    trades.push({
      date,
      symbol: row.symbol,
      name: row.name ?? '',
      action: 'opening',
      // 金額一律以「分」為單位的整數儲存
      shares: n,
      price: priceCents,
      fee: feeCents,
      costUnknown,
    });

    if (Number.isFinite(price) && price > 0) {
      quotes.push({ symbol: row.symbol, close: Math.round(price * 100) });
    }
  }

  return { trades, quotes, errors };
}
