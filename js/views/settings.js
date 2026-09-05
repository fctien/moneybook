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
import { isStandalone, installGuide } from '../lib/install.js';

const LAST_BACKUP_KEY = 'lastBackupAt';
const BACKUP_WARN_DAYS = 30;

export function createSettingsView({ appVersion = '1.0.0' } = {}) {
  const node = el('section.view.view--settings');
  const refs = {};

  build();

  function build() {
    clear(node);

    refs.backupCard = el('section.card.card--accent');
    refs.dataCard = el('section.card');
    refs.storageCard = el('section.card');

    node.append(
      refs.backupCard,
      el('section.card', {}, [
        el('h2.card__title', { text: '分類管理' }),
        el('div.row-list', {}, [
          rowButton('📂', '支出分類', () => openCategoryManager('expense')),
          rowButton('💰', '收入分類', () => openCategoryManager('income')),
        ]),
      ]),
      refs.dataCard,
      refs.storageCard,
      buildInstallCard(),
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
        el('p.about-text.about-text--muted', {
          text: '完全離線運作的個人記帳工具。所有資料只存在這台裝置的瀏覽器中，不會上傳到任何伺服器。',
        }),
      ]),
    );

    refresh();
  }

  /**
   * 「加到主畫面」。
   *
   * 已經安裝的人不需要被一直提醒，所以只有在「還沒安裝」時才顯示警告。
   * 這條不是體驗建議而是資料安全問題：iOS Safari 會清除七天未使用的一般網站資料，
   * 已加到主畫面的 PWA 才不受此限制。
   */
  function buildInstallCard() {
    const installed = isStandalone();

    return el('section.card', {}, [
      el('h2.card__title', { text: '加到主畫面' }),
      installed
        ? el('p.about-text.about-text--muted', { text: '✅ 已經以獨立 App 的形式開啟，資料不會被瀏覽器當成一般網站清掉。' })
        : el('p.hint.hint--warn', {
          text: 'iOS Safari 會清除七天未使用的網站資料。加到主畫面後就不受這個限制，強烈建議現在就做。',
        }),
      el('div.row-list', {}, [
        rowButton('📲', installed ? '安裝方式說明' : '如何加到主畫面', openInstallHelp),
      ]),
    ]);
  }

  function openInstallHelp() {
    const guide = installGuide();

    openSheet('加到主畫面', (body) => {
      body.append(
        el('p.sheet__message', {
          text: '加到主畫面之後，從圖示開啟就是全螢幕、沒有網址列，跟一般 App 一樣，而且瀏覽器不會把資料當成一般網站清掉。',
        }),
        el('div.help-block', {}, [
          el('div.help-block__title', { text: guide.title }),
          el('ol.guide-list', {}, guide.steps.map((s) => el('li', { text: s }))),
        ]),
      );

      if (guide.warnings.length) {
        body.append(el('div.help-block', {}, [
          el('div.help-block__title', { text: '找不到選項時' }),
          el('ul.guide-list', {}, guide.warnings.map((w) => el('li', { text: w }))),
        ]));
      }

      body.append(el('p.hint.hint--block', {
        text: '安裝後請立刻做一次「匯出備份檔」。加到主畫面降低了資料被清掉的機率，但手機遺失或重置一樣救不回來。',
      }));
    });
  }

  function rowButton(icon, label, onClick, { danger = false, meta = '' } = {}) {
    return el(`button.row${danger ? '.is-danger' : ''}`, { type: 'button', onClick }, [
      el('span.row__icon', { text: icon }),
      el('span.row__label', { text: label }),
      meta ? el('span.row__meta', { text: meta }) : null,
      el('span.row__chevron', { text: '›' }),
    ]);
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
    renderDataCard();
    renderStorageCard();
  }

  return { node, refresh };
}
