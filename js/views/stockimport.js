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
  mergeBatches, combineDuplicates, rowsToTrades,
} from '../lib/importparse.js';
import { nameToSymbol } from '../lib/stocklookup.js';
import * as store from '../store.js';

const FIELD_LABEL = {
  [FIELD.IGNORE]: '不使用',
  [FIELD.SHARES]: '股數',
  [FIELD.AVG_COST]: '成本價',
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
  const stateIn = {
    batches: [], mapping: [], rows: [], duplicates: [], combined: false,
    // 讀到了但查不出是哪一檔的名稱，要讓使用者知道有東西被漏掉
    unresolved: [],
  };

  openSheet('匯入持股', (body, close) => {
    const render = () => {
      clear(body);
      body.append(buildSource());
      if (stateIn.rows.length) {
        body.append(buildMapping(), buildPreview(), buildActions());
      } else {
        const unresolved = buildUnresolved();
        if (unresolved) body.append(unresolved);
        body.append(buildHelp());
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
        const { rows, skipped, unresolved } = extractHoldings(text, { lookup: nameToSymbol });
        if (unresolved.length) stateIn.unresolved.push(...unresolved);

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
        stateIn.batches.push(rows);
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
      const width = Math.max(0, ...stateIn.rows.map((r) => (r.numbers ?? []).length));
      if (!width) return el('div');

      const selects = [];
      for (let c = 0; c < width; c += 1) {
        const sample = stateIn.rows.find((r) => r.numbers?.[c] != null)?.numbers[c];
        selects.push(el('div.map-col', {}, [
          el('div.map-col__label', { text: `第 ${c + 1} 欄`, title: String(sample ?? '') }),
          el('select.invoice-item__cat', {
            onChange: (e) => {
              stateIn.mapping[c] = e.target.value;
              // 換了對應就重新套用，使用者手改過的值會被覆蓋 —— 這是刻意的，
              // 否則畫面會同時存在兩套互相矛盾的數字。
              // 已經合併過的話要從原始批次重新合併：合併後的 numbers 只留第一批的，
              // 若拿它重算會靜默得到錯的股數與成本。
              if (stateIn.combined) {
                stateIn.rows = combineDuplicates(stateIn.batches.flat(), stateIn.mapping);
              } else {
                resolveRows(true);
              }
              render();
            },
          }, Object.entries(FIELD_LABEL).map(([v, label]) => el('option', {
            value: v, text: label, selected: stateIn.mapping[c] === v,
          }))),
          el('div.map-col__sample', { text: sample == null ? '' : String(sample) }),
        ]));
      }

      return el('div.field', {}, [
        el('div.field__label', { text: '這幾欄分別是什麼' }),
        el('div.map-row', {}, selects),
      ]);
    }

    // ------------------------------------------------------------ 預覽

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
              const all = stateIn.batches.flat();
              stateIn.rows = combineDuplicates(all, stateIn.mapping);
              stateIn.duplicates = [];
              stateIn.combined = true;
              toast('已合併重複的股票', 'success');
              render();
            },
          }, ['股數相加、成本取加權平均']),
        ]));
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
            labelled('成本價', num('avgCost', '必填')),
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
            stateIn.mapping = [];
            stateIn.combined = false;
            stateIn.unresolved = [];
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
      const { trades, quotes, errors } = rowsToTrades(stateIn.rows, stateIn.mapping, todayISO());

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
      const merged = mergeBatches(stateIn.batches);
      stateIn.rows = merged.rows;
      stateIn.duplicates = merged.duplicates;
      if (!stateIn.mapping.length) stateIn.mapping = suggestMapping(stateIn.rows);
      resolveRows(true);
    }

    /** 依目前的欄位對應，把 numbers 攤成 shares / avgCost / price */
    function resolveRows(overwrite = false) {
      const idx = (field) => stateIn.mapping.indexOf(field);
      for (const row of stateIn.rows) {
        const pick = (field) => {
          const i = idx(field);
          return i >= 0 ? row.numbers?.[i] ?? null : null;
        };
        if (overwrite || row.shares == null) row.shares = pick(FIELD.SHARES);
        if (overwrite || row.avgCost == null) row.avgCost = pick(FIELD.AVG_COST);
        if (overwrite || row.price == null) row.price = pick(FIELD.PRICE);
      }
    }

    render();
  });
}
