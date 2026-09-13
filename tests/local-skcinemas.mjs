import test from 'node:test';
import assert from 'node:assert/strict';
import { SK_CINEMAS, selectScheduleRows } from '../lib/cinema-coverage.mjs';
import { validateLocalSnapshot, mergeLocalSnapshot, snapshotRecord, localUploadDue, latestLocalSlot,
  skcinemasUrl, MAX_SNAPSHOT_BYTES } from '../lib/local-skcinemas.mjs';

const stamp = '2026-09-13T02:00:00.000Z';
const now = Date.parse('2026-09-13T03:00:00.000Z');
function fixture(at = stamp) {
  return {
    schemaVersion: 1, source: 'skcinemas', generatedAt: at,
    cinemas: SK_CINEMAS.map(c => ({ ...c, state: 'ok', attemptedAt: at, lastSuccessAt: at })),
    records: SK_CINEMAS.flatMap(c => ['2026-09-13', '2026-09-24'].map((date, i) => ({
      source: 'skcinemas', cinema: c.name, area: c.area, movie: '驀然回首(真人版)', rawMovie: '驀然回首(真人版)',
      sourceMovieId: 'HO00004925', sourceSessionId: `s${i}`, sourceUrl: skcinemasUrl(c.id),
      date, time: '19:00', rating: '普遍級', hall: null, tags: ['數位版'], url: skcinemasUrl(c.id), fetchedAt: at,
    }))),
  };
}

test('本機快照：五館、多日與原始時間可驗證，未上傳個人或未知欄位', () => {
  const f = fixture();
  const s = validateLocalSnapshot(JSON.stringify(f), { now });
  assert.equal(s.records.length, 10);
  assert.equal(s.records[0].fetchedAt, stamp);
  assert.equal(snapshotRecord({ ...f.records[0], token: 'DO_NOT_PUBLISH', privatePath: '/private' }).token, undefined);
  assert.equal(JSON.stringify(snapshotRecord({ ...f.records[0], token: 'DO_NOT_PUBLISH' })).includes('DO_NOT_PUBLISH'), false);
});

test('本機快照：拒收未知來源、館別、私人欄位和外部網址', () => {
  for (const change of [
    f => { f.token = 'private'; },
    f => { f.records[0].cookie = 'private'; },
    f => { f.source = 'other'; },
    f => { f.schemaVersion = 99; },
    f => { f.cinemas[0].id = '9999'; },
    f => { f.cinemas[0].name = '不存在影城'; },
    f => { f.records[0].area = '台中市'; },
    f => { f.records[0].source = 'atmovies'; },
    f => { f.records[0].sourceUrl = 'https://example.com'; },
    f => { f.records[0].url = 'javascript:alert(1)'; },
    f => { f.records[0].url = skcinemasUrl('1005'); },
  ]) {
    const f = fixture(); change(f);
    assert.throws(() => validateLocalSnapshot(f, { now }));
  }
});

test('本機快照：拒收未來時間、無效日期、超長資料和重複場次', () => {
  for (const change of [
    f => { f.generatedAt = '2099-01-01T00:00:00.000Z'; },
    f => { f.records[0].fetchedAt = '2026-09-13T01:00:00.000Z'; },
    f => { f.records[0].date = '2026-02-30'; },
    f => { f.records[0].date = '2026-01-01'; },
    f => { f.records[0].date = '2027-09-24'; },
    f => { f.records[0].time = '24:59'; },
    f => { f.records[0].sourceSessionId = ''; },
    f => { f.records[0].movie = 'x'.repeat(241); },
    f => { f.records[0].tags = ['bad\ncontrol']; },
    f => { f.records.push(f.records[0]); },
    f => { f.records = f.records.filter(r => r.cinema !== SK_CINEMAS[0].name); },
  ]) {
    const f = fixture(); change(f);
    assert.throws(() => validateLocalSnapshot(f, { now }));
  }
  assert.throws(() => validateLocalSnapshot(' '.repeat(MAX_SNAPSHOT_BYTES + 1), { now }), /過大/);
});

test('本機補充在雲端官方失敗後納入，保留時間，補上開眼沒有的遠期日期', () => {
  const s = fixture();
  const result = mergeLocalSnapshot(s, [], { fetchedAt: new Date(now).toISOString(), cinemas: {} }, { now });
  assert.equal(result.imported.length, 5);
  assert.equal(result.source.fetchedAt, stamp, '下載／匯入時間不得把快照洗新');
  assert.equal(result.source.cinemas[SK_CINEMAS[0].name].lastSuccessAt, stamp);
  assert.equal(result.source.cinemas[SK_CINEMAS[0].name].fetchMethod, 'local-snapshot');
  assert.equal(result.records[0].movieIdentity, 'look-back-2026');
  const backup = { ...s.records[0], source: 'atmovies', fetchedAt: new Date(now).toISOString() };
  const selected = selectScheduleRows([...result.records, backup], { skcinemas: result.source }, now);
  assert.equal(selected.filter(r => r.cinema === backup.cinema).length, 2);
  assert.equal(selected.some(r => r.source === 'atmovies'), false);
  assert.equal(selected.some(r => r.date === '2026-09-24'), true);
});

test('較新的直接官方結果優先，不讓本機較舊快照倒蓋；其他館仍可補', () => {
  const s = fixture();
  const newer = { ...s.records[0], fetchedAt: new Date(now).toISOString(), time: '20:00' };
  const status = { cinemas: { [newer.cinema]: { state: 'ok', lastSuccessAt: newer.fetchedAt } } };
  const result = mergeLocalSnapshot(s, [newer], status, { now });
  assert.equal(result.imported.length, 4);
  assert.equal(result.records.find(r => r.cinema === newer.cinema).time, '20:00');
  assert.equal(result.source.cinemas[newer.cinema].lastSuccessAt, newer.fetchedAt);
});

test('單館本機失敗不變新鮮成功，近期使用開眼，保留尚未過期的遠期資料', () => {
  const s = fixture();
  s.cinemas[0].state = 'failed';
  s.cinemas[0].attemptedAt = new Date(now).toISOString();
  s.generatedAt = new Date(now).toISOString();
  const result = mergeLocalSnapshot(s, [], {}, { now });
  const name = s.cinemas[0].name;
  assert.equal(result.source.cinemas[name].state, 'failed');
  assert.equal(result.source.cinemas[name].lastSuccessAt, stamp);
  const backup = { ...s.records[0], source: 'atmovies', fetchedAt: new Date(now).toISOString() };
  const selected = selectScheduleRows([...result.records, backup], { skcinemas: result.source }, now);
  assert.equal(selected.find(r => r.cinema === name && r.date === backup.date).source, 'atmovies');
  assert.equal(selected.find(r => r.cinema === name && r.date === '2026-09-24').source, 'skcinemas');
});

test('本機離線超過 26 小時不搶備援；超過 72 小時完全不匯入', () => {
  const s = fixture();
  const aged = mergeLocalSnapshot(s, [], {}, { now: now + 27 * 3600000 });
  assert.equal(aged.source.cinemas[SK_CINEMAS[0].name].state, 'failed');
  assert.equal(aged.source.cinemas[SK_CINEMAS[0].name].lastSuccessAt, stamp);
  assert.equal(aged.records.some(r => r.date === '2026-09-13'), false);
  const expired = mergeLocalSnapshot(s, [], {}, { now: now + 73 * 3600000 });
  assert.equal(expired.imported.length, 0);
  assert.equal(expired.records.length, 0);
});

test('本機排程：台北早晚兩次、登入補跑去重，跨日不依賴系統時區', () => {
  const ms = s => Date.parse(`2026-09-13T${s}+08:00`);
  assert.equal(latestLocalSlot(ms('04:59:00')), Date.parse('2026-09-12T17:05:00+08:00'));
  assert.equal(latestLocalSlot(ms('05:05:00')), ms('05:05:00'));
  assert.equal(latestLocalSlot(ms('17:05:00')), ms('17:05:00'));
  assert.equal(localUploadDue(undefined, ms('10:00:00')), true);
  assert.equal(localUploadDue('2026-09-13T05:06:00+08:00', ms('10:00:00')), false);
  assert.equal(localUploadDue('2026-09-13T05:06:00+08:00', ms('17:05:00')), true);
  assert.equal(localUploadDue('2026-09-13T18:00:00+08:00', ms('17:05:00')), true, '本機時钟不正常時不能永遠停止更新');
});
