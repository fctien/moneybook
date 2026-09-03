/**
 * Service Worker：讓 App 在完全沒有網路時仍可開啟。
 *
 * 策略：
 * - App 本身的檔案（HTML/CSS/JS/圖示）採 cache-first，開啟速度最快也能離線
 * - 更新版本時改 CACHE_VERSION，舊快取會在 activate 階段清掉
 *
 * 注意：使用者的記帳資料存在 IndexedDB，與這裡的快取完全無關。
 * 清除快取只會讓 App 重新下載程式碼，不會動到任何一筆帳。
 */

const CACHE_VERSION = 'moneybook-v1.1.2';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/store.js',
  './js/ui.js',
  './js/chart.js',
  './js/lib/money.js',
  './js/lib/dateutil.js',
  './js/lib/stats.js',
  './js/lib/schema.js',
  './js/lib/backup.js',
  './js/lib/install.js',
  './js/lib/invoice.js',
  './js/lib/qrscan.js',
  // jsQR 有 250 KB，是 app shell 裡最大的一支。仍然預先快取，
  // 否則第一次在離線狀態下按「掃發票」會直接失敗。
  './js/lib/jsqr.js',
  './js/views/entry.js',
  './js/views/ledger.js',
  './js/views/assets.js',
  './js/views/report.js',
  './js/views/settings.js',
  './js/views/scan.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // 個別 addAll 失敗會讓整包安裝失敗，因此逐一加入並容忍單檔失敗
      .then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 只處理自己網域的 GET，其餘一律放行給瀏覽器
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // 背景靜默更新，下次開啟就是新版
        fetch(request)
          .then((response) => {
            if (response.ok) caches.open(CACHE_VERSION).then((cache) => cache.put(request, response));
          })
          .catch(() => {});
        return cached;
      }

      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // 離線且沒有快取時，導覽請求至少回傳首頁，避免看到瀏覽器的錯誤頁
          if (request.mode === 'navigate') return caches.match('./index.html');
          return new Response('離線中，且此資源沒有快取', { status: 503, statusText: 'Offline' });
        });
    }),
  );
});
