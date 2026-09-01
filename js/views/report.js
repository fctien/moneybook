/**
 * 報表頁：月收支趨勢、分類佔比、淨資產走勢。
 *
 * 圖表繪製都排在 requestAnimationFrame 裡，因為 Canvas 需要先知道自己的
 * CSS 尺寸才能設定正確的解析度；在版面尚未完成配置時畫會得到 0 寬度的空白圖。
 */

import { el, clear } from '../ui.js';
import { formatAmount, formatCurrency } from '../lib/money.js';
import {
  currentMonthKey, shiftMonth, formatMonthLabel, recentMonths, formatMonthShort, formatDayLabel,
} from '../lib/dateutil.js';
import {
  filterByMonth, summarize, groupByCategory, groupByMonth, dailyAverageExpense,
} from '../lib/stats.js';
import { drawMonthlyBars, drawDonut, drawLine } from '../chart.js';
import * as store from '../store.js';

export function createReportView() {
  let monthKey = currentMonthKey();
  let breakdownType = 'expense';

  const node = el('section.view.view--report');
  const refs = {};
  let rafId = null;
  let fallbackTimer = null;

  build();

  // 轉向或視窗尺寸改變時要重畫，否則圖表會被拉伸變形
  const onResize = () => scheduleDraw();
  globalThis.addEventListener('resize', onResize);
  globalThis.addEventListener('orientationchange', onResize);

  // 從背景切回前景時補畫一次：頁面被凍結期間排隊的繪製有可能被丟掉
  const onVisible = () => {
    if (document.visibilityState === 'visible') scheduleDraw();
  };
  document.addEventListener('visibilitychange', onVisible);

  function build() {
    clear(node);

    refs.monthLabel = el('div.month-nav__label');
    refs.stats = el('div.stat-row');
    refs.barCanvas = el('canvas.chart.chart--bars', { height: '170' });
    refs.donutCanvas = el('canvas.chart.chart--donut', { height: '170' });
    refs.breakdownList = el('div.breakdown-list');
    refs.breakdownToggle = el('div.segment.segment--sm');
    refs.lineCanvas = el('canvas.chart.chart--line', { height: '170' });
    refs.snapshotHint = el('p.hint.hint--center');

    node.append(
      el('div.month-nav', {}, [
        el('button.icon-btn', { type: 'button', 'aria-label': '上個月', onClick: () => stepMonth(-1) }, ['‹']),
        refs.monthLabel,
        el('button.icon-btn', { type: 'button', 'aria-label': '下個月', onClick: () => stepMonth(1) }, ['›']),
      ]),
      refs.stats,
      card('近 6 個月收支', [
        refs.barCanvas,
        el('div.legend', {}, [
          legendItem('收入', 'var(--c-income)'),
          legendItem('支出', 'var(--c-expense)'),
        ]),
      ]),
      card('本月分類佔比', [refs.breakdownToggle, refs.donutCanvas, refs.breakdownList]),
      card('淨資產趨勢', [refs.lineCanvas, refs.snapshotHint]),
    );

    buildToggle();
    refresh();
  }

  function card(title, children) {
    return el('section.card', {}, [el('h2.card__title', { text: title }), ...children]);
  }

  function legendItem(label, color) {
    return el('span.legend__item', {}, [
      el('span.legend__dot', { style: { background: color } }),
      label,
    ]);
  }

  function buildToggle() {
    clear(refs.breakdownToggle);
    for (const [id, label] of [['expense', '支出'], ['income', '收入']]) {
      refs.breakdownToggle.append(el(`button.segment__item${breakdownType === id ? '.is-active' : ''}`, {
        type: 'button',
        onClick: () => {
          breakdownType = id;
          buildToggle();
          renderBreakdown();
          scheduleDraw();
        },
      }, [label]));
    }
  }

  function stepMonth(delta) {
    monthKey = shiftMonth(monthKey, delta);
    refresh();
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

  function renderStats() {
    clear(refs.stats);
    const rows = filterByMonth(store.state.transactions, monthKey);
    const s = summarize(rows);
    const avg = dailyAverageExpense(store.state.transactions, monthKey, new Date().toISOString().slice(0, 10));
    const biggest = rows
      .filter((t) => t.type === 'expense')
      .reduce((max, t) => (t.amount > (max?.amount ?? 0) ? t : max), null);

    const items = [
      { label: '本月結餘', value: formatAmount(s.net, { decimals: 'never', sign: true }), cls: s.net >= 0 ? 'is-income' : 'is-expense' },
      { label: '日均支出', value: formatAmount(avg, { decimals: 'never' }), cls: '' },
      { label: '筆數', value: String(s.count), cls: '' },
      {
        label: '最大單筆',
        value: biggest ? formatAmount(biggest.amount, { decimals: 'never' }) : '—',
        cls: '',
      },
    ];

    for (const item of items) {
      refs.stats.append(el('div.stat', {}, [
        el('div.stat__label', { text: item.label }),
        el(`div.stat__value${item.cls ? '.' + item.cls : ''}`, { text: item.value }),
      ]));
    }
  }

  function renderBreakdown() {
    clear(refs.breakdownList);
    const categories = store.categoryMap();
    const rows = groupByCategory(filterByMonth(store.state.transactions, monthKey), breakdownType);

    if (!rows.length) {
      refs.breakdownList.append(el('p.hint.hint--center', {
        text: `本月沒有${breakdownType === 'expense' ? '支出' : '收入'}紀錄`,
      }));
      return;
    }

    for (const row of rows) {
      const cat = categories.get(row.categoryId);
      const color = cat?.color ?? '#94a3b8';
      refs.breakdownList.append(el('div.breakdown', {}, [
        el('span.breakdown__icon', { text: cat?.icon ?? '📌' }),
        el('span.breakdown__main', {}, [
          el('span.breakdown__name', { text: cat?.name ?? '未分類' }),
          el('span.breakdown__bar', {}, [
            el('span.breakdown__bar-fill', { style: { width: `${Math.max(2, row.pct)}%`, background: color } }),
          ]),
        ]),
        el('span.breakdown__figures', {}, [
          el('span.breakdown__amount', { text: formatAmount(row.total, { decimals: 'never' }) }),
          el('span.breakdown__pct', { text: `${row.pct.toFixed(1)}%` }),
        ]),
      ]));
    }
  }

  function renderSnapshotHint() {
    const snapshots = store.sortedSnapshots();
    if (!snapshots.length) {
      refs.snapshotHint.textContent = '到「資產」頁按下「儲存今日快照」，累積兩筆以上就會出現趨勢線。';
      return;
    }
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    if (snapshots.length === 1) {
      refs.snapshotHint.textContent = `目前只有 1 筆快照（${formatDayLabel(first.date)}），下個月再存一次就能看到變化。`;
      return;
    }
    const diff = last.net - first.net;
    refs.snapshotHint.textContent = `${formatDayLabel(first.date)} 至 ${formatDayLabel(last.date)}：`
      + `${diff >= 0 ? '增加' : '減少'} ${formatCurrency(Math.abs(diff), { decimals: 'never' })}`;
  }

  /**
   * 把繪製排到下一個影格，並避免同一影格內重複繪製。
   *
   * 同時掛一個計時器兜底：requestAnimationFrame 在分頁被移到背景、
   * 某些 WebView、以及 iOS PWA 從凍結狀態恢復時可能完全不觸發。
   * 只靠 rAF 的話那個回呼會永遠不執行，排隊旗標卡住，
   * 後續每一次重繪請求都被吞掉，圖表就再也畫不出來了。
   */
  function scheduleDraw() {
    if (rafId !== null || fallbackTimer !== null) return;

    const run = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      rafId = null;
      fallbackTimer = null;
      draw();
    };

    rafId = requestAnimationFrame(run);
    fallbackTimer = setTimeout(run, 120);
  }

  function draw() {
    // 頁面被隱藏時 canvas 寬度為 0，畫了也是白工，等切回來再畫
    if (!node.isConnected || node.offsetParent === null) return;

    const months = recentMonths(monthKey, 6);
    const monthRows = groupByMonth(store.state.transactions, months);
    const spansYears = new Set(months.map((m) => m.slice(0, 4))).size > 1;
    drawMonthlyBars(refs.barCanvas, monthRows, {
      labels: months.map((m) => formatMonthShort(m, spansYears)),
    });

    const categories = store.categoryMap();
    const breakdown = groupByCategory(filterByMonth(store.state.transactions, monthKey), breakdownType);
    const total = breakdown.reduce((a, r) => a + r.total, 0);
    drawDonut(
      refs.donutCanvas,
      breakdown.map((row) => ({
        label: categories.get(row.categoryId)?.name ?? '未分類',
        value: row.total,
        color: categories.get(row.categoryId)?.color ?? '#94a3b8',
      })),
      {
        centerTop: breakdownType === 'expense' ? '本月支出' : '本月收入',
        centerBottom: formatAmount(total, { decimals: 'never' }),
      },
    );

    drawLine(
      refs.lineCanvas,
      store.sortedSnapshots().map((s) => ({
        label: s.date.slice(5).replace('-', '/'),
        value: s.net,
      })),
    );
  }

  function refresh() {
    renderHeader();
    renderStats();
    renderBreakdown();
    renderSnapshotHint();
    scheduleDraw();
  }

  function destroy() {
    globalThis.removeEventListener('resize', onResize);
    globalThis.removeEventListener('orientationchange', onResize);
    document.removeEventListener('visibilitychange', onVisible);
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
  }

  return { node, refresh, destroy };
}
