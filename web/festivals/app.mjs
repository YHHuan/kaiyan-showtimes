import { validateFestivals, validDate, monthValid, shiftMonth, monthDays, taipeiDate, inPeriod, reviewOld,
  readFollows, toggleFollow, readSavedSessions, scheduleIndex, resolveSaved, conflicts, exportCalendar, FOLLOW_KEY } from './festival-calendar.mjs';
import { SCREENINGS_KEY, emptyScreeningFeed, validateScreeningFeed, availableScreenings, resolveFestivalSessions,
  readFestivalSessions, saveFestivalSession, removeFestivalSession, screeningSignature, sourceState, matchesScreening } from './festival-screenings.mjs';

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
const state = { mode: ['saved', 'festivals'].includes(params.get('view')) ? params.get('view') : 'screenings', month: initialMonth,
  day: validDate(params.get('day')) && params.get('day').startsWith(initialMonth) ? params.get('day') : initialMonth === today.slice(0, 7) ? today : initialMonth + '-01',
  city: 'all', followedOnly: false, buffer: 15, festival: 'all', query: '', upcoming: true, limit: 40 };
let data, index, follows = [], saved = [], clashes = [], monthItems = [], festivalSaved = [], screenings = [];

function notify(message) { $('action-status').textContent = message; }
function readLocal() {
  const problems = [];
  try { follows = readFollows(localStorage); } catch { follows = []; problems.push('影展關注無法讀取，未改動原資料。'); }
  try { saved = resolveSaved(readSavedSessions(localStorage, data.schedule), data.schedule, index, data.generatedAt); }
  catch { saved = []; problems.push('收藏場次無法讀取，未改動原收藏；請確認瀏覽器允許儲存網站資料。'); }
  try {
    festivalSaved = readFestivalSessions(localStorage);
    saved.push(...resolveFestivalSessions(festivalSaved, data.screenings, data.festivals, data.schedule.cinemaAliases));
  } catch { festivalSaved = []; problems.push('影展場次收藏無法讀取，未改動原資料。'); }
  saved.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  screenings = availableScreenings(data.screenings, data.festivals, data.schedule.cinemaAliases);
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
  if (data.screenings.sources.some(s => s.festivalId === f.id && s.rows.length)) actions.prepend(button('挑選個別場次', () => {
    state.mode = 'screenings'; state.festival = f.id; state.query = ''; state.limit = 40;
    $('festival-select').value = f.id; $('film-search').value = '';
    state.day = currentDay >= f.startDate && currentDay <= f.endDate ? currentDay : f.startDate;
    state.month = state.day.slice(0, 7); render(); $('day-agenda').focus();
  }));
  if (f.seriesId && data.seriesIds?.includes(f.seriesId)) actions.append(link('本站已核實活動場（部分）→', '../?' + new URLSearchParams({ series: f.seriesId })));
  card.append(actions);
  const provenance = el('p', 'state' + (reviewOld(f, currentDay) ? ' warn' : ''));
  provenance.append('檔期核對 ' + f.checkedAt + (reviewOld(f, currentDay) ? ' · 超過 30 天，請再核對官方。 ' : ' · '), link('公告來源', f.sourceUrl, true));
  card.append(provenance);
  return card;
}
const statusLabels = {
  current: '本輪資料有此場次；購票前請向官方確認。', past: '已開演／已過期，保留你的收藏紀錄。',
  missing: '本輪未查到，可能尚未公布或已異動；不代表取消。', stale: '來源資料過舊或尚未成功取得，暫不新增收藏／匯出，請向官方確認。',
  ambiguous: '有多個活動入口，請回主站確認版本及票種；暫不匯出。',
  unverified: '本輪來源未完整更新，顯示上次資料；暫不新增收藏／匯出，請核對官方。',
  changed: '官方場次資料有異動；保留你的原收藏，確認新版後才恢復匯出。'
};
function changeFavorite(id, action) {
  try {
    if (action === 'remove') removeFestivalSession(localStorage, id);
    else {
      const row = data.screenings.sources.flatMap(s => s.rows).find(s => s.id === id);
      const current = availableScreenings(data.screenings, data.festivals).find(s => s.id === id);
      if (!row || current?.state !== 'current') { notify('此場目前無法核對，未更動收藏，請見官方。'); render(); return; }
      saveFestivalSession(localStorage, row);
    }
    render();
    document.querySelector('[data-save="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true });
    notify(action === 'remove' ? '已取消這場影展收藏；原本院線收藏未更動。' : '已儲存這一場，到「我的場次」就能一起排片、匯出行事曆。只存在這個瀏覽器。');
  } catch { notify('無法儲存影展場次；沒有更動原收藏，請確認瀏覽器儲存權限、空間或資料格式。'); }
}
function sessionCard(s, browse = false) {
  const card = el('article', 'item'); card.dataset.sessionState = s.state;
  if (s.kind === 'festival') { card.dataset.screeningId = s.id; card.append(el('p', 'eyebrow', s.festivalName)); }
  card.append(el('p', 'date-line', s.day + ' ' + timeLabel(s.start) + (s.end ? ' — ' + (taipeiDate(s.end) !== s.day ? '翌日 ' : '') + timeLabel(s.end) + (s.endKind === 'official' ? '（官網時段）' : '（估計）') : '')),
    el('h3', '', s.movie), el('p', 'muted', [s.cinema, s.hall, s.tag].filter(Boolean).join(' · ')),
    el('p', 'state' + (s.state === 'current' || s.state === 'past' ? '' : ' warn'), statusLabels[s.state]));
  if (s.kind === 'festival') {
    if (s.films.length > 1) card.append(el('p', 'state', '合輯，一張場次：' + s.films.map(f => f.title).join('／')));
    if (s.englishTitle) card.append(el('p', 'state', s.englishTitle));
    if (s.end) card.append(el('p', 'state', s.endKind === 'official' ? '結束依官網時段；映後、休息及交通請另預留。' : '結束依片長估算，不另加預告；映後及交通請另預留。'));
  }
  if (s.state === 'current' && !s.end) card.append(el('p', 'state warn', '片長未知，無法完整檢查撞期與轉場。'));
  const relevant = clashes.filter(c => c.a === s.key || c.b === s.key);
  if (relevant.length) card.append(el('p', 'state warn', [...new Set(relevant.map(c => c.kind === 'overlap' ? '與其他收藏場次可能撞期' : '跨戲院轉場時間不足'))].join('；')));
  const actions = el('div', 'actions');
  if (s.kind === 'festival') {
    const existing = festivalSaved.find(r => r.id === s.id);
    const row = data.screenings.sources.flatMap(source => source.rows).find(r => r.id === s.id);
    const differs = existing && row && screeningSignature(existing) !== screeningSignature(row);
    if (browse) {
      const action = existing && !differs ? 'remove' : 'save';
      const save = button(existing ? differs ? '確認後更新成此場次' : '★ 已收藏・取消' : '☆ 收藏這一場', () => changeFavorite(s.id, action));
      save.dataset.save = s.id; save.setAttribute('aria-pressed', String(Boolean(existing && !differs)));
      save.disabled = action !== 'remove' && s.state !== 'current'; actions.append(save);
    } else {
      if (s.replacement) {
        const r = s.replacement;
        card.append(el('p', 'notice', '官方目前：' + r.movie + ' · ' + r.date + ' ' + String(Math.floor(r.mins / 60)).padStart(2, '0') + ':' + String(r.mins % 60).padStart(2, '0') + ' · ' + r.cinema + ' ' + r.hall));
        if (availableScreenings(data.screenings, data.festivals).some(r => r.id === s.id && r.state === 'current')) actions.append(button('確認異動並更新收藏', () => changeFavorite(s.id, 'save')));
      }
      actions.append(button('取消這場收藏', () => changeFavorite(s.id, 'remove')));
    }
    actions.append(link('官方場次表 →', s.sourceUrl, true));
    card.append(el('p', 'state', '場次來源更新：' + (s.fetchedAt ? new Date(s.fetchedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚無可核對資料')));
  } else {
    actions.append(link('回主站核對', '../?' + new URLSearchParams({ m: s.movie, dd: s.date })));
    if (s.url) actions.append(link('官方場次／訂票 →', s.url, true));
  }
  card.append(actions);
  return card;
}
function syncUrl() {
  const p = new URLSearchParams({ month: state.month, day: state.day });
  p.set('view', state.mode);
  // Never put personal watchlists or followed IDs in a shareable URL.
  try { history.replaceState(null, '', '?' + p); } catch {}
}
function render() {
  readLocal();
  const isFestival = state.mode === 'festivals', browse = state.mode === 'screenings', currentDay = taipeiDate();
  const visibleFestivals = data.festivals.filter(f => (state.city === 'all' || f.cities.includes(state.city)) && (!state.followedOnly || follows.includes(f.id)));
  const visibleScreenings = screenings.filter(s => (state.festival === 'all' || s.festivalId === state.festival)
    && (!state.upcoming || s.start > Date.now()) && matchesScreening(s, state.query));
  const displayedSessions = browse ? visibleScreenings : saved;
  const days = monthDays(state.month);
  monthItems = isFestival ? visibleFestivals.filter(f => f.startDate <= days.filter(d => d.startsWith(state.month)).at(-1) && f.endDate >= state.month + '-01') : displayedSessions.filter(s => s.day.startsWith(state.month));
  clashes = conflicts(saved, state.buffer); // Include adjacent-day pairs, not just selected month.
  $('mode-festivals').setAttribute('aria-pressed', String(isFestival));
  $('mode-saved').setAttribute('aria-pressed', String(state.mode === 'saved'));
  $('mode-screenings').setAttribute('aria-pressed', String(browse));
  $('festival-filters').hidden = !isFestival;
  $('saved-filters').hidden = state.mode !== 'saved';
  $('screening-filters').hidden = !browse;
  $('sources').hidden = isFestival;
  $('mode-note').textContent = isFestival
    ? '目前僅收錄 ' + data.festivals.length + ' 檔已核實影展，不是全年完整清單。檔期人工核對，不會隨每日場次更新自動刷新。'
    : browse ? '挑一部片、選一個時間，收藏你真的想去的那一場。短片合輯以整場收藏；這不是訂票，也不代表仍有座位。所有時間以台灣時間顯示。'
      : '院線與影展的「指定場次」一起排片。院線收藏唯讀、影展收藏獨立儲存；不會把收藏的電影自動排進日曆，也不會改動原收藏。所有時間以台灣時間顯示。';
  const stamp = new Date(data.generatedAt);
  $('data-note').hidden = state.mode !== 'saved';
  $('data-note').textContent = '院線資料版本：' + stamp.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + '。院線散場依片長＋12分鐘估算；影展依官網時段或片長，不加 12 分鐘。映後、休息及交通請另預留，轉場預留不是實際交通時間。';
  const sourceLabels = { current: '已取得', unverified: '本輪更新不完整，暫停新增／匯出', stale: '資料過舊或未成功取得', 'not-fetched': '尚未取得', unsupported: '尚未接入', retired: '本屆自動更新已結束', missing: '無資料' };
  $('source-list').replaceChildren(...data.screenings.sources.map(source => {
    const p = el('p', 'state');
    p.append((data.festivals.find(f => f.id === source.festivalId)?.shortName || source.festivalId) + '：' + sourceLabels[sourceState(source)] + ' · ' + source.rows.length + ' 場 · ' + source.scope,
      el('br'), source.fetchedAt ? '最後成功取得 ' + new Date(source.fetchedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + ' · ' : '', link('官方', source.url, true));
    return p;
  }));
  $('source-summary').textContent = '來源與收錄範圍：' + data.screenings.sources.filter(s => sourceState(s) === 'current').length + ' 檔可核對，非完整影展清單';
  $('legend').textContent = isFestival ? '色帶是影展期間，不代表每天都有放映。點日期看檔期。' : browse ? '數字是符合篩選的影展場次，點日期逐場挑選。收藏後到「我的場次」排片。' : '數字是你收藏的院線與影展場次，點日期看完整清單。';
  $('month-title').textContent = Number(state.month.slice(0, 4)) + ' 年 ' + Number(state.month.slice(5)) + ' 月';
  $('month').value = state.month;
  $('prev').disabled = shiftMonth(state.month, -1) === state.month;
  $('next').disabled = shiftMonth(state.month, 1) === state.month;
  const calendar = $('calendar'); calendar.replaceChildren();
  for (const day of days) {
    const fests = visibleFestivals.filter(f => inPeriod(day, f));
    const sessions = displayedSessions.filter(s => s.day === day);
    const b = button('', () => {
      if (!monthValid(day.slice(0, 7))) return;
      state.day = day; state.month = day.slice(0, 7); render();
      document.querySelector('[data-day="' + day + '"]')?.focus({ preventScroll: true });
    });
    b.className = 'day' + (day.startsWith(state.month) ? '' : ' outside') + (day === currentDay ? ' today' : '');
    b.dataset.day = day;
    b.setAttribute('aria-pressed', String(day === state.day));
    if (day === currentDay) b.setAttribute('aria-current', 'date');
    b.setAttribute('aria-label', day + '，' + (isFestival ? fests.length + ' 檔收錄影展' + (fests.length ? '：' + fests.map(f => f.name).join('、') : '') : sessions.length + (browse ? ' 個影展場次' : ' 個收藏場次')));
    b.append(el('span', 'day-number', String(Number(day.slice(8)))));
    if (isFestival) {
      for (const f of fests.slice(0, 2)) b.append(el('span', 'festival-band palette-' + (data.festivals.indexOf(f) % 4), f.shortName));
      if (fests.length > 2) b.append(el('span', 'session-count', '+' + (fests.length - 2) + ' 檔'));
    } else if (sessions.length) b.append(el('span', 'session-count', '● ' + sessions.length + ' 場'));
    calendar.append(b);
  }
  $('day-title').textContent = state.day.replaceAll('-', ' / ');
  const daily = isFestival ? visibleFestivals.filter(f => inPeriod(state.day, f)) : displayedSessions.filter(s => s.day === state.day);
  const cardFor = s => isFestival ? festivalCard(s) : sessionCard(s, browse);
  $('day-items').replaceChildren(...daily.map(cardFor));
  if (!daily.length) $('day-items').append(el('p', 'empty', isFestival ? '這一天沒有符合條件的已收錄影展，不代表沒有活動。' : browse ? '這一天沒有符合篩選的已收錄場次。試試其他日期，或往下看本月清單；不代表官方沒有場次。' : '這一天尚未收藏指定場次；可到「影展場次」或回主站挑選。'));
  $('list-title').textContent = (isFestival ? '本月影展' : browse ? '本月影展場次' : '本月收藏場次') + ' · ' + monthItems.length;
  $('month-items').replaceChildren(...(browse ? monthItems.slice(0, state.limit) : monthItems).map(cardFor));
  $('show-more').hidden = !browse || monthItems.length <= state.limit;
  $('show-more').textContent = '再顯示 40 場（目前 ' + Math.min(state.limit, monthItems.length) + '／' + monthItems.length + '）';
  if (!monthItems.length) $('month-items').append(el('p', 'empty', isFestival ? '這個月沒有符合條件的已收錄檔期。試試其他月份、地區，或取消「只看我關注」。' : browse ? '沒有符合條件的已收錄場次。可清除片名、切換影展／月份，或查看官方；尚未接入不等於尚未公布。' : '這個月尚無收藏場次。電影／戲院收藏沒有指定時間，所以不會自動出現在這裡。'));
  const eligible = isFestival ? monthItems : monthItems.filter(s => s.state === 'current');
  $('export').disabled = !eligible.length;
  $('export').hidden = browse;
  $('export').textContent = isFestival ? '匯出本月檔期 .ics' : '匯出可核對場次 .ics';
  $('export-note').textContent = isFestival
    ? '匯出目前篩選的 ' + eligible.length + ' 檔完整影展期間（跨月不截斷），不是放映時間；匯入後不會自動同步。'
    : browse ? '先收藏想看的個別場次，再到「我的場次」匯出 .ics 給 Apple／Google 行事曆。不是匯出整個影展，也不是訂票。'
      : '可匯出 ' + eligible.length + ' 場；已過期、未取得、異動待確認、更新失敗、資料過舊或入口有歧義的 ' + (monthItems.length - eligible.length) + ' 場不匯出。未知片長不填結束時間；匯入後不會自動同步。';
  const monthKeys = new Set(monthItems.map(s => s.key));
  const relevant = clashes.filter(c => monthKeys.has(c.a) || monthKeys.has(c.b));
  const unknown = isFestival ? 0 : monthItems.filter(s => s.state === 'current' && !s.end).length;
  $('conflict-note').hidden = state.mode !== 'saved' || !monthItems.length;
  $('conflict-note').textContent = (relevant.length ? relevant.length + ' 組可能撞期／轉場不足，請核對下列場次。' : '依目前可核對的片長，未發現已知撞期或轉場不足。')
    + (unknown ? '另有 ' + unknown + ' 場片長未知，無法完整判斷。' : '') + ' 缺資料的收藏不列入推算；這不是保證來得及。';
  syncUrl();
}
async function download() {
  // Resolve with the current clock again: a previously rendered session may have started.
  render();
  if (state.mode === 'screenings') return;
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
  try { validateScreeningFeed(data.screenings, data.festivals); }
  catch { data.screenings = emptyScreeningFeed(data.festivals); }
  const cities = [...new Set(data.festivals.flatMap(f => f.cities))].sort((a, b) => ['台北市', '新北市', '台中市', '台南市', '高雄市'].indexOf(a) - ['台北市', '新北市', '台中市', '台南市', '高雄市'].indexOf(b));
  for (const city of cities) { const option = el('option', '', city); option.value = city; $('city').append(option); }
  for (const f of data.festivals) { const option = el('option', '', f.shortName); option.value = f.id; $('festival-select').append(option); }
  for (const mode of ['screenings', 'festivals', 'saved']) $('mode-' + mode).addEventListener('click', () => { state.mode = mode; state.limit = 40; render(); });
  for (const [name, delta] of [['prev', -1], ['next', 1]]) $(name).addEventListener('click', () => { state.month = shiftMonth(state.month, delta); state.day = state.month + '-01'; render(); });
  $('today').addEventListener('click', () => { state.day = taipeiDate(); state.month = state.day.slice(0, 7); render(); });
  $('month').addEventListener('change', e => { if (monthValid(e.target.value)) { state.month = e.target.value; state.day = state.month + '-01'; render(); } });
  $('city').addEventListener('change', e => { state.city = e.target.value; render(); });
  $('followed-only').addEventListener('change', e => { state.followedOnly = e.target.checked; render(); });
  $('buffer').addEventListener('change', e => { state.buffer = Number(e.target.value); render(); });
  $('festival-select').addEventListener('change', e => { state.festival = e.target.value; state.limit = 40; render(); });
  $('film-search').addEventListener('input', e => { state.query = e.target.value; state.limit = 40; render(); });
  $('upcoming-only').addEventListener('change', e => { state.upcoming = e.target.checked; state.limit = 40; render(); });
  $('show-more').addEventListener('click', () => { state.limit += 40; render(); });
  $('export').addEventListener('click', download);
  window.addEventListener('storage', e => { if (!e.key || [SCREENINGS_KEY, FOLLOW_KEY, 'kaiyan.sessions', 'kaiyan.favorites'].includes(e.key)) render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  $('load-error').hidden = true; $('app').hidden = false; render();
}
init().catch(() => {
  $('app').hidden = true;
  $('load-error').hidden = false;
  $('load-error').replaceChildren('影展日曆暫時無法載入，原收藏未更動。', link('返回場次查詢 →', '../'));
});
