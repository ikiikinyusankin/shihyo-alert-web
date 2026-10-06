'use strict';
// GitHub Actions から毎朝実行される取得スクリプト。
// 2つの取得元からデータを取得し、docs/data/data.json に書き出す。
// 片方の取得に失敗した場合は、前回のデータを残して失敗した旨を記録する。

const fs = require('fs');
const path = require('path');
const { dayKey } = require('../lib/dates');
const { fetchFF } = require('../lib/ff');
const { fetchGMO } = require('../lib/gmo');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const OUT = path.join(__dirname, '..', 'docs', 'data', 'data.json');
const LABELS = { ff: 'Forex Factory', gmo: 'GMO外貨' };
const KEYS = ['ff', 'gmo'];

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (e) {
    return { sources: {} };
  }
}

(async () => {
  const now = Date.now();
  const today = dayKey(now);
  const previous = readPrevious();

  const results = await Promise.allSettled([
    fetchFF(fetch, UA),
    fetchGMO(fetch, UA, today)
  ]);

  const sources = {};
  let okCount = 0;

  KEYS.forEach((key, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') {
      okCount += 1;
      sources[key] = Object.assign({ label: LABELS[key], ok: true, fromCache: false, error: '', fetchedAt: now }, r.value);
      console.log(LABELS[key] + ': 取得成功 ' + r.value.events.length + ' 件（' + r.value.from + ' 〜 ' + r.value.to + '）');
      return;
    }
    const message = r.reason && r.reason.name === 'AbortError'
      ? '応答が返ってきませんでした（時間切れ）'
      : String((r.reason && r.reason.message) || r.reason || '不明なエラー');
    console.log(LABELS[key] + ': 取得失敗 ' + message);
    const old = previous.sources && previous.sources[key];
    if (old && Array.isArray(old.events) && old.events.length) {
      sources[key] = Object.assign({}, old, { label: LABELS[key], ok: false, fromCache: true, error: message });
    } else {
      sources[key] = { label: LABELS[key], ok: false, fromCache: false, error: message, fetchedAt: null, events: [], holidays: [], from: null, to: null };
    }
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: now, sourceKeys: KEYS, sources }), 'utf8');
  console.log('書き出し: ' + OUT);

  // 両方とも失敗したときだけ、実行を「失敗」にする（GitHub から通知メールが届く）
  if (okCount === 0) process.exit(1);
})();
