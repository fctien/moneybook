/**
 * 明細頁：按月份瀏覽所有交易，可搜尋、編輯、刪除。
 */

import { el, clear, toast, openSheet, confirmDialog, haptic } from '../ui.js';
import { formatAmount, formatCurrency } from '../lib/money.js';
import {
  currentMonthKey, shiftMonth, formatMonthLabel, formatRelativeDay, formatDayLabel,
} from '../lib/dateutil.js';
import { filterByMonth, summarize, groupByDay } from '../lib/stats.js';
import * as store from '../store.js';

const TYPE_LABEL = { income: '收入', expense: '支出', transfer: '轉帳' };

export function createLedgerView({ onEdit } = {}) {
  let monthKey = currentMonthKey();
  let keyword = '';

  const node = el('section.view.view--ledger');
  const refs = {};

  build();

  function build() {
    clear(node);

    refs.monthLabel = el('div.month-nav__label');
    refs.summary = el('div.summary-cards');
    refs.list = el('div.tx-list');
    refs.search = el('input.search-input', {
      type: 'search',
      placeholder: '搜尋備註或分類',
      onInput: (e) => { keyword = e.target.value.trim(); renderList(); },
    });

    node.append(
      el('div.month-nav', {}, [
        el('button.icon-btn', { type: 'button', 'aria-label': '上個月', onClick: () => stepMonth(-1) }, ['‹']),
        refs.monthLabel,
        el('button.icon-btn', { type: 'button', 'aria-label': '下個月', onClick: () => stepMonth(1) }, ['›']),
      ]),
      refs.summary,
      el('div.search-row', {}, [refs.search]),
      refs.list,
    );

    refresh();
  }

  function stepMonth(delta) {
    monthKey = shiftMonth(monthKey, delta);
    haptic();
    refresh();
  }

  function monthTransactions() {
    return filterByMonth(store.state.transactions, monthKey);
  }

  function renderHeader() {
    clear(refs.monthLabel);
    refs.monthLabel.append(el('span', { text: formatMonthLabel(monthKey) }));
    if (monthKey !== currentMonthKey()) {
      refs.monthLabel.append(el('button.link-btn', {
        type: 'button',
        onClick: () => { monthKey = currentMonthKey(); refresh(); },
      }, ['回本月']));
    }
  }

  function renderSummary() {
    clear(refs.summary);
    const s = summarize(monthTransactions());
    const cards = [
      { label: '收入', value: s.income, cls: 'is-income' },
      { label: '支出', value: s.expense, cls: 'is-expense' },
      { label: '結餘', value: s.net, cls: s.net >= 0 ? 'is-income' : 'is-expense' },
    ];
    for (const card of cards) {
      refs.summary.append(el(`div.summary-card.${card.cls}`, {}, [
        el('div.summary-card__label', { text: card.label }),
        el('div.summary-card__value', { text: formatAmount(card.value, { decimals: 'never' }) }),
      ]));
    }
  }

  function renderList() {
    clear(refs.list);

    const accounts = store.accountMap();
    const categories = store.categoryMap();
    let rows = monthTransactions();

    if (keyword) {
      const kw = keyword.toLowerCase();
      rows = rows.filter((tx) => {
        const cat = categories.get(tx.categoryId)?.name ?? '';
        const acc = accounts.get(tx.accountId)?.name ?? '';
        return (
          (tx.note ?? '').toLowerCase().includes(kw)
          || cat.toLowerCase().includes(kw)
          || acc.toLowerCase().includes(kw)
          || String(tx.amount / 100).includes(kw)
        );
      });
    }

    if (!rows.length) {
      refs.list.append(el('div.empty', {}, [
        el('div.empty__icon', { text: keyword ? '🔍' : '📝' }),
        el('p.empty__text', { text: keyword ? '找不到符合的紀錄' : `${formatMonthLabel(monthKey)}還沒有任何紀錄` }),
      ]));
      return;
    }

    for (const day of groupByDay(rows)) {
      const dayNet = day.income - day.expense;
      refs.list.append(el('div.day-header', {}, [
        el('span.day-header__date', { text: formatRelativeDay(day.date) }),
        el('span.day-header__sum', {
          text: `${day.income ? '收 ' + formatAmount(day.income, { decimals: 'never' }) + '　' : ''}${day.expense ? '支 ' + formatAmount(day.expense, { decimals: 'never' }) : ''}`.trim()
            || (dayNet === 0 ? '' : formatAmount(dayNet, { decimals: 'never' })),
        }),
      ]));

      for (const tx of day.items) {
        refs.list.append(renderRow(tx, accounts, categories));
      }
    }
  }

  function renderRow(tx, accounts, categories) {
    const cat = categories.get(tx.categoryId);
    const acc = accounts.get(tx.accountId);
    const toAcc = accounts.get(tx.toAccountId);

    const isTransfer = tx.type === 'transfer';
    const icon = isTransfer ? '🔁' : cat?.icon ?? '📌';
    const title = isTransfer ? `${acc?.name ?? '?'} → ${toAcc?.name ?? '?'}` : cat?.name ?? '未分類';
    const sub = [tx.note, isTransfer ? null : acc?.name].filter(Boolean).join('・');

    const amountClass = isTransfer ? 'is-transfer' : tx.type === 'income' ? 'is-income' : 'is-expense';
    const prefix = isTransfer ? '' : tx.type === 'income' ? '+' : '-';

    return el('button.tx-row', {
      type: 'button',
      onClick: () => openDetail(tx),
    }, [
      el('span.tx-row__icon', {
        text: icon,
        style: cat?.color && !isTransfer ? { background: `${cat.color}22` } : {},
      }),
      el('span.tx-row__main', {}, [
        el('span.tx-row__title', { text: title }),
        sub ? el('span.tx-row__sub', { text: sub }) : null,
      ]),
      el(`span.tx-row__amount.${amountClass}`, { text: prefix + formatAmount(tx.amount) }),
    ]);
  }

  function openDetail(tx) {
    const accounts = store.accountMap();
    const categories = store.categoryMap();
    const cat = categories.get(tx.categoryId);

    openSheet('交易明細', (body, close) => {
      const rows = [
        ['金額', formatCurrency(tx.amount)],
        ['類型', TYPE_LABEL[tx.type] ?? tx.type],
        ['日期', formatDayLabel(tx.date)],
      ];
      if (tx.type === 'transfer') {
        rows.push(['轉出', accounts.get(tx.accountId)?.name ?? '（已刪除）']);
        rows.push(['轉入', accounts.get(tx.toAccountId)?.name ?? '（已刪除）']);
      } else {
        rows.push(['分類', cat ? `${cat.icon} ${cat.name}` : '（已刪除）']);
        rows.push(['帳戶', accounts.get(tx.accountId)?.name ?? '（已刪除）']);
      }
      if (tx.note) rows.push(['備註', tx.note]);

      const table = el('dl.detail-list');
      for (const [label, value] of rows) {
        table.append(el('dt', { text: label }), el('dd', { text: value }));
      }

      body.append(
        table,
        el('div.sheet__actions', {}, [
          el('button.btn.btn--danger', {
            type: 'button',
            onClick: async () => {
              const ok = await confirmDialog('刪除這筆紀錄？', '刪除後無法復原。', { confirmText: '刪除', danger: true });
              if (!ok) return;
              await store.deleteTransaction(tx.id);
              toast('已刪除', 'success');
              close();
            },
          }, ['刪除']),
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: () => { close(); onEdit?.(tx); },
          }, ['編輯']),
        ]),
      );
    });
  }

  function refresh() {
    renderHeader();
    renderSummary();
    renderList();
  }

  /** 切到明細頁時跳到指定月份 */
  function goToMonth(key) {
    monthKey = key;
    refresh();
  }

  return { node, refresh, goToMonth };
}
