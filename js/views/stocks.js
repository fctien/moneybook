/**
 * 資產頁裡的「股票投資」區塊。
 *
 * 沒有另開分頁：股票本來就是資產的一部分，放在資產頁裡，
 * 市值才會和現金、房貸並列成同一個淨資產數字。底部分頁維持五個也比較好按。
 *
 * 本階段（第一階段）只做手動輸入。自動抓股價是第三階段，
 * 屆時會是「預設關閉、使用者自行開啟」的選項 —— 抓價會把持股代號送到外部服務。
 */

import { el, clear, toast, openSheet, confirmDialog, haptic } from '../ui.js';
import { formatAmount, formatCurrency, parseAmount } from '../lib/money.js';
import { todayISO, formatDayLabel } from '../lib/dateutil.js';
import { ACTION, estimateFee, estimateTax, byMarketValue } from '../lib/portfolio.js';
import * as store from '../store.js';

const ACTION_LABEL = {
  [ACTION.OPENING]: '期初持股',
  [ACTION.BUY]: '買進',
  [ACTION.SELL]: '賣出',
  [ACTION.DIVIDEND]: '現金股利',
  [ACTION.STOCK_DIV]: '股票股利',
};

export function createStocksSection() {
  const node = el('section.stocks');
  const refs = {};

  build();

  function build() {
    clear(node);
    refs.summary = el('div.stock-summary');
    refs.list = el('div.stock-list');

    node.append(
      el('div.section-head', {}, [
        el('h2.section-head__title', { text: '股票投資' }),
        el('button.link-btn', { type: 'button', onClick: () => openHoldingEditor() }, ['+ 新增持股']),
      ]),
      refs.summary,
      refs.list,
    );

    refresh();
  }

  function refresh() {
    const s = store.portfolioSummary();
    renderSummary(s);
    renderList(s);
  }

  // ---------------------------------------------------------------- 總覽

  function renderSummary(s) {
    clear(refs.summary);

    if (!s.heldCount) {
      refs.summary.append(el('p.hint', {
        text: '還沒有持股。按「+ 新增持股」填入代號、股數與平均成本即可開始追蹤。',
      }));
      return;
    }

    const cells = [
      ['市值', s.pricedCount ? formatAmount(s.marketValue) : '—'],
      ['成本', formatAmount(s.totalCost)],
    ];

    // 只有全部持股都有報價，未實現損益才是完整的數字。
    // 少算一檔卻照樣顯示總額，會讓人誤以為自己在虧損。
    if (s.complete) {
      const sign = s.unrealized >= 0 ? '+' : '';
      cells.push(['未實現損益', `${sign}${formatAmount(s.unrealized)}`]);
      cells.push(['報酬率', s.returnRate === null ? '—' : `${(s.returnRate * 100).toFixed(1)}%`]);
    }

    refs.summary.append(el('div.stat-row', {}, cells.map(([label, value]) => el('div.stat', {}, [
      el('div.stat__label', { text: label }),
      el('div.stat__value', { text: value }),
    ]))));

    if (!s.complete && s.missingQuotes.length) {
      refs.summary.append(el('p.hint.hint--warn', {
        text: `${s.missingQuotes.join('、')} 還沒有股價，因此不計入市值與損益。點該檔可以填入目前股價。`,
      }));
    }

    if (s.realized !== 0) {
      const sign = s.realized >= 0 ? '+' : '';
      refs.summary.append(el('p.hint', {
        text: `累計已實現損益 ${sign}${formatAmount(s.realized)}`
          + (s.dividends ? `（含股利 ${formatAmount(s.dividends)}）` : ''),
      }));
    }

    // 目前刻意不把股票市值加進上方的淨資產。
    // 多數人早就用「手動估值」開了一個證券帳戶，若這裡再自動加一次就會重複計算，
    // 而重複計算的淨資產比沒有數字更危險 —— 使用者不會發現自己多算了一份。
    // 等之後能自動抓股價時，會改成由這裡直接更新那個帳戶的估值。
    refs.summary.append(el('p.hint', {
      text: '股票市值目前不會自動計入上方的淨資產，避免與「手動估值」的證券帳戶重複計算。'
        + '請自行把上面的市值填進該帳戶。',
    }));
  }

  // ---------------------------------------------------------------- 列表

  function renderList(s) {
    clear(refs.list);
    const held = byMarketValue(s.rows);
    if (!held.length) return;

    for (const r of held) {
      const gain = r.unrealized;
      const cls = gain === null ? '' : gain >= 0 ? ' is-up' : ' is-down';

      refs.list.append(el('button.stock-row', {
        type: 'button',
        onClick: () => openHoldingDetail(r.symbol),
      }, [
        el('div.stock-row__main', {}, [
          el('div.stock-row__title', { text: r.name ? `${r.symbol} ${r.name}` : r.symbol }),
          el('div.stock-row__sub', {
            text: `${r.shares} 股・均價 ${formatAmount(Math.round(r.avgCost))}`
              + (r.price ? `　現價 ${formatAmount(r.price)}` : ''),
          }),
        ]),
        el('div.stock-row__right', {}, [
          el('div.stock-row__value', { text: r.marketValue === null ? '未填股價' : formatAmount(r.marketValue) }),
          el(`div.stock-row__gain${cls}`, {
            text: gain === null ? '' : `${gain >= 0 ? '+' : ''}${formatAmount(gain)}`
              + (r.returnRate === null ? '' : `　${(r.returnRate * 100).toFixed(1)}%`),
          }),
        ]),
      ]));
    }

    // 已清空但有損益的部位單獨列出，否則賣掉之後那筆獲利就消失了
    const closed = s.rows.filter((r) => r.shares === 0 && r.realized !== 0);
    if (closed.length) {
      refs.list.append(el('p.hint.hint--block', {
        text: `已結清：${closed.map((r) => `${r.symbol} ${r.realized >= 0 ? '+' : ''}${formatAmount(r.realized)}`).join('、')}`,
      }));
    }
  }

  // ---------------------------------------------------------------- 新增持股

  function openHoldingEditor() {
    openSheet('新增持股', (body, close) => {
      const f = {
        symbol: el('input.input', { type: 'text', placeholder: '例如 2330', maxlength: '12' }),
        name: el('input.input', { type: 'text', placeholder: '例如 台積電（選填）', maxlength: '20' }),
        shares: el('input.input', { type: 'number', inputmode: 'numeric', placeholder: '例如 1000' }),
        cost: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '每股平均成本' }),
        price: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '目前股價（選填）' }),
        date: el('input.input', { type: 'date', value: todayISO() }),
      };

      body.append(
        el('p.sheet__message', {
          text: '填入目前的持股狀況即可，不必回頭補所有交易紀錄。之後的買賣再逐筆記錄。',
        }),
        field('股票代號', f.symbol),
        field('名稱', f.name),
        field('股數', f.shares),
        field('每股平均成本', f.cost),
        field('目前股價', f.price),
        field('起算日期', f.date),
        el('p.hint', { text: '沒填股價也可以，只是暫時看不到市值與損益，之後再補。' }),
        el('div.sheet__actions', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async () => {
              const symbol = f.symbol.value.trim().toUpperCase();
              const shares = Number(f.shares.value);
              const cost = parseAmount(f.cost.value);

              if (!symbol) return toast('請輸入股票代號', 'error');
              if (!Number.isInteger(shares) || shares <= 0) return toast('股數要是大於 0 的整數', 'error');
              if (cost === null || cost <= 0) return toast('請輸入每股平均成本', 'error');

              const r = await store.saveStockTrade({
                date: f.date.value || todayISO(),
                symbol,
                name: f.name.value.trim(),
                action: ACTION.OPENING,
                shares,
                price: cost,
              });
              if (!r.ok) return toast(r.error, 'error');

              const price = parseAmount(f.price.value);
              if (price !== null && price > 0) await store.setQuote(symbol, price);

              haptic(15);
              toast(`已加入 ${symbol}`, 'success');
              close();
            },
          }, ['加入']),
        ]),
      );
    });
  }

  // ---------------------------------------------------------------- 個股明細

  function openHoldingDetail(symbol) {
    const render = (body, close) => {
      clear(body);

      const s = store.portfolioSummary();
      const row = s.rows.find((r) => r.symbol === symbol);
      if (!row) return close();

      const rerender = () => render(body, close);

      body.append(el('div.stat-row', {}, [
        ['股數', String(row.shares)],
        ['均價', formatAmount(Math.round(row.avgCost))],
        ['市值', row.marketValue === null ? '—' : formatAmount(row.marketValue)],
      ].map(([l, v]) => el('div.stat', {}, [
        el('div.stat__label', { text: l }),
        el('div.stat__value', { text: v }),
      ]))));

      if (row.unrealized !== null) {
        const sign = row.unrealized >= 0 ? '+' : '';
        body.append(el('p.hint', {
          text: `未實現損益 ${sign}${formatAmount(row.unrealized)}`
            + (row.returnRate === null ? '' : `（${(row.returnRate * 100).toFixed(1)}%）`),
        }));
      }
      if (row.realized !== 0) {
        body.append(el('p.hint', {
          text: `已實現損益 ${row.realized >= 0 ? '+' : ''}${formatAmount(row.realized)}`,
        }));
      }
      for (const w of row.warnings) {
        body.append(el('p.hint.hint--warn', { text: w }));
      }

      body.append(el('div.row-list', {}, [
        rowBtn('📈', '買進', () => openTradeEditor(symbol, ACTION.BUY, rerender)),
        rowBtn('📉', '賣出', () => openTradeEditor(symbol, ACTION.SELL, rerender)),
        rowBtn('💰', '現金股利', () => openTradeEditor(symbol, ACTION.DIVIDEND, rerender)),
        rowBtn('🎁', '股票股利', () => openTradeEditor(symbol, ACTION.STOCK_DIV, rerender)),
        rowBtn('🏷', '更新股價', () => openQuoteEditor(symbol, rerender)),
      ]));

      // 交易明細
      const trades = [...store.tradesOf(symbol)].sort((a, b) => (a.date < b.date ? 1 : -1));
      body.append(el('div.section-head', {}, [el('h2.section-head__title', { text: `交易紀錄（${trades.length}）` })]));

      for (const t of trades) {
        body.append(el('div.trade-row', {}, [
          el('div.trade-row__main', {}, [
            el('div.trade-row__title', { text: `${ACTION_LABEL[t.action] ?? t.action}` }),
            el('div.trade-row__sub', { text: formatDayLabel(t.date) }),
          ]),
          el('div.trade-row__amount', { text: describeTrade(t) }),
          el('button.icon-btn', {
            type: 'button',
            'aria-label': '刪除這筆',
            onClick: async () => {
              const ok = await confirmDialog('刪除這筆交易', `${formatDayLabel(t.date)} ${ACTION_LABEL[t.action]}`, { danger: true });
              if (!ok) return;
              await store.deleteStockTrade(t.id);
              rerender();
            },
          }, ['✕']),
        ]));
      }

      body.append(el('div.sheet__actions', {}, [
        el('button.btn.btn--ghost.is-danger', {
          type: 'button',
          onClick: async () => {
            const ok = await confirmDialog(
              `刪除 ${symbol}`,
              `會一併刪掉這檔的 ${trades.length} 筆交易紀錄，無法復原。`,
              { danger: true, confirmText: '刪除' },
            );
            if (!ok) return;
            await store.deleteSymbol(symbol);
            toast(`已刪除 ${symbol}`, 'success');
            close();
          },
        }, ['刪除這檔股票']),
      ]));
    };

    openSheet(symbol, render);
  }

  // ---------------------------------------------------------------- 交易輸入

  function openTradeEditor(symbol, action, onDone) {
    openSheet(`${symbol}　${ACTION_LABEL[action]}`, (body, close) => {
      const isCash = action === ACTION.DIVIDEND;
      const isStockDiv = action === ACTION.STOCK_DIV;

      const f = {
        date: el('input.input', { type: 'date', value: todayISO() }),
        shares: el('input.input', { type: 'number', inputmode: 'numeric', placeholder: '股數' }),
        price: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '每股價格' }),
        amount: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '股利總額' }),
        fee: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '自動試算' }),
        tax: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '自動試算' }),
      };

      // 手續費與證交稅依成交金額自動帶入，但保留讓使用者覆寫 —— 每家券商折扣不同
      const autoFill = () => {
        const shares = Number(f.shares.value);
        const price = parseAmount(f.price.value);
        if (!Number.isInteger(shares) || shares <= 0 || price === null || price <= 0) return;
        const gross = shares * price;
        f.fee.value = (estimateFee(gross) / 100).toFixed(2);
        if (action === ACTION.SELL) f.tax.value = (estimateTax(gross) / 100).toFixed(2);
      };
      f.shares.addEventListener('input', autoFill);
      f.price.addEventListener('input', autoFill);

      body.append(field('日期', f.date));
      if (isCash) {
        body.append(field('股利總額', f.amount));
      } else {
        body.append(field('股數', f.shares));
        if (!isStockDiv) {
          body.append(
            field('每股價格', f.price),
            field('手續費', f.fee),
          );
          if (action === ACTION.SELL) body.append(field('證交稅', f.tax));
          body.append(el('p.hint', { text: '手續費 0.1425%、證交稅 0.3% 會自動試算，可依券商折扣自行修改。' }));
        } else {
          body.append(el('p.hint', { text: '無償配股只增加股數，總成本不變，平均成本會因此下降。' }));
        }
      }

      body.append(el('div.sheet__actions', {}, [
        el('button.btn.btn--primary', {
          type: 'button',
          onClick: async () => {
            const payload = {
              date: f.date.value || todayISO(),
              symbol,
              action,
              shares: Number(f.shares.value) || 0,
              price: parseAmount(f.price.value) ?? 0,
              fee: parseAmount(f.fee.value) ?? 0,
              tax: parseAmount(f.tax.value) ?? 0,
              amount: parseAmount(f.amount.value) ?? 0,
            };
            const r = await store.saveStockTrade(payload);
            if (!r.ok) return toast(r.error, 'error');

            haptic(15);
            toast('已記錄', 'success');
            close();
            onDone?.();
          },
        }, ['記錄']),
      ]));
    });
  }

  function openQuoteEditor(symbol, onDone) {
    openSheet(`${symbol}　更新股價`, (body, close) => {
      const current = store.state.quotes[symbol];
      const input = el('input.input', {
        type: 'text', inputmode: 'decimal',
        placeholder: '每股價格',
        value: current ? (current.close / 100).toFixed(2) : '',
      });

      body.append(
        field('目前股價', input),
        el('p.hint', {
          text: current
            ? `上次更新：${formatDayLabel(current.date)}`
            : '第一次填入股價。自動抓取股價會在後續版本提供，屆時是可自行開啟的選項。',
        }),
        el('div.sheet__actions', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async () => {
              const price = parseAmount(input.value);
              if (price === null || price <= 0) return toast('請輸入正確的股價', 'error');
              await store.setQuote(symbol, price);
              toast('已更新股價', 'success');
              close();
              onDone?.();
            },
          }, ['儲存']),
        ]),
      );
    });
  }

  // ---------------------------------------------------------------- 小工具

  function field(label, input) {
    return el('div.field', {}, [el('div.field__label', { text: label }), input]);
  }

  function rowBtn(icon, label, onClick) {
    return el('button.row', { type: 'button', onClick }, [
      el('span.row__icon', { text: icon }),
      el('span.row__label', { text: label }),
      el('span.row__chevron', { text: '›' }),
    ]);
  }

  function describeTrade(t) {
    if (t.action === ACTION.DIVIDEND) return formatCurrency(t.amount);
    if (t.action === ACTION.STOCK_DIV) return `+${t.shares} 股`;
    const sign = t.action === ACTION.SELL ? '-' : '+';
    return `${sign}${t.shares} 股　${formatAmount(t.price)}`;
  }

  return { node, refresh };
}
