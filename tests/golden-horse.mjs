import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoldenHorseDay, loadGoldenHorse, refreshScreeningFeed, FestivalNotReady } from '../lib/festival-sources.mjs';
import { emptyScreeningFeed, sourceState, matchesScreening, SCREENINGS_KEY, saveFestivalSession, readFestivalSessions, resolveFestivalSessions, availableScreenings } from '../lib/festival-screenings.mjs';
import { exportCalendar, conflicts } from '../lib/festival-calendar.mjs';
import { goldenFestival as f, goldenRow, goldenHTML } from './golden-horse-fixture.mjs';
import { goldenNoData, xrFixture } from './festival-screenings-fixture.mjs';
const now = Date.parse('2026-10-25T00:00:00Z');
const parse = html => parseGoldenHorseDay(html, f, f.startDate);
const dayPage = url => {
  const date = new URL(url).searchParams.get('search_date');
  return goldenHTML({ date, rows: [goldenRow({ ticket: '2' + date.slice(-2) })] });
};
test('Golden Horse reads one table row once, stable ticket ID, hall, scoped marks and estimated overnight end', () => {
  const [row] = parse(goldenHTML());
  assert.equal(row.id, 'golden-horse-2026:ticket-200'); assert.equal(row.programId, '100');
  assert.equal(row.cinema, '台北信義威秀'); assert.equal(row.hall, '11廳');
  assert.equal(row.mins, 1410); assert.equal(row.endMins, 1500); assert.equal(row.endKind, 'runtime');
  assert.deepEqual(row.notes, ['影人出席', '級別：12+']);
  assert.equal(row.url, f.programUrl + '?search_date=2026-11-06');
  assert.equal(globalThis.untrustedGoldenHorseScriptExecuted, undefined);
  const retimed = parse(goldenHTML({ rows: [goldenRow({ time: '23:40', hall: '12廳' })] }))[0];
  assert.equal(retimed.id, row.id); assert.notEqual(retimed.endMins, row.endMins);
  const other = parse(goldenHTML({ rows: [goldenRow(), goldenRow({ ticket: '201', hall: '12廳' })] }));
  assert.equal(other.length, 2); assert.notEqual(other[0].id, other[1].id);
});
test('Golden Horse short compilations remain a single slot and each member is searchable', () => {
  const [row] = parse(goldenHTML({ rows: [goldenRow({ movie: '【短片合輯】', members: [{ id: '101', title: '星空' }, { id: '100', title: '晨光' }] })] }));
  assert.equal(row.movie, '【短片合輯】'); assert.equal(row.programId, '100-101'); assert.equal(row.films.length, 2);
  assert.ok(matchesScreening(row, '星空')); assert.ok(matchesScreening(row, '晨光'));
});
test('Golden Horse explicitly excludes events and industry, not public films with no ticket URL', () => {
  const rows = parse(goldenHTML({ rows: [goldenRow({ ticket: null }), goldenRow({ ticket: null, event: true, movie: '電影沙龍' }), goldenRow({ ticket: null, industry: true })] }));
  assert.equal(rows.length, 1); assert.match(rows[0].id, /:placement-[a-f0-9]{32}$/);
  assert.ok(rows[0].notes.some(n => n.includes('不代表免票或有空位')));
  const other = parse(goldenHTML({ rows: [goldenRow({ ticket: null })], cinema: '台中iFG遠雄廣場威秀' }))[0];
  assert.notEqual(other.id, rows[0].id);
  assert.deepEqual(parse(goldenHTML({ rows: [goldenRow({ ticket: null, event: true })] })), []);
  assert.throws(() => parse(goldenHTML({ rows: [goldenRow({ event: true })] })));
  assert.throws(() => parse(goldenHTML({ rows: [goldenRow({ industry: true })] })));
});
test('Golden Horse rejects wrong edition, category, ambiguous or incomplete date manifest and day fallback', () => {
  const html = goldenHTML();
  for (const bad of [html.replace('value="2026-11-06"', 'value="2026-11-07"'),
    html.replaceAll('2026', '2025'), html.replace('search_category=FF', 'search_category=GH'),
    html.replace('search_year=2026&', 'search_year=2026&search_year=2025&'),
    html.replace('26_ghmf', '25_ghmf'), html.replace('"2026-11-7",', ''),
    html.replace('"2026-11-7"', '"2026-11-6"'), html.replace('"2026-11-7"', '"2026-12-7"'),
    html.replace('var availableDates =', 'var differentDates ='),
    html.replace('</body>', '<script>var availableDates = [];</script></body>')]) assert.throws(() => parse(bad));
  assert.throws(() => parseGoldenHorseDay(html, f, '2026-02-30'));
  assert.throws(() => parseGoldenHorseDay(html, f, '2026-10-06'));
});
test('Golden Horse fails closed on partial tables, unsafe links, duplicates and unknown row shapes', () => {
  const html = goldenHTML();
  for (const bad of [html.replace('</html>', ''), html.replace('class="time"', 'class="changed"'),
    html.replace('<td class="add">', '<td>'), html.replace('11廳', ''), html.replace('90分', '?分'),
    html.replace('90分', '0分'), html.replace('90分', '601分'), html.replace('23:30', '24:30'),
    html.replace('12+', '未定'), html.replace('show-list', 'unknown-list'), html.replace('<th colspan="4">台北信義威秀</th>', ''),
    html.replace('https://www.goldenhorse.org.tw/film/programme', 'https://evil.example/film/programme'),
    html.replace('https://www.goldenhorse.org.tw/film/programme', 'https://user:password@www.goldenhorse.org.tw/film/programme'),
    html.replace('https://tghff.tixcraft.com/ticket', 'javascript:ticket'),
    goldenHTML({ rows: [goldenRow(), goldenRow()] }), goldenHTML({ rows: [] }),
    goldenHTML({ rows: [goldenRow({ members: [{ id: '100', title: '晨光' }, { id: '100', title: '星空' }] })] })]) assert.throws(() => parse(bad));
});
test('Golden Horse preserves exact pre-publication pending, never mislabels a broken page as not published', () => {
  assert.throws(() => parse(goldenNoData), FestivalNotReady);
  for (const bad of ['', '<html>503</html>', goldenNoData.replace('目前無相關資料', '系統錯誤'), goldenHTML().replace('id="content"', 'id="other"')]) {
    assert.throws(() => parse(bad), error => !(error instanceof FestivalNotReady));
  }
});
test('Golden Horse loader covers every explicit day once and never returns a partially successful edition', async () => {
  const calls = [];
  const rows = await loadGoldenHorse(f, async url => { calls.push(url); return dayPage(url); });
  assert.equal(calls.length, 17); assert.equal(new Set(calls).size, 17); assert.equal(rows.length, 17);
  assert.equal(rows[0].date, '2026-11-06'); assert.equal(rows.at(-1).date, '2026-11-22');
  await assert.rejects(loadGoldenHorse(f, async url => {
    if (url.endsWith('11-22')) throw new Error('last day network failure');
    return dayPage(url);
  }));
  await assert.rejects(loadGoldenHorse(f, async () => goldenHTML()));
  await assert.rejects(loadGoldenHorse(f, async url => dayPage(url).replace(/_ghmf\/2\d{2}/g, '_ghmf/200')));
});
test('Golden Horse pending becomes current only after all days; any later loss preserves saved rows and timestamp', async () => {
  const prior = emptyScreeningFeed([f]); prior.sources[0].attemptedAt = new Date(now - 1000).toISOString();
  const good = await refreshScreeningFeed({ festivals: [f], previous: prior, now: () => now, loaders: { [f.id]: festival => loadGoldenHorse(festival, async url => dayPage(url)) } });
  assert.equal(sourceState(good.sources[0], now), 'current'); assert.equal(good.sources[0].rows.length, 17);
  for (const loader of [async () => { throw new FestivalNotReady('no data'); }, async () => [],
    async () => good.sources[0].rows.slice(0, 5), festival => loadGoldenHorse(festival, async url => {
      if (url.endsWith('11-22')) throw new Error('timeout'); return dayPage(url);
    })]) {
    const failed = await refreshScreeningFeed({ festivals: [f], previous: good, now: () => now + 1000, loaders: { [f.id]: loader } });
    assert.equal(failed.sources[0].status, 'failed'); assert.deepEqual(failed.sources[0].rows, good.sources[0].rows);
    assert.equal(failed.sources[0].fetchedAt, good.sources[0].fetchedAt);
    assert.equal(sourceState(failed.sources[0], now + 1000), 'unverified');
  }
});
test('Golden Horse save and ICS use the one actual slot, UTC runtime end and explicit change confirmation', async () => {
  const [row] = parse(goldenHTML());
  const map = new Map([['kaiyan.sessions', 'keep ordinary'], ['kaiyan.favorites', 'keep movies']]);
  const store = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  saveFestivalSession(store, row); assert.deepEqual(readFestivalSessions(store), [row]);
  const feed = emptyScreeningFeed([f]);
  Object.assign(feed.sources[0], { status: 'ok', fetchedAt: new Date(now).toISOString(), attemptedAt: new Date(now).toISOString(), rows: [row] });
  const sessions = resolveFestivalSessions([row], feed, [f], {}, now);
  const ics = await exportCalendar({ sessions, now });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /DTSTART:20261106T153000Z/); assert.match(ics, /DTEND:20261106T170000Z/);
  feed.sources[0].rows = [{ ...row, mins: 1420, endMins: 1510 }];
  const changed = resolveFestivalSessions([row], feed, [f], {}, now);
  assert.equal(changed[0].state, 'changed'); assert.equal(changed[0].end, null);
  assert.doesNotMatch(await exportCalendar({ sessions: changed, now }), /BEGIN:VEVENT/);
  assert.deepEqual(JSON.parse(map.get(SCREENINGS_KEY)), [row]);
  assert.equal(map.get('kaiyan.sessions'), 'keep ordinary'); assert.equal(map.get('kaiyan.favorites'), 'keep movies');
});
test('Golden Horse cannot spend the existing XR request budget and published source order stays stable', async () => {
  const { feed, catalog } = xrFixture(), calls = [], future = Date.parse('2099-01-01T04:00:00Z');
  const next = await refreshScreeningFeed({ festivals: catalog.festivals, previous: feed, now: () => future,
    loaders: { 'golden-horse-2026': async () => { calls.push('golden'); throw new Error('slow day failed'); },
      'kff-2026': async () => { calls.push('regular'); return feed.sources[1].rows; },
      'kff-2026:xr': async () => { calls.push('xr'); return feed.extraSources[0].rows; } } });
  assert.deepEqual(calls, ['regular', 'xr', 'golden']);
  assert.deepEqual(next.sources.map(s => s.festivalId), catalog.festivals.map(f => f.id));
  assert.equal(next.extraSources[0].status, 'ok'); assert.deepEqual(next.extraSources[0].rows, feed.extraSources[0].rows);
});
test('Golden Horse reviewed cinema names share transfer identity with the ordinary cinema, without merging slots', () => {
  for (const [cinema, canonical] of [['MUVIE', 'MUVIE CINEMAS台北松仁威秀'], ['台中iFG遠雄廣場威秀', '台中iFG遠雄廣場威秀影城'], ['高雄大遠百威秀', '高雄大遠百威秀影城']]) {
    const rows = parse(goldenHTML({ cinema })), feed = emptyScreeningFeed([f]);
    Object.assign(feed.sources[0], { status: 'ok', rows, fetchedAt: new Date(now).toISOString() });
    const [s] = availableScreenings(feed, [f], {}, now);
    assert.equal(s.cinema, cinema); assert.equal(s.venueKey, canonical);
    const ordinary = { key: 'ordinary', state: 'current', start: s.end + 300000, venueKey: canonical };
    assert.deepEqual(conflicts([s, ordinary], 15), []);
    ordinary.venueKey = '另一戲院'; assert.equal(conflicts([s, ordinary], 15)[0].kind, 'transfer');
  }
});
