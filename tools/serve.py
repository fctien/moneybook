"""本機測試用的靜態檔伺服器。

執行：python tools/serve.py [port]

用途：
1. 在電腦瀏覽器開啟 http://localhost:8000 測試
2. 手機與電腦連同一個 Wi-Fi 時，用畫面上顯示的區域網路網址在手機上實測

正式部署時不需要這支程式 —— 整個專案是純靜態檔，
直接丟到 GitHub Pages、Netlify、Vercel 或任何靜態空間都能跑。

注意：Service Worker 只在 https 或 localhost 下才會註冊。
用手機連區網 IP（http://192.168.x.x:8000）時 App 功能正常，
但不會安裝離線快取，屬於預期行為。
"""

import http.server
import socket
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    """加上 .webmanifest 的 MIME type，並停用快取以免改了檔案卻看到舊版。"""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stdout.write(f"  {self.address_string()} - {fmt % args}\n")


def local_ip() -> str:
    """取得本機在區域網路上的 IP。不會真的送出封包。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class ThreadedServer(socketserver.ThreadingTCPServer):
    """多執行緒，否則 Service Worker 安裝時會把伺服器塞死。

    SW 在 install 階段會一次抓取整份 app shell（二十多個檔案），
    瀏覽器又會開多條 keep-alive 連線平行下載。
    單執行緒的 TCPServer 只能一條一條處理，前一條還沒關閉就無法接下一條，
    結果是整個伺服器停止回應、PWA 永遠裝不起來。
    """

    allow_reuse_address = True
    daemon_threads = True  # 主程式結束時不必等待殘留連線


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT

    with ThreadedServer(("0.0.0.0", port), Handler) as httpd:
        print("=" * 56)
        print("  MoneyBook 開發伺服器")
        print("=" * 56)
        print(f"  本機:     http://localhost:{port}/")
        print(f"  手機測試: http://{local_ip()}:{port}/")
        print(f"  測試頁:   http://localhost:{port}/test.html")
        print("\n  按 Ctrl+C 結束\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  已停止")


if __name__ == "__main__":
    main()
