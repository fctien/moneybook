/**
 * 設定頁。
 *
 * 這一頁最重要的是備份。資料只存在這支手機的瀏覽器裡，沒有任何雲端副本：
 * 手機遺失、重置、清除瀏覽資料，帳就沒了。
 * 因此備份按鈕放在最上面，並且會主動提醒使用者上次備份是多久以前。
 */

import {
  el, clear, toast, openSheet, confirmDialog, saveTextFile, copyToClipboard,
  pickTextFile, formatBytes,
} from '../ui.js';
import { serializeBackup, parseBackup, backupFilename, transactionsToCSV, snapshotsToCSV } from '../lib/backup.js';
import { todayISO, daysBetween, formatDayLabel } from '../lib/dateutil.js';
import { formatAmount } from '../lib/money.js';
import * as store from '../store.js';
import { storageEstimate, requestPersistence } from '../db.js';
import { isStandalone } from '../lib/install.js';

const LAST_BACKUP_KEY = 'lastBackupAt';
const BACKUP_WARN_DAYS = 30;

export function createSettingsView({ appVersion = '1.0.0', installer = null, openInstallHelp = null } = {}) {
  const node = el('section.view.view--settings');
  const refs = {};

  build();

  function build() {
    clear(node);

    refs.backupCard = el('section.card.card--accent');
    refs.quoteCard = el('section.card');
    refs.dataCard = el('section.card');
    refs.storageCard = el('section.card');
    refs.installCard = el('section.card');

    node.append(
      refs.backupCard,
      el('section.card', {}, [
        el('h2.card__title', { text: '分類管理' }),
        el('div.row-list', {}, [
          rowButton('📂', '支出分類', () => openCategoryManager('expense')),
          rowButton('💰', '收入分類', () => openCategoryManager('income')),
        ]),
      ]),
      refs.quoteCard,
      refs.dataCard,
      refs.storageCard,
      refs.installCard,
      el('section.card', {}, [
        el('h2.card__title', { text: '使用教學' }),
        el('div.row-list', {}, [
          // 影片放在同一個網域下，不依賴 YouTube 之類的外部平台，
          // 也就不會有追蹤或被下架的問題
          rowButton('📺', '觀看教學影片（3 分半）', () => {
            globalThis.open('./docs/demo/moneybook-tutorial.mp4', '_blank');
          }),
        ]),
        el('p.hint', { text: '從記帳、月結、資產到報表的完整操作示範。' }),
      ]),
      el('section.card', {}, [
        el('h2.card__title', { text: '關於' }),
        el('p.about-text', { text: `MoneyBook v${appVersion}` }),
        el('div.row-list', {}, [
          rowButton('🔄', '檢查更新', checkUpdateNow),
          rowButton('📐', '版面診斷', openLayoutDiagnostics),
        ]),
        el('p.about-text.about-text--muted', {
          text: '完全離線運作的個人記帳工具。所有資料只存在這台裝置的瀏覽器中，不會上傳到任何伺服器。',
        }),
      ]),
    );

    refresh();
    // beforeinstallprompt 可能在這一頁建好之後才到，「立即安裝」那一列要跟著出現
    installer?.onChange?.(renderInstallCard);
  }

  /**
   * 「加到主畫面」。
   *
   * 已經安裝的人不需要被一直提醒，所以只有在「還沒安裝」時才顯示警告。
   * 這條不是體驗建議而是資料安全問題：iOS Safari 會清除七天未使用的一般網站資料，
   * 已加到主畫面的 PWA 才不受此限制。
   */
  function renderInstallCard() {
    clear(refs.installCard);
    const installed = isStandalone();
    const native = installer?.available?.() ?? false;
    const rows = [];

    if (!installed && native) {
      rows.push(rowButton('📲', '立即安裝到主畫面', async () => {
        const outcome = await installer.prompt();
        if (outcome === 'accepted') toast('已加到主畫面', 'success');
        else if (outcome === 'unavailable') openInstallHelp?.({ installer });
      }));
    }
    rows.push(rowButton('📖', installed ? '安裝方式說明' : '如何加到主畫面', () => openInstallHelp?.({ installer })));

    refs.installCard.append(
      el('h2.card__title', { text: '加到主畫面' }),
      installed
        ? el('p.about-text.about-text--muted', { text: '✅ 已經以獨立 App 的形式開啟，資料不會被瀏覽器當成一般網站清掉。' })
        : el('p.hint.hint--warn', {
          text: 'iOS Safari 會清除七天未使用的網站資料。加到主畫面後就不受這個限制，強烈建議現在就做。',
        }),
      el('div.row-list', {}, rows),
    );
  }

  function rowButton(icon, label, onClick, { danger = false, meta = '' } = {}) {
    return el(`button.row${danger ? '.is-danger' : ''}`, { type: 'button', onClick }, [
      el('span.row__icon', { text: icon }),
      el('span.row__label', { text: label }),
      meta ? el('span.row__meta', { text: meta }) : null,
      el('span.row__chevron', { text: '›' }),
    ]);
  }

  /**
   * 手動檢查更新。
   *
   * 瀏覽器只在「導航」時才自動檢查新版的 Service Worker，
   * 而獨立 App 可能好幾天都不會導航一次 —— 使用者就會卡在舊版本。
   * 程式已經改成啟動與回到前景時主動檢查，這裡再給一個明確的手動入口。
   */
  async function checkUpdateNow() {
    toast('檢查中…', 'info', 2000);
    const { checkForUpdate, forceUpdate } = await import('../app.js');
    const { state, live } = await checkForUpdate();

    if (state === 'ready') {
      toast(live ? `有新版本 v${live}，正在更新…` : '有新版本，正在更新…', 'success', 3000);
      setTimeout(forceUpdate, 900);
    } else if (state === 'latest') {
      toast(`已經是最新版本 v${appVersion}`, 'success', 3000);
    } else if (state === 'unsupported') {
      toast('這個環境不支援自動更新', 'info', 3000);
    } else {
      toast('連不到伺服器，請確認網路後再試', 'error', 3500);
    }
  }

  /**
   * 版面診斷。
   *
   * 「畫面沒展開、底下一塊空白」這類問題在電腦上重現不了 ——
   * 螢幕尺寸、safe area、是不是獨立 App、瀏覽器工具列高度都只有當下那台裝置知道。
   * 把這些數字直接秀出來並可複製，使用者回報時就不必用文字描述畫面。
   */
  function openLayoutDiagnostics() {
    openSheet('版面診斷', (body) => {
      const cs = getComputedStyle(document.documentElement);
      const vlog = store.getSetting('viewportLog', null) || {};
      const appBox = document.querySelector('.app')?.getBoundingClientRect();
      const tabBox = document.querySelector('.tabbar')?.getBoundingClientRect();
      const vv = globalThis.visualViewport;

      const rows = [
        ['版本（目前執行）', `v${appVersion}`],
        ['獨立 App（已加到主畫面）', isStandalone() ? '是' : '否'],
        ['視窗 innerWidth × innerHeight', `${innerWidth} × ${innerHeight}`],
        ['visualViewport 高', vv ? `${Math.round(vv.height)}` : '不支援'],
        ['螢幕 screen 寬×高', `${screen.width} × ${screen.height}`],
        ['screen.availHeight', `${screen.availHeight}`],
        ['outerHeight', `${outerHeight}`],
        ['documentElement.clientHeight', `${document.documentElement.clientHeight}`],
        // 決定性的一項：網頁視口在螢幕上的起點。
        // 0 代表 App 有畫到狀態列底下（缺的那塊在螢幕下方）；
        // 不是 0 代表 iOS 把視口往下推了（缺的那塊在上方）。修法完全相反。
        ['視口在螢幕上的起點 screenY', `${globalThis.screenY ?? globalThis.screenTop ?? '不支援'}`],
        // 跑版當下這兩項最有價值：視窗被捲走了，或 body 比視窗高，
        // 都會讓整個 App 往上位移、底下露出空白
        ['視窗捲動位置 scrollY', `${Math.round(globalThis.scrollY)}`],
        ['body 高度', `${Math.round(document.body.scrollHeight)}`],
        ['body 比視窗高', `${Math.round(document.body.scrollHeight - innerHeight)}`],
        ['裝置像素比', `${devicePixelRatio}`],
        ['safe-area 上（實際套用）', cs.getPropertyValue('--safe-top').trim() || '0px'],
        ['safe-area 上（系統回報）', getComputedStyle(document.body).getPropertyValue('padding-top') === '' ? '—' : (globalThis.CSS?.supports?.('top: env(safe-area-inset-top)') ? '支援 env()' : '不支援 env()')],
        ['上方內距已手動歸零', store.safeTopOverridden() ? '是' : '否'],
        ['下方內距已手動歸零', store.safeBottomOverridden() ? '是' : '否'],
        ['safe-area 下', cs.getPropertyValue('--safe-bottom').trim() || '0px'],
        ['App 高度', appBox ? `${Math.round(appBox.height)}` : '—'],
        ['App 底部座標', appBox ? `${Math.round(appBox.bottom)}` : '—'],
        ['分頁列底部座標', tabBox ? `${Math.round(tabBox.bottom)}` : '—'],
        // 不是 0 就代表 App 沒有填滿視口
        ['App 底部剩餘空白', appBox ? `${Math.round(innerHeight - appBox.bottom)}` : '—'],
        // 不是 0 就代表視口本身比螢幕小 —— 那不是 CSS 能解決的
        ['視口比螢幕短', `${screen.height - innerHeight}`],
        // .app 的下緣距離視窗底部還有多少。不是 0 就代表 App 沒填滿視窗。
        ['App 下緣到視窗底部', `${Math.round(innerHeight - (appBox?.bottom ?? innerHeight))}`],
        // 「更新完是滿版、用一陣子就跑版」要靠這三項才證實得了
        ['視窗高｜啟動以來最大', vlog.max ? `${vlog.max}（${vlog.maxAt}）` : '—'],
        ['視窗高｜啟動以來最小', vlog.min ? `${vlog.min}（${vlog.minAt}・${vlog.minWhy ?? ''}）` : '—'],
        ['視窗高｜最後一次', vlog.last ? `${vlog.last}（${vlog.lastAt}・${vlog.lastWhy ?? ''}）` : '—'],
      ];

      const text = [
        ...rows.map(([k, v]) => `${k}: ${v}`),
        `UA: ${navigator.userAgent}`,
      ].join(String.fromCharCode(10));

      // 視口比螢幕矮，就不是 CSS 問題了 —— App 已經填滿它拿得到的全部空間。
      // 這種情況多半是主畫面捷徑記住了舊機型的視窗大小（換機、從備份還原之後最常見），
      // 只有重新加到主畫面才會更新。直接把判斷與做法寫在這裡，不要只丟一堆數字。
      const short = screen.height - innerHeight;

      body.append(
        el('p.sheet__message', {
          text: '這些是這台裝置回報的實際數字。若版面看起來不對，把它複製給我。',
        }),
        short > 4
          ? el('div.help-block', {}, [
            el('div.help-block__title', { text: `⚠ 視口比螢幕矮 ${short} 點` }),
            el('p.hint', {
              text: 'App 已經填滿它能拿到的全部空間，少掉的那塊是 iOS 沒有給這個主畫面捷徑，'
                + 'CSS 畫不到。這通常是捷徑記住了舊機型的視窗大小（換手機或從備份還原後最常見），'
                + '重新加到主畫面就會更新。',
            }),
            el('p.hint.hint--warn', {
              text: '重要：iOS 刪掉主畫面捷徑會一併刪掉它的資料。'
                + '請務必先到「備份與還原 → 匯出備份檔」存一份，刪除重加之後再還原。',
            }),
          ])
          : null,
        // 按鈕放最上面：這張表有十幾列，擺在最後的話在小螢幕上要捲很久才看得到，
        // 使用者會以為根本沒有這顆按鈕
        el('div.sheet__actions.sheet__actions--stack', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async (e) => {
              const ok = await copyToClipboard(text);
              toast(ok ? '已複製，可直接貼上回報' : '複製失敗，請改用下方長按選取', ok ? 'success' : 'error');
              if (ok) e.target.textContent = '✓ 已複製';
            },
          }, ['複製診斷資訊']),
          // 缺的那塊在上面還是下面，沒辦法從 JS 可靠地判斷 —— 但使用者看一眼就知道。
          // 這顆按鈕把上方 safe-area 內距歸零：如果畫面因此對了，代表視口本來就已經
          // 排除狀態列那塊、我們墊了第二次；如果內容跑到瀏海底下，代表不是這個原因。
          el('button.btn.btn--ghost', {
            type: 'button',
            onClick: async (e) => {
              const next = !store.safeTopOverridden();
              await store.setSafeTopOverride(next);
              e.target.textContent = next ? '↩ 復原上方內距' : '試：取消上方內距';
              toast(
                next
                  ? '已取消上方內距。關掉這頁看一下：版面對了嗎？內容有沒有被瀏海擋住？'
                  : '已復原。',
                'info', 6000,
              );
            },
          }, [store.safeTopOverridden() ? '↩ 復原上方內距' : '試：取消上方內距']),
          // 視口若沒延伸到螢幕底部，home indicator 就不在視口裡，
          // 分頁列還照著 safe-area 墊一塊就是白白吃掉空間。
          el('button.btn.btn--ghost', {
            type: 'button',
            onClick: async (e) => {
              const next = !store.safeBottomOverridden();
              await store.setSafeBottomOverride(next);
              e.target.textContent = next ? '↩ 復原下方內距' : '試：取消下方內距';
              toast(
                next
                  ? '已取消下方內距。分頁列會往下貼齊，看看是不是更合理。'
                  : '已復原。',
                'info', 5000,
              );
            },
          }, [store.safeBottomOverridden() ? '↩ 復原下方內距' : '試：取消下方內距']),
          // 把 App 的邊界畫出來，截一張圖就知道缺口在哪一邊
          el('button.btn.btn--ghost', {
            type: 'button',
            onClick: () => {
              document.querySelector('.app')?.classList.toggle('is-outlined');
              toast('已標示 App 邊界，請關掉這頁截一張圖給我。再按一次可取消。', 'info', 6000);
            },
          }, ['標示 App 邊界（截圖用）']),
        ]),
        // 剪貼簿 API 在 iOS 某些情境會被擋掉，留一塊可以長按選取的純文字當備援
        el('pre.diag-text', { text }),
        el('dl.detail-list', {}, rows.flatMap(([k, v]) => [
          el('dt', { text: k }),
          el('dd', { text: v }),
        ])),
      );
    });
  }

  // ------------------------------------------------------------- 股價自動更新

  /**
   * 這是整個 App 唯一會對外連線的功能，所以：
   *   - 預設關閉
   *   - 開關旁邊直接寫清楚會送出什麼、送到哪裡，不藏在說明頁裡
   * 使用者要能在按下去之前就知道自己同意了什麼。
   */
  function renderQuoteCard() {
    clear(refs.quoteCard);

    const enabled = store.autoQuoteEnabled();
    const toggle = el('input', {
      type: 'checkbox',
      checked: enabled,
      onChange: async (e) => {
        await store.setAutoQuoteEnabled(e.target.checked);
        toast(e.target.checked ? '已開啟自動更新股價' : '已關閉，股價改為手動填寫', 'success', 3200);
        renderQuoteCard();
      },
    });

    const last = store.lastQuoteUpdate();

    refs.quoteCard.append(
      el('h2.card__title', { text: '股價自動更新' }),
      el('label.switch-row', {}, [
        el('span', { text: '收盤後自動更新股價並計總' }),
        toggle,
      ]),
      el('p.hint', {
        text: '開啟後，台北時間 14:00 之後第一次開啟本 App 時，'
          + '會自動抓取持股的最新收盤價、更新總資產，並存下當日的淨資產快照。一天只會抓一次。',
      }),
      el('p.hint.hint--warn', {
        text: '這是本 App 唯一會連外的功能。抓價時會把你的持股代號送到資料來源 FinMind '
          + '（api.finmindtrade.com）。送出的只有代號，沒有股數、成本或任何個人資料，'
          + '但對方仍然看得出「有人持有這幾檔」。不開啟的話，股價改為自己手動填，其他功能完全不受影響。',
      }),
      el('p.hint', {
        text: '資料是收盤價，不是盤中即時價 —— 盤中不會跳動。'
          + '手機關著的時候程式不會執行，所以是「開啟 App 時補抓」，不是背景排程。',
      }),
    );

    if (last) {
      refs.quoteCard.append(el('p.hint', {
        text: `上次更新：${formatDayLabel(last.date)} 的收盤價`
          + (last.source === 'finmind' ? '（自動抓取）' : '（手動填入）'),
      }));
    }
  }

  // ------------------------------------------------------------- 備份

  function renderBackupCard() {
    clear(refs.backupCard);

    const lastBackup = store.getSetting(LAST_BACKUP_KEY, null);
    const daysAgo = lastBackup ? daysBetween(lastBackup.slice(0, 10), todayISO()) : null;
    const overdue = daysAgo === null || daysAgo >= BACKUP_WARN_DAYS;

    refs.backupCard.append(
      el('h2.card__title', { text: '備份與還原' }),
      el(`div.backup-status${overdue ? '.is-warning' : ''}`, {}, [
        el('span.backup-status__icon', { text: overdue ? '⚠️' : '✅' }),
        el('span.backup-status__text', {
          text: lastBackup
            ? `上次備份：${formatDayLabel(lastBackup.slice(0, 10))}（${daysAgo} 天前）`
            : '尚未備份過，強烈建議現在就做一次',
        }),
      ]),
      el('p.hint', {
        text: '資料只存在這支手機裡。換手機、重置或清除瀏覽器資料都會讓紀錄消失，備份檔是唯一的救援方式。',
      }),
      el('div.row-list', {}, [
        rowButton('💾', '匯出備份檔（JSON）', exportBackup),
        rowButton('📋', '複製備份內容到剪貼簿', copyBackup),
        rowButton('📥', '從備份檔還原', importBackup),
        rowButton('📊', '匯出交易明細（CSV）', exportTransactionsCSV),
        rowButton('📈', '匯出淨資產快照（CSV）', exportSnapshotsCSV),
      ]),
    );
  }

  async function markBackedUp() {
    await store.setSetting(LAST_BACKUP_KEY, new Date().toISOString());
    renderBackupCard();
  }

  async function exportBackup() {
    const text = serializeBackup(store.exportPayload());
    const filename = backupFilename(todayISO());
    const result = await saveTextFile(filename, text, 'application/json');

    if (result === 'cancelled') return;
    if (result === 'failed') {
      toast('無法直接存檔，請改用「複製備份內容到剪貼簿」', 'error');
      return;
    }
    await markBackedUp();
    toast(result === 'shared' ? '已開啟分享選單' : `已匯出 ${filename}`, 'success');
  }

  async function copyBackup() {
    const text = serializeBackup(store.exportPayload());
    const ok = await copyToClipboard(text);

    if (ok) {
      await markBackedUp();
      toast(`已複製 ${formatBytes(new Blob([text]).size)} 的備份內容`, 'success');
      return;
    }

    // 剪貼簿被瀏覽器擋下時，至少讓使用者能自己全選複製。
    // 這裡刻意不自動標記為已備份 —— 內容只是顯示出來，使用者未必真的存走了；
    // 標記成已備份反而會讓人誤以為安全。改由使用者自己確認。
    openSheet('備份內容', (body, close) => {
      body.append(
        el('p.hint', { text: '請長按下方文字全選複製，貼到記事本、雲端硬碟或寄給自己保存。' }),
        el('textarea.backup-textarea', { readonly: true, rows: '12' }, [text]),
        el('div.sheet__actions', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async () => {
              await markBackedUp();
              toast('已記錄備份時間', 'success');
              close();
            },
          }, ['我已複製並保存']),
        ]),
      );
    });
  }

  async function importBackup() {
    const picked = await pickTextFile();
    if (!picked) return;

    const parsed = parseBackup(picked.text);
    if (!parsed.ok) {
      toast(parsed.error, 'error');
      return;
    }

    const { counts, skipped, exportedAt } = parsed;
    openSheet('確認還原', (body, close) => {
      const summary = el('dl.detail-list');
      summary.append(
        el('dt', { text: '檔案' }), el('dd', { text: picked.name }),
        el('dt', { text: '匯出時間' }), el('dd', { text: exportedAt ? exportedAt.slice(0, 10) : '未知' }),
        el('dt', { text: '交易' }), el('dd', { text: `${counts.transactions} 筆` }),
        el('dt', { text: '帳戶' }), el('dd', { text: `${counts.accounts} 個` }),
        el('dt', { text: '分類' }), el('dd', { text: `${counts.categories} 個` }),
        el('dt', { text: '快照' }), el('dd', { text: `${counts.snapshots} 筆` }),
      );

      body.append(summary);

      if (skipped.length) {
        body.append(el('p.hint.is-error', {
          text: `有 ${skipped.length} 筆資料格式不正確會被略過（其餘仍可正常還原）。`,
        }));
      }

      body.append(
        el('p.hint', { text: '「取代」會清空目前資料後寫入備份內容；「合併」會保留現有資料，只覆蓋相同編號的項目。' }),
        el('div.sheet__actions.sheet__actions--stack', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async () => {
              await store.importMerge(parsed.data);
              toast(`已合併 ${counts.transactions} 筆交易`, 'success');
              close();
              refresh();
            },
          }, ['合併匯入（建議）']),
          el('button.btn.btn--danger', {
            type: 'button',
            onClick: async () => {
              const ok = await confirmDialog(
                '取代全部資料？',
                `目前的 ${store.state.transactions.length} 筆交易會被完全清除，改用備份檔的內容。此操作無法復原。`,
                { confirmText: '確定取代', danger: true },
              );
              if (!ok) return;
              await store.importReplace(parsed.data);
              toast('已還原備份', 'success');
              close();
              refresh();
            },
          }, ['取代全部資料']),
        ]),
      );
    });
  }

  async function exportTransactionsCSV() {
    if (!store.state.transactions.length) {
      toast('還沒有任何交易紀錄', 'error');
      return;
    }
    const csv = transactionsToCSV(store.state.transactions, {
      accounts: store.state.accounts,
      categories: store.state.categories,
    });
    await exportCSV(`moneybook-明細-${todayISO()}.csv`, csv);
  }

  /** CSV 匯出的共同收尾：使用者取消時什麼都不說，才不會誤報成功或失敗 */
  async function exportCSV(filename, csv) {
    const result = await saveTextFile(filename, csv, 'text/csv');
    if (result === 'cancelled') return;
    toast(result === 'failed' ? '匯出失敗' : '已匯出 CSV', result === 'failed' ? 'error' : 'success');
  }

  async function exportSnapshotsCSV() {
    if (!store.state.snapshots.length) {
      toast('還沒有任何淨資產快照', 'error');
      return;
    }
    const csv = snapshotsToCSV(store.state.snapshots);
    await exportCSV(`moneybook-淨資產-${todayISO()}.csv`, csv);
  }

  // ------------------------------------------------------------- 分類管理

  function openCategoryManager(type) {
    const title = type === 'expense' ? '支出分類' : '收入分類';

    openSheet(title, (body) => {
      const list = el('div.row-list');

      const render = () => {
        clear(list);
        const categories = store.state.categories
          .filter((c) => c.type === type)
          .sort((a, b) => Number(a.archived) - Number(b.archived) || (a.order ?? 0) - (b.order ?? 0));

        for (const cat of categories) {
          const usage = store.categoryUsage(cat.id);
          list.append(el(`button.row${cat.archived ? '.is-muted' : ''}`, {
            type: 'button',
            onClick: () => openCategoryEditor(cat, type, render),
          }, [
            el('span.row__icon', { text: cat.icon, style: { background: `${cat.color}22` } }),
            el('span.row__label', { text: cat.name + (cat.archived ? '（已封存）' : '') }),
            el('span.row__meta', { text: usage ? `${usage} 筆` : '' }),
            el('span.row__chevron', { text: '›' }),
          ]));
        }

        list.append(el('button.row.is-add', {
          type: 'button',
          onClick: () => openCategoryEditor(null, type, render),
        }, [
          el('span.row__icon', { text: '＋' }),
          el('span.row__label', { text: '新增分類' }),
        ]));
      };

      render();
      body.append(list);
    });
  }

  function openCategoryEditor(category, type, onDone) {
    const isNew = !category;
    const draft = {
      id: category?.id,
      name: category?.name ?? '',
      type,
      icon: category?.icon ?? '📌',
      color: category?.color ?? '#64748b',
      archived: category?.archived ?? false,
      order: category?.order,
    };

    openSheet(isNew ? '新增分類' : '編輯分類', (body, close) => {
      body.append(
        el('div.field', {}, [
          el('div.field__label', { text: '名稱' }),
          el('input.text-input', {
            type: 'text',
            value: draft.name,
            placeholder: '例如：早餐、交通',
            maxlength: '20',
            onInput: (e) => { draft.name = e.target.value; },
          }),
        ]),
        el('div.field', {}, [
          el('div.field__label', { text: '圖示（可直接輸入任何 emoji）' }),
          el('input.text-input.text-input--icon', {
            type: 'text',
            value: draft.icon,
            maxlength: '4',
            onInput: (e) => { draft.icon = e.target.value; },
          }),
        ]),
        el('div.field', {}, [
          el('div.field__label', { text: '顏色' }),
          el('input.color-input', {
            type: 'color',
            value: draft.color,
            onInput: (e) => { draft.color = e.target.value; },
          }),
        ]),
      );

      if (!isNew) {
        body.append(el('label.switch-row', {}, [
          el('span', { text: '封存這個分類' }),
          el('input', {
            type: 'checkbox',
            checked: draft.archived,
            onChange: (e) => { draft.archived = e.target.checked; },
          }),
        ]));
      }

      const actions = el('div.sheet__actions');
      if (!isNew) {
        actions.append(el('button.btn.btn--danger', {
          type: 'button',
          onClick: async () => {
            const result = await store.deleteCategory(draft.id);
            if (!result.ok) { toast(result.error, 'error'); return; }
            toast('已刪除', 'success');
            close();
            onDone?.();
          },
        }, ['刪除']));
      }
      actions.append(el('button.btn.btn--primary', {
        type: 'button',
        onClick: async () => {
          const result = await store.saveCategory(draft);
          if (!result.ok) { toast(result.error, 'error'); return; }
          toast('已儲存', 'success');
          close();
          onDone?.();
        },
      }, ['儲存']));

      body.append(actions);
    });
  }

  // ------------------------------------------------------------- 資料與儲存

  function renderDataCard() {
    clear(refs.dataCard);
    const { transactions, accounts, categories, snapshots } = store.state;
    const total = transactions.reduce((a, t) => a + (t.type === 'expense' ? t.amount : 0), 0);

    refs.dataCard.append(
      el('h2.card__title', { text: '資料統計' }),
      el('div.stat-row', {}, [
        stat('交易筆數', String(transactions.length)),
        stat('帳戶', String(accounts.length)),
        stat('分類', String(categories.length)),
        stat('快照', String(snapshots.length)),
      ]),
      el('p.hint', { text: `累計支出 ${formatAmount(total, { decimals: 'never' })} 元` }),
      el('div.row-list', {}, [
        rowButton('🗑', '清除全部資料', wipeData, { danger: true }),
      ]),
    );
  }

  function stat(label, value) {
    return el('div.stat', {}, [
      el('div.stat__label', { text: label }),
      el('div.stat__value', { text: value }),
    ]);
  }

  async function wipeData() {
    const ok = await confirmDialog(
      '清除全部資料？',
      `這會刪除全部 ${store.state.transactions.length} 筆交易、帳戶與分類設定，且無法復原。請先確認已經匯出備份。`,
      { confirmText: '全部清除', danger: true },
    );
    if (!ok) return;

    const second = await confirmDialog('再次確認', '真的要清除嗎？這是最後一次確認。', {
      confirmText: '確定清除',
      danger: true,
    });
    if (!second) return;

    await store.wipeEverything();
    toast('已清除全部資料', 'success');
    refresh();
  }

  async function renderStorageCard() {
    clear(refs.storageCard);
    refs.storageCard.append(el('h2.card__title', { text: '儲存空間' }));

    const estimate = await storageEstimate();
    if (estimate && estimate.quota > 0) {
      const pct = (estimate.usage / estimate.quota) * 100;
      refs.storageCard.append(
        el('p.about-text', {
          text: `已使用 ${formatBytes(estimate.usage)}／可用 ${formatBytes(estimate.quota)}（${pct.toFixed(2)}%）`,
        }),
      );
    } else {
      refs.storageCard.append(el('p.about-text', { text: '這個瀏覽器沒有提供儲存空間資訊。' }));
    }

    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    refs.storageCard.append(
      el('div.row-list', {}, [
        rowButton(
          persisted ? '🔒' : '🔓',
          persisted ? '資料已設為持續保存' : '要求持續保存資料',
          async () => {
            const result = await requestPersistence();
            if (result === true) toast('已設定為持續保存', 'success');
            else if (result === false) toast('瀏覽器拒絕了此要求，請確認已將本 App 加到主畫面', 'error');
            else toast('這個瀏覽器不支援此功能', 'error');
            renderStorageCard();
          },
        ),
      ]),
      el('p.hint', {
        text: '設為持續保存後，裝置空間不足時瀏覽器比較不會清掉本 App 的資料。這仍不能取代備份。',
      }),
    );
  }

  function refresh() {
    renderBackupCard();
    renderQuoteCard();
    renderDataCard();
    renderStorageCard();
    renderInstallCard();
  }

  return { node, refresh };
}
