# MoneyBook 專案規範

離線優先的個人記帳 PWA。純靜態檔，部署在 GitHub Pages。

- 本機資料夾 `MoneyBook`，線上網址全小寫 `moneybook` —— 大小寫不同會 404
- 線上：https://fctien.github.io/moneybook/
- 倉庫：https://github.com/fctien/moneybook

## 不可退讓的原則

1. **資料只存本機**（IndexedDB），不上傳伺服器。唯一的對外連線是股價自動更新，
   預設關閉、使用者同意後才啟用。
2. **絕不產生看起來正常但錯誤的數字。** 算不出來就回 `null` 並說明原因，
   不要用 0、不要用預設值、不要猜。缺一檔報價就不顯示總損益、不存快照。
3. **金額一律用「分」為單位的整數**儲存。中間計算可以是浮點，結果一定 round 回整數。
4. **部位由交易紀錄推算，不存第二份。** 存兩份遲早對不起來，且無法判斷哪份是對的。
5. **成本用加權平均法**（台灣券商標準）。這個不要改 —— 改了歷史損益全部變成另一組數字。

## 工作流程

- 改完跑 `node --test tests/*.test.js` 與 `node tools/check_shell.mjs` 再回報
- 新增程式檔必須列進 `sw.js` 的 `APP_SHELL`（check_shell.mjs 會擋）
- 改動要在 `sw.js` 的 `CACHE_VERSION` 與 `js/app.js` 的 `APP_VERSION` 同步升版
- 建構紀錄寫進 `docs/dev-log-*.html`，規劃寫進 `docs/plan-*.html`
- 外部資料來源一律**從瀏覽器實測 CORS**，`curl` 抓得到不算數
