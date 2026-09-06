/**
 * 資產頁裡的「基金投資」區塊。
 *
 * 與股票分開成兩個區塊，不是兩份幾乎一樣的程式湊在一起：
 * 基金有幣別、有小數單位數、淨值不是股價，兩邊各自綁一個帳戶。
 * 版面沿用股票區塊的樣式（CSS 選擇器同時列了 .fund-*），
 * 但資料與計算完全走 funds.js。
 *
 * 本階段只做手動輸入。自動抓淨值與匯率是後續階段，
 * 屆時會是「預設關閉、使用者自行開啟」的選項。
 */

import { el, clear, toast, openSheet, confirmDialog, haptic } from '../ui.js';
import { formatAmount, formatCurrency, parseAmount } from '../lib/money.js';
import { todayISO, formatDayLabel } from '../lib/dateutil.js';
import {
  FUND_ACTION, byFundValue,
  parseUnits, parseNav, parseRate,
  unitsToNumber, navToNumber, rateToNumber,
} from '../lib/funds.js';
import * as store from '../store.js';

const ACTION_LABEL = {
  [FUND_ACTION.OPENING]: '期初持份',
  [FUND_ACTION.BUY]: '申購',
  [FUND_ACTION.SELL]: '贖回',
  [FUND_ACTION.DIVIDEND]: '現金配息',
  [FUND_ACTION.REINVEST]: '配息再投資',
};

/** 常見的計價幣別。使用者仍可自行輸入其他三碼幣別。 */
const COMMON_CURRENCIES = ['TWD', 'USD', 'CNY', 'EUR', 'JPY', 'HKD', 'AUD', 'ZAR'];

/** 去掉尾端多餘的零，並加上千分位 */
function trimNumber(value, decimals) {
  if (!Number.isFinite(value)) return '—';
  const text = value.toFixed(decimals).replace(/\.?0+$/, '');
  const [int, frac] = text.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** 單位數顯示：最多四位小數 */
const unitsText = (units) => trimNumber(unitsToNumber(units), 4);

/** 淨值顯示：最多四位小數。基金淨值的第三、四位是有意義的，不能四捨五入掉。 */
const navText = (nav) => trimNumber(navToNumber(nav), 4);

/** 原幣金額（分）→ 顯示文字，例如「10,000.00 USD」 */
function foreignText(cents, currency) {
  if (!Number.isFinite(cents)) return '—';
  return `${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function createFundsSection({ onChange } = {}) {
  const node = el('section.funds');
  const refs = {};

  build();

  function build() {
    clear(node);
    refs.summary = el('div.fund-summary');
    refs.list = el('div.fund-list');

    node.append(
      el('div.section-head', {}, [
        el('h2.section-head__title', { text: '基金投資' }),
        el('div.section-head__actions', {}, [
          el('button.link-btn', { type: 'button', onClick: () => openRatesSheet() }, ['匯率']),
          el('button.link-btn', { type: 'button', onClick: () => openHoldingEditor() }, ['+ 新增基金']),
        ]),
      ]),
      refs.summary,
      refs.list,
    );

    refresh();
  }

  function refresh() {
    const s = store.fundSummary();
    renderSummary(s);
    renderList(s);
    onChange?.();
  }

  // ---------------------------------------------------------------- 總覽

  function renderSummary(s) {
    clear(refs.summary);

    if (!s.heldCount) {
      refs.summary.append(el('p.hint', {
        text: '還沒有基金。按「+ 新增基金」填入單位數與平均成本即可開始追蹤，台幣與外幣計價都可以。',
      }));
      return;
    }

    // 總覽四格的寬度有限，帶小數會被截斷成「245,407....」。
    // 彙總層級不需要角分，四捨五入到元，與帳戶列表的顯示也一致。
    const round = (v) => formatAmount(v, { decimals: 'never' });

    const cells = [
      ['市值', s.pricedCount ? round(s.marketValue) : '—'],
      ['成本', round(s.totalCost)],
    ];

    // 只有每一檔都算得出台幣市值，未實現損益才是完整的數字
    if (s.complete) {
      const sign = s.unrealized >= 0 ? '+' : '';
      cells.push(['未實現損益', `${sign}${round(s.unrealized)}`]);
      cells.push(['報酬率', s.returnRate === null ? '—' : `${(s.returnRate * 100).toFixed(1)}%`]);
    }

    refs.summary.append(el('div.stat-row', {}, cells.map(([label, value]) => el('div.stat', {}, [
      el('div.stat__label', { text: label }),
      el('div.stat__value', { text: value }),
    ]))));

    // 缺淨值與缺匯率分開講：兩者要補的東西不一樣，混在一起使用者不知道該去填哪個
    if (s.missingNav.length) {
      refs.summary.append(el('p.hint.hint--warn', {
        text: `${s.missingNav.join('、')} 還沒有淨值，因此不計入市值與損益。點該檔可以填入目前淨值。`,
      }));
    }

    if (s.missingRate.length) {
      refs.summary.append(el('p.hint.hint--warn', {}, [
        el('span', { text: `還沒有 ${s.missingRate.join('、')} 的匯率，這些基金不計入台幣市值。` }),
        el('button.link-btn', { type: 'button', onClick: () => openRatesSheet() }, ['填匯率']),
      ]));
    }

    if (s.missingCost?.length) {
      refs.summary.append(el('p.hint.hint--warn', {
        text: `${s.missingCost.join('、')} 的成本待補，因此不顯示損益。`
          + '點該檔用「申購」補一筆，或到「+ 新增基金」重新填入平均成本。',
      }));
    }

    if (s.realized !== 0) {
      const sign = s.realized >= 0 ? '+' : '';
      refs.summary.append(el('p.hint', {
        text: `累計已實現損益 ${sign}${formatAmount(s.realized)}`
          + (s.dividends ? `（含配息 ${formatAmount(s.dividends)}）` : ''),
      }));
    }

    refs.summary.append(buildNetWorthLink(s));
  }

  /**
   * 「計入淨資產」的設定。與股票同一套機制，但綁的是另一個帳戶 ——
   * 兩個模組共用一個帳戶的話，那個帳戶的金額會被兩邊輪流覆寫。
   */
  function buildNetWorthLink(s) {
    const linkedId = store.getSetting(store.FUND_ACCOUNT_KEY, '');
    const linked = store.state.accounts.find((a) => a.id === linkedId);

    if (!linked) {
      return el('p.hint', {}, [
        el('span', { text: '基金市值目前不計入上方的淨資產。' }),
        el('button.link-btn', { type: 'button', onClick: () => openLinkPicker() }, ['計入淨資產']),
      ]);
    }

    const short = s.missingNav.length + s.missingRate.length;
    return el('p.hint', {}, [
      el('span', {
        text: `市值已自動寫入「${linked.name}」，計入淨資產。`
          + (short ? `（${short} 項資料未齊，未含在內）` : ''),
      }),
      el('button.link-btn', {
        type: 'button',
        onClick: async () => {
          await store.setSetting(store.FUND_ACCOUNT_KEY, '');
          toast('已取消連結，該帳戶的金額請自行維護', 'info', 3600);
          refresh();
        },
      }, ['取消']),
    ]);
  }

  function openLinkPicker() {
    // 排除已經綁給股票的帳戶：兩邊寫同一個帳戶會互相覆蓋，看起來就像數字自己在跳
    const stockAccountId = store.getSetting(store.STOCK_ACCOUNT_KEY, '');
    const manual = store.state.accounts.filter(
      (a) => !a.archived && a.valuationMode === 'manual' && a.id !== stockAccountId,
    );

    openSheet('計入淨資產', (body, close) => {
      body.append(el('p.sheet__message', {
        text: '選一個「手動估值」的帳戶，基金市值會自動寫進去，跟著算進淨資產。'
          + '之後每次交易或更新淨值都會同步，不必再自己填。',
      }));

      const pick = async (account) => {
        await store.setSetting(store.FUND_ACCOUNT_KEY, account.id);
        const r = await store.syncFundValueToAccount();
        toast(r.synced ? `已寫入「${account.name}」` : '設定完成', 'success');
        close();
        refresh();
      };

      if (manual.length) {
        body.append(el('div.row-list', {}, manual.map((a) => rowBtn('🏦', a.name, () => pick(a)))));
        body.append(el('p.hint', {
          text: '選定的帳戶原本填的金額會被覆蓋 —— 它之後由基金模組維護。'
            + '已經給股票用的帳戶不會出現在這裡。',
        }));
      } else {
        body.append(el('p.hint', { text: '還沒有可用的「手動估值」帳戶。' }));
      }

      body.append(el('div.sheet__actions', {}, [
        el('button.btn.btn--ghost', {
          type: 'button',
          onClick: async () => {
            const r = await store.saveAccount({
              name: '基金帳戶', kind: 'investment', valuationMode: 'manual', manualValue: 0,
            });
            if (!r.ok) return toast(r.error, 'error');
            await pick(r.value);
          },
        }, ['新建「基金帳戶」']),
      ]));
    });
  }

  // ---------------------------------------------------------------- 匯率表

  function openRatesSheet() {
    const render = (body, close) => {
      clear(body);

      const rates = store.fxRates();
      const needed = store.currenciesNeedingRate();
      const listed = [...new Set([...Object.keys(rates), ...needed])].sort();

      body.append(el('p.sheet__message', {
        text: '外幣基金要有匯率才算得出台幣市值。目前是手動維護，'
          + '自動抓匯率會在後續版本提供，屆時是可自行開啟的選項。',
      }));

      if (needed.length) {
        body.append(el('p.hint.hint--warn', {
          text: `${needed.join('、')} 還沒有匯率，這些基金暫時不計入台幣市值。`,
        }));
      }

      if (!listed.length) {
        body.append(el('p.hint', { text: '目前沒有外幣基金，不需要填匯率。' }));
      }

      for (const code of listed) {
        const input = el('input.input', {
          type: 'text', inputmode: 'decimal',
          placeholder: `1 ${code} = ? 台幣`,
          value: rates[code] > 0 ? String(rateToNumber(rates[code])) : '',
        });

        const row = el('div.field', {}, [
          el('div.field__label', { text: `${code} → TWD` }),
          input,
        ]);

        body.append(row);
      }

      if (listed.length) {
        body.append(el('div.sheet__actions', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async () => {
              const inputs = [...body.querySelectorAll('.field input')];
              let saved = 0;
              for (let i = 0; i < listed.length; i += 1) {
                const code = listed[i];
                const raw = inputs[i].value.trim();
                if (!raw) {
                  // 清空代表「這個匯率我還不知道」，那就真的移掉 ——
                  // 留一個舊匯率會讓市值看起來很正常，其實是用過期的數字算的
                  if (rates[code] !== undefined) await store.removeFxRate(code);
                  continue;
                }
                const rate = parseRate(raw);
                if (rate === null || rate <= 0) return toast(`${code} 的匯率不正確`, 'error');
                await store.setFxRate(code, rate);
                saved += 1;
              }
              toast(saved ? '已更新匯率' : '已清除匯率', 'success');
              close();
              refresh();
            },
          }, ['儲存']),
        ]));
      }

      // 讓使用者可以先建立一個還沒買過的幣別（例如準備要申購）
      body.append(el('div.sheet__actions', {}, [
        el('button.btn.btn--ghost', {
          type: 'button',
          onClick: () => openAddCurrency(() => render(body, close)),
        }, ['加入其他幣別']),
      ]));
    };

    openSheet('匯率', render);
  }

  function openAddCurrency(onDone) {
    openSheet('加入幣別', (body, close) => {
      const code = el('input.input', {
        type: 'text', placeholder: '例如 GBP', maxlength: '3',
      });
      const rate = el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '1 單位 = ? 台幣' });

      body.append(
        field('幣別代碼', code),
        field('匯率', rate),
        el('div.sheet__actions', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async () => {
              const c = code.value.trim().toUpperCase();
              if (!/^[A-Z]{3}$/.test(c)) return toast('幣別要是三個英文字母', 'error');
              const r = parseRate(rate.value);
              if (r === null || r <= 0) return toast('請輸入正確的匯率', 'error');
              await store.setFxRate(c, r);
              toast(`已加入 ${c}`, 'success');
              close();
              onDone?.();
            },
          }, ['加入']),
        ]),
      );
    });
  }

  // ---------------------------------------------------------------- 列表

  function renderList(s) {
    clear(refs.list);
    const held = byFundValue(s.rows);
    if (!held.length) return;

    for (const r of held) {
      const gain = r.unrealized;
      const cls = gain === null ? '' : gain >= 0 ? ' is-up' : ' is-down';

      const sub = `${unitsText(r.units)} 單位・`
        + (r.costUnknown ? '成本待補' : `均價 ${trimNumber(r.avgNav, 4)}`)
        + (r.nav ? `　淨值 ${navText(r.nav)}` : '')
        + (r.currency !== 'TWD' ? `　${r.currency}` : '');

      refs.list.append(el('button.fund-row', {
        type: 'button',
        onClick: () => openFundDetail(r.fundId),
      }, [
        el('div.fund-row__main', {}, [
          el('div.fund-row__title', { text: r.name ? `${r.name}` : r.fundId }),
          el('div.fund-row__sub', { text: sub }),
        ]),
        el('div.fund-row__right', {}, [
          el('div.fund-row__value', {
            text: r.marketValue === null
              ? (r.nav === null ? '未填淨值' : `缺 ${r.currency} 匯率`)
              : formatAmount(r.marketValue),
          }),
          el(`div.fund-row__gain${cls}`, {
            text: gain === null ? '' : `${gain >= 0 ? '+' : ''}${formatAmount(gain)}`
              + (r.returnRate === null ? '' : `　${(r.returnRate * 100).toFixed(1)}%`),
          }),
        ]),
      ]));
    }

    const closed = s.rows.filter((r) => r.units === 0 && r.realizedTwd !== 0);
    if (closed.length) {
      refs.list.append(el('p.hint.hint--block', {
        text: `已結清：${closed.map((r) => `${r.name || r.fundId} ${r.realizedTwd >= 0 ? '+' : ''}${formatAmount(r.realizedTwd)}`).join('、')}`,
      }));
    }
  }

  // ---------------------------------------------------------------- 新增基金

  function openHoldingEditor() {
    openSheet('新增基金', (body, close) => {
      const f = {
        name: el('input.input', { type: 'text', placeholder: '例如 安聯台灣科技', maxlength: '40' }),
        fundId: el('input.input', { type: 'text', placeholder: '選填，用來對帳的短代碼', maxlength: '20' }),
        currency: currencySelect('TWD'),
        units: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '例如 1234.5678' }),
        cost: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '平均每單位成本' }),
        rate: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '申購當時的匯率' }),
        nav: el('input.input', { type: 'text', inputmode: 'decimal', placeholder: '目前淨值（選填）' }),
        date: el('input.input', { type: 'date', value: todayISO() }),
      };

      const rateField = field('申購匯率', f.rate);
      const rateHint = el('p.hint', {
        text: '用「當初申購時」的匯率，不是今天的 —— 台幣成本要照實際換匯的價格算，'
          + '報酬率才分得出哪些是基金賺的、哪些是匯率賺的。',
      });

      const syncRateVisible = () => {
        const isTwd = f.currency.value === 'TWD';
        rateField.hidden = isTwd;
        rateHint.hidden = isTwd;
      };
      f.currency.addEventListener('change', syncRateVisible);

      body.append(
        el('p.sheet__message', {
          text: '填入目前的持有狀況即可，不必回頭補所有扣款紀錄。之後的申購贖回再逐筆記錄。',
        }),
        field('基金名稱', f.name),
        field('代碼', f.fundId),
        el('p.hint', { text: '基金沒有像股票代號那樣的統一編號，留白就用名稱當代碼。' }),
        field('計價幣別', f.currency),
        field('單位數', f.units),
        field('平均每單位成本', f.cost),
        rateField,
        rateHint,
        field('目前淨值', f.nav),
        field('起算日期', f.date),
        el('p.hint', { text: '沒填淨值也可以，只是暫時看不到市值與損益，之後再補。' }),
        el('div.sheet__actions', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async () => {
              const name = f.name.value.trim();
              const fundId = f.fundId.value.trim() || name;
              if (!fundId) return toast('請輸入基金名稱', 'error');

              const units = parseUnits(f.units.value);
              if (units === null || units <= 0) return toast('請輸入單位數', 'error');

              const cost = parseNav(f.cost.value);
              if (cost === null || cost <= 0) return toast('請輸入平均每單位成本', 'error');

              const currency = f.currency.value;
              let fxRate;
              if (currency !== 'TWD') {
                fxRate = parseRate(f.rate.value);
                if (fxRate === null || fxRate <= 0) {
                  return toast(`請輸入申購當時 ${currency} 的匯率`, 'error');
                }
              }

              const r = await store.saveFundTrade({
                date: f.date.value || todayISO(),
                fundId,
                name,
                currency,
                action: FUND_ACTION.OPENING,
                units,
                nav: cost,
                fxRate,
              });
              if (!r.ok) return toast(r.error, 'error');

              const nav = parseNav(f.nav.value);
              if (nav !== null && nav > 0) await store.setNav(fundId, nav);

              // 順手把今天的匯率也記起來，否則市值會顯示「缺匯率」，
              // 使用者剛填過一個匯率卻還要再填一次，會覺得程式沒收到
              if (currency !== 'TWD' && !(store.fxRates()[currency] > 0)) {
                await store.setFxRate(currency, fxRate);
              }

              haptic(15);
              toast(`已加入 ${name || fundId}`, 'success');
              close();
              refresh();
            },
          }, ['加入']),
        ]),
      );

      syncRateVisible();
    });
  }

  // ---------------------------------------------------------------- 個別基金

  function openFundDetail(fundId) {
    const render = (body, close) => {
      clear(body);

      const s = store.fundSummary();
      const row = s.rows.find((r) => r.fundId === fundId);
      if (!row) return close();

      const rerender = () => render(body, close);
      const foreign = row.currency !== 'TWD';

      body.append(el('div.stat-row', {}, [
        ['單位數', unitsText(row.units)],
        ['均價', row.costUnknown ? '待補' : trimNumber(row.avgNav, 4)],
        ['市值', row.marketValue === null ? '—' : formatAmount(row.marketValue)],
      ].map(([l, v]) => el('div.stat', {}, [
        el('div.stat__label', { text: l }),
        el('div.stat__value', { text: v }),
      ]))));

      if (foreign) {
        body.append(el('p.hint', {
          text: `計價幣別 ${row.currency}`
            + (row.marketValueForeign !== null ? `・原幣市值 ${foreignText(row.marketValueForeign, row.currency)}` : '')
            + (row.fxRate ? `・匯率 ${trimNumber(rateToNumber(row.fxRate), 4)}` : '・尚未填匯率'),
        }));
      }

      // 外幣基金的兩種報酬率一起講。只給一個數字的話，
      // 使用者無法判斷賺的是基金還是匯率 —— 那是兩件該分開看的事。
      if (row.unrealized !== null) {
        const sign = row.unrealized >= 0 ? '+' : '';
        body.append(el('p.hint', {
          text: `未實現損益 ${sign}${formatAmount(row.unrealized)}`
            + (row.returnRate === null ? '' : `（${(row.returnRate * 100).toFixed(1)}%）`),
        }));

        if (foreign && row.unrealizedForeign !== null) {
          const fs = row.unrealizedForeign >= 0 ? '+' : '';
          body.append(el('p.hint', {
            text: `其中基金本身 ${fs}${foreignText(row.unrealizedForeign, row.currency)}`
              + (row.returnRateForeign === null ? '' : `（${(row.returnRateForeign * 100).toFixed(1)}%）`)
              + (row.fxEffect === null ? '' : `，匯兌損益 ${row.fxEffect >= 0 ? '+' : ''}${formatAmount(row.fxEffect)}`),
          }));
        }
      }

      if (row.realizedTwd !== 0) {
        body.append(el('p.hint', {
          text: `已實現損益 ${row.realizedTwd >= 0 ? '+' : ''}${formatAmount(row.realizedTwd)}`,
        }));
      }

      for (const w of row.warnings) {
        body.append(el('p.hint.hint--warn', { text: w }));
      }

      body.append(el('div.row-list', {}, [
        rowBtn('📈', '申購', () => openTradeEditor(fundId, FUND_ACTION.BUY, rerender)),
        rowBtn('📉', '贖回', () => openTradeEditor(fundId, FUND_ACTION.SELL, rerender)),
        rowBtn('💰', '現金配息', () => openTradeEditor(fundId, FUND_ACTION.DIVIDEND, rerender)),
        rowBtn('🔁', '配息再投資', () => openTradeEditor(fundId, FUND_ACTION.REINVEST, rerender)),
        rowBtn('🏷', '更新淨值', () => openNavEditor(fundId, rerender)),
        rowBtn('✏️', '修改名稱與幣別', () => openFundIdEditor(fundId, rerender)),
      ]));

      const trades = [...store.fundTradesOf(fundId)].sort((a, b) => (a.date < b.date ? 1 : -1));
      body.append(el('div.section-head', {}, [
        el('h2.section-head__title', { text: `交易紀錄（${trades.length}）` }),
      ]));
      body.append(el('p.hint', { text: '點任何一筆可以修改或刪除。' }));

      for (const t of trades) {
        body.append(el('button.trade-row.trade-row--tappable', {
          type: 'button',
          onClick: () => openTradeEditor(fundId, t.action, rerender, t),
        }, [
          el('div.trade-row__main', {}, [
            el('div.trade-row__title', { text: ACTION_LABEL[t.action] ?? t.action }),
            el('div.trade-row__sub', { text: formatDayLabel(t.date) + (t.note ? `・${t.note}` : '') }),
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
              `刪除 ${row.name || fundId}`,
              `會一併刪掉這檔的 ${trades.length} 筆交易紀錄，無法復原。`,
              { danger: true, confirmText: '刪除' },
            );
            if (!ok) return;
            await store.deleteFund(fundId);
            toast('已刪除', 'success');
            close();
            refresh();
          },
        }, ['刪除這檔基金']),
      ]));
    };

    openSheet(fundId, render);
  }

  // ---------------------------------------------------------------- 交易輸入

  /**
   * 新增或修改一筆交易。傳入 existing 就是編輯模式 ——
   * 輸入錯了要能改回來，只能刪掉重建的話使用者得重新回想當初填了什麼。
   */
  function openTradeEditor(fundId, action, onDone, existing = null) {
    const trades = store.fundTradesOf(fundId);
    const base = existing ?? trades[trades.length - 1] ?? {};
    const currency = existing?.currency ?? base.currency ?? 'TWD';
    const foreign = currency !== 'TWD';
    const isDividend = action === FUND_ACTION.DIVIDEND;

    const title = `${existing ? '修改' : ''}${ACTION_LABEL[action] ?? ''}`;

    openSheet(title, (body, close) => {
      const f = {
        date: el('input.input', { type: 'date', value: existing?.date ?? todayISO() }),
        units: el('input.input', {
          type: 'text', inputmode: 'decimal', placeholder: '單位數',
          value: existing && existing.units ? String(unitsToNumber(existing.units)) : '',
        }),
        nav: el('input.input', {
          type: 'text', inputmode: 'decimal', placeholder: '每單位淨值',
          value: existing && existing.nav ? String(navToNumber(existing.nav)) : '',
        }),
        amount: el('input.input', {
          type: 'text', inputmode: 'decimal', placeholder: '配息金額',
          value: existing && existing.amount ? String(existing.amount / 100) : '',
        }),
        fee: el('input.input', {
          type: 'text', inputmode: 'decimal', placeholder: '手續費（選填）',
          value: existing && existing.fee ? String(existing.fee / 100) : '',
        }),
        rate: el('input.input', {
          type: 'text', inputmode: 'decimal', placeholder: '當日匯率',
          value: existing?.fxRate ? String(rateToNumber(existing.fxRate)) : defaultRateText(currency),
        }),
        note: el('input.input', { type: 'text', placeholder: '備註（選填）', value: existing?.note ?? '' }),
      };

      if (isDividend) {
        body.append(field(`配息金額（${currency}）`, f.amount));
      } else {
        body.append(field('單位數', f.units));
        body.append(field(`每單位淨值（${currency}）`, f.nav));
        if (action === FUND_ACTION.BUY || action === FUND_ACTION.SELL) {
          body.append(field(`手續費（${currency}，選填）`, f.fee));
        }
      }

      if (foreign) {
        body.append(field('當日匯率', f.rate));
        body.append(el('p.hint', {
          text: action === FUND_ACTION.SELL
            ? '用贖回當日的匯率。台幣損益就是用這個匯率的收入，減掉申購當日匯率的成本。'
            : '用這筆交易當日的匯率，不是今天的。',
        }));
      }

      if (action === FUND_ACTION.REINVEST) {
        body.append(el('p.hint', {
          text: '配息換成單位數。會同時記成一筆配息收入與等額申購，'
            + '因此再投資的當下總報酬不變 —— 本來就不該憑空多賺或少賺。',
        }));
      }

      body.append(field('日期', f.date), field('備註', f.note));

      const actions = [
        el('button.btn.btn--primary', {
          type: 'button',
          onClick: async () => {
            const payload = {
              id: existing?.id,
              createdAt: existing?.createdAt,
              date: f.date.value || todayISO(),
              fundId,
              name: base.name ?? '',
              currency,
              action,
              note: f.note.value.trim(),
            };

            if (foreign) {
              const rate = parseRate(f.rate.value);
              if (rate === null || rate <= 0) return toast('請輸入當日匯率', 'error');
              payload.fxRate = rate;
            }

            if (isDividend) {
              const amount = parseAmount(f.amount.value);
              if (amount === null || amount <= 0) return toast('請輸入配息金額', 'error');
              payload.amount = amount;
            } else {
              const units = parseUnits(f.units.value);
              const nav = parseNav(f.nav.value);
              if (units === null || units <= 0) return toast('請輸入單位數', 'error');
              if (nav === null || nav <= 0) return toast('請輸入每單位淨值', 'error');
              payload.units = units;
              payload.nav = nav;
              payload.fee = parseAmount(f.fee.value) ?? 0;
            }

            const r = await store.saveFundTrade(payload);
            if (!r.ok) return toast(r.error, 'error');

            haptic(12);
            toast(existing ? '已更新' : '已記錄', 'success');
            close();
            onDone?.();
            refresh();
          },
        }, [existing ? '儲存' : '記錄']),
      ];

      if (existing) {
        actions.push(el('button.btn.btn--ghost.is-danger', {
          type: 'button',
          onClick: async () => {
            const ok = await confirmDialog('刪除這筆交易', '刪掉後持份與損益會重新計算，無法復原。', {
              danger: true, confirmText: '刪除',
            });
            if (!ok) return;
            await store.deleteFundTrade(existing.id);
            toast('已刪除', 'success');
            close();
            onDone?.();
            refresh();
          },
        }, ['刪除這筆']));
      }

      body.append(el('div.sheet__actions', {}, actions));
    });
  }

  function openNavEditor(fundId, onDone) {
    openSheet('更新淨值', (body, close) => {
      const current = store.state.navs[fundId];
      const input = el('input.input', {
        type: 'text', inputmode: 'decimal', placeholder: '每單位淨值',
        value: current ? String(navToNumber(current.nav)) : '',
      });

      body.append(
        field('目前淨值', input),
        el('p.hint', {
          text: current
            ? `上次更新：${formatDayLabel(current.date)}`
            : '第一次填入淨值。自動抓取會在後續版本提供，屆時是可自行開啟的選項。',
        }),
        el('div.sheet__actions', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async () => {
              const nav = parseNav(input.value);
              if (nav === null || nav <= 0) return toast('請輸入正確的淨值', 'error');
              await store.setNav(fundId, nav);
              toast('已更新淨值', 'success');
              close();
              onDone?.();
              refresh();
            },
          }, ['儲存']),
        ]),
      );
    });
  }

  /** 修改名稱、代碼與幣別 */
  function openFundIdEditor(fundId, onDone) {
    openSheet('修改基金資料', (body, close) => {
      const trades = store.fundTradesOf(fundId);
      const base = trades[trades.length - 1] ?? {};

      const f = {
        fundId: el('input.input', { type: 'text', value: fundId, maxlength: '20' }),
        name: el('input.input', { type: 'text', value: base.name ?? '', maxlength: '40' }),
        currency: currencySelect(base.currency ?? 'TWD'),
      };

      body.append(
        field('代碼', f.fundId),
        field('名稱', f.name),
        field('計價幣別', f.currency),
        el('p.hint.hint--warn', {
          text: '改幣別不會換算既有交易的金額 —— 那些數字原本就是用當初的幣別記的。'
            + '只有在一開始選錯幣別時才該改。',
        }),
        el('div.sheet__actions', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: async () => {
              const next = f.fundId.value.trim();
              if (!next) return toast('請輸入代碼', 'error');

              const nav = store.state.navs[fundId];

              // 交易紀錄的 id 不變，只換上面的代碼 —— 這是「修改」不是「搬移」。
              // 先更新再依 id 刪除的話，剛改好的那幾筆會被自己刪掉。
              for (const t of trades) {
                await store.saveFundTrade({
                  ...t, fundId: next, name: f.name.value.trim(), currency: f.currency.value,
                });
              }

              if (next !== fundId && nav) {
                await store.setNav(next, nav.nav, { date: nav.date, source: nav.source });
                await store.deleteNav(fundId);
              }

              toast('已更新', 'success');
              close();
              onDone?.();
              refresh();
            },
          }, ['儲存']),
        ]),
      );
    });
  }

  // ---------------------------------------------------------------- 小工具

  /** 已經填過匯率的幣別，開新交易時預帶進去省得每次都查 */
  function defaultRateText(currency) {
    const rate = store.fxRates()[currency];
    return rate > 0 ? String(rateToNumber(rate)) : '';
  }

  function currencySelect(value) {
    const sel = el('select.input');
    for (const code of COMMON_CURRENCIES) {
      sel.append(el('option', { value: code, text: code, selected: code === value }));
    }
    // 使用者手上可能是清單以外的幣別，不能因此擋住他
    if (value && !COMMON_CURRENCIES.includes(value)) {
      sel.append(el('option', { value, text: value, selected: true }));
    }
    sel.value = value;
    return sel;
  }

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
    const cur = t.currency !== 'TWD' ? ` ${t.currency}` : '';
    if (t.action === FUND_ACTION.DIVIDEND) return `${formatCurrency(t.amount)}${cur}`;
    if (t.action === FUND_ACTION.OPENING) {
      const total = Math.round(unitsToNumber(t.units) * navToNumber(t.nav) * 100) + (t.fee ?? 0);
      return `${unitsText(t.units)} 單位　${total ? formatAmount(total) + cur : '成本待補'}`;
    }
    const sign = t.action === FUND_ACTION.SELL ? '-' : '+';
    return `${sign}${unitsText(t.units)} 單位　${navText(t.nav)}${cur}`;
  }

  return { node, refresh };
}
