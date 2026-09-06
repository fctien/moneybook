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

export const APP_VERSION = '1.16.0';

const TABS = [
  { id: 'entry', label: '記帳', icon: '✏️' },
  { id: 'ledger', label: '明細', icon: '📋' },
  { id: 'assets', label: '資產', icon: '🏦' },
  { id: 'report', label: '報表', icon: '📊' },
  { id: 'settings', label: '設定', icon: '⚙️' },
];

const views = {};
let currentTab = 'entry';

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

  views.entry = createEntryView({ onSaved: () => { /* 留在記帳頁，方便連續記帳 */ } });
  views.ledger = createLedgerView({
    onEdit: (tx) => {
      views.entry.loadTransaction(tx);
      switchTab('entry');
    },
  });
  views.assets = createAssetsView();
  views.report = createReportView();
  views.settings = createSettingsView({ appVersion: APP_VERSION });

  const main = el('main.app__main', { id: 'main' });
  const tabbar = buildTabBar();
  root.append(main, tabbar);

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
        el('li', { text: '請把本頁「加到主畫面」，否則 iOS 可能在閒置七天後清掉資料。' }),
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

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// 開啟時無法註冊 Service Worker，直接略過而不是拋錯
  if (location.protocol === 'file:') return;

  const register = () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            toast('已下載新版本，下次開啟時生效', 'info', 4000);
          }
        });
      });
    }).catch((err) => console.warn('Service Worker 註冊失敗', err));
  };

  // app.js 以 type="module" 載入（等同 defer），而且 main() 裡還 await 了 store.init()，
  // 走到這一行時 load 事件通常「早就觸發過」了 —— 此時才掛監聽器，它永遠不會被呼叫，
  // Service Worker 就註冊不上，離線快取與更新提示全部失效。
  // 因此先看 readyState：已經載入完成就直接註冊，否則才等 load。
  if (document.readyState === 'complete') register();
  else globalThis.addEventListener('load', register, { once: true });
}

main();
