/**
 * 「加到主畫面」偵測邏輯的自我測試。
 * 執行：node --test tests/install.test.js
 *
 * 這裡的判斷會決定使用者看到哪一套安裝步驟。判錯的後果很具體：
 * 對一個用 Line 內建瀏覽器的人顯示「點分享按鈕」，他會照做、找不到、然後放棄。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectPlatform, isIOSNonSafari, installGuide } from '../js/lib/install.js';

// 真實的 User-Agent 字串
const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.108 Mobile/15E148 Safari/604.1',
  iphoneLine: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.9.0',
  iphoneFacebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]',
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

// ── 平台判斷 ────────────────────────────────────────────────

test('detectPlatform 認得 iPhone、Android、桌機', () => {
  assert.equal(detectPlatform(UA.iphoneSafari, 5), 'ios');
  assert.equal(detectPlatform(UA.androidChrome, 5), 'android');
  assert.equal(detectPlatform(UA.windowsChrome, 0), 'desktop');
});

test('iPadOS 偽裝成 Mac，要靠觸控點數分辨', () => {
  // 同一組 UA，差別只在有沒有觸控
  assert.equal(detectPlatform(UA.ipadOS, 5), 'ios', 'iPad 有多點觸控');
  assert.equal(detectPlatform(UA.macSafari, 0), 'desktop', 'Mac 沒有觸控');
});

// ── iOS 上是不是 Safari ─────────────────────────────────────

test('iOS Safari 本體判定為 Safari', () => {
  assert.equal(isIOSNonSafari(UA.iphoneSafari), false);
});

test('iOS 上的 Chrome 判定為非 Safari', () => {
  // CriOS 底層仍是 WebKit，但沒有「加入主畫面」
  assert.equal(isIOSNonSafari(UA.iphoneChrome), true);
});

test('Line 與 Facebook 的內建瀏覽器判定為非 Safari', () => {
  assert.equal(isIOSNonSafari(UA.iphoneLine), true);
  assert.equal(isIOSNonSafari(UA.iphoneFacebook), true);
});

test('非 iOS 平台一律回傳 false', () => {
  assert.equal(isIOSNonSafari(UA.androidChrome), false);
  assert.equal(isIOSNonSafari(UA.windowsChrome), false);
});

// ── 說明內容 ────────────────────────────────────────────────

test('iOS 的步驟提到 Safari、分享按鈕與加入主畫面', () => {
  const g = installGuide('ios', false);
  assert.match(g.title, /iPhone/);
  const all = g.steps.join('');
  assert.match(all, /Safari/);
  assert.match(all, /分享/);
  assert.match(all, /加入主畫面/);
});

test('iOS 一定會提醒私密瀏覽模式沒有這個選項', () => {
  const g = installGuide('ios', false);
  assert.ok(g.warnings.some((w) => w.includes('私密瀏覽')), '這是實際踩過的坑，不能漏');
});

test('用非 Safari 開啟時，警告要排在最前面', () => {
  const g = installGuide('ios', true);
  assert.match(g.warnings[0], /Safari/);
  assert.ok(g.warnings.length > installGuide('ios', false).warnings.length, '多一條專屬警告');
});

test('Android 的步驟講 Chrome 與安裝應用程式', () => {
  const g = installGuide('android', false);
  assert.equal(g.title, 'Android');
  assert.match(g.steps.join(''), /Chrome/);
  assert.match(g.steps.join(''), /安裝應用程式/);
});

test('桌機也有對應說明，不會回傳空的', () => {
  const g = installGuide('desktop', false);
  assert.equal(g.title, '電腦');
  assert.ok(g.steps.length > 0);
});

test('每個平台的步驟都不是空字串', () => {
  for (const p of ['ios', 'android', 'desktop']) {
    const g = installGuide(p, false);
    assert.ok(g.steps.every((s) => s.trim().length > 0), `${p} 有空步驟`);
    assert.ok(g.warnings.every((w) => w.trim().length > 0), `${p} 有空警告`);
  }
});
