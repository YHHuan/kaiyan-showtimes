import { validateFestivals, validDate, monthValid, shiftMonth, monthDays, taipeiDate, inPeriod, reviewOld,
  readFollows, toggleFollow, readSavedSessions, scheduleIndex, resolveSaved, conflicts, exportCalendar, FOLLOW_KEY } from './model.mjs';

const $ = id => document.getElementById(id);
const el = (tag, className = '', value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
};
function link(label, href, external = false) {
  const a = el('a', '', label); a.href = href;
  if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
}
function button(label, action) { const b = el('button', '', label); b.type = 'button'; b.addEventListener('click', action); return b; }
const shortDay = date => date.slice(5).replace('-', '/');
const timeLabel = timestamp => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(timestamp));
const params = new URLSearchParams(location.search);
const today = taipeiDate();
const initialMonth = monthValid(params.get('month')) ? params.get('month') : today.slice(0, 7);
const state = { mode: params.get('view') === 'saved' ? 'saved' : 'festivals', month: initialMonth,
  day: validDate(params.get('day')) && params.get('day').startsWith(initialMonth) ? params.get('day') : initialMonth === today.slice(0, 7) ? today : initialMonth + '-01',
  city: 'all', followedOnly: false, buffer: 15 };
let data, index, follows = [], saved = [], clashes = [], monthItems = [];

function notify(message) { $('action-status').textContent = message; }
function readLocal() {
  const problems = [];
  try { follows = readFollows(localStorage); } catch { follows = []; problems.push('影展關注無法讀取，未改動原資料。'); }
  try { saved = resolveSaved(readSavedSessions(localStorage, data.schedule), data.schedule, index, data.generatedAt); }
  catch { saved = []; problems.push('收藏場次無法讀取，未改動原收藏；請確認瀏覽器允許儲存網站資料。'); }
  $('storage-note').hidden = !problems.length;
  $('storage-note').textContent = problems.join(' ');
}
function festivalCard(f) {
  const card = el('article', 'item'); card.dataset.festivalId = f.id;
  const title = el('h3', '', f.name);
  const currentDay = taipeiDate();
  title.append(el('span', 'pill', currentDay > f.endDate ? '已結束' : currentDay < f.startDate ? '即將開始' : '展期中'));
  card.append(title, el('p', 'date-line', f.startDate + ' — ' + f.endDate + ' · ' + f.cities.join('、')),
    el('p', 'muted', '影展期間，非電影場次；完整片單及放映時間請見官方。'));
  const actions = el('div', 'actions');
  const follow = button(follows.includes(f.id) ? '★ 已關注' : '☆ 關注影展', () => {
    try {
      follows = toggleFollow(localStorage, f.id);
      render();
      document.querySelector('[data-follow="' + f.id + '"]')?.focus({ preventScroll: true });
      notify(follows.includes(f.id) ? '已關注，僅存在這個瀏覽器。' : '已取消關注。');
    } catch { notify('無法儲存關注；沒有更動原收藏，請確認瀏覽器儲存權限或資料格式。'); }
  });
  follow.dataset.follow = f.id; follow.setAttribute('aria-pressed', String(follows.includes(f.id)));
  actions.append(follow, link('官方節目／場次 →', f.programUrl, true));
  if (f.seriesId && data.seriesIds?.includes(f.seriesId)) actions.append(link('本站已核實活動場（部分）→', '../?' + new URLSearchParams({ series: f.seriesId })));
  card.append(actions);
  const provenance = el('p', 'state' + (reviewOld(f, currentDay) ? ' warn' : ''));
  provenance.append('檔期核對 ' + f.checkedAt + (reviewOld(f, currentDay) ? ' · 超過 30 天，請再核對官方。 ' : ' · '), link('公告來源', f.sourceUrl, true));
  card.append(provenance);
  return card;
}
const statusLabels = {
  current: '本輪資料有此場次；購票前請向官方確認。', past: '已開演／已過期，保留你的收藏紀錄。',
  missing: '本輪未查到，可能尚未公布或已異動；不代表取消。', stale: '場次資料已過期，請回主站更新並向官方確認。',
  ambiguous: '有多個活動入口，請回主站確認版本及票種；暫不匯出。'
};
function sessionCard(s) {
  const card = el('article', 'item'); card.dataset.sessionState = s.state;
  card.append(el('p', 'date-line', s.day + ' ' + timeLabel(s.start) + (s.end ? ' — ' + (taipeiDate(s.end) !== s.day ? '翌日 ' : '') + timeLabel(s.end) + '（估計）' : '')),
    el('h3', '', s.movie), el('p', 'muted', [s.cinema, s.hall, s.tag].filter(Boolean).join(' · ')),
    el('p', 'state' + (s.state === 'current' || s.state === 'past' ? '' : ' warn'), statusLabels[s.state]));
  if (s.state === 'current' && !s.end) card.append(el('p', 'state warn', '片長未知，無法完整檢查撞期與轉場。'));
  const relevant = clashes.filter(c => c.a === s.key || c.b === s.key);
  if (relevant.length) card.append(el('p', 'state warn', [...new Set(relevant.map(c => c.kind === 'overlap' ? '與其他收藏場次可能撞期' : '跨戲院轉場時間不足'))].join('；')));
  const actions = el('div', 'actions');
  actions.append(link('回主站核對', '../?' + new URLSearchParams({ m: s.movie, dd: s.date })));
  if (s.url) actions.append(link('官方場次／訂票 →', s.url, true));
  card.append(actions);
  return card;
}
function syncUrl() {
  const p = new URLSearchParams({ month: state.month, day: state.day });
  if (state.mode === 'saved') p.set('view', 'saved');
  // Never put personal watchlists or followed IDs in a shareable URL.
  try { history.replaceState(null, '', '?' + p); } catch {}
}
function render() {
  readLocal();
  const isFestival = state.mode === 'festivals', currentDay = taipeiDate();
  const visibleFestivals = data.festivals.filter(f => (state.city === 'all' || f.cities.includes(state.city)) && (!state.followedOnly || follows.includes(f.id)));
  const days = monthDays(state.month);
  monthItems = isFestival ? visibleFestivals.filter(f => f.startDate <= days.filter(d => d.startsWith(state.month)).at(-1) && f.endDate >= state.month + '-01') : saved.filter(s => s.day.startsWith(state.month));
  clashes = conflicts(saved, state.buffer); // Include adjacent-day pairs, not just selected month.
  $('mode-festivals').setAttribute('aria-pressed', String(isFestival));
  $('mode-saved').setAttribute('aria-pressed', String(!isFestival));
  $('festival-filters').hidden = !isFestival;
  $('saved-filters').hidden = isFestival;
  $('mode-note').textContent = isFestival
    ? '目前僅收錄 ' + data.festivals.length + ' 檔已核實影展，不是全年完整清單。檔期人工核對，不會隨每日場次更新自動刷新。'
    : '只讀取你在開演收藏的「指定場次」，不會把收藏的電影自動排進日曆，也不會改動原收藏。所有時間以台灣時間顯示。';
  const stamp = new Date(data.generatedAt);
  $('data-note').hidden = isFestival;
  $('data-note').textContent = '場次資料版本：' + stamp.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + '。散場依片長＋12分鐘估算，不含映後座談；轉場預留不是實際交通時間。';
  $('month-title').textContent = Number(state.month.slice(0, 4)) + ' 年 ' + Number(state.month.slice(5)) + ' 月';
  $('month').value = state.month;
  $('prev').disabled = shiftMonth(state.month, -1) === state.month;
  $('next').disabled = shiftMonth(state.month, 1) === state.month;
  const calendar = $('calendar'); calendar.replaceChildren();
  for (const day of days) {
    const fests = visibleFestivals.filter(f => inPeriod(day, f));
    const sessions = saved.filter(s => s.day === day);
    const b = button('', () => {
      if (!monthValid(day.slice(0, 7))) return;
      state.day = day; state.month = day.slice(0, 7); render();
      document.querySelector('[data-day="' + day + '"]')?.focus({ preventScroll: true });
    });
    b.className = 'day' + (day.startsWith(state.month) ? '' : ' outside') + (day === currentDay ? ' today' : '');
    b.dataset.day = day;
    b.setAttribute('aria-pressed', String(day === state.day));
    if (day === currentDay) b.setAttribute('aria-current', 'date');
    b.setAttribute('aria-label', day + '，' + (isFestival ? fests.length + ' 檔收錄影展' + (fests.length ? '：' + fests.map(f => f.name).join('、') : '') : sessions.length + ' 個收藏場次'));
    b.append(el('span', 'day-number', String(Number(day.slice(8)))));
    if (isFestival) {
      for (const f of fests.slice(0, 2)) b.append(el('span', 'festival-band palette-' + (data.festivals.indexOf(f) % 4), f.shortName));
      if (fests.length > 2) b.append(el('span', 'session-count', '+' + (fests.length - 2) + ' 檔'));
    } else if (sessions.length) b.append(el('span', 'session-count', '● ' + sessions.length + ' 場'));
    calendar.append(b);
  }
  $('day-title').textContent = state.day.replaceAll('-', ' / ');
  const daily = isFestival ? visibleFestivals.filter(f => inPeriod(state.day, f)) : saved.filter(s => s.day === state.day);
  $('day-items').replaceChildren(...daily.map(isFestival ? festivalCard : sessionCard));
  if (!daily.length) $('day-items').append(el('p', 'empty', isFestival ? '這一天沒有符合條件的已收錄影展，不代表沒有活動。' : '這一天尚未收藏指定場次；可先回主站找想看的電影。'));
  $('list-title').textContent = (isFestival ? '本月影展' : '本月收藏場次') + ' · ' + monthItems.length;
  $('month-items').replaceChildren(...monthItems.map(isFestival ? festivalCard : sessionCard));
  if (!monthItems.length) $('month-items').append(el('p', 'empty', isFestival ? '這個月沒有符合條件的已收錄檔期。試試其他月份、地區，或取消「只看我關注」。' : '這個月尚無收藏場次。電影／戲院收藏沒有指定時間，所以不會自動出現在這裡。'));
  const eligible = isFestival ? monthItems : monthItems.filter(s => s.state === 'current');
  $('export').disabled = !eligible.length;
  $('export').textContent = isFestival ? '匯出本月檔期 .ics' : '匯出可核對場次 .ics';
  $('export-note').textContent = isFestival
    ? '匯出目前篩選的 ' + eligible.length + ' 檔完整影展期間（跨月不截斷），不是放映時間；匯入後不會自動同步。'
    : '可匯出 ' + eligible.length + ' 場；已過期、未取得、資料過舊或入口有歧義的 ' + (monthItems.length - eligible.length) + ' 場不匯出。未知片長不填結束時間；匯入後不會自動同步。';
  const monthKeys = new Set(monthItems.map(s => s.key));
  const relevant = clashes.filter(c => monthKeys.has(c.a) || monthKeys.has(c.b));
  const unknown = isFestival ? 0 : monthItems.filter(s => s.state === 'current' && !s.end).length;
  $('conflict-note').hidden = isFestival || !monthItems.length;
  $('conflict-note').textContent = (relevant.length ? relevant.length + ' 組可能撞期／轉場不足，請核對下列場次。' : '依目前可核對的片長，未發現已知撞期或轉場不足。')
    + (unknown ? '另有 ' + unknown + ' 場片長未知，無法完整判斷。' : '') + ' 缺資料的收藏不列入推算；這不是保證來得及。';
  syncUrl();
}
async function download() {
  // Resolve with the current clock again: a previously rendered session may have started.
  render();
  const isFestival = state.mode === 'festivals';
  const selected = isFestival ? monthItems : monthItems.filter(s => s.state === 'current');
  if (!selected.length) return;
  try {
    const content = await exportCalendar(isFestival ? { festivals: selected } : { sessions: selected });
    const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }));
    const a = link('', url); a.download = 'kaiyan-' + state.mode + '-' + state.month + '.ics';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('已產生 .ics，請匯入你使用的行事曆；後續改期不會自動同步。');
  } catch { notify('行事曆匯出失敗；原收藏未受影響，請稍後再試。'); }
}
async function init() {
  const response = await fetch('./data.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('data unavailable');
  data = await response.json(); validateFestivals(data);
  if (!Number.isFinite(Date.parse(data.generatedAt))) throw new Error('missing build timestamp');
  index = scheduleIndex(data.schedule);
  const cities = [...new Set(data.festivals.flatMap(f => f.cities))].sort((a, b) => ['台北市', '新北市', '台中市', '台南市', '高雄市'].indexOf(a) - ['台北市', '新北市', '台中市', '台南市', '高雄市'].indexOf(b));
  for (const city of cities) { const option = el('option', '', city); option.value = city; $('city').append(option); }
  for (const mode of ['festivals', 'saved']) $('mode-' + mode).addEventListener('click', () => { state.mode = mode; render(); });
  for (const [name, delta] of [['prev', -1], ['next', 1]]) $(name).addEventListener('click', () => { state.month = shiftMonth(state.month, delta); state.day = state.month + '-01'; render(); });
  $('today').addEventListener('click', () => { state.day = taipeiDate(); state.month = state.day.slice(0, 7); render(); });
  $('month').addEventListener('change', e => { if (monthValid(e.target.value)) { state.month = e.target.value; state.day = state.month + '-01'; render(); } });
  $('city').addEventListener('change', e => { state.city = e.target.value; render(); });
  $('followed-only').addEventListener('change', e => { state.followedOnly = e.target.checked; render(); });
  $('buffer').addEventListener('change', e => { state.buffer = Number(e.target.value); render(); });
  $('export').addEventListener('click', download);
  window.addEventListener('storage', e => { if (!e.key || [FOLLOW_KEY, 'kaiyan.sessions', 'kaiyan.favorites'].includes(e.key)) render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  $('load-error').hidden = true; $('app').hidden = false; render();
}
init().catch(() => {
  $('app').hidden = true;
  $('load-error').hidden = false;
  $('load-error').replaceChildren('影展日曆暫時無法載入，原收藏未更動。', link('返回場次查詢 →', '../'));
});
