/**
 * 檢查 sw.js 的 APP_SHELL 清單是否涵蓋所有實際存在的程式碼檔案。
 *
 * 為什麼需要這個檢查：
 * 新增一個 view 或 lib 檔卻忘了加進 APP_SHELL，在有網路時完全看不出問題
 * （fetch 會直接抓得到），但使用者一進到飛航模式，那支檔案就載不到，
 * App 整個開不起來。這種缺陷很難靠手動測試發現，交給 CI 擋住。
 *
 * 執行：node tools/check_shell.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 遞迴列出目錄下的檔案，回傳以 ./ 開頭的 POSIX 相對路徑 */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push('./' + relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');

// 只取 APP_SHELL 陣列裡的字串，避免把註解或其他常數也抓進來
const block = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
if (!block) {
  console.error('✗ 在 sw.js 找不到 APP_SHELL 陣列');
  process.exit(1);
}
const listed = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

// 應該要被快取的：所有 js/ 與 css/ 底下的檔案
const required = [...walk(join(ROOT, 'js')), ...walk(join(ROOT, 'css'))];

const missing = required.filter((f) => !listed.has(f));

// 反向檢查：清單裡列了但檔案其實不存在（改名或刪檔後忘了同步）
const stale = [...listed].filter((f) => {
  if (f === './') return false; // 首頁本身，不是實體檔案
  try {
    statSync(join(ROOT, f));
    return false;
  } catch {
    return true;
  }
});

let failed = false;

if (missing.length) {
  failed = true;
  console.error('✗ 這些檔案存在，但沒有列進 sw.js 的 APP_SHELL（離線時會載不到）：');
  for (const f of missing) console.error('    ' + f);
}

if (stale.length) {
  failed = true;
  console.error('✗ APP_SHELL 列了不存在的檔案（會讓 install 階段抓不到）：');
  for (const f of stale) console.error('    ' + f);
}

if (failed) process.exit(1);

console.log(`✓ APP_SHELL 檢查通過：${listed.size} 個項目，涵蓋全部 ${required.length} 支程式碼檔案`);
