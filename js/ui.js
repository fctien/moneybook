/**
 * UI 共用元件：DOM 輔助、提示訊息、底部彈出面板、確認對話框、檔案輸出。
 *
 * 檔案輸出是這個模組最麻煩的部分，因為 iOS 與 Android 行為不同：
 * iOS 在「加到主畫面」的 standalone 模式下，<a download> 常常沒有反應，
 * 必須改用 Web Share API 才能把備份檔交給「檔案」App 或其他 App。
 * 因此這裡採用三段式退場機制，確保任何情況下使用者都拿得到備份。
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * 建立元素。
 * @param {string} tag 支援 'div.card.is-active' 這種簡寫
 * @param {object} [props] class / text / html / dataset / 事件（onClick）/ 其他屬性
 * @param {Array} [children]
 */
export function el(tag, props = {}, children = []) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 輕微震動回饋，讓按鍵有實體感（iOS Safari 不支援時自動略過） */
export function haptic(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* 不支援就算了，不影響功能 */
  }
}

// ------------------------------------------------------------------ toast

let toastTimer = null;

export function toast(message, type = 'info', duration = 2400) {
  let host = $('#toast-host');
  if (!host) {
    host = el('div', { id: 'toast-host', class: 'toast-host' });
    document.body.append(host);
  }
  clear(host);
  host.append(el(`div.toast.toast--${type}`, { text: message }));
  host.classList.add('is-visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('is-visible'), duration);
}

// ------------------------------------------------------------------ sheet

/**
 * 底部彈出面板（手機上比置中彈窗好按，拇指容易搆到）。
 * @returns {{close: Function, body: HTMLElement}}
 */
export function openSheet(title, buildBody, { onClose } = {}) {
  const existing = $('.sheet-backdrop');
  if (existing) existing.remove();

  const body = el('div.sheet__body');
  const backdrop = el('div.sheet-backdrop');
  const sheet = el('div.sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });

  const close = () => {
    backdrop.classList.remove('is-open');
    setTimeout(() => {
      backdrop.remove();
      document.body.classList.remove('is-locked');
      onClose?.();
    }, 180);
  };

  sheet.append(
    el('div.sheet__handle'),
    el('div.sheet__header', {}, [
      el('h2.sheet__title', { text: title }),
      el('button.icon-btn', { type: 'button', 'aria-label': '關閉', onClick: close }, ['✕']),
    ]),
    body,
  );

  backdrop.append(sheet);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  document.body.append(backdrop);
  document.body.classList.add('is-locked');
  // 用計時器而非 requestAnimationFrame 觸發滑入動畫：只是要讓瀏覽器先套用初始樣式，
  // 不需要對齊影格。而 rAF 在部分情境下不會觸發，那會讓面板永遠停在畫面外，
  // 使用者按了按鈕卻什麼都沒發生。
  setTimeout(() => backdrop.classList.add('is-open'), 16);

  buildBody?.(body, close);
  return { close, body };
}

/**
 * 確認對話框。回傳 Promise<boolean>。
 * 不用 window.confirm，因為它在 iOS standalone PWA 裡樣式突兀且會被部分瀏覽器封鎖。
 */
export function confirmDialog(title, message, { confirmText = '確定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, close) => {
      if (settled) return;
      settled = true;
      resolve(value);
      close();
    };

    openSheet(title, (body, close) => {
      body.append(
        el('p.sheet__message', { text: message }),
        el('div.sheet__actions', {}, [
          el('button.btn.btn--ghost', { type: 'button', onClick: () => finish(false, close) }, [cancelText]),
          el(`button.btn.${danger ? 'btn--danger' : 'btn--primary'}`, {
            type: 'button',
            onClick: () => finish(true, close),
          }, [confirmText]),
        ]),
      );
    }, { onClose: () => finish(false, () => {}) });
  });
}

// ------------------------------------------------------------------ 檔案輸出

/**
 * 把文字內容交給使用者保存。
 * 依序嘗試：Web Share（iOS 必要）→ 下載連結（Android / 桌機）→ 回報失敗由呼叫端顯示文字備援。
 * @returns {Promise<'shared'|'downloaded'|'cancelled'|'failed'>}
 *          cancelled 與 failed 分開回報，因為使用者主動取消分享時
 *          不該跳出「存檔失敗」把人嚇一跳。
 */
export async function saveTextFile(filename, text, mimeType = 'application/json') {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });

  // iOS 的 standalone PWA 只有這條路走得通
  try {
    const file = new File([blob], filename, { type: mimeType });
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled';
    // 其他錯誤（例如不支援分享檔案）就往下走下載那條路
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}

export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的備援 */
  }
  try {
    const ta = el('textarea', { style: { position: 'fixed', opacity: '0', top: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 讀取使用者選擇的檔案內容 */
export function pickTextFile(accept = '.json,application/json') {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      try {
        resolve({ name: file.name, text: await file.text() });
      } catch {
        resolve(null);
      }
    });
    document.body.append(input);
    input.click();
  });
}

/** 位元組數轉可讀字串 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
