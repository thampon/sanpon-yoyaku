// GlitteR 体験予約 自動テスト
// 実行：npm i jsdom@24 → node glitter-demo/tests/suite.js（試作版も試す時は TRIAL=/path/to/index.html を付ける）（見本版＝端末内保存／試作版＝共有データの代役で実行）
const {JSDOM}=require('jsdom');const fs=require('fs');
const path=require('path');const DEMO=path.join(__dirname,'..','index.html'), TRIAL=process.env.TRIAL||'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];
function check(id,name,ok,detail){results.push({id,name,ok:!!ok,detail:detail||''})}
const pad=n=>String(n).padStart(2,'0');
function jstToday(off=0){const d=new Date(Date.now()+9*3600e3+off*864e5);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())}

function load(file,{url='https://example.test/glitter-demo/',storage=null,claude=null}={}){
  let html=fs.readFileSync(file,'utf8').replace(/<link[^>]*fonts[^>]*>/,'');
  if(!/^<!doctype/i.test(html))html='<!doctype html><html><head></head><body>'+html+'</body></html>';
  const dom=new JSDOM(html,{url,runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){
    w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
    if(storage)for(const k in storage)w.localStorage.setItem(k,storage[k]);
    if(claude)w.claude=claude(w);
  }});
  const w=dom.window,d=w.document,$=id=>d.getElementById(id);
  return {w,d,$,state:()=>JSON.parse(w.localStorage.getItem('glitterDemoV1')||'{}'),storage:()=>({glitterDemoV1:w.localStorage.getItem('glitterDemoV1')})};
}
function fill(t,o={}){const {$,d}=t;
  $('name').value=o.name??'テスト 花子';$('kana').value=o.kana??'テスト ハナコ';
  if(o.gender!==null)$(o.gender||'g1').checked=true;
  $('tel').value=o.tel??'09011112222';$('email').value=o.email??'hanako@example.com';
  $('comment').value=o.comment??'';$('consent').checked=o.consent??true;
  for(let n=1;n<=3;n++){$('d'+n).value=(o['d'+n]??'');$('t'+n).value=(o['t'+n]??'')}
}
const submit=t=>t.$('form').dispatchEvent(new t.w.Event('submit',{cancelable:true}));
const btn=(t,root,text)=>[...t.d.querySelectorAll(root+' button')].find(b=>b.textContent.trim()===text);
const apps=t=>Object.entries(t.state()).filter(([k])=>k.startsWith('applications/')).map(([,v])=>v);
const booth=t=>Object.entries(t.state()).filter(([k])=>k.startsWith('booth2/')).map(([k,v])=>({id:k,...v}));
const errs=t=>[...t.d.querySelectorAll('.err:not([hidden])')].map(e=>e.textContent);
async function apply(t,o){fill(t,o);submit(t);await sleep(10);if(t.$('confirm').hidden)return false;t.$('sendBtn').click();await sleep(150);return !t.$('done').hidden}

(async()=>{
const D2=jstToday(2),D9=jstToday(9),D10=jstToday(10),D20=jstToday(20);
// ===== 見本版 =====
let t=load(DEMO);await sleep(80);

// T01 必須未入力
fill(t,{name:'',kana:'',gender:null,tel:'',email:'',consent:false});submit(t);await sleep(5);
check('T01','必須項目が空だとエラーになり確認へ進まない',!t.$('formErr').hidden&&t.$('confirm').hidden&&t.d.querySelectorAll('.invalid').length===7,'エラー箇所 '+t.d.querySelectorAll('.invalid').length+'件');
// T09 入力保持
t.$('name').value='保持 テスト';submit(t);await sleep(5);
check('T09','エラー時に入力内容が消えない',t.$('name').value==='保持 テスト');
// T02 メール形式
fill(t,{email:'abc@',d1:D10,t1:'13:00'});submit(t);await sleep(5);
check('T02','メールアドレスの形式チェック',errs(t).some(e=>e.includes('メールアドレス'))&&t.$('confirm').hidden);
// T03 電話番号（全角・ハイフン可、桁不足はエラー）
fill(t,{tel:'12345',d1:D10,t1:'13:00'});submit(t);await sleep(5);
const telNg=errs(t).some(e=>e.includes('電話番号'));
fill(t,{tel:'０９０－１２３４－５６７８',d1:D10,t1:'13:00'});submit(t);await sleep(5);
const telOk=!t.$('confirm').hidden&&t.$('cInfo').textContent.includes('09012345678');
check('T03','電話番号チェック（全角・ハイフン可／桁不足はエラー）',telNg&&telOk);t.$('backBtn').click();
// T04 フリガナ
fill(t,{kana:'やまだ はなこ',d1:D10,t1:'13:00'});submit(t);await sleep(5);
const kanaOk=t.$('kana').value==='ヤマダ ハナコ'&&!t.$('confirm').hidden;t.$('backBtn').click();
fill(t,{kana:'Yamada',d1:D10,t1:'13:00'});submit(t);await sleep(5);
check('T04','フリガナはひらがな→カタカナ自動変換、英字はエラー',kanaOk&&errs(t).some(e=>e.includes('フリガナ')));
// T05 過去日時・受付開始前
check('T05a','日付欄の最短日が「今日＋2日」',t.$('d1').min===D2,'min='+t.$('d1').min);
fill(t,{d1:jstToday(-1),t1:'10:00'});submit(t);await sleep(5);
const pastNg=errs(t).some(e=>e.includes('お選びください'));
fill(t,{d1:jstToday(1),t1:'10:00'});submit(t);await sleep(5);
check('T05b','過去日・明日を直接入力してもエラー',pastNg&&errs(t).some(e=>e.includes('お選びください')));
// T06 期間外
fill(t,{d1:jstToday(61),t1:'10:00'});submit(t);await sleep(5);
check('T06','61日先はエラー',errs(t).some(e=>e.includes('お選びください')));
// T07 日付だけ
fill(t,{d1:D10,t1:'10:00',d2:D10});submit(t);await sleep(5);
check('T07','日付だけ・時刻だけはエラー',errs(t).some(e=>e.includes('両方')));
// T08 候補の重なり
fill(t,{d1:D10,t1:'10:00',d2:D10,t2:'11:00'});submit(t);await sleep(5);
const ovNg=errs(t).some(e=>e.includes('重なって'));
fill(t,{d1:D10,t1:'10:00',d2:D10,t2:'11:30'});submit(t);await sleep(5);
check('T08','候補同士の重なりはエラー、ちょうど90分後はOK',ovNg&&!t.$('confirm').hidden);
// T10 確認画面 → 戻る
const confOk=t.$('cSlots').textContent.includes('10:00〜11:30')&&t.$('cSlots').textContent.includes('指定なし');
t.$('backBtn').click();
check('T10','確認画面の内容表示と「戻る」で入力が残る',confOk&&!t.$('form').hidden&&t.$('d2').value===D10);
// T26 空データ
t.$('tabAdm').click();
check('T26','申込0件の時に案内が出る',t.$('appList').textContent.includes('まだ申込はありません'));
t.$('tabCust').click();
// T11 二重送信
fill(t,{d1:D9,t1:'10:00',d2:D10,t2:'14:00',comment:'<img src=x onerror="window.__x=1">テスト'});submit(t);await sleep(5);
t.$('sendBtn').click();t.$('sendBtn').click();t.$('sendBtn').click();await sleep(200);
check('T11','送信ボタン3回連打でも1件',apps(t).length===1&&!t.$('done').hidden,'件数 '+apps(t).length);
const no1=t.$('doneNo').textContent;
// T12 同じ内容で再申込
t.$('againBtn').click();await apply(t,{d1:D9,t1:'10:00',d2:D10,t2:'14:00'});await sleep(200);
const a1=apps(t);
check('T12','完了後に同じ内容で再申込しても1件（履歴に記録）',a1.length===1&&a1[0].history.some(h=>h.action.includes('重複')),'件数 '+a1.length);
// T14 仮受付
const tent=booth(t).find(e=>e.kind==='tentative');
check('T14','仮受付の予定がブース2に第一希望で入る（件名・第二希望つき）',tent&&tent.start===D9+'T10:00'&&tent.end===D9+'T11:30'&&tent.title.startsWith('【仮受付】')&&tent.note.includes('14:00'));
// T15 受付メール
check('T15','受付のお知らせ・店舗通知が記録される',a1[0].mails.some(m=>m.type==='受付のお知らせ')&&a1[0].mails.some(m=>m.type.includes('店舗')));
// T13 保存（再読み込み）
t=load(DEMO,{storage:t.storage()});await sleep(80);t.$('tabAdm').click();
check('T13','再読み込み後も申込が残る',t.$('appList').textContent.includes(no1));
// T22 XSS
const det=t.$('detail');
check('T22','コメントのHTMLは文字として表示され実行されない',det.textContent.includes('<img src=x')&&!det.querySelector('img')&&t.w.__x===undefined);
// T17 空きなし表示（第一希望が例の予定10:00-11:00と重なる）
const picks=[...t.d.querySelectorAll('.pick')].map(p=>p.textContent);
check('T17a','重なる候補は「空きなし」、空いている候補が初期選択',picks[0].includes('空きなし')&&picks[1].includes('空きあり')&&t.d.querySelector('input[name=pick]:checked').value==='1');
// T27 確定連打 → T16 確定
btn(t,'#detail','この日時で確定する').click();btn(t,'#detail','この日時で確定する')?.click();await sleep(250);
let a=apps(t)[0];
check('T16','確定でステータス・ブース2・確定メールが更新',a.status==='confirmed'&&a.confirmed_start===D10+'T14:00'&&booth(t).find(e=>e.appId===a.id).kind==='confirmed'&&a.mails.some(m=>m.type==='予約確定のお知らせ'));
check('T27','確定ボタン連打でも確定は1回',a.history.filter(h=>h.action.startsWith('予約を確定')).length===1&&a.mails.filter(m=>m.type==='予約確定のお知らせ').length===1);
// T17b 重なる日時へ変更 → 中止
async function resched(dt,tm){btn(t,'#detail','日時を変更する').click();await sleep(20);t.$('rsD').value=dt;t.$('rsT').value=tm;btn(t,'.sheet','この日時で確定する').click();await sleep(250)}
await resched(D9,'10:00');
a=apps(t)[0];
const sheetTxt=(t.d.querySelector('.sheet')||{}).textContent||'';
check('T17b','既存予定と重なる日時は確定を中止し、重なる予定を表示',sheetTxt.includes('確定できませんでした')&&sheetTxt.includes('（例）')&&a.confirmed_start===D10+'T14:00'&&a.mails.length===3);
btn(t,'.sheet','別の日時を選び直す').click();
// T18 準備時間（例の予定 10:00-11:00 の直後）
await resched(D9,'11:00');const b11=((t.d.querySelector('.sheet')||{}).textContent||'').includes('確定できませんでした');if(b11)btn(t,'.sheet','別の日時を選び直す').click();
await resched(D9,'11:30');a=apps(t)[0];
check('T18','準備時間15分：11:00開始は不可、11:30開始は可',b11&&a.confirmed_start===D9+'T11:30');
// T20 日時変更
check('T20','日時変更で予定が移動し、変更のお知らせが記録',booth(t).find(e=>e.appId===a.id).start===D9+'T11:30'&&a.mails.some(m=>m.type==='日時変更のお知らせ'));
// T19 同時1件（2人目が同じ時間）
t.$('tabCust').click();await apply(t,{name:'二人目 太郎',kana:'フタリメ タロウ',email:'two@example.com',d1:D9,t1:'11:30'});await sleep(250);
t.$('tabAdm').click();const two=apps(t).find(x=>x.email==='two@example.com');
t.$('q').value='二人目';t.$('q').dispatchEvent(new t.w.Event('input'));
[...t.d.querySelectorAll('#appList .card')][0].click();await sleep(20);
const p2=t.d.querySelector('.pick').textContent;
await (async()=>{btn(t,'#detail','候補以外の日時で確定する').click();await sleep(20);t.$('rsD').value=D9;t.$('rsT').value='11:30';btn(t,'.sheet','この日時で確定する').click();await sleep(250)})();
check('T19','確定済みの体験と同じ時間は2件目を確定できない',p2.includes('空きなし')&&((t.d.querySelector('.sheet')||{}).textContent||'').includes('確定できませんでした')&&apps(t).find(x=>x.id===two.id).status==='new');
btn(t,'.sheet','別の日時を選び直す')?.click();
// T29 過去日時
btn(t,'#detail','候補以外の日時で確定する').click();await sleep(20);t.$('rsD').value=jstToday(-1);t.$('rsT').value='10:00';btn(t,'.sheet','この日時で確定する').click();await sleep(100);
check('T29','過去の日時は確定できない',t.$('toastRoot').textContent.includes('過去')&&apps(t).find(x=>x.id===two.id).status==='new');
// T21 キャンセル（通知なし）
btn(t,'#detail','この申込をキャンセルにする').click();await sleep(10);t.$('cxMail').checked=false;btn(t,'#detail','キャンセルにする').click();await sleep(150);
const c2=apps(t).find(x=>x.id===two.id);
// キャンセル（通知あり）：1人目
t.$('q').value='';t.$('q').dispatchEvent(new t.w.Event('input'));
[...t.d.querySelectorAll('#filters button')].find(b=>b.textContent.startsWith('確定')).click();
[...t.d.querySelectorAll('#appList .card')][0].click();await sleep(10);
btn(t,'#detail','この申込をキャンセルにする').click();await sleep(10);btn(t,'#detail','キャンセルにする').click();await sleep(150);
const c1=apps(t).find(x=>x.id===a.id);
check('T21','キャンセルで予定削除・状態変更、通知は選んだ時だけ',c2.status==='cancelled'&&!c2.mails.some(m=>m.type.includes('キャンセル'))&&c1.status==='cancelled'&&c1.mails.some(m=>m.type.includes('キャンセル'))&&!booth(t).some(e=>e.appId===a.id||e.appId===two.id));
// T30 見本データに戻す
t.$('resetDemo').click();await sleep(100);
check('T30','「見本データに戻す」で申込が消え、例の予定4件に戻る',apps(t).length===0&&booth(t).length===4);
// T28 申込元
t=load(DEMO,{url:'https://example.test/glitter-demo/?from=hp'});await sleep(80);await apply(t,{d1:D20,t1:'15:00'});await sleep(200);
const s1=apps(t)[0]?.source;
t=load(DEMO,{url:'https://example.test/glitter-demo/?from=line'});await sleep(80);await apply(t,{d1:D20,t1:'15:00'});await sleep(200);
const s2=apps(t)[0]?.source;
t=load(DEMO,{url:'https://example.test/glitter-demo/?from=evil'});await sleep(80);await apply(t,{d1:D20,t1:'15:00'});await sleep(200);
check('T28','申込元：hp→ホームページ、line→LINE公式、不明な値→直接',s1==='ホームページ'&&s2==='LINE公式'&&apps(t)[0]?.source==='直接',[s1,s2,apps(t)[0]?.source].join('/'));
// T31 料金表示
check('T31','料金欄が「通常 5,000円」取り消し線＋「無料」',t.d.querySelector('.fact s')?.textContent==='5,000円'&&t.d.querySelectorAll('.fact b')[1].textContent==='無料');

// ===== 試作版（共有データの代役）：TRIAL=試作版HTMLのパス を指定した時だけ =====
if(TRIAL){
const store={};const subs=new Set();let fail={};const reads=[];
const clone=o=>JSON.parse(JSON.stringify(o));
function makeDb(){
  const snapOf=p=>({id:p.split('/').pop(),exists:p in store,data:()=>p in store?clone(store[p]):undefined});
  const inColl=(c,p)=>p.startsWith(c+'/')&&!p.slice(c.length+1).includes('/');
  const qs=(c,w)=>{const l=Object.keys(store).filter(p=>inColl(c,p)&&(!w||store[p][w.f]===w.v)).sort().map(snapOf);return{docs:l,size:l.length,empty:!l.length}};
  const emit=()=>setTimeout(()=>subs.forEach(s=>s.cb(qs(s.c,s.w))),0);
  const maybeFail=(op,p)=>{for(const k in fail){if(p.startsWith(k)&&fail[k][op]>0){fail[k][op]--;throw{code:'unavailable',message:'test'}}}};
  const doc=p=>({get:async()=>{reads.push(p);return snapOf(p)},set:async d=>{maybeFail('set',p);store[p]=clone(d);emit()},
    update:async d=>{maybeFail('update',p);if(!(p in store))throw{code:'invalid_argument'};store[p]={...store[p],...clone(d)};emit()},
    delete:async()=>{delete store[p];emit()},acquire:async()=>({acquired:true})});
  const collection=c=>({doc:id=>doc(c+'/'+id),get:async()=>{reads.push(c);return qs(c,null)},
    onSnapshot:(cb)=>{reads.push(c);const s={c,cb};subs.add(s);setTimeout(()=>cb(qs(c,null)),0);return()=>subs.delete(s)},
    where:(f,op,v)=>({onSnapshot:cb=>{reads.push(c);const s={c,w:{f,v},cb};subs.add(s);setTimeout(()=>cb(qs(c,{f,v})),0);return()=>subs.delete(s)}})});
  return{doc,collection};
}
const stub=(id,editor)=>w=>({use:async n=>n==='db'?makeDb():n==='user'?{id:async()=>id,canEdit:async()=>editor}:null});
// T25 権限
const cust=load(TRIAL,{claude:stub('u_cust',false)});await sleep(120);
check('T25','編集権限のない人には管理画面が出ず、管理データも読まない',cust.$('tabAdm').hidden&&cust.$('admView').hidden&&!reads.some(r=>r.startsWith('applications')||r.startsWith('booth2')));
// T23 保存の失敗 → 入力保持 → 再送で成功
fail={'apps/':{set:2}};
fill(cust,{d1:D10,t1:'16:00'});submit(cust);await sleep(5);cust.$('sendBtn').click();await sleep(2000);
const errShown=!cust.$('sendErr').hidden&&!cust.$('confirm').hidden;
cust.$('sendBtn').click();await sleep(300);
check('T23','保存に失敗したら案内を出して入力を残し、もう一度押せば送れる',errShown&&!cust.$('done').hidden&&Object.keys(store).filter(k=>k.startsWith('apps/')).length===1);
// T24 仮受付の失敗 → 次の処理で回復
fail={'booth2/':{set:1}};
const adm=load(TRIAL,{claude:stub('u_admin',true)});await sleep(400);
const afterFail=Object.keys(store).filter(k=>k.startsWith('applications/')).length;
adm.$('tabAdm').click();
store['inbox/__poke']={processed:true};subs.forEach(s=>s.c==='inbox'&&s.cb({docs:Object.keys(store).filter(k=>k.startsWith('inbox/')&&!store[k].processed).map(k=>({data:()=>store[k]})),size:0,empty:false}));await sleep(300);
const afterRetry=Object.keys(store).filter(k=>k.startsWith('applications/')).length;
check('T24','カレンダー登録に失敗しても申込は失われず、次の処理で登録される',afterFail===0&&afterRetry===1&&Object.keys(store).some(k=>k.startsWith('booth2/t-'))&&Object.values(store).filter(v=>v.appId&&v.processed===false).length===0,'失敗直後 '+afterFail+'件 → 再処理後 '+afterRetry+'件');

}
// ===== 結果 =====
const pass=results.filter(r=>r.ok).length;
for(const r of results)console.log((r.ok?'OK  ':'NG  ')+r.id+' '+r.name+(r.detail?'（'+r.detail+'）':''));
console.log(`\n${pass}/${results.length} 合格`);
fs.writeFileSync('/tmp/claude-0/-home-claude/eb44dd6d-75d9-5ee8-883c-4779de4af7cb/scratchpad/results.json',JSON.stringify(results,null,1));
process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
