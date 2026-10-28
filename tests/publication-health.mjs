import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicationHealth } from '../lib/publication-health.mjs';
import { todayISO } from '../lib/common.mjs';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const today = '2026-10-28', stamp = today + 'T04:00:00Z', now = Date.parse(stamp);
function fixture() {
  const coverage = Array.from({ length: 80 }, (_, i) => ({ name: `影城${i}`, count: 50 }));
  const rows = coverage.flatMap(c => Array.from({ length: 50 }, (_, i) => ({
    source: 'atmovies', cinema: c.name, movie: `電影${i}`, date: today,
    time: '12:30', fetchedAt: stamp,
  })));
  return { total: 4000, rows, coverage, today, now,
    status: { atmovies: { fetchedAt: stamp, cinemas: {} } }, healthySources: ['atmovies'],
    history: { _cinemas: Object.fromEntries(coverage.map(c => [c.name, { count: 100 }])) } };
}

test('多日量低於6000仍須獨立通過完整名冊、新鮮當日館數及3000場門檻', () => {
  const input = fixture(), result = publicationHealth(input);
  assert.ok(input.total < 6000);
  assert.equal(result.ok, true);
  assert.equal(result.basis, 'fresh-day-coverage');
  assert.equal(result.freshTodaySessions, 4000);
  assert.equal(result.freshTodayCinemas, 80);
  assert.equal(publicationHealth({ ...input, total: 6000 }).basis, 'multi-day-volume');
});

test('少一館或整館自當期名冊消失，歷史名冊仍會擋下低總量發佈', () => {
  for (const remove of [false, true]) {
    const input = fixture();
    if (remove) input.coverage.pop(); else input.coverage.at(-1).count = 0;
    const result = publicationHealth(input);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['影城79']);
  }
  const input = fixture();input.coverage = input.coverage.slice(0, 74);input.history = {};
  assert.equal(publicationHealth(input).ok, false);
});

test('大量重複、只有未來日期或集中少數館都不能冒充當日全台覆蓋', () => {
  const input = fixture();
  for (const rows of [Array(4000).fill(input.rows[0]),
    input.rows.map(r => ({ ...r, date: '2026-10-29' })),
    input.rows.map(r => ({ ...r, cinema: '影城0' }))]) {
    assert.equal(publicationHealth({ ...input, rows }).ok, false);
  }
  assert.equal(publicationHealth({ ...input, rows: input.rows.slice(0, 2999) }).ok, false);
});

test('來源批次新時間不能洗新舊列；缺時間、無效時間、未來時間和失敗來源不合格', () => {
  const input = fixture();
  for (const fetchedAt of ['2026-10-27T01:00:00Z', 'invalid', '2026-10-29T04:00:00Z']) {
    assert.equal(publicationHealth({ ...input, rows: input.rows.map(r => ({ ...r, fetchedAt })) }).ok, false);
  }
  assert.equal(publicationHealth({ ...input, status: {}, rows: input.rows.map(r => ({ ...r, fetchedAt: '' })) }).ok, false);
  assert.equal(publicationHealth({ ...input, healthySources: [] }).ok, false);
  input.status.atmovies.lastAttemptState = 'failed';
  assert.equal(publicationHealth(input).ok, false);
});

test('當日抓取失敗不能由留存資料補數；少數未公布當日的藝文館可保留未來場次', () => {
  const input = fixture();
  input.rows = input.rows.map((r, i) => i < 800 ? { ...r, date: '2026-10-29' } : r);
  assert.equal(publicationHealth(input).ok, true, '64/80館、3200場達到門檻');
  input.status.atmovies.cinemas.影城79 = { state: 'partial', failedDates: [today] };
  assert.equal(publicationHealth(input).ok, false, '63館不能達到80%');
});

test('真正健康檢查記錄當日驗證依據；掉館時退出失敗且不覆寫成功歷史', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kaiyan-publication-health-'));
  try {
    await mkdir(join(dir, 'data'));await mkdir(join(dir, 'lib'));
    for (const file of ['check_health.mjs', 'lib/publication-health.mjs', 'lib/cinema-coverage.mjs',
      'lib/common.mjs', 'lib/movie-identity.mjs']) {
      await copyFile(new URL('../' + file, import.meta.url), join(dir, file));
    }
    const day = todayISO(), fetchedAt = new Date().toISOString(), status = {};
    const counts = { atmovies: 4000, ambassador: 800, miranew: 60, miramar: 30,
      lux: 15, arthouse: 20, arthouse2: 25, srm: 10, ccmovie: 10 };
    let backup;
    for (const [source, count] of Object.entries(counts)) {
      const rows = Array.from({ length: count }, (_, i) => ({ source,
        cinema: `影城${source === 'atmovies' ? Math.floor(i / 50) : 0}`,
        movie: `電影${i % 50}`, date: day, time: `12:${String(i % 50).padStart(2, '0')}`,
        hall: '影廳', fetchedAt }));
      if (source === 'atmovies') backup = rows;
      status[source] = { count, fetchedAt };
      await writeFile(join(dir, 'data', source + '.json'), JSON.stringify(rows));
    }
    const history = { _cinemas: Object.fromEntries(Array.from({ length: 80 }, (_, i) =>
      [`影城${i}`, { count: 100, dates: [day] }])) };
    await writeFile(join(dir, 'data', '_status.json'), JSON.stringify(status));
    await writeFile(join(dir, 'data', '_history.json'), JSON.stringify(history));
    const run = () => spawnSync(process.execPath, [join(dir, 'check_health.mjs')], { encoding: 'utf8' });
    const success = run();
    assert.equal(success.status, 0, success.stdout + success.stderr);
    const report = JSON.parse(await readFile(join(dir, 'data', '_health.json'), 'utf8'));
    assert.equal(report.publication.basis, 'fresh-day-coverage');
    assert.equal(report.publication.freshTodaySessions, 4000);
    const acceptedHistory = await readFile(join(dir, 'data', '_history.json'), 'utf8');
    await writeFile(join(dir, 'data', 'atmovies.json'), JSON.stringify(backup.filter(r => r.cinema !== '影城79')));
    const failure = run();
    assert.equal(failure.status, 1, failure.stdout + failure.stderr);
    assert.equal(await readFile(join(dir, 'data', '_history.json'), 'utf8'), acceptedHistory);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
