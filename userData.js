// userData.js
// 共有ID(userId)とログイン状態。25_FriendBoard/userData.js と同じ方式。
// uko05.github.io配下は同一オリジンなので、localStorageのキーとFirebase Authのログイン状態を
// 他サイト(おみくじ・アカウント管理など)と共有している。
// このサイトは「登録・申請はアカウント登録(24_AccountCenterでログイン)必須」なので、
// ログイン中は accountLinks(authUid -> omikujiUserId)で確定した共有IDを使う。

import { app, db } from './firebaseConfig.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const LS_SHARED_UID = 'genshinOmikuji_userId';
const auth = getAuth(app);

let _authUid = null;
let _linkedUserId = null;

export function getAuthUid() { return _authUid; }

// アカウント登録済みでログイン中、かつ共有IDの紐付けがある時だけ true
export function isLoggedIn() { return !!(_authUid && _linkedUserId); }

export function getUserId() {
  if (_linkedUserId) return _linkedUserId;
  return localStorage.getItem(LS_SHARED_UID) || null;
}

// ログイン状態と accountLinks の確認が終わるまで待つ(最大2.5秒)
export function waitForAccount() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    onAuthStateChanged(auth, async (user) => {
      _authUid = (user && user.email) ? user.uid : null;
      _linkedUserId = null;
      if (_authUid) {
        try {
          const linkSnap = await getDoc(doc(db, 'accountLinks', _authUid));
          const linkedId = linkSnap.exists() ? linkSnap.data().omikujiUserId : null;
          if (linkedId) {
            _linkedUserId = linkedId;
            if (linkedId !== localStorage.getItem(LS_SHARED_UID)) localStorage.setItem(LS_SHARED_UID, linkedId);
          }
        } catch (e) {
          console.warn('[userData] account link lookup failed', e);
        }
      }
      finish();
    });
    setTimeout(finish, 2500);
  });
}
