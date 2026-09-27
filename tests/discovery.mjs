import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiscovery, loadDiscovery, matchesWork, validateCatalog } from '../lib/discovery.mjs';
import { discoveryFixture } from './discovery-fixture.mjs';
const { catalog, data } = await discoveryFixture();
const brand = (d, id) => d.brands.find(b => b.id === id);
const series = (d, id) => d.series.find(s => s.id === id);

test('checked-in seed has valid provenance, stable IDs and deliberately partial membership', async () => {
  const seed = validateCatalog(JSON.parse(await readFile(new URL('../catalog/discovery.json', import.meta.url), 'utf8')));
  assert.equal(seed.works.filter(w => w.brands.some(b => b.id === 'haipeng')).length, 18);
  assert.equal(seed.works.filter(w => w.brands.some(b => b.id === 'a24')).length, 3);
  assert.equal(seed.series.flatMap(s => s.screenings).length, 5);
  assert.ok(!seed.works.some(w => /2026\/\/intro/.test(w.sources.join(' '))), 'broken official detail URLs must not be guessed');
});

test('classification is additive, many-to-many and never English-only', () => {
  const before = JSON.stringify(data), catalogBefore = JSON.stringify(catalog);
  const d = buildDiscovery(catalog, data);
  assert.deepEqual(new Set(brand(d, 'haipeng').movies), new Set([0, 3, 6]));
  assert.deepEqual(new Set(brand(d, 'a24').movies), new Set([1, 6]));
  assert.ok(!brand(d, 'a24').movies.includes(3), 'Haipeng The Rover is not the A24 film');
  assert.ok(!brand(d, 'haipeng').movies.includes(5), 'English collision cannot establish membership');
  assert.equal(JSON.stringify(data), before);
  assert.equal(JSON.stringify(catalog), catalogBefore);
});

test('unknown, conflicting and different-edition evidence is refused', () => {
  const work = catalog.works.find(w => w.id === 'power-ballad');
  assert.equal(matchesWork(work, ['被偷走的情歌', null]), false, 'title alone is unknown');
  assert.equal(matchesWork(work, ['被偷走的情歌', null], { d: 99 }), true);
  for (const [movie, meta, durations] of [
    [['被偷走的情歌', 'Another Movie'], { d: 98 }, []],
    [['被偷走的情歌', 'Power Ballad'], { d: 150 }, []],
    [['被偷走的情歌', 'Power Ballad'], { r: '另一位導演' }, []],
    [['被偷走的情歌 導演剪輯版', 'Power Ballad'], { d: 98 }, []],
    [['被偷走的情歌(2020)', 'Power Ballad'], { d: 98 }, []],
    [['被偷走的情歌（版本待確認）', 'Power Ballad'], { d: 98 }, []],
    [['被偷走的情歌', 'Power Ballad'], {}, [98, 150]],
  ]) assert.equal(matchesWork(work, movie, meta, durations), false);
  const conflict = new Map([['被偷走的情歌', new Set([98, 150])]]);
  assert.ok(!brand(buildDiscovery(catalog, data, conflict), 'haipeng').movies.includes(0));
  const ambiguous = structuredClone(catalog);
  ambiguous.works.push({ ...work, id: 'other-power-ballad' });
  assert.ok(!brand(buildDiscovery(ambiguous, data), 'haipeng').movies.includes(0));
});

test('series scopes exact venue/date/time/hall/event; never adds synthetic rows', () => {
  const d = buildDiscovery(catalog, data);
  assert.deepEqual(series(d, 'eslite-sunday-2026-q3').rows, [7]);
  assert.deepEqual(series(d, 'eslite-sunday-2026-q4').rows, [12, 11]);
  assert.deepEqual(series(d, 'wmw2026-spot').rows, [13, 14]);
  const wrong = structuredClone(data);
  wrong.urls[1] = 'https://www.opentix.life/event/another-program';
  assert.deepEqual(series(buildDiscovery(catalog, wrong), 'wmw2026-spot').rows, []);
  wrong.urls[1] = data.urls[1]; wrong.halls[0] = '2廳';
  assert.deepEqual(series(buildDiscovery(catalog, wrong), 'wmw2026-spot').rows, []);
  wrong.halls[0] = '1廳'; wrong.movies[9][0] += ' 加長版';
  assert.deepEqual(series(buildDiscovery(catalog, wrong), 'wmw2026-spot').rows, [], 'official URL cannot override edition conflict');
  const duplicate = structuredClone(data);
  duplicate.packed += ';' + data.packed.split(';')[7];
  assert.deepEqual(series(buildDiscovery(catalog, duplicate), 'eslite-sunday-2026-q3').rows, [], 'ambiguous simultaneous entrances stay unknown');
  const empty = { ...data, packed: '' };
  assert.equal(buildDiscovery(catalog, empty).series[0].entries.length, 1, 'official notice survives missing showtimes');
  assert.deepEqual(buildDiscovery(catalog, empty).series[0].rows, []);
});

test('movie/row reordering derives new ephemeral indices, not persisted crosswalks', () => {
  const reordered = structuredClone(data), n = data.movies.length;
  reordered.movies.reverse();
  reordered.meta = Object.fromEntries(Object.entries(data.meta).map(([mi, m]) => [n - 1 - Number(mi), m]));
  reordered.packed = data.packed.split(';').reverse().map(g => {
    const f = g.split(','); f[1] = (n - 1 - parseInt(f[1], 36)).toString(36); return f.join(',');
  }).join(';');
  const a = buildDiscovery(catalog, data), b = buildDiscovery(catalog, reordered);
  assert.deepEqual(brand(a, 'haipeng').movies.map(i => data.movies[i][0]).sort(), brand(b, 'haipeng').movies.map(i => reordered.movies[i][0]).sort());
  assert.deepEqual(series(b, 'eslite-sunday-2026-q3').rows, [data.packed.split(';').length - 1 - 7]);
});

test('schema rejects unsafe URLs, unknown keys, dangling refs and broad screening rules', () => {
  for (const mutate of [
    c => { c.version = 99; }, c => { c.brands.push(c.brands[0]); },
    c => { c.works[0].sources = ['javascript:alert(1)']; },
    c => { c.brands[0].url = 'https://user:password@example.org/'; },
    c => { c.works[0].brands[0].id = 'absent'; },
    c => { c.works[0].checkedAt = '2026-02-30'; },
    c => { c.works[0].eligibleTickets = ['all']; },
    c => { c.series[0].screenings[0].workId = 'absent'; },
    c => { delete c.series[0].screenings[0].time; },
    c => { c.series[0].screenings[0].time = '25:30'; },
    c => { c.series[0].screenings[0].date = '2100-01-01'; },
  ]) { const c = structuredClone(catalog); mutate(c); assert.throws(() => validateCatalog(c)); }
});

test('missing/invalid/disabled classification does not fail ordinary build', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'kaiyan-discovery-optional-'));
  const warnings = [], path = join(scratch, 'catalog.json');
  try {
    assert.equal((await loadDiscovery(path, data, undefined, { warn: s => warnings.push(s) })).status, 'unavailable');
    await writeFile(path, '{broken json');
    assert.equal((await loadDiscovery(path, data, undefined, { warn: s => warnings.push(s) })).status, 'unavailable');
    assert.equal((await loadDiscovery(path, data, undefined, { enabled: false, warn: s => warnings.push(s) })).status, 'disabled');
    assert.equal(warnings.length, 2);
    await writeFile(path, JSON.stringify(catalog));
    assert.equal((await loadDiscovery(path, data)).status, 'ready');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
