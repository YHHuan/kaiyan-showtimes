import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateFestivals, validDate, monthDays, shiftMonth, taipeiDate, inPeriod, reviewOld, safeUrl, FOLLOW_KEY,
  readFollows, toggleFollow, readSavedSessions, savedKey, startTime, scheduleIndex, resolveSaved, conflicts, exportCalendar } from '../lib/festival-calendar.mjs';
import { festivalFixture, now } from './festival-fixture.mjs';
function memory(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { writes: [], getItem: k => map.get(k) ?? null, setItem(k, v) { this.writes.push(k); map.set(k, v); } };
}
test('影展只收核實檔期與安全來源，四檔正式 catalog 合法', async () => {
  const catalog = JSON.parse(await readFile(new URL('../catalog/festivals.json', import.meta.url), 'utf8'));
  validateFestivals(catalog);
  assert.equal(catalog.festivals.length, 4);
  const badValues = [{ startDate: '2026-02-30' }, { endDate: '2020-01-01' }, { sourceUrl: 'javascript:alert(1)' },
    { url: 'https://person:password@example.org' }, { inventedScreenings: [] }, { checkedAt: 'yesterday' }, { cities: [] }];
  for (const patch of badValues) {
    const bad = structuredClone(catalog); Object.assign(bad.festivals[0], patch);
    assert.throws(() => validateFestivals(bad));
  }
  assert.throws(() => validateFestivals({ version: 1, festivals: [catalog.festivals[0], catalog.festivals[0]] }));
  assert.equal(safeUrl('data:text/html,evil'), '');
});
test('月曆涵蓋閏日、跨年、月份邊界；台北日期不依裝置時區', () => {
  assert.equal(validDate('2100-02-29'), false);
  assert.equal(validDate('2000-02-29'), true);
  assert.equal(monthDays('2028-02').length, 42);
  assert.ok(monthDays('2028-02').includes('2028-02-29'));
  assert.equal(new Date(monthDays('2028-02')[0]).getUTCDay(), 0);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('1900-01', -1), '1900-01');
  assert.equal(taipeiDate(Date.parse('2026-10-05T16:01:00Z')), '2026-10-06');
  assert.throws(() => monthDays('2026-99'));
});
test('影展期間含最後一天，但不宣稱有場次；核對日期不隨建站刷新', () => {
  const { catalog } = festivalFixture(), f = catalog.festivals[0];
  assert.equal(inPeriod('2099-01-05', f), true);
  assert.equal(inPeriod('2099-01-06', f), false);
  assert.equal(reviewOld(f, '2099-01-25'), true);
  assert.equal(reviewOld(f, '2099-01-01'), false);
});
test('關注影展使用新 key，保留其他分頁／已退役 ID；壞儲存不能被覆蓋', () => {
  const storage = memory({ [FOLLOW_KEY]: '["retired-event"]', 'kaiyan.sessions': '["original"]' });
  toggleFollow(storage, 'test-one');
  storage.setItem(FOLLOW_KEY, '["retired-event","test-one","another-tab"]');
  assert.deepEqual(toggleFollow(storage, 'test-one'), ['retired-event', 'another-tab']);
  assert.ok(storage.writes.every(k => k === FOLLOW_KEY));
  assert.equal(storage.getItem('kaiyan.sessions'), '["original"]');
  const broken = memory({ [FOLLOW_KEY]: '{broken' });
  assert.throws(() => toggleFollow(broken, 'test-one'));
  assert.deepEqual(broken.writes, []);
  assert.throws(() => readFollows({ getItem() { throw new Error('blocked'); } }));
});
test('既有收藏僅唯讀：新版、舊版、別名與污染標籤去重，不遷移或覆寫', () => {
  const { data, saved } = festivalFixture();
  const alias = { ...saved[0], movie: '舊片名', cinema: '舊戲院', tag: '字幕版・© @movies All rights reserved 開眼電影網版權所有' };
  const storage = memory({ 'kaiyan.favorites': JSON.stringify({ movies: ['保留電影'], sessions: [saved[0], alias] }) });
  assert.equal(readSavedSessions(storage, data).length, 1);
  assert.deepEqual(storage.writes, []);
  storage.setItem('kaiyan.sessions', '[]');
  assert.deepEqual(readSavedSessions(storage, data), [], 'empty separate list takes precedence');
  assert.equal(savedKey(saved[0], data), savedKey(alias, data));
  assert.throws(() => readSavedSessions(memory({ 'kaiyan.sessions': '{bad' }), data));
});
test('損壞日期／時間收藏不列入，合法 24 點之後轉為真正次日', () => {
  const { saved } = festivalFixture();
  const s = { ...saved[0], mins: 1500 };
  const storage = memory({ 'kaiyan.sessions': JSON.stringify([s, { ...s, date: '2099-02-31' }, { ...s, mins: 2880 }, { ...s, mins: -1 }, null]) });
  assert.deepEqual(readSavedSessions(storage), [s]);
  assert.equal(taipeiDate(startTime(s)), '2099-01-02');
});
test('場次對照支援座位欄、null 標籤／廳別與兩種訂票日期模板', () => {
  const { data, saved } = festivalFixture();
  data.packed += ',1'; // Optional seat data must not change session identity.
  const index = scheduleIndex(data);
  const result = resolveSaved(saved, data, index, data.updatedAt, now);
  assert.equal(result.find(s => s.movie === '晚場電影').url, 'https://example.org/book?date=2099-01-01');
  assert.equal(result.find(s => s.movie === '續場電影').url, 'https://example.org/book?date=2099%2F01%2F02');
  assert.equal(result.find(s => s.movie === '雙入口合輯').state, 'ambiguous');
  assert.equal(result.find(s => s.movie === '本輪沒有的收藏').state, 'missing');
  assert.equal(result.find(s => s.movie === '片長未提供').end, null);
  assert.throws(() => scheduleIndex({ ...data, packed: '0,0,999,0,0,0,100' }));
});
test('過期建站、失聯或已開演收藏不能帶出旧購票連結或可核對狀態', () => {
  const { data, saved } = festivalFixture(), index = scheduleIndex(data);
  const result = resolveSaved(saved, data, index, new Date(now - 73 * 3600000).toISOString(), now);
  assert.ok(result.every(s => s.state === 'stale' && !s.url && !s.end));
  const old = resolveSaved(saved, data, index, data.updatedAt, now + 3 * 86400000);
  assert.ok(old.every(s => s.state === 'past' && !s.url));
});
test('跨午夜撞期、轉場邊界和片長未知，不能假裝已核算完整行程', () => {
  const { data, saved } = festivalFixture();
  const sessions = resolveSaved(saved, data, scheduleIndex(data), data.updatedAt, now);
  assert.equal(conflicts(sessions).filter(c => c.kind === 'overlap').length, 1);
  const a = sessions.find(s => s.movie === '晚場電影'), b = sessions.find(s => s.movie === '續場電影');
  assert.equal(taipeiDate(a.end), '2099-01-02');
  assert.equal(conflicts([a, { ...b, start: a.end + 14 * 60000 }], 15)[0].kind, 'transfer');
  assert.deepEqual(conflicts([a, { ...b, start: a.end + 15 * 60000 }], 15), []);
  assert.deepEqual(conflicts([a, { ...b, cinema: a.cinema, venueKey: a.venueKey, start: a.end }], 15), []);
  assert.deepEqual(conflicts(sessions.filter(s => s.movie === '片長未提供')), []);
});
test('戲院舊名稱不會被誤判成需要轉場，關注容量上限不寫入無法讀回的狀態', () => {
  const { data, saved } = festivalFixture();
  const [a] = resolveSaved([{ ...saved[0], cinema: '舊戲院' }], data, scheduleIndex(data), data.updatedAt, now);
  assert.equal(a.venueKey, '測試影城');
  const b = { ...a, key: 'another', cinema: '測試影城', start: a.end + 60000 };
  assert.deepEqual(conflicts([a, b]), []);
  const storage = memory({ [FOLLOW_KEY]: JSON.stringify(Array.from({ length: 1000 }, (_, i) => 'festival-' + i)) });
  assert.throws(() => toggleFollow(storage, 'new-festival'));
  assert.deepEqual(storage.writes, []);
});
test('影展 ICS 是全天檔期，DTEND 不含尾日；跨年完整保留、UID 穩定', async () => {
  const { catalog } = festivalFixture();
  const ics = await exportCalendar({ festivals: [catalog.festivals[0]], now });
  assert.match(ics, /DTSTART;VALUE=DATE:20981230/);
  assert.match(ics, /DTEND;VALUE=DATE:20990106/);
  assert.match(ics, /TRANSP:TRANSPARENT/);
  const again = await exportCalendar({ festivals: [catalog.festivals[0]], now: now + 86400000 });
  assert.equal(ics.match(/UID:([^\r]+)/)[1], again.match(/UID:([^\r]+)/)[1]);
});
test('場次 ICS 用 UTC 保留台灣時間；不匯出歧義／過期／缺漏，未知片長不捏造散場', async () => {
  const { data, saved } = festivalFixture();
  const sessions = resolveSaved(saved, data, scheduleIndex(data), data.updatedAt, now);
  const ics = await exportCalendar({ sessions, now });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.match(ics, /DTSTART:20990101T153000Z/);
  assert.match(ics, /DTEND:20990101T172200Z/);
  assert.doesNotMatch(ics, /雙入口|本輪沒有/);
  const unknown = await exportCalendar({ sessions: sessions.filter(s => s.movie === '片長未提供'), now });
  assert.doesNotMatch(unknown, /DTEND/);
  const expired = await exportCalendar({ sessions, now: now + 3 * 86400000 });
  assert.doesNotMatch(expired, /BEGIN:VEVENT/);
});
test('ICS 跳脫換行／逗點與 Unicode 75-octet 摺行，使用穩定內容而非索引產生 UID', async () => {
  const { data, saved } = festivalFixture();
  const [session] = resolveSaved([saved[0]], data, scheduleIndex(data), data.updatedAt, now);
  const value = { ...session, movie: '長片名😀'.repeat(30) + '\r\nBEGIN:VEVENT,;' };
  const ics = await exportCalendar({ sessions: [value], now });
  assert.equal((ics.match(/^BEGIN:VEVENT/gm) || []).length, 1);
  assert.match(ics.replace(/\r\n /g, ''), /\\nBEGIN:VEVENT\\,\\;/);
  assert.ok(ics.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  assert.equal(ics.match(/UID:([^\r]+)/)[1], (await exportCalendar({ sessions: [session], now })).match(/UID:([^\r]+)/)[1]);
});
