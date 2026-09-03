/**
 * 台灣電子發票證明聯二維條碼解析。
 *
 * 依據財政部財政資訊中心「電子發票證明聯一維及二維條碼規格說明」v1.9。
 *
 * 為什麼讀 QR 而不做 OCR：
 * 品名、數量、單價本來就以數位形式編碼在發票右方的二維條碼裡，直接解出來是
 * 精確值，沒有辨識誤差；熱感應紙上的小字做 OCR 則既慢又不準，中文模型還要
 * 額外幾十 MB 的語言檔，離線快取會膨脹到不能接受。
 *
 * ── 左方二維條碼 ──
 * 前 77 碼為固定欄位：
 *   發票字軌號碼(10) 開立日期(7) 隨機碼(4) 銷售額(8,hex) 總計額(8,hex)
 *   買方統編(8) 賣方統編(8) 加密驗證資訊(24)
 * 其後每個欄位前以 ":" 區隔：
 *   營業人自行使用區(10) : 二維條碼記載品目筆數 : 該張發票品目總筆數
 *   : 中文編碼參數(0=Big5 1=UTF-8 2=Base64) : 品名 : 數量 : 單價 : ...
 *
 * ── 右方二維條碼 ──
 * 前 2 碼固定為 "**"，其後接續左方放不下的品目資訊。
 */

const HEADER_LEN = 77;
const RIGHT_PREFIX = '**';

export const ENCODING = { BIG5: '0', UTF8: '1', BASE64: '2' };

/**
 * 把 QR 掃到的內容正規化成 { text, bytes }。
 *
 * 品名可能是 Big5 編碼，那是「位元組」而不是可直接當字串用的東西，
 * 所以只要拿得到原始位元組就一併留著，交給後面依編碼參數決定怎麼解。
 *
 * @param {string|Uint8Array|number[]} raw
 */
function normalize(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return { text: raw, bytes: null };
  const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
  // 前 77 碼一定是 ASCII，用 latin1 逐位元組轉字元可保證位置對得上
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return { text, bytes };
}

/** 民國年月日（7 碼）轉 ISO 日期字串 */
export function rocDateToISO(roc) {
  if (typeof roc !== 'string' || !/^\d{7}$/.test(roc)) return null;
  const year = Number(roc.slice(0, 3)) + 1911;
  const month = roc.slice(3, 5);
  const day = roc.slice(5, 7);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${month}-${day}`;
}

/** 8 碼十六進位金額轉整數（元）。全 0 代表營業人未分離稅項，視為未提供。 */
export function hexAmountToNumber(hex) {
  if (typeof hex !== 'string' || !/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
  return parseInt(hex, 16);
}

/**
 * 依中文編碼參數把位元組解成字串。
 * Big5 走 TextDecoder；瀏覽器與 Node 都支援，但 Node 需要完整 ICU，
 * 因此失敗時退回 latin1，至少數字與單價還讀得出來。
 */
function decodeBytes(bytes, encoding) {
  if (!bytes) return null;
  const label = encoding === ENCODING.BIG5 ? 'big5' : 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}

/** Base64 解碼成字串（先試 UTF-8，失敗退 Big5） */
function decodeBase64(text) {
  let bin;
  try {
    bin = typeof atob === 'function'
      ? atob(text)
      : Buffer.from(text, 'base64').toString('binary');
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const utf8 = decodeBytes(bytes, ENCODING.UTF8);
  // UTF-8 解不出來時會出現替換字元，改用 Big5 再試一次
  if (utf8 && !utf8.includes('�')) return utf8;
  return decodeBytes(bytes, ENCODING.BIG5) ?? utf8;
}

/**
 * 從「品名:數量:單價」重複的欄位取出品項。
 * 用左方宣告的「二維條碼記載品目筆數」決定要讀幾組，剩下的視為補充說明。
 *
 * 中文編碼參數只作用在「品名」上 —— 數量與單價依規格是十進位明碼，
 * 若連它們也拿去 Base64 解碼，'35' 會被當成合法 Base64 而解成亂碼。
 *
 * @param {{text:string, bytes:Uint8Array|null}[]} fields 尚未解碼的欄位
 */
function readItems(fields, declaredCount, encoding) {
  const items = [];
  const max = Number.isFinite(declaredCount) && declaredCount >= 0
    ? declaredCount
    : Math.floor(fields.length / 3);

  for (let i = 0; i < max; i += 1) {
    const name = fields[i * 3];
    const qty = fields[i * 3 + 1];
    const price = fields[i * 3 + 2];
    if (!name || !qty || !price) break;

    const quantity = Number(qty.text);
    const unitPrice = Number(price.text);
    items.push({
      name: decodeSegment(name, encoding).trim(),
      quantity: Number.isFinite(quantity) ? quantity : null,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
    });
  }

  const consumed = items.length * 3;
  const note = fields.slice(consumed).map((f) => decodeSegment(f, encoding)).join(':').trim();
  return { items, note: note || null };
}

/**
 * 解析電子發票二維條碼。
 *
 * @param {string|Uint8Array} left  左方二維條碼內容
 * @param {string|Uint8Array} [right] 右方二維條碼內容（可省略，只是拿不到後半段品項）
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function parseInvoiceQR(left, right) {
  const L = normalize(left);
  if (!L) return { ok: false, error: '沒有讀到左方二維條碼' };

  // 使用者可能左右拍反了，這裡自動校正而不是要他重拍
  if (L.text.startsWith(RIGHT_PREFIX)) {
    const R = normalize(right);
    if (R && !R.text.startsWith(RIGHT_PREFIX)) return parseInvoiceQR(right, left);
    return { ok: false, error: '這是右方二維條碼，還需要左方那一個' };
  }

  if (L.text.length < HEADER_LEN) {
    return { ok: false, error: '左方二維條碼內容不完整，請重新拍攝' };
  }

  const header = L.text.slice(0, HEADER_LEN);
  const invoiceNumber = header.slice(0, 10);
  const date = rocDateToISO(header.slice(10, 17));
  const randomCode = header.slice(17, 21);
  const untaxed = hexAmountToNumber(header.slice(21, 29));
  const total = hexAmountToNumber(header.slice(29, 37));
  const buyerId = header.slice(37, 45);
  const sellerId = header.slice(45, 53);

  if (!/^[A-Z]{2}\d{8}$/.test(invoiceNumber)) {
    return { ok: false, error: '發票號碼格式不正確，可能不是電子發票證明聯' };
  }
  if (!date) return { ok: false, error: '發票日期格式不正確' };
  if (total === null) return { ok: false, error: '發票金額格式不正確' };

  // 77 碼之後才是以冒號分隔的延伸資訊
  const rest = L.text.slice(HEADER_LEN);
  const restBytes = L.bytes ? L.bytes.slice(HEADER_LEN) : null;

  const value = {
    invoiceNumber,
    date,
    randomCode,
    // 銷售額全 0 代表營業人無法分離稅項，此時沒有意義
    untaxedAmount: untaxed === 0 ? null : untaxed,
    totalAmount: total,
    buyerId: buyerId === '00000000' ? null : buyerId,
    sellerId,
    items: [],
    itemsTruncated: false,
    note: null,
  };

  // 沒有延伸資訊也算解析成功 —— 日期與總金額已經夠自動填一筆帳了
  if (!rest.startsWith(':')) return { ok: true, value };

  const segments = splitSegments(rest, restBytes);
  if (segments.length < 4) return { ok: true, value };

  const [, encodedCountRaw, totalCountRaw, encodingRaw] = segments;
  const encoding = encodingRaw?.text ?? ENCODING.UTF8;
  const encodedCount = Number(encodedCountRaw?.text);
  const totalCount = Number(totalCountRaw?.text);

  // 品項欄位從第 5 段開始，右方二維條碼是它的延續。
  // 這裡刻意保留未解碼的 {text, bytes}，等 readItems 才決定哪個欄位要解碼。
  let itemFields = segments.slice(4);

  const R = normalize(right);
  if (R && R.text.startsWith(RIGHT_PREFIX)) {
    const tail = R.text.slice(RIGHT_PREFIX.length);
    const tailBytes = R.bytes ? R.bytes.slice(RIGHT_PREFIX.length) : null;
    // 右方開頭若是冒號，代表它是獨立的一段；否則是左方最後一段被切斷的接續
    const joined = tail.startsWith(':') ? tail : `:${tail}`;
    const joinedBytes = tailBytes && !tail.startsWith(':') ? prependColon(tailBytes) : tailBytes;
    const tailSegments = splitSegments(joined, joinedBytes);

    if (!tail.startsWith(':') && itemFields.length && tailSegments.length) {
      itemFields[itemFields.length - 1] = concatSegments(itemFields.at(-1), tailSegments.shift());
    }
    itemFields = itemFields.concat(tailSegments);
  }

  const { items, note } = readItems(itemFields, encodedCount, encoding);
  value.items = items;
  value.note = note;
  // 發票上記載的品目筆數少於實際總筆數時，其餘明細只存在財政部平台
  value.itemsTruncated = Number.isFinite(totalCount) && items.length < totalCount;

  return { ok: true, value };
}

/**
 * 接回被左右二維條碼切斷的同一個欄位。
 * 文字與位元組要一起接，Big5 的品名才不會在接縫處壞掉。
 */
function concatSegments(a, b) {
  const text = a.text + b.text;
  if (!a.bytes || !b.bytes) return { text, bytes: null };
  const bytes = new Uint8Array(a.bytes.length + b.bytes.length);
  bytes.set(a.bytes, 0);
  bytes.set(b.bytes, a.bytes.length);
  return { text, bytes };
}

/** 在位元組陣列前加一個冒號，讓左右接續的切段邏輯一致 */
function prependColon(bytes) {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = 0x3a;
  out.set(bytes, 1);
  return out;
}

/**
 * 以冒號切段，同時把對應的原始位元組一起切出來。
 * 位元組要一起帶，Big5 的品名才有辦法正確還原。
 */
function splitSegments(text, bytes) {
  const out = [];
  let start = 1; // 跳過開頭的冒號
  for (let i = 1; i <= text.length; i += 1) {
    if (i === text.length || text[i] === ':') {
      out.push({
        text: text.slice(start, i),
        bytes: bytes ? bytes.slice(start, i) : null,
      });
      start = i + 1;
    }
  }
  return out;
}

/**
 * 依編碼參數把一個欄位解成可讀字串。
 *
 * 只要拿得到原始位元組就一定要走 TextDecoder —— 不論 Big5 還是 UTF-8。
 * normalize() 為了讓位元組與字元位置一對一對齊，是用 latin1 逐位元組轉字元的，
 * 那份 text 對 ASCII 正確、對中文則是亂碼，不能直接拿來當品名用。
 */
function decodeSegment(seg, encoding) {
  if (!seg) return '';
  if (encoding === ENCODING.BASE64) return decodeBase64(seg.text) ?? seg.text;
  if (seg.bytes) {
    return decodeBytes(seg.bytes, encoding === ENCODING.BIG5 ? ENCODING.BIG5 : ENCODING.UTF8);
  }
  return seg.text;
}

/**
 * 判斷一段 QR 內容是不是電子發票的左方或右方條碼。
 * 掃到別的 QR（網址、載具條碼）時用來快速略過。
 */
export function looksLikeInvoiceQR(raw) {
  const n = normalize(raw);
  if (!n) return false;
  if (n.text.startsWith(RIGHT_PREFIX)) return true;
  return n.text.length >= HEADER_LEN && /^[A-Z]{2}\d{8}\d{7}/.test(n.text);
}
