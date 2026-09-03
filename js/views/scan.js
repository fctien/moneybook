/**
 * 掃電子發票：拍照 → 解出品項 → 確認 → 記帳。
 *
 * 設計取捨：
 * - 解不出品項時「不」視為失敗。左方二維條碼一定有日期與總金額，
 *   光是自動帶出這兩項就已經省掉大半輸入，退回讓使用者自己選分類即可。
 * - 逐項記帳時每一列可以各自指定分類 —— 一張全聯的發票裡混著食材與日用品，
 *   全部塞進同一個分類會讓月報表失真。
 */

import * as store from '../store.js';
import { el, clear, toast, haptic, openSheet, confirmDialog } from '../ui.js';
import { formatAmount, CENTS_PER_UNIT } from '../lib/money.js';
import { parseInvoiceQR, looksLikeInvoiceQR } from '../lib/invoice.js';
import { scanQRCodesFromImage, capturePhoto } from '../lib/qrscan.js';

/**
 * 啟動掃描流程。
 *
 * @param {object} [opts]
 * @param {(info:{count:number}) => void} [opts.onSaved]
 * @param {() => Promise<File|Blob|null>} [opts.pickPhoto]
 *        照片來源。預設叫出系統相機；自動化測試可注入固定的圖片，
 *        否則檔案選取對話框會讓測試整個卡住。
 */
export async function startInvoiceScan({ onSaved, pickPhoto = capturePhoto } = {}) {
  const file = await pickPhoto();
  if (!file) return; // 使用者取消

  const closeBusy = showBusy();
  let codes;
  try {
    codes = await scanQRCodesFromImage(file);
  } catch (err) {
    closeBusy();
    toast(err?.message || '照片處理失敗', 'error');
    return;
  }
  closeBusy();

  const invoiceCodes = codes.filter((c) => looksLikeInvoiceQR(c.bytes ?? c.text));
  if (!invoiceCodes.length) {
    toast('沒有讀到發票條碼，請對準發票下方兩個方塊重拍', 'error', 3600);
    return;
  }

  // 左方是有表頭那個，右方以 ** 起始；parseInvoiceQR 會自行校正順序
  const left = invoiceCodes.find((c) => !c.text.startsWith('**')) ?? invoiceCodes[0];
  const right = invoiceCodes.find((c) => c !== left);

  const parsed = parseInvoiceQR(left.bytes ?? left.text, right ? (right.bytes ?? right.text) : undefined);
  if (!parsed.ok) {
    toast(parsed.error, 'error', 3600);
    return;
  }

  if (!(await confirmIfDuplicate(parsed.value.invoiceNumber))) return;

  haptic(12);
  openConfirmSheet(parsed.value, onSaved);
}

/**
 * 掃發票的使用說明。
 *
 * 刻意把「哪些發票不適用」寫在說明裡而不是等失敗才跳錯誤 ——
 * 使用者對著一張手開收據拍三次都掃不到，只會覺得功能壞了。
 */
export function openScanHelp() {
  openSheet('怎麼掃電子發票', (body) => {
    body.append(
      el('p.sheet__message', {
        text: '電子發票證明聯的下方印有兩個方塊狀的條碼，品名、數量、單價本來就記在裡面。App 直接讀取，不需要辨識文字，也不會把照片傳出去。',
      }),

      el('div.help-block', {}, [
        el('div.help-block__title', { text: '操作步驟' }),
        el('ol.guide-list', {}, [
          el('li', { text: '按上方「📷 掃電子發票」，手機會叫出相機。' }),
          el('li', { text: '對準發票「最下方」，讓兩個方塊條碼都完整入鏡再拍。' }),
          el('li', { text: '解出品項後，勾選要記的項目，並幫每一項選分類。' }),
          el('li', { text: '按「記錄」，每個勾選的品項各存成一筆。' }),
        ]),
      ]),

      el('div.help-block', {}, [
        el('div.help-block__title', { text: '拍不到時試試' }),
        el('ul.guide-list', {}, [
          el('li', { text: '把發票攤平，不要有摺痕壓在條碼上。' }),
          el('li', { text: '光線要足，但避免正上方反光。' }),
          el('li', { text: '鏡頭再靠近一點，讓兩個條碼佔滿畫面寬度。' }),
          el('li', { text: '左右拍反了沒關係，App 會自動判斷。' }),
        ]),
      ]),

      el('div.help-block', {}, [
        el('div.help-block__title', { text: '兩種記法' }),
        el('ul.guide-list', {}, [
          el('li', { text: '逐項記帳：每個品項各記一筆，可分別指定分類。一張發票裡混著食材和日用品時用這個。' }),
          el('li', { text: '記成一筆：只記總金額，品名寫進備註。懶得分類時用這個。' }),
        ]),
      ]),

      el('div.help-block', {}, [
        el('div.help-block__title', { text: '這些情況掃不出品項' }),
        el('ul.guide-list', {}, [
          el('li', { text: '傳統手開發票、一般收據、國外消費 —— 上面沒有這種條碼。' }),
          el('li', { text: '品項太多時，超出的明細只存在財政部平台，發票本身沒有記載。' }),
          el('li', { text: '有些店家的品名是內部代碼或只寫「商品」，這是店家端的問題。' }),
        ]),
        el('p.hint', {
          text: '就算解不出品項也不算白掃 —— 日期與總金額一定讀得到，會自動帶入，您只要選分類。',
        }),
      ]),

      el('p.hint.hint--block', {
        text: '照片只在手機裡運算，用完即丟，不會儲存也不會上傳。同一張發票掃第二次會跳出提醒。',
      }),
    );
  });
}

/** 掃描期間的簡單遮罩，避免使用者以為當掉了 */
function showBusy() {
  const node = el('div.scan-busy', {}, [
    el('div.scan-busy__box', {}, [
      el('div.scan-busy__spinner'),
      el('div.scan-busy__text', { text: '辨識中…' }),
    ]),
  ]);
  document.body.append(node);
  return () => node.remove();
}

/** 依品名猜分類：對到既有分類名稱就用它，猜不到留空讓使用者選 */
function guessCategoryId(name, categories) {
  if (!name) return '';
  const hit = categories.find((c) => name.includes(c.name));
  return hit ? hit.id : '';
}

function openConfirmSheet(invoice, onSaved) {
  const categories = store.categoriesOfType('expense');
  const accounts = store.postableAccounts();

  if (!accounts.length) {
    toast('還沒有可記帳的帳戶，請先到「資產」頁新增', 'error', 3600);
    return;
  }

  // 逐項記帳只在真的有品項時才有意義
  const hasItems = invoice.items.length > 0;
  const draft = {
    mode: hasItems ? 'items' : 'total',
    accountId: accounts[0].id,
    totalCategoryId: '',
    rows: invoice.items.map((it) => ({
      ...it,
      checked: true,
      categoryId: guessCategoryId(it.name, categories),
      // 單價 × 數量；任一缺漏就退回 null，交由使用者處理
      amount: it.unitPrice != null && it.quantity != null
        ? Math.round(it.unitPrice * it.quantity)
        : null,
    })),
  };

  openSheet('確認發票內容', (body, close) => {
    const rerender = () => { clear(body); render(); };

    function render() {
      body.append(buildSummary(invoice));

      if (invoice.itemsTruncated) {
        body.append(el('p.hint.hint--warn', {
          text: '這張發票的品項超過條碼可記載的數量，只解出部分明細，其餘請自行補上。',
        }));
      }

      if (hasItems) body.append(buildModeToggle(draft, rerender));

      body.append(
        draft.mode === 'items'
          ? buildItemList(draft, categories, invoice, rerender)
          : buildTotalForm(draft, categories, invoice),
      );

      body.append(buildAccountRow(draft, accounts, rerender));
      body.append(buildActions(invoice, draft, close, onSaved));
    }

    render();
  });
}

function buildSummary(invoice) {
  return el('div.invoice-summary', {}, [
    el('div.invoice-summary__amount', { text: formatAmount(invoice.totalAmount * CENTS_PER_UNIT) }),
    el('div.invoice-summary__meta', {
      text: `${invoice.date}　${invoice.invoiceNumber}`,
    }),
  ]);
}

function buildModeToggle(draft, rerender) {
  const mk = (mode, label) => el('button.segment__item', {
    type: 'button',
    class: `segment__item${draft.mode === mode ? ' is-active' : ''}`,
    onClick: () => { draft.mode = mode; rerender(); },
  }, [label]);

  return el('div.segment', { role: 'tablist' }, [
    mk('items', '逐項記帳'),
    mk('total', '記成一筆'),
  ]);
}

function buildItemList(draft, categories, invoice, rerender) {
  const wrap = el('div.invoice-items');

  for (const row of draft.rows) {
    const check = el('input', {
      type: 'checkbox',
      checked: row.checked,
      onChange: (e) => { row.checked = e.target.checked; updateTotal(); },
    });

    const select = el('select.invoice-item__cat', {
      onChange: (e) => { row.categoryId = e.target.value; },
    }, [
      el('option', { value: '', text: '選分類' }),
      ...categories.map((c) => el('option', {
        value: c.id,
        text: `${c.icon ?? ''}${c.name}`,
        selected: c.id === row.categoryId,
      })),
    ]);

    wrap.append(el('label.invoice-item', {}, [
      check,
      el('div.invoice-item__main', {}, [
        el('div.invoice-item__name', { text: row.name || '（無品名）' }),
        el('div.invoice-item__detail', {
          text: row.quantity != null && row.unitPrice != null
            ? `${row.quantity} × ${row.unitPrice}`
            : '數量或單價缺漏',
        }),
      ]),
      select,
      el('div.invoice-item__amount', {
        text: row.amount != null ? formatAmount(row.amount * CENTS_PER_UNIT) : '—',
      }),
    ]));
  }

  const totalLine = el('div.invoice-total');
  wrap.append(totalLine);
  updateTotal();

  function updateTotal() {
    const sum = draft.rows
      .filter((r) => r.checked && r.amount != null)
      .reduce((a, r) => a + r.amount, 0);

    clear(totalLine);
    totalLine.append(el('span', { text: `已選 ${formatAmount(sum * CENTS_PER_UNIT)}` }));

    // 對不起來通常是明細被截斷、或發票有折扣，提醒但不阻擋
    if (sum !== invoice.totalAmount) {
      totalLine.append(el('span.invoice-total__diff', {
        text: `　與發票總額 ${formatAmount(invoice.totalAmount * CENTS_PER_UNIT)} 不符`,
      }));
    }
  }

  return wrap;
}

function buildTotalForm(draft, categories, invoice) {
  return el('div.field', {}, [
    el('div.field__label', { text: '分類' }),
    el('select.invoice-item__cat', {
      onChange: (e) => { draft.totalCategoryId = e.target.value; },
    }, [
      el('option', { value: '', text: '選分類' }),
      ...categories.map((c) => el('option', {
        value: c.id,
        text: `${c.icon ?? ''}${c.name}`,
        selected: c.id === draft.totalCategoryId,
      })),
    ]),
    el('p.hint', {
      text: invoice.items.length
        ? '會記成一筆，品名寫進備註。'
        : '這張發票沒有品項明細，只能記總額。',
    }),
  ]);
}

function buildAccountRow(draft, accounts, rerender) {
  return el('div.field', {}, [
    el('div.field__label', { text: '帳戶' }),
    el('div.chip-row', {}, accounts.map((a) => el('button', {
      type: 'button',
      class: `chip${a.id === draft.accountId ? ' is-active' : ''}`,
      onClick: () => { draft.accountId = a.id; rerender(); },
    }, [a.name]))),
  ]);
}

function buildActions(invoice, draft, close, onSaved) {
  return el('div.sheet__actions', {}, [
    el('button.btn.btn--primary', {
      type: 'button',
      onClick: () => save(invoice, draft, close, onSaved),
    }, ['記錄']),
  ]);
}

async function save(invoice, draft, close, onSaved) {
  const payloads = [];

  if (draft.mode === 'items') {
    const picked = draft.rows.filter((r) => r.checked);
    if (!picked.length) return toast('至少要選一個品項', 'error');
    if (picked.some((r) => r.amount == null)) return toast('有品項的金額缺漏，請取消勾選或改記總額', 'error', 3600);
    if (picked.some((r) => !r.categoryId)) return toast('每個品項都要選分類', 'error');

    for (const r of picked) {
      payloads.push({
        type: 'expense',
        date: invoice.date,
        amount: r.amount * CENTS_PER_UNIT,
        accountId: draft.accountId,
        categoryId: r.categoryId,
        note: `${r.name}｜${invoice.invoiceNumber}`,
      });
    }
  } else {
    if (!draft.totalCategoryId) return toast('請選分類', 'error');
    const names = invoice.items.map((i) => i.name).filter(Boolean).join('、');
    payloads.push({
      type: 'expense',
      date: invoice.date,
      amount: invoice.totalAmount * CENTS_PER_UNIT,
      accountId: draft.accountId,
      categoryId: draft.totalCategoryId,
      note: (names ? `${names}｜` : '') + invoice.invoiceNumber,
    });
  }

  const failures = [];
  for (const p of payloads) {
    // eslint-disable-next-line no-await-in-loop -- 筆數少，循序寫入比較好回報哪一筆失敗
    const r = await store.saveTransaction(p);
    if (!r.ok) failures.push(r.error);
  }

  if (failures.length) {
    toast(`有 ${failures.length} 筆沒寫入：${failures[0]}`, 'error', 4000);
    return;
  }

  haptic(15);
  toast(`已記錄 ${payloads.length} 筆`, 'success');
  close();
  onSaved?.({ count: payloads.length });
}

/**
 * 同一張發票可能被重複掃描，這裡提供給呼叫端做提醒用。
 * 目前僅比對備註裡的發票號碼，夠簡單也夠準。
 */
export async function confirmIfDuplicate(invoiceNumber) {
  const dup = store.state.transactions.some((t) => t.note?.includes(invoiceNumber));
  if (!dup) return true;
  return confirmDialog('這張發票掃過了', `發票 ${invoiceNumber} 已經有紀錄，還要再記一次嗎？`);
}
