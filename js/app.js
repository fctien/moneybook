/**
 * 應用進入點：初始化資料、建立分頁、處理 Service Worker 與安裝提示。
 */

import { el, clear, toast, openSheet, $ } from './ui.js';
import * as store from './store.js';
import { createEntryView } from './views/entry.js';
import { createLedgerView } from './views/ledger.js';
import { createAssetsView } from './views/assets.js';
import { createReportView } from './views/report.js';
import { createSettingsView } from './views/settings.js';
import { openInstallHelp } from './views/installhelp.js';
import {
  isStandalone, detectPlatform, createInstallPromptController, shouldShowInstallBanner,
} from './lib/install.js';

export const APP_VERSION = '1.26.1';

const TABS = [
  { id: 'entry', label: '記帳', icon: '✏️' },
  { id: 'ledger', label: '明細', icon: '📋' },
  { id: 'assets', label: '資產', icon: '🏦' },
  { id: 'report', label: '報表', icon: '📊' },
  { id: 'settings', label: '設定', icon: '⚙️' },
];

const views = {};
let currentTab = 'entry';

/** 上次關掉「加到主畫面」提示列的時間 */
const INSTALL_BANNER_KEY = 'installBannerDismissedAt';

// 要在任何畫面建立前就開始聽，事件只發一次
const installer = createInstallPromptController();

async function main() {
  const root = $('#app');
  const loading = $('#boot');

  try {
    await store.init();
  } catch (err) {
    console.error(err);
    showFatalError(root, loading, err);
    return;
  }

  loading?.remove();
  // 這一版是「完整還原到 v1.18.0 版面」給使用者對照用的。
  // 診斷用的 safe-area 覆寫開關若還開著，看到的就不是 v1.18.0 了，
  // 因此啟動時一律歸零。要再試的話，進診斷畫面重新開啟即可。
  await store.setSafeTopOverride(false);
  await store.setSafeBottomOverride(false);
  store.applySafeAreaOverrides();

  views.entry = createEntryView({ onSaved: () => { /* 留在記帳頁，方便連續記帳 */ } });
  views.ledger = createLedgerView({
    onEdit: (tx) => {
      views.entry.loadTransaction(tx);
      switchTab('entry');
    },
  });
  views.assets = createAssetsView();
  views.report = createReportView();
  views.settings = createSettingsView({ appVersion: APP_VERSION, installer, openInstallHelp });

  const main = el('main.app__main', { id: 'main' });
  const tabbar = buildTabBar();

  // v1.25.0：使用者要對照 v1.17.0 的版面，而「加到主畫面」提示列是 v1.18.0
  // 才加的，那一版還不存在。掛上去就不是 v1.17.0 的版面了，所以這一版不掛。
  // 設定 → 加到主畫面 裡的說明與安裝按鈕不受影響，照常可用。
  const SHOW_INSTALL_BANNER = false;
  const banner = SHOW_INSTALL_BANNER ? buildInstallBanner() : null;
  root.append(main, ...(banner ? [banner] : []), tabbar);

  // 只有目前分頁掛在 DOM 上，切換時整個換掉。
  // 資料量小、DOM 也不大，這比維持五份隱藏 DOM 更省記憶體也更好推理。
  renderCurrentTab(main);

  // 任何資料變更都讓目前分頁重新整理；其他分頁在切換時才更新，
  // 避免在背景做無意義的重繪
  store.subscribe(() => views[currentTab]?.refresh?.());

  restoreFromHash();
  globalThis.addEventListener('hashchange', restoreFromHash);

  registerServiceWorker();
  maybeShowFirstRunGuide();
  startAutoQuoteUpdates();
  keepWindowPinned();
  watchViewportHeight();
}


/**
 * 記錄視窗高度的變化。
 *
 * 使用者說「剛更新完是滿版的，用一陣子就跑版」。若真是如此，
 * innerHeight 會在使用途中變小而且不再回來 —— 這是唯一能證實或推翻的證據，
 * 而它只發生在真實裝置上，電腦重現不了。
 *
 * 只記在記憶體與設定裡，不送出去任何地方。
 */
const VIEWPORT_LOG_KEY = 'viewportLog';

function watchViewportHeight() {
  const now = () => new Date().toTimeString().slice(0, 8);
  const log = store.getSetting(VIEWPORT_LOG_KEY, null) || {};

  const record = (why) => {
    const h = globalThis.innerHeight;
    log.last = h;
    log.lastAt = now();
    log.lastWhy = why;
    if (!log.max || h > log.max) { log.max = h; log.maxAt = now(); }
    if (!log.min || h < log.min) { log.min = h; log.minAt = now(); log.minWhy = why; }
    // silent：純粹是診斷資料，不需要因此重畫任何畫面
    store.setSetting(VIEWPORT_LOG_KEY, log, { silent: true }).catch(() => {});
  };

  record('啟動');
  globalThis.addEventListener('resize', () => record('resize'));
  globalThis.addEventListener('orientationchange', () => setTimeout(() => record('轉向'), 300));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(() => record('回到前景'), 300);
  });
}

/**
 * 把視窗釘在最上面。
 *
 * iOS 的鍵盤彈出時，系統會把「整個視窗」往上捲以露出輸入框。
 * 收起鍵盤後它不一定會捲回去 —— 於是整個 App 往上位移，
 * 底下露出一塊空白，看起來就像版面壞掉。
 * 每打一次字（金額、備註、搜尋）都可能發生一次，所以是「用久了才跑版」，
 * 一開始看起來好好的。
 *
 * 這個 App 所有的捲動都發生在 .app__main 裡面，視窗本身永遠不該被捲動。
 * 但也不能見到捲動就拉回去 —— 鍵盤開著的時候那個位移是必要的，
 * 硬拉回去會讓使用者看不到自己正在打字的欄位。
 * 所以只在「鍵盤收起來之後」才校正。
 */
function keepWindowPinned() {
  const pin = () => {
    if (globalThis.scrollY !== 0) globalThis.scrollTo(0, 0);
  };

  const isTyping = () => {
    const a = document.activeElement;
    return Boolean(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };

  const pinIfIdle = () => {
    // 延遲一下再看：focusout 當下焦點可能正要移到另一個輸入框
    setTimeout(() => { if (!isTyping()) pin(); }, 120);
  };

  globalThis.addEventListener('focusout', pinIfIdle);
  globalThis.addEventListener('orientationchange', () => setTimeout(pin, 250));

  // 鍵盤收起來時 visualViewport 會變回整個視窗高度，那是最可靠的收尾時機
  globalThis.visualViewport?.addEventListener('resize', () => {
    if (globalThis.visualViewport.height >= globalThis.innerHeight - 8) pinIfIdle();
  });

  // 回到前景時也校正一次：切出去再切回來是另一個常見的位移時機
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pinIfIdle();
  });
}

/**
 * 收盤後的自動更新。
 *
 * PWA 關著的時候不會執行任何程式 —— iOS Safari 沒有背景定期同步，
 * Android 的 Periodic Background Sync 也不保證排得到。
 * 所以這裡做的是「開啟或回到前景時補抓一次」，條件與次數的判斷都在 store 裡，
 * 沒同意、還沒收盤、今天抓過了，都會安靜地什麼都不做。
 */
function startAutoQuoteUpdates() {
  const run = async () => {
    try {
      const r = await store.maybeAutoUpdateQuotes();
      if (!r.ran || !r.updated) return;

      // 自動跑的結果用一句話帶過就好，不打斷使用者正在做的事。
      // 但有檔數沒更新到就得講 —— 總資產少了一塊卻不說最糟。
      const parts = [`已自動更新 ${r.updated} 檔股價`];
      if (r.snapshot) parts.push('並存下今日快照');
      toast(parts.join('，'), 'success', 3600);
      if (r.errors.length) {
        const { describeQuoteErrors } = await import('./lib/quotesource.js');
        toast(describeQuoteErrors(r.errors), 'error', 6000);
      }
    } catch (err) {
      // 自動更新失敗不該打擾使用者：他沒有按下任何東西。
      // 畫面上的「上次更新」日期自然會顯示資料變舊了。
      console.warn('自動更新股價失敗', err);
    }
  };

  run();

  // 手機把 App 放在背景一整天再切回來，也算是「今天第一次開啟」
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
}

/**
 * 「加到主畫面」提示列，夾在內容與分頁列之間。
 *
 * 放在設定頁裡的說明，沒點進設定的人永遠看不到 —— 而 iOS 會清掉
 * 七天沒開的網站資料，這不是體驗問題，是會不會掉資料的問題。
 * 所以要擺在一定看得到的地方，但也要能關掉：關掉後兩週內不再出現。
 *
 * 位置刻意在畫面最下方：iOS Safari 的分享按鈕就在我們分頁列的正下方，
 * 提示列裡的「往下找 ⬆︎」指的就是那裡。
 */
function buildInstallBanner() {
  const node = el('div.install-banner', { hidden: true });

  const render = () => {
    clear(node);
    const show = shouldShowInstallBanner({
      standalone: isStandalone(),
      platform: detectPlatform(),
      dismissedAt: store.getSetting(INSTALL_BANNER_KEY, null),
      now: Date.now(),
    });
    node.hidden = !show;
    if (!show) return;

    const native = installer.available();
    const platform = detectPlatform();
    // 三種情境三句話：能一鍵裝的講方便，iOS 講風險（會掉資料），Android 沒拿到事件時講路徑
    const message = native
      ? '一鍵安裝，之後從圖示開啟就像一般 App。'
      : platform === 'ios'
        ? '否則 iOS 可能在閒置七天後清掉你的帳目。'
        : '從 Chrome 選單安裝，之後從圖示開啟就像一般 App。';

    node.append(
      el('span.install-banner__icon', { text: '📲' }),
      el('div.install-banner__text', {}, [
        el('strong', { text: '加到主畫面' }),
        el('span', { text: message }),
      ]),
      el('button.btn.btn--primary.btn--sm', {
        type: 'button',
        onClick: async () => {
          if (!native) return openInstallHelp({ installer });
          const outcome = await installer.prompt();
          if (outcome === 'accepted') toast('已加到主畫面', 'success');
          else if (outcome === 'unavailable') openInstallHelp({ installer });
        },
      }, [native ? '安裝' : '怎麼做']),
      el('button.install-banner__close', {
        type: 'button',
        'aria-label': '暫時關閉',
        onClick: async () => {
          await store.setSetting(INSTALL_BANNER_KEY, Date.now(), { silent: true });
          render();
        },
      }, ['✕']),
    );
  };

  render();
  // 拿到 beforeinstallprompt 或安裝完成時，按鈕文字與顯示與否都會變
  installer.onChange(() => {
    if (installer.justInstalled()) toast('已加到主畫面，之後請從圖示開啟', 'success', 4000);
    render();
  });
  return node;
}

function buildTabBar() {
  const nav = el('nav.tabbar', { role: 'tablist' });
  for (const tab of TABS) {
    nav.append(el(`button.tabbar__item${currentTab === tab.id ? '.is-active' : ''}`, {
      type: 'button',
      role: 'tab',
      id: `tab-${tab.id}`,
      'aria-selected': String(currentTab === tab.id),
      onClick: () => switchTab(tab.id),
    }, [
      el('span.tabbar__icon', { text: tab.icon }),
      el('span.tabbar__label', { text: tab.label }),
    ]));
  }
  return nav;
}

function renderCurrentTab(mainEl) {
  const host = mainEl ?? $('#main');
  if (!host) return;
  clear(host);
  const view = views[currentTab];
  if (!view) return;
  host.append(view.node);
  view.refresh?.();
  host.scrollTop = 0;
}

async function switchTab(id) {
  if (id === currentTab) return;

  // 正在編輯既有交易時離開記帳頁，先問過使用者
  if (currentTab === 'entry' && views.entry?.isEditing?.()) {
    const ok = await views.entry.confirmLeaveEdit();
    if (!ok) return;
    views.entry.resetDraft();
  }

  currentTab = id;
  for (const btn of document.querySelectorAll('.tabbar__item')) {
    const active = btn.id === `tab-${id}`;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  renderCurrentTab();
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
}

/** 支援用網址列的 #ledger 直接開到某一頁，也讓瀏覽器返回鍵有作用 */
function restoreFromHash() {
  const id = location.hash.replace('#', '');
  if (TABS.some((t) => t.id === id) && id !== currentTab) switchTab(id);
}

function showFatalError(root, loading, err) {
  loading?.remove();
  clear(root);
  root.append(el('div.fatal', {}, [
    el('h1', { text: '無法啟動' }),
    el('p', { text: String(err?.message ?? err) }),
    el('p.hint', {
      text: '若使用無痕／私密瀏覽模式，瀏覽器會封鎖本機資料庫，請改用一般瀏覽模式開啟。',
    }),
    el('button.btn.btn--primary', { type: 'button', onClick: () => location.reload() }, ['重新載入']),
  ]));
}

/** 首次啟動時說明資料存在哪裡、為什麼一定要備份 */
async function maybeShowFirstRunGuide() {
  if (store.getSetting('firstRunDone', false)) return;

  openSheet('歡迎使用 MoneyBook', (body, close) => {
    body.append(
      el('p.sheet__message', { text: '這是一個完全離線的記帳工具，所有資料只存在這台裝置裡，不會上傳到任何伺服器。' }),
      el('ul.guide-list', {}, [
        el('li', { text: '「記帳」頁用數字鍵盤快速記錄收支，可以直接打 35+50 這種算式。' }),
        el('li', { text: '按「📷 掃電子發票」拍發票下方的兩個方塊條碼，品項與金額會自動帶入。' }),
        el('li', { text: '「資產」頁可手動填入股票、不動產、貸款的價值，算出淨資產。' }),
        el('li', {}, [
          el('span', { text: '請把本頁「加到主畫面」，否則 iOS 可能在閒置七天後清掉資料。' }),
          el('button.link-btn', {
            type: 'button',
            onClick: () => openInstallHelp({ installer }),
          }, ['看怎麼做']),
        ]),
        el('li', { text: '每個月到「設定」匯出一次備份檔，這是資料遺失時唯一的救援方式。' }),
      ]),
      el('div.sheet__actions', {}, [
        el('button.btn.btn--primary', {
          type: 'button',
          onClick: async () => {
            await store.setSetting('firstRunDone', true);
            close();
          },
        }, ['開始使用']),
      ]),
    );
  });
}

/** 有新版正在等著套用 */
let updateReady = false;

/**
 * 直接去伺服器讀 app.js 的版本號。
 *
 * 不靠 Service Worker 的狀態來判斷有沒有新版 —— sw.js 呼叫了 skipWaiting()，
 * 新的 worker 會直接跳過 waiting 進入啟用，於是 reg.waiting 幾乎永遠是 null。
 * 拿它當依據會一律回報「已經是最新版」，而使用者其實卡在舊版。
 * 比對版本號沒有這種模糊地帶：不一樣就是有新版。
 */
async function fetchLiveVersion() {
  try {
    // 網址一定要帶一個每次都不同的參數。
    // Service Worker 的 fetch 處理是 cache-first，而 caches.match() 比對的是完整網址 ——
    // 直接抓 './js/app.js' 會被自己的快取攔截、讀到舊檔，
    // 於是「檢查更新」永遠回報「已經是最新版」。fetch 的 cache: 'no-store'
    // 管的是 HTTP 快取，擋不住 Service Worker。
    const res = await fetch(`./js/app.js?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * 供設定頁的「檢查更新」使用。
 * @returns {Promise<{state:'latest'|'ready'|'failed'|'unsupported', live?:string}>}
 */
export async function checkForUpdate() {
  const live = await fetchLiveVersion();

  if (live && live !== APP_VERSION) return { state: 'ready', live };
  if (live === APP_VERSION) {
    // 版本號一樣就是真的最新，順手讓 SW 也去檢查一次，下次就不必再手動
    navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
    return { state: 'latest', live };
  }

  // 連不到伺服器（離線），只好退回看 SW 的狀態
  if (!('serviceWorker' in navigator)) return { state: 'unsupported' };
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { state: 'unsupported' };
  return { state: updateReady || reg.waiting || reg.installing ? 'ready' : 'failed' };
}

/**
 * 強制換上新版。
 *
 * 清掉 Service Worker 的快取再重新載入 —— 光是 reload 沒有用，
 * 舊的快取還在，載進來的仍然是舊程式碼。
 *
 * 只清程式檔的快取，**不會動到記帳資料**（那在 IndexedDB 裡，是另一回事）。
 */
export async function forceUpdate() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.update();
  } catch { /* 沒有 SW 也無所謂，照樣清快取重載 */ }

  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* 清不掉就算了，至少還會重新載入 */ }

  location.reload();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// 開啟時無法註冊 Service Worker，直接略過而不是拋錯
  if (location.protocol === 'file:') return;

  const register = () => {
    // updateViaCache: 'none' —— 不要用 HTTP 快取去檢查 sw.js。
    // GitHub Pages 給 sw.js 的 Cache-Control 是 max-age=600，
    // 若在十分鐘內重開好幾次，每次拿到的都是快取裡的舊 sw.js，
    // 於是「重開就會更新」這個直覺會失效，使用者怎麼試都停在舊版。
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            updateReady = true;
            toast('已下載新版本，回到主畫面再開啟即可生效', 'info', 5000);
          }
        });
      });

      // 瀏覽器只在「導航」時自動檢查新版。獨立 App 被留在背景好幾天都不會導航一次，
      // 於是使用者永遠停在舊版本 —— 這也是為什麼會出現「我看不到新版」。
      // 啟動時與每次回到前景都主動問一次。
      const poll = () => { reg.update().catch(() => {}); };
      poll();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') poll();
      });
    }).catch((err) => console.warn('Service Worker 註冊失敗', err));
  };

  // 新的 Service Worker 接手之後，畫面上跑的仍然是舊的程式碼，必須重新載入才會換。
  // 但不能說換就換 —— 使用者可能正在輸入。等下次回到前景這個自然的斷點再做。
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => { updateReady = true; });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !updateReady) return;
    const busy = document.querySelector('.sheet-backdrop')
      || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (!busy) location.reload();
  });

  // app.js 以 type="module" 載入（等同 defer），而且 main() 裡還 await 了 store.init()，
  // 走到這一行時 load 事件通常「早就觸發過」了 —— 此時才掛監聽器，它永遠不會被呼叫，
  // Service Worker 就註冊不上，離線快取與更新提示全部失效。
  // 因此先看 readyState：已經載入完成就直接註冊，否則才等 load。
  if (document.readyState === 'complete') register();
  else globalThis.addEventListener('load', register, { once: true });
}

main();
