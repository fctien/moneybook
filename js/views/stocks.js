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

/**
 * 平均成本的顯示格式。
 *
 * 這個值是「總成本 ÷ 股數」除出來的，四捨五入到兩位會變成 8.74，
 * 而券商顯示的是 8.7423 —— 對帳時看起來就像算錯了。
 * 因此最多留四位小數，並去掉尾端多餘的零。
 */
function formatUnitPrice(cents) {
  if (!Number.isFinite(cents)) return '—';
  const v = cents / 100;
  const text = v.toFixed(4).replace(/\.?0+$/, '');
  const [int, frac] = text.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** 每股金額（分）轉成輸入框用的文字，最多四位小數且不留尾端的零 */
function unitText(cents) {
  if (!Number.isFinite(cents)) return '';
  return (cents / 100).toFixed(4).replace(/\.?0+$/, '');
}

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
        el('div.section-head__actions', {}, [
          el('button.link-btn', {
            type: 'button',
            onClick: async () => {
              const { openStockImport } = await import('./stockimport.js');
              openStockImport({ onDone: refresh });
            },
          }, ['匯入']),
          el('button.link-btn', { type: 'button', onClick: () => openHoldingEditor() }, ['+ 新增持股']),
        ]),
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

    if (s.missingQuotes.length) {
      refs.summary.append(el('p.hint.hint--warn', {
        text: `${s.missingQuotes.join('、')} 還沒有股價，因此不計入市值與損益。點該檔可以填入目前股價。`,
      }));
    }

    if (s.missingCost?.length) {
      refs.summary.append(el('p.hint.hint--warn', {
        text: `${s.missingCost.join('、')} 的成本待補，因此不顯示損益。`
          + '點該檔用「買進」補一筆，或到「+ 新增持股」重新填入平均成本。',
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
            text: `${r.shares} 股・`
              + (r.costUnknown ? '成本待補' : `均價 ${formatUnitPrice(r.avgCost)}`)
              + (r.price ? `　現價 ${formatUnitPrice(r.price)}` : ''),
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
        ['均價', row.costUnknown ? '待補' : formatUnitPrice(row.avgCost)],
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
        rowBtn('✏️', '修改代號與名稱', () => openSymbolEditor(symbol, rerender)),
      ]));

      // 交易明細
      const trades = [...store.tradesOf(symbol)].sort((a, b) => (a.date < b.date ? 1 : -1));
      body.append(el('div.section-head', {}, [el('h2.section-head__title', { text: `交易紀錄（${trades.length}）` })]));

      body.append(el('p.hint', { text: '點任何一筆可以修改或刪除。' }));

      for (const t of trades) {
        body.append(el('button.trade-row.trade-row--tappable', {
          type: 'button',
          onClick: () => openTradeEditor(symbol, t.action, rerender, t),
        }, [
          el('div.trade-row__main', {}, [
            el('div.trade-row__title', { text: `${ACTION_LABEL[t.action] ?? t.action}` }),
            el('div.trade-row__sub', {
              text: formatDayLabel(t.date) + (t.note ? `・${t.note}` : ''),
            }),
          ]),
          el('div.trade-row__amount', { text: describeTrade(t) }),
          el('span.row__chevron', { text: '›' }),
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

  /**
   * 新增或修改一筆交易。
   *
   * 傳入 existing 就是編輯模式 —— 輸入錯了要能改回來，
   * 只能刪掉重建的話，使用者得重新回想當初填了什麼。
   *
   * 期初持股刻意用「每股成本／成本總額」兩個欄位而不是「價格＋手續費」：
   * 券商顯示的就是這兩個數字，這樣才對得起來。兩者雙向連動，
   * 實際儲存時把除不盡的餘數放進 fee，總成本因此能精確還原。
   */
  function openTradeEditor(symbol, action, onDone, existing = null) {
    const editing = Boolean(existing);
    const title = `${symbol}　${editing ? '修改' : ''}${ACTION_LABEL[action]}`;

    openSheet(title, (body, close) => {
      const isCash = action === ACTION.DIVIDEND;
      const isStockDiv = action === ACTION.STOCK_DIV;
      const isOpening = action === ACTION.OPENING;

      const money = (cents) => (cents ? (cents / 100).toString() : '');

      const f = {
        date: el('input.input', { type: 'date', value: existing?.date ?? todayISO() }),
        shares: el('input.input', {
          type: 'number', inputmode: 'numeric', placeholder: '股數',
          value: existing?.shares ? String(existing.shares) : '',
        }),
        price: el('input.input', {
          type: 'text', inputmode: 'decimal', placeholder: '每股價格',
          value: money(existing?.price),
        }),
        amount: el('input.input', {
          type: 'text', inputmode: 'decimal', placeholder: '股利總額',
          value: money(existing?.amount),
        }),
        fee: el('input.input', {
          type: 'text', inputmode: 'decimal', placeholder: '自動試算',
          value: money(existing?.fee),
        }),
        tax: el('input.input', {
          type: 'text', inputmode: 'decimal', placeholder: '自動試算',
          value: money(existing?.tax),
        }),
        unitCost: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '每股成本' }),
        totalCost: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '成本總額' }),
        note: el('input.input', {
          type: 'text', placeholder: '備註（選填）', maxlength: '100',
          value: existing?.note ?? '',
        }),
      };

      // 期初持股：帶入現有的成本，兩個欄位互相換算
      if (isOpening && existing) {
        const total = existing.shares * existing.price + (existing.fee ?? 0);
        f.totalCost.value = (total / 100).toString();
        // 每股成本最多四位小數，與券商的顯示一致。
        // 成本總額才是寫入時的依據，所以這裡的截短不會讓數字失真。
        if (existing.shares > 0) f.unitCost.value = unitText(total / existing.shares);
      }

      let syncing = false;
      const syncFromUnit = () => {
        if (syncing) return;
        syncing = true;
        const n = Number(f.shares.value);
        const u = parseAmount(f.unitCost.value);
        if (Number.isFinite(n) && n > 0 && u !== null) f.totalCost.value = ((u * n) / 100).toString();
        syncing = false;
      };
      const syncFromTotal = () => {
        if (syncing) return;
        syncing = true;
        const n = Number(f.shares.value);
        const t = parseAmount(f.totalCost.value);
        if (Number.isFinite(n) && n > 0 && t !== null) f.unitCost.value = unitText(t / n);
        syncing = false;
      };
      f.unitCost.addEventListener('input', syncFromUnit);
      f.totalCost.addEventListener('input', syncFromTotal);
      f.shares.addEventListener('input', () => {
        if (f.totalCost.value) syncFromTotal();
        else syncFromUnit();
      });

      // 手續費與證交稅依成交金額自動帶入，但保留讓使用者覆寫 —— 每家券商折扣不同。
      // 編輯既有紀錄時不覆蓋原本的值，否則使用者填過的數字會被蓋掉。
      const autoFill = () => {
        if (editing) return;
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
      } else if (isOpening) {
        body.append(
          field('股數', f.shares),
          field('每股成本', f.unitCost),
          field('成本總額', f.totalCost),
          el('p.hint', { text: '兩個成本欄位會互相換算，填任一個即可。留白代表成本待補，該檔不會顯示損益。' }),
        );
      } else {
        body.append(field('股數', f.shares));
        if (!isStockDiv) {
          body.append(field('每股價格', f.price), field('手續費', f.fee));
          if (action === ACTION.SELL) body.append(field('證交稅', f.tax));
          body.append(el('p.hint', { text: '手續費 0.1425%、證交稅 0.3% 會自動試算，可依券商折扣自行修改。' }));
        } else {
          body.append(el('p.hint', { text: '無償配股只增加股數，總成本不變，平均成本會因此下降。' }));
        }
      }

      body.append(field('備註', f.note));

      body.append(el('div.sheet__actions', {}, [
        editing
          ? el('button.btn.btn--ghost.is-danger', {
            type: 'button',
            onClick: async () => {
              const ok = await confirmDialog('刪除這筆交易', `${formatDayLabel(existing.date)} ${ACTION_LABEL[action]}`, { danger: true });
              if (!ok) return;
              await store.deleteStockTrade(existing.id);
              toast('已刪除', 'success');
              close();
              onDone?.();
            },
          }, ['刪除'])
          : null,
        el('button.btn.btn--primary', {
          type: 'button',
          onClick: async () => {
            const shares = Number(f.shares.value) || 0;
            const payload = {
              // 帶上原本的 id 才是修改，否則會多出一筆
              id: existing?.id,
              createdAt: existing?.createdAt,
              date: f.date.value || todayISO(),
              symbol,
              name: existing?.name ?? '',
              action,
              shares,
              price: parseAmount(f.price.value) ?? 0,
              fee: parseAmount(f.fee.value) ?? 0,
              tax: parseAmount(f.tax.value) ?? 0,
              amount: parseAmount(f.amount.value) ?? 0,
              note: f.note.value.trim(),
            };

            if (isOpening) {
              const total = parseAmount(f.totalCost.value);
              if (total === null) {
                // 成本留白：標成待補，不會顯示憑空編出來的損益
                payload.price = 0;
                payload.fee = 0;
                payload.costUnknown = true;
              } else if (shares > 0) {
                // 除不盡的餘數放進 fee，總成本才能精確還原
                payload.price = Math.floor(total / shares);
                payload.fee = total - payload.price * shares;
                payload.costUnknown = false;
              }
            }

            const r = await store.saveStockTrade(payload);
            if (!r.ok) return toast(r.error, 'error');

            haptic(15);
            toast(editing ? '已更新' : '已記錄', 'success');
            close();
            onDone?.();
          },
        }, [editing ? '儲存修改' : '記錄']),
      ]));
    });
  }

  /** 修改代號與名稱 —— 匯入時查表可能認錯，要能改回來 */
  function openSymbolEditor(symbol, onDone) {
    const trades = store.tradesOf(symbol);
    const current = trades.find((t) => t.name)?.name ?? '';

    openSheet(`${symbol}　修改代號與名稱`, (body, close) => {
      const f = {
        symbol: el('input.input', { type: 'text', value: symbol, maxlength: '12' }),
        name: el('input.input', { type: 'text', value: current, maxlength: '20', placeholder: '名稱（選填）' }),
      };

      body.append(
        field('股票代號', f.symbol),
        field('名稱', f.name),
        el('p.hint', { text: `會一併更新這一檔的 ${trades.length} 筆交易紀錄。` }),
        el('div.sheet__actions', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async () => {
              const next = f.symbol.value.trim().toUpperCase();
              if (!next) return toast('請輸入股票代號', 'error');

              const quote = store.state.quotes[symbol];

              // 交易紀錄的 id 不變，只換上面的代號 —— 這是「修改」不是「搬移」。
              // 先更新再依 id 刪除的話，剛改好的那幾筆會被自己刪掉。
              for (const tr of trades) {
                await store.saveStockTrade({ ...tr, symbol: next, name: f.name.value.trim() });
              }

              if (next !== symbol && quote) {
                await store.setQuote(next, quote.close, { date: quote.date, source: quote.source });
                await store.deleteQuote(symbol);
              }

              toast('已更新', 'success');
              close();
              onDone?.();
            },
          }, ['儲存']),
        ]),
      );
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
    if (t.action === ACTION.OPENING) {
      // 期初持股的單價是由總成本除出來的，直接顯示總額比較對得上券商
      const total = t.shares * t.price + (t.fee ?? 0);
      return `${t.shares} 股　${total ? formatAmount(total) : '成本待補'}`;
    }
    const sign = t.action === ACTION.SELL ? '-' : '+';
    return `${sign}${t.shares} 股　${formatAmount(t.price)}`;
  }

  return { node, refresh };
}
