/**
 * さんぽんパーソナル 予約システム v1.0
 * Google Apps Script（スプレッドシートにバインドして使う）
 *
 * 構成：
 *   - 予約の正 ……… Googleカレンダー
 *   - 顧客・回数券・履歴の正 … このスプレッドシート
 *   - 通知 ……… Slack（顧客DM＝ユーザートークン／トレーナー宛て＝Incoming Webhook）
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）：
 *   SPREADSHEET_ID      … setup() が自動で入れる
 *   ADMIN_TOKEN         … setup() が自動で入れる（管理画面URLの鍵）
 *   SLACK_USER_TOKEN    … xoxp- で始まるトークン（顧客DMに「さんぽん本人」として投稿）
 *   SLACK_WEBHOOK_URL   … トレーナー通知用チャンネルのWebhook URL
 */

// ===== 定数 =====
const TZ = 'Asia/Tokyo';
const SH = {
  CUSTOMERS: '顧客',
  GYMS: 'ジム',
  TRAVEL: '移動時間',
  HOURS: '営業時間',
  BOOKINGS: '予約',
  TICKETS: '回数券履歴',
  SETTINGS: '設定'
};
const HEADERS = {
  '顧客': ['顧客ID', '氏名', 'カレンダー表記', '利用ジムID', 'SlackチャンネルID', 'トークン', '残回数', '有効', 'メモ', '予約期限', '優先ジム', 'セッション分'],
  'ジム': ['ジムID', '名称', '住所', '判定キーワード', '有効', '空き確認カレンダーID', 'まとめボタン'],
  '移動時間': ['出発ジムID', '到着ジムID', '所要分'],
  '営業時間': ['曜日', '開始', '終了', '休み'],
  '予約': ['予約ID', '顧客ID', '氏名', 'ジムID', '開始', '終了', '状態', '予定ID', '申請日時', '処理日時', '回数戻し', '却下理由', 'ジム予定ID'],
  '回数券履歴': ['日時', '顧客ID', '氏名', '増減', '理由', '予約ID'],
  '設定': ['キー', '値', '説明']
};
const STATUS = { PENDING: '仮予約', CONFIRMED: '確定', REJECTED: '却下', CANCELED: 'キャンセル' };
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const PENDING_PREFIX = '【仮】';
const OTHER_GYM = 'other'; // 「その他」＝場所未定（相談して決める）

// ===== 初期データ =====
// ※GitHub保管版の注記：GlitteR南青山の共有カレンダーIDは公開リポジトリに置かないため伏せている。
//   本番の値はスプレッドシート「ジム」シートの「空き確認カレンダーID」列に入っている（この初期値はsetup時しか使わない）。
const DEFAULT_ROWS = {
  '顧客': [
    ['C001', 'テスト 太郎', 'テストPT', 'glitter,other', '', '', '4', 'TRUE', '動作確認用。SlackチャンネルIDに自分宛てのDM IDを入れてテストする']
  ],
  'ジム': [
    ['glitter', 'GlitteR南青山', '東京都港区南青山2-9-25 センチュリーホーム南青山B棟202', '南青山,GlitteR,外苑前', 'TRUE', '（ジムシートに入力：GlitteR共有カレンダーID）'],
    ['other', 'その他（場所は相談）', '', '', 'TRUE', ''],
    // 以下はお客さんには出さず（有効=FALSE）、カレンダーの予定の場所から移動時間を判定するためだけに使う
    ['shibuya', '渋谷（ジムカリ）', '東京都渋谷区渋谷1-9-4 トーカン渋谷キャステール507', '渋谷区渋谷,トーカン渋谷,ジムカリ', 'FALSE', ''],
    ['roppongi', '六本木', '東京都港区六本木3-5-14', '六本木', 'FALSE', ''],
    ['shintomi', '新富町', '東京都中央区新富1-5-13 ブレシア銀座イースト1階', '新富,ブレシア銀座', 'FALSE', ''],
    ['aobadai', '青葉台（First Step）', '神奈川県横浜市青葉区しらとり台1-27 NAGビル4階402号室', '青葉台,しらとり台,First Step', 'FALSE', ''],
    ['futako', '二子玉川（T-BALANCE）', '東京都世田谷区玉川4-3-15 サントピア二子玉川第二102号室', '二子玉川,玉川4,T-BALANCE', 'FALSE', ''],
    ['yoga', '用賀（All Day Gym）', '東京都世田谷区用賀3-10-18 ユーオンヒルズ用賀102号室', '用賀,All Day Gym', 'FALSE', '']
  ],
  // 片方向だけ書けばOK（逆方向は同じ時間として扱う）。数値は仮置き。
  '移動時間': [
    ['shibuya', 'roppongi', '25'], ['shibuya', 'shintomi', '35'], ['shibuya', 'aobadai', '35'],
    ['shibuya', 'futako', '20'], ['shibuya', 'yoga', '20'], ['shibuya', 'glitter', '20'],
    ['roppongi', 'shintomi', '25'], ['roppongi', 'aobadai', '50'], ['roppongi', 'futako', '40'],
    ['roppongi', 'yoga', '40'], ['roppongi', 'glitter', '20'],
    ['shintomi', 'aobadai', '60'], ['shintomi', 'futako', '50'], ['shintomi', 'yoga', '50'], ['shintomi', 'glitter', '30'],
    ['aobadai', 'futako', '25'], ['aobadai', 'yoga', '30'], ['aobadai', 'glitter', '45'],
    ['futako', 'yoga', '15'], ['futako', 'glitter', '35'],
    ['yoga', 'glitter', '35']
  ],
  '営業時間': [
    ['月', '07:00', '22:00', 'FALSE'],
    ['火', '07:00', '22:00', 'FALSE'],
    ['水', '07:00', '22:00', 'FALSE'],
    ['木', '07:00', '22:00', 'FALSE'],
    ['金', '07:00', '22:00', 'FALSE'],
    ['土', '09:00', '18:00', 'FALSE'],
    ['日', '09:00', '18:00', 'FALSE']
  ],
  '設定': [
    ['CALENDAR_ID', 'primary', '予約を書き込むカレンダーID。primary＝メインカレンダー'],
    ['WEBAPP_URL', '', 'デプロイ後のWebアプリURL（…/exec）を貼る'],
    ['SESSION_MIN', '60', 'セッション時間（分）'],
    ['STEP_MIN', '15', '開始時刻の刻み（分）'],
    ['LEAD_DAYS', '7', '予約締切：開始の何日前まで受け付けるか'],
    ['MAX_MONTHS', '2', '何ヶ月先まで受け付けるか'],
    ['MAX_PENDING', '4', '1人あたり同時に持てる仮予約の上限'],
    ['UNKNOWN_BUFFER_MIN', '30', '場所が分からない予定の前後に空ける時間（分）'],
    ['TRAVEL_DEFAULT_MIN', '60', '移動時間シートにない組み合わせの移動時間（分）'],
    ['ALLDAY_BLOCK_WORDS', '休,NG,×,出張', '終日予定のうち、タイトルにこの語を含むものはその日を丸ごと予約不可にする（カンマ区切り）'],
    ['STALE_HOURS', '24', '仮予約が何時間放置されたら毎朝リマインドするか'],
    ['TEMPLATE_APPROVE', '{name}さん\nご予約が確定しました。\n\n日時：{date} {time}\n場所：{gym}\n住所：{address}\n残り回数：{remaining}回\n\n当日お待ちしています！', '確定時に顧客へ送る文面'],
    ['TEMPLATE_REJECT', '{name}さん\n申請いただいた {date} {time}（{gym}）は、ジムの空きが確保できずお受けできませんでした。{reason}\nお手数ですが、別の日時で再度ご予約ください。\n{url}', '却下時に顧客へ送る文面'],
    ['TEMPLATE_CANCEL', '{name}さん\n{date} {time}（{gym}）のご予約をキャンセルしました。\n{refund}\n残り回数：{remaining}回', 'キャンセル時に顧客へ送る文面'],
    ['RENTAL_TITLE', '[レンタル]さんぽん_{name}', '承認時にジム側カレンダー（ブース2など）へ入れる予定のタイトル']
  ]
};

// ===== セットアップ =====
/** 最初に1回だけ実行。シート作成・初期値投入・管理用トークン発行・トリガー設定。 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('ADMIN_TOKEN')) props.setProperty('ADMIN_TOKEN', newToken_());

  Object.keys(HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() > 0) return; // 既にあるシートは触らない
    const head = HEADERS[name];
    sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e6efe0');
    sh.setFrozenRows(1);
    const rows = DEFAULT_ROWS[name];
    if (rows && rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    sh.autoResizeColumns(1, head.length);
  });
  ['シート1', 'Sheet1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  setupTriggers_();
  Logger.log('セットアップ完了。次は手順書の「Slack設定」と「デプロイ」へ。');
  try { SpreadsheetApp.getUi().alert('セットアップ完了しました。手順書の次のステップに進んでください。'); } catch (e) { /* エディタから実行時はUIなし */ }
}

function setupTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'notifyStalePending') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('notifyStalePending').timeBased().everyDays(1).atHour(8).inTimezone(TZ).create();
}

/** スプレッドシートを開いたときのメニュー */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('さんぽん予約')
    .addItem('選択行の顧客に予約URLを発行', 'menuIssueUrl')
    .addItem('管理画面のURLを表示', 'menuShowAdminUrl')
    .addItem('空き枠を今すぐ更新', 'warmSlotsCache')
    .addSeparator()
    .addItem('初期設定（setup）', 'setup')
    .addToUi();
}

function menuIssueUrl() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SH.CUSTOMERS) { ui.alert('「顧客」シートで、URLを発行したい人の行を選んでから実行してください。'); return; }
  const row = sh.getActiveRange().getRow();
  if (row < 2) { ui.alert('顧客の行を選んでください。'); return; }
  const r = readRows_(SH.CUSTOMERS).filter(function (x) { return x._row === row; })[0];
  if (!r || !r['顧客ID']) { ui.alert('顧客IDが入っている行を選んでください。'); return; }
  const url = issueCustomerUrl_(r['顧客ID']);
  showUrlDialog_(r['氏名'] + 'さんの予約URL', url, '再発行すると前のURLは使えなくなります。');
}

function menuShowAdminUrl() {
  const url = adminUrl_();
  showUrlDialog_('管理画面のURL', url, 'このURLを知っている人は管理画面を開けます。ブックマークして、人には送らないでください。');
}

function showUrlDialog_(title, url, note) {
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:14px">' +
    '<input id="u" value="' + escHtml_(url) + '" style="width:100%;padding:8px;font-size:13px" readonly onclick="this.select()">' +
    '<p style="color:#555">' + escHtml_(note) + '</p></div>'
  ).setWidth(520).setHeight(150);
  SpreadsheetApp.getUi().showModalDialog(html, title);
}

// ===== Webアプリの入口 =====
function doGet(e) {
  const p = (e && e.parameter) || {};
  const adminToken = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  if (p.admin) {
    if (!adminToken || p.admin !== adminToken) return simplePage_('このURLは無効です。');
    const t = HtmlService.createTemplateFromFile('Admin');
    t.adminToken = adminToken;
    return t.evaluate().setTitle('予約管理｜さんぽんパーソナル')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  if (!p.t || !/^[0-9a-f]{32}$/.test(p.t) || !findCustomerByToken_(p.t)) {
    return simplePage_('このURLは無効です。お手数ですが、トレーナーにお問い合わせください。');
  }
  const t = HtmlService.createTemplateFromFile('Booking');
  t.token = p.t;
  return t.evaluate().setTitle('ご予約｜さんぽんパーソナル')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 外部ページ（Googleの外に置いた予約画面）からのAPI呼び出し口。
 * スマホでGoogleアカウントに複数ログインしていると script.google.com の画面が開けない問題の回避用。
 * body: {"fn":"apiSlots","args":[...]}  →  {"ok":true,"result":...} / {"ok":false,"error":"..."}
 */
const PUBLIC_API_ = ['apiCustomerView', 'apiSlots', 'apiSlotsAll', 'apiRequest', 'apiAdminView', 'apiApprove',
  'apiReject', 'apiCancel', 'apiAddTickets', 'apiIssueUrl', 'apiReschedule'];
function doPost(e) {
  let out;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (PUBLIC_API_.indexOf(body.fn) < 0) throw new Error('不正なリクエストです。');
    const fns = { apiCustomerView: apiCustomerView, apiSlots: apiSlots, apiSlotsAll: apiSlotsAll, apiRequest: apiRequest,
      apiAdminView: apiAdminView, apiApprove: apiApprove, apiReject: apiReject, apiCancel: apiCancel,
      apiAddTickets: apiAddTickets, apiIssueUrl: apiIssueUrl, apiReschedule: apiReschedule };
    out = { ok: true, result: fns[body.fn].apply(null, Array.isArray(body.args) ? body.args : []) };
  } catch (err) {
    out = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function simplePage_(msg) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;padding:32px 20px;color:#1f2a1f">' + escHtml_(msg) + '</div>'
  ).setTitle('さんぽんパーソナル').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ===== 顧客向けAPI（google.script.run から呼ばれる） =====
function apiCustomerView(token) {
  return guard_(function () {
    const c = requireCustomer_(token);
    const st = getSettings_();
    const gyms = getGyms_();
    const now = new Date();
    const mine = readRows_(SH.BOOKINGS).filter(function (b) { return b['顧客ID'] === c.id; });
    const pending = mine.filter(function (b) { return b['状態'] === STATUS.PENDING; }).length;
    const upcoming = mine.filter(function (b) {
      return (b['状態'] === STATUS.PENDING || b['状態'] === STATUS.CONFIRMED) && new Date(b['終了']) >= now;
    }).sort(byStart_);
    return {
      name: c.name,
      remaining: c.remaining,
      pending: pending,
      bookable: Math.max(0, Math.min(c.remaining - pending, st.maxPending - pending)),
      maxPending: st.maxPending,
      leadDays: st.leadDays,
      until: c.until ? fmtDay_(c.until) : '',
      sessionMin: lenOf_(c, st),
      gyms: gyms.filter(function (g) { return g.active && c.gymIds.indexOf(g.id) >= 0; })
        .map(function (g) { return { id: g.id, name: g.name, address: g.address, group: g.group, preferred: g.id === c.prefer }; }),
      // 予約状況：今月1日以降のセッションをカレンダーから（システム導入前に手で入れた分も含む）。取れなければ予約シートの今後分
      bookings: (function () {
        try { return calendarBookings_(c, gyms, st, now); } catch (err) { Logger.log('カレンダーからの予約状況取得に失敗: ' + err); }
        return upcoming.map(function (b) {
          const s = new Date(b['開始']), e = new Date(b['終了']);
          const g = gymById_(gyms, b['ジムID']);
          return { date: fmtDay_(s), time: fmtTime_(s) + '〜' + fmtTime_(e), gym: g ? g.name : b['ジムID'], status: b['状態'], day: dayKey_(s), start: isoJst_(s), end: isoJst_(e) };
        });
      })()
    };
  });
}

/**
 * その顧客のセッション予定をカレンダーから集める（今月1日〜150日後）
 * 予定名の見分け方：カレンダー表記（例：風間啓PT）で始まる／氏名（空白なし）で始まり「PT」を含む／
 * 名字（氏名の空白より前）で始まり「PT」を含む（ほかの顧客と名字がかぶらない場合だけ）
 */
function calendarBookings_(c, gyms, st, now) {
  if (typeof Calendar === 'undefined' || !Calendar.Events) throw new Error('Calendar API なし');
  const all = readRows_(SH.CUSTOMERS).map(toCustomer_).filter(function (x) { return x.id; });
  const flat = function (n) { return String(n || '').replace(/[\s　]/g, ''); };
  const keys = [{ p: String(c.calName || ''), pt: false }, { p: flat(c.name), pt: true }];
  const sur = String(c.name || '').trim().split(/[\s　]+/)[0];
  if (sur && sur !== String(c.name).trim()) {
    const clash = all.some(function (o) { return o.id !== c.id && flat(o.name).indexOf(sur) === 0; });
    if (!clash) keys.push({ p: sur, pt: true });
  }
  const from = new Date(Utilities.formatDate(now, TZ, 'yyyy-MM') + '-01T00:00:00+09:00');
  const to = new Date(now.getTime() + 150 * 86400000);
  const out = [];
  let pageToken;
  do {
    const res = Calendar.Events.list(getCal_(st).getId(), {
      timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 2500, pageToken: pageToken,
      fields: 'nextPageToken,items(summary,start,end,location,status,extendedProperties)'
    });
    (res.items || []).forEach(function (ev) {
      if (ev.status === 'cancelled' || !ev.start || !ev.start.dateTime) return;
      const title = String(ev.summary || '');
      const pend = title.indexOf(PENDING_PREFIX) === 0;
      const base = pend ? title.slice(PENDING_PREFIX.length) : title;
      const hit = keys.some(function (k) { return k.p && base.indexOf(k.p) === 0 && (!k.pt || base.indexOf('PT') >= 0); });
      if (!hit) return;
      const s = new Date(ev.start.dateTime), e = new Date(ev.end.dateTime);
      const ep = ev.extendedProperties || {};
      const tag = (ep.shared && ep.shared.spGym) || (ep.private && ep.private.spGym) || ''; // 場所を変えた時の印（shared）を優先
      const gid = matchGym_(ev.location, gyms) || tag; // 場所欄を優先（日時・場所の変更後も確実に合う）
      const g = gid ? gymById_(gyms, gid) : null;
      let place = g ? g.name : '';
      if (!place) {
        const m = String(ev.location || '').match(/（([^（）]+)）\s*$/);
        place = m ? m[1] : (base.indexOf('@') >= 0 ? base.split('@').pop() : '');
      }
      out.push({
        date: fmtDay_(s), time: fmtTime_(s) + '〜' + fmtTime_(e), gym: place || '—',
        status: pend ? STATUS.PENDING : (e < now ? '済' : STATUS.CONFIRMED),
        day: dayKey_(s), start: isoJst_(s), end: isoJst_(e)
      });
    });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

function apiSlots(token, gymId) {
  return guard_(function () {
    const c = requireCustomer_(token);
    const gym = gymById_(getGyms_(), gymId);
    if (!gym || !gym.active || c.gymIds.indexOf(gym.id) < 0) fail_('このジムは選択できません。');
    return forLength_(cutUntil_(getSlotsCached_([gym.id])[gym.id] || [], c.until), lenOf_(c, getSettings_()), getSettings_());
  });
}

/** お客さんが選べる全ジムの空き枠をまとめて返す（ページを開いた瞬間に裏で取りにいく用） */
function apiSlotsAll(token) {
  return guard_(function () {
    const c = requireCustomer_(token);
    const ids = getGyms_().filter(function (g) { return g.active && c.gymIds.indexOf(g.id) >= 0; })
      .map(function (g) { return g.id; });
    const all = getSlotsCached_(ids);
    const st = getSettings_();
    Object.keys(all).forEach(function (k) { all[k] = forLength_(cutUntil_(all[k], c.until), lenOf_(c, st), st); });
    return all;
  });
}

// ===== 空き枠キャッシュ =====
// カレンダー読み込みが重い（1ジム5〜7秒）ので、計算結果を最大15分キャッシュする。
// 10分ごとのトリガー（warmSlotsCache）で作り直すので、お客さんは基本キャッシュを読むだけ。
// 予約の申請・承認・却下・キャンセル、シート編集のときは即破棄。申請時は必ず最新のカレンダーで再チェックする。
const SLOT_CACHE_SEC = 21600; // 10分ごとに作り直すので長めに持つ（切れると次の人が一から計算＝遅い）
function slotsVer_() {
  const cache = CacheService.getScriptCache();
  let v = cache.get('slotsVer');
  if (!v) { v = String(Date.now()); cache.put('slotsVer', v, 21600); }
  return v;
}
function clearSlotsCache_() {
  CacheService.getScriptCache().put('slotsVer', String(Date.now()), 21600);
}
function computeSlots_(gymIds, budgetMs) {
  const t0 = Date.now();
  const st = getSettings_();
  const gyms = getGyms_();
  const range = bookingRange_(st, new Date());
  const base = loadBusy_(getCal_(st), range.from, range.to, st, gyms);
  const tf = travelFn_(st), hours = getHours_();
  const cache = CacheService.getScriptCache(), ver = slotsVer_();
  const out = {};
  gymIds.forEach(function (id) {
    if (budgetMs && Date.now() - t0 > budgetMs) return; // 時間切れ：残りは次回に回す
    const g = gymById_(gyms, id);
    if (!g || !g.active) return;
    const s = buildSlots_(g.id, st, base.concat(loadGymCal_(g, range.from, range.to)), tf, hours, range.from, range.to);
    out[id] = s;
    const json = JSON.stringify(s);
    if (json.length < 95000) cache.putAll({ ['slots:' + ver + ':' + id]: json, ['slots:last:' + id]: json }, SLOT_CACHE_SEC);
  });
  return out;
}
function getSlotsCached_(gymIds) {
  const ver = slotsVer_();
  const got = CacheService.getScriptCache().getAll(gymIds.map(function (id) { return 'slots:' + ver + ':' + id; })
    .concat(gymIds.map(function (id) { return 'slots:last:' + id; })));
  const res = {}, miss = [];
  gymIds.forEach(function (id) {
    // 最新が無くても、直前の作り置きがあればそれを返す（その場で一から計算すると1分以上かかることがあるため）。
    // 申し込み時は必ず最新のカレンダーで確認し直すので、二重予約にはならない
    const j = got['slots:' + ver + ':' + id] || got['slots:last:' + id];
    if (j) res[id] = JSON.parse(j); else miss.push(id);
  });
  if (miss.length) {
    const fresh = computeSlots_(miss);
    Object.keys(fresh).forEach(function (k) { res[k] = fresh[k]; });
  }
  // 作り置きは最大15分前のもの。「今から◯日後」の境目を過ぎた枠はここで外す
  const minStart = bookingRange_(getSettings_(), new Date()).from.getTime();
  Object.keys(res).forEach(function (k) {
    res[k] = res[k].map(function (d) {
      return { date: d.date, label: d.label, times: d.times.filter(function (t) { return new Date(t.start).getTime() >= minStart; }) };
    }).filter(function (d) { return d.times.length; });
  });
  return res;
}
/** 10分ごとのトリガーから呼ばれる：有効な全ジムの空き枠を作り直す */
function warmSlotsCache() {
  try { flushNotifyQueue(); ensureFlushTrigger_(); } catch (e) { Logger.log(e); }
  // シートの読み込み結果も最新に読み直しておく（お客さん・管理画面の読み込みを速くするため）
  try {
    ROWS_MEMO_ = {}; FRESH_READS_ = true;
    Object.keys(SH).forEach(function (k) { sheetValues_(SH[k]); });
  } catch (e) { Logger.log('シートの読み直しに失敗: ' + e); } finally { FRESH_READS_ = false; }
  // 前回やり残した場所から先に作る（Googleの実行時間6分の上限で途中終了しても、全部の場所が順に新しくなる）
  const ids = getGyms_().filter(function (g) { return g.active; }).map(function (g) { return g.id; });
  const props = PropertiesService.getScriptProperties();
  const prev = String(props.getProperty('WARM_ORDER') || '').split(',').filter(function (x) { return ids.indexOf(x) >= 0; });
  const order = prev.concat(ids.filter(function (x) { return prev.indexOf(x) < 0; }));
  const done = Object.keys(computeSlots_(order, 4 * 60000));
  const rest = order.filter(function (x) { return done.indexOf(x) < 0; });
  props.setProperty('WARM_ORDER', rest.concat(done).join(','));
}
/** 1回だけ手動実行：10分ごとの空き枠更新トリガーを入れる */
function installWarmTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'warmSlotsCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('warmSlotsCache').timeBased().everyMinutes(10).create();
  warmSlotsCache();
}
/** シートを手で直したら空き枠キャッシュを捨てる（営業時間・移動時間などをすぐ反映するため） */
function onEdit() {
  // 空き枠の作り置きは捨てない（次に開いた人が遅くなるため。10分ごとの更新に任せる／急ぐときはメニュー「空き枠を今すぐ更新」）
  // シートの読み込み結果の一時保存は捨てる（手で直した顧客・ジム・営業時間などをすぐ反映するため）
  try { dropAllRows_(); } catch (e) { /* 何もしない */ }
}
/** 仮予約が入ったら、作り置きからその前後の枠だけ外す（全部捨てて計算し直すと遅いため）。正確な形は10分ごとの更新で戻る */
function patchSlotsCache_(s, e) {
  try {
    const cache = CacheService.getScriptCache(), ver = slotsVer_();
    const st = getSettings_();
    const buf = Math.max(st.travelDefault || 60, 60) * 60000; // 移動時間ぶん広めに外す
    const lo = s.getTime() - buf, hi = e.getTime() + buf, len = st.sessionMin * 60000;
    const keys = [];
    getGyms_().forEach(function (g) { keys.push('slots:' + ver + ':' + g.id, 'slots:last:' + g.id); });
    const got = cache.getAll(keys), put = {};
    Object.keys(got).forEach(function (k) {
      const days = JSON.parse(got[k]).map(function (d) {
        return { date: d.date, label: d.label, times: d.times.filter(function (t) {
          const ts = new Date(t.start).getTime();
          return !(ts < hi && ts + len > lo);
        }) };
      }).filter(function (d) { return d.times.length; });
      put[k] = JSON.stringify(days);
    });
    if (Object.keys(put).length) cache.putAll(put, SLOT_CACHE_SEC);
  } catch (err) { clearSlotsCache_(); }
}

function apiRequest(token, gymId, startIso) {
  return guard_(function () {
    return withLock_(function () {
      const c = requireCustomer_(token);
      const st = getSettings_();
      const gyms = getGyms_();
      const gym = gymById_(gyms, gymId);
      if (!gym || !gym.active || c.gymIds.indexOf(gym.id) < 0) fail_('このジムは選択できません。');

      const pending = readRows_(SH.BOOKINGS).filter(function (b) {
        return b['顧客ID'] === c.id && b['状態'] === STATUS.PENDING;
      }).length;
      if (c.remaining - pending <= 0) fail_('予約できる残り回数がありません。トレーナーにご相談ください。');
      if (pending >= st.maxPending) fail_('仮予約は同時に' + st.maxPending + '件までです。確定をお待ちください。');

      const s = new Date(startIso);
      if (isNaN(s.getTime())) fail_('日時が正しくありません。');
      const len = lenOf_(c, st);
      const e = new Date(s.getTime() + len * 60000);

      // 申請時点でもう一度、その日の空き枠を計算し直して確認（二重予約防止）
      const range = bookingRange_(st, new Date());
      const dayFrom = new Date(dayKey_(s) + 'T00:00:00+09:00');
      const dayTo = new Date(dayFrom.getTime() + 86400000 - 1);
      const from = new Date(Math.max(range.from.getTime(), dayFrom.getTime()));
      const to = new Date(Math.min(range.to.getTime(), dayTo.getTime()));
      if (from > to) fail_('この日時は受付期間外です。');
      if (c.until && s.getTime() > c.until.getTime()) fail_(fmtDay_(c.until) + 'より後の日時は予約できません。');
      const busy = loadBusy_(getCal_(st), from, to, st, gyms).concat(loadGymCal_(gym, from, to));
      const days = buildSlots_(gym.id, st, busy, travelFn_(st), getHours_(), from, to);
      const ok = forLength_(days, len, st).some(function (d) {
        return d.times.some(function (t) { return new Date(t.start).getTime() === s.getTime(); });
      });
      if (!ok) fail_('選んだ枠はたった今埋まってしまいました。別の枠をお選びください。');

      const id = 'B' + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 900 + 100);
      const evId = createPendingEvent_(st, c, gym, id, s, e);

      appendRow_(SH.BOOKINGS, {
        '予約ID': id, '顧客ID': c.id, '氏名': c.name, 'ジムID': gym.id,
        '開始': isoJst_(s), '終了': isoJst_(e), '状態': STATUS.PENDING, '予定ID': evId,
        '申請日時': isoJst_(new Date())
      });

      queueNotify_(':calendar: *仮予約の申請*\n' + c.name + 'さん｜' + fmtDay_(s) + ' ' + fmtTime_(s) + '〜' + fmtTime_(e) +
        '｜' + gym.name + '\n残回数 ' + c.remaining + '回（仮予約 ' + (pending + 1) + '件）\n' +
        'ジムを押さえたら承認してください → ' + adminUrl_());

      patchSlotsCache_(s, e);
      return { date: fmtDay_(s), time: fmtTime_(s) + '〜' + fmtTime_(e), gym: gym.name };
    });
  });
}

// ===== 管理画面API =====
function apiAdminView(adminToken) {
  return guard_(function () {
    requireAdmin_(adminToken);
    const st = getSettings_();
    const gyms = getGyms_();
    const customers = readRows_(SH.CUSTOMERS).map(toCustomer_).filter(function (c) { return c.id; });
    const bookings = readRows_(SH.BOOKINGS);
    const now = new Date();
    const cal = getCal_(st);
    const gymName = function (id) { const g = gymById_(gyms, id); return g ? g.name : id; };
    const remainingOf = function (cid) {
      const c = customers.filter(function (x) { return x.id === cid; })[0];
      return c ? c.remaining : '';
    };
    const view = function (b) {
      const s = new Date(b['開始']), e = new Date(b['終了']);
      return {
        id: b['予約ID'], customerId: b['顧客ID'], name: b['氏名'], gym: gymName(b['ジムID']), gymId: b['ジムID'],
        day: dayKey_(s), hm: fmtTime_(s),
        date: fmtDay_(s), time: fmtTime_(s) + '〜' + fmtTime_(e), status: b['状態'],
        requestedAt: b['申請日時'] ? fmtDay_(new Date(b['申請日時'])) + ' ' + fmtTime_(new Date(b['申請日時'])) : '',
        remaining: remainingOf(b['顧客ID']), past: e < now
      };
    };

    const pending = bookings.filter(function (b) { return b['状態'] === STATUS.PENDING; }).sort(byStart_).map(view);
    const upcomingRows = bookings.filter(function (b) {
      return b['状態'] === STATUS.CONFIRMED && new Date(b['終了']) >= now;
    }).sort(byStart_);

    // カレンダーとの差分チェック（手で動かした・消した予定を検出）
    // 高速化：予定を1件ずつ探さず、期間内の予定を1回でまとめて取ってから照合する
    const warnings = [];
    const live = bookings.filter(function (b) {
      return (b['状態'] === STATUS.PENDING || b['状態'] === STATUS.CONFIRMED) && new Date(b['終了']) >= now;
    });
    let uidMap = null;
    if (live.length && typeof Calendar !== 'undefined' && Calendar.Events) {
      try {
        const maxEnd = live.reduce(function (m, b) { return Math.max(m, new Date(b['終了']).getTime()); }, now.getTime());
        uidMap = startsByUid_(cal.getId(), new Date(now.getTime() - 86400000 * 14), new Date(maxEnd + 86400000 * 60));
      } catch (err) { Logger.log('予定の一括取得に失敗: ' + err); uidMap = null; }
    }
    live.forEach(function (b) {
      let start = null;
      if (b['予定ID']) {
        if (uidMap && uidMap[b['予定ID']]) start = uidMap[b['予定ID']];
        else { const ev = cal.getEventById(b['予定ID']); start = ev ? ev.getStartTime() : null; }
      }
      const label = b['氏名'] + 'さん ' + fmtDay_(new Date(b['開始'])) + ' ' + fmtTime_(new Date(b['開始']));
      if (!start) warnings.push(label + '：カレンダーに予定が見つかりません（手動で削除された可能性）');
      else if (start.getTime() !== new Date(b['開始']).getTime()) {
        warnings.push(label + '：カレンダー上の時間が ' + fmtDay_(start) + ' ' + fmtTime_(start) + ' に変わっています');
      }
    });
    pending.filter(function (p) { return p.past; }).forEach(function (p) {
      warnings.push(p.name + 'さん ' + p.date + ' ' + p.time + '：日時を過ぎた仮予約が残っています（承認か却下を）');
    });

    return {
      pending: pending,
      upcoming: upcomingRows.map(view),
      customers: customers.map(function (c) {
        const pend = bookings.filter(function (b) { return b['顧客ID'] === c.id && b['状態'] === STATUS.PENDING; }).length;
        return {
          id: c.id, name: c.name, remaining: c.remaining, pending: pend, active: c.active,
          gyms: c.gymIds.map(gymName).join('、'), hasUrl: !!c.token, hasSlack: !!c.slack
        };
      }),
      warnings: warnings,
      gyms: gyms.filter(function (g) { return g.active; }).map(function (g) { return { id: g.id, name: g.name }; }),
      slackReady: {
        user: !!PropertiesService.getScriptProperties().getProperty('SLACK_USER_TOKEN'),
        webhook: !!PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL')
      }
    };
  });
}

/**
 * 承認。change を渡すと日時・場所を変えて承認する（管理画面の「変更して承認」）
 * change: { date: 'yyyy-MM-dd', time: 'HH:mm', gymId: 'glitter', force: true=予定の重なりを無視 }
 */
function apiApprove(adminToken, bookingId, change) {
  return guard_(function () {
    requireAdmin_(adminToken);
    return withLock_(function () {
      const st = getSettings_();
      const b = requireBooking_(bookingId);
      if (b['状態'] !== STATUS.PENDING) fail_('この予約は既に「' + b['状態'] + '」です。');
      const c = requireCustomerById_(b['顧客ID']);
      if (c.remaining <= 0) fail_(c.name + 'さんの残回数が0です。先に回数券を追加してください。');
      const cal = getCal_(st);
      const ev = b['予定ID'] ? cal.getEventById(b['予定ID']) : null;
      if (!ev) fail_('カレンダーに仮予定が見つかりません（手動で削除された可能性）。却下で処理してください。');
      const gyms = getGyms_();
      const s0 = new Date(b['開始']), e0 = new Date(b['終了']);
      const gym0 = gymById_(gyms, b['ジムID']) || { id: b['ジムID'], name: b['ジムID'], address: '', checkCal: '' };
      let s = s0, e = e0, gym = gym0, changed = false;
      if (change && (change.date || change.time || change.gymId)) {
        const d = String(change.date || dayKey_(s0)), t = String(change.time || fmtTime_(s0));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{1,2}:\d{2}$/.test(t)) fail_('日時の形式が正しくありません。');
        const ns = new Date(d + 'T' + (t.length === 4 ? '0' + t : t) + ':00+09:00');
        if (isNaN(ns.getTime())) fail_('日時が正しくありません。');
        if (ns.getTime() < Date.now()) fail_('過去の日時には変更できません。');
        const ng = change.gymId ? gymById_(gyms, change.gymId) : gym0;
        if (!ng) fail_('場所が見つかりません。');
        changed = ns.getTime() !== s0.getTime() || ng.id !== gym0.id;
        if (changed) {
          s = ns; e = new Date(ns.getTime() + (e0.getTime() - s0.getTime())); gym = ng;
          if (!change.force && s.getTime() !== s0.getTime()) {
            const evId = ev.getId();
            const clash = cal.getEvents(s, e).filter(function (x) { return !x.isAllDayEvent() && x.getId() !== evId; });
            if (clash.length) fail_('【重なり】その時間には「' + clash[0].getTitle() + '」（' + fmtTime_(clash[0].getStartTime()) + '〜' + fmtTime_(clash[0].getEndTime()) + '）が入っています。');
          }
        }
      }

      // ジム側カレンダー（ブース2など）にレンタル予定を入れる。先にやって、失敗したら承認自体を止める
      let rentalId = '';
      if (gym.checkCal) {
        const gcal = CalendarApp.getCalendarById(gym.checkCal);
        if (!gcal) fail_(gym.name + 'のカレンダーが見つかりません。');
        const clash = gcal.getEvents(s, e).filter(function (x) { return !x.isAllDayEvent(); });
        if (clash.length) fail_(gym.name + 'のカレンダーにその時間の予定（' + clash[0].getTitle() + '）が既に入っています。ブースの空きを確認してください。');
        try {
          rentalId = gcal.createEvent(fill_(st.rentalTitle, { name: c.name }), s, e, {
            description: 'さんぽんパーソナル予約システムで作成\n予約ID：' + b['予約ID']
          }).getId();
        } catch (err) {
          fail_(gym.name + 'のカレンダーに予定を入れられませんでした（編集権限がない可能性）。承認は中止しました。');
        }
      }

      if (changed) {
        ev.setTime(s, e);
        ev.setLocation(gym.name + '　' + (gym.address || ''));
        setGymTag_(st, ev, gym.id);
      }
      ev.setTitle(c.calName);
      ev.setDescription(String(ev.getDescription() || '').replace('仮予約（承認待ち）', '確定') +
        (changed ? '\n変更前のご希望：' + fmtDay_(s0) + ' ' + fmtTime_(s0) + '〜' + fmtTime_(e0) + '｜' + gym0.name : ''));
      const now = isoJst_(new Date());
      const upd = { '状態': STATUS.CONFIRMED, '処理日時': now, 'ジム予定ID': rentalId };
      if (changed) { upd['開始'] = isoJst_(s); upd['終了'] = isoJst_(e); upd['ジムID'] = gym.id; }
      updateCells_(SH.BOOKINGS, b._row, upd);
      if (changed) patchSlotsCache_(s, e); // 新しい時間を空き枠から外す（元の時間は10分ごとの更新で戻る）
      const rem = c.remaining - 1;
      updateCells_(SH.CUSTOMERS, c._row, { '残回数': rem });
      appendRow_(SH.TICKETS, { '日時': now, '顧客ID': c.id, '氏名': c.name, '増減': -1, '理由': '消化', '予約ID': b['予約ID'] });

      const sent = sendCustomer_(c, fill_(st.tplApprove, {
        name: c.name, date: fmtDay_(s), time: fmtTime_(s) + '〜' + fmtTime_(e),
        gym: gym.name, address: gym.address, remaining: rem
      }) + (changed ? '\n\n※ご希望の「' + fmtDay_(s0) + ' ' + fmtTime_(s0) + '〜｜' + gym0.name + '」から、上記に変更して確定しています。' : ''));
      return (changed ? '日時・場所を変更して' : '') + '確定しました（残回数 ' + rem + '回）。' + (rentalId ? gym.name + 'のカレンダーにも登録しました。' : '') + sentNote_(sent);
    });
  });
}

function apiReject(adminToken, bookingId, reason) {
  return guard_(function () {
    requireAdmin_(adminToken);
    return withLock_(function () {
      const st = getSettings_();
      const b = requireBooking_(bookingId);
      if (b['状態'] !== STATUS.PENDING) fail_('この予約は既に「' + b['状態'] + '」です。');
      const c = requireCustomerById_(b['顧客ID']);
      const ev = b['予定ID'] ? getCal_(st).getEventById(b['予定ID']) : null;
      if (ev) ev.deleteEvent();
      reason = String(reason || '').trim();
      updateCells_(SH.BOOKINGS, b._row, { '状態': STATUS.REJECTED, '処理日時': isoJst_(new Date()), '却下理由': reason });

      const s = new Date(b['開始']), e = new Date(b['終了']);
      const gym = gymById_(getGyms_(), b['ジムID']) || { name: b['ジムID'], address: '' };
      const sent = sendCustomer_(c, fill_(st.tplReject, {
        name: c.name, date: fmtDay_(s), time: fmtTime_(s) + '〜' + fmtTime_(e), gym: gym.name,
        address: gym.address, reason: reason ? '（' + reason + '）' : '', url: customerUrl_(c.token), remaining: c.remaining
      }));
      return '却下しました。' + sentNote_(sent);
    });
  });
}

function apiCancel(adminToken, bookingId, refund) {
  return guard_(function () {
    requireAdmin_(adminToken);
    return withLock_(function () {
      const st = getSettings_();
      const b = requireBooking_(bookingId);
      if (b['状態'] !== STATUS.CONFIRMED) fail_('確定済みの予約だけキャンセルできます（仮予約は「却下」で処理）。');
      const c = requireCustomerById_(b['顧客ID']);
      const ev = b['予定ID'] ? getCal_(st).getEventById(b['予定ID']) : null;
      if (ev) ev.deleteEvent();
      let rentalNote = '';
      if (b['ジム予定ID']) {
        const g = gymById_(getGyms_(), b['ジムID']);
        try {
          const rev = g && g.checkCal ? CalendarApp.getCalendarById(g.checkCal).getEventById(b['ジム予定ID']) : null;
          if (rev) { rev.deleteEvent(); rentalNote = (g ? g.name : 'ジム') + 'の予定も削除しました。'; }
        } catch (err) { rentalNote = '※' + (g ? g.name : 'ジム') + 'の予定は削除できませんでした。手動で消してください。'; }
      }
      const now = isoJst_(new Date());
      let rem = c.remaining;
      if (refund) {
        rem = c.remaining + 1;
        updateCells_(SH.CUSTOMERS, c._row, { '残回数': rem });
        appendRow_(SH.TICKETS, { '日時': now, '顧客ID': c.id, '氏名': c.name, '増減': 1, '理由': 'キャンセル戻し', '予約ID': b['予約ID'] });
      }
      updateCells_(SH.BOOKINGS, b._row, { '状態': STATUS.CANCELED, '処理日時': now, '回数戻し': refund ? 'TRUE' : 'FALSE' });

      const s = new Date(b['開始']), e = new Date(b['終了']);
      const gym = gymById_(getGyms_(), b['ジムID']) || { name: b['ジムID'], address: '' };
      const sent = sendCustomer_(c, fill_(st.tplCancel, {
        name: c.name, date: fmtDay_(s), time: fmtTime_(s) + '〜' + fmtTime_(e), gym: gym.name, address: gym.address,
        refund: refund ? '回数券は消化せず、1回分お戻ししています。' : '規定により、1回分は消化扱いとなります。',
        remaining: rem
      }));
      return 'キャンセルしました（残回数 ' + rem + '回）。' + rentalNote + sentNote_(sent);
    });
  });
}

/** 期間内の予定を1回で取り、iCalUID → 開始日時 の対応表を返す */
function startsByUid_(calId, from, to) {
  const map = {};
  let pageToken;
  do {
    const res = Calendar.Events.list(calId, {
      timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, maxResults: 2500, pageToken: pageToken,
      fields: 'nextPageToken,items(iCalUID,start,status)'
    });
    (res.items || []).forEach(function (ev) {
      if (ev.status === 'cancelled' || !ev.iCalUID || !ev.start) return;
      map[ev.iCalUID] = ev.start.dateTime ? new Date(ev.start.dateTime) : new Date(ev.start.date + 'T00:00:00+09:00');
    });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return map;
}

/**
 * 確定済みの予約の日時・場所を変更（管理画面「日時・場所を変更」）。回数券は動かさない
 * change: { date: 'yyyy-MM-dd', time: 'HH:mm', gymId, force: true=予定の重なりを無視, notify: false=お客さんに連絡しない }
 */
function apiReschedule(adminToken, bookingId, change) {
  return guard_(function () {
    requireAdmin_(adminToken);
    return withLock_(function () {
      const st = getSettings_();
      const b = requireBooking_(bookingId);
      if (b['状態'] !== STATUS.CONFIRMED) fail_('確定済みの予約だけ変更できます（仮予約は「日時・場所を変えて承認」で）。');
      const c = requireCustomerById_(b['顧客ID']);
      const cal = getCal_(st);
      const ev = b['予定ID'] ? cal.getEventById(b['予定ID']) : null;
      if (!ev) fail_('カレンダーに予定が見つかりません（手動で削除された可能性）。');
      const gyms = getGyms_();
      const s0 = new Date(b['開始']), e0 = new Date(b['終了']);
      const gym0 = gymById_(gyms, b['ジムID']) || { id: b['ジムID'], name: b['ジムID'], address: '', checkCal: '' };
      change = change || {};
      const d = String(change.date || dayKey_(s0)), t = String(change.time || fmtTime_(s0));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{1,2}:\d{2}$/.test(t)) fail_('日時の形式が正しくありません。');
      const s = new Date(d + 'T' + (t.length === 4 ? '0' + t : t) + ':00+09:00');
      if (isNaN(s.getTime())) fail_('日時が正しくありません。');
      if (s.getTime() < Date.now()) fail_('過去の日時には変更できません。');
      const gym = change.gymId ? gymById_(gyms, change.gymId) : gym0;
      if (!gym) fail_('場所が見つかりません。');
      const e = new Date(s.getTime() + (e0.getTime() - s0.getTime()));
      const timeChanged = s.getTime() !== s0.getTime(), gymChanged = gym.id !== gym0.id;
      if (!timeChanged && !gymChanged) fail_('日時も場所も変わっていません。');

      if (!change.force && timeChanged) {
        const evId = ev.getId();
        const clash = cal.getEvents(s, e).filter(function (x) { return !x.isAllDayEvent() && x.getId() !== evId; });
        if (clash.length) fail_('【重なり】その時間には「' + clash[0].getTitle() + '」（' + fmtTime_(clash[0].getStartTime()) + '〜' + fmtTime_(clash[0].getEndTime()) + '）が入っています。');
      }

      // ジム側カレンダー（ブース）：新しい場所・時間で入れ直す。先に新しい方を入れて、成功したら古い方を消す
      const oldRental = b['ジム予定ID'] || '';
      let newRental = oldRental, rentalNote = '';
      if (gym.checkCal) {
        const gcal = CalendarApp.getCalendarById(gym.checkCal);
        if (!gcal) fail_(gym.name + 'のカレンダーが見つかりません。');
        const clash2 = gcal.getEvents(s, e).filter(function (x) { return !x.isAllDayEvent() && x.getId() !== oldRental; });
        if (clash2.length) fail_(gym.name + 'のカレンダーにその時間の予定（' + clash2[0].getTitle() + '）が既に入っています。ブースの空きを確認してください。');
        try {
          newRental = gcal.createEvent(fill_(st.rentalTitle, { name: c.name }), s, e, {
            description: 'さんぽんパーソナル予約システムで作成\n予約ID：' + b['予約ID']
          }).getId();
          rentalNote = gym.name + 'のカレンダーも新しい時間で登録しました。';
        } catch (err) {
          fail_(gym.name + 'のカレンダーに予定を入れられませんでした（編集権限がない可能性）。変更は中止しました。');
        }
      } else {
        newRental = '';
      }
      if (oldRental) {
        try {
          const rev = gym0.checkCal ? CalendarApp.getCalendarById(gym0.checkCal).getEventById(oldRental) : null;
          if (rev) rev.deleteEvent();
        } catch (err) { rentalNote += '※' + gym0.name + 'の古い予定は削除できませんでした。手動で消してください。'; }
      }

      ev.setTime(s, e);
      if (gymChanged) { ev.setLocation(gym.name + '　' + (gym.address || '')); setGymTag_(st, ev, gym.id); }
      ev.setDescription(String(ev.getDescription() || '') + '\n変更（' + fmtDay_(new Date()) + '）：' + fmtDay_(s0) + ' ' + fmtTime_(s0) + '｜' + gym0.name + ' → ' + fmtDay_(s) + ' ' + fmtTime_(s) + '｜' + gym.name);
      updateCells_(SH.BOOKINGS, b._row, { '開始': isoJst_(s), '終了': isoJst_(e), 'ジムID': gym.id, 'ジム予定ID': newRental, '処理日時': isoJst_(new Date()) });
      patchSlotsCache_(s, e);

      let sentNote = 'お客さんには連絡していません。';
      if (change.notify !== false) {
        const sent = sendCustomer_(c, c.name + 'さん\nご予約の日時・場所を変更しました。\n\n変更前：' + fmtDay_(s0) + ' ' + fmtTime_(s0) + '〜' + fmtTime_(e0) + '｜' + gym0.name +
          '\n変更後：' + fmtDay_(s) + ' ' + fmtTime_(s) + '〜' + fmtTime_(e) + '\n場所：' + gym.name + (gym.address ? '\n住所：' + gym.address : '') + '\n\n当日お待ちしています！');
        sentNote = sentNote_(sent);
      }
      return '変更しました（' + fmtDay_(s) + ' ' + fmtTime_(s) + '〜｜' + gym.name + '）。' + rentalNote + sentNote;
    });
  });
}

function apiAddTickets(adminToken, customerId, delta, reason) {
  return guard_(function () {
    requireAdmin_(adminToken);
    return withLock_(function () {
      const n = Number(delta);
      if (!n || Math.floor(n) !== n) fail_('回数は0以外の整数で入力してください。');
      const c = requireCustomerById_(customerId);
      const rem = c.remaining + n;
      if (rem < 0) fail_('残回数がマイナスになります。');
      updateCells_(SH.CUSTOMERS, c._row, { '残回数': rem });
      appendRow_(SH.TICKETS, {
        '日時': isoJst_(new Date()), '顧客ID': c.id, '氏名': c.name, '増減': n,
        '理由': String(reason || '').trim() || (n > 0 ? '付与' : '補正'), '予約ID': ''
      });
      return c.name + 'さんの残回数を ' + rem + '回にしました。';
    });
  });
}

function apiIssueUrl(adminToken, customerId) {
  return guard_(function () {
    requireAdmin_(adminToken);
    return withLock_(function () { return issueCustomerUrl_(customerId); });
  });
}

// ===== 定時処理 =====
/** 毎朝8時：放置された仮予約をまとめてリマインド */
function notifyStalePending() {
  const st = getSettings_();
  const limit = Date.now() - st.staleHours * 3600000;
  const stale = readRows_(SH.BOOKINGS).filter(function (b) {
    return b['状態'] === STATUS.PENDING && b['申請日時'] && new Date(b['申請日時']).getTime() < limit;
  }).sort(byStart_);
  if (!stale.length) return;
  const lines = stale.map(function (b) {
    const s = new Date(b['開始']);
    return '・' + b['氏名'] + 'さん ' + fmtDay_(s) + ' ' + fmtTime_(s);
  });
  notifyTrainer_(':hourglass: *承認待ちの仮予約が ' + stale.length + '件あります*\n' + lines.join('\n') + '\n' + adminUrl_());
}

// ===== 空き枠判定（中核ロジック） =====
/** 受付期間：今から LEAD_DAYS 日後 〜 MAX_MONTHS ヶ月後の日の終わり */
function bookingRange_(st, now) {
  const from = new Date(now.getTime() + st.leadDays * 86400000);
  const y = Number(Utilities.formatDate(now, TZ, 'yyyy'));
  const m = Number(Utilities.formatDate(now, TZ, 'M')) - 1 + st.maxMonths;
  const d = Number(Utilities.formatDate(now, TZ, 'd'));
  const ty = y + Math.floor(m / 12), tm = (m % 12) + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate(); // その月の末日
  const key = ty + '-' + pad2_(tm) + '-' + pad2_(Math.min(d, lastDay));
  const to = new Date(key + 'T23:59:59+09:00');
  return { from: from, to: to };
}

/** カレンダーから「埋まっている時間」と場所を読み込む */
function loadBusy_(cal, from, to, st, gyms) {
  const pad = 6 * 3600000; // 前後の移動時間判定のため少し広めに読む
  const fromP = new Date(from.getTime() - pad), toP = new Date(to.getTime() + pad);
  // 高速版：Calendar API（拡張サービス）で一括取得。使えない場合は従来の方法
  if (typeof Calendar !== 'undefined' && Calendar.Events) {
    try { return loadBusyFast_(cal.getId(), fromP, toP, st, gyms); } catch (e) { Logger.log('高速取得に失敗、通常取得に切替: ' + e); }
  }
  const evs = cal.getEvents(fromP, toP);
  const out = [];
  evs.forEach(function (ev) {
    try {
      if (ev.getMyStatus && ev.getMyStatus() === CalendarApp.GuestStatus.NO) return; // 欠席にした予定は無視
    } catch (e) { /* 自分が主催の予定では取得できない場合あり */ }
    if (ev.isAllDayEvent()) {
      const title = ev.getTitle() || '';
      const blocks = st.alldayWords.some(function (w) { return w && title.indexOf(w) >= 0; });
      if (blocks) out.push({ start: ev.getAllDayStartDate(), end: ev.getAllDayEndDate(), gymId: null, allDay: true });
      return;
    }
    const gymId = ev.getTag('spGym') || matchGym_(ev.getLocation(), gyms);
    out.push({ start: ev.getStartTime(), end: ev.getEndTime(), gymId: gymId || null, allDay: false });
  });
  return out;
}

/** Calendar API で予定を一括取得（1リクエストで最大2500件） */
function loadBusyFast_(calId, from, to, st, gyms) {
  const out = [];
  let pageToken;
  do {
    const res = Calendar.Events.list(calId, {
      timeMin: from.toISOString(), timeMax: to.toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults: 2500, pageToken: pageToken,
      fields: 'nextPageToken,items(summary,location,start,end,status,attendees(self,responseStatus),extendedProperties)'
    });
    (res.items || []).forEach(function (ev) {
      if (ev.status === 'cancelled') return;
      const me = (ev.attendees || []).filter(function (a) { return a.self; })[0];
      if (me && me.responseStatus === 'declined') return; // 欠席にした予定は無視
      if (ev.start && ev.start.date) { // 終日予定
        const title = ev.summary || '';
        const blocks = st.alldayWords.some(function (w) { return w && title.indexOf(w) >= 0; });
        if (blocks) out.push({ start: new Date(ev.start.date + 'T00:00:00+09:00'), end: new Date(ev.end.date + 'T00:00:00+09:00'), gymId: null, allDay: true });
        return;
      }
      const ep = ev.extendedProperties || {};
      const tag = (ep.shared && ep.shared.spGym) || (ep.private && ep.private.spGym) || ''; // 場所を変えた時の印（shared）を優先
      const gymId = matchGym_(ev.location, gyms) || tag; // 場所欄を優先
      out.push({ start: new Date(ev.start.dateTime), end: new Date(ev.end.dateTime), gymId: gymId || null, allDay: false });
    });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

/** ジム側の予約カレンダー（例：GlitteR ブース2）で埋まっている時間を読む */
function loadGymCal_(gym, from, to) {
  if (!gym.checkCal) return [];
  const out = [];
  try {
    if (typeof Calendar !== 'undefined' && Calendar.Events) {
      let pageToken;
      do {
        const res = Calendar.Events.list(gym.checkCal, {
          timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, maxResults: 2500, pageToken: pageToken,
          fields: 'nextPageToken,items(start,end,status,transparency)'
        });
        (res.items || []).forEach(function (ev) {
          if (ev.status === 'cancelled' || ev.transparency === 'transparent') return;
          const s = ev.start.dateTime ? new Date(ev.start.dateTime) : new Date(ev.start.date + 'T00:00:00+09:00');
          const e = ev.end.dateTime ? new Date(ev.end.dateTime) : new Date(ev.end.date + 'T00:00:00+09:00');
          out.push({ start: s, end: e, gymId: gym.id, hard: true });
        });
        pageToken = res.nextPageToken;
      } while (pageToken);
      return out;
    }
    const cal = CalendarApp.getCalendarById(gym.checkCal);
    if (!cal) throw new Error('カレンダーが見つかりません');
    cal.getEvents(from, to).forEach(function (ev) {
      out.push({ start: ev.getStartTime(), end: ev.getEndTime(), gymId: gym.id, hard: true });
    });
  } catch (e) {
    fail_(gym.name + 'の空き状況を確認できませんでした。時間をおいて再度お試しください。');
  }
  return out;
}

/** 予定の場所（文字列）からジムを推定 */
function matchGym_(location, gyms) {
  const loc = String(location || '');
  if (!loc) return null;
  for (let i = 0; i < gyms.length; i++) {
    const g = gyms[i];
    if (g.id === OTHER_GYM) continue;
    const words = [g.name].concat(g.keywords);
    for (let j = 0; j < words.length; j++) {
      if (words[j] && loc.indexOf(words[j]) >= 0) return g.id;
    }
  }
  return null;
}

/** 2つの予定の間に必要な空き時間（分） */
function gapMin_(fromGym, toGym, st, travel) {
  if (!fromGym || !toGym || fromGym === OTHER_GYM || toGym === OTHER_GYM) return st.unknownBuffer;
  if (fromGym === toGym) return 0;
  return travel(fromGym, toGym);
}

/** 枠 [s, e) を gymId で入れられるか */
function slotFree_(s, e, gymId, busy, st, travel) {
  const S = s.getTime(), E = e.getTime();
  for (let i = 0; i < busy.length; i++) {
    const b = busy[i];
    const bs = b.start.getTime(), be = b.end.getTime();
    if (b.allDay || b.hard) { // 終日ブロック・ジム側の予約は、時間が重なったらNG（移動時間は関係なし）
      if (bs < E && be > S) return false;
      continue;
    }
    const okBefore = be + gapMin_(b.gymId, gymId, st, travel) * 60000 <= S; // 予定が先に終わって移動が間に合う
    const okAfter = E + gapMin_(gymId, b.gymId, st, travel) * 60000 <= bs;  // 枠が先に終わって移動が間に合う
    if (!okBefore && !okAfter) return false;
  }
  return true;
}

/** 受付期間内の空き枠を日ごとに返す */
function buildSlots_(gymId, st, busy, travel, hours, from, to) {
  // 高速化（10/19）：日付→文字の変換（Utilities.formatDate）を枠ごとに呼ばず計算で作る／その日の前後の予定だけを見る
  const JST = 9 * 3600000, DAY = 86400000, PAD = 6 * 3600000;
  const days = [];
  const fromMs = from.getTime(), toMs = to.getTime();
  let dayStart = Math.floor((fromMs + JST) / DAY) * DAY - JST; // JSTの0時
  while (dayStart <= toMs) {
    const j = new Date(dayStart + JST);
    const key = j.getUTCFullYear() + '-' + pad2_(j.getUTCMonth() + 1) + '-' + pad2_(j.getUTCDate());
    const dow = j.getUTCDay();
    const h = hours[DOW[dow]];
    const times = [];
    if (h && !h.closed) {
      const near = busy.filter(function (b) { return b.end.getTime() + PAD >= dayStart && b.start.getTime() - PAD <= dayStart + DAY; });
      for (let t = h.open; t + st.sessionMin <= h.close; t += st.stepMin) {
        const sMs = dayStart + t * 60000;
        if (sMs < fromMs || sMs > toMs) continue;
        const s = new Date(sMs), e = new Date(sMs + st.sessionMin * 60000);
        if (slotFree_(s, e, gymId, near, st, travel)) {
          const hh = Math.floor(t / 60), mm = pad2_(t % 60);
          times.push({ start: key + 'T' + pad2_(hh) + ':' + mm + ':00+09:00', label: hh + ':' + mm });
        }
      }
    }
    if (times.length) days.push({ date: key, label: (j.getUTCMonth() + 1) + '/' + j.getUTCDate() + '（' + DOW[dow] + '）', times: times });
    dayStart += DAY;
  }
  return days;
}

function travelFn_(st) {
  const map = {};
  readRows_(SH.TRAVEL).forEach(function (r) {
    const a = r['出発ジムID'], b = r['到着ジムID'], m = Number(r['所要分']);
    if (!a || !b || isNaN(m)) return;
    map[a + '|' + b] = m;
    if (map[b + '|' + a] === undefined) map[b + '|' + a] = m;
  });
  return function (a, b) {
    const v = map[a + '|' + b];
    return v === undefined ? st.travelDefault : v;
  };
}

function getHours_() {
  const out = {};
  readRows_(SH.HOURS).forEach(function (r) {
    const open = toMin_(r['開始']), close = toMin_(r['終了']);
    out[r['曜日']] = { open: open, close: close, closed: isTrue_(r['休み']) || open === null || close === null };
  });
  return out;
}

// ===== データアクセス =====
function getSettings_() {
  const s = {};
  readRows_(SH.SETTINGS).forEach(function (r) { if (r['キー']) s[r['キー']] = r['値']; });
  return {
    calendarId: s.CALENDAR_ID || 'primary',
    webappUrl: s.WEBAPP_URL || '',
    sessionMin: num_(s.SESSION_MIN, 60),
    stepMin: Math.max(5, num_(s.STEP_MIN, 15)),
    leadDays: num_(s.LEAD_DAYS, 7),
    maxMonths: Math.max(1, num_(s.MAX_MONTHS, 2)),
    maxPending: Math.max(1, num_(s.MAX_PENDING, 4)),
    unknownBuffer: num_(s.UNKNOWN_BUFFER_MIN, 30),
    travelDefault: num_(s.TRAVEL_DEFAULT_MIN, 60),
    alldayWords: splitList_(s.ALLDAY_BLOCK_WORDS),
    staleHours: num_(s.STALE_HOURS, 24),
    tplApprove: s.TEMPLATE_APPROVE || DEFAULT_ROWS['設定'][11][1],
    tplReject: s.TEMPLATE_REJECT || DEFAULT_ROWS['設定'][12][1],
    tplCancel: s.TEMPLATE_CANCEL || DEFAULT_ROWS['設定'][13][1],
    rentalTitle: s.RENTAL_TITLE || DEFAULT_ROWS['設定'][14][1]
  };
}

function getCal_(st) {
  const cal = st.calendarId === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(st.calendarId);
  if (!cal) fail_('カレンダーが見つかりません。「設定」シートのCALENDAR_IDを確認してください。');
  return cal;
}

function getGyms_() {
  return readRows_(SH.GYMS).filter(function (r) { return r['ジムID']; }).map(function (r) {
    return { id: r['ジムID'], name: r['名称'], address: r['住所'], keywords: splitList_(r['判定キーワード']), active: isTrue_(r['有効']), checkCal: r['空き確認カレンダーID'] || '', group: String(r['まとめボタン'] || '').trim() };
  });
}
function gymById_(gyms, id) { return gyms.filter(function (g) { return g.id === id; })[0] || null; }

function toCustomer_(r) {
  return {
    id: r['顧客ID'], name: r['氏名'], calName: r['カレンダー表記'] || (r['氏名'] + 'PT'),
    gymIds: splitList_(r['利用ジムID']), slack: r['SlackチャンネルID'], token: r['トークン'],
    remaining: num_(r['残回数'], 0), active: isTrue_(r['有効']), _row: r._row,
    until: untilOf_(r['予約期限']),
    prefer: String(r['優先ジム'] || '').trim(),
    sessionMin: num_(r['セッション分'], 0)
  };
}
/** その顧客の1回の長さ（分）。顧客シート「セッション分」が空なら設定シートの SESSION_MIN */
function lenOf_(c, st) { return c.sessionMin > st.sessionMin ? c.sessionMin : st.sessionMin; }
/** 長いセッション（例：夫婦で120分）用：通常枠（60分）が連続して空いている開始時刻だけ残す */
function forLength_(days, len, st) {
  const n = Math.ceil(len / st.sessionMin);
  if (n <= 1) return days;
  const step = st.sessionMin * 60000;
  return days.map(function (d) {
    const set = {};
    d.times.forEach(function (t) { set[new Date(t.start).getTime()] = true; });
    return { date: d.date, label: d.label, times: d.times.filter(function (t) {
      const s0 = new Date(t.start).getTime();
      for (let i = 1; i < n; i++) if (!set[s0 + i * step]) return false;
      return true;
    }) };
  }).filter(function (d) { return d.times.length; });
}
/** 顧客ごとの予約期限（例 2026/11/30 → その日の23:59:59まで）。空欄なら null（期限なし） */
function untilOf_(v) {
  const m = String(v || '').trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (!m) return null;
  return new Date(m[1] + '-' + pad2_(Number(m[2])) + '-' + pad2_(Number(m[3])) + 'T23:59:59+09:00');
}
/** 予約期限より後の枠を外す */
function cutUntil_(days, until) {
  if (!until) return days;
  const lim = until.getTime();
  return days.map(function (d) {
    return { date: d.date, label: d.label, times: d.times.filter(function (t) { return new Date(t.start).getTime() <= lim; }) };
  }).filter(function (d) { return d.times.length; });
}
function findCustomerByToken_(token) {
  if (!token) return null;
  let r = readRows_(SH.CUSTOMERS).filter(function (x) { return x['トークン'] === token; })[0];
  if (!r && !FRESH_READS_) { // ためていた内容が古い可能性があるので、見つからない時だけ最新のシートで探し直す
    delete ROWS_MEMO_[SH.CUSTOMERS]; FRESH_READS_ = true;
    try { r = readRows_(SH.CUSTOMERS).filter(function (x) { return x['トークン'] === token; })[0]; } finally { FRESH_READS_ = false; }
  }
  if (!r) return null;
  const c = toCustomer_(r);
  return c.active ? c : null;
}
function requireCustomer_(token) {
  const c = findCustomerByToken_(String(token || ''));
  if (!c) fail_('このURLは無効です。トレーナーにお問い合わせください。');
  return c;
}
function requireCustomerById_(id) {
  const r = readRows_(SH.CUSTOMERS).filter(function (x) { return x['顧客ID'] === id; })[0];
  if (!r) fail_('顧客ID「' + id + '」が見つかりません。');
  return toCustomer_(r);
}
function requireBooking_(id) {
  const b = readRows_(SH.BOOKINGS).filter(function (x) { return x['予約ID'] === id; })[0];
  if (!b) fail_('予約が見つかりません。画面を再読み込みしてください。');
  return b;
}
function requireAdmin_(token) {
  const t = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  if (!t || token !== t) fail_('管理画面のURLが無効です。');
}

function issueCustomerUrl_(customerId) {
  const c = requireCustomerById_(customerId);
  const token = newToken_();
  updateCells_(SH.CUSTOMERS, c._row, { 'トークン': token });
  return customerUrl_(token);
}

let SS_MEMO_ = null; // 1回の処理の中でスプレッドシートを何度も開き直さない（1回0.3〜0.5秒かかるため）
function sheet_(name) {
  if (!SS_MEMO_) {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    SS_MEMO_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  }
  const sh = SS_MEMO_.getSheetByName(name);
  if (!sh) fail_('シート「' + name + '」がありません。setup() を実行してください。');
  return sh;
}
// シートの読み込み結果を少しの間（最大15分。10分ごとの自動更新で読み直す）ためておく。毎回スプレッドシートを開いて読むと1回1秒前後かかるため
// ・この仕組みが書き込むときは、その場で捨てる（updateCells_ / appendRow_）
// ・手でシートを直したときは onEdit で全部捨てる（※Googleの外のツールで直した場合は最大10分遅れ）
// ・承認・申請など書き込みを伴う処理（withLock_ の中）は、ためた結果を使わず必ずシートを読む
const ROWS_CACHE_SEC = 900;
let ROWS_MEMO_ = {}, FRESH_READS_ = false;
function rowsKey_(name) { return 'rows:' + name; }
function dropRows_(name) {
  delete ROWS_MEMO_[name];
  try { CacheService.getScriptCache().remove(rowsKey_(name)); } catch (e) { /* 何もしない */ }
}
function dropAllRows_() {
  ROWS_MEMO_ = {};
  CacheService.getScriptCache().removeAll(Object.keys(SH).map(function (k) { return rowsKey_(SH[k]); }));
}
function sheetValues_(name) {
  if (ROWS_MEMO_[name]) return ROWS_MEMO_[name];
  const cache = CacheService.getScriptCache();
  let values = null;
  if (!FRESH_READS_) {
    const hit = cache.get(rowsKey_(name));
    if (hit) { try { values = JSON.parse(hit); } catch (e) { values = null; } }
  }
  if (!values) {
    values = sheet_(name).getDataRange().getDisplayValues();
    const json = JSON.stringify(values);
    if (json.length < 90000) { try { cache.put(rowsKey_(name), json, ROWS_CACHE_SEC); } catch (e) { /* 何もしない */ } }
  }
  ROWS_MEMO_[name] = values;
  return values;
}
function readRows_(name) {
  const values = sheetValues_(name).slice();
  const head = (values.shift() || []).map(function (h) { return String(h).trim(); });
  const rows = [];
  values.forEach(function (row, i) {
    const o = { _row: i + 2 };
    let any = false;
    head.forEach(function (h, j) {
      const v = String(row[j] === undefined ? '' : row[j]).trim();
      o[h] = v;
      if (v) any = true;
    });
    if (any) rows.push(o);
  });
  return rows;
}
function updateCells_(name, rowNum, obj) {
  const sh = sheet_(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
  Object.keys(obj).forEach(function (k) {
    let col = head.indexOf(k);
    if (col < 0 && HEADERS[name] && HEADERS[name].indexOf(k) >= 0) { // 後から追加した列は自動で作る
      col = head.length;
      sh.getRange(1, col + 1).setValue(k).setFontWeight('bold').setBackground('#e6efe0');
      head.push(k);
    }
    if (col < 0) fail_('シート「' + name + '」に列「' + k + '」がありません。');
    sh.getRange(rowNum, col + 1).setNumberFormat('@').setValue(String(obj[k]));
  });
  dropRows_(name);
}
function appendRow_(name, obj) {
  const sh = sheet_(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
  const row = sh.getLastRow() + 1;
  const values = head.map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : String(obj[h]); });
  sh.getRange(row, 1, 1, head.length).setNumberFormat('@').setValues([values]);
  dropRows_(name);
}

// ===== Slack =====
/** 顧客の既存DMチャンネルに、さんぽん本人として投稿（ユーザートークン） */
function sendCustomer_(c, text) {
  const tok = PropertiesService.getScriptProperties().getProperty('SLACK_USER_TOKEN');
  if (!tok) return { ok: false, error: 'SLACK_USER_TOKEN 未設定' };
  if (!c.slack) return { ok: false, error: c.name + 'さんのSlackチャンネルID未設定' };
  try {
    const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { Authorization: 'Bearer ' + tok },
      payload: JSON.stringify({ channel: c.slack, text: text }),
      muteHttpExceptions: true
    });
    const j = JSON.parse(res.getContentText());
    return j.ok ? { ok: true } : { ok: false, error: j.error };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** トレーナー宛て通知（Incoming Webhook） */
/** 仮予約の通知は後回し（お客さんを待たせないため）。1分ごとのトリガーでまとめて送る */
function queueNotify_(text) {
  try {
    const p = PropertiesService.getScriptProperties();
    const q = JSON.parse(p.getProperty('NOTIFY_QUEUE') || '[]');
    q.push(text);
    p.setProperty('NOTIFY_QUEUE', JSON.stringify(q));
  } catch (e) { notifyTrainer_(text); }
}
function flushNotifyQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  let q;
  try {
    const p = PropertiesService.getScriptProperties();
    q = JSON.parse(p.getProperty('NOTIFY_QUEUE') || '[]');
    if (!q.length) return;
    p.deleteProperty('NOTIFY_QUEUE');
  } finally { lock.releaseLock(); }
  q.forEach(function (t) { notifyTrainer_(t); });
}
function ensureFlushTrigger_() {
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'flushNotifyQueue'; });
  if (!has) ScriptApp.newTrigger('flushNotifyQueue').timeBased().everyMinutes(1).create();
}
/** 仮予約の予定を1回の通信で作る（従来は作成＋タグ2つで3回）。予定IDは従来と同じ形式（iCalUID） */
function createPendingEvent_(st, c, gym, id, s, e) {
  const title = PENDING_PREFIX + c.calName;
  const loc = gym.name + '　' + gym.address;
  const desc = 'さんぽんパーソナル予約システムで作成\n予約ID：' + id + '\n顧客：' + c.name + '\n状態：仮予約（承認待ち）';
  if (typeof Calendar !== 'undefined' && Calendar.Events) {
    try {
      const r = Calendar.Events.insert({
        summary: title, location: loc, description: desc,
        start: { dateTime: isoJst_(s), timeZone: TZ }, end: { dateTime: isoJst_(e), timeZone: TZ },
        extendedProperties: { private: { spId: id, spGym: gym.id } }
      }, getCal_(st).getId(), { fields: 'iCalUID' });
      if (r && r.iCalUID) return r.iCalUID;
    } catch (err) { Logger.log('高速作成に失敗、通常作成に切替: ' + err); }
  }
  const ev = getCal_(st).createEvent(title, s, e, { location: loc, description: desc });
  ev.setTag('spId', id);
  ev.setTag('spGym', gym.id);
  return ev.getId();
}
/** 予定の「場所」の印を書き換える（2か所に持っているので両方そろえる） */
function setGymTag_(st, ev, gymId) {
  ev.setTag('spGym', gymId);
  if (typeof Calendar !== 'undefined' && Calendar.Events) {
    try {
      Calendar.Events.patch({ extendedProperties: { private: { spGym: gymId } } }, getCal_(st).getId(), String(ev.getId()).replace(/@google\.com$/, ''));
    } catch (e) { Logger.log('場所の印の更新に失敗: ' + e); }
  }
}
function notifyTrainer_(text) {
  const url = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!url) { Logger.log('[通知未設定] ' + text); return; }
  try {
    UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify({ text: text }), muteHttpExceptions: true
    });
  } catch (e) { Logger.log('Slack通知失敗: ' + e); }
}

function sentNote_(sent) {
  return sent.ok ? 'お客さんにSlackで連絡しました。' : '※お客さんへのSlack連絡は失敗しました（' + sent.error + '）。手動で連絡してください。';
}

// ===== 共通ユーティリティ =====
function fail_(msg) { const e = new Error(msg); e.userFacing = true; throw e; }

/** API共通：想定外のエラーはトレーナーに通知し、お客さんには一般的な文言を返す */
function guard_(fn) {
  try {
    return fn();
  } catch (e) {
    if (e && e.userFacing) throw new Error(e.message);
    Logger.log(e && e.stack ? e.stack : e);
    notifyTrainer_(':warning: 予約システムでエラーが発生しました：' + (e && e.message ? e.message : e));
    throw new Error('エラーが発生しました。時間をおいて再度お試しください。');
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail_('混み合っています。少し待ってからもう一度お試しください。');
  // 書き込みを伴う処理は、ためた読み込み結果を使わず最新のシートで判断する
  ROWS_MEMO_ = {}; FRESH_READS_ = true;
  try { return fn(); } finally { FRESH_READS_ = false; lock.releaseLock(); }
}

function adminUrl_() {
  const t = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  return webappUrl_() + '?admin=' + t;
}
function customerUrl_(token) { return webappUrl_() + '?t=' + token; }
function webappUrl_() {
  const st = getSettings_();
  if (st.webappUrl) return st.webappUrl.replace(/[?#].*$/, '');
  try { return ScriptApp.getService().getUrl() || '（WEBAPP_URL未設定）'; } catch (e) { return '（WEBAPP_URL未設定）'; }
}

function newToken_() { return Utilities.getUuid().replace(/-/g, '').toLowerCase(); }
function fill_(tpl, vars) {
  return String(tpl).replace(/\\n/g, '\n').split('\n').map(function (line) {
    var empty = false;
    var out = line.replace(/\{(\w+)\}/g, function (m, k) {
      var v = vars[k] === undefined || vars[k] === null ? '' : String(vars[k]);
      if (v === '') empty = true;
      return v;
    });
    // 「住所：」のように値が空で項目名だけ残る行は出さない
    return empty && /[：:]\s*$/.test(out) ? null : out;
  }).filter(function (l) { return l !== null; }).join('\n');
}
function isoJst_(d) { return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function dayKey_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function dowJst_(d) { return Number(Utilities.formatDate(d, TZ, 'u')) % 7; } // 0=日
function fmtDay_(d) { return Utilities.formatDate(d, TZ, 'M/d') + '（' + DOW[dowJst_(d)] + '）'; }
function fmtTime_(d) { return Utilities.formatDate(d, TZ, 'H:mm'); }
function byStart_(a, b) { return new Date(a['開始']) - new Date(b['開始']); }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function num_(v, def) { const n = Number(v); return v === '' || v === undefined || v === null || isNaN(n) ? def : n; }
function isTrue_(v) { return /^(true|○|◯|1|yes|有効)$/i.test(String(v || '').trim()); }
function splitList_(v) {
  return String(v || '').split(/[,、，]+/).map(function (x) { return x.trim(); }).filter(function (x) { return x; });
}
function toMin_(v) {
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function escHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
