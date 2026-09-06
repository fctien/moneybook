"""產生台股代號對照表 js/lib/twstocks.js。

執行：python tools/make_stocklist.py

用途：券商 App 的庫存畫面常常只顯示股票名稱而不顯示代號，
截圖辨識出來的文字因此找不到代號。有了這份對照表就能由名稱反查代號。

為什麼要「內建」而不是即時查詢：
1. 這份資料查詢時會把使用者持有哪些股票送到外部服務，牴觸本專案的隱私原則
2. 離線時也要能用
3. 代號與名稱是公開事實，變動很慢，內建一份完全足夠

資料來源為 FinMind 的 TaiwanStockInfo（彙整自證交所與櫃買中心的公開資料）。
新上市的股票不會自動出現在這份表裡 —— 這只是輔助，查不到時使用者仍可自行輸入代號。
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "js" / "lib" / "twstocks.js"
API = "https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo"

# 一般股 4 碼、ETF 5～6 碼，債券 ETF 結尾可能帶一個英文字母。
# 其餘長度異常的多半是指數或衍生商品，對記帳沒有意義。
CODE_RE = re.compile(r"^\d{4,6}[A-Z]?$")

MARKETS = ["twse", "tpex", "emerging"]


def fetch(path: Path | None) -> list[dict]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8")).get("data", [])
    with urllib.request.urlopen(API, timeout=90) as r:
        return json.loads(r.read().decode("utf-8")).get("data", [])


def main() -> None:
    cache = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    rows = fetch(cache)
    if not rows:
        sys.exit("[錯誤] 沒有取得任何資料")

    industries: list[str] = []
    ind_index: dict[str, int] = {}
    seen: set[str] = set()
    entries: list[str] = []

    for r in rows:
        code = str(r.get("stock_id", "")).strip()
        name = str(r.get("stock_name", "")).strip()
        market = r.get("type", "")

        if not CODE_RE.match(code) or not name or code in seen:
            continue
        if market not in MARKETS:
            continue
        # 分隔符號出現在資料裡會把整份表解壞，直接跳過比事後除錯容易
        if any(ch in name for ch in ",;"):
            continue

        seen.add(code)

        ind = str(r.get("industry_category", "")).strip()
        if ind not in ind_index:
            ind_index[ind] = len(industries)
            industries.append(ind)

        entries.append(f"{code},{name},{ind_index[ind]},{MARKETS.index(market)}")

    entries.sort()
    raw = ";".join(entries)

    OUT.write_text(
        '/**\n'
        ' * 台股代號對照表（自動產生，請勿手動編輯）。\n'
        ' *\n'
        ' * 由 tools/make_stocklist.py 產生，資料來自證交所與櫃買中心的公開清單。\n'
        ' * 用途是「由名稱反查代號」—— 券商 App 的庫存畫面常常只顯示名稱。\n'
        ' *\n'
        f' * 收錄 {len(entries)} 檔（上市／上櫃／興櫃）。\n'
        ' *\n'
        ' * 存成一整條字串而不是物件陣列：同樣的內容，字串的體積約只有\n'
        ' * JSON 物件的一半，載入時才展開成查表結構。\n'
        ' */\n\n'
        f"export const MARKETS = {json.dumps(MARKETS, ensure_ascii=False)};\n\n"
        f"export const INDUSTRIES = {json.dumps(industries, ensure_ascii=False)};\n\n"
        "/** 每筆格式：代號,名稱,產業索引,市場索引 */\n"
        f"export const RAW = '{raw}';\n",
        encoding="utf-8",
        newline="",
    )

    kb = OUT.stat().st_size / 1024
    print(f"[OK] {OUT.relative_to(ROOT)}  {len(entries)} 檔、{len(industries)} 個產業、{kb:.0f} KB")


if __name__ == "__main__":
    main()
