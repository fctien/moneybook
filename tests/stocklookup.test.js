/**
 * 台股代號查表的自我測試。
 * 執行：node --test tests/stocklookup.test.js
 *
 * 這份查表的用途是「券商截圖只有名稱、沒有代號」時把代號補回來。
 * 最重要的性質不是命中率高，而是「不確定時不要亂猜」——
 * 填錯代號比留白危險得多：留白使用者一定會看到並補上，
 * 填錯了卻長得很正常，會一路錯到損益報表。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findBySymbol, findByName, nameToSymbol, search, tableSize,
} from '../js/lib/stocklookup.js';

test('資料表有載入且筆數合理', () => {
  const n = tableSize();
  assert.ok(n > 2500, `只有 ${n} 檔，資料表可能沒產生完整`);
});

// ── 代號查詢 ────────────────────────────────────────────────

test('findBySymbol 查得到常見個股與 ETF', () => {
  assert.equal(findBySymbol('2330').name, '台積電');
  assert.equal(findBySymbol('2317').name, '鴻海');
  assert.equal(findBySymbol('0050').name, '元大台灣50');
});

test('findBySymbol 帶回產業與市場別', () => {
  const e = findBySymbol('2330');
  assert.ok(e.industry.length > 0);
  assert.equal(e.market, 'twse');
});

test('findBySymbol 對不存在的代號回傳 null', () => {
  assert.equal(findBySymbol('9999999'), null);
  assert.equal(findBySymbol(''), null);
  assert.equal(findBySymbol(null), null);
});

// ── 名稱反查 ────────────────────────────────────────────────

test('完整名稱可以反查出代號', () => {
  assert.equal(nameToSymbol('台積電'), '2330');
  assert.equal(nameToSymbol('鴻海'), '2317');
  assert.equal(nameToSymbol('聯發科'), '2454');
});

test('名稱前後有空白也認得', () => {
  assert.equal(nameToSymbol('  台積電  '), '2330');
});

test('名稱後面帶括號代號也認得', () => {
  // 有些券商寫成「台積電(2330)」，正規化後應剩下名稱
  assert.equal(nameToSymbol('台積電(2330)'), '2330');
});

// ── 不確定時不要亂猜（這一組是重點）─────────────────────────

test('一個字的輸入一律不猜', () => {
  assert.equal(nameToSymbol('台'), null);
  assert.equal(nameToSymbol('中'), null);
});

test('會命中一堆 ETF 的泛用詞不自動填', () => {
  // 「台灣」「高股息」出現在幾十檔 ETF 名稱裡，唯一解不存在
  assert.equal(nameToSymbol('台灣'), null, '多重命中時必須留白');
  assert.equal(nameToSymbol('高股息'), null);
});

test('截圖裡的雜訊字不會被誤判成股票', () => {
  for (const noise of ['庫存查詢', '合計', '股票名稱', '未實現損益', '總計']) {
    assert.equal(nameToSymbol(noise), null, `「${noise}」不該被當成股票`);
  }
});

test('空值與非字串不會拋例外', () => {
  assert.equal(nameToSymbol(''), null);
  assert.equal(nameToSymbol(null), null);
  assert.equal(nameToSymbol(undefined), null);
  assert.equal(findByName(123), null);
});

// ── 關鍵字搜尋 ──────────────────────────────────────────────

test('search 用代號前綴找得到，且代號相符的排前面', () => {
  const r = search('2330');
  assert.ok(r.length > 0);
  assert.equal(r[0].symbol, '2330');
});

test('search 用名稱關鍵字找得到', () => {
  const r = search('台積');
  assert.ok(r.some((e) => e.symbol === '2330'), '打「台積」要找得到台積電');
});

test('search 對空字串回傳空陣列', () => {
  assert.deepEqual(search(''), []);
  assert.deepEqual(search(null), []);
});

test('search 會遵守筆數上限', () => {
  assert.ok(search('台', 5).length <= 5);
});
