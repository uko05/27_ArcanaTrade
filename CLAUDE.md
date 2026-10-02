# 原神アルカナ交換所（27_ArcanaTrade） — 開発メモ

静的サイト（ビルドなし、ESモジュール直読み）。デザインは 25_FriendBoard の styles.css をそのまま使い、
末尾に「27_ArcanaTrade 専用」の追記をしている。

## 仕組み
- 幻想シアターのアルカナ22枚(大アルカナ)の被りを、同じサーバーの人と1枚ずつ交換する相手を探す。
- 登録・申請はアカウント登録(24_AccountCenter のログイン)必須。さがす一覧は未登録でも見られる。
- どのカードも1枚は手元に残す。出せる枚数 = 所持数 - 1 - 交換予定(reservedOut)。
- Firestore のルールと Cloud Functions は 24_AccountCenter リポジトリにある
  （firestore.rules の「27_ArcanaTrade」節、functions/arcanaTrade.js）。
- 承認・交換完了・取り消しは Cloud Functions（arcanaApprove / arcanaComplete / arcanaCancel）だけが行う。
  同じカードへの申請が重なっても出せる枚数を超えないよう、トランザクションで確かめる。
  承認時に、出せる枚数がなくなったカードの申請と、同じカードをもう手に入れた人のほかの申請を自動で取り下げる。
- arcanaTradeSweep（1時間ごと）: 承認から3日で自動的に交換完了、7日承認されない申請は取り下げ。
- 定数（3日・7日・チャット5回・カードid）は app.js / arcana.js と functions/arcanaTrade.js の両方にある。変えるときは両方そろえる。

## 運用
- 修正するたびに index.html の #site-version と styles.css?v= / app.js?v= を上げる。
- 大きめの修正（データの持ち方を変えたなど）の時だけ version.json と uko-reload-version を同じだけ上げる。
