"""產生「MoneyBook 記帳教學」示範影片。

執行（需先啟動本機伺服器 python tools/serve.py 8811）：
    python tools/make_demo_video.py            # 全部跑完
    python tools/make_demo_video.py capture    # 只重拍截圖
    python tools/make_demo_video.py narrate    # 只重產旁白
    python tools/make_demo_video.py build      # 只重組影片

流程：
  1. capture  Playwright 用手機尺寸操作 App，逐個場景截圖
  2. narrate  edge-tts 產生中文旁白，並量出每段長度
  3. build    moviepy 依旁白長度組成 MP4，畫面下方燒上字幕

為什麼用「截圖投影片」而不是直接錄螢幕：
錄影的長度無法與旁白對齊，得事後手工剪。改成每個場景一張圖、
顯示時間直接取自該段旁白的實際長度，畫面與聲音必然同步，
重跑也會得到完全一樣的結果。
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "demo"
SHOTS = OUT / "shots"
AUDIO = OUT / "audio"
VIDEO = OUT / "moneybook-記帳教學.mp4"

BASE_URL = "http://localhost:8811/index.html"
VOICE = "zh-TW-HsiaoChenNeural"      # 台灣中文女聲
VIEWPORT = {"width": 390, "height": 844}   # iPhone 15 邏輯解析度
SCALE = 2                                   # 兩倍圖，字才清楚

# 每個場景播完後多留一點餘韻，換場才不會太急
TAIL_SECONDS = 0.45


# --------------------------------------------------------------------------
# 示範資料：兩個月的收支，報表才有東西可畫
# --------------------------------------------------------------------------

SEED_JS = r"""
async () => {
  const store = await import('./js/store.js');
  await store.setSetting('firstRunDone', true);

  const C = Object.fromEntries(store.categoriesOfType('expense').map(c => [c.name, c.id]));
  const I = Object.fromEntries(store.categoriesOfType('income').map(c => [c.name, c.id]));
  const A = Object.fromEntries(store.postableAccounts().map(a => [a.name, a.id]));

  const rows = [
    ['2026-08-05','income','薪資',68000,'銀行帳戶','八月薪資'],
    ['2026-08-06','expense','居住',18000,'銀行帳戶','房租'],
    ['2026-08-07','expense','飲食',185,'現金','午餐'],
    ['2026-08-09','expense','交通',1200,'現金','捷運月票'],
    ['2026-08-12','expense','飲食',420,'現金','聚餐'],
    ['2026-08-15','expense','生活用品',890,'銀行帳戶','日用品'],
    ['2026-08-18','expense','娛樂',650,'現金','電影'],
    ['2026-08-20','expense','飲食',260,'現金','晚餐'],
    ['2026-08-22','expense','醫療',1500,'銀行帳戶','健檢'],
    ['2026-08-25','expense','教育',2400,'銀行帳戶','線上課程'],
    ['2026-08-28','expense','飲食',310,'現金','早午餐'],
    ['2026-09-01','income','薪資',68000,'銀行帳戶','九月薪資'],
    ['2026-09-01','expense','居住',18000,'銀行帳戶','房租'],
    ['2026-09-02','expense','飲食',120,'現金','早餐'],
    ['2026-09-02','expense','交通',60,'現金','公車'],
    ['2026-09-03','expense','飲食',95,'現金','咖啡'],
    ['2026-09-03','expense','生活用品',560,'銀行帳戶','衛生紙'],
    ['2026-09-04','expense','飲食',180,'現金','午餐'],
    ['2026-09-04','expense','娛樂',390,'銀行帳戶','串流訂閱'],
    ['2026-09-04','income','兼職',5000,'銀行帳戶','演講費'],
    ['2026-09-05','expense','飲食',240,'現金','晚餐'],
    ['2026-09-05','expense','交通',150,'現金','計程車'],
  ];

  for (const [date, type, cat, amt, acct, note] of rows) {
    await store.saveTransaction({
      type, date, amount: amt * 100,
      accountId: A[acct],
      categoryId: type === 'expense' ? C[cat] : I[cat],
      note,
    });
  }

  const accts = store.state.accounts;
  const bank = accts.find(a => a.name === '銀行帳戶');
  const cash = accts.find(a => a.name === '現金');
  await store.saveAccount({ ...bank, openingBalance: 320000 * 100 });
  await store.saveAccount({ ...cash, openingBalance: 8000 * 100 });
  await store.saveAccount({ name: '證券帳戶', kind: 'investment', valuationMode: 'manual', manualValue: 480000 * 100 });
  await store.saveAccount({ name: '信用貸款', kind: 'loan', valuationMode: 'manual', manualValue: -280000 * 100 });

  // 快照直接寫入而不用 takeSnapshot() —— 後者一律記錄「當下」的淨資產，
  // 五筆會全部一樣，趨勢線就變成一條平線，示範起來看不出重點。
  const db = await import('./js/db.js');
  const series = [
    ['2026-04-01', 820000, 300000],
    ['2026-05-01', 845000, 296000],
    ['2026-06-01', 862000, 292000],
    ['2026-07-01', 875000, 288000],
    ['2026-08-01', 890000, 284000],
    ['2026-09-05', 903220, 280000],
  ];
  for (const [date, assets, liab] of series) {
    await db.put(db.STORE.snapshots, {
      id: crypto.randomUUID(),
      date,
      assets: assets * 100,
      liabilities: liab * 100,
      net: (assets - liab) * 100,
      breakdown: [],
      note: '',
      createdAt: Date.now(),
    });
  }
  await store.reload();
  return store.state.transactions.length;
}
"""


# --------------------------------------------------------------------------
# 場景：畫面操作與旁白寫在一起，才不會改了一邊忘了另一邊
# --------------------------------------------------------------------------

def tap_tab(page, index: int) -> None:
    page.locator(".tabbar__item").nth(index).click()
    page.wait_for_timeout(700)


def tap_key(page, label: str) -> None:
    page.locator(".keypad button", has_text=label).first.click()
    page.wait_for_timeout(180)


def scroll_main(page, ratio: float) -> None:
    """捲動分頁內容。

    可捲動的是外層的 #main，不是 view 本身 —— view 的 overflow 是 visible，
    對它設 scrollTop 不會有任何效果。
    """
    page.evaluate(
        "r => { const m = document.querySelector('#main');"
        " m.scrollTop = (m.scrollHeight - m.clientHeight) * r; }",
        ratio,
    )
    page.wait_for_timeout(600)


def build_scenes():
    """回傳 [(id, 旁白, 操作函式, 字幕)]"""

    def s01(page):
        tap_tab(page, 0)

    def s02(page):
        for k in ["1", "2", "0"]:
            tap_key(page, k)

    def s03(page):
        tap_key(page, "+")
        tap_key(page, "5")
        tap_key(page, "0")

    def s04(page):
        page.locator(".cat").first.click()
        page.wait_for_timeout(400)

    def s05(page):
        page.locator(".entry-scroll").evaluate("e => e.scrollTop = e.scrollHeight")
        page.wait_for_timeout(400)

    def s06(page):
        page.locator(".btn--submit").click()
        page.wait_for_timeout(900)

    def s07(page):
        tap_tab(page, 1)

    def s08(page):
        page.locator(".month-nav button").first.click()
        page.wait_for_timeout(700)

    def s09(page):
        page.locator(".month-nav button").last.click()
        page.wait_for_timeout(500)
        tap_tab(page, 2)

    def s10(page):
        tap_tab(page, 3)

    def s11(page):
        scroll_main(page, 0.42)
        page.wait_for_timeout(600)

    def s12(page):
        scroll_main(page, 1.0)
        page.wait_for_timeout(600)

    def s13(page):
        tap_tab(page, 4)

    def s14(page):
        scroll_main(page, 1.0)
        page.wait_for_timeout(600)

    def s15(page):
        tap_tab(page, 0)
        page.wait_for_timeout(400)

    def s16(page):
        page.locator(".link-btn").click()
        page.wait_for_timeout(900)

    return [
        ("01-intro", s01,
         "這是 MoneyBook，一個完全離線的記帳工具。所有資料只存在你自己的手機裡，不會上傳到任何伺服器。打開就是記帳頁，最上面選支出、收入或轉帳。",
         "記帳頁：支出／收入／轉帳"),

        ("02-amount", s02,
         "先用下方的數字鍵盤輸入金額。這裡輸入一百二十元。",
         "用數字鍵盤輸入金額"),

        ("03-expression", s03,
         "鍵盤支援算式。一起買了兩樣東西時，直接打加號再接下一筆，畫面會即時算出總額一百七十元，不必自己心算。",
         "支援算式：120＋50 ＝ 170"),

        ("04-category", s04,
         "接著選分類。常用的分類會依照使用頻率自動排到前面，越用越順手。",
         "選分類（依使用頻率排序）"),

        ("05-account", s05,
         "再往下可以選帳戶跟日期。預設是現金和今天，多數情況直接用預設值就好，也可以加上備註。",
         "選帳戶、日期，可加備註"),

        ("06-save", s06,
         "按下完成就記錄好了。存檔後會停在記帳頁，方便你連續記好幾筆。",
         "按「完成」存檔"),

        ("07-ledger", s07,
         "切到明細頁，最上面就是這個月的收入、支出跟結餘。下面依日期列出每一筆，點任何一筆都可以修改或刪除。",
         "明細頁：本月收支與結餘"),

        ("08-month", s08,
         "左右箭頭可以切換月份，回頭查看上個月的紀錄。這就是月底結算要看的畫面。",
         "切換月份查看歷史"),

        ("09-assets", s09,
         "資產頁管理你的整體財務。現金和銀行帳戶會依照每天記帳自動加減；股票、不動產、貸款這類無法靠記帳推算的，改用手動填入目前價值。負債請填負數，最上面就是淨資產。",
         "資產頁：淨資產與各帳戶"),

        ("10-report", s10,
         "報表頁把數字變成圖。最上面是本月結餘、日均支出和筆數，下面是近六個月的收支長條圖，可以看出花錢的趨勢。",
         "報表頁：近六個月收支"),

        ("11-category-pie", s11,
         "再往下是本月的分類佔比。哪一類花最多一眼就看得出來，這是控制支出最實用的一張圖。",
         "分類佔比：錢花到哪裡去"),

        ("12-trend", s12,
         "最下面是淨資產趨勢線。到資產頁按下儲存今日快照，累積兩筆以上就會畫出這條線，看得到資產是不是真的在長大。",
         "淨資產趨勢線"),

        ("13-settings", s13,
         "設定頁最重要的是備份。資料只存在這支手機裡，沒有任何雲端副本，手機遺失或清除瀏覽器資料就救不回來了。",
         "設定頁：備份是必需品"),

        ("14-install", s14,
         "所以請務必做兩件事。第一，每個月匯出一次備份檔存到雲端硬碟。第二，把這個網頁加到主畫面，否則 iOS 可能在閒置七天後清掉資料。這裡有完整的安裝說明。",
         "每月備份＋加到主畫面"),

        ("15-scan", s15,
         "回到記帳頁，最上面還有掃電子發票。拍下發票下方那兩個方塊條碼，品名、數量、金額會自動帶出來，不用一項一項自己打。",
         "掃電子發票自動帶入品項"),

        ("16-scan-help", s16,
         "點旁邊的「怎麼用」，裡面有完整的操作步驟、拍不清楚時的排除方法，也說明了哪些發票沒有條碼所以掃不出來。以上就是記帳的基本操作。",
         "內建使用說明"),
    ]


# --------------------------------------------------------------------------
# 步驟一：截圖
# --------------------------------------------------------------------------

def capture() -> None:
    from playwright.sync_api import sync_playwright

    SHOTS.mkdir(parents=True, exist_ok=True)
    for old in SHOTS.glob("*.png"):
        old.unlink()

    scenes = build_scenes()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport=VIEWPORT,
            device_scale_factor=SCALE,
            locale="zh-TW",
            timezone_id="Asia/Taipei",
            color_scheme="light",
        )
        page = ctx.new_page()
        page.goto(BASE_URL, wait_until="networkidle")
        page.wait_for_selector(".tabbar", timeout=15000)

        count = page.evaluate(SEED_JS)
        print(f"  已建立 {count} 筆示範資料")

        # 重新載入讓畫面吃到剛寫入的資料
        page.reload(wait_until="networkidle")
        page.wait_for_selector(".tabbar", timeout=15000)
        page.wait_for_timeout(800)

        for scene_id, action, _narration, _caption in scenes:
            action(page)
            page.wait_for_timeout(350)
            path = SHOTS / f"{scene_id}.png"
            page.screenshot(path=str(path))
            print(f"  截圖 {path.name}")

        ctx.close()
        browser.close()

    print(f"完成：{len(scenes)} 張截圖 -> {SHOTS}")


# --------------------------------------------------------------------------
# 步驟二：旁白
# --------------------------------------------------------------------------

def narrate() -> None:
    import edge_tts

    AUDIO.mkdir(parents=True, exist_ok=True)
    for old in AUDIO.glob("*.mp3"):
        old.unlink()

    scenes = build_scenes()

    async def run():
        for scene_id, _action, narration, _caption in scenes:
            path = AUDIO / f"{scene_id}.mp3"
            # rate 稍慢一點，教學影片講太快聽不清楚
            tts = edge_tts.Communicate(narration, VOICE, rate="-8%")
            await tts.save(str(path))
            print(f"  旁白 {path.name}")

    asyncio.run(run())
    print(f"完成：{len(scenes)} 段旁白 -> {AUDIO}")


# --------------------------------------------------------------------------
# 步驟三：組成影片
# --------------------------------------------------------------------------

def _font_path() -> str | None:
    """找一個有中文字的字型，字幕才不會變成一排豆腐。"""
    for name in ("msjh.ttc", "msjhbd.ttc", "mingliu.ttc", "simsun.ttc", "Arial Unicode.ttf"):
        p = Path("C:/Windows/Fonts") / name
        if p.exists():
            return str(p)
    return None


def _compose_frame(shot: Path, caption: str, size: tuple[int, int]) -> "Path":
    """把截圖放到固定尺寸的畫布上，下方燒上字幕。"""
    from PIL import Image, ImageDraw, ImageFont

    W, H = size
    canvas = Image.new("RGB", (W, H), (17, 20, 26))

    img = Image.open(shot).convert("RGB")
    caption_h = 130
    avail_h = H - caption_h
    scale = min(W / img.width, avail_h / img.height)
    new = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    canvas.paste(new, ((W - new.width) // 2, (avail_h - new.height) // 2))

    draw = ImageDraw.Draw(canvas)
    fp = _font_path()
    font = ImageFont.truetype(fp, 40) if fp else ImageFont.load_default()

    bbox = draw.textbbox((0, 0), caption, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((W - tw) // 2, H - caption_h + 34), caption, font=font, fill=(240, 244, 250))

    out = SHOTS / f"_frame-{shot.stem}.png"
    canvas.save(out)
    return out


def build() -> None:
    from moviepy import AudioFileClip, ImageClip, concatenate_videoclips

    scenes = build_scenes()
    size = (1080, 1920)   # 直式，符合手機畫面比例

    clips = []
    for scene_id, _action, _narration, caption in scenes:
        shot = SHOTS / f"{scene_id}.png"
        mp3 = AUDIO / f"{scene_id}.mp3"
        if not shot.exists() or not mp3.exists():
            sys.exit(f"[錯誤] 缺少 {shot.name} 或 {mp3.name}，請先跑 capture 與 narrate")

        audio = AudioFileClip(str(mp3))
        dur = audio.duration + TAIL_SECONDS

        frame = _compose_frame(shot, caption, size)
        clip = ImageClip(str(frame)).with_duration(dur).with_audio(audio)
        clips.append(clip)
        print(f"  場景 {scene_id}  {dur:5.1f} 秒")

    video = concatenate_videoclips(clips, method="chain")
    OUT.mkdir(parents=True, exist_ok=True)
    video.write_videofile(
        str(VIDEO), fps=24, codec="libx264", audio_codec="aac",
        preset="medium", logger=None,
    )

    for f in SHOTS.glob("_frame-*.png"):
        f.unlink()

    mb = VIDEO.stat().st_size / 1024 / 1024
    print(f"完成：{VIDEO}  （{video.duration:.0f} 秒，{mb:.1f} MB）")


# --------------------------------------------------------------------------

def main() -> None:
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("all", "capture"):
        print("[1/3] 截圖")
        capture()
    if step in ("all", "narrate"):
        print("[2/3] 旁白")
        narrate()
    if step in ("all", "build"):
        print("[3/3] 組成影片")
        build()


if __name__ == "__main__":
    main()
