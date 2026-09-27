import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { unpackDiscoveryRows } from '../lib/discovery.mjs';
import { discoveryFixture } from './discovery-fixture.mjs';

const { catalog, data } = await discoveryFixture();
const scratch = await mkdtemp(join(tmpdir(), 'kaiyan-discovery-ui-'));
let server, browser;
try {
  for (const dir of ['data', 'lib', 'catalog']) await mkdir(join(scratch, dir));
  for (const file of ['build_site.mjs', 'site_template.html', 'lib/common.mjs', 'lib/movie-identity.mjs', 'lib/cinema-coverage.mjs', 'lib/schedule-parsers.mjs', 'lib/discovery.mjs']) {
    await copyFile(new URL('../' + file, import.meta.url), join(scratch, file));
  }
  const rows = unpackDiscoveryRows(data).map(r => ({
    source: 'fixture', movie: data.movies[r.mi][0], movieEn: data.movies[r.mi][1], cinema: data.cinemas[r.ci][0],
    area: data.cinemas[r.ci][1], date: data.dates[r.di], time: String(Math.floor(r.mins / 60)).padStart(2, '0') + ':' + String(r.mins % 60).padStart(2, '0'),
    hall: data.halls[r.hi], tags: [data.tags[r.ti]], sourceRuntimeMin: data.meta[r.mi]?.d,
    url: data.urls[r.ui].replace('{d}', data.dates[r.di]),
  }));
  await writeFile(join(scratch, 'data/fixture.json'), JSON.stringify(rows));
  await writeFile(join(scratch, 'data/movie_meta.json'), JSON.stringify(Object.fromEntries(data.movies.map((m, i) => [m[0], {
    matchVersion: 3, matchedTitle: m[0], runtimeMin: data.meta[i].d,
    directors: data.meta[i].r ? [data.meta[i].r] : [],
  }]))));
  await writeFile(join(scratch, 'catalog/discovery.json'), JSON.stringify(catalog));
  async function build(enabled) {
    execFileSync(process.execPath, ['build_site.mjs'], { cwd: scratch, stdio: 'pipe', env: { ...process.env, DISCOVERY_ENABLED: enabled ? '1' : '0' } });
    const html = await readFile(join(scratch, 'out/index.html'), 'utf8');
    return { html, data: JSON.parse(html.match(/(?:var|const) DATA\s*=\s*(\{[^\n]+\});/)[1]) };
  }
  const before = await build(false), enabled = await build(true);
  const hostile = structuredClone(catalog);
  hostile.brands[0].description = '來源文字 </script><img id="discovery-injection" src="x" onerror="window.discoveryInjected=1">';
  await writeFile(join(scratch, 'catalog/discovery.json'), JSON.stringify(hostile));
  const escaped = await build(true);
  await writeFile(join(scratch, 'catalog/discovery.json'), '{bad JSON');
  const invalid = await build(true);
  const ordinary = d => { const { discovery, updatedAt, ...base } = d; return base; };
  assert.deepEqual(ordinary(enabled.data), ordinary(before.data), 'all base payload fields, including packed/meta/URLs/posters/coverage, must remain identical');
  assert.deepEqual(ordinary(invalid.data), ordinary(before.data), 'invalid catalog must not alter ordinary showtimes');
  assert.equal(invalid.data.discovery.status, 'unavailable');
  assert.equal(enabled.data.discovery.status, 'ready');
  assert.equal(enabled.data.discovery.series.find(s => s.id === 'eslite-sunday-2026-q3').rows.length, 1);
  assert.equal(unpackDiscoveryRows(enabled.data).length, rows.length, 'official notices never manufacture showtimes');
  let served = enabled.html;
  server = createServer((req, res) => {
    if (new URL(req.url, 'http://localhost').pathname === '/') res.setHeader('Content-Type', 'text/html; charset=utf-8'), res.end(served);
    else res.writeHead(204).end();
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.setFixedTime(new Date('2099-01-01T08:00:00+08:00'));
  await page.goto(base);
  const defaultSummary = await page.locator('#summary').innerText();
  const defaultControlsHeight = await page.locator('.controls').evaluate(e => e.getBoundingClientRect().height);
  assert.equal(await page.locator('#discovery-note').isVisible(), false);
  await page.locator('#more-filters').click();
  await page.locator('#brand').selectOption('haipeng');
  await page.locator('#close-filters').click();
  assert.equal(new URL(page.url()).searchParams.get('brand'), 'haipeng');
  assert.match(await page.locator('#summary').innerText(), /3 部電影.*4 個場次/);
  assert.equal(await page.locator('.controls').evaluate(e => e.getBoundingClientRect().height), defaultControlsHeight, 'normal sticky header must not grow');
  assert.match(await page.locator('#discovery-note').innerText(), /部分收錄/);
  await page.locator('#discovery-note summary').click();
  assert.match(await page.locator('#discovery-note').innerText(), /資料核對：2026-09-27/);
  assert.match(await page.locator('#discovery-note').innerText(), /尚無可核對場次/);
  assert.equal(await page.locator('#discovery-note a[href="https://www.swtwn.com/films/films.php"]').count(), 1);
  await page.locator('#discovery-note button').filter({ hasText: '查本站場次' }).first().click();
  assert.ok(new URL(page.url()).searchParams.get('m'), 'catalog can open actual matching movie');
  assert.equal(new URL(page.url()).searchParams.get('brand'), 'haipeng');

  for (const view of ['movie', 'cinema', 'plan']) {
    await page.goto(base + '?brand=a24&v=' + view + '&ps=00:00&pe=23:59');
    assert.match(await page.locator('#summary').innerText(), /2 部電影.*2 個場次/);
    assert.doesNotMatch(await page.locator('#list').innerText(), /高山遊民|被偷走的情歌|另一部同名/);
    assert.match(await page.locator('#list').innerText(), /實境誘捕/);
  }
  await page.goto(base + '?brand=a24&series=eslite-sunday-2026-q3');
  assert.match(await page.locator('#summary').innerText(), /0 個場次/, 'multiple facets are AND');
  await page.goto(base + '?series=eslite-sunday-2026-q3&v=cinema&e=1');
  assert.match(await page.locator('#summary').innerText(), /1 部電影.*1 家戲院.*1 個場次/);
  assert.match(await page.locator('#list').innerText(), /誠品電影院/);
  assert.doesNotMatch(await page.locator('#list').innerText(), /台中測試影城|13:20/);
  assert.equal(await page.locator('.vlink').first().getAttribute('href'), 'https://example.org/book?date=2099-01-01', 'series does not rewrite booking entrance');
  await page.locator('.t').first().click();
  const savedBefore = await page.evaluate(() => localStorage.getItem('kaiyan.sessions'));
  assert.ok(savedBefore && !savedBefore.includes('eslite-sunday'), 'favorite format contains no discovery membership');
  await page.locator('#my-favorites').click();
  assert.equal(await page.locator('.saved-session').count(), 1);
  assert.equal(await page.locator('#discovery-note').isVisible(), false);
  await page.locator('#home').click();
  assert.equal(new URL(page.url()).search, '');
  assert.equal(await page.evaluate(() => localStorage.getItem('kaiyan.sessions')), savedBefore, 'reset must preserve favorites');

  await page.goto(base + '?series=eslite-sunday-2026-q4');
  assert.match(await page.locator('#list').innerText(), /目前條件沒有已核對/);
  await page.locator('#discovery-note summary').click();
  assert.match(await page.locator('#discovery-note').innerText(), /2099-01-03 11:00/);
  assert.equal(await page.locator('#discovery-note a[href="https://meet.eslite.com/tw/tc/artshow/202609230006"]').count(), 2);
  await page.goto(base + '?series=wmw2026-spot&d=2099-01-03&v=cinema');
  assert.match(await page.locator('#summary').innerText(), /1 個場次/);

  for (const query of ['brand=retired-brand', 'series=retired-series']) {
    await page.goto(base + '?' + query);
    assert.match(await page.locator('#list').innerText(), /所選分類目前不可用/);
    assert.ok(page.url().includes(query), 'unknown valid ID must not silently broaden filters');
    await page.locator('#discovery-note button').filter({ hasText: '清除片單' }).click();
    assert.equal(await page.locator('#summary').innerText(), defaultSummary);
  }
  for (const fallback of [before.html, invalid.html]) {
    served = fallback;
    await page.goto(base + '?brand=haipeng');
    assert.match(await page.locator('#list').innerText(), /所選分類目前不可用/);
    await page.locator('#summary .clear').click();
    assert.equal(await page.locator('#summary').innerText(), defaultSummary);
  }
  // An older cached payload has no discovery property at all.
  const old = structuredClone(enabled.data); delete old.discovery;
  const script = enabled.html.match(/<script>([\s\S]*?)<\/script>/)[1];
  served = enabled.html.replace(/((?:var|const) DATA\s*=\s*)\{[^\n]+\};/, '$1' + JSON.stringify(old) + ';');
  const newScript = served.match(/<script>([\s\S]*?)<\/script>/)[1];
  served = served.replace(createHash('sha256').update(script).digest('base64'), createHash('sha256').update(newScript).digest('base64'));
  await page.goto(base);
  assert.equal(await page.locator('#summary').innerText(), defaultSummary);
  served = escaped.html;
  await page.goto(base + '?brand=haipeng');
  await page.locator('#discovery-note summary').click();
  assert.match(await page.locator('#discovery-note').innerText(), /<img id="discovery-injection"/);
  assert.equal(await page.locator('#discovery-injection').count(), 0, 'source text is never interpreted as HTML');
  assert.equal(await page.evaluate(() => window.discoveryInjected), undefined);
  served = enabled.html;
  for (const width of [320, 390, 640, 641, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(base + '?brand=haipeng');
    if (!(await page.locator('#extra').isVisible())) await page.locator('#more-filters').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px must not overflow`);
    for (const id of ['brand', 'series']) {
      const box = await page.locator('#' + id).boundingBox();
      assert.ok(box.width >= 44 && (width > 640 || box.height >= 44), 'new controls retain mobile touch targets');
    }
    if (width <= 640) await page.locator('#close-filters').click();
    await page.locator('#discovery-note summary').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px catalog must wrap`);
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(base + '?brand=haipeng');
  await page.route('**/*', route => route.abort());
  await page.locator('#brand').selectOption('a24');
  assert.match(await page.locator('#summary').innerText(), /2 部電影/, 'embedded filters need no extra network access');
  await page.locator('#home').click();
  assert.equal(await page.locator('#summary').innerText(), defaultSummary);
  assert.deepEqual(errors, []);
  console.log('discovery UI OK: baseline payload equality, real build/fail-open catalog, fail-closed selected facets, brand/series scope, 3 views, URLs/reset/favorites, old payloads, offline interaction, 5 viewport sizes');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(ok => server.close(ok));
  await rm(scratch, { recursive: true, force: true });
}
