/**
 * 「加到主畫面」的偵測與說明。
 *
 * 為什麼值得單獨做一支：
 * 這個 App 的資料只存在瀏覽器裡，而 iOS Safari 會清除「七天未使用」的一般網站資料。
 * 已加到主畫面的 PWA 不受此限制 —— 也就是說，沒安裝的使用者可能在某天打開後
 * 發現帳目全部不見。這不是體驗好壞的問題，是會不會掉資料的問題。
 *
 * 實際踩過的坑（都寫進說明裡）：
 * - iOS 只有 Safari 能安裝，Chrome、Line 或郵件裡點開的 App 內建瀏覽器都不行
 * - 私密瀏覽模式下「加入主畫面」這個選項根本不會出現
 * - 分享選單分兩段，選項在第二段，要往上滑才看得到
 * - 選項可能被使用者關掉，要到「編輯動作」重新加回來
 */

/** 是否已經以獨立 App 的形式開啟（已加到主畫面） */
export function isStandalone() {
  // iOS 用的是非標準的 navigator.standalone，其他平台看 display-mode
  if (globalThis.navigator?.standalone === true) return true;
  return globalThis.matchMedia?.('(display-mode: standalone)')?.matches === true
    || globalThis.matchMedia?.('(display-mode: fullscreen)')?.matches === true;
}

/**
 * 粗略判斷平台，只用來決定顯示哪一套步驟。
 * 觸控點數獨立成參數，否則在 Node 裡沒有 navigator.maxTouchPoints 可測。
 */
export function detectPlatform(
  ua = globalThis.navigator?.userAgent ?? '',
  maxTouchPoints = globalThis.navigator?.maxTouchPoints ?? 0,
) {
  // iPadOS 13 之後的 UA 偽裝成 Mac，靠觸控點數才分得出來
  const iPadOS = /Macintosh/.test(ua) && maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPadOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/**
 * iOS 上是否為「非 Safari」的瀏覽器。
 * iOS 底下全部都是 WebKit，但只有 Safari 本體能安裝到主畫面，
 * 用 Chrome 或 App 內建瀏覽器的人怎麼找都找不到那個選項。
 */
export function isIOSNonSafari(ua = globalThis.navigator?.userAgent ?? '') {
  if (detectPlatform(ua) !== 'ios') return false;
  // CriOS=Chrome、FxiOS=Firefox、EdgiOS=Edge、OPT/OPiOS=Opera
  if (/CriOS|FxiOS|EdgiOS|OPT\/|OPiOS/.test(ua)) return true;
  // Line、Facebook、Instagram 等 App 的內建瀏覽器
  if (/Line\/|FBAN|FBAV|Instagram|MicroMessenger/.test(ua)) return true;
  // Safari 本體的 UA 一定同時有 Version/ 與 Safari/
  return !(/Version\/\d/.test(ua) && /Safari/.test(ua));
}

/**
 * 產生對應平台的安裝步驟。
 * 回傳純資料而不是 DOM，方便測試也方便別處重用。
 *
 * @returns {{title:string, steps:string[], warnings:string[]}}
 */
export function installGuide(platform = detectPlatform(), nonSafari = isIOSNonSafari()) {
  if (platform === 'ios') {
    return {
      title: 'iPhone／iPad',
      steps: [
        '用 Safari 開啟本頁（其他瀏覽器沒有這個功能）。',
        '點畫面最下方中間的「分享」按鈕，就是那個向上箭頭的方框。',
        '選單分成兩段，手指往上滑到第二段（「拷貝」「加入書籤」那一區）。',
        '找到「加入主畫面」，點它，再按右上角「新增」。',
      ],
      warnings: [
        nonSafari
          ? '偵測到您現在不是用 Safari 開啟。iOS 上只有 Safari 能加到主畫面 —— 若是從 Line 或郵件點連結進來的，請先選「在 Safari 中打開」。'
          : '',
        '私密瀏覽模式下不會出現「加入主畫面」，請改用一般模式。',
        '第二段選單若找不到，捲到最底點「編輯動作⋯」，把「加入主畫面」加回來。',
      ].filter(Boolean),
    };
  }

  if (platform === 'android') {
    return {
      title: 'Android',
      steps: [
        '用 Chrome 開啟本頁。',
        '網址列可能會直接跳出「安裝應用程式」，有的話點它就好。',
        '沒跳出來就點右上角「⋮」選單。',
        '選「安裝應用程式」或「加到主畫面」。',
      ],
      warnings: ['從 Line 或 FB 內建瀏覽器開啟時沒有這個選項，請先用 Chrome 開啟。'],
    };
  }

  return {
    title: '電腦',
    steps: [
      '用 Chrome 或 Edge 開啟本頁。',
      '網址列右側會出現一個安裝圖示（螢幕加向下箭頭），點它。',
      '或從瀏覽器選單選「安裝 MoneyBook」。',
    ],
    warnings: ['電腦上安裝與否影響不大，資料一樣存在瀏覽器裡。手機才是真的需要安裝。'],
  };
}
