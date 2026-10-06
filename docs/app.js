'use strict';
(function () {
  var JST_OFFSET = 9 * 60 * 60 * 1000;
  var CURS = ['USD', 'JPY', 'EUR', 'GBP', 'AUD', 'CHF', 'CAD', 'NZD'];
  var LEADS = [1, 3, 5, 10, 15];
  var IMP_LABEL = ['—', '低', '中', '高'];
  var DOW = ['日', '月', '火', '水', '木', '金', '土'];
  var SETTINGS_KEY = 'shihyo-alert-settings-v1';
  var DEFAULTS = {
    source: 'ff', lead: 5, sound: 'chime', repeatMode: 'count', repeatCount: 3,
    muted: false, keepAwake: true, on: {}, watch: {}
  };

  var S = {
    ready: false,
    loadError: '',
    loadedAt: 0,
    settings: JSON.parse(JSON.stringify(DEFAULTS)),
    sources: {},
    sourceKeys: [],
    soundFile: null,      // { name, url }
    fileError: false,
    now: Date.now(),
    today: '',
    lastMinute: -1,
    filter: { curs: {}, minImp: 1, onlyOn: false },
    fired: {},
    ring: null,
    audioOn: false,       // 「アラート待機を始める」を押して音が鳴らせる状態か
    badTicks: 0,
    wake: 'off',          // off / on / unsupported / failed
    calMessage: ''
  };

  // ---------- 小さな道具 ----------
  function $(id) { return document.getElementById(id); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(ts) { return new Date(ts + JST_OFFSET).toISOString().slice(0, 10); }
  function hm(ts) {
    var d = new Date(ts + JST_OFFSET);
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function addDays(key, n) {
    var p = key.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }
  function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shortDate(key) {
    var p = key.split('-');
    return Number(p[1]) + '/' + Number(p[2]);
  }
  function remainText(ms) {
    var mins = Math.max(1, Math.ceil(ms / 60000));
    if (mins >= 60) {
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      return 'あと' + h + '時間' + (m ? m + '分' : '');
    }
    return 'あと' + mins + '分';
  }

  // ---------- 設定の保存（この端末のブラウザ内） ----------
  function pruneMarks(map, today) {
    var limit = addDays(today, -7);
    var out = {};
    Object.keys(map || {}).forEach(function (id) {
      if ((id.split('|')[1] || '') >= limit) out[id] = map[id];
    });
    return out;
  }

  function loadSettings() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    var s = {};
    Object.keys(DEFAULTS).forEach(function (k) { s[k] = saved[k] !== undefined ? saved[k] : DEFAULTS[k]; });
    s.lead = LEADS.indexOf(Number(s.lead)) >= 0 ? Number(s.lead) : 5;
    s.repeatCount = Math.max(1, Math.min(99, parseInt(s.repeatCount, 10) || 3));
    s.repeatMode = s.repeatMode === 'until' ? 'until' : 'count';
    if (['chime', 'bell', 'beep', 'file'].indexOf(s.sound) < 0) s.sound = 'chime';
    s.on = pruneMarks(s.on, S.today);
    s.watch = pruneMarks(s.watch, S.today);
    S.settings = s;
  }

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch (e) { /* 保存できない環境でも動作は続ける */ }
    }, 300);
  }

  // 選んだ音声ファイルは、次に開いたときも使えるようブラウザ内に保存する
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('shihyo-alert', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('files'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function storeSoundFile(file) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put({ blob: file, name: file.name }, 'sound');
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () { /* 保存できなくても、今回の間は使える */ });
  }
  function restoreSoundFile() {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var req = db.transaction('files', 'readonly').objectStore('files').get('sound');
        req.onsuccess = function () {
          var v = req.result;
          if (v && v.blob) S.soundFile = { name: v.name || '音声ファイル', url: URL.createObjectURL(v.blob) };
          resolve();
        };
        req.onerror = function () { resolve(); };
      });
    }).catch(function () { /* 無視 */ });
  }

  // ---------- データの読み込み ----------
  function loadData() {
    return fetch('data/data.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      S.sources = d.sources || {};
      S.sourceKeys = d.sourceKeys || Object.keys(S.sources);
      S.loadError = '';
      S.loadedAt = Date.now();
      if (!S.sources[S.settings.source]) S.settings.source = S.sourceKeys[0] || 'ff';
    }).catch(function (e) {
      if (!S.sourceKeys.length) S.loadError = 'データを読み込めませんでした（' + (e && e.message ? e.message : e) + '）。通信環境を確認して「再読み込み」を押してください。';
    });
  }

  function src() { return S.sources[S.settings.source] || null; }

  // 本日の指標 = 日本時間で今日の日付のもの。
  // GMO外貨の「27:00」のように前日の欄に載る深夜の指標も、時刻が今日ならば含める。
  function todaysEvents() {
    var s = src();
    if (!s || !s.events) return [];
    var list = s.events.filter(function (e) {
      return e.day === S.today || (e.ts !== null && dayKey(e.ts) === S.today);
    });
    list.sort(function (a, b) {
      if (a.ts === null && b.ts === null) return 0;
      if (a.ts === null) return -1;
      if (b.ts === null) return 1;
      return a.ts - b.ts;
    });
    return list;
  }

  function timeLabel(ts) {
    if (ts === null) return '未定';
    return (dayKey(ts) > S.today ? '翌' : '') + hm(ts);
  }
  function isPast(e) { return e.ts !== null && e.ts <= S.now; }
  function isOn(e) { return e.ts !== null && !!S.settings.on[e.id]; }
  function isWatched(e) {
    var w = S.settings.watch[e.id];
    return w === undefined ? e.imp === 3 : !!w;
  }
  function ringAt(e) { return e.ts - S.settings.lead * 60000; }

  // 取得済みのデータに、今日の分がまだ含まれていない場合
  function noToday() {
    var s = src();
    if (!s || !s.fetchedAt || !s.to) return false;
    return dayKey(s.fetchedAt) !== S.today && S.today > s.to;
  }

  // すでにアラート時刻を過ぎている指標は「鳴らし済み」として扱う
  // （ONにした瞬間や、タイミングを変えた瞬間に鳴り出さないようにする）
  function syncFired() {
    todaysEvents().forEach(function (e) {
      if (!isOn(e)) { delete S.fired[e.id]; return; }
      if (S.now >= ringAt(e)) { if (!S.fired[e.id]) S.fired[e.id] = true; }
      else delete S.fired[e.id];
    });
  }

  // ---------- 描画 ----------
  function renderClock() {
    var d = new Date(S.now + JST_OFFSET);
    $('clockDate').textContent = d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日（' + DOW[d.getUTCDay()] + '）';
    $('clockTime').textContent = hm(S.now);
  }

  function renderSourceButtons() {
    $('sourceButtons').innerHTML = S.sourceKeys.map(function (k) {
      var active = S.settings.source === k;
      return '<button type="button" class="seg' + (active ? ' active' : '') + '" aria-pressed="' + active + '" data-act="source" data-key="' + esc(k) + '">' + esc(S.sources[k].label) + '</button>';
    }).join('');
  }

  function renderStatus() {
    var el = $('statusLine');
    var s = src();
    el.className = 'status-line';
    if (!S.ready) { el.textContent = '読み込み中…'; return; }
    if (S.loadError) { el.className = 'status-line warn'; el.textContent = S.loadError; return; }
    if (!s) { el.textContent = ''; return; }
    var when = '';
    if (s.fetchedAt) {
      when = (dayKey(s.fetchedAt) === S.today ? '' : shortDate(dayKey(s.fetchedAt)) + ' ') + hm(s.fetchedAt);
    }
    if (s.ok) {
      el.textContent = 'データ取得 ' + when + '（毎朝1回、自動で取得）';
    } else if (s.fromCache) {
      el.className = 'status-line warn';
      el.textContent = '最新の取得に失敗したため、前回（' + when + '）のデータを表示しています。理由：' + s.error;
    } else {
      el.className = 'status-line warn';
      el.textContent = '取得に失敗しています。理由：' + s.error;
    }
  }

  function renderStandby() {
    var el = $('standby');
    if (!S.audioOn) {
      el.className = 'card standby o3 off';
      el.innerHTML = '<div class="standby-text"><div class="standby-title">アラート音はまだ鳴らせません</div>' +
        '<div class="standby-note">ボタンを押すと、この画面を開いている間アラートが鳴ります（アプリを開くたびに1回）。</div></div>' +
        '<div class="standby-actions"><button type="button" class="btn primary" data-act="standby">アラート待機を始める</button></div>';
      return;
    }
    var wakeNote = '';
    if (S.wake === 'unsupported') wakeNote = '（この端末・ブラウザでは使えません）';
    else if (S.wake === 'failed') wakeNote = '（今は有効にできませんでした）';
    var wakeOn = S.settings.keepAwake && S.wake === 'on';
    el.className = 'card standby o3 on';
    el.innerHTML = '<div class="standby-text"><div class="standby-title">アラート待機中</div>' +
      '<div class="standby-note">この画面を開いたままにしてください。アプリを閉じたり、画面をロックしたりすると鳴りません。</div></div>' +
      '<div class="standby-actions"><button type="button" class="switch-row" role="switch" aria-checked="' + wakeOn + '" data-act="wake">' +
      '<span>画面を消さない' + esc(wakeNote) + '</span><span class="track"><span class="knob"></span></span></button></div>';
  }

  function renderHolidays() {
    var s = src();
    var el = $('holidays');
    if (!S.ready) { el.textContent = '読み込み中…'; return; }
    if (!s || (!s.ok && !s.fromCache) || noToday()) { el.textContent = '—'; return; }
    var list = (s.holidays || []).filter(function (h) { return h.day === S.today; });
    if (!list.length) { el.textContent = '本日、休場の市場はありません'; return; }
    el.innerHTML = list.map(function (h) {
      return '<div class="holiday-item"><span class="cur-pill mono">' + esc(h.cur) + '</span>' +
        '<span class="country">' + esc(h.country) + '</span><span class="note">' + esc(h.note) + '</span></div>';
    }).join('');
  }

  function renderFilters() {
    var events = todaysEvents();
    var list = CURS.slice();
    var extra = [];
    events.forEach(function (e) {
      if (list.indexOf(e.cur) < 0 && extra.indexOf(e.cur) < 0) extra.push(e.cur);
    });
    extra.sort();
    list = list.concat(extra);
    var any = Object.keys(S.filter.curs).some(function (k) { return S.filter.curs[k]; });
    var html = '<button type="button" class="chip' + (!any ? ' active' : '') + '" aria-pressed="' + !any + '" data-act="cur" data-key="">すべて</button>';
    html += list.map(function (c) {
      var a = !!S.filter.curs[c];
      return '<button type="button" class="chip' + (a ? ' active' : '') + '" aria-pressed="' + a + '" data-act="cur" data-key="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    $('curChips').innerHTML = html;

    $('impButtons').innerHTML = [[1, 'すべて'], [2, '中以上'], [3, '高のみ']].map(function (p) {
      var a = S.filter.minImp === p[0];
      return '<button type="button" class="seg' + (a ? ' active' : '') + '" aria-pressed="' + a + '" data-act="imp" data-key="' + p[0] + '">' + p[1] + '</button>';
    }).join('');
    $('onlyOn').checked = S.filter.onlyOn;
    $('filterSummary').textContent = (any || S.filter.minImp > 1 || S.filter.onlyOn) ? '（適用中）' : '';
  }

  function renderCounts() {
    var events = S.ready ? todaysEvents() : [];
    var upcoming = events.filter(function (e) { return e.ts === null || e.ts > S.now; }).length;
    var on = events.filter(isOn).length;
    $('counts').innerHTML = '<div>全 <b>' + events.length + '</b> 件</div><div>これから <b>' + upcoming + '</b> 件</div><div>アラートON <b class="accent">' + on + '</b> 件</div>';
  }

  function rowHtml(e) {
    var past = isPast(e);
    var on = isOn(e);
    var watched = isWatched(e);
    var cls = 'trow' + (past ? ' past' : '') + (on && !past ? ' on' : '') + (watched ? ' watched' : '');
    var id = esc(e.id);
    var label = esc(timeLabel(e.ts) + ' ' + e.cur + ' ' + e.name);

    var soon = '';
    if (e.ts !== null && !past && e.ts - S.now <= 60 * 60000) {
      soon = '<span class="soon-tag">' + esc(remainText(e.ts - S.now)) + 'で発表</span>';
    }

    var alertCell;
    if (e.ts === null) {
      alertCell = '時刻未定';
    } else if (past) {
      alertCell = '発表済み';
    } else {
      alertCell = '<button type="button" class="switch" role="switch" aria-checked="' + on + '" aria-label="' + label + ' のアラート" data-act="alert" data-id="' + id + '">' +
        '<span class="sw-label">' + (on ? 'ON' : 'OFF') + '</span><span class="track"><span class="knob"></span></span></button>';
    }

    var imp = e.imp >= 1 && e.imp <= 3 ? e.imp : 0;
    return '<div class="' + cls + '">' +
      '<label class="c-watch"><input type="checkbox" data-act="watch" data-id="' + id + '" aria-label="' + label + ' を注目にする"' + (watched ? ' checked' : '') + '></label>' +
      '<div class="c-time mono">' + esc(timeLabel(e.ts)) + '</div>' +
      '<div class="c-cur"><span class="cur-pill mono">' + esc(e.cur) + '</span></div>' +
      '<div class="c-name"><div class="name-line"><span class="name">' + esc(e.name) + '</span>' + soon + '</div><div class="sub">' + esc(e.country) + '</div></div>' +
      '<div class="c-imp imp' + imp + '"><span class="bars" aria-hidden="true"><i class="b1"></i><i class="b2"></i><i class="b3"></i></span><span class="imp-label">' + IMP_LABEL[imp] + '</span></div>' +
      '<div class="c-alert">' + alertCell + '</div>' +
      '</div>';
  }

  function notice(title, body) {
    return '<div class="card notice"><strong>' + esc(title) + '</strong>' + esc(body) + '</div>';
  }

  function renderList() {
    var el = $('listArea');
    var s = src();
    if (!S.ready) { el.innerHTML = notice('読み込み中…', '経済指標を読み込んでいます。'); return; }
    if (S.loadError || !s) { el.innerHTML = notice('表示できません', S.loadError || 'データがありません。'); return; }
    if (!s.ok && !s.fromCache) {
      el.innerHTML = notice(s.label + ' のデータがありません', '取得に失敗しています（' + s.error + '）。次回の自動取得をお待ちください。');
      return;
    }
    if (noToday()) {
      el.innerHTML = notice('本日（' + shortDate(S.today) + '）の分はまだありません', '取得済みのデータは ' + shortDate(s.to) + ' までです。毎朝6時ごろに自動で取得されます。「再読み込み」で確認できます。');
      return;
    }

    var any = Object.keys(S.filter.curs).some(function (k) { return S.filter.curs[k]; });
    var all = todaysEvents();
    var rows = all.filter(function (e) {
      if (any && !S.filter.curs[e.cur]) return false;
      if (S.filter.minImp > 1 && e.imp < S.filter.minImp) return false;
      if (S.filter.onlyOn && !isOn(e)) return false;
      return true;
    });

    var body;
    if (rows.length) body = rows.map(rowHtml).join('');
    else if (!all.length) body = '<div class="empty">本日の指標はありません。</div>';
    else body = '<div class="empty">条件に合う指標はありません。フィルターを変更してください。</div>';

    el.innerHTML = '<div class="card table-card"><div class="table-inner">' +
      '<div class="thead"><div>注目</div><div>発表時刻</div><div>通貨</div><div>指標</div><div>重要度</div><div class="right">アラート</div></div>' +
      body +
      '<div class="table-foot"><div>時刻はすべて日本時間</div><div>取得元：' + esc(s.label) + '</div></div>' +
      '</div></div>';
  }

  function onEvents() {
    return S.ready && !noToday() ? todaysEvents().filter(isOn) : [];
  }

  function renderSide() {
    var events = onEvents();

    var next = null;
    for (var i = 0; i < events.length; i++) {
      if (events[i].ts > S.now) { next = events[i]; break; }
    }
    $('nextCard').className = 'card pad next-card o4' + (next ? '' : ' none');
    if (next) {
      var r = ringAt(next);
      var remain = r > S.now ? remainText(r - S.now) : 'まもなく発表';
      $('nextAlert').innerHTML = '<div class="next-top"><div class="next-time mono">' + esc(timeLabel(r)) + '</div><div class="next-remain">' + esc(remain) + '</div></div>' +
        '<div class="next-name">' + esc(next.name) + '</div>' +
        '<div class="next-meta"><span class="mono">' + esc(next.cur) + '</span> ・ <span class="mono">' + esc(timeLabel(next.ts)) + '</span> 発表</div>';
    } else {
      $('nextAlert').innerHTML = '<div class="muted">これから鳴るアラートはありません。一覧のスイッチをONにすると予定されます。</div>';
    }

    if (!events.length) {
      $('alertList').innerHTML = '<div class="alert-empty">ONにした指標がここに並びます。</div>';
    } else {
      $('alertList').innerHTML = events.map(function (e) {
        var r = ringAt(e);
        var past = isPast(e);
        var status;
        if (past) status = '発表済み';
        else if (S.now >= r) status = S.fired[e.id] === 'rang' ? '鳴動済み' : 'アラート時刻を経過';
        else status = remainText(r - S.now);
        var done = past || S.now >= r;
        return '<div class="alert-item' + (done ? ' done' : '') + '"><div class="alert-time mono">' + esc(timeLabel(r)) + '</div>' +
          '<div class="alert-body"><div class="alert-name">' + esc(e.cur + ' ' + e.name) + '</div>' +
          '<div class="alert-note">' + esc(timeLabel(e.ts)) + ' 発表 ・ ' + esc(status) + '</div></div></div>';
      }).join('');
    }

    var hint = $('calHint');
    if (S.calMessage) {
      hint.className = 'hint warn';
      hint.textContent = S.calMessage;
    } else {
      hint.className = 'hint';
      hint.textContent = 'アプリを閉じているときやロック中は、このアプリからは鳴らせません。カレンダーに登録しておくと、iPhoneの通知で知らせます（' + S.settings.lead + '分前）。';
    }
  }

  function renderControls() {
    var st = S.settings;
    $('leadButtons').innerHTML = LEADS.map(function (n) {
      var a = st.lead === n;
      return '<button type="button" class="seg' + (a ? ' active' : '') + '" aria-pressed="' + a + '" data-act="lead" data-key="' + n + '">' + n + '分前</button>';
    }).join('');

    $('soundSelect').value = st.sound;
    var fn = $('fileName');
    if (S.soundFile && S.soundFile.name) {
      if (S.fileError) {
        fn.className = 'file-name bad';
        fn.textContent = S.soundFile.name + '（再生できませんでした。内蔵のチャイムで鳴らします）';
      } else {
        fn.className = 'file-name set';
        fn.textContent = S.soundFile.name;
      }
    } else {
      fn.className = 'file-name';
      fn.textContent = 'ファイル未選択（MP3・WAV など）';
    }

    $('repCount').checked = st.repeatMode === 'count';
    $('repUntil').checked = st.repeatMode === 'until';
    if (document.activeElement !== $('repN')) $('repN').value = st.repeatCount;
    $('muteSwitch').setAttribute('aria-checked', String(!!st.muted));
  }

  function renderRing() {
    var r = S.ring;
    var el = $('ringPanel');
    if (!r) { el.innerHTML = ''; return; }
    var st = S.settings;
    var silent = !S.audioOn && !st.muted && !r.test;
    var count = st.repeatMode === 'count' && !silent ? (r.done + ' / ' + st.repeatCount + ' 回目') : (r.done + ' 回目');
    var note = st.repeatMode === 'count' ? '指定した回数を鳴らすと自動で止まります' : 'チェックするまで鳴り続けます';
    if (st.muted) note += '（消音中）';
    else if (silent) note = '音が有効になっていないため、鳴っていません。「アラート待機を始める」を押すと鳴ります。';
    el.innerHTML = '<section class="ring" aria-live="polite">' +
      '<div class="ring-head"><h2>' + (r.test ? 'アラート鳴動中（テスト）' : 'アラート鳴動中') + '</h2><div class="ring-count mono">' + esc(count) + '</div></div>' +
      '<ul class="ring-names">' + r.names.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' +
      '<div class="ring-note">' + esc(note) + '</div>' +
      '<label class="check-label"><input type="checkbox" data-act="ack">確認した（チェックで停止）</label>' +
      '</section>';
  }

  function renderData() {
    renderStatus();
    renderHolidays();
    renderFilters();
    renderCounts();
    renderList();
    renderSide();
  }

  function renderAll() {
    renderClock();
    renderSourceButtons();
    renderStandby();
    renderData();
    renderControls();
    renderRing();
  }

  // ---------- 音 ----------
  var audioCtx = null;
  var player = new Audio();
  player.preload = 'auto';

  function ensureCtx() {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx && C) audioCtx = new C();
    return audioCtx;
  }

  function tone(freq, start, dur, type, vol) {
    var o = audioCtx.createOscillator();
    var g = audioCtx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.16, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(start);
    o.stop(start + dur + 0.02);
  }

  // 無音の短い音声（ファイル再生用のプレーヤーを、ボタン操作の中で有効にするために使う）
  function silentUrl() {
    var n = 800;
    var buf = new ArrayBuffer(44 + n);
    var v = new DataView(buf);
    var put = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    put(0, 'RIFF'); v.setUint32(4, 36 + n, true); put(8, 'WAVE'); put(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    put(36, 'data'); v.setUint32(40, n, true);
    for (var i = 0; i < n; i++) v.setUint8(44 + i, 128);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  // スマートフォンのブラウザは、画面の操作をきっかけにしないと音を鳴らせない。
  // 「アラート待機を始める」を押したときに、ここで音を鳴らせる状態にする。
  function enableAudio() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* 対応していない環境 */ }
    try {
      if (ensureCtx()) {
        audioCtx.resume();
        tone(440, audioCtx.currentTime + 0.01, 0.05, 'sine', 0.0001);
      }
    } catch (e) { /* 無視 */ }
    try {
      player.muted = true;
      player.src = silentUrl();
      var p = player.play();
      var done = function () { try { player.pause(); } catch (e) { /* 無視 */ } player.muted = false; };
      if (p && p.then) p.then(done).catch(done); else done();
    } catch (e) { player.muted = false; }
    S.audioOn = true;
    S.badTicks = 0;
    if (S.ring) S.ring.done = 0; // 鳴動パネルが出ている最中に有効にしたら、最初から鳴らし直す
    if (S.settings.keepAwake) requestWake();
    renderStandby();
    renderRing();
  }

  function playBuiltin(kind, done) {
    var total = 900;
    try {
      if (ensureCtx()) {
        if (audioCtx.state !== 'running') audioCtx.resume();
        var t = audioCtx.currentTime + 0.02;
        if (kind === 'bell') {
          tone(1318.5, t, 1.0, 'sine', 0.16);
          tone(2637, t, 0.5, 'sine', 0.04);
          total = 1050;
        } else if (kind === 'beep') {
          tone(660, t, 0.18, 'square', 0.07);
          tone(660, t + 0.26, 0.18, 'square', 0.07);
          total = 650;
        } else {
          tone(880, t, 0.4, 'sine', 0.16);
          tone(1174.66, t + 0.28, 0.65, 'sine', 0.16);
          total = 1000;
        }
      }
    } catch (e) { /* 音が出せなくても画面表示は続ける */ }
    return setTimeout(done, total);
  }

  function playOnce(r, done) {
    var st = S.settings;
    if (st.muted) { r.timer = setTimeout(done, 900); return; }
    if (st.sound === 'file' && S.soundFile && S.soundFile.url && !S.fileError) {
      var called = false;
      var fin = function () { if (!called) { called = true; player.onended = null; player.onerror = null; done(); } };
      var fail = function () {
        if (called) return;
        called = true;
        player.onended = null;
        player.onerror = null;
        S.fileError = true;
        renderControls();
        r.timer = playBuiltin('chime', done);
      };
      try {
        player.muted = false;
        player.src = S.soundFile.url;
        player.onended = fin;
        player.onerror = fail;
        r.usesPlayer = true;
        var p = player.play();
        if (p && p.catch) p.catch(fail);
      } catch (e) { fail(); }
      return;
    }
    r.timer = playBuiltin(st.sound === 'file' ? 'chime' : st.sound, done);
  }

  function ringStep() {
    var r = S.ring;
    if (!r) return;
    var st = S.settings;
    // 音が有効になっていない間は、気づけるように確認されるまでパネルを出したままにする
    var audible = S.audioOn || st.muted || r.test;
    if (st.repeatMode === 'count' && r.done >= st.repeatCount && audible) { stopRing(); return; }
    r.done += 1;
    renderRing();
    playOnce(r, function () {
      if (S.ring !== r) return;
      r.timer = setTimeout(ringStep, 400);
    });
  }

  function startRing(names, test) {
    if (S.ring) {
      if (test) return;
      S.ring.test = false;
      names.forEach(function (n) { if (S.ring.names.indexOf(n) < 0) S.ring.names.push(n); });
      S.ring.done = Math.min(S.ring.done, 1);
      renderRing();
      return;
    }
    S.ring = { names: names.slice(), test: !!test, done: 0, timer: null, usesPlayer: false };
    ringStep();
  }

  function stopRing() {
    var r = S.ring;
    if (!r) return;
    clearTimeout(r.timer);
    if (r.usesPlayer) {
      player.onended = null;
      player.onerror = null;
      try { player.pause(); } catch (e) { /* 無視 */ }
    }
    S.ring = null;
    renderRing();
  }

  // ---------- 画面を消さない ----------
  var wakeLock = null;
  function requestWake() {
    if (!('wakeLock' in navigator)) { S.wake = 'unsupported'; renderStandby(); return; }
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      S.wake = 'on';
      lock.addEventListener('release', function () {
        if (wakeLock === lock) { wakeLock = null; S.wake = 'off'; renderStandby(); }
      });
      renderStandby();
    }).catch(function () {
      S.wake = 'failed';
      renderStandby();
    });
  }
  function releaseWake() {
    var l = wakeLock;
    wakeLock = null;
    S.wake = 'off';
    if (l) { try { l.release(); } catch (e) { /* 無視 */ } }
    renderStandby();
  }

  // ---------- カレンダー登録（.ics ファイルを作る） ----------
  function icsEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function icsDate(ts) {
    return new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }
  // 1行は75バイトまで。超える分は次の行に折り返す（先頭に空白1つ）
  function icsFold(line) {
    var enc = new TextEncoder();
    var out = [];
    var cur = '';
    var bytes = 0;
    Array.from(line).forEach(function (ch) {
      var n = enc.encode(ch).length;
      var limit = out.length ? 74 : 75;
      if (bytes + n > limit) { out.push(cur); cur = ''; bytes = 0; }
      cur += ch;
      bytes += n;
    });
    out.push(cur);
    return out.join('\r\n ');
  }
  function icsUid(id) {
    var h1 = 5381;
    var h2 = 52711;
    for (var i = 0; i < id.length; i++) {
      var c = id.charCodeAt(i);
      h1 = ((h1 * 33) ^ c) >>> 0;
      h2 = ((h2 * 31) + c) >>> 0;
    }
    return h1.toString(16) + h2.toString(16) + '@shihyo-alert';
  }
  function buildIcs(events) {
    var s = src();
    var lead = S.settings.lead;
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//shihyo-alert//JA', 'CALSCALE:GREGORIAN'];
    events.forEach(function (e) {
      var imp = IMP_LABEL[e.imp >= 1 && e.imp <= 3 ? e.imp : 0];
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + icsUid(e.id));
      lines.push('DTSTAMP:' + icsDate(S.now));
      lines.push('DTSTART:' + icsDate(e.ts));
      lines.push('DTEND:' + icsDate(e.ts + 10 * 60000));
      lines.push('SUMMARY:' + icsEscape('【指標】' + e.cur + ' ' + e.name));
      lines.push('DESCRIPTION:' + icsEscape(e.country + ' ／ 重要度 ' + imp + ' ／ 取得元 ' + (s ? s.label : '')));
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push('DESCRIPTION:' + icsEscape(e.cur + ' ' + e.name + '（' + lead + '分前）'));
      lines.push('TRIGGER:-PT' + lead + 'M');
      lines.push('END:VALARM');
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }
  function exportCalendar() {
    var events = onEvents().filter(function (e) { return e.ts > S.now; });
    if (!events.length) {
      S.calMessage = 'これから発表される指標で、アラートをONにしたものがありません。';
      renderSide();
      return;
    }
    var ics = buildIcs(events);
    var name = 'shihyo-alert-' + S.today.replace(/-/g, '') + '.ics';
    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var a = document.createElement('a');
    var blobUrl = null;
    if (isIOS) {
      a.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
    } else {
      blobUrl = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
      a.href = blobUrl;
    }
    a.download = name;
    a.className = 'sr-only';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }, 2000);
    S.calMessage = events.length + '件を書き出しました。追加の画面が出たら「すべて追加」を選んでください。ファイルとして保存された場合は、そのファイルを開くと追加できます。登録後にアラートをOFFにしても、カレンダー側の予定は消えません。';
    renderSide();
  }
  // ---------- アラート時刻の監視 ----------
  function checkAlerts() {
    if (!S.ready || noToday()) return;
    var due = todaysEvents().filter(function (e) {
      return isOn(e) && !S.fired[e.id] && S.now >= ringAt(e) && S.now < e.ts;
    });
    if (!due.length) return;
    var names = due.map(function (e) {
      S.fired[e.id] = 'rang';
      return timeLabel(e.ts) + ' ' + e.cur + ' ' + e.name;
    });
    startRing(names, false);
    renderSide();
  }

  function tick() {
    S.now = Date.now();
    var today = dayKey(S.now);
    if (today !== S.today) {
      S.today = today;
      S.fired = {};
      renderAll();
    }
    var minute = Math.floor(S.now / 60000);
    if (minute !== S.lastMinute) {
      S.lastMinute = minute;
      renderClock();
      renderCounts();
      renderList();
      renderSide();
    }
    // 画面を閉じて戻ったあとなどに、音が止められていないかを確かめる
    if (S.audioOn && audioCtx) {
      if (audioCtx.state === 'running') {
        S.badTicks = 0;
      } else {
        S.badTicks += 1;
        try { audioCtx.resume(); } catch (e) { /* 無視 */ }
        if (S.badTicks >= 4) { S.audioOn = false; S.badTicks = 0; renderStandby(); renderRing(); }
      }
    }
    checkAlerts();
  }

  function refocus(act, id) {
    var list = document.querySelectorAll('[data-act="' + act + '"]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-id') === id) { list[i].focus({ preventScroll: true }); return; }
    }
  }

  function reload() {
    var btn = $('reloadBtn');
    btn.disabled = true;
    btn.textContent = '読み込み中…';
    return loadData().then(function () {
      btn.disabled = false;
      btn.textContent = '再読み込み';
      S.now = Date.now();
      syncFired();
      renderAll();
    });
  }

  // ---------- 操作 ----------
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');
    var key = t.getAttribute('data-key');

    if (act === 'source') {
      if (!S.sources[key]) return;
      S.settings.source = key;
      S.filter.curs = {};
      S.calMessage = '';
      syncFired();
      save();
      renderSourceButtons();
      renderData();
    } else if (act === 'cur') {
      if (!key) S.filter.curs = {};
      else S.filter.curs[key] = !S.filter.curs[key];
      renderFilters();
      renderList();
    } else if (act === 'imp') {
      S.filter.minImp = Number(key);
      renderFilters();
      renderList();
    } else if (act === 'lead') {
      S.settings.lead = Number(key);
      S.calMessage = '';
      syncFired();
      save();
      renderControls();
      renderSide();
    } else if (act === 'alert') {
      var id = t.getAttribute('data-id');
      if (S.settings.on[id]) delete S.settings.on[id];
      else S.settings.on[id] = true;
      S.calMessage = '';
      syncFired();
      save();
      renderCounts();
      renderList();
      renderSide();
      refocus('alert', id);
    } else if (act === 'standby') {
      enableAudio();
    } else if (act === 'wake') {
      S.settings.keepAwake = !(S.settings.keepAwake && S.wake === 'on');
      save();
      if (S.settings.keepAwake) requestWake();
      else releaseWake();
    }
  });

  document.addEventListener('change', function (ev) {
    var t = ev.target;
    var act = t.getAttribute && t.getAttribute('data-act');
    if (act === 'watch') {
      var wid = t.getAttribute('data-id');
      S.settings.watch[wid] = t.checked;
      save();
      renderList();
      refocus('watch', wid);
    } else if (act === 'ack') {
      stopRing();
    }
  });

  $('onlyOn').addEventListener('change', function () {
    S.filter.onlyOn = this.checked;
    renderFilters();
    renderList();
  });

  $('reloadBtn').addEventListener('click', reload);
  $('calBtn').addEventListener('click', exportCalendar);

  $('soundSelect').addEventListener('change', function () {
    S.settings.sound = this.value;
    save();
  });

  $('testSound').addEventListener('click', function () {
    // テスト再生のボタン操作でも、音を鳴らせる状態にする
    if (!S.audioOn) enableAudio();
    startRing(['テスト再生'], true);
  });

  $('fileInput').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    if (S.soundFile && S.soundFile.url) { try { URL.revokeObjectURL(S.soundFile.url); } catch (e) { /* 無視 */ } }
    S.soundFile = { name: f.name, url: URL.createObjectURL(f) };
    S.fileError = false;
    S.settings.sound = 'file';
    save();
    storeSoundFile(f);
    renderControls();
  });

  $('repCount').addEventListener('change', function () {
    S.settings.repeatMode = 'count';
    save();
    renderRing();
  });
  $('repUntil').addEventListener('change', function () {
    S.settings.repeatMode = 'until';
    save();
    renderRing();
  });
  $('repN').addEventListener('input', function () {
    var n = parseInt(this.value, 10);
    if (isNaN(n)) return;
    S.settings.repeatCount = Math.max(1, Math.min(99, n));
    S.settings.repeatMode = 'count';
    $('repCount').checked = true;
    save();
    renderRing();
  });
  $('repN').addEventListener('blur', function () {
    this.value = S.settings.repeatCount;
  });

  $('muteSwitch').addEventListener('click', function () {
    S.settings.muted = !S.settings.muted;
    save();
    renderControls();
    renderRing();
  });

  // 画面に戻ってきたとき: 時刻を確かめ直し、古ければデータも読み直す
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !S.ready) return;
    if (S.audioOn && S.settings.keepAwake) requestWake();
    if (Date.now() - S.loadedAt > 30 * 60000) reload();
    tick();
  });

  // ---------- 起動 ----------
  // 絞り込みは、広い画面では最初から開いておく（スマートフォンでは閉じておく）
  if (window.matchMedia && window.matchMedia('(min-width: 761px)').matches) $('filterBox').open = true;
  S.today = dayKey(S.now);
  loadSettings();
  renderAll();

  Promise.all([loadData(), restoreSoundFile()]).then(function () {
    S.ready = true;
    S.now = Date.now();
    S.today = dayKey(S.now);
    // 開いた時点でアラート時刻を過ぎているものは、音を有効にする前なので鳴らし済みにはしない
    renderAll();
    tick();
    setInterval(tick, 1000);
  });
})();
