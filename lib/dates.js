'use strict';
// 日付・時刻はすべて日本時間（JST, UTC+9）で扱う。PCのタイムゾーン設定には依存しない。

const JST_OFFSET = 9 * 60 * 60 * 1000;

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

// エポックミリ秒 → 日本時間の日付キー 'YYYY-MM-DD'
function dayKey(ts) {
  return new Date(ts + JST_OFFSET).toISOString().slice(0, 10);
}

// エポックミリ秒 → 日本時間の 'HH:MM'
function hm(ts) {
  const d = new Date(ts + JST_OFFSET);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

// 日本時間の年月日時分 → エポックミリ秒（hh が 24 以上でも翌日に繰り上がる）
function jstToTs(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET;
}

// 日付キーに n 日足す
function addDays(key, n) {
  const p = key.split('-').map(Number);
  const t = Date.UTC(p[0], p[1] - 1, p[2] + n);
  return new Date(t).toISOString().slice(0, 10);
}

// 日付キー 'YYYY-MM-DD' → 'YYYYMMDD'
function compact(key) {
  return key.replace(/-/g, '');
}

module.exports = { JST_OFFSET, pad, dayKey, hm, jstToTs, addDays, compact };
