'use strict';
// 取得元: GMO外貨の経済指標カレンダー（ウェブページの表を読み取る）。
// URL に日付を入れると、その日から8日分のページが返る。

const { pad, jstToTs, addDays, compact } = require('./dates');

const GMO_BASE = 'https://www.gaikaex.com/gaikaex/mark/calendar/index.php?date=';

// 国名 → 通貨コード
const COUNTRY_CUR = {
  日本: 'JPY',
  米国: 'USD',
  アメリカ: 'USD',
  ユーロ: 'EUR',
  ユーロ圏: 'EUR',
  ドイツ: 'EUR',
  フランス: 'EUR',
  イタリア: 'EUR',
  スペイン: 'EUR',
  イギリス: 'GBP',
  英国: 'GBP',
  オーストラリア: 'AUD',
  ニュージーランド: 'NZD',
  カナダ: 'CAD',
  スイス: 'CHF',
  中国: 'CNY',
  香港: 'HKD',
  トルコ: 'TRY',
  南アフリカ: 'ZAR',
  メキシコ: 'MXN'
};
// 国旗画像の名前に残っているユーロ導入前の通貨コード
const LEGACY_EUR = ['dem', 'frf', 'itl', 'esp', 'nlg', 'bef', 'ats', 'iep', 'pte', 'fim', 'grd'];

function text(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function currencyOf(country, flag) {
  if (COUNTRY_CUR[country]) return COUNTRY_CUR[country];
  if (flag) {
    const f = flag.toLowerCase();
    if (LEGACY_EUR.indexOf(f) >= 0) return 'EUR';
    if (/^[a-z]{3}$/.test(f)) return f.toUpperCase();
  }
  return '—';
}

// 表の「10/5(月)」は年が無いので、取得開始日から順にたどって年月日を決める
function resolveDay(label, startKey) {
  const m = label.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!m) return null;
  const want = pad(Number(m[1])) + '-' + pad(Number(m[2]));
  for (let i = -1; i <= 14; i++) {
    const key = addDays(startKey, i);
    if (key.slice(5) === want) return key;
  }
  return startKey.slice(0, 4) + '-' + want;
}

function parseGMO(html, startKey) {
  const head = html.indexOf('<th class="date">');
  const tb = head >= 0 ? html.indexOf('<tbody', head) : -1;
  const te = tb >= 0 ? html.indexOf('</tbody>', tb) : -1;
  if (head < 0 || tb < 0 || te < 0) {
    throw new Error('ページの中に指標の表が見つかりません（ページの作りが変わった可能性があります）');
  }

  const rows = html.slice(tb, te).split(/<tr\b/i).slice(1);
  const events = [];
  const holidays = [];
  const seen = {};
  let day = null;
  let from = null;
  let to = null;

  for (const row of rows) {
    const cells = [];
    const re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = re.exec(row))) cells.push({ attr: m[1], html: m[2] });
    if (!cells.length) continue;

    let i = 0;
    if (/class\s*=\s*"date"/.test(cells[0].attr)) {
      day = resolveDay(text(cells[0].html), startKey);
      i = 1;
      if (day) {
        if (!from || day < from) from = day;
        if (!to || day > to) to = day;
      }
    }
    if (!day || cells.length < i + 4) continue;

    const time = text(cells[i].html);
    const country = text(cells[i + 1].html);
    const title = text(cells[i + 2].html);
    if (!title) continue; // 指標の無い日（土日など）の空行
    const flag = (cells[i + 1].html.match(/flags\/([A-Za-z]+)_/) || [])[1];
    const cur = currencyOf(country, flag);
    const stars = (text(cells[i + 3].html).match(/★/g) || []).length;

    if (title === '休場') {
      holidays.push({ day, cur, country, note: '休場' });
      continue;
    }

    // 時刻は「27:00」（翌3:00）のように24時以降の表記がある。「--:--」は時刻未定。
    const tm = time.match(/^(\d{1,2}):(\d{2})$/);
    let ts = null;
    if (tm) {
      const p = day.split('-').map(Number);
      ts = jstToTs(p[0], p[1], p[2], Number(tm[1]), Number(tm[2]));
    }

    let id = ['gmo', day, tm ? time : 'xx:xx', cur, country, title].join('|');
    if (seen[id]) {
      seen[id] += 1;
      id += '#' + seen[id];
    } else {
      seen[id] = 1;
    }

    events.push({ id, day, ts, cur, country, name: title, imp: Math.min(stars, 3) });
  }

  if (!from) {
    throw new Error('表から日付を読み取れませんでした（ページの作りが変わった可能性があります）');
  }

  events.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    if (a.ts === null || b.ts === null) return (a.ts === null ? -1 : 0) - (b.ts === null ? -1 : 0);
    return a.ts - b.ts;
  });
  return { events, holidays, from, to };
}

// todayKey の前日から取得する（前日の「27:00」など、日付をまたぐ指標を拾うため）
async function fetchGMO(fetchImpl, userAgent, todayKey) {
  const startKey = addDays(todayKey, -1);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetchImpl(GMO_BASE + compact(startKey), {
      headers: { 'User-Agent': userAgent, Accept: 'text/html' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('サーバーの応答が正常ではありません（HTTP ' + res.status + '）');
    return parseGMO(await res.text(), startKey);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { GMO_BASE, parseGMO, fetchGMO };
