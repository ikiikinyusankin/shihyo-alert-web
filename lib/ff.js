'use strict';
// 取得元: Forex Factory の週間エクスポート（JSON）。アクセスした時点の「今週分」が返る。

const { dayKey, hm } = require('./dates');
const { translateTitle, countryName } = require('./translate');

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const IMPACT = { High: 3, Medium: 2, Low: 1 };

function parseFF(text) {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch (e) {
    throw new Error('データではない応答が返りました（取得回数の制限に達した可能性があります。5分ほど待ってから起動し直してください）');
  }
  if (!Array.isArray(arr)) {
    throw new Error('データの形式が想定と違います');
  }

  const events = [];
  const holidays = [];
  const seen = {};
  let from = null;
  let to = null;

  for (const row of arr) {
    if (!row || typeof row.date !== 'string') continue;
    const ts = Date.parse(row.date);
    if (isNaN(ts)) continue;
    const cur = String(row.country || '').trim() || '—';
    const title = String(row.title || '').trim();
    if (!title) continue;
    const day = dayKey(ts);
    if (!from || day < from) from = day;
    if (!to || day > to) to = day;

    if (row.impact === 'Holiday') {
      holidays.push({ day, cur, country: countryName(cur), note: '祝日のため休場' });
      continue;
    }

    let id = ['ff', day, hm(ts), cur, title].join('|');
    if (seen[id]) {
      seen[id] += 1;
      id += '#' + seen[id];
    } else {
      seen[id] = 1;
    }

    events.push({
      id,
      day,
      ts,
      cur,
      country: countryName(cur),
      name: translateTitle(cur, title),
      imp: IMPACT[row.impact] || 0
    });
  }

  events.sort((a, b) => a.ts - b.ts);
  return { events, holidays, from, to };
}

async function fetchFF(fetchImpl, userAgent) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetchImpl(FF_URL, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('サーバーの応答が正常ではありません（HTTP ' + res.status + '）');
    return parseFF(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { FF_URL, parseFF, fetchFF };
