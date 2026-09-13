import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cinemaCoverage, selectScheduleRows, freshCinema } from '../lib/cinema-coverage.mjs';
import { saveRecords } from '../lib/common.mjs';

const now = Date.parse('2026-09-13T08:00:00+08:00'), stamp = new Date(now).toISOString();
const day = '2026-09-13';
const row = (source, cinema = '台北天母新光影城', date = day, fetchedAt = stamp) => ({ source, cinema, date, time: '10:55', movie: '測試片', fetchedAt });
const status = { skcinemas: { fetchedAt: stamp, count: 800, cinemas: {
  台北天母新光影城: { state: 'ok', lastSuccessAt: stamp },
  台中新光影城: { state: 'failed', lastSuccessAt: '2026-09-10T00:00:00Z' },
} }, atmovies: { fetchedAt: stamp, cinemas: {} } };

test('逐館逐日備援：全來源數量足夠也不能漏掉失敗分館或缺的日期', () => {
  const rows = [row('skcinemas'), row('atmovies'), row('atmovies', '台北天母新光影城', '2026-09-14'), row('atmovies', '台中新光影城')];
  const selected = selectScheduleRows(rows, status, now);
  assert.equal(selected.length, 3);
  assert.equal(selected[0].source, 'skcinemas');
  assert.equal(selected[1].date, '2026-09-14');
  assert.equal(selected[2].cinema, '台中新光影城');
  assert.equal(freshCinema(status, 'skcinemas', '台中新光影城', now), false);
});

test('新備援取代失敗官方的舊快取，不能同一天重複上架', () => {
  const rows = [row('skcinemas', '台中新光影城', day, '2026-09-12T00:00:00Z'), row('atmovies', '台中新光影城')];
  assert.deepEqual(selectScheduleRows(rows, status, now).map(r => r.source), ['atmovies']);
  const old = row('skcinemas', '台北天母新光影城', day, '2026-09-01T00:00:00Z');
  assert.equal(selectScheduleRows([old], status, now).length, 0, '來源時間戳很新也不能讓過期列復活');
});

test('午夜之後的有效日期缺口可見，缺館仍列在覆蓋名冊', () => {
  const s = { atmovies: { fetchedAt: stamp, cinemas: {
    天母: { state: 'ok', area: '台北市', lastSuccessAt: stamp },
    缺資料影城: { state: 'failed', area: '台中市', lastSuccessAt: stamp },
  } } };
  const before = cinemaCoverage([row('atmovies', '天母')], s, day, now);
  assert.equal(before.find(c => c.name === '天母').state, 'today-only');
  const after = cinemaCoverage([row('atmovies', '天母')], s, '2026-09-14', now + 86400000);
  assert.equal(after.find(c => c.name === '天母').state, 'missing');
  assert.equal(after.find(c => c.name === '缺資料影城').state, 'missing');
});

test('歷史覆蓋名冊與新場次使用相同縣市，不重複產生花蓮市／花蓮縣影城', () => {
  const s = { showtimes: { fetchedAt: stamp, cinemas: { 花蓮影城: { area: '花蓮市', state: 'ok', lastSuccessAt: stamp } } } };
  const rows = [{ ...row('showtimes', '花蓮影城'), area: '花蓮市' }];
  assert.equal(selectScheduleRows(rows, s, now)[0].area, '花蓮縣');
  const coverage = cinemaCoverage(rows, s, day, now);
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0].area, '花蓮縣');
});

test('日期抓取失敗即使保留快取也要警告；新鮮備援可解除缺口', () => {
  const s = { skcinemas: { fetchedAt: stamp, cinemas: {
    台北天母新光影城: { state: 'partial', lastSuccessAt: stamp, failedDates: [day] },
  } }, atmovies: { fetchedAt: stamp, cinemas: {} } };
  assert.equal(cinemaCoverage([row('skcinemas')], s, day, now)[0].state, 'partial');
  assert.equal(cinemaCoverage([row('skcinemas'), row('atmovies')], s, day, now)[0].state, 'today-only');
});

test('寫入來源狀態時保留掉館紀錄與各館日期，零筆不算成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kaiyan-coverage-'));
  try {
    const path = join(dir, 'test.json');
    await saveRecords(path, [row('test', '天母'), row('test', '另一館')]);
    await saveRecords(path, [row('test', '天母')]);
    const s = JSON.parse(await readFile(join(dir, '_status.json'), 'utf8')).test;
    assert.equal(s.cinemas.另一館.state, 'missing');
    assert.equal(s.cinemas.另一館.count, 0);
    assert.deepEqual(s.cinemas.天母.dates, [day]);
    assert.ok(s.cinemas.另一館.lastSuccessAt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
