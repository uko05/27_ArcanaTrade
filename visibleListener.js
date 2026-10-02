// visibleListener.js
// タブが裏に回っている間はFirestoreのリアルタイム購読(onSnapshot)を止め、表に戻ったら
// 再開する(2026-09-27追加、読み取り課金の削減)。見ていないタブが他人の投稿・いいねを
// 受信し続けると、そのたびに1件ずつ読み取りが課金されるため。
// 再開時の読み取りは、firebaseConfig.jsの永続キャッシュ(resume token)により
// 「止めていた間に変わったドキュメントだけ」で済む(停止が30分を超えた場合は全件読み直し)。
// ちょっと別タブを見ただけで購読を張り直さないよう、裏に回ってから少し待ってから止める。
const HIDDEN_GRACE_MS = 60 * 1000;

const subs = new Set();
let paused = false;
let pauseTimer = null;

function pauseAll() {
  pauseTimer = null;
  paused = true;
  subs.forEach((sub) => {
    if (sub.unsub) { sub.unsub(); sub.unsub = null; }
  });
}

function resumeAll() {
  if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
  if (!paused) return;
  paused = false;
  subs.forEach((sub) => {
    if (!sub.unsub) sub.unsub = sub.start();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (!pauseTimer && !paused) pauseTimer = setTimeout(pauseAll, HIDDEN_GRACE_MS);
  } else {
    resumeAll();
  }
});

// 裏タブで開かれた場合も、一度は購読して初期表示を作ってから猶予後に止める
if (document.visibilityState === 'hidden') pauseTimer = setTimeout(pauseAll, HIDDEN_GRACE_MS);

// start: onSnapshot()を張ってそのunsubscribe関数を返す関数。再開のたびに呼び直されるので、
// 「今から48時間前」のような購読条件はstartの中で計算すること。
export function listenWhileVisible(start) {
  const sub = { start, unsub: paused ? null : start() };
  subs.add(sub);
  return () => {
    if (sub.unsub) sub.unsub();
    subs.delete(sub);
  };
}
