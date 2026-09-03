"""把 sw.js 的 CACHE_VERSION 換成目前的 git commit，用於「要讓手機立刻更新」的時候。

執行：
    python tools/bump_version.py           # 用目前 HEAD 的短 SHA
    python tools/bump_version.py v1.1.0    # 自己指定版本字串

什麼時候需要跑這支程式
----------------------
平常「不需要」。Service Worker 的 fetch 走的是 stale-while-revalidate：
每次開啟 App 時先用快取內容立刻顯示，同時在背景重新抓一次並更新快取，
所以改了程式碼推上去之後，使用者「下一次」開啟就會是新版，本來就會自動更新。

需要跑的情況有兩個：

1. 想讓使用者「這一次」就看到更新提示
   瀏覽器只有在 sw.js 的「位元組內容」變了，才會判定 Service Worker 有新版本、
   觸發 updatefound 並跳出「已下載新版本」的提示。改 CACHE_VERSION 就是在改它的內容。

2. 改動牽涉到快取結構，需要整包丟掉重來
   換了新的 CACHE_VERSION 之後，activate 階段會把所有舊的快取刪乾淨。

注意：這只會清掉「程式碼快取」，使用者記在 IndexedDB 裡的帳目完全不受影響。
"""

import re
import subprocess
import sys
from pathlib import Path

SW = Path(__file__).resolve().parent.parent / "sw.js"
PATTERN = re.compile(r"const CACHE_VERSION = '([^']*)';")


def current_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            cwd=SW.parent,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        sys.exit("[錯誤] 取不到 git commit，請改用：python tools/bump_version.py <版本字串>")


def main() -> None:
    label = sys.argv[1] if len(sys.argv) > 1 else current_sha()
    new_version = f"moneybook-{label}"

    src = SW.read_text(encoding="utf-8")
    match = PATTERN.search(src)
    if not match:
        sys.exit("[錯誤] 在 sw.js 找不到 CACHE_VERSION")

    old_version = match.group(1)
    if old_version == new_version:
        print(f"  CACHE_VERSION 已經是 {new_version}，不需更動")
        return

    updated = PATTERN.sub(f"const CACHE_VERSION = '{new_version}';", src, count=1)
    # newline="" 保留原本的換行字元。若讓 Python 自動轉成 CRLF，
    # 整份 sw.js 都會被判定為有變更，diff 會被無關的換行改動淹沒。
    with SW.open("w", encoding="utf-8", newline="") as fh:
        fh.write(updated)
    print(f"[OK] CACHE_VERSION: {old_version}  ->  {new_version}")
    print("  接著 commit 並 push，手機上的 App 下次開啟就會提示更新。")


if __name__ == "__main__":
    main()
