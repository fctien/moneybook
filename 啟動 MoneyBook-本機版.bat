@echo off
rem ==========================================================
rem  MoneyBook 啟動器（本機版）
rem
rem  用本機的 Python 伺服器跑這個資料夾裡的程式碼。
rem  用途是測試改動，或是完全不連外網的情況。
rem
rem  注意：本機版與線上版的資料是分開的。
rem  瀏覽器依「網址」隔離資料，localhost 與 github.io 是兩個不同的網址，
rem  因此這裡看到的會是空白的帳本，不是資料不見了。
rem ==========================================================

chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=8811"
set "URL=http://localhost:%PORT%/"

rem ---- 確認 Python 在不在 ----
where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 Python，本機版需要它來啟動伺服器。
  echo   如果只是想用 MoneyBook 記帳，請改用「啟動 MoneyBook.bat」。
  echo.
  pause
  exit /b 1
)

rem ---- 找瀏覽器 ----
set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%P set "BROWSER=%%~P"

rem ---- 等伺服器起來再開瀏覽器 ----
rem 伺服器在這個視窗前景執行，所以開瀏覽器的動作要先排到背景去
if defined BROWSER (
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%BROWSER%' '--app=%URL%'"
) else (
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"
)

echo.
echo   MoneyBook 本機版：%URL%
echo   這個視窗就是伺服器。關掉它或按 Ctrl+C 即可停止。
echo.

python tools\serve.py %PORT%

endlocal
