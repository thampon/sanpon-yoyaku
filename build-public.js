#!/usr/bin/env node
/**
 * Apps Script用の画面ファイルを、GitHub Pages（公開）用に変換する。
 *   src/Booking.html → index.html（お客さん用）
 *   gas/Admin.html   → admin.html（管理画面）
 *
 * 使い方：node build-public.js
 * 確認だけ：node build-public.js --check（今の index.html / admin.html と一致するかを見る。ファイルは書き換えない）
 *
 * 変換内容（Apps Script専用の部分を、外部ページ用に置き換える）：
 *   1. <base target="_top"> を外す
 *   2. <meta charset> の後に noindex・タイトル等を足す
 *   3. トークンを「URLの ? 以降」から読むようにする
 *   4. google.script.run の呼び出しを、Apps Script の /exec への fetch（自動やり直し付き）に置き換える
 */
const fs = require('fs');
const path = require('path');

const API_URL = 'https://script.google.com/macros/s/AKfycbyn8BzGeSM6x5tSeIhi0vAlIhX7n8NpY-u_GSXo5exqINmJa_U9Nwe08gIJjlUDPg-M/exec';

const CALL_GAS = [
  '  const call = (fn, ...args) => new Promise((res, rej) =>',
  "    google.script.run.withSuccessHandler(res).withFailureHandler((e) => rej(e && e.message ? e.message : String(e)))[fn](...args));"
].join('\n');

const CALL_FETCH = [
  '  const API_URL = "' + API_URL + '";',
  '  // 通信が一瞬こけても自動でやり直す（最大3回）。申請など書き込み系は二重登録を避けるため1回だけ',
  '  const READ_ONLY = { apiCustomerView: 1, apiSlots: 1, apiSlotsAll: 1, apiAdminView: 1 };',
  '  const call = async (fn, ...args) => {',
  '    const tries = READ_ONLY[fn] ? 4 : 1;',
  '    let lastErr = null;',
  '    for (let i = 0; i < tries; i++) {',
  '      if (i) await new Promise((r) => setTimeout(r, 1200 * i));',
  '      let r, j;',
  '      // 読み込み系は30秒で見切ってやり直す（Google側でたまに返事が詰まるため）',
  '      const ac = (READ_ONLY[fn] && window.AbortController) ? new AbortController() : null;',
  '      const timer = ac ? setTimeout(() => ac.abort(), 30000) : null;',
  '      try {',
  "        r = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ fn, args }), redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: ac ? ac.signal : undefined });",
  '        j = await r.json().catch(() => null);',
  '      } catch (e) { lastErr = e; continue; } finally { if (timer) clearTimeout(timer); }',
  "      if (!j) { lastErr = new Error('bad response ' + r.status); continue; }",
  '      if (!j.ok) throw j.error;',
  '      return j.result;',
  '    }',
  "    try { console.warn('call failed', fn, lastErr); } catch (e) {}",
  '    // 申請などは、送れていても返事だけ受け取れなかった可能性がある（二重申請を防ぐため、確認をお願いする）',
  "    if (!READ_ONLY[fn]) throw '送信結果を確認できませんでした。ページを再読み込みして「予約状況」に入っているか確認してください（入っていなければ、もう一度お試しください）。';",
  "    throw '通信できませんでした（' + String(lastErr && lastErr.message || lastErr).slice(0, 60) + '）。ページを再読み込みしてもう一度お試しください。';",
  '  };'
].join('\n');

const TARGETS = [
  {
    src: 'src/Booking.html', out: 'index.html',
    head: [
      '<meta name="robots" content="noindex">',
      '<title>ご予約｜さんぽんパーソナル</title>',
      "<script>if (new URLSearchParams(location.search).get('admin')) location.replace('admin.html' + location.search);</script>"
    ],
    token: ['  const TOKEN = <?!= JSON.stringify(token) ?>;', "  const TOKEN = new URLSearchParams(location.search).get('t') || '';"]
  },
  {
    src: 'gas/Admin.html', out: 'admin.html',
    head: [
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="robots" content="noindex">',
      '<title>予約管理｜さんぽんパーソナル</title>'
    ],
    token: ['  const ADMIN = <?!= JSON.stringify(adminToken) ?>;', "  const ADMIN = new URLSearchParams(location.search).get('admin') || '';"]
  }
];

function replaceOnce(text, from, to, label) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(label + '：置き換え元が ' + n + ' か所見つかりました（1か所のはず）。元ファイルの形が変わっていないか確認してください。');
  return text.replace(from, () => to);
}

function build(t) {
  let s = fs.readFileSync(path.join(__dirname, t.src), 'utf8');
  s = replaceOnce(s, '<base target="_top">\n', '\n', t.src + ' base');
  s = replaceOnce(s, '<meta charset="utf-8">\n', '<meta charset="utf-8">\n' + t.head.join('\n') + '\n', t.src + ' head');
  s = replaceOnce(s, t.token[0], t.token[1], t.src + ' token');
  s = replaceOnce(s, CALL_GAS, CALL_FETCH, t.src + ' call');
  return s;
}

const check = process.argv.includes('--check');
let ok = true;
for (const t of TARGETS) {
  const out = build(t);
  const dest = path.join(__dirname, t.out);
  if (check) {
    const cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
    const same = cur === out;
    ok = ok && same;
    console.log((same ? '一致　' : '不一致') + '：' + t.src + ' → ' + t.out);
  } else {
    fs.writeFileSync(dest, out);
    console.log('書き出し：' + t.src + ' → ' + t.out);
  }
}
if (check && !ok) process.exit(1);
