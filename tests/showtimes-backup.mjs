import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CINEMAS, SHOWTIMES_BACKUP, fetchAtmovies } from '../fetch/atmovies.mjs';
import { cinemaCoverage, selectScheduleRows } from '../lib/cinema-coverage.mjs';
import { markSourceFailed, saveRecords, todayISO } from '../lib/common.mjs';

const day = '2026-09-30', tomorrow = '2026-10-01';
const now = Date.parse(day + 'T12:00:00+08:00'), stamp = new Date(now).toISOString();
const expired = new Date(now - 73 * 3600000).toISOString();
const config = SHOWTIMES_BACKUP.t02g04;
const quiet = () => {};
const page = (date = day, links = '') => `<h3>${date.replaceAll('-', '/')} (三)</h3>${links}
  <ul id="theaterShowtimeTable"><li class="filmTitle"><a href="/movie/ftest/">測試片</a></li>
  <li><ul><li>片長：100分</li></ul><ul><li>IMAX版</li><li>12：30</li></ul></li></ul>`;
const row = (source, name, date = day, fetchedAt = stamp) => ({
  source, cinema: name, area: '基隆市', movie: '測試片', date, time: '12:30', fetchedAt,
});

test('秀泰 15 館加入正式抓取清單，已核實代碼／地區沿用官方館名', () => {
  const expected = {
    t02g04: ['基隆秀泰影城', '基隆市', 'a01'],
    t02d03: ['台北欣欣秀泰影城', '台北市', 'a02'],
    t02a13: ['大巨蛋秀泰影城', '台北市', 'a02'],
    t02e13: ['樹林秀泰影城', '新北市', 'a02'],
    t02e15: ['土城秀泰影城', '新北市', 'a02'],
    t04410: ['台中站前秀泰影城', '台中市', 'a04'],
    t04411: ['台中文心秀泰影城', '台中市', 'a04'],
    t04413: ['台中麗寶秀泰影城', '台中市', 'a04'],
    t04504: ['北港秀泰影城', '雲林縣', 'a45'],
    t05504: ['嘉義秀泰影城', '嘉義市', 'a05'],
    t06628: ['台南仁德秀泰影城', '台南市', 'a06'],
    t07729: ['高雄岡山秀泰影城', '高雄市', 'a07'],
    t07707: ['高雄夢時代秀泰影城', '高雄市', 'a07'],
    t03801: ['花蓮秀泰影城', '花蓮縣', 'a38'],
    t08902: ['台東秀泰影城', '台東縣', 'a89'],
  };
  assert.deepEqual(Object.fromEntries(Object.entries(SHOWTIMES_BACKUP)
    .map(([code, c]) => [code, [c.name, c.area, c.region]])), expected);
  for (const [code, c] of Object.entries(SHOWTIMES_BACKUP)) {
    assert.equal(CINEMAS[code], c);
    assert.equal(c.official, 'https://www.showtimes.com.tw/ticketing');
  }
  assert.equal(Object.keys(CINEMAS).length, 51, '保留原本 36 館並加入 15 館');
  assert.equal(new Set(Object.values(CINEMAS).map(c => c.name)).size, 51);
});

test('官方整支 403 且快取超過 72 小時，15 館備援皆能接手且不更新官方成功時間', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kaiyan-showtimes-failure-'));
  try {
    const current = todayISO(), oldStamp = new Date(Date.now() - 73 * 3600000).toISOString();
    const official = Object.values(SHOWTIMES_BACKUP).map(c => row('showtimes', c.name, current, oldStamp));
    const oldStatus = { showtimes: { fetchedAt: oldStamp, count: official.length, cinemas:
      Object.fromEntries(Object.values(SHOWTIMES_BACKUP).map(c => [c.name, {
        state: 'ok', area: c.area, dates: [current], lastSuccessAt: oldStamp,
      }])) } };
    await writeFile(join(dir, 'showtimes.json'), JSON.stringify(official));
    await writeFile(join(dir, '_status.json'), JSON.stringify(oldStatus));
    await markSourceFailed(join(dir, 'showtimes.json')); // run-all.sh 的官方 HTTP 403 失敗路徑
    const requests = [];
    const result = await fetchAtmovies({ targets: SHOWTIMES_BACKUP, today: current, log: quiet,
      fetchPage: async url => { requests.push(url); return page(current); } });
    assert.deepEqual(requests, Object.entries(SHOWTIMES_BACKUP)
      .map(([code, c]) => `https://www.atmovies.com.tw/showtime/${code}/${c.region}/`));
    await saveRecords(join(dir, 'atmovies.json'), result.records, { cinemas: result.cinemas });
    const status = JSON.parse(await readFile(join(dir, '_status.json'), 'utf8'));
    assert.equal(status.showtimes.fetchedAt, oldStamp);
    assert.equal(status.showtimes.lastAttemptState, 'failed');
    const selected = selectScheduleRows([...official, ...result.records], status);
    assert.equal(selected.length, 15);
    assert.ok(selected.every(r => r.source === 'atmovies'));
    assert.ok(selected.every(r => r.sourceUrl.endsWith('/' + current.replaceAll('-', '') + '/')));
    assert.ok(selected.every(r => r.url === 'https://www.showtimes.com.tw/ticketing'));
    const coverage = cinemaCoverage([...official, ...result.records], status, current);
    assert.equal(coverage.length, 15, '不能因簡稱或縣市不同而重複列館');
    assert.ok(coverage.every(c => c.count === 1 && c.state === 'today-only'));
    assert.ok(coverage.every(c => !c.failedDates.includes(current)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('秀泰恢復後優先採官方同館同日，仍由備援補官方缺日，不重複格式', () => {
  const official = { ...row('showtimes', config.name), tags: ['IMAX'], hall: '巨幕廳' };
  const backup = { ...row('atmovies', config.name), tags: ['IMAX版'], hall: null };
  const nextDay = row('atmovies', config.name, tomorrow);
  const status = { showtimes: { fetchedAt: stamp, cinemas: {
    [config.name]: { state: 'ok', lastSuccessAt: stamp },
  } }, atmovies: { fetchedAt: stamp } };
  assert.deepEqual(selectScheduleRows([official, backup, nextDay], status, now), [official, nextDay]);
});

test('備援一館也回 403 時不影響其他館，保留的過期列不能被新來源時間戳復活', async () => {
  const other = SHOWTIMES_BACKUP.t02a13;
  const old = row('atmovies', config.name, day, expired);
  const previousWithoutStamp = { ...old };
  delete previousWithoutStamp.fetchedAt;
  const result = await fetchAtmovies({ targets: { t02g04: config, t02a13: other },
    previous: [previousWithoutStamp], status: { atmovies: { fetchedAt: expired } }, today: day,
    timestamp: () => stamp, log: quiet, fetchPage: async url => {
      if (url.includes('/t02g04/')) throw new Error('HTTP 403');
      return page();
    } });
  assert.equal(result.cinemas[config.name].state, 'failed');
  assert.equal(result.cinemas[config.name].lastSuccessAt, undefined);
  assert.equal(result.cinemas[other.name].state, 'ok');
  assert.equal(result.records.find(r => r.cinema === config.name).fetchedAt, expired);
  const status = { atmovies: { fetchedAt: stamp, cinemas: result.cinemas } };
  assert.deepEqual(selectScheduleRows(result.records, status, now).map(r => r.cinema), [other.name]);
  assert.equal(cinemaCoverage(result.records, status, day, now).find(c => c.name === config.name).state, 'missing');
});

test('部分日期失敗保留原時間並標示缺口，只抓已公布日期、不猜後續日期', async () => {
  const requests = [];
  const old = row('atmovies', config.name, tomorrow, expired);
  const result = await fetchAtmovies({ targets: { t02g04: config }, previous: [old], today: day,
    timestamp: () => stamp, log: quiet, fetchPage: async url => {
      requests.push(url);
      if (url.endsWith('/20261001/')) throw new Error('HTTP 503');
      return page(day, '<a href="/showtime/t02g04/a01/20261001/">明天</a>');
    } });
  assert.deepEqual(requests, ['https://www.atmovies.com.tw/showtime/t02g04/a01/',
    'https://www.atmovies.com.tw/showtime/t02g04/a01/20261001/']);
  assert.equal(result.cinemas[config.name].state, 'partial');
  assert.deepEqual(result.cinemas[config.name].failedDates, [tomorrow]);
  assert.equal(result.records.find(r => r.date === tomorrow).fetchedAt, expired);
  const status = { atmovies: { fetchedAt: stamp, cinemas: result.cinemas } };
  assert.deepEqual(selectScheduleRows(result.records, status, now).map(r => r.date), [day]);
  assert.equal(cinemaCoverage(result.records, status, day, now)[0].state, 'partial');
});

test('午夜根頁仍是昨天時核對明確日期頁，不能直接把昨天改成今天', async () => {
  const requests = [];
  const result = await fetchAtmovies({ targets: { t02g04: config }, today: day,
    timestamp: () => stamp, log: quiet, fetchPage: async url => {
      requests.push(url);
      return page(url.endsWith('/20260930/') ? day : '2026-09-29');
    } });
  assert.deepEqual(requests, ['https://www.atmovies.com.tw/showtime/t02g04/a01/',
    'https://www.atmovies.com.tw/showtime/t02g04/a01/20260930/']);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].date, day);
});
