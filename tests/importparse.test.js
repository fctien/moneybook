/**
 * 持股匯入解析的自我測試。
 * 執行：node --test tests/importparse.test.js
 *
 * 測資模擬三種真實來源：券商 App 截圖經 iOS 即時文字辨識後的文字、
 * 集保 PDF 選取複製的文字、以及券商網頁匯出的 CSV。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeText, detectDelimiter, parseCSV, toNumber, findSymbol,
  extractHoldings, suggestMapping, mergeBatches, combineDuplicates, rowsToTrades, FIELD,
} from '../js/lib/importparse.js';

// ── 數字解析 ────────────────────────────────────────────────

test('toNumber 處理千分位、貨幣符號與單位', () => {
  assert.equal(toNumber('1,234'), 1234);
  assert.equal(toNumber('1,234.56'), 1234.56);
  assert.equal(toNumber('＄1,234'), 1234);
  assert.equal(toNumber('1000股'), 1000);
  assert.equal(toNumber('-500'), -500);
});

test('toNumber 處理全形數字', () => {
  // iOS 即時文字辨識偶爾會產生全形字元
  assert.equal(toNumber('１２３４'), 1234);
  assert.equal(toNumber('１２．５'), 12.5);
});

test('toNumber 對非數字回傳 null，不回傳 0', () => {
  assert.equal(toNumber('台積電'), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber('N/A'), null, '0 會被誤讀成「這欄真的是零」');
});

// ── 代號辨識 ────────────────────────────────────────────────

test('findSymbol 認得一般代號與 ETF', () => {
  assert.equal(findSymbol(['2330', '台積電']), '2330');
  assert.equal(findSymbol(['0050', '元大台灣50']), '0050');
  assert.equal(findSymbol(['00878', '國泰永續高股息']), '00878');
});

test('findSymbol 認得括號寫法', () => {
  assert.equal(findSymbol(['台積電(2330)']), '2330');
  assert.equal(findSymbol(['台積電（2330）']), '2330', '全形括號也要認得');
});

test('findSymbol 不會把四位數的股數當成代號', () => {
  // 「1,000」有千分位，一定是數量而不是代號
  assert.equal(findSymbol(['2330', '台積電', '1,000', '600.00']), '2330');
  assert.equal(findSymbol(['台積電', '1,000']), null, '沒有代號就該回傳 null');
});

// ── CSV ─────────────────────────────────────────────────────

test('detectDelimiter 認得逗號與 Tab', () => {
  assert.equal(detectDelimiter('a,b,c'), ',');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
});

test('parseCSV 正確處理引號內的逗號', () => {
  const rows = parseCSV('代號,名稱,股數\n2330,"台積電,普通股",1000');
  assert.deepEqual(rows[1], ['2330', '台積電,普通股', '1000']);
});

test('parseCSV 處理跳脫的雙引號', () => {
  const rows = parseCSV('a,b\n1,"他說""你好"""');
  assert.equal(rows[1][1], '他說"你好"');
});

test('parseCSV 略過空白列', () => {
  const rows = parseCSV('a,b\n\n1,2\n\n');
  assert.equal(rows.length, 2);
});

// ── 編碼 ────────────────────────────────────────────────────

test('decodeText 認得 UTF-8 BOM', () => {
  const body = new TextEncoder().encode('代號,名稱');
  const withBom = Uint8Array.from([0xEF, 0xBB, 0xBF, ...body]);
  assert.equal(decodeText(withBom), '代號,名稱');
});

test('decodeText 在 UTF-8 解不出來時改用 Big5', () => {
  // 「台積電」的 Big5 位元組
  const big5 = Uint8Array.from([0xA5, 0x78, 0xBF, 0x6E, 0xB9, 0x71]);
  const out = decodeText(big5);
  assert.equal(out, '台積電', '券商匯出的 CSV 十之八九是 Big5');
});

test('decodeText 對純 UTF-8 不會誤判', () => {
  const bytes = new TextEncoder().encode('台積電 2330');
  assert.equal(decodeText(bytes), '台積電 2330');
});

// ── 貼上文字：券商 App 截圖 ─────────────────────────────────

test('單行排列的庫存文字', () => {
  const text = [
    '2330 台積電 1,000 600.00 800.00',
    '2317 鴻海 2,000 105.50 247.50',
  ].join('\n');

  const { rows } = extractHoldings(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, '2330');
  assert.equal(rows[0].name, '台積電');
  assert.deepEqual(rows[0].numbers, [1000, 600, 800]);
  assert.equal(rows[1].symbol, '2317');
});

test('代號與數字分成兩行時要接起來', () => {
  // 券商 App 截圖經文字辨識後最常見的斷行方式
  const text = [
    '台積電(2330)',
    '1,000    600.00    800.00',
    '鴻海(2317)',
    '2,000    105.50    247.50',
  ].join('\n');

  const { rows } = extractHoldings(text);
  assert.equal(rows.length, 2, '兩筆持股不能被拆成四列');
  assert.deepEqual(rows[0].numbers, [1000, 600, 800]);
  assert.deepEqual(rows[1].numbers, [2000, 105.5, 247.5]);
});

test('標題列與雜訊會被略過', () => {
  const text = [
    '庫存查詢',
    '股票名稱  股數  成本  現價',
    '2330 台積電 1,000 600.00 800.00',
    '合計',
  ].join('\n');

  const { rows, skipped } = extractHoldings(text);
  assert.equal(rows.length, 1, '只有含代號的那一列算持股');
  assert.ok(skipped >= 2);
});

test('CSV 內容也走同一套抽取', () => {
  const csv = '代號,名稱,股數,成本,現價\n2330,台積電,1000,600,800\n0050,元大台灣50,500,140.5,190';
  const { rows } = extractHoldings(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].symbol, '0050');
  assert.deepEqual(rows[1].numbers, [500, 140.5, 190]);
});

test('空輸入不會拋例外', () => {
  assert.deepEqual(extractHoldings('').rows, []);
  assert.deepEqual(extractHoldings(null).rows, []);
});

// ── 只有名稱、沒有代號 ──────────────────────────────────────

// 假的查表，避免這組測試相依於真實的 3000 檔資料
const LOOKUP = (name) => ({
  台積電: '2330', 鴻海: '2317', 元大台灣50: '0050',
}[String(name).trim()] ?? null);

test('只有名稱時用查表補上代號', () => {
  const text = `台積電 1,000 600.00 800.00
鴻海 2,000 105.50 247.50`;
  const { rows } = extractHoldings(text, { lookup: LOOKUP });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, '2330');
  assert.equal(rows[0].resolvedBy, 'name', '要標記是靠名稱推出來的，讓畫面能提醒使用者確認');
  assert.deepEqual(rows[0].numbers, [1000, 600, 800]);
});

test('沒有提供查表時，只有名稱的列照舊略過', () => {
  const { rows } = extractHoldings('台積電 1,000 600.00');
  assert.equal(rows.length, 0, '沒有查表就無從得知是哪一檔');
});

test('有代號時不會被查表覆蓋，且標記為 code', () => {
  const { rows } = extractHoldings('2330 台積電 1,000 600.00', { lookup: LOOKUP });
  assert.equal(rows[0].symbol, '2330');
  assert.equal(rows[0].resolvedBy, 'code');
});

test('查不到的名稱會列進 unresolved，而不是無聲消失', () => {
  // 使用者要能分辨「沒讀到這一列」與「讀到了但認不出是哪一檔」
  const text = `台積電 1,000 600.00
未知證券 500 100.00`;
  const { rows, unresolved } = extractHoldings(text, { lookup: LOOKUP });
  assert.equal(rows.length, 1);
  assert.deepEqual(unresolved, ['未知證券']);
});

test('沒有數字的雜訊列不會被當成未解析的股票', () => {
  const text = `庫存查詢
股票名稱 股數 成本
台積電 1,000 600.00`;
  const { rows, unresolved } = extractHoldings(text, { lookup: LOOKUP });
  assert.equal(rows.length, 1);
  assert.deepEqual(unresolved, [], '純標題列沒有數字，不該被當成認不出的股票');
});

test('名稱與數字分成兩行，且沒有代號', () => {
  const text = `台積電
1,000    600.00    800.00
鴻海
2,000    105.50    247.50`;
  const { rows } = extractHoldings(text, { lookup: LOOKUP });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, '2330');
  assert.deepEqual(rows[0].numbers, [1000, 600, 800]);
  assert.equal(rows[1].symbol, '2317');
  assert.deepEqual(rows[1].numbers, [2000, 105.5, 247.5]);
});

test('連續兩個只有名稱的列不會被併成一筆', () => {
  // 下一行若本身就是另一檔股票，就不能拿來當這一筆的數字
  const text = `台積電
鴻海 2,000 105.50`;
  const { rows } = extractHoldings(text, { lookup: LOOKUP });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].numbers, [], '台積電沒有數字就該是空的');
  assert.equal(rows[1].symbol, '2317');
  assert.deepEqual(rows[1].numbers, [2000, 105.5]);
});

test('名稱單獨一行、數字在下一行且查不到時，也要列進 unresolved', () => {
  // 這是券商截圖最常見的排版；先前只看「同一行有沒有數字」會讓它無聲消失
  const text = `台積電
1,000  600.00
某某未上市
300  50.00`;
  const { rows, unresolved } = extractHoldings(text, { lookup: LOOKUP });
  assert.equal(rows.length, 1);
  assert.deepEqual(unresolved, ['某某未上市']);
});

test('標題列即使下一行是股票，也不會被當成認不出的股票', () => {
  const text = `庫存明細
台積電
1,000  600.00`;
  const { rows, unresolved } = extractHoldings(text, { lookup: LOOKUP });
  assert.equal(rows.length, 1);
  assert.deepEqual(unresolved, [], '「庫存明細」的下一行不是純數字，不算資料列');
});

// ── 欄位建議 ────────────────────────────────────────────────

test('suggestMapping 把最大的整數欄猜成股數', () => {
  const { rows } = extractHoldings('2330 台積電 1,000 600.00 800.00\n2317 鴻海 2,000 105.50 247.50');
  const m = suggestMapping(rows);
  assert.equal(m[0], FIELD.SHARES, '股數動輒上千，單價通常只有兩三位數');
  assert.equal(m[1], FIELD.AVG_COST);
  assert.equal(m[2], FIELD.PRICE);
});

test('suggestMapping 對只有兩欄的情況也能運作', () => {
  const { rows } = extractHoldings('2330 台積電 1,000 600.00');
  const m = suggestMapping(rows);
  assert.equal(m[0], FIELD.SHARES);
  assert.equal(m[1], FIELD.AVG_COST);
});

test('suggestMapping 對空資料回傳空陣列', () => {
  assert.deepEqual(suggestMapping([]), []);
});

// ── 多頁合併 ────────────────────────────────────────────────

test('多頁貼上會合併成一份清單', () => {
  const p1 = extractHoldings('2330 台積電 1,000 600 800').rows;
  const p2 = extractHoldings('2317 鴻海 2,000 105.5 247.5').rows;
  const { rows, duplicates } = mergeBatches([p1, p2]);
  assert.equal(rows.length, 2);
  assert.deepEqual(duplicates, []);
});

test('同一頁貼兩次不會讓股數變成兩倍', () => {
  // 這是最常見的誤操作，自動相加會讓數字憑空翻倍且很難察覺
  const page = extractHoldings('2330 台積電 1,000 600 800').rows;
  const { rows, duplicates } = mergeBatches([page, page]);
  assert.equal(rows.length, 1, '重複的要合併成一筆');
  assert.deepEqual(duplicates, ['2330'], '但要標記出來讓使用者知道');
  assert.deepEqual(rows[0].numbers, [1000, 600, 800]);
});

test('mergeBatches 對空輸入安全', () => {
  assert.deepEqual(mergeBatches().rows, []);
  assert.deepEqual(mergeBatches([[], null]).rows, []);
});

// ── 重複合併 ────────────────────────────────────────────────

const M3 = [FIELD.SHARES, FIELD.AVG_COST, FIELD.PRICE];

test('同一檔分散在兩家券商時，股數相加、成本走加權平均', () => {
  // 1000 股 @600 與 100 股 @900 合起來不是 750（簡單平均），
  // 而是 (1000*600 + 100*900) / 1100 = 627.27
  const rows = [
    { symbol: '2330', name: '台積電', numbers: [1000, 600, 800] },
    { symbol: '2330', name: '台積電', numbers: [100, 900, 800] },
  ];
  const out = combineDuplicates(rows, M3);
  assert.equal(out.length, 1);
  assert.equal(out[0].shares, 1100);
  assert.ok(Math.abs(out[0].avgCost - 627.2727272727273) < 1e-9, '簡單平均會讓成本高估');
  assert.equal(out[0].mergedFrom, 2);
});

test('合併時市價取最後看到的那一筆', () => {
  const rows = [
    { symbol: '2330', name: '', numbers: [1000, 600, 800] },
    { symbol: '2330', name: '', numbers: [100, 600, 810] },
  ];
  const out = combineDuplicates(rows, M3);
  assert.equal(out[0].price, 810);
});

test('不同代號不會被合併', () => {
  const rows = [
    { symbol: '2330', name: '', numbers: [1000, 600] },
    { symbol: '2317', name: '', numbers: [2000, 100] },
  ];
  assert.equal(combineDuplicates(rows, [FIELD.SHARES, FIELD.AVG_COST]).length, 2);
});

test('合併結果可直接餵給 rowsToTrades', () => {
  const rows = [
    { symbol: '2330', name: '台積電', numbers: [1000, 600, 800] },
    { symbol: '2330', name: '台積電', numbers: [100, 900, 800] },
  ];
  const merged = combineDuplicates(rows, M3);
  const out = rowsToTrades(merged, M3, '2026-09-06');
  assert.equal(out.trades.length, 1);
  assert.equal(out.trades[0].shares, 1100);
  assert.equal(out.trades[0].price, 62727, '加權平均成本轉成分並四捨五入');
});

test('combineDuplicates 對空輸入安全', () => {
  assert.deepEqual(combineDuplicates(), []);
  assert.deepEqual(combineDuplicates([], []), []);
});

// ── 轉成交易 ────────────────────────────────────────────────

const MAPPING = [FIELD.SHARES, FIELD.AVG_COST, FIELD.PRICE];

test('rowsToTrades 產生期初交易與報價，金額轉為分', () => {
  const { rows } = extractHoldings('2330 台積電 1,000 600.00 800.00');
  const out = rowsToTrades(rows, MAPPING, '2026-09-06');

  assert.equal(out.trades.length, 1);
  assert.deepEqual(out.trades[0], {
    date: '2026-09-06', symbol: '2330', name: '台積電',
    action: 'opening', shares: 1000, price: 60000, fee: 0, costUnknown: false,
  });
  assert.deepEqual(out.quotes, [{ symbol: '2330', close: 80000 }]);
  assert.deepEqual(out.errors, []);
});

test('沒有現價欄位時不產生報價，但交易照樣建立', () => {
  const { rows } = extractHoldings('2330 台積電 1,000 600.00');
  const out = rowsToTrades(rows, [FIELD.SHARES, FIELD.AVG_COST], '2026-09-06');
  assert.equal(out.trades.length, 1);
  assert.deepEqual(out.quotes, []);
});

test('股數不正確的列會被擋下並回報，不會靜默寫入', () => {
  const rows = [{ symbol: '2330', name: '台積電', numbers: [0, 600] }];
  const out = rowsToTrades(rows, [FIELD.SHARES, FIELD.AVG_COST], '2026-09-06');
  assert.equal(out.trades.length, 0);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /股數/);
});

test('缺成本價不擋下來，標記為「成本待補」照樣建立持股', () => {
  // 券商的庫存畫面（未實現損益、即時庫存）都只有股數與現價，沒有成本。
  // 整批擋掉的話這個功能對真實資料就等於不能用。
  const rows = [{ symbol: '2330', name: '台積電', numbers: [1000, 800] }];
  const out = rowsToTrades(rows, [FIELD.SHARES, FIELD.PRICE], '2026-09-06');

  assert.equal(out.errors.length, 0);
  assert.equal(out.trades.length, 1);
  assert.equal(out.trades[0].shares, 1000);
  assert.equal(out.trades[0].price, 0);
  assert.equal(out.trades[0].costUnknown, true);
  assert.deepEqual(out.quotes, [{ symbol: '2330', close: 80000 }], '現價仍要寫進報價');
});

test('使用者在預覽表改過的值優先於自動解析', () => {
  const rows = [{ symbol: '2330', name: '台積電', numbers: [1000, 600, 800], shares: 1500, avgCost: 555 }];
  const out = rowsToTrades(rows, MAPPING, '2026-09-06');
  assert.equal(out.trades[0].shares, 1500);
  assert.equal(out.trades[0].price, 55500);
});

test('被標記略過的列不會匯入', () => {
  const rows = [
    { symbol: '2330', name: '台積電', numbers: [1000, 600] },
    { symbol: '2317', name: '鴻海', numbers: [2000, 105], skip: true },
  ];
  const out = rowsToTrades(rows, [FIELD.SHARES, FIELD.AVG_COST], '2026-09-06');
  assert.equal(out.trades.length, 1);
  assert.equal(out.trades[0].symbol, '2330');
});

test('小數成本轉分時正確四捨五入', () => {
  const rows = [{ symbol: '2330', name: '', numbers: [1000, 105.55] }];
  const out = rowsToTrades(rows, [FIELD.SHARES, FIELD.AVG_COST], '2026-09-06');
  assert.equal(out.trades[0].price, 10555);
});
