import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTIAF, parseWMW, parseKFFDay, refreshScreeningFeed, editionDays } from '../lib/festival-sources.mjs';
import { SCREENINGS_KEY, validateScreeningFeed, validateScreening, sourceState, readFestivalSessions, saveFestivalSession,
  removeFestivalSession, availableScreenings, resolveFestivalSessions, matchesScreening } from '../lib/festival-screenings.mjs';
import { conflicts, exportCalendar } from '../lib/festival-calendar.mjs';
import { now } from './festival-fixture.mjs';
import { screeningFixture, parserFestival, tiafHTML, wmwHTML, wmwScript, wmwEvent, kffJSON } from './festival-screenings-fixture.mjs';
const storage = initial => {
  const map = new Map(Object.entries(initial || {}));
  return { getItem: k => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, v), map };
};
test('TIAF decodes whole compilations, hall, notes and program members without splitting', () => {
  const rows = parseTIAF(tiafHTML(), parserFestival);
  assert.equal(rows.length, 1); assert.equal(rows[0].mins, 750); assert.equal(rows[0].hall, '2廳');
  assert.equal(rows[0].programId, '10-11'); assert.equal(rows[0].movie, '晨光＋星空');
  assert.deepEqual(rows[0].notes, ['映後座談', '親子友善專場']);
  assert.notEqual(rows[0].id, parseTIAF(tiafHTML({ time: '13:30' }), parserFestival)[0].id);
});
test('TIAF blank official program IDs use full session placement, never a title-only match', () => {
  const row = parseTIAF(tiafHTML({ ids: '' }), parserFestival)[0];
  assert.match(row.programId, /^label-/);
  assert.notEqual(row.id, parseTIAF(tiafHTML({ ids: '', time: '13:30' }), parserFestival)[0].id);
});
test('TIAF rejects edition, weekday, time, partial and layout drift', () => {
  for (const html of [tiafHTML({ year: 2025 }), tiafHTML({ day: '10.3 Sun.' }), tiafHTML({ time: '24:15' }),
    tiafHTML().replace('</html>', ''), tiafHTML().replace('class="time"', 'class="changed"'), tiafHTML({ ids: 'oops' })]) {
    assert.throws(() => parseTIAF(html, parserFestival));
  }
});
test('WMW offsets start at 08:00 and site IDs map to actual hall labels', () => {
  const [row] = parseWMW(wmwHTML(), parserFestival, wmwScript);
  assert.equal(row.mins, 860); assert.equal(row.hall, '2廳'); assert.equal(row.endMins, 951);
  assert.equal(row.films.length, 2); assert.deepEqual(row.notes, ['映後 QA 影片']);
  assert.equal(parseWMW(wmwHTML([wmwEvent, { ...wmwEvent, state: false }]), parserFestival, wmwScript).length, 1);
});
test('WMW rejects renderer drift, arbitrary JS, wrong site/date and bad URLs', () => {
  assert.throws(() => parseWMW(wmwHTML(), parserFestival, wmwScript.replace('8, 0', '9, 0')));
  assert.throws(() => parseWMW(wmwHTML().replace('var events = [', 'var events = [process.exit(),'), parserFestival, wmwScript));
  for (const event of [{ ...wmwEvent, start: -10 }, { ...wmwEvent, site: 'site99' }, { ...wmwEvent, date: '11/16' },
    { ...wmwEvent, film: '<a href="javascript:alert(1)">bad</a>' }]) assert.throws(() => parseWMW(wmwHTML([event]), parserFestival, wmwScript));
});
test('KFF uses stable session ID, preserves compilations, official end/overnight and source marks', () => {
  const data = kffJSON();
  const [row] = parseKFFDay(data, parserFestival, '2026-10-09', new Map([['1', '影人出席']]));
  assert.equal(row.id, 'fixture-2026:100'); assert.equal(row.endMins, 1470); assert.equal(row.endKind, 'official');
  assert.equal(row.films.length, 2); assert.deepEqual(row.notes, ['影人出席']);
  assert.doesNotMatch(JSON.stringify(row), /synopses|brief|_detail/);
  data[108][0].cinemas[0].auditoriums[0].programs[0].start_time = '23:40';
  assert.equal(parseKFFDay(data, parserFestival, '2026-10-09')[0].id, row.id);
});
test('KFF rejects wrong day, source identity or edition and treats explicit empty day distinctly', () => {
  assert.throws(() => parseKFFDay(kffJSON(), parserFestival, '2026-10-10'));
  for (const mutate of [s => s.cate = 109, s => s.cinema = 10, s => s.belong = 99,
    s => s.belong_program.film_row[0].year = '2025', s => s.belong_program.status = 0]) {
    const data = kffJSON(); mutate(data[108][0].cinemas[0].auditoriums[0].programs[0]);
    assert.throws(() => parseKFFDay(data, parserFestival, '2026-10-09'));
  }
  assert.deepEqual(parseKFFDay({ 108: [{ date: '2026-10-09', cinemas: [] }] }, parserFestival, '2026-10-09'), []);
});
test('KFF published award program without announced films remains one truthful slot', () => {
  const data = kffJSON(), p = data[108][0].cinemas[0].auditoriums[0].programs[0].belong_program;
  p.film_row = []; p.time_length = null; p.title = '得獎精選';
  const [row] = parseKFFDay(data, parserFestival, '2026-10-09');
  assert.equal(row.movie, '得獎精選'); assert.deepEqual(row.films, []); assert.equal(row.runtime, null);
  assert.equal(row.endKind, 'official'); assert.ok(row.notes.includes('本場片單尚未提供，請見官方'));
});
test('provider fetch is atomic, preserves real last-good time on partial/empty/drop failure', async () => {
  const { catalog, source, feed } = screeningFixture();
  for (const loader of [async () => { throw new Error('one day failed'); }, async () => [], async () => [source.rows[0]]]) {
    const next = await refreshScreeningFeed({ festivals: catalog.festivals, previous: feed, loaders: { 'test-one': loader }, now: () => now + 60000 });
    const s = next.sources[0]; assert.equal(s.status, 'failed'); assert.deepEqual(s.rows, source.rows);
    assert.equal(s.fetchedAt, source.fetchedAt); assert.notEqual(s.attemptedAt, source.attemptedAt);
    assert.equal(sourceState(s, now + 60000), 'unverified');
  }
});
test('success uses actual completion time; independent provider failure does not erase it', async () => {
  const { catalog, source, feed } = screeningFixture(); let clock = now;
  const next = await refreshScreeningFeed({ festivals: catalog.festivals, previous: feed, now: () => clock,
    loaders: { 'test-one': async () => { clock += 10000; return source.rows; }, 'test-two': async () => { throw new Error('offline'); } } });
  assert.equal(next.sources[0].fetchedAt, new Date(now + 10000).toISOString()); assert.equal(next.sources[0].status, 'ok');
  assert.equal(next.sources[1].status, 'failed'); assert.deepEqual(next.sources[1].rows, []);
});
test('expired edition does not refetch/relabel a non-year-bound site; requests horizon bounded', async () => {
  const { catalog, feed } = screeningFixture(); let calls = 0;
  const next = await refreshScreeningFeed({ festivals: catalog.festivals, previous: feed, loaders: { 'test-one': async () => { calls++; return []; } }, now: () => Date.parse('2100-01-01') });
  assert.equal(calls, 0); assert.equal(next.sources[0].status, 'retired'); assert.equal(next.sources[0].fetchedAt, feed.sources[0].fetchedAt);
  assert.throws(() => editionDays({ startDate: '2026-01-01', endDate: '2026-03-01' }));
});
test('strict feed identity/date/URL/duplicate/unknown-field and size validation', () => {
  const { catalog, feed, row } = screeningFixture(); validateScreeningFeed(feed, catalog.festivals);
  for (const extra of [{ date: '2099-02-30' }, { mins: 1440 }, { endMins: 1390 }, { url: 'javascript:alert(1)' }, { id: 'another:1' }, { secret: 'no raw API blobs' }]) assert.throws(() => validateScreening({ ...row, ...extra }));
  const copy = structuredClone(feed); copy.sources[0].rows.push(copy.sources[0].rows[0]);
  assert.throws(() => validateScreeningFeed(copy, catalog.festivals));
});
test('new favorites only, rereads other-tab edits, preserves original and refuses corrupt/quota writes', () => {
  const { row, second } = screeningFixture(); const original = { 'kaiyan.sessions': '[{"original":true}]', 'kaiyan.favorites': '{"movies":["keep"]}' };
  const store = storage(original); saveFestivalSession(store, row); saveFestivalSession(store, second);
  assert.equal(readFestivalSessions(store).length, 2); removeFestivalSession(store, row.id); assert.deepEqual(readFestivalSessions(store), [second]);
  for (const [k, v] of Object.entries(original)) assert.equal(store.getItem(k), v);
  store.setItem(SCREENINGS_KEY, '{broken'); assert.throws(() => saveFestivalSession(store, row)); assert.equal(store.getItem(SCREENINGS_KEY), '{broken');
  const full = storage({ [SCREENINGS_KEY]: JSON.stringify([row]) }); full.setItem = () => { throw new Error('quota'); };
  assert.throws(() => removeFestivalSession(full, row.id)); assert.deepEqual(readFestivalSessions(full), [row]);
});
test('saved snapshot stays unchanged until explicit reconfirmation, missing is not cancellation', () => {
  const { row, feed, catalog } = screeningFixture(); const changed = structuredClone(feed);
  changed.sources[0].rows[0].mins += 10;
  let [s] = resolveFestivalSessions([row], changed, catalog.festivals, {}, now);
  assert.equal(s.state, 'changed'); assert.equal(s.mins, row.mins); assert.equal(s.replacement.mins, row.mins + 10);
  assert.equal(s.end, null); assert.equal(s.url, '');
  const store = storage(); saveFestivalSession(store, s.replacement);
  assert.equal(resolveFestivalSessions(readFestivalSessions(store), changed, catalog.festivals, {}, now)[0].state, 'current');
  changed.sources[0].rows = [];
  [s] = resolveFestivalSessions([row], changed, catalog.festivals, {}, now); assert.equal(s.state, 'missing'); assert.equal(s.movie, row.movie);
});
test('stale/future timestamp/failed source suppress exports, but saves remain readable', async () => {
  const { row, feed, catalog } = screeningFixture();
  for (const [extra, expected] of [[{ status: 'failed' }, 'unverified'], [{ fetchedAt: '2098-12-01T00:00:00Z' }, 'stale'], [{ fetchedAt: '2100-01-01T00:00:00Z' }, 'stale']]) {
    const copy = structuredClone(feed); Object.assign(copy.sources[0], extra);
    const sessions = resolveFestivalSessions([row], copy, catalog.festivals, {}, now);
    assert.equal(sessions[0].state, expected); assert.doesNotMatch(await exportCalendar({ sessions, now }), /BEGIN:VEVENT/);
  }
});
test('case-insensitive title/member search; same venue aliases and ordinary sessions can share conflicts', () => {
  const { row, feed, catalog } = screeningFixture();
  assert.ok(matchesScreening(row, 'ＴＷＯ')); assert.ok(matchesScreening(row, '晨光')); assert.equal(matchesScreening(row, 'not here'), false);
  const [s] = availableScreenings(feed, catalog.festivals, { 測試影城: '正式影城名' }, now);
  assert.equal(s.venueKey, '正式影城名');
  const ordinary = { key: 'ordinary', state: 'current', start: s.start + 900000, end: s.end, venueKey: s.venueKey };
  assert.deepEqual(conflicts([s, ordinary]), [{ a: s.key, b: ordinary.key, kind: 'overlap' }]);
});
test('selected screening ICS uses UTC official/runtime end, stable UID, not whole period or +12 minutes', async () => {
  const { row, feed, catalog } = screeningFixture();
  const sessions = resolveFestivalSessions([row], feed, catalog.festivals, {}, now);
  const ics = await exportCalendar({ sessions, now });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1); assert.match(ics, /DTSTART:20990101T151500Z/);
  assert.match(ics, /DTEND:20990101T161500Z/); assert.doesNotMatch(ics, /VALUE=DATE|12分鐘/);
  const again = await exportCalendar({ sessions, now: now + 1000 }); assert.equal(ics.match(/UID:(.+)/)[1], again.match(/UID:(.+)/)[1]);
});
test('reviewed festival venue aliases do not invent travel within the same physical cinema', () => {
  const { row, source, catalog } = screeningFixture();
  const f = { ...catalog.festivals[0], id: 'wmw-2026' };
  const s = { ...row, id: 'wmw-2026:100', festivalId: f.id, cinema: '光點華山' };
  const [resolved] = availableScreenings({ sources: [{ ...source, festivalId: f.id, rows: [s] }] }, [f], {}, now);
  assert.equal(resolved.venueKey, '光點華山電影館'); assert.equal(resolved.cinema, '光點華山');
  const ordinary = { key: 'ordinary', state: 'current', start: resolved.end + 300000, venueKey: '光點華山電影館' };
  assert.deepEqual(conflicts([resolved, ordinary], 15), []);
  ordinary.venueKey = '光點台北電影院'; assert.equal(conflicts([resolved, ordinary], 15)[0].kind, 'transfer');
});
test('removed source adapter cannot leave last-good data looking freshly verified', async () => {
  const { feed, catalog } = screeningFixture();
  const next = await refreshScreeningFeed({ festivals: catalog.festivals, previous: feed, loaders: {}, now: () => now });
  assert.equal(next.sources[0].status, 'unsupported'); assert.equal(next.sources[0].fetchedAt, feed.sources[0].fetchedAt);
  assert.equal(availableScreenings(next, catalog.festivals, {}, now)[0].state, 'missing');
});
