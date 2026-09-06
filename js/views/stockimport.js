/**
 * 持股匯入：貼上文字或上傳 CSV。
 *
 * 兩條路共用同一套「解析 → 欄位對應 → 預覽確認 → 寫入」的流程，
 * 差別只在資料怎麼進來。
 *
 * ── 為什麼一定要有預覽 ──
 * 各券商排版差異極大，自動判斷一定有猜錯的時候。猜錯了使用者看得到並能改；
 * 默默寫進錯誤的成本價，則會一路污染之後所有的損益數字，而且很難回頭找出原因。
 */

import { el, clear, toast, openSheet, confirmDialog, haptic } from '../ui.js';
import { todayISO } from '../lib/dateutil.js';
import {
  FIELD, decodeText, extractHoldings, suggestMapping,
  mergeBatches, combineDuplicates, mergeBySymbol, rowsToTrades,
} from '../lib/importparse.js';
import { nameToSymbol } from '../lib/stocklookup.js';
import * as store from '../store.js';

const FIELD_LABEL = {
  [FIELD.IGNORE]: '不使用',
  [FIELD.SHARES]: '股數',
  [FIELD.AVG_COST]: '每股成本',
  [FIELD.TOTAL_COST]: '成本總額',
  [FIELD.PRICE]: '現價',
};

const SAMPLE = `2330 台積電 1,000 600.00 800.00
2317 鴻海 2,000 105.50 247.50`;

/**
 * 開啟匯入畫面。
 * @param {{onDone?: () => void}} opts
 */
export function openStockImport({ onDone } = {}) {
  // batches：每貼一次或每上傳一個檔案算一批，用來支援庫存分好幾頁的情況
  // 每一批都帶自己的欄位對應。共用一份對應會出事：
  // 「未實現損益」畫面是 股數/現價/市值 三欄，「即時庫存」畫面是 庫存數量/可下單數量 兩欄，
  // 兩者混在同一次匯入時，後者的第二欄會被當成前者的「現價」——
  // 1,000 股的可下單數量變成每股 1,000 元，市值憑空多出一百萬而且畫面上看不出異常。
  const stateIn = {
    batches: [],   // [{ rows, mapping }]
    rows: [],
    duplicates: [],
    combined: false,
    conflicts: [],
    layoutLost: false,
    // 讀到了但查不出是哪一檔的名稱，要讓使用者知道有東西被漏掉
    unresolved: [],
  };

  openSheet('匯入持股', (body, close) => {
    const render = () => {
      clear(body);
      body.append(buildSource());
      const lost = buildLayoutLost();
      if (lost) body.append(lost);

      if (stateIn.rows.length) {
        body.append(buildMapping(), buildPreview(), buildActions());
      } else {
        const unresolved = buildUnresolved();
        if (unresolved) body.append(unresolved);
        if (!lost) body.append(buildHelp());
      }
    };

    // ------------------------------------------------------------ 來源

    function buildSource() {
      const ta = el('textarea.import-textarea', {
        rows: '5',
        placeholder: '在這裡貼上庫存文字…',
      });

      const addText = (text) => {
        // 券商庫存畫面常常只有名稱沒有代號，交給查表補上
        const { rows, skipped, unresolved, header, layoutLost } = extractHoldings(text, { lookup: nameToSymbol });
        if (unresolved.length) stateIn.unresolved.push(...unresolved);

        // 認得出股票卻幾乎沒有數字 —— 表格在辨識時就被拆成直行了
        if (layoutLost) {
          stateIn.layoutLost = true;
          render();
          return;
        }

        if (!rows.length) {
          toast(
            unresolved.length
              ? `認不出 ${unresolved.join('、')}，請改貼含代號的畫面`
              : `沒有辨識到任何股票（略過 ${skipped} 行）`,
            'error', 4000,
          );
          if (unresolved.length) render();
          return;
        }
        // 這一批的欄位對應只依這一批的資料推斷。
        // 有表頭就照欄名對，比從數值特徵猜可靠得多。
        stateIn.batches.push({ rows, header, mapping: suggestMapping(rows, header) });
        recompute();
        haptic(12);
        toast(`加入 ${rows.length} 檔`, 'success');
        render();
      };

      const fileInput = el('input', {
        type: 'file',
        accept: '.csv,.txt,text/csv,text/plain',
        style: 'display:none',
        onChange: async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          // 用位元組讀取再自行判斷編碼 —— 券商匯出的 CSV 多半是 Big5，
          // 直接用 text() 會得到一整片亂碼而且不會報錯
          const text = decodeText(await file.arrayBuffer());
          addText(text);
          e.target.value = '';
        },
      });

      return el('div.import-source', {}, [
        ta,
        el('div.import-buttons', {}, [
          el('button.btn.btn--primary', {
            type: 'button',
            onClick: () => {
              if (!ta.value.trim()) return toast('請先貼上內容', 'error');
              addText(ta.value);
              ta.value = '';
            },
          }, ['解析並加入']),
          el('button.btn.btn--ghost', {
            type: 'button',
            onClick: () => fileInput.click(),
          }, ['選擇 CSV 檔']),
        ]),
        fileInput,
        stateIn.batches.length
          ? el('p.hint', {
            text: `已加入 ${stateIn.batches.length} 批、共 ${stateIn.rows.length} 檔。`
              + '庫存有好幾頁時，回上一步再貼下一頁即可。',
          })
          : null,
      ]);
    }

    function buildHelp() {
      return el('div.help-block', {}, [
        el('div.help-block__title', { text: '文字要從哪裡來' }),
        el('ul.guide-list', {}, [
          el('li', { text: '券商 App：庫存頁截圖 → 相簿打開 → 長按選取文字 → 拷貝。iOS 內建的即時文字辨識，不必安裝任何東西。' }),
          el('li', { text: '集保 e 手掌握：匯出庫存明細 PDF → 開啟 → 選取文字 → 拷貝。' }),
          el('li', { text: '券商網頁版：直接選取表格 → 拷貝，或下載 CSV 用左邊的按鈕上傳。' }),
        ]),
        el('p.hint', { text: `看起來像這樣：\n${SAMPLE}` }),
        el('p.hint', {
          text: '解析後會先讓你確認每一欄的意思與數字對不對，確認無誤才會寫入。',
        }),
      ]);
    }

    // ------------------------------------------------------------ 欄位對應

    function buildMapping() {
      const groups = [];

      stateIn.batches.forEach((batch, bi) => {
        const width = Math.max(0, ...batch.rows.map((r) => (r.numbers ?? []).length));
        if (!width) return;

        const selects = [];
        for (let c = 0; c < width; c += 1) {
          const sample = batch.rows.find((r) => r.numbers?.[c] != null)?.numbers[c];
          selects.push(el('div.map-col', {}, [
            el('div.map-col__label', { text: `第 ${c + 1} 欄` }),
            el('select.invoice-item__cat', {
              onChange: (e) => {
                batch.mapping[c] = e.target.value;
                // 換了對應就重新套用，使用者手改過的值會被覆蓋 —— 這是刻意的，
                // 否則畫面會同時存在兩套互相矛盾的數字
                recompute();
                render();
              },
            }, Object.entries(FIELD_LABEL).map(([v, label]) => el('option', {
              value: v, text: label, selected: batch.mapping[c] === v,
            }))),
            el('div.map-col__sample', { text: sample == null ? '' : String(sample) }),
          ]));
        }

        groups.push(el('div.field', {}, [
          el('div.field__label', {
            text: stateIn.batches.length > 1
              ? `第 ${bi + 1} 批的欄位（${batch.rows.length} 檔）`
              : '這幾欄分別是什麼',
          }),
          el('div.map-row', {}, selects),
        ]));
      });

      return el('div', {}, groups);
    }

    // ------------------------------------------------------------ 預覽

    /**
     * 表格被辨識成直行時的說明。
     *
     * 這種情況「不能」靠順序去猜對應：名稱一個區塊、數字另一個區塊，
     * 順序錯一格，之後每一檔的成本都會掛到別人身上，而且看起來完全正常。
     * 與其猜，不如告訴使用者怎麼取得能用的文字。
     */
    function buildLayoutLost() {
      if (!stateIn.layoutLost) return null;

      return el('div.hint.hint--warn', {}, [
        el('div', {
          text: '認得出是哪些股票，但一個數字都對不上 ——'
            + '這張表格太寬，iOS 的文字辨識是「逐直行」讀的，'
            + '每一列的對應關係在辨識時就已經消失了。',
        }),
        el('div.help-block__title', { text: '改用這個方式' }),
        el('ol.guide-list', {}, [
          el('li', { text: '把畫面「橫向捲動」，一次只讓兩三欄入鏡再截圖。例如先截「商品＋庫存數量」。' }),
          el('li', { text: '貼進來按「解析並加入」。' }),
          el('li', { text: '再截「商品＋成本金額」，同樣貼進來。' }),
          el('li', { text: '兩批會用股票代號自動對起來，湊成完整的一筆。' }),
        ]),
        el('p.hint', {
          text: '欄位少的畫面辨識時才留得住行對應。若券商有網頁版，直接選取表格複製會更準。',
        }),
        el('button.link-btn', {
          type: 'button',
          onClick: () => { stateIn.layoutLost = false; render(); },
        }, ['知道了']),
      ]);
    }

    function buildUnresolved() {
      if (!stateIn.unresolved.length) return null;
      const names = [...new Set(stateIn.unresolved)];

      // 這些是「有讀到但認不出來」的列。不講的話使用者會以為全部都匯進去了，
      // 少掉幾檔卻毫無徵兆，比整批失敗還糟。
      return el('div.hint.hint--warn', {}, [
        el('div', {
          text: `認不出這些名稱：${names.join('、')}。`
            + '對照表可能沒收錄（新上市、名稱被截斷），請改貼含股票代號的畫面，'
            + '或用「+ 新增持股」手動輸入。',
        }),
        el('button.link-btn', {
          type: 'button',
          onClick: () => { stateIn.unresolved = []; render(); },
        }, ['知道了，不再提醒']),
      ]);
    }

    function buildPreview() {
      const wrap = el('div.import-preview');

      const unresolved = buildUnresolved();
      if (unresolved) wrap.append(unresolved);

      if (stateIn.conflicts.length) {
        // 兩批對同一個欄位給了不同的值。不擅自挑一個 ——
        // 挑錯了畫面上看不出來，之後的損益全部跟著錯。
        const lines = stateIn.conflicts.slice(0, 5).map((c) => {
          const label = { shares: '股數', avgCost: '每股成本', totalCost: '成本總額', price: '現價' }[c.field] ?? c.field;
          return `${c.symbol} 的${label}：${c.values.join(' 與 ')}`;
        });
        wrap.append(el('div.hint.hint--warn', {
          text: `不同批次給了不一樣的數字，請在下面確認哪個才對：${lines.join('；')}`,
        }));
      }

      if (stateIn.duplicates.length) {
        wrap.append(el('div.hint.hint--warn', {}, [
          el('div', {
            text: `${stateIn.duplicates.join('、')} 重複出現。`
              + '若是不小心貼了同一頁兩次，維持現狀即可（只會保留一筆）；'
              + '若是同一檔分別放在兩家券商，請按下面的按鈕合併。',
          }),
          el('button.link-btn', {
            type: 'button',
            onClick: () => {
              // 每一批的欄位對應不同，因此先各自攤平成 shares/avgCost/price，
              // 再交給 combineDuplicates（它會優先採用已攤平的值）
              stateIn.rows = combineDuplicates(resolvedRowsOfAllBatches(), []);
              stateIn.duplicates = [];
              stateIn.combined = true;
              toast('已合併重複的股票', 'success');
              render();
            },
          }, ['股數相加、成本取加權平均']),
        ]));
      }

      // 券商的庫存畫面多半沒有成本價，先講清楚會怎麼處理，
      // 使用者才不會以為是自己貼漏了
      const incomplete = stateIn.rows.filter((r) => r.incomplete);
      if (incomplete.length) {
        wrap.append(el('div.hint.hint--warn', {
          text: `${incomplete.map((r) => r.name || r.symbol).join('、')} 的欄位數與其他列不一致`
            + '（辨識時可能漏掉了空白格），數字沒有自動填入，請自行確認後補上。',
        }));
      }

      const noCost = (r) => !(r.avgCost != null || r.totalCost != null);
      if (stateIn.rows.some((r) => !r.skip && noCost(r))) {
        wrap.append(el('p.hint', {
          text: '成本價留白也可以匯入，該檔會標記為「成本待補」——'
            + '算得出市值，但不會顯示損益（用 0 當成本會得到荒謬的報酬率）。'
            + '之後在該檔的「買進」補一筆，或直接改這裡即可。',
        }));
      }

      for (const row of stateIn.rows) {
        const num = (key, placeholder) => el('input.input.input--sm', {
          type: 'text',
          inputmode: 'decimal',
          placeholder,
          // 加權平均算出來常是 627.2727272727273，顯示成這樣沒人看得下去。
          // 只截短「顯示值」，row 上仍保留完整精度，匯入時才四捨五入成分。
          value: row[key] == null ? '' : String(Math.round(row[key] * 10000) / 10000),
          onInput: (e) => {
            const v = Number(e.target.value.replace(/,/g, ''));
            row[key] = Number.isFinite(v) ? v : null;
          },
        });

        wrap.append(el(`div.import-row${row.skip ? '.is-skipped' : ''}`, {}, [
          el('label.import-row__head', {}, [
            el('input', {
              type: 'checkbox',
              checked: !row.skip,
              onChange: (e) => { row.skip = !e.target.checked; render(); },
            }),
            el('span.import-row__title', {
              text: (row.name ? `${row.symbol} ${row.name}` : row.symbol)
                + (row.mergedFrom > 1 ? `（合併 ${row.mergedFrom} 筆）` : ''),
            }),
            // 靠名稱推出來的代號要標示，使用者才知道這一筆值得多看一眼
            row.resolvedBy === 'name'
              ? el('span.badge', { text: '由名稱推定', title: '原始畫面沒有代號，代號是查表補上的' })
              : null,
          ]),
          row.resolvedBy === 'name'
            ? el('div.import-row__symbol', {}, [
              el('span.import-field__label', { text: '代號（推定錯誤請改這裡）' }),
              el('input.input.input--sm', {
                type: 'text',
                value: row.symbol,
                onInput: (e) => { row.symbol = e.target.value.trim().toUpperCase(); },
              }),
            ])
            : null,
          el('div.import-row__fields', {}, [
            labelled('股數', num('shares', '必填')),
            row.totalCost != null
              ? labelled('成本總額', num('totalCost', '沒有可留白'))
              : labelled('每股成本', num('avgCost', '沒有可留白')),
            labelled('現價', num('price', '選填')),
          ]),
        ]));
      }

      return wrap;
    }

    function labelled(text, input) {
      return el('div.import-field', {}, [el('span.import-field__label', { text }), input]);
    }

    // ------------------------------------------------------------ 匯入

    function buildActions() {
      const usable = stateIn.rows.filter((r) => !r.skip).length;

      return el('div.sheet__actions', {}, [
        el('button.btn.btn--ghost', {
          type: 'button',
          onClick: () => {
            stateIn.batches = [];
            stateIn.rows = [];
            stateIn.duplicates = [];
            stateIn.combined = false;
            stateIn.unresolved = [];
            stateIn.conflicts = [];
            stateIn.layoutLost = false;
            render();
          },
        }, ['清空重來']),
        el('button.btn.btn--primary', {
          type: 'button',
          onClick: () => doImport(),
        }, [`匯入 ${usable} 檔`]),
      ]);
    }

    async function doImport() {
      const { trades, quotes, errors } = rowsToTrades(stateIn.rows, [], todayISO());

      if (!trades.length) {
        toast(errors[0] ?? '沒有可匯入的資料', 'error', 3600);
        return;
      }

      if (errors.length) {
        const ok = await confirmDialog(
          `有 ${errors.length} 檔無法匯入`,
          `${errors.slice(0, 3).join('\n')}\n\n其餘 ${trades.length} 檔要照樣匯入嗎？`,
        );
        if (!ok) return;
      }

      // 已經存在的代號要先問過，否則會憑空多出一筆期初持股讓股數翻倍
      const existing = new Set(store.stockPositions().filter((p) => p.shares > 0).map((p) => p.symbol));
      const clash = trades.filter((t) => existing.has(t.symbol)).map((t) => t.symbol);
      if (clash.length) {
        const ok = await confirmDialog(
          '有重複的股票',
          `${clash.join('、')} 已經在持股清單裡。`
            + '繼續匯入會再加一筆期初持股，股數會變成兩者相加。確定要繼續嗎？',
          { danger: true },
        );
        if (!ok) return;
      }

      let done = 0;
      for (const t of trades) {
        const r = await store.saveStockTrade(t);
        if (r.ok) done += 1;
      }
      for (const q of quotes) await store.setQuote(q.symbol, q.close, { source: 'import' });

      haptic(15);
      toast(`已匯入 ${done} 檔`, 'success');
      close();
      onDone?.();
    }

    // ------------------------------------------------------------ 狀態

    function recompute() {
      // 又貼了新的一頁，先前的合併結果就過時了
      stateIn.combined = false;
      const merged = mergeBatches(stateIn.batches.map((b) => b.rows));
      stateIn.duplicates = merged.duplicates;

      // 用代號把各批互補起來：先貼「商品＋庫存數量」、再貼「商品＋成本金額」，
      // 兩批就湊成完整的一筆。這是寬表格唯一可靠的取得方式。
      const bySymbol = mergeBySymbol(resolvedRowsOfAllBatches());
      stateIn.rows = bySymbol.rows;
      stateIn.conflicts = bySymbol.conflicts;
    }

    /**
     * 把每一批各自依「自己的」欄位對應攤平成 shares / avgCost / price。
     * 之後的合併與寫入都只看這三個欄位，不再需要 mapping。
     */
    function resolvedRowsOfAllBatches() {
      const out = [];
      for (const batch of stateIn.batches) {
        const idx = (field) => batch.mapping.indexOf(field);
        for (const row of batch.rows) {
          const pick = (field) => {
            const i = idx(field);
            return i >= 0 ? row.numbers?.[i] ?? null : null;
          };
          // 欄位數與其他列不一致的，不按位置對應 ——
          // 少一格卻照樣對，成本會安靜地跑到別的欄位去。留白讓使用者自己填。
          if (row.incomplete) {
            row.shares = null;
            row.avgCost = null;
            row.totalCost = null;
            row.price = null;
          } else {
            row.shares = pick(FIELD.SHARES);
            row.avgCost = pick(FIELD.AVG_COST);
            row.totalCost = pick(FIELD.TOTAL_COST);
            row.price = pick(FIELD.PRICE);
          }
          out.push(row);
        }
      }
      return out;
    }

    render();
  });
}
