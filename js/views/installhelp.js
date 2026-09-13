/**
 * 「加到主畫面」的說明畫面。
 *
 * 從設定頁與提示列兩個地方都會開，所以獨立成一支。
 *
 * iOS 的步驟用畫的而不是純文字：使用者要在分享選單裡找的是一個圖示，
 * 文字描述「向上箭頭的方框」不如直接把那個方框畫出來。
 * 圖示是內嵌 SVG，離線也顯示得出來。
 */

import { el, openSheet, toast } from '../ui.js';
import { installGuide, detectPlatform, isIOSNonSafari } from '../lib/install.js';

/** iOS 的「分享」圖示：方框加向上箭頭 */
function shareIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ios-icon');
  svg.innerHTML = `
    <path d="M12 3v12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>
    <path d="M8 7l4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>
  `;
  return svg;
}

/** iOS 的「加入主畫面」圖示：方框加號 */
function addHomeIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ios-icon');
  svg.innerHTML = `
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke="currentColor" stroke-width="1.8" fill="none"/>
    <path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  `;
  return svg;
}

/** 模擬 iOS 分享選單裡那一列，讓使用者知道要找長什麼樣子的東西 */
function iosMenuRow(label, icon) {
  return el('div.ios-menu-row', {}, [
    el('span.ios-menu-row__label', { text: label }),
    icon,
  ]);
}

/**
 * 開啟說明畫面。
 * @param {object} [opts]
 * @param {object} [opts.installer] createInstallPromptController() 的結果；
 *   有它而且可用時，畫面最上方直接給一顆「立即安裝」
 * @param {string} [opts.platform] 覆寫平台偵測，在電腦上檢查 iOS 版畫面時用
 */
export function openInstallHelp({ installer, platform = detectPlatform() } = {}) {
  const guide = installGuide(platform, isIOSNonSafari());

  openSheet('加到主畫面', (body, close) => {
    body.append(el('p.sheet__message', {
      text: '加到主畫面之後，從圖示開啟就是全螢幕、沒有網址列，跟一般 App 一樣，'
        + '而且瀏覽器不會把資料當成一般網站清掉。',
    }));

    // Android／桌面 Chrome：能直接叫出系統對話框就不必看步驟
    if (installer?.available()) {
      body.append(el('div.sheet__actions', {}, [
        el('button.btn.btn--primary.btn--block', {
          type: 'button',
          onClick: async (e) => {
            e.target.disabled = true;
            const outcome = await installer.prompt();
            e.target.disabled = false;
            if (outcome === 'accepted') {
              toast('已加到主畫面', 'success');
              close();
            } else if (outcome === 'unavailable') {
              toast('這個瀏覽器不支援直接安裝，請照下方步驟操作', 'info', 4000);
            }
          },
        }, ['📲 立即安裝']),
      ]));
      body.append(el('p.hint.hint--center', { text: '按下去會跳出系統的安裝確認，再按一次「安裝」就完成。' }));
    }

    body.append(el('div.help-block', {}, [
      el('div.help-block__title', { text: guide.title }),
      el('ol.guide-list', {}, guide.steps.map((s) => el('li', { text: s }))),
    ]));

    // iOS：把要找的兩個圖示畫出來
    if (platform === 'ios') {
      body.append(el('div.help-block', {}, [
        el('div.help-block__title', { text: '要找的是這兩個' }),
        el('div.ios-menu', {}, [
          el('p.hint', { text: '① Safari 最下方中間：' }),
          el('div.ios-share-demo', {}, [shareIcon()]),
          el('p.hint', { text: '② 分享選單往上滑，第二段裡：' }),
          iosMenuRow('加入主畫面', addHomeIcon()),
        ]),
      ]));
    }

    if (guide.warnings.length) {
      body.append(el('div.help-block', {}, [
        el('div.help-block__title', { text: '找不到選項時' }),
        el('ul.guide-list', {}, guide.warnings.map((w) => el('li', { text: w }))),
      ]));
    }

    body.append(el('p.hint.hint--block', {
      text: '安裝後請立刻做一次「匯出備份檔」。加到主畫面降低了資料被清掉的機率，但手機遺失或重置一樣救不回來。',
    }));
  });
}
