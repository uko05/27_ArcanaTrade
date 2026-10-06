// app.js
// 原神アルカナ交換所。画面の流れ:
//   マイアルカナ(所持枚数・サーバー・UIDを登録) → さがす(同じサーバーで自分が持っていないカードを
//   出せる人) → 交換申請(1枚と1枚) → 相手が承認するとお互いのUIDが見える → 交換完了で枚数を更新。
//
// データ(Firestore、ルールは 24_AccountCenter/firestore.rules):
//   arcanaTradeProfiles/{userId}  公開。counts(所持枚数), reservedOut(承認済み・未完了で出す予定の枚数。
//                                 サーバーだけが書く), spare(交換に出せるカードid。検索用)
//   arcanaTradePrivate/{userId}   本人だけ。genshinUid
//   arcanaTradeRequests/{id}      申請。当事者だけが読める。承認・完了・取り消しは
//                                 Cloud Functions(arcanaApprove / arcanaComplete / arcanaCancel)が行う
//                                 (同じカードへの申請が重なっても枚数がおかしくならないよう、サーバー側で確かめるため)

import { db, functions } from './firebaseConfig.js';
import { getUserId, isLoggedIn, waitForAccount } from './userData.js';
import { listenWhileVisible } from './visibleListener.js';
import { ARCANA, ARCANA_IDS, ARCANA_BY_ID, tradeableCount, computeSpare } from './arcana.js';
import {
  doc, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit, serverTimestamp, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getDoc, getDocs, onSnapshot } from './fsTracked.js'; // 読み取り件数の集計(調査用、fsTracked.js参照)
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const SERVER_LABEL = { asia: 'Asia', america: 'America', europe: 'Europe', sar: 'TW,HK,MO' };
const STALE_MS = 30 * 24 * 60 * 60 * 1000;   // 30日更新のない人は「さがす」に出さない
const AUTO_COMPLETE_DAYS = 3;                // 承認から3日で自動的に交換完了(arcanaTrade.jsと同じ値)
const CHAT_MAX_PER_PERSON = 5;               // 1件の交換で1人が送れるチャットの数
const CHAT_MAX_LEN = 200;

const callApprove = httpsCallable(functions, 'arcanaApprove');
const callComplete = httpsCallable(functions, 'arcanaComplete');
const callCancel = httpsCallable(functions, 'arcanaCancel');

// ===== 状態 =====
let myId = null;
let myProfile = null;        // Firestore上の自分のプロフィール(未保存なら null)
let editCounts = {};         // 編集中の所持枚数
let receivedReqs = [];       // 自分が受けた申請(ownerId == 自分)
let sentReqs = [];           // 自分が出した申請(applicantId == 自分)
let currentSubtab = 'active';
let applyTarget = null;      // 申請ポップで選んでいる相手のプロフィール
let applyGet = null;
let applyGive = null;

// ===== 小物 =====
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts === 'number') return ts;
  return 0;
}
function timeAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}
function cardChip(id, extraClass = '') {
  const a = ARCANA_BY_ID[id];
  if (!a) return '';
  return `<span class="arcana-chip ${extraClass}"><img src="${a.img}" alt="" loading="lazy"><span>${esc(a.number)} ${esc(a.name)}</span></span>`;
}
function showToast(text) {
  const el = document.createElement('div');
  el.className = 'app-toast app-toast-show';
  el.innerHTML = `<span class="app-toast-text">${esc(text)}</span>`;
  document.body.appendChild(el);
  setTimeout(() => { el.classList.replace('app-toast-show', 'app-toast-hide'); setTimeout(() => el.remove(), 400); }, 2600);
}
function callErrorMessage(e) {
  const m = e?.details?.reason || e?.message || '';
  const map = {
    noSpareOwner: '相手の出せる枚数がなくなりました（ほかの人との交換が先に決まりました）。',
    noSpareApplicant: 'あなたの出せる枚数がなくなりました（ほかの交換が先に決まりました）。',
    notPending: 'この申請はすでに処理されています。',
    notParticipant: 'この交換の当事者ではありません。',
    notLoggedIn: 'ログインが必要です。',
    alreadyDone: 'すでに交換完了にしています。',
    cannotCancel: 'どちらかが交換完了を押したあとは、取り消せません。',
  };
  return map[m] || '処理に失敗しました。時間をおいてもう一度お試しください。';
}

// ===== タブ =====
function switchTab(tab) {
  document.querySelectorAll('.board-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ['mine', 'search', 'trades'].forEach((t) => $(`tab-panel-${t}`).classList.toggle('hidden', t !== tab));
  if (tab === 'search') loadSearch();
  if (tab === 'trades') renderTrades();
}
document.querySelectorAll('.board-tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
document.querySelectorAll('.board-subtab-btn').forEach((b) => b.addEventListener('click', () => {
  currentSubtab = b.dataset.subtab;
  document.querySelectorAll('.board-subtab-btn').forEach((x) => x.classList.toggle('active', x === b));
  renderTrades();
}));

// ===== マイアルカナ =====
function renderMineGrid() {
  const grid = $('mine-grid');
  const reserved = myProfile?.reservedOut || {};
  const allowLast = $('input-allow-last').checked;
  grid.innerHTML = '';
  ARCANA.forEach((a) => {
    const n = editCounts[a.id] || 0;
    const r = reserved[a.id] || 0;
    const canGive = tradeableCount(editCounts, reserved, a.id, allowLast);
    const cell = document.createElement('div');
    cell.className = 'arcana-cell' + (n === 0 ? ' arcana-cell-none' : '') + (canGive >= 1 ? ' arcana-cell-spare' : '');
    cell.innerHTML = `
      <button type="button" class="arcana-cell-card" aria-label="${esc(a.name)}を1枚増やす">
        <img src="${a.img}" alt="${esc(a.name)}" loading="lazy">
        <span class="arcana-cell-count">×${n}</span>
      </button>
      <span class="arcana-cell-name">${esc(a.number)} ${esc(a.name)}</span>
      <span class="arcana-cell-controls">
        <button type="button" class="arcana-minus" aria-label="1枚減らす">−</button>
        <span class="arcana-cell-give">${canGive >= 1 ? `出せる${canGive}` : (n === 0 ? '未所持' : '　')}</span>
      </span>
      ${r ? `<span class="arcana-cell-reserved">交換予定 ${r}</span>` : ''}`;
    cell.querySelector('.arcana-cell-card').addEventListener('click', () => {
      editCounts[a.id] = Math.min(99, n + 1);
      renderMineGrid();
    });
    cell.querySelector('.arcana-minus').addEventListener('click', () => {
      // 交換予定の分(+残す1枚)より少なくはできない
      const min = r > 0 ? r + (allowLast ? 0 : 1) : 0;
      editCounts[a.id] = Math.max(min, n - 1);
      renderMineGrid();
    });
    grid.appendChild(cell);
  });
  const owned = ARCANA_IDS.filter((id) => (editCounts[id] || 0) > 0).length;
  const spare = computeSpare(editCounts, reserved, allowLast).length;
  $('mine-summary').textContent = `持っている: ${owned} / 22種類　｜　交換に出せる: ${spare}種類　｜　持っていない: ${22 - owned}種類`;
}

async function loadMine() {
  editCounts = {};
  myProfile = null;
  if (!isLoggedIn()) {
    $('login-notice').classList.remove('hidden');
    $('mine-form').classList.add('arcana-disabled');
    renderMineGrid();
    return;
  }
  $('login-notice').classList.add('hidden');
  $('mine-form').classList.remove('arcana-disabled');
  try {
    const [pSnap, privSnap] = await Promise.all([
      getDoc(doc(db, 'arcanaTradeProfiles', myId)),
      getDoc(doc(db, 'arcanaTradePrivate', myId)),
    ]);
    if (pSnap.exists()) {
      myProfile = pSnap.data();
      editCounts = { ...(myProfile.counts || {}) };
      $('input-name').value = myProfile.displayName || '';
      $('input-server').value = myProfile.server || 'asia';
      $('input-allow-last').checked = !!myProfile.allowLastCopy;
    }
    if (privSnap.exists()) $('input-uid').value = privSnap.data().genshinUid || '';
    // まだ登録していない人は、フレンド承認板(25_FriendBoard)のプロフィールから名前・UID・サーバーを
    // 最初から入れておく(同じ共有IDなので、承認板に登録済みならそのまま使える)。保存するまでは反映されない
    if (!pSnap.exists()) await prefillFromFriendBoard(!privSnap.exists());
  } catch (e) {
    console.error('[mine] load failed', e);
  }
  renderMineGrid();
  // 承認・完了で reservedOut / counts がサーバー側で変わるので、自分のプロフィールだけ購読しておく
  listenWhileVisible(() => onSnapshot(doc(db, 'arcanaTradeProfiles', myId), (snap) => {
    if (!snap.exists()) return;
    const prev = myProfile;
    myProfile = snap.data();
    // サーバー側で枚数が変わった時(交換完了など)は編集中の枚数にも反映する
    if (!prev || JSON.stringify(prev.counts) !== JSON.stringify(myProfile.counts)) editCounts = { ...(myProfile.counts || {}) };
    renderMineGrid();
  }));
}

async function prefillFromFriendBoard(fillUid) {
  try {
    const snap = await getDoc(doc(db, 'friendBoardProfiles', myId));
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.displayName && !$('input-name').value) $('input-name').value = String(d.displayName).slice(0, 20);
    if (fillUid && d.genshinUid && !$('input-uid').value) $('input-uid').value = String(d.genshinUid).slice(0, 12);
    if (d.server && ['asia', 'america', 'europe', 'sar'].includes(d.server)) $('input-server').value = d.server;
    const msg = $('mine-msg');
    msg.className = 'board-form-msg';
    msg.textContent = 'フレンド承認板のプロフィールから、名前・UID・サーバーを入れておきました。確認して保存してください。';
  } catch (e) {
    console.warn('[mine] friend board prefill failed', e);
  }
}

$('mine-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('mine-msg');
  msg.className = 'board-form-msg';
  if (!isLoggedIn()) { msg.textContent = 'アカウント登録・ログインが必要です。'; return; }
  const name = $('input-name').value.trim();
  const uid = $('input-uid').value.trim();
  const server = $('input-server').value;
  if (!name) { msg.textContent = '名前を入力してください。'; return; }
  if (!/^\d{9,10}$/.test(uid)) { msg.textContent = '原神UIDは9〜10桁の数字で入力してください。'; return; }
  if (myProfile && myProfile.server && myProfile.server !== server && hasOpenTrades()) {
    msg.textContent = '申請中・取引中の交換があるあいだは、サーバーを変えられません。';
    return;
  }
  const counts = {};
  ARCANA_IDS.forEach((id) => { if (editCounts[id] > 0) counts[id] = editCounts[id]; });
  const reserved = myProfile?.reservedOut || {};
  const allowLastCopy = $('input-allow-last').checked;
  setSaveButtonsDisabled(true);
  try {
    await setDoc(doc(db, 'arcanaTradePrivate', myId), { genshinUid: uid, updatedAt: serverTimestamp() });
    const data = {
      userId: myId, displayName: name, server, counts, allowLastCopy,
      spare: computeSpare(counts, reserved, allowLastCopy),
      updatedAt: serverTimestamp(), lastActiveAt: serverTimestamp(),
    };
    // reservedOut はサーバー(Cloud Functions)だけが書くので、ここでは送らない(初回は空で作る)
    if (!myProfile) data.reservedOut = {};
    await setDoc(doc(db, 'arcanaTradeProfiles', myId), data, { merge: true });
    msg.textContent = '保存しました。「さがす」で交換相手を探せます。';
    msg.classList.add('ok');
  } catch (e) {
    console.error('[mine] save failed', e);
    msg.textContent = '保存に失敗しました。時間をおいてもう一度お試しください。';
  } finally {
    setSaveButtonsDisabled(false);
  }
});

// 保存ボタンは2つ(カード一覧の上と下)。どちらもフォームの送信ボタン
function setSaveButtonsDisabled(v) {
  $('mine-save-btn').disabled = v;
  $('mine-save-btn-top').disabled = v;
}
// チェックを切り替えたら、出せる枚数の表示をすぐ更新する(保存は保存ボタンで)
$('input-allow-last').addEventListener('change', renderMineGrid);

function hasOpenTrades() {
  return [...receivedReqs, ...sentReqs].some((r) => r.status === 'pending' || r.status === 'approved');
}

// ===== さがす =====
let searchLoading = false;
async function loadSearch() {
  if (searchLoading) return;
  const list = $('search-list');
  const desc = $('search-desc');
  const ready = isLoggedIn() && myProfile;
  // 交換できるのは同じサーバーの人だけなので、サーバーは自分の登録から決める(選ぶ欄は置かない)。
  // まだ登録していない人には、全サーバーの人をサーバー名付きで見せる
  const server = ready ? myProfile.server : null;

  let q;
  let missing = [];
  if (ready) {
    missing = ARCANA_IDS.filter((id) => !((myProfile.counts || {})[id] > 0));
    if (missing.length === 0) {
      desc.textContent = '';
      list.innerHTML = '<p class="board-list-empty">22種類すべて持っています！</p>';
      return;
    }
    desc.textContent = `${SERVER_LABEL[server]}サーバーで、あなたが持っていないカードを出せる人を表示しています。`;
    q = query(collection(db, 'arcanaTradeProfiles'),
      where('server', '==', server), where('spare', 'array-contains-any', missing),
      orderBy('lastActiveAt', 'desc'), limit(60));
  } else {
    desc.textContent = isLoggedIn()
      ? 'マイアルカナを保存すると、同じサーバーであなたが持っていないカードを出せる人だけに絞り込めます（今は全サーバー表示）。'
      : '交換に出せるカードがある人を表示しています（全サーバー）。申請するにはアカウント登録とマイアルカナの保存が必要です。';
    q = query(collection(db, 'arcanaTradeProfiles'), orderBy('lastActiveAt', 'desc'), limit(60));
  }

  searchLoading = true;
  list.innerHTML = '<p class="board-list-empty">読み込み中…</p>';
  try {
    const snap = await getDocs(q);
    const now = Date.now();
    const people = snap.docs.map((d) => d.data())
      .filter((p) => p.userId !== myId)
      .filter((p) => (p.spare || []).length > 0)
      .filter((p) => now - toMs(p.lastActiveAt) < STALE_MS);
    renderSearch(people, missing);
  } catch (e) {
    console.error('[search] load failed', e);
    list.innerHTML = '<p class="board-list-empty">読み込みに失敗しました。</p>';
  } finally {
    searchLoading = false;
  }
}
$('search-refresh-btn').addEventListener('click', loadSearch);

function renderSearch(people, missing) {
  const list = $('search-list');
  const ready = isLoggedIn() && myProfile;
  if (people.length === 0) {
    list.innerHTML = '<p class="board-list-empty">今は該当する人がいません。</p>';
    return;
  }
  const mySpare = ready ? computeSpare(myProfile.counts, myProfile.reservedOut, !!myProfile.allowLastCopy) : [];
  // お互いにうれしい相手(相手が持っていないカードを自分が出せる)を上に並べる
  const scored = people.map((p) => {
    const canGet = ready ? (p.spare || []).filter((id) => missing.includes(id)) : (p.spare || []);
    const theyLack = ARCANA_IDS.filter((id) => !((p.counts || {})[id] > 0));
    const canGive = mySpare.filter((id) => theyLack.includes(id));
    // もらえるカードを2枚以上(本当の被りとして)持っている人を上に。
    // 「1枚所持も交換候補に出す」で最後の1枚を出している人は、その次に並べる
    const dup = canGet.some((id) => ((p.counts || {})[id] || 0) >= 2);
    return { p, canGet, canGive, mutual: canGive.length > 0, dup };
  }).sort((a, b) => (b.dup - a.dup) || (b.mutual - a.mutual));

  list.innerHTML = '';
  scored.forEach(({ p, canGet, canGive, mutual }) => {
    const card = document.createElement('div');
    card.className = 'board-card arcana-person';
    const already = sentReqs.some((r) => r.ownerId === p.userId && (r.status === 'pending' || r.status === 'approved'));
    card.innerHTML = `
      <div class="board-card-body">
        <div class="board-card-head">
          <strong class="arcana-person-name">${esc(p.displayName || '名無し')}</strong>
          <span class="board-card-time">${ready ? '' : `${esc(SERVER_LABEL[p.server] || '')}サーバー・`}${timeAgo(toMs(p.lastActiveAt))}に更新</span>
        </div>
        ${mutual ? '<span class="arcana-mutual">お互いにうれしい交換ができそう！</span>' : ''}
        <p class="arcana-person-label">${ready ? 'もらえるカード（あなたが持っていないもの）' : '交換に出せるカード'}</p>
        <div class="arcana-chips">${canGet.map((id) => cardChip(id, 'arcana-chip-get')).join('')}</div>
        ${ready && canGive.length ? `<p class="arcana-person-label">相手が持っていない、あなたの出せるカード</p>
        <div class="arcana-chips">${canGive.map((id) => cardChip(id, 'arcana-chip-give')).join('')}</div>` : ''}
        <div class="board-card-foot arcana-person-foot"></div>
      </div>`;
    const foot = card.querySelector('.arcana-person-foot');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'board-card-apply-btn';
    if (!isLoggedIn()) { btn.textContent = '申請にはアカウント登録が必要です'; btn.disabled = true; }
    else if (!myProfile) { btn.textContent = 'マイアルカナを保存すると申請できます'; btn.disabled = true; }
    else if (mySpare.length === 0) { btn.textContent = '出せるカード（2枚以上）がありません'; btn.disabled = true; }
    else if (already) { btn.textContent = 'この人には申請中・取引中です'; btn.disabled = true; }
    else { btn.textContent = '交換申請する'; btn.addEventListener('click', () => openApply(p, canGet, mySpare)); }
    foot.appendChild(btn);
    list.appendChild(card);
  });
}

// ===== 交換申請ポップ =====
function openApply(target, canGet, mySpare) {
  applyTarget = target;
  applyGet = null;
  applyGive = null;
  $('apply-to').textContent = `${target.displayName || '名無し'} さんに申請します`;
  $('apply-message').value = '';
  $('apply-msg').textContent = '';
  // 相手が持っていないカードを優先して並べる(相手にとってもうれしい交換になりやすい)
  const theyLack = new Set(ARCANA_IDS.filter((id) => !((target.counts || {})[id] > 0)));
  const giveList = [...mySpare].sort((a, b) => theyLack.has(b) - theyLack.has(a));
  renderPick('apply-get', canGet, () => applyGet, (id) => { applyGet = id; });
  renderPick('apply-give', giveList, () => applyGive, (id) => { applyGive = id; }, theyLack);
  $('apply-modal').classList.remove('hidden');
}
function renderPick(elId, ids, getSel, setSel, highlight = null) {
  const el = $(elId);
  el.innerHTML = '';
  ids.forEach((id) => {
    const a = ARCANA_BY_ID[id];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'arcana-pick' + (getSel() === id ? ' selected' : '') + (highlight && highlight.has(id) ? ' arcana-pick-wanted' : '');
    b.innerHTML = `<img src="${a.img}" alt="" loading="lazy"><span>${esc(a.number)} ${esc(a.name)}</span>${highlight && highlight.has(id) ? '<em>相手が未所持</em>' : ''}`;
    b.addEventListener('click', () => { setSel(id); renderPick(elId, ids, getSel, setSel, highlight); });
    el.appendChild(b);
  });
}
function closeApply() { $('apply-modal').classList.add('hidden'); applyTarget = null; }
$('apply-close').addEventListener('click', closeApply);
document.querySelector('#apply-modal .arcana-modal-backdrop').addEventListener('click', closeApply);

$('apply-send').addEventListener('click', async () => {
  const msg = $('apply-msg');
  if (!applyTarget) return;
  if (!applyGet || !applyGive) { msg.textContent = 'もらうカードと出すカードを1枚ずつ選んでください。'; return; }
  if (applyGet === applyGive) { msg.textContent = '同じカード同士は交換できません。'; return; }
  const dup = sentReqs.some((r) => r.ownerId === applyTarget.userId && r.getCard === applyGet && r.status === 'pending');
  if (dup) { msg.textContent = 'この人には同じカードで申請中です。'; return; }
  $('apply-send').disabled = true;
  try {
    await addDoc(collection(db, 'arcanaTradeRequests'), {
      ownerId: applyTarget.userId,
      ownerName: applyTarget.displayName || '',
      applicantId: myId,
      applicantName: myProfile.displayName || '',
      server: myProfile.server,
      getCard: applyGet,     // 申請者がもらう(=相手が出す)カード
      giveCard: applyGive,   // 申請者が出す(=相手がもらう)カード
      message: $('apply-message').value.trim().slice(0, 100),
      status: 'pending',
      createdAt: serverTimestamp(),
      ownerSeen: false,
      applicantSeen: true,
      chatMessages: [],
    });
    await updateDoc(doc(db, 'arcanaTradeProfiles', myId), { lastActiveAt: serverTimestamp() }).catch(() => {});
    closeApply();
    showToast('申請しました。相手の承認を待ちましょう。');
    loadSearch();
  } catch (e) {
    console.error('[apply] failed', e);
    msg.textContent = '申請に失敗しました。時間をおいてもう一度お試しください。';
  } finally {
    $('apply-send').disabled = false;
  }
});

// ===== 交換(申請・取引) =====
function startTradeListeners() {
  listenWhileVisible(() => onSnapshot(query(collection(db, 'arcanaTradeRequests'), where('ownerId', '==', myId)), (snap) => {
    receivedReqs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    onTradesChanged();
  }, (e) => console.error('[trades] received listen failed', e)));
  listenWhileVisible(() => onSnapshot(query(collection(db, 'arcanaTradeRequests'), where('applicantId', '==', myId)), (snap) => {
    sentReqs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    onTradesChanged();
  }, (e) => console.error('[trades] sent listen failed', e)));
}

function roleOf(r) { return r.ownerId === myId ? 'owner' : 'applicant'; }
function myDone(r) { return roleOf(r) === 'owner' ? !!r.ownerDone : !!r.applicantDone; }
function unseen(r) { return roleOf(r) === 'owner' ? r.ownerSeen === false : r.applicantSeen === false; }

function onTradesChanged() {
  const all = [...receivedReqs, ...sentReqs];
  const pendingIn = receivedReqs.filter((r) => r.status === 'pending').length;
  const activeNeedsMe = all.filter((r) => r.status === 'approved' && (!myDone(r) || unseen(r))).length;
  const total = pendingIn + activeNeedsMe;
  setBadge('trades-tab-badge', total);
  setBadge('sub-badge-received', pendingIn);
  setBadge('sub-badge-active', activeNeedsMe);
  if (!$('tab-panel-trades').classList.contains('hidden')) renderTrades();
}
function setBadge(id, n) {
  const el = $(id);
  el.textContent = n;
  el.classList.toggle('hidden', !n);
}

function renderTrades() {
  const list = $('trades-list');
  if (!isLoggedIn()) {
    list.innerHTML = '<p class="board-list-empty">交換するにはアカウント登録・ログインが必要です。</p>';
    return;
  }
  const byNew = (a, b) => toMs(b.createdAt) - toMs(a.createdAt);
  let items = [];
  if (currentSubtab === 'active') items = [...receivedReqs, ...sentReqs].filter((r) => r.status === 'approved').sort(byNew);
  if (currentSubtab === 'received') items = receivedReqs.filter((r) => r.status === 'pending').sort(byNew);
  if (currentSubtab === 'sent') items = sentReqs.filter((r) => r.status === 'pending').sort(byNew);
  if (currentSubtab === 'history') items = [...receivedReqs, ...sentReqs].filter((r) => !['pending', 'approved'].includes(r.status)).sort(byNew).slice(0, 50);

  const empty = {
    active: '取引中の交換はありません。',
    received: '届いている申請はありません。',
    sent: '承認待ちの申請はありません。',
    history: '履歴はまだありません。',
  };
  list.innerHTML = items.length ? '' : `<p class="board-list-empty">${empty[currentSubtab]}</p>`;
  items.forEach((r) => list.appendChild(renderTradeCard(r)));

  // 取引中タブを開いたら、未読チャットを既読にする
  if (currentSubtab === 'active') {
    items.filter(unseen).forEach((r) => {
      const field = roleOf(r) === 'owner' ? 'ownerSeen' : 'applicantSeen';
      updateDoc(doc(db, 'arcanaTradeRequests', r.id), { [field]: true }).catch(() => {});
    });
  }
}

const STATUS_LABEL = {
  declined: 'お断りされました', withdrawn: '取り下げ', completed: '交換完了', cancelled: '取り消し',
};
const WITHDRAW_REASON = {
  noSpare: '出せるカードがなくなったため自動で取り下げ',
  gotElsewhere: '同じカードをほかの人と交換できたため自動で取り下げ',
  expired: '7日間承認されなかったため自動で取り下げ',
  byApplicant: '申請者が取り下げ',
};

function renderTradeCard(r) {
  const role = roleOf(r);
  const otherName = role === 'owner' ? r.applicantName : r.ownerName;
  // 自分が出す / もらうカード
  const iGive = role === 'owner' ? r.getCard : r.giveCard;
  const iGet = role === 'owner' ? r.giveCard : r.getCard;
  const card = document.createElement('div');
  card.className = 'board-card arcana-trade' + (r.status === 'approved' ? ' arcana-trade-active' : '');
  let statusHtml = '';
  if (STATUS_LABEL[r.status]) {
    const reason = r.status === 'withdrawn' && WITHDRAW_REASON[r.withdrawReason] ? `（${WITHDRAW_REASON[r.withdrawReason]}）` : '';
    statusHtml = `<span class="arcana-status arcana-status-${r.status}">${STATUS_LABEL[r.status]}${reason}</span>`;
  }
  card.innerHTML = `
    <div class="board-card-body">
      <div class="board-card-head">
        <strong>${esc(otherName || '名無し')} さん</strong>
        <span class="board-card-time">${timeAgo(toMs(r.createdAt))}${role === 'owner' ? 'に届いた申請' : 'に送った申請'}</span>
      </div>
      ${statusHtml}
      <div class="arcana-trade-cards">
        <div><p class="arcana-person-label">あなたが出す</p>${cardChip(iGive, 'arcana-chip-give')}</div>
        <span class="arcana-trade-arrow">⇄</span>
        <div><p class="arcana-person-label">あなたがもらう</p>${cardChip(iGet, 'arcana-chip-get')}</div>
      </div>
      ${r.message ? `<p class="board-card-comment">「${esc(r.message)}」</p>` : ''}
      <div class="arcana-trade-extra"></div>
      <div class="board-card-foot arcana-trade-foot"></div>
    </div>`;
  const extra = card.querySelector('.arcana-trade-extra');
  const foot = card.querySelector('.arcana-trade-foot');

  if (r.status === 'pending' && role === 'owner') {
    const mineLeft = myProfile ? tradeableCount(myProfile.counts, myProfile.reservedOut, r.getCard, !!myProfile.allowLastCopy) : 0;
    const ok = button('承認する', 'board-card-apply-btn', async (b) => {
      b.disabled = true;
      try { await callApprove({ requestId: r.id }); showToast('承認しました。UIDを確認して、ゲーム内で交換してください。'); }
      catch (e) { console.error(e); alert(callErrorMessage(e)); b.disabled = false; }
    });
    if (mineLeft < 1) { ok.disabled = true; ok.textContent = '出せる枚数がありません'; }
    foot.appendChild(ok);
    foot.appendChild(button('お断りする', 'board-card-apply-msg-btn', async (b) => {
      if (!confirm('この申請をお断りしますか？')) return;
      b.disabled = true;
      await updateDoc(doc(db, 'arcanaTradeRequests', r.id), { status: 'declined', respondedAt: serverTimestamp() })
        .catch((e) => { console.error(e); alert('処理に失敗しました。'); b.disabled = false; });
    }));
  }
  if (r.status === 'pending' && role === 'applicant') {
    foot.appendChild(button('申請を取り下げる', 'board-card-apply-msg-btn', async (b) => {
      if (!confirm('この申請を取り下げますか？')) return;
      b.disabled = true;
      await deleteDoc(doc(db, 'arcanaTradeRequests', r.id)).catch((e) => { console.error(e); b.disabled = false; });
    }));
  }

  if (r.status === 'approved') {
    const otherUid = role === 'owner' ? r.revealed?.applicantUid : r.revealed?.ownerUid;
    const deadline = toMs(r.approvedAt) + AUTO_COMPLETE_DAYS * 24 * 60 * 60 * 1000;
    const daysLeft = Math.max(0, Math.ceil((deadline - Date.now()) / (24 * 60 * 60 * 1000)));
    extra.innerHTML = `
      <div class="arcana-uid-box">相手のUID: <strong>${esc(otherUid || '（取得中…）')}</strong>
        <button type="button" class="arcana-copy-btn">コピー</button></div>`;
    extra.querySelector('.arcana-copy-btn').addEventListener('click', () => {
      if (otherUid) navigator.clipboard?.writeText(otherUid).then(() => showToast('UIDをコピーしました'));
    });
    const doneBox = document.createElement('div');
    doneBox.className = 'arcana-done-box';
    if (!myDone(r)) {
      doneBox.innerHTML = `<p class="arcana-done-text">ゲーム内で交換できたら、<strong>必ず「交換完了」を押してください。</strong><br>
        登録しているカードの枚数が自動で更新されます（押さなくても、あと${daysLeft}日で自動的に完了になります）。</p>`;
      doneBox.appendChild(button('交換完了', 'arcana-done-btn', async (b) => {
        if (!confirm('ゲーム内で交換は終わりましたか？\n「交換完了」にすると、あなたのカードの枚数が更新されます。')) return;
        b.disabled = true;
        try { await callComplete({ requestId: r.id }); showToast('交換完了にしました。おつかれさまでした！'); }
        catch (e) { console.error(e); alert(callErrorMessage(e)); b.disabled = false; }
      }));
    } else {
      doneBox.innerHTML = '<p class="arcana-done-text">あなたは交換完了にしました。相手の完了を待っています（相手が押さなくても自動で完了になります）。</p>';
    }
    extra.appendChild(doneBox);
    extra.appendChild(renderChat(r));
    if (!r.ownerDone && !r.applicantDone) {
      foot.appendChild(button('この交換をやめる', 'arcana-cancel-btn', async (b) => {
        if (!confirm('この交換を取り消しますか？\n（フレンドになれなかったなど、交換できなかったときに使ってください）')) return;
        b.disabled = true;
        try { await callCancel({ requestId: r.id }); showToast('交換を取り消しました。'); }
        catch (e) { console.error(e); alert(callErrorMessage(e)); b.disabled = false; }
      }));
    }
  }
  return card;
}

function button(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', () => onClick(b));
  return b;
}

function renderChat(r) {
  const role = roleOf(r);
  const wrap = document.createElement('div');
  wrap.className = 'arcana-chat-wrap';
  const msgs = r.chatMessages || [];
  const chat = document.createElement('div');
  chat.className = 'board-chat';
  msgs.forEach((m) => {
    const me = m.from === role;
    const row = document.createElement('div');
    row.className = 'board-chat-row ' + (me ? 'board-chat-row-me' : 'board-chat-row-them');
    row.innerHTML = `<div class="board-chat-bubble ${me ? 'board-chat-bubble-me' : 'board-chat-bubble-them'}">${esc(m.text)}</div>`;
    chat.appendChild(row);
  });
  wrap.appendChild(chat);
  const mineCount = msgs.filter((m) => m.from === role).length;
  const left = CHAT_MAX_PER_PERSON - mineCount;
  const composer = document.createElement('div');
  composer.className = 'board-chat-composer';
  if (left <= 0) {
    composer.innerHTML = '<p class="board-chat-note">この交換で送れるメッセージは使い切りました。</p>';
  } else {
    composer.innerHTML = `<input type="text" class="board-chat-composer-input" maxlength="${CHAT_MAX_LEN}" placeholder="メッセージ（あと${left}回）">
      <button type="button" class="board-chat-composer-send">送信</button>`;
    const input = composer.querySelector('input');
    const send = composer.querySelector('button');
    send.addEventListener('click', async () => {
      const text = input.value.trim().slice(0, CHAT_MAX_LEN);
      if (!text) return;
      send.disabled = true;
      const otherSeen = role === 'owner' ? 'applicantSeen' : 'ownerSeen';
      try {
        await updateDoc(doc(db, 'arcanaTradeRequests', r.id), {
          chatMessages: arrayUnion({ from: role, text, at: Date.now() }),
          [otherSeen]: false,
        });
        input.value = '';
      } catch (e) {
        console.error('[chat] send failed', e);
        alert('送信に失敗しました。');
      } finally {
        send.disabled = false;
      }
    });
  }
  wrap.appendChild(composer);
  return wrap;
}

// ===== 起動 =====
(async function init() {
  renderMineGrid();
  await waitForAccount();
  myId = getUserId();
  $('account-link').textContent = isLoggedIn() ? 'アカウント管理（ログイン中）' : 'アカウント管理（登録・申請には登録が必要です）';
  await loadMine();
  if (isLoggedIn()) startTradeListeners();
  // まだ保存していない・未ログインの人は、まず「さがす」で相手がいるか見られるようにする
  if (!myProfile) switchTab(isLoggedIn() ? 'mine' : 'search');
})();
