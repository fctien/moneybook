"""產生 PWA 所需的圖示檔。

執行：python tools/make_icons.py

產出（放在 icons/）：
    icon-192.png            Android 主畫面 / manifest
    icon-512.png            manifest 大尺寸與啟動畫面
    icon-maskable-512.png   Android 自適應圖示（內容須留在中央安全區內）
    apple-touch-icon.png    iOS 加到主畫面時使用（180x180，iOS 會自己套圓角）

刻意用純幾何繪製而不是外部圖檔，這樣任何人重新產生都不需要額外素材。
"""

from pathlib import Path

from PIL import Image, ImageDraw

ICON_DIR = Path(__file__).resolve().parent.parent / "icons"

BLUE = (37, 99, 235, 255)
BLUE_DARK = (29, 78, 216, 255)
WHITE = (255, 255, 255, 255)

# 以 1024x1024 繪製再縮圖，邊緣才會平滑
CANVAS = 1024


def draw_wallet(draw: ImageDraw.ImageDraw, size: int, scale: float = 1.0) -> None:
    """在畫布中央畫一個白色錢包。scale 用來替 maskable 版本縮小內容。"""
    cx = cy = size / 2
    w = size * 0.52 * scale
    h = size * 0.40 * scale
    r = size * 0.06 * scale

    left, top = cx - w / 2, cy - h / 2
    right, bottom = cx + w / 2, cy + h / 2

    # 錢包本體
    draw.rounded_rectangle([left, top, right, bottom], radius=r, fill=WHITE)

    # 右側卡夾：挖掉一塊再放上藍色圓點，做出釦環的層次
    flap_w = w * 0.30
    draw.rounded_rectangle(
        [right - flap_w, top + h * 0.28, right + size * 0.012 * scale, bottom - h * 0.28],
        radius=r * 0.7,
        fill=BLUE_DARK,
    )
    dot_r = h * 0.075
    draw.ellipse(
        [right - flap_w * 0.55 - dot_r, cy - dot_r, right - flap_w * 0.55 + dot_r, cy + dot_r],
        fill=WHITE,
    )

    # 上緣的翻蓋線，讓它看起來像掀蓋錢包而不是一塊白方塊
    line_y = top + h * 0.22
    draw.rounded_rectangle(
        [left + w * 0.10, line_y - h * 0.025, left + w * 0.55, line_y + h * 0.025],
        radius=h * 0.025,
        fill=BLUE,
    )


def make_icon(size: int, *, rounded: bool, scale: float = 1.0) -> Image.Image:
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if rounded:
        draw.rounded_rectangle([0, 0, CANVAS - 1, CANVAS - 1], radius=CANVAS * 0.22, fill=BLUE)
    else:
        # maskable 圖示會被系統裁成圓形或圓角，背景必須鋪滿整張
        draw.rectangle([0, 0, CANVAS, CANVAS], fill=BLUE)

    draw_wallet(draw, CANVAS, scale)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)

    outputs = [
        ("icon-192.png", make_icon(192, rounded=True)),
        ("icon-512.png", make_icon(512, rounded=True)),
        # maskable 安全區是中心 80% 的圓，內容縮到 0.72 保證不會被裁掉
        ("icon-maskable-512.png", make_icon(512, rounded=False, scale=0.72)),
        ("apple-touch-icon.png", make_icon(180, rounded=True)),
    ]

    for name, img in outputs:
        path = ICON_DIR / name
        img.save(path, "PNG", optimize=True)
        print(f"  {name:26} {path.stat().st_size:>7,} bytes")

    print(f"\n完成，共 {len(outputs)} 個檔案，輸出於 {ICON_DIR}")


if __name__ == "__main__":
    main()
