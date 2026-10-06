'use strict';
// Forex Factory の英語の指標名を日本語にする。
// 1) 対訳表（通貨別の overrides → titles）  2) 規則による組み立て  3) 訳せなければ英語のまま

const table = require('../data/translations.json');

const PREFIX_COUNTRY = {
  German: '独',
  French: '仏',
  Italian: '伊',
  Spanish: '西'
};

const PREFIX_STAGE = {
  Flash: '速報値',
  Prelim: '速報値',
  Advance: '速報値',
  Final: '確報値',
  Revised: '改定値'
};

function lookup(cur, title) {
  const o = table.overrides[cur + '|' + title];
  if (o) return o;
  return table.titles[title] || null;
}

// 「消費者物価指数（前月比）」+「速報値」→「消費者物価指数（前月比・速報値）」
function addStage(name, stage) {
  if (/）$/.test(name)) return name.replace(/）$/, '・' + stage + '）');
  return name + '（' + stage + '）';
}

function byRule(cur, title) {
  let m;

  m = title.match(/^(\d+)-y Bond Auction$/);
  if (m) return m[1] + '年債入札';
  m = title.match(/^(\d+)-m Bill Auction$/);
  if (m) return m[1] + 'カ月物短期債入札';

  m = title.match(/^FOMC Member (.+) Speaks$/);
  if (m) return 'FOMCメンバー ' + m[1] + '氏 発言';
  m = title.match(/^MPC Member (.+) Speaks$/);
  if (m) return '英中銀MPC委員 ' + m[1] + '氏 発言';
  m = title.match(/^(.+) Speaks$/);
  if (m) return m[1] + ' 発言';

  // German / French / Italian / Spanish + 既知の指標名
  m = title.match(/^(German|French|Italian|Spanish) (.+)$/);
  if (m) {
    const rest = lookup(cur, m[2]) || byRule(cur, m[2]);
    if (rest) return PREFIX_COUNTRY[m[1]] + ' ' + rest;
  }

  // Flash / Prelim / Final / Revised + 既知の指標名
  m = title.match(/^(Flash|Prelim|Advance|Final|Revised) (.+)$/);
  if (m) {
    const rest = lookup(cur, m[2]);
    if (rest) return addStage(rest, PREFIX_STAGE[m[1]]);
  }

  return null;
}

function translateTitle(cur, title) {
  return lookup(cur, title) || byRule(cur, title) || title;
}

function countryName(cur) {
  return table.countries[cur] || cur;
}

module.exports = { translateTitle, countryName };
