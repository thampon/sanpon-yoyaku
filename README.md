# さんぽんパーソナル 予約ページ

お客さま用の予約画面（GitHub Pages）。データと処理は Google Apps Script 側にあります。

## ファイル
| 場所 | 中身 |
|---|---|
| `index.html` | お客さん用の画面（公開） |
| `admin.html` | 管理画面（公開。URLの鍵がないと何も表示されない） |
| `src/Booking.html` | お客さん用画面の元ファイル（Apps Scriptの Booking.html と同じ内容） |
| `gas/` | Apps Script のサーバー処理の控え（Code.gs・Admin.html・appsscript.json） |
| `build-public.js` | 元ファイル → 公開用ファイルへの変換 |

## 画面を直すとき
1. `src/Booking.html`（または `gas/Admin.html`）を直す
2. `node build-public.js` で `index.html` / `admin.html` を作り直す（`--check` で一致確認だけもできる）
3. GitHub に反映（1〜2分で公開）
4. Apps Script 側の Booking.html / Admin.html も同じ内容にする

## サーバー処理を直すとき
1. Apps Script で編集・保存 →「デプロイを管理」→ 編集 →「新バージョン」でデプロイ（URLは変わらない）
2. 同じ内容を `gas/` にも反映してコミットする（ここが変更履歴になる）

## 注意
- このリポジトリは公開。Slackトークン・Webhook URL・管理用トークン・顧客情報は絶対に入れない（値はApps Scriptのスクリプトプロパティとスプレッドシートにある）。
- `gas/Code.gs` の初期データにあるGlitteR共有カレンダーIDは伏せてある。本番の値はスプレッドシート「ジム」シートにある。
- `gas/` は2026-10-19時点（デプロイv30）の控えから作成。本番のApps Scriptと一致しているかは未照合。
