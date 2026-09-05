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

export function createAssetsView() {
  const node = el('section.view.view--assets');
  const refs = {};

  build();

  function build() {
    clear(node);
    refs.hero = el('div.networth-hero');
    refs.groups = el('div.account-groups');
    refs.stocks = createStocksSection();

    node.append(
      refs.hero,
      refs.stocks.node,
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
    );

    refresh();
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
            text: acc.valuationMode === 'manual' ? `${kind.label}・手動估值` : `${kind.label}・自動累算`,
          }),
        ]),
        el(`span.account-row__balance${balance < 0 ? '.is-expense' : ''}`, {
          text: formatAmount(balance, { decimals: 'never' }),
        }),
      ]));
    }
    return list;
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
    renderHero();
    refs.stocks.refresh();
    renderGroups();
  }

  return { node, refresh };
}
