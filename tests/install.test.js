/**
 * 「加到主畫面」偵測邏輯的自我測試。
 * 執行：node --test tests/install.test.js
 *
 * 這裡的判斷會決定使用者看到哪一套安裝步驟。判錯的後果很具體：
 * 對一個用 Line 內建瀏覽器的人顯示「點分享按鈕」，他會照做、找不到、然後放棄。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectPlatform, isIOSNonSafari, installGuide,
  createInstallPromptController, shouldShowInstallBanner, BANNER_SNOOZE_DAYS,
} from '../js/lib/install.js';

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

// ── 提示列顯示條件 ─────────────────────────────────────────

const DAY = 86_400_000;

test('已經是獨立 App 就不顯示提示列', () => {
  assert.equal(shouldShowInstallBanner({ standalone: true, platform: 'ios', dismissedAt: null, now: 0 }), false);
});

test('電腦不顯示提示列，安裝與否不影響資料安全', () => {
  assert.equal(shouldShowInstallBanner({ standalone: false, platform: 'desktop', dismissedAt: null, now: 0 }), false);
});

test('手機上沒關過就顯示', () => {
  assert.equal(shouldShowInstallBanner({ standalone: false, platform: 'ios', dismissedAt: null, now: 0 }), true);
  assert.equal(shouldShowInstallBanner({ standalone: false, platform: 'android', dismissedAt: null, now: 0 }), true);
});

test('關掉後兩週內不再出現，兩週後再提醒', () => {
  const closed = 1_000_000;
  const within = closed + (BANNER_SNOOZE_DAYS - 1) * DAY;
  const after = closed + BANNER_SNOOZE_DAYS * DAY;
  assert.equal(shouldShowInstallBanner({ standalone: false, platform: 'ios', dismissedAt: closed, now: within }), false);
  assert.equal(shouldShowInstallBanner({ standalone: false, platform: 'ios', dismissedAt: closed, now: after }), true);
});

// ── 一鍵安裝控制器 ─────────────────────────────────────────

/** 假的事件目標與假的 beforeinstallprompt 事件 */
function fakeTarget() {
  const handlers = {};
  return {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    fire: (type, ev = {}) => handlers[type]?.(ev),
  };
}

function fakePromptEvent(outcome) {
  return {
    prevented: false,
    prompted: 0,
    preventDefault() { this.prevented = true; },
    async prompt() { this.prompted += 1; },
    userChoice: Promise.resolve({ outcome }),
  };
}

test('沒收到事件時不能安裝，prompt 回 unavailable', async () => {
  const c = createInstallPromptController(fakeTarget(), undefined);
  assert.equal(c.available(), false);
  assert.equal(await c.prompt(), 'unavailable');
});

test('收到 beforeinstallprompt 後攔下預設提示並可安裝', async () => {
  const t = fakeTarget();
  const c = createInstallPromptController(t, undefined);
  const ev = fakePromptEvent('accepted');

  t.fire('beforeinstallprompt', ev);
  assert.equal(ev.prevented, true, '要擋掉瀏覽器自己的迷你提示列');
  assert.equal(c.available(), true);

  assert.equal(await c.prompt(), 'accepted');
  assert.equal(ev.prompted, 1);
  assert.equal(c.available(), false, '同一個事件只能 prompt 一次');
});

test('使用者按取消時事件留著，按鈕還能再用', async () => {
  const t = fakeTarget();
  const c = createInstallPromptController(t, undefined);
  t.fire('beforeinstallprompt', fakePromptEvent('dismissed'));

  assert.equal(await c.prompt(), 'dismissed');
  assert.equal(c.available(), true);
});

test('模組載入前攔到的事件會被接手', () => {
  const stash = { event: fakePromptEvent('accepted') };
  const c = createInstallPromptController(fakeTarget(), stash);
  assert.equal(c.available(), true);
});

test('appinstalled 之後清掉事件並標記已安裝', () => {
  const t = fakeTarget();
  const c = createInstallPromptController(t, undefined);
  let notified = 0;
  c.onChange(() => { notified += 1; });

  t.fire('beforeinstallprompt', fakePromptEvent('accepted'));
  t.fire('appinstalled');

  assert.equal(c.available(), false);
  assert.equal(c.justInstalled(), true);
  assert.equal(notified, 2);
});
