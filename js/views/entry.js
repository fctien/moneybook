/**
 * 記帳輸入頁。
 *
 * 這一頁的唯一目標是「三下記完一筆」：選分類 → 打金額 → 按完成。
 * 因此刻意用自製數字鍵盤而不是系統鍵盤：
 * 1. 系統鍵盤會從下方彈出遮住分類區，每次都要收起來再操作
 * 2. 自製鍵盤可以放 + - × ÷，買了三樣東西可以直接打 35+50+120
 * 3. 按鍵可以做到 60px 高，走在路上單手也按得準
 */

import { el, clear, toast, haptic, confirmDialog } from '../ui.js';
import { formatAmount, parseAmount, evaluateExpression } from '../lib/money.js';
import { todayISO, formatRelativeDay } from '../lib/dateutil.js';
import { categoryFrequency } from '../lib/stats.js';
import * as store from '../store.js';

const TYPES = [
  { id: 'expense', label: '支出' },
  { id: 'income', label: '收入' },
  { id: 'transfer', label: '轉帳' },
];

const KEYPAD = ['7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '-', '.', '0', 'back', '+'];

export function createEntryView({ onSaved } = {}) {
  const draft = {
    id: null,
    type: 'expense',
    expression: '',
    categoryId: null,
    accountId: null,
    toAccountId: null,
    date: todayISO(),
    note: '',
  };

  const node = el('section.view.view--entry');
  const refs = {};

  build();

  function build() {
    clear(node);

    refs.typeBar = el('div.segment', { role: 'tablist' });
    refs.amount = el('div.amount-display');
    refs.amountHint = el('div.amount-hint');
    refs.categoryGrid = el('div.category-grid');
    refs.accountRow = el('div.chip-row');
    refs.transferRow = el('div.transfer-row.is-hidden');
    refs.dateRow = el('div.chip-row.chip-row--date');
    refs.note = el('input.note-input', {
      type: 'text',
      placeholder: '備註（選填）',
      maxlength: '200',
      onInput: (e) => { draft.note = e.target.value; },
    });
    // 掃發票是「一次記完整張」的捷徑，跟下面手動輸入互不干擾，
    // 所以放在分類上方而不是擠進鍵盤區
    refs.scanBtn = el('button.btn.btn--scan', {
      type: 'button',
      onClick: async () => {
        // 動態載入：掃描要用到的 QR 解碼元件有 250 KB，
        // 沒按這顆按鈕的人不該為它付出啟動時間
        const { startInvoiceScan } = await import('./scan.js');
        await startInvoiceScan({ onSaved: () => onSaved?.({ wasEditing: false }) });
      },
    }, ['📷 掃電子發票']);

    // 光有一顆按鈕，使用者不會知道該拍發票的哪個部位、也不知道哪些發票不適用。
    // 一行提示講清楚最常見的用法，細節與限制收進「怎麼用」。
    refs.scanHelp = el('div.scan-hint', {}, [
      el('span', { text: '拍發票下方兩個方塊，自動帶出品項與金額' }),
      el('button.link-btn', {
        type: 'button',
        onClick: async () => {
          // scan.js 只有 10 KB，且不會連帶載入 jsQR（那是按下掃描才載入的）
          const { openScanHelp } = await import('./scan.js');
          openScanHelp();
        },
      }, ['怎麼用？']),
    ]);

    refs.keypad = el('div.keypad');
    refs.submit = el('button.btn.btn--primary.btn--submit', { type: 'button', onClick: submit }, ['完成']);
    refs.cancelEdit = el('button.btn.btn--ghost.is-hidden', { type: 'button', onClick: () => resetDraft() }, ['取消編輯']);

    node.append(
      el('div.entry-top', {}, [
        refs.typeBar,
        el('div.amount-box', {}, [refs.amount, refs.amountHint]),
      ]),
      el('div.entry-scroll', {}, [
        refs.scanBtn,
        refs.scanHelp,
        el('div.field', {}, [el('div.field__label', { text: '分類' }), refs.categoryGrid]),
        el('div.field', {}, [el('div.field__label', { text: '帳戶' }), refs.accountRow, refs.transferRow]),
        el('div.field', {}, [el('div.field__label', { text: '日期' }), refs.dateRow]),
        el('div.field', {}, [refs.note]),
      ]),
      el('div.entry-bottom', {}, [
        refs.keypad,
        el('div.entry-actions', {}, [refs.cancelEdit, refs.submit]),
      ]),
    );

    buildTypeBar();
    buildKeypad();
    refresh();
  }

  function buildTypeBar() {
    clear(refs.typeBar);
    for (const type of TYPES) {
      refs.typeBar.append(el('button.segment__item', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(draft.type === type.id),
        class: draft.type === type.id ? 'is-active' : '',
        onClick: () => {
          if (draft.type === type.id) return;
          draft.type = type.id;
          draft.categoryId = null;
          haptic();
          refresh();
        },
      }, [type.label]));
    }
  }

  function buildKeypad() {
    clear(refs.keypad);
    for (const key of KEYPAD) {
      if (key === 'back') {
        refs.keypad.append(el('button.key.key--fn', {
          type: 'button',
          'aria-label': '刪除',
          onClick: () => pressBackspace(),
          onContextmenu: (e) => { e.preventDefault(); draft.expression = ''; renderAmount(); },
        }, ['⌫']));
      } else {
        const isOperator = ['+', '-', '×', '÷'].includes(key);
        refs.keypad.append(el(`button.key${isOperator ? '.key--op' : ''}`, {
          type: 'button',
          onClick: () => pressKey(key),
        }, [key]));
      }
    }
  }

  function pressKey(key) {
    haptic();
    const last = draft.expression.slice(-1);
    const isOperator = ['+', '-', '×', '÷'].includes(key);

    if (isOperator) {
      if (draft.expression === '') return;               // 不允許以運算子開頭
      if (['+', '-', '×', '÷'].includes(last)) {
        draft.expression = draft.expression.slice(0, -1) + key; // 連按運算子視為改變運算子
      } else {
        draft.expression += key;
      }
    } else if (key === '.') {
      // 目前這一段數字已經有小數點就不再加
      const segment = draft.expression.split(/[+\-×÷]/).pop();
      if (segment.includes('.')) return;
      draft.expression += draft.expression === '' || ['+', '-', '×', '÷'].includes(last) ? '0.' : '.';
    } else {
      const segment = draft.expression.split(/[+\-×÷]/).pop();
      // 擋掉 007 這種輸入，但允許 0.5
      if (segment === '0') draft.expression = draft.expression.slice(0, -1) + key;
      else if (segment.replace('.', '').length >= 12) return;
      else draft.expression += key;
    }
    renderAmount();
  }

  function pressBackspace() {
    haptic();
    draft.expression = draft.expression.slice(0, -1);
    renderAmount();
  }

  /** 目前輸入框對應的金額（cents），無效時回 null */
  function currentCents() {
    if (draft.expression === '') return null;
    const withOperator = /[+\-×÷]/.test(draft.expression);
    return withOperator ? evaluateExpression(draft.expression) : parseAmount(draft.expression);
  }

  function renderAmount() {
    const cents = currentCents();
    const hasOperator = /[+\-×÷]/.test(draft.expression);

    refs.amount.textContent = draft.expression === '' ? '0' : draft.expression;
    refs.amount.classList.toggle('is-placeholder', draft.expression === '');

    if (hasOperator && cents !== null) {
      refs.amountHint.textContent = `= ${formatAmount(cents)}`;
      refs.amountHint.classList.remove('is-error');
    } else if (draft.expression !== '' && cents === null) {
      refs.amountHint.textContent = '算式還沒輸入完';
      refs.amountHint.classList.add('is-error');
    } else {
      refs.amountHint.textContent = '';
      refs.amountHint.classList.remove('is-error');
    }

    refs.submit.disabled = cents === null || cents <= 0;
  }

  function renderCategories() {
    clear(refs.categoryGrid);

    if (draft.type === 'transfer') {
      refs.categoryGrid.append(el('p.hint', { text: '轉帳只是把錢從一個帳戶搬到另一個，不列入收支統計，因此不需要分類。' }));
      return;
    }

    const categories = store.categoriesOfType(draft.type);
    if (!categories.length) {
      refs.categoryGrid.append(el('p.hint', { text: '還沒有分類，請到「設定 → 分類管理」新增。' }));
      return;
    }

    // 常用的排前面：走路時最想按的就是那三四個最常用分類
    const freq = categoryFrequency(store.state.transactions, draft.type);
    const sorted = [...categories].sort((a, b) => (freq.get(b.id) ?? 0) - (freq.get(a.id) ?? 0) || (a.order ?? 0) - (b.order ?? 0));

    for (const cat of sorted) {
      const active = draft.categoryId === cat.id;
      refs.categoryGrid.append(el(`button.cat${active ? '.is-active' : ''}`, {
        type: 'button',
        style: active ? { borderColor: cat.color, background: `${cat.color}1a` } : {},
        onClick: () => {
          draft.categoryId = cat.id;
          haptic();
          renderCategories();
          renderAmount();
        },
      }, [
        el('span.cat__icon', { text: cat.icon || '📌' }),
        el('span.cat__name', { text: cat.name }),
      ]));
    }
  }

  function renderAccounts() {
    clear(refs.accountRow);
    // 只列自動累算的帳戶。手動估值的項目（股票、不動產、貸款）記帳不會改變餘額，
    // 列在這裡只會讓使用者記出一筆對不上的帳。
    const accounts = store.postableAccounts();

    if (!accounts.length) {
      refs.accountRow.append(el('p.hint', {
        text: store.activeAccounts().length
          ? '目前的帳戶都是「手動估值」，無法記帳。請到「資產」頁新增現金或銀行帳戶。'
          : '還沒有帳戶，請到「資產」頁新增。',
      }));
      refs.transferRow.classList.add('is-hidden');
      draft.accountId = null;
      return;
    }

    if (!draft.accountId || !accounts.some((a) => a.id === draft.accountId)) {
      draft.accountId = accounts[0].id;
    }

    for (const acc of accounts) {
      refs.accountRow.append(el(`button.chip${draft.accountId === acc.id ? '.is-active' : ''}`, {
        type: 'button',
        onClick: () => { draft.accountId = acc.id; haptic(); renderAccounts(); },
      }, [acc.name]));
    }

    if (draft.type === 'transfer') {
      refs.transferRow.classList.remove('is-hidden');
      clear(refs.transferRow);
      refs.transferRow.append(el('div.field__label', { text: '轉入' }));
      const row = el('div.chip-row');
      const targets = accounts.filter((a) => a.id !== draft.accountId);
      if (!draft.toAccountId || !targets.some((a) => a.id === draft.toAccountId)) {
        draft.toAccountId = targets[0]?.id ?? null;
      }
      for (const acc of targets) {
        row.append(el(`button.chip${draft.toAccountId === acc.id ? '.is-active' : ''}`, {
          type: 'button',
          onClick: () => { draft.toAccountId = acc.id; haptic(); renderAccounts(); },
        }, [acc.name]));
      }
      refs.transferRow.append(row);
    } else {
      refs.transferRow.classList.add('is-hidden');
    }
  }

  function renderDate() {
    clear(refs.dateRow);
    const today = todayISO();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayISO = todayISO(yesterday);

    for (const [label, value] of [['今天', today], ['昨天', yesterdayISO]]) {
      refs.dateRow.append(el(`button.chip${draft.date === value ? '.is-active' : ''}`, {
        type: 'button',
        onClick: () => { draft.date = value; haptic(); renderDate(); },
      }, [label]));
    }

    const custom = el('input.date-input', {
      type: 'date',
      value: draft.date,
      max: today,
      onChange: (e) => {
        draft.date = e.target.value || today;
        renderDate();
      },
    });
    const isCustom = draft.date !== today && draft.date !== yesterdayISO;
    refs.dateRow.append(el(`div.chip.chip--date${isCustom ? '.is-active' : ''}`, {}, [
      isCustom ? formatRelativeDay(draft.date) : '其他',
      custom,
    ]));
  }

  async function submit() {
    const cents = currentCents();
    if (cents === null || cents <= 0) {
      toast('請輸入金額', 'error');
      return;
    }

    const payload = {
      id: draft.id ?? undefined,
      type: draft.type,
      date: draft.date,
      amount: cents,
      accountId: draft.accountId,
      toAccountId: draft.type === 'transfer' ? draft.toAccountId : null,
      categoryId: draft.type === 'transfer' ? null : draft.categoryId,
      note: draft.note,
      createdAt: draft.createdAt,
    };

    const result = await store.saveTransaction(payload);
    if (!result.ok) {
      toast(result.error, 'error');
      return;
    }

    haptic(15);
    toast(draft.id ? '已更新' : `已記錄 ${formatAmount(cents)}`, 'success');
    const wasEditing = Boolean(draft.id);
    resetDraft();
    onSaved?.({ wasEditing });
  }

  function resetDraft() {
    draft.id = null;
    draft.createdAt = undefined;
    draft.expression = '';
    draft.note = '';
    draft.date = todayISO();
    refs.note.value = '';
    refs.cancelEdit.classList.add('is-hidden');
    refs.submit.textContent = '完成';
    refresh();
  }

  /** 從明細頁點「編輯」時載入既有交易 */
  function loadTransaction(tx) {
    draft.id = tx.id;
    draft.createdAt = tx.createdAt;
    draft.type = tx.type;
    draft.expression = String(tx.amount / 100);
    draft.categoryId = tx.categoryId;
    draft.accountId = tx.accountId;
    draft.toAccountId = tx.toAccountId;
    draft.date = tx.date;
    draft.note = tx.note ?? '';
    refs.note.value = draft.note;
    refs.cancelEdit.classList.remove('is-hidden');
    refs.submit.textContent = '儲存修改';
    refresh();
  }

  async function confirmLeaveEdit() {
    if (!draft.id) return true;
    return confirmDialog('放棄修改？', '目前正在編輯一筆既有紀錄，離開會放棄未儲存的變更。', {
      confirmText: '放棄',
      danger: true,
    });
  }

  function refresh() {
    buildTypeBar();
    renderCategories();
    renderAccounts();
    renderDate();
    renderAmount();
  }

  return { node, refresh, loadTransaction, resetDraft, confirmLeaveEdit, isEditing: () => Boolean(draft.id) };
}
