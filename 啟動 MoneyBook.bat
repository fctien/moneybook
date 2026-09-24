@echo off
rem ==========================================================
rem  MoneyBook 啟動器（線上版）
rem
rem  開啟 GitHub Pages 上的正式版本，也就是手機上用的同一個網址。
rem  資料存在瀏覽器裡，離線也能用（Service Worker 已經把程式快取起來）。
rem
rem  用 Chrome/Edge 的 --app 模式開啟：沒有網址列與分頁，看起來就像一般程式。
rem ==========================================================

chcp 65001 >nul
setlocal

set "URL=https://fctien.github.io/moneybook/"

rem ---- 找瀏覽器。Chrome 優先，其次 Edge ----
set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do if not defined BROWSER if exist %%P set "BROWSER=%%~P"

if not defined BROWSER for %%P in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%P set "BROWSER=%%~P"

if defined BROWSER (
  echo 正在開啟 MoneyBook...
  start "" "%BROWSER%" "--app=%URL%"
) else (
  rem 找不到 Chrome 或 Edge 就用預設瀏覽器開，只是會多一條網址列
  echo 找不到 Chrome 或 Edge，改用預設瀏覽器開啟。
  start "" "%URL%"
)

endlocal
