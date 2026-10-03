// arcana.js
// 交換できるアルカナ22枚(大アルカナ)。画像と名前は14_GenshinOmikuji/tarot.jsと同じものを使う
// (おみくじだけのレアカード「奈落のアルカナ」「七星のアルカナ」は交換対象外なので入れない)。
// idはFirestoreに保存するキーなので変更しないこと。

const IMG_BASE = 'https://cdn.jsdelivr.net/gh/uko05/99_SharedImage@main/01_Genshin/Omikuji/';

export const ARCANA = [
  { id: 'fool',             number: '0',     name: '愚者',         nameEn: 'The Fool',           file: 'Fool.png' },
  { id: 'magician',         number: 'I',     name: '魔術師',       nameEn: 'The Magician',       file: 'Magician.png' },
  { id: 'high_priestess',   number: 'II',    name: '女教皇',       nameEn: 'The High Priestess', file: 'High_Priestess.png' },
  { id: 'empress',          number: 'III',   name: '女帝',         nameEn: 'The Empress',        file: 'Empress.png' },
  { id: 'emperor',          number: 'IV',    name: '皇帝',         nameEn: 'The Emperor',        file: 'Emperor.png' },
  { id: 'hierophant',       number: 'V',     name: '聖職者',       nameEn: 'The Hierophant',     file: 'Hierophant.png' },
  { id: 'lovers',           number: 'VI',    name: '恋人',         nameEn: 'The Lovers',         file: 'Lovers.png' },
  { id: 'chariot',          number: 'VII',   name: '戦車',         nameEn: 'The Chariot',        file: 'Chariot.png' },
  { id: 'strength',         number: 'VIII',  name: '力',           nameEn: 'Strength',           file: 'Strength.png' },
  { id: 'hermit',           number: 'IX',    name: '隠者',         nameEn: 'The Hermit',         file: 'Hermit.png' },
  { id: 'wheel_of_fortune', number: 'X',     name: '運命の輪',     nameEn: 'Wheel of Fortune',   file: 'Wheel_of_Fortune.png' },
  { id: 'justice',          number: 'XI',    name: '正義',         nameEn: 'Justice',            file: 'Justice.png' },
  { id: 'hanged_man',       number: 'XII',   name: '吊るされた男', nameEn: 'The Hanged Man',     file: 'Hanged_Man.png' },
  { id: 'death',            number: 'XIII',  name: '死神',         nameEn: 'Death',              file: 'Death.png' },
  { id: 'temperance',       number: 'XIV',   name: '節制',         nameEn: 'Temperance',         file: 'Temperance.png' },
  { id: 'devil',            number: 'XV',    name: '悪魔',         nameEn: 'The Devil',          file: 'Devil.png' },
  { id: 'tower',            number: 'XVI',   name: '塔',           nameEn: 'The Tower',          file: 'Tower.png' },
  { id: 'star',             number: 'XVII',  name: '星',           nameEn: 'The Star',           file: 'Star.png' },
  { id: 'moon',             number: 'XVIII', name: '月',           nameEn: 'The Moon',           file: 'Moon.png' },
  { id: 'sun',              number: 'XIX',   name: '太陽',         nameEn: 'The Sun',            file: 'Sun.png' },
  { id: 'judgement',        number: 'XX',    name: '審判',         nameEn: 'Judgement',          file: 'Judgement.png' },
  { id: 'world',            number: 'XXI',   name: '世界',         nameEn: 'The World',          file: 'World.png' },
].map((a) => ({ ...a, img: IMG_BASE + a.file }));

export const ARCANA_IDS = ARCANA.map((a) => a.id);
export const ARCANA_BY_ID = Object.fromEntries(ARCANA.map((a) => [a.id, a]));

// 交換に出せる枚数 = 所持数 - 残す枚数 - 交換予定(承認済み・未完了)の枚数。
// 残す枚数は通常1枚。「1枚所持も交換候補に出す」(allowLastCopy)をオンにした人は0枚(最後の1枚も出せる)。
// 24_AccountCenter/functions/arcanaTrade.js の tradeable() と同じ計算にすること。
export function tradeableCount(counts, reservedOut, id, allowLastCopy = false) {
  return Math.max(0, (counts?.[id] || 0) - (allowLastCopy ? 0 : 1) - (reservedOut?.[id] || 0));
}

// 交換に出せるカード(1枚以上出せるもの)のid一覧。Firestoreの検索用に profile.spare として保存する
export function computeSpare(counts, reservedOut, allowLastCopy = false) {
  return ARCANA_IDS.filter((id) => tradeableCount(counts, reservedOut, id, allowLastCopy) >= 1);
}
