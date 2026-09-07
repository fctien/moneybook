/**
 * 資產頁：淨資產總覽與帳戶管理。
 *
 * 兩種帳戶估值方式：
 * - tracked（現金、銀行、信用卡）：餘額 = 期初餘額 + 交易累積，程式自己算
 * - manual （投資、不動產、保單、貸款）：餘額就是使用者填的數字
 *
 * 分開的理由是實務需求：股票市值和房價沒辦法靠記帳推算，
 * 只能定期手動更新一個估值；而現金和銀行如果也要手動填，記帳就失去意義了。
 */

import { el, clear, toast, openSheet, confirmDialog, haptic } from '../ui.js';
import { formatAmount, formatCurrency, parseAmount } from '../lib/money.js';
import { todayISO, formatDayLabel } from '../lib/dateutil.js';
import { accountBalances } from '../lib/stats.js';
import { ACCOUNT_KINDS, accountKind } from '../lib/schema.js';
import * as store from '../store.js';
import { createStocksSection } from './stocks.js';
import { createFundsSection } from './funds.js';

/** 資產頁裡的三個分頁。順序就是顯示順序。 */
const TABS = [
  { id: 'accounts', label: '帳戶' },
  { id: 'stocks', label: '股票' },
  { id: 'funds', label: '基金' },
];

/** 記住使用者上次停在哪一個分頁 */
const ASSETS_TAB_KEY = 'assetsTab';

export function createAssetsView() {
  const node = el('section.view.view--assets');
  const refs = {};
  // 初值為 true：build() 期間投資區塊會先呼叫一次 onChange，
  // 那時 hero 還沒掛上去，重畫沒有意義（而且緊接著就會 refresh()）。
  let rendering = true;
  let activeTab = 'accounts';

  build();

  /**
   * 資產頁分成三段而不是一條長捲軸。
   *
   * 原本是「淨資產 → 股票 → 基金 → 帳戶」一路往下接。持股一多（六十幾檔就有
   * 四千多像素），基金與帳戶就被推到捲軸深處，等於不存在 ——
   * 問題不在基金排最後，而是任何東西放在股票下面都會消失。
   *
   * 淨資產刻意留在分頁外面：它是這一頁要回答的問題，
   * 放進某一段就等於有三分之二的時間看不到。
   */
  function build() {
    clear(node);
    refs.hero = el('div.networth-hero');
    refs.segment = el('div.segment.segment--stacked');
    refs.tabHost = el('div.assets-tab');
    refs.groups = el('div.account-groups');

    refs.accountsNode = el('div', {}, [
      el('div.section-head', {}, [
        el('h2.section-head__title', { text: '帳戶與資產' }),
        el('button.link-btn', { type: 'button', onClick: () => openAccountEditor(null) }, ['+ 新增']),
      ]),
      refs.groups,
      el('p.hint.hint--block', {
        text: '現金、銀行、信用卡請用「自動累算」，餘額由每日記帳自己加減。'
          + '投資、不動產、貸款請用「手動估值」，直接填目前價值、定期更新即可 —— '
          + '這類帳戶不會出現在記帳頁，因為記在上面的收支並不會改變它們的估值。',
      }),
    ]);

    node.append(refs.hero, refs.segment, refs.tabHost);

    const saved = store.getSetting(ASSETS_TAB_KEY, '');
    if (TABS.some((t) => t.id === saved)) activeTab = saved;

    refresh();
  }

  /**
   * 投資區塊的市值會寫進綁定的帳戶，因此變動時淨資產要跟著更新。
   * rendering 旗標擋掉 refresh() → section.refresh() → onChange 的重複重畫。
   */
  function onModuleChange() {
    if (rendering) return;
    renderHero();
    renderSegment();
    if (activeTab === 'accounts') renderGroups();
  }

  /**
   * 分頁內容第一次打開時才建立。
   * 沒在看的分頁不必先把 DOM 做出來 —— 六十幾檔持股的列表尤其不值得。
   */
  function sectionFor(id) {
    if (id === 'stocks' || id === 'funds') {
      if (!refs[id]) {
        // 建立時區塊自己會 refresh 一次並回呼 onChange，那時還沒掛上畫面
        rendering = true;
        try {
          refs[id] = id === 'stocks'
            ? createStocksSection({ onChange: onModuleChange })
            : createFundsSection({ onChange: onModuleChange });
        } finally {
          rendering = false;
        }
      }
      return refs[id];
    }
    return { node: refs.accountsNode, refresh: renderGroups };
  }

  /**
   * 每一段標的是「筆數」而不是金額。
   *
   * 三段各放一個金額看起來很自然，但股票與基金的市值已經寫進它們綁定的帳戶裡，
   * 也就包含在帳戶合計中。三個金額並排會讓人以為要相加，一加就重複計算 ——
   * 筆數沒有這個歧義，而且同樣看得出「基金那裡有沒有東西」。
   */
  function tabCounts() {
    return {
      accounts: `${store.state.accounts.filter((a) => !a.archived).length} 個`,
      stocks: `${store.stockPositions().filter((p) => p.shares > 0).length} 檔`,
      funds: `${store.fundPositions().filter((p) => p.units > 0).length} 檔`,
    };
  }

  function renderSegment() {
    clear(refs.segment);
    const counts = tabCounts();

    for (const tab of TABS) {
      refs.segment.append(el(`button.segment__item${activeTab === tab.id ? '.is-active' : ''}`, {
        type: 'button',
        'aria-pressed': String(activeTab === tab.id),
        onClick: () => setTab(tab.id),
      }, [
        el('span', { text: tab.label }),
        el('span.segment__count', { text: counts[tab.id] }),
      ]));
    }
  }

  async function setTab(id) {
    if (id === activeTab) return;
    activeTab = id;
    refresh();

    // 換了分頁還停在原本的捲動位置，看到的會是新內容的中段
    const scroller = node.parentElement;
    if (scroller) scroller.scrollTop = 0;

    // silent：這裡已經自己重畫過了，再觸發一次全域通知只是把列表重畫第二次
    await store.setSetting(ASSETS_TAB_KEY, id, { silent: true });
  }

  function renderHero() {
    clear(refs.hero);
    const nw = store.currentNetWorth();

    refs.hero.append(
      el('div.networth-hero__label', { text: '淨資產' }),
      el(`div.networth-hero__value${nw.net < 0 ? '.is-negative' : ''}`, {
        text: formatCurrency(nw.net, { decimals: 'never' }),
      }),
      el('div.networth-hero__split', {}, [
        el('div.networth-hero__item', {}, [
          el('span.networth-hero__item-label', { text: '總資產' }),
          el('span.networth-hero__item-value.is-income', { text: formatAmount(nw.assets, { decimals: 'never' }) }),
        ]),
        el('div.networth-hero__item', {}, [
          el('span.networth-hero__item-label', { text: '總負債' }),
          el('span.networth-hero__item-value.is-expense', { text: formatAmount(nw.liabilities, { decimals: 'never' }) }),
        ]),
      ]),
      el('button.btn.btn--outline.btn--block', { type: 'button', onClick: saveSnapshot }, ['📸 儲存今日快照']),
      renderLastSnapshotHint(),
    );
  }

  function renderLastSnapshotHint() {
    const snapshots = store.sortedSnapshots();
    const last = snapshots[snapshots.length - 1];
    if (!last) {
      return el('p.hint.hint--center', { text: '存下快照後，報表頁就能畫出淨資產的變化趨勢。' });
    }
    const diff = store.currentNetWorth().net - last.net;
    const diffText = diff === 0
      ? '與上次快照相同'
      : `較上次${diff > 0 ? '增加' : '減少'} ${formatAmount(Math.abs(diff), { decimals: 'never' })}`;
    return el('p.hint.hint--center', { text: `上次快照：${formatDayLabel(last.date)}・${diffText}` });
  }

  async function saveSnapshot() {
    const result = await store.takeSnapshot('', todayISO());
    if (!result.ok) {
      toast(result.error, 'error');
      return;
    }
    haptic(15);
    toast(result.replaced ? '已更新今日快照' : '已儲存今日快照', 'success');
  }

  function renderGroups() {
    clear(refs.groups);

    const balances = accountBalances(store.state.accounts, store.state.transactions);
    const active = store.state.accounts.filter((a) => !a.archived);
    const archived = store.state.accounts.filter((a) => a.archived);

    if (!active.length) {
      refs.groups.append(el('div.empty', {}, [
        el('div.empty__icon', { text: '🏦' }),
        el('p.empty__text', { text: '還沒有任何帳戶' }),
        el('button.btn.btn--primary', { type: 'button', onClick: () => openAccountEditor(null) }, ['新增第一個帳戶']),
      ]));
      return;
    }

    const assets = active.filter((a) => (balances.get(a.id) ?? 0) >= 0);
    const liabilities = active.filter((a) => (balances.get(a.id) ?? 0) < 0);

    if (assets.length) refs.groups.append(renderGroup('資產', assets, balances));
    if (liabilities.length) refs.groups.append(renderGroup('負債', liabilities, balances));
    if (archived.length) refs.groups.append(renderGroup(`已封存（${archived.length}）`, archived, balances, true));
  }

  function renderGroup(title, accounts, balances, muted = false) {
    const list = el(`div.account-group${muted ? '.is-muted' : ''}`);
    list.append(el('div.account-group__title', { text: title }));

    for (const acc of accounts) {
      const kind = accountKind(acc.kind);
      const balance = balances.get(acc.id) ?? 0;

      list.append(el('button.account-row', {
        type: 'button',
        onClick: () => openAccountEditor(acc),
      }, [
        el('span.account-row__icon', { text: kind.icon }),
        el('span.account-row__main', {}, [
          el('span.account-row__name', { text: acc.name }),
          el('span.account-row__meta', {
            text: acc.valuationMode === 'manual'
              ? `${kind.label}・${boundModule(acc.id) ? `由${boundModule(acc.id)}自動估值` : '手動估值'}`
              : `${kind.label}・自動累算`,
          }),
        ]),
        el(`span.account-row__balance${balance < 0 ? '.is-expense' : ''}`, {
          text: formatAmount(balance, { decimals: 'never' }),
        }),
      ]));
    }
    return list;
  }

  /**
   * 這個帳戶的金額是不是由某個投資模組維護的？
   * 回傳模組名稱，沒被綁定就回 null。
   */
  function boundModule(accountId) {
    if (!accountId) return null;
    if (accountId === store.getSetting(store.STOCK_ACCOUNT_KEY, '')) return '股票投資';
    if (accountId === store.getSetting(store.FUND_ACCOUNT_KEY, '')) return '基金投資';
    return null;
  }

  /** 新增或編輯帳戶。account 為 null 時是新增。 */
  function openAccountEditor(account) {
    const isNew = !account;
    const draft = {
      id: account?.id,
      name: account?.name ?? '',
      kind: account?.kind ?? 'bank',
      valuationMode: account?.valuationMode ?? 'tracked',
      openingBalance: account?.openingBalance ?? 0,
      manualValue: account?.manualValue ?? 0,
      note: account?.note ?? '',
      archived: account?.archived ?? false,
      order: account?.order,
    };

    openSheet(isNew ? '新增帳戶' : '編輯帳戶', (body, close) => {
      const nameInput = el('input.text-input', {
        type: 'text',
        value: draft.name,
        placeholder: '例如：台新銀行、玉山信用卡',
        maxlength: '30',
        onInput: (e) => { draft.name = e.target.value; },
      });

      const kindGrid = el('div.kind-grid');
      const amountField = el('div.field');

      const renderKinds = () => {
        clear(kindGrid);
        for (const kind of ACCOUNT_KINDS) {
          kindGrid.append(el(`button.kind${draft.kind === kind.id ? '.is-active' : ''}`, {
            type: 'button',
            onClick: () => {
              draft.kind = kind.id;
              // 換種類時同步套用該種類的預設估值方式，但編輯既有帳戶時不覆蓋使用者的選擇
              if (isNew) draft.valuationMode = kind.defaultMode;
              renderKinds();
              renderAmountField();
            },
          }, [
            el('span.kind__icon', { text: kind.icon }),
            el('span.kind__label', { text: kind.label }),
          ]));
        }
      };

      const renderAmountField = () => {
        clear(amountField);
        const isManual = draft.valuationMode === 'manual';

        amountField.append(
          el('div.field__label', { text: '估值方式' }),
          el('div.segment.segment--sm', {}, [
            el(`button.segment__item${!isManual ? '.is-active' : ''}`, {
              type: 'button',
              onClick: () => { draft.valuationMode = 'tracked'; renderAmountField(); },
            }, ['自動累算']),
            el(`button.segment__item${isManual ? '.is-active' : ''}`, {
              type: 'button',
              onClick: () => { draft.valuationMode = 'manual'; renderAmountField(); },
            }, ['手動估值']),
          ]),
          el('p.hint', {
            text: isManual
              ? '直接填目前價值，不受記帳影響。適合股票、基金、不動產、貸款餘額。'
              : '填入目前餘額作為起點，之後每筆收支會自動加減。適合現金、銀行、信用卡。',
          }),
          el('div.field__label', { text: isManual ? '目前價值' : '目前餘額（作為起算點）' }),
          // 這個帳戶的金額由投資模組維護，手動改了下一次交易或更新報價就會被蓋回去。
          // 不講的話使用者會以為自己改的數字沒存進去。
          isManual && boundModule(account?.id)
            ? el('p.hint.hint--warn', {
              text: `這個帳戶的金額由「${boundModule(account.id)}」自動維護，`
                + '手動修改會在下次交易或更新報價時被覆蓋。'
                + `若要自己填，請先到${boundModule(account.id)}區塊取消連結。`,
            })
            : null,
          el('input.text-input.text-input--amount', {
            type: 'text',
            inputmode: 'decimal',
            value: String((isManual ? draft.manualValue : draft.openingBalance) / 100),
            placeholder: '0',
            onInput: (e) => {
              const cents = parseAmount(e.target.value);
              if (cents === null) return;
              if (isManual) draft.manualValue = cents;
              else draft.openingBalance = cents;
            },
          }),
          el('p.hint', { text: '負債請填負數，例如房貸餘額 600 萬就填 -6000000。' }),
        );
      };

      renderKinds();
      renderAmountField();

      body.append(
        el('div.field', {}, [el('div.field__label', { text: '名稱' }), nameInput]),
        el('div.field', {}, [el('div.field__label', { text: '種類' }), kindGrid]),
        amountField,
      );

      if (!isNew) {
        body.append(el('label.switch-row', {}, [
          el('span', { text: '封存這個帳戶' }),
          el('input', {
            type: 'checkbox',
            checked: draft.archived,
            onChange: (e) => { draft.archived = e.target.checked; },
          }),
        ]));
        body.append(el('p.hint', { text: '封存後不會出現在記帳選單與淨資產統計，但歷史紀錄保留。' }));
      }

      const actions = el('div.sheet__actions');
      if (!isNew) {
        actions.append(el('button.btn.btn--danger', {
          type: 'button',
          onClick: async () => {
            const usage = store.accountUsage(draft.id);
            if (usage > 0) {
              toast(`這個帳戶有 ${usage} 筆交易，請改用封存`, 'error');
              return;
            }
            const ok = await confirmDialog('刪除帳戶？', `確定要刪除「${draft.name}」嗎？`, { confirmText: '刪除', danger: true });
            if (!ok) return;
            const result = await store.deleteAccount(draft.id);
            if (!result.ok) { toast(result.error, 'error'); return; }
            toast('已刪除', 'success');
            close();
          },
        }, ['刪除']));
      }
      actions.append(el('button.btn.btn--primary', {
        type: 'button',
        onClick: async () => {
          const result = await store.saveAccount(draft);
          if (!result.ok) { toast(result.error, 'error'); return; }
          toast(isNew ? '已新增帳戶' : '已儲存', 'success');
          close();
        },
      }, [isNew ? '新增' : '儲存']));

      body.append(actions);
    });
  }

  function refresh() {
    rendering = true;
    try {
      renderHero();
      renderSegment();

      const section = sectionFor(activeTab);
      if (section.node.parentNode !== refs.tabHost) {
        clear(refs.tabHost);
        refs.tabHost.append(section.node);
      }
      section.refresh();
    } finally {
      rendering = false;
    }
  }

  return { node, refresh };
}
