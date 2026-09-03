/**
 * 電子發票二維條碼解析的自我測試。
 * 執行：node --test tests/invoice.test.js
 *
 * 測資依財政部「電子發票證明聯一維及二維條碼規格說明」v1.9 手動組出，
 * 涵蓋 UTF-8／Big5／Base64 三種中文編碼、左右條碼接續、以及各種殘缺輸入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseInvoiceQR, rocDateToISO, hexAmountToNumber, looksLikeInvoiceQR, ENCODING,
} from '../js/lib/invoice.js';

// ── 固定 77 碼表頭 ──────────────────────────────────────────
// 字軌(10) 日期(7) 隨機碼(4) 銷售額(8) 總計額(8) 買方(8) 賣方(8) 加密(24)
const HEADER =
  'AB12345678' + // 發票號碼
  '1150903' +    // 民國 115 年 9 月 3 日 → 2026-09-03
  '1234' +       // 隨機碼
  '000001DC' +   // 銷售額 476（未稅）
  '000001F4' +   // 總計額 500（含稅）
  '00000000' +   // 買方統編：一般消費者
  '12345678' +   // 賣方統編
  'abcdefghijklmnopqrstuvwx'; // 加密驗證資訊

test('表頭固定為 77 碼', () => {
  assert.equal(HEADER.length, 77);
});

// ── 單一欄位轉換 ────────────────────────────────────────────

test('rocDateToISO 民國年轉西元', () => {
  assert.equal(rocDateToISO('1150903'), '2026-09-03');
  assert.equal(rocDateToISO('1000101'), '2011-01-01');
  assert.equal(rocDateToISO('1131231'), '2024-12-31');
});

test('rocDateToISO 擋掉格式錯誤與不可能的月日', () => {
  assert.equal(rocDateToISO('115090'), null);   // 只有 6 碼
  assert.equal(rocDateToISO('1151303'), null);  // 13 月
  assert.equal(rocDateToISO('1150932'), null);  // 32 日
  assert.equal(rocDateToISO(''), null);
  assert.equal(rocDateToISO(null), null);
});

test('hexAmountToNumber 十六進位金額', () => {
  assert.equal(hexAmountToNumber('000001F4'), 500);
  assert.equal(hexAmountToNumber('000001DC'), 476);
  assert.equal(hexAmountToNumber('00000000'), 0);
  assert.equal(hexAmountToNumber('0000FFFF'), 65535);
});

test('hexAmountToNumber 擋掉長度不對或非十六進位', () => {
  assert.equal(hexAmountToNumber('1F4'), null);
  assert.equal(hexAmountToNumber('0000ZZZZ'), null);
  assert.equal(hexAmountToNumber(null), null);
});

// ── 表頭解析 ────────────────────────────────────────────────

test('只有表頭也能解析出日期與金額', () => {
  const r = parseInvoiceQR(HEADER);
  assert.equal(r.ok, true);
  assert.equal(r.value.invoiceNumber, 'AB12345678');
  assert.equal(r.value.date, '2026-09-03');
  assert.equal(r.value.totalAmount, 500);
  assert.equal(r.value.untaxedAmount, 476);
  assert.equal(r.value.sellerId, '12345678');
  assert.deepEqual(r.value.items, []);
});

test('買方統編為 00000000 時視為一般消費者', () => {
  const r = parseInvoiceQR(HEADER);
  assert.equal(r.value.buyerId, null);
});

test('銷售額全 0 代表未分離稅項，回傳 null 而非 0', () => {
  const h = HEADER.slice(0, 21) + '00000000' + HEADER.slice(29);
  const r = parseInvoiceQR(h);
  assert.equal(r.ok, true);
  assert.equal(r.value.untaxedAmount, null);
  assert.equal(r.value.totalAmount, 500, '總計額不受影響');
});

// ── 品項解析（UTF-8）────────────────────────────────────────

test('UTF-8 編碼解出品名、數量、單價', () => {
  const left = HEADER + ':**********:2:2:1:鮮奶茶:1:35:排骨便當:1:80';
  const r = parseInvoiceQR(left);
  assert.equal(r.ok, true);
  assert.equal(r.value.items.length, 2);
  assert.deepEqual(r.value.items[0], { name: '鮮奶茶', quantity: 1, unitPrice: 35 });
  assert.deepEqual(r.value.items[1], { name: '排骨便當', quantity: 1, unitPrice: 80 });
  assert.equal(r.value.itemsTruncated, false);
});

test('品目筆數少於總筆數時標記為未完整', () => {
  const left = HEADER + ':**********:1:5:1:鮮奶茶:1:35';
  const r = parseInvoiceQR(left);
  assert.equal(r.value.items.length, 1);
  assert.equal(r.value.itemsTruncated, true, '其餘明細只存在財政部平台');
});

test('補充說明不會被誤當成品項', () => {
  const left = HEADER + ':**********:1:1:1:鮮奶茶:1:35:謝謝惠顧';
  const r = parseInvoiceQR(left);
  assert.equal(r.value.items.length, 1);
  assert.equal(r.value.note, '謝謝惠顧');
});

// ── 左右二維條碼接續 ────────────────────────────────────────

test('右方條碼以冒號起始時直接接續品項', () => {
  const left = HEADER + ':**********:2:2:1:鮮奶茶:1:35';
  const right = '**:排骨便當:1:80';
  const r = parseInvoiceQR(left, right);
  assert.equal(r.value.items.length, 2);
  assert.equal(r.value.items[1].name, '排骨便當');
});

test('左方最後一段被切斷時，右方接回同一個欄位', () => {
  // 「排骨便當」被切成「排骨」+「便當」
  const left = HEADER + ':**********:2:2:1:鮮奶茶:1:35:排骨';
  const right = '**便當:1:80';
  const r = parseInvoiceQR(left, right);
  assert.equal(r.value.items.length, 2);
  assert.equal(r.value.items[1].name, '排骨便當', '被切斷的品名要接回來');
  assert.equal(r.value.items[1].unitPrice, 80);
});

test('左右拍反了會自動校正，不需要使用者重拍', () => {
  const left = HEADER + ':**********:2:2:1:鮮奶茶:1:35';
  const right = '**:排骨便當:1:80';
  const r = parseInvoiceQR(right, left); // 故意顛倒
  assert.equal(r.ok, true);
  assert.equal(r.value.invoiceNumber, 'AB12345678');
  assert.equal(r.value.items.length, 2);
});

test('只拍到右方條碼時給出明確錯誤', () => {
  const r = parseInvoiceQR('**:排骨便當:1:80');
  assert.equal(r.ok, false);
  assert.match(r.error, /左方/);
});

// ── Big5 編碼 ───────────────────────────────────────────────

test('Big5 編碼的品名要用原始位元組還原', () => {
  // ':**********:2:2:0:鮮奶茶:1:35:排骨便當:1:80' 的 Big5 位元組
  const tailBytes = [
    58, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 58, 50, 58, 50, 58, 48, 58,
    194, 65, 165, 164, 175, 249, 58, 49, 58, 51, 53, 58,
    177, 198, 176, 169, 171, 75, 183, 237, 58, 49, 58, 56, 48,
  ];
  const headerBytes = [...HEADER].map((c) => c.charCodeAt(0));
  const bytes = Uint8Array.from([...headerBytes, ...tailBytes]);

  const r = parseInvoiceQR(bytes);
  assert.equal(r.ok, true);
  assert.equal(r.value.items.length, 2);
  assert.equal(r.value.items[0].name, '鮮奶茶');
  assert.equal(r.value.items[1].name, '排骨便當');
  assert.equal(r.value.items[1].unitPrice, 80);
});

test('Big5 位元組不會讓表頭錯位', () => {
  const headerBytes = [...HEADER].map((c) => c.charCodeAt(0));
  const r = parseInvoiceQR(Uint8Array.from(headerBytes));
  assert.equal(r.value.invoiceNumber, 'AB12345678');
  assert.equal(r.value.totalAmount, 500);
});

test('UTF-8 品名以位元組傳入時要正確還原（jsQR 實際的回傳形態）', () => {
  // jsQR 回傳的是 binaryData 位元組，不是已解碼的字串。
  // 這裡曾經漏掉 UTF-8 的位元組解碼，導致品名變成「é®®å¥¶è¶」這種亂碼。
  const tail = ':**********:2:2:1:鮮奶茶:1:35:排骨便當:1:80';
  const bytes = Uint8Array.from([
    ...[...HEADER].map((c) => c.charCodeAt(0)),
    ...new TextEncoder().encode(tail),
  ]);

  const r = parseInvoiceQR(bytes);
  assert.equal(r.ok, true);
  assert.equal(r.value.items[0].name, '鮮奶茶');
  assert.equal(r.value.items[1].name, '排骨便當');
  assert.equal(r.value.items[1].unitPrice, 80);
});

test('UTF-8 位元組跨左右條碼接續也要正確', () => {
  const enc = new TextEncoder();
  const leftBytes = Uint8Array.from([
    ...[...HEADER].map((c) => c.charCodeAt(0)),
    ...enc.encode(':**********:2:2:1:鮮奶茶:1:35:排骨'),
  ]);
  const rightBytes = enc.encode('**便當:1:80');

  const r = parseInvoiceQR(leftBytes, rightBytes);
  assert.equal(r.ok, true);
  assert.equal(r.value.items[1].name, '排骨便當', '多位元組字元不能在接縫處壞掉');
});

// ── Base64 編碼 ─────────────────────────────────────────────

test('Base64 編碼參數為 2 時要先解碼', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const left = `${HEADER}:**********:1:1:2:${b64('鮮奶茶')}:1:35`;
  const r = parseInvoiceQR(left);
  assert.equal(r.ok, true);
  assert.equal(r.value.items[0].name, '鮮奶茶');
  assert.equal(r.value.items[0].unitPrice, 35);
});

// ── 錯誤輸入 ────────────────────────────────────────────────

test('內容太短時回報不完整', () => {
  const r = parseInvoiceQR('AB12345678');
  assert.equal(r.ok, false);
  assert.match(r.error, /不完整/);
});

test('發票號碼格式不符時明確拒絕', () => {
  const bad = '1234567890' + HEADER.slice(10);
  const r = parseInvoiceQR(bad);
  assert.equal(r.ok, false);
  assert.match(r.error, /發票號碼/);
});

test('日期不合法時明確拒絕', () => {
  const bad = HEADER.slice(0, 10) + '1151303' + HEADER.slice(17);
  const r = parseInvoiceQR(bad);
  assert.equal(r.ok, false);
  assert.match(r.error, /日期/);
});

test('空輸入不會拋例外', () => {
  assert.equal(parseInvoiceQR(null).ok, false);
  assert.equal(parseInvoiceQR('').ok, false);
});

// ── 快速判別 ────────────────────────────────────────────────

test('looksLikeInvoiceQR 認得左右兩種條碼', () => {
  assert.equal(looksLikeInvoiceQR(HEADER), true);
  assert.equal(looksLikeInvoiceQR('**:排骨便當:1:80'), true);
});

test('looksLikeInvoiceQR 略過其他 QR', () => {
  assert.equal(looksLikeInvoiceQR('https://www.example.com'), false);
  assert.equal(looksLikeInvoiceQR('/ABC+123'), false, '載具條碼不是發票條碼');
  assert.equal(looksLikeInvoiceQR(''), false);
  assert.equal(looksLikeInvoiceQR(null), false);
});

test('ENCODING 常數對應規格定義', () => {
  assert.equal(ENCODING.BIG5, '0');
  assert.equal(ENCODING.UTF8, '1');
  assert.equal(ENCODING.BASE64, '2');
});
