# MoneyBook — 單機個人記帳與資產管理 PWA

手機上單機運作的記帳工具。收支流水帳 + 淨資產追蹤，**資料完全存在你自己的裝置裡，不上傳任何伺服器**。

- 前端純靜態檔，沒有 npm、沒有建置流程、沒有 CDN 相依
- 加到主畫面後以全螢幕開啟，操作起來與原生 App 幾乎無異
- 完全離線可用（Service Worker 快取程式碼，IndexedDB 存資料）
- 同一份程式碼在 iPhone、Android、電腦瀏覽器都能跑

---

## ⚠️ 先讀這一段：備份是必需品

資料只存在這一台裝置的瀏覽器裡，**沒有任何雲端副本**。以下情況會讓紀錄全部消失，且無法救回：

- 手機遺失、損壞或重置
- 清除瀏覽器資料 / 網站資料
- 解除安裝後重裝

因此：

1. 安裝後**務必「加到主畫面」**。iOS Safari 會清除七天未使用的一般網站資料，但已加到主畫面的 PWA 不受此限制。
2. **每個月到「設定 → 匯出備份檔」存一次 JSON**，丟到 Google Drive、iCloud 或寄給自己。
3. App 會在超過 30 天未備份時，於設定頁顯示黃色警告。

還原方式：設定 → 從備份檔還原 → 選「合併匯入」（保留現有資料）或「取代全部資料」。

---

## 安裝到手機

先把這個資料夾放到一個手機連得到的網址（見下方「部署」），然後：

### iPhone / iPad
1. 用 **Safari** 開啟網址（Chrome 不行，iOS 只有 Safari 能安裝 PWA）
2. 點下方「分享」按鈕 <kbd>􀈂</kbd>
3. 選「加入主畫面」→「新增」

### Android
1. 用 **Chrome** 開啟網址
2. 網址列會跳出「安裝應用程式」，或點右上角 ⋮ →「安裝應用程式 / 加到主畫面」

安裝後從主畫面圖示開啟，即為無網址列的全螢幕模式。

---

## 部署

整個專案是純靜態檔，任何靜態空間都能跑。**必須用 https 或 localhost**，否則 Service Worker 不會註冊（App 仍可用，只是沒有離線快取）。

### 方式一：GitHub Pages（免費、最推薦，本專案採用）

已部署於 **https://fctien.github.io/moneybook/**

設定方式：repo 的 Settings → Pages → Source 選 **Deploy from a branch**，
分支 `main`、資料夾 `/ (root)`。之後每次 `git push` 到 `main`，
GitHub 會自動重新發佈，不需要 deploy workflow。

```bash
git push origin main
```

**倉庫必須設為 Public** —— Private repo 要用 GitHub Pages 需付費方案。
本 App 不含任何個人資料（帳目只存在瀏覽器的 IndexedDB，從未進版控），程式碼公開並無風險。

### 方式二：Netlify / Vercel
把整個資料夾拖進 Netlify Drop（https://app.netlify.com/drop）即可，不需帳號設定。

### 方式三：只在自家 Wi-Fi 內使用
```bash
python tools/serve.py
```
畫面會顯示區網網址（例如 `http://192.168.1.20:8000`），手機連同一個 Wi-Fi 即可開啟。
缺點是離開家裡就不能用，且非 https 環境不會安裝離線快取。

---

## 功能

| 分頁 | 內容 |
|------|------|
| **記帳** | 自製數字鍵盤，支援 `35+50*2` 這類算式；分類依使用頻率自動排序；支出／收入／轉帳三種類型 |
| **明細** | 按月瀏覽、關鍵字搜尋、點擊編輯或刪除 |
| **資產** | 帳戶餘額、淨資產總覽、儲存每日快照 |
| **報表** | 近 6 個月收支長條圖、分類佔比甜甜圈、淨資產趨勢線 |
| **設定** | 備份還原、CSV 匯出、分類管理、儲存空間狀態 |

### 兩種帳戶估值方式

| 方式 | 適用 | 行為 |
|------|------|------|
| **自動累算** | 現金、銀行、信用卡、電子支付 | 餘額 = 期初餘額 + 每筆記帳自動加減 |
| **手動估值** | 股票、基金、不動產、保單、貸款 | 餘額就是你填的數字，**不會出現在記帳頁** |

手動估值的帳戶刻意排除在記帳選單之外：股票市值沒辦法靠記帳推算，
而記在上面的收支並不會改變估值，那筆錢會憑空消失、對不起來。
這類項目請直接到「資產」頁更新金額。

負債請填**負數**（例如房貸剩 600 萬就填 `-6000000`），淨資產即為所有帳戶餘額直接相加。

---

## 開發與測試

```bash
# 單元測試（金額計算、日期、統計、備份序列化）
node --test tests/lib.test.js

# 檢查 sw.js 的 APP_SHELL 沒有漏檔或列到不存在的檔案
node tools/check_shell.mjs

# 啟動本機伺服器
python tools/serve.py

# 瀏覽器整合測試（IndexedDB 讀寫、備份還原全流程）
# 開啟 http://localhost:8000/test.html
```

前兩項會在每次推上 `main` 時由 GitHub Actions（`.github/workflows/ci.yml`）自動執行。

### 更新已安裝在手機上的 App

推上 `main` 後 GitHub Pages 會自動重新發佈，**一般情況下不需要做任何額外動作** ——
Service Worker 的 fetch 走 stale-while-revalidate：開啟時先用快取立刻顯示畫面，
同時在背景重抓一次更新快取，所以使用者下一次開啟就是新版。

只有這兩種情況需要手動戳一下版本：

```bash
python tools/bump_version.py          # 用目前 commit 的短 SHA
python tools/bump_version.py v1.1.0   # 或自己指定
```

1. 想讓使用者**這一次**就跳出「已下載新版本」的提示 ——
   瀏覽器只有在 `sw.js` 的位元組內容變了，才會判定 SW 有新版本並觸發 `updatefound`
2. 改動牽涉快取結構，需要把舊快取整包丟掉重建

不論哪一種，被清掉的都只是**程式碼快取**，IndexedDB 裡的帳目完全不受影響。

`test.html` 使用獨立的 `moneybook-selftest` 資料庫，**不會動到正式資料**，測完自動刪除。

重新產生 PWA 圖示（需要 Pillow）：
```bash
python tools/make_icons.py
```

### 檔案結構

```
index.html              進入點
manifest.webmanifest    PWA 設定
sw.js                   Service Worker（離線快取）
css/app.css             樣式（含深色模式與 iOS 安全區處理）
js/
  app.js                進入點、分頁切換、SW 註冊
  store.js              應用狀態（記憶體 + IndexedDB 同步）
  db.js                 IndexedDB 封裝
  ui.js                 共用元件、跨平台檔案輸出
  chart.js              Canvas 圖表（無外部套件）
  lib/                  純函式，可被 node --test 直接測試
    money.js            金額解析與格式化（以「分」為單位的整數運算）
    dateutil.js         日期處理（本地時區，不用 toISOString）
    stats.js            餘額、淨資產、分類與月份彙總
    schema.js           資料結構、預設值、驗證
    backup.js           備份序列化與 CSV 產生
  views/                五個分頁
tests/lib.test.js       單元測試
test.html               瀏覽器整合測試
```

### 幾個實作上的決定

- **金額用整數「分」儲存**，解析走純字串路徑，不做 `value * 100` 的浮點乘法 —— 否則 `19.995 * 100` 會得到 `1999.4999999999998`，誤差會日積月累到對不起來。
- **日期不用 `toISOString()`**，因為它會轉成 UTC，在台灣（UTC+8）會讓凌晨八點前記的帳掉到前一天。
- **轉帳不計入收支統計**，否則還卡費、轉存這類搬錢動作會把月報表灌水。
- **圖表自己用 Canvas 畫**，不引入 Chart.js —— 任何 CDN 相依都會讓 App 在飛航模式下變成一片空白。
- **繪圖排程 rAF + 計時器雙保險**：`requestAnimationFrame` 在分頁移到背景、部分 WebView、iOS PWA 從凍結恢復時可能完全不觸發，只靠它會讓圖表永遠畫不出來。
- **有交易紀錄的帳戶與分類不能刪除**，只能封存，避免產生指向不存在項目的孤兒資料。
