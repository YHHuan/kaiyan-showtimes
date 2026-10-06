import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { buildFestivalCalendar } from '../build_festivals.mjs';
import { FOLLOW_KEY } from '../lib/festival-calendar.mjs';
import { festivalFixture, now } from './festival-fixture.mjs';
import { screeningFixture, xrFixture } from './festival-screenings-fixture.mjs';

const { catalog, data, saved, tuples } = festivalFixture();
const scratch = await mkdtemp(join(tmpdir(), 'kaiyan-festival-ui-'));
let server, browser;
try {
  for (const dir of ['data', 'lib', 'catalog', 'web/festivals']) await mkdir(join(scratch, dir), { recursive: true });
  const files = ['build_site.mjs', 'build_festivals.mjs', 'site_template.html', 'lib/common.mjs', 'lib/movie-identity.mjs',
    'lib/cinema-coverage.mjs', 'lib/schedule-parsers.mjs', 'lib/discovery.mjs', 'lib/festival-calendar.mjs', 'lib/festival-screenings.mjs',
    'catalog/discovery.json', 'web/festivals/index.html', 'web/festivals/style.css', 'web/festivals/app.mjs'];
  for (const file of files) await copyFile(new URL('../' + file, import.meta.url), join(scratch, file));
  const sourceRows = tuples.map(([ci, mi, di, hi, ti, ui, mins]) => ({ source: 'fixture', movie: data.movies[mi][0],
    cinema: data.cinemas[ci][0], area: data.cinemas[ci][1], date: data.dates[di], time: String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'),
    hall: data.halls[hi], tags: data.tags[ti] ? [data.tags[ti]] : [], url: data.urls[ui].replace('{d}', data.dates[di]).replace('{s}', encodeURIComponent(data.dates[di].replaceAll('-', '/'))), sourceRuntimeMin: data.meta[mi]?.d }));
  await writeFile(join(scratch, 'data/fixture.json'), JSON.stringify(sourceRows));
  await writeFile(join(scratch, 'catalog/festivals.json'), JSON.stringify(catalog));
  function build(enabled) {
    const log = execFileSync(process.execPath, ['build_site.mjs'], { cwd: scratch, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, FESTIVAL_CALENDAR_ENABLED: enabled ? '1' : '0' } });
    return { log };
  }
  async function corePayload() {
    const html = await readFile(join(scratch, 'out/index.html'), 'utf8');
    const { updatedAt, ...base } = JSON.parse(html.match(/(?:var|const) DATA\s*=\s*(\{[^\n]+\});/)[1]);
    return base;
  }
  build(false); const baseline = await corePayload();
  assert.match(await readFile(join(scratch, 'out/festivals/index.html'), 'utf8'), /暫時不可用/);
  await mkdir(join(scratch, 'data/festivals'), { recursive: true });
  await writeFile(join(scratch, 'data/festivals/screenings.json'), JSON.stringify(screeningFixture().feed));
  assert.match(build(true).log, /影展日曆：3 檔/);
  assert.deepEqual(await corePayload(), baseline, 'optional calendar never changes any core DATA field');
  assert.equal(JSON.parse(await readFile(join(scratch, 'out/festivals/data.json'), 'utf8')).screenings.sources[0].rows.length, 2, 'nested feed only enters optional output');
  const xr = xrFixture();
  await writeFile(join(scratch, 'catalog/festivals.json'), JSON.stringify(xr.catalog));
  await writeFile(join(scratch, 'data/festivals/screenings.json'), JSON.stringify(xr.feed));
  build(true); assert.deepEqual(await corePayload(), baseline, 'XR extension never enters ordinary source counts or any core DATA field');
  assert.equal(JSON.parse(await readFile(join(scratch, 'out/festivals/data.json'), 'utf8')).screenings.extraSources[0].rows.length, 2);
  await writeFile(join(scratch, 'catalog/festivals.json'), JSON.stringify(catalog));
  await writeFile(join(scratch, 'data/festivals/screenings.json'), '{broken');
  build(true); assert.deepEqual(await corePayload(), baseline, 'broken nested feed never changes core DATA');
  await rm(join(scratch, 'data/festivals/screenings.json'));
  await writeFile(join(scratch, 'catalog/festivals.json'), '{broken');
  build(true);
  assert.deepEqual(await corePayload(), baseline, 'malformed catalog cannot fail or change main build');
  assert.match(await readFile(join(scratch, 'out/festivals/index.html'), 'utf8'), /暫時不可用/);
  assert.equal(JSON.parse(await readFile(join(scratch, 'out/festivals/data.json'), 'utf8')).status, 'unavailable', 'old successful dataset invalidated');
  await rm(join(scratch, 'build_festivals.mjs'));
  build(true);
  assert.deepEqual(await corePayload(), baseline, 'missing addon module cannot fail or change main build');
  await writeFile(join(scratch, 'catalog/festivals.json'), JSON.stringify(catalog));
  await buildFestivalCalendar({ root: scratch, payload: data });
  const readyData = await readFile(join(scratch, 'out/festivals/data.json'), 'utf8');
  let servedData = readyData;
  const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/festivals/data.json') { res.setHeader('Content-Type', 'application/json'); res.end(servedData); return; }
      const rel = path.endsWith('/') ? path + 'index.html' : path;
      res.setHeader('Content-Type', (mime[extname(rel)] || 'application/octet-stream') + '; charset=utf-8');
      res.end(await readFile(join(scratch, 'out', rel)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
  const page = await context.newPage(); const errors = [], network = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (!r.url().startsWith(base)) network.push(r.url()); });
  await page.clock.setFixedTime(new Date(now));
  await page.goto(base + '/festivals/?view=festivals');
  await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#calendar .day').count(), 42);
  assert.match(await page.locator('#month-title').innerText(), /2099 年 1 月/);
  assert.equal(await page.locator('#month-items .item').count(), 2);
  assert.match(await page.locator('#mode-note').innerText(), /不是全年完整清單/);
  await page.locator('[data-day="2099-01-03"]').click();
  assert.equal(await page.locator('#day-items .item').count(), 2);
  await page.locator('#city').selectOption('台中市');
  assert.equal(await page.locator('#month-items .item').count(), 1);
  await page.locator('#month-items [data-follow="test-two"]').click();
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), FOLLOW_KEY), ['test-two']);
  await page.locator('#city').selectOption('all');
  await page.locator('#followed-only').check();
  assert.equal(await page.locator('#month-items .item').count(), 1);
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#month-items [data-follow="test-two"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('a[href="../?series=test-series"]').count(), 2);
  const download = async () => {
    const received = page.waitForEvent('download'); await page.locator('#export').click();
    return await readFile(await (await received).path(), 'utf8');
  };
  const periods = await download();
  assert.match(periods, /DTSTART;VALUE=DATE:20981230/);
  assert.match(periods, /DTEND;VALUE=DATE:20990106/);
  assert.equal((periods.match(/BEGIN:VEVENT/g) || []).length, 2);
  await page.locator('#prev').click(); assert.match(await page.locator('#month-title').innerText(), /2098 年 12 月/);
  await page.locator('#next').click(); await page.locator('#next').click();
  assert.match(await page.locator('#month-title').innerText(), /2099 年 2 月/);
  assert.equal(await page.locator('#month-items .item').count(), 1);
  await page.locator('#today').click();
  const original = { sessions: JSON.stringify(saved), favorites: JSON.stringify({ movies: ['保留的電影'], cinemas: ['保留的戲院'] }) };
  await page.evaluate(({ sessions, favorites }) => { localStorage.setItem('kaiyan.sessions', sessions); localStorage.setItem('kaiyan.favorites', favorites); }, original);
  await page.locator('#mode-saved').click();
  assert.equal(await page.locator('#month-items .item').count(), 5);
  assert.match(await page.locator('#conflict-note').innerText(), /1 組可能撞期/);
  assert.match(await page.locator('#conflict-note').innerText(), /1 場片長未知/);
  assert.match(await page.locator('#export-note').innerText(), /可匯出 3 場/);
  assert.equal(await page.locator('[data-session-state="missing"] a[target]').count(), 0);
  assert.equal(await page.locator('[data-session-state="ambiguous"] a[target]').count(), 0);
  const sessions = await download();
  assert.equal((sessions.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.match(sessions, /DTSTART:20990101T153000Z/);
  assert.doesNotMatch(sessions, /雙入口|本輪沒有/);
  await page.locator('#buffer').selectOption('30');
  const other = await context.newPage(); await other.clock.setFixedTime(new Date(now));
  await other.goto(base + '/festivals/'); await other.locator('#app').waitFor({ state: 'visible' });
  await other.evaluate(value => localStorage.setItem('kaiyan.sessions', JSON.stringify(value)), [saved[0]]);
  await page.waitForFunction(() => document.querySelectorAll('#month-items .item').length === 1);
  await other.evaluate(value => localStorage.setItem('kaiyan.sessions', value), original.sessions);
  await page.waitForFunction(() => document.querySelectorAll('#month-items .item').length === 5);
  await other.close();
  for (const width of [320, 360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['festivals', 'saved']) {
      await page.locator('#mode-' + mode).click();
      const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(size.scroll <= size.width + 1, 'no horizontal overflow: ' + width + ' ' + mode);
      assert.equal(await page.locator('#calendar .day[aria-label]').count(), 42);
    }
  }
  assert.deepEqual(await page.evaluate(() => ({ sessions: localStorage.getItem('kaiyan.sessions'), favorites: localStorage.getItem('kaiyan.favorites') })), original, 'addon never rewrites original favorites');
  await page.goto(base + '/?saved=1');
  assert.match(await page.locator('#list').innerText(), /我的收藏/);
  assert.equal(await page.locator('.saved-session').count(), saved.length, 'return to ordinary saved view remains functional');
  await page.locator('.festival-link').click(); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#mode-festivals').click();
  const hostile = JSON.parse(readyData); hostile.festivals[0].name = '</script><img id="injected" src=x onerror="window.injected=1">';
  servedData = JSON.stringify(hostile);
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#injected').count(), 0);
  assert.match(await page.locator('#month-items').innerText(), /<img id=/);
  const stale = JSON.parse(readyData); stale.generatedAt = '2098-12-25T00:00:00Z'; servedData = JSON.stringify(stale);
  await page.goto(base + '/festivals/?view=saved'); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#export').isDisabled(), true);
  assert.equal(await page.locator('#month-items [data-session-state="stale"]').count(), 5);
  servedData = '{invalid JSON';
  await page.reload(); await page.locator('#load-error a').waitFor();
  assert.match(await page.locator('#load-error').innerText(), /原收藏未更動/);
  assert.equal(await page.locator('#load-error a').getAttribute('href'), '../');
  servedData = readyData;
  const blocked = await context.newPage(); await blocked.clock.setFixedTime(new Date(now));
  await blocked.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } }); });
  await blocked.goto(base + '/festivals/?view=festivals'); await blocked.locator('#app').waitFor({ state: 'visible' });
  assert.match(await blocked.locator('#storage-note').innerText(), /無法讀取/);
  await blocked.locator('#month-items [data-follow="test-one"]').click();
  assert.match(await blocked.locator('#action-status').innerText(), /無法儲存/);
  assert.equal(await blocked.locator('#month-items [data-follow="test-one"]').getAttribute('aria-pressed'), 'false');
  await blocked.close();
  const quota = await context.newPage(); await quota.clock.setFixedTime(new Date(now));
  await quota.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }; });
  await quota.goto(base + '/festivals/?view=festivals'); await quota.locator('#app').waitFor({ state: 'visible' });
  const priorFollows = await quota.evaluate(key => localStorage.getItem(key), FOLLOW_KEY);
  await quota.locator('#month-items [data-follow="test-one"]').click();
  assert.match(await quota.locator('#action-status').innerText(), /無法儲存/);
  assert.equal(await quota.evaluate(key => localStorage.getItem(key), FOLLOW_KEY), priorFollows);
  assert.deepEqual(await quota.evaluate(() => ({ sessions: localStorage.getItem('kaiyan.sessions'), favorites: localStorage.getItem('kaiyan.favorites') })), original);
  await quota.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(network, [], 'calendar performs no third-party requests');
  console.log('festival UI OK: core payload equality, disabled/broken/missing build isolation, month/year navigation, local follows, legacy favorites, cross-midnight conflicts, truthful exports, storage/tabs, 5 viewport sizes, injection/CSP, failed/stale data, main saved-view return');
} finally {
  await browser?.close();
  if (server) await new Promise(ok => server.close(ok));
  await rm(scratch, { recursive: true, force: true });
}
