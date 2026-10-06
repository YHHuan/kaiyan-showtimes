import { festivalFixture, now } from './festival-fixture.mjs';
export function screeningFixture() {
  const { catalog } = festivalFixture();
  const row = { id: 'test-one:100', festivalId: 'test-one', programId: '11', movie: '兩部短片合輯', englishTitle: 'Two Shorts',
    cinema: '測試影城', hall: '2廳', date: '2099-01-01', mins: 1395, runtime: 60, endMins: 1455, endKind: 'official',
    notes: ['映後座談'], films: [{ id: '1', title: '晨光' }, { id: '2', title: '星空' }], url: 'https://example.org/schedule' };
  const second = { ...row, id: 'test-one:101', date: '2099-01-02', mins: 600, endMins: 660 };
  const source = { festivalId: row.festivalId, url: row.url, scope: '測試逐場資料', status: 'ok',
    attemptedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(), rows: [row, second] };
  return { row, second, source, feed: { version: 1, sources: [source] }, catalog };
}

// Minimal synthetic fixtures reflecting the official formats, not copied films/synopses.
export const parserFestival = { id: 'fixture-2026', startDate: '2026-10-03', endDate: '2026-10-25', programUrl: 'https://example.org/schedule' };
export function tiafHTML({ ids = '10,11', title = '晨光＋星空', time = '12:30', day = '10.3 Sat.', year = 2026 } = {}) {
  return `<html><head><title>${year} TIAF</title></head><body><div id="dayByDay"><div class="content">
    <h2 class="theaterName">測試影城</h2><div class="timetable"><div class="table"><div class="tr">
    <div class="th"><div class="date">${day}</div>2廳</div><div class="td showTime" data-films="${ids}">
    <div class="top"><b>${title}</b><i>Two Shorts</i></div><div class="bottom"><dl class="note">
    <div class="runtime">60 min</div><div>☆ ※</div></dl><div class="time">${time}</div></div></div></div></div></div>
    <h2 class="theaterName">尚無場次的場地</h2><div class="timetable"></div></div></div></body></html>`;
}
export const wmwScript = '({dayStart: new Date(null, null, null, 8, 0, 0)})';
export const wmwEvent = { date: '10/16', site: 'site25', start: 380, times: 91, state: true,
  film: '<li><a href="https://www.wmw.org.tw/tw/film/10">晨光</a></li><li><a href="https://www.wmw.org.tw/tw/film/11">星空</a></li>',
  custom_title: '<li>晨光＋星空</li>', info: '<i class="fa fa-star-o"></i>|91min' };
export function wmwHTML(events = [wmwEvent]) {
  return `<html><body><div class="schedule" data-date="10/16"><div class="day-event-title"><span>光點華山1廳</span><span>光點華山2廳</span></div>
    <section class="day-events site24"></section><section class="day-events site25"></section></div>
    <script>var events = ${JSON.stringify(events)};</script></body></html>`;
}
export function kffJSON() {
  return { 108: [{ date: '2026-10-09', cinemas: [{ title: '測試影城', auditoriums: [{ id: 9, title: '3F 放映廳',
    _detail: { ignored: 'UI duplicate preview must not become another session' },
    programs: [{ id: 100, belong: 10, cate: 108, cinema: 9, date: '2026-10-09', start_time: '23:30', end_time: '00:30', mark: [1], notes: null,
      belong_program: { id: 10, cate: 108, status: 1, title: '晨光＋星空', title_en: 'Two Shorts', time_length: '60',
        film_row: [{ id: 11, year: '2026', title: '晨光', brief: 'Do not publish source synopses' }, { id: 12, year: '2026', title: '星空' }] } }] }] }] }] };
}

export function kffXRJSON() {
  const days = kffJSON()[108], hall = days[0].cinemas[0].auditoriums[0], first = hall.programs[0];
  first.cate = 109; first.belong_program.cate = 109;
  first.start_time = '11:00'; first.end_time = '11:40';
  first.belong_program.time_length = '12'; // Film duration is not the booked slot.
  first.notes = '本節目需線上預約，每場 8 位';
  const second = structuredClone(first);
  Object.assign(second, { id: 101, start_time: '12:00', end_time: '12:40', notes: '英文發音、中文字幕' });
  hall.programs = [{ ...first, showtime_row: [first, second] }];
  return { 109: days };
}

// Future clock keeps UI tests deterministic. Production IDs are intentionally
// reused here to exercise category routing, not to claim a real 2099 edition.
export function xrFixture() {
  const { catalog, source, row } = screeningFixture();
  catalog.festivals.push({ ...catalog.festivals[0], id: 'kff-2026', name: '測試雄影', shortName: '測試雄影', cities: ['高雄市'] },
    { ...catalog.festivals[0], id: 'golden-horse-2026', name: '測試金馬', shortName: '測試金馬' });
  const regular = { ...row, id: 'kff-2026:100', festivalId: 'kff-2026', movie: '長片測試' };
  const xr = { ...regular, id: 'kff-2026:xr:100', movie: 'XR 測試體驗', englishTitle: 'XR Experience',
    mins: 780, endMins: 820, runtime: 12, notes: ['XR 體驗', '英文發音、中文字幕'] };
  const xrSecond = { ...xr, id: 'kff-2026:xr:101', mins: 900, endMins: 940 };
  const xrSource = { ...source, sourceId: 'kff-2026:xr', festivalId: 'kff-2026', rows: [xr, xrSecond] };
  const feed = { version: 1, sources: [source, { ...source, festivalId: 'kff-2026', rows: [regular] },
    { ...source, festivalId: 'golden-horse-2026', status: 'not-fetched', fetchedAt: null, rows: [] }], extraSources: [xrSource] };
  return { catalog, regular, xr, xrSecond, xrSource, feed };
}

export const goldenNoData = `<script>$(document).ready(function(){fancyAlert('目前無相關資料', function(){document.location.href=('https://www.goldenhorse.org.tw');});});</script>
<noscript><a href='https://www.goldenhorse.org.tw'>未自動轉跳，請按這裡。</a></noscript>`;
