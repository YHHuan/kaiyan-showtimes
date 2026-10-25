import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { buildFestivalCalendar } from '../build_festivals.mjs';
import { parseGoldenHorseDay } from '../lib/festival-sources.mjs';
import { SCREENINGS_KEY } from '../lib/festival-screenings.mjs';
import { festivalFixture, now } from './festival-fixture.mjs';
import { xrFixture } from './festival-screenings-fixture.mjs';
import { goldenFestival, goldenRow, goldenHTML } from './golden-horse-fixture.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'kaiyan-golden-ui-'));
const { data, saved } = festivalFixture(), { catalog, feed, xr } = xrFixture();
const festival = catalog.festivals.find(f => f.id === 'golden-horse-2026');
// Fixed future dates are test data only, not an asserted real festival edition.
Object.assign(festival, { startDate: '2099-01-01', endDate: '2099-01-03', programUrl: goldenFestival.programUrl });
const rows = parseGoldenHorseDay(goldenHTML({ festival, rows: [goldenRow({ festival }), goldenRow({ festival, ticket: '201',
  time: '20:00', runtime: 60, movie: '【測試短片集】', members: [{ id: '101', title: '星空' }, { id: '102', title: '日出' }] })] }), festival, festival.startDate);
const golden = rows.find(r => r.id.endsWith('200')), compilation = rows.find(r => r.id.endsWith('201'));
Object.assign(feed.sources.find(s => s.festivalId === festival.id), { status: 'ok', fetchedAt: new Date(now).toISOString(), rows });
let server, browser;
try {
  for (const directory of ['catalog', 'data/festivals', 'lib', 'web/festivals']) await mkdir(join(scratch, directory), { recursive: true });
  for (const file of ['lib/festival-calendar.mjs', 'lib/festival-screenings.mjs', 'web/festivals/app.mjs', 'web/festivals/style.css', 'web/festivals/index.html']) {
    await copyFile(new URL('../' + file, import.meta.url), join(scratch, file));
  }
  await writeFile(join(scratch, 'catalog/festivals.json'), JSON.stringify(catalog));
  const build = async content => {
    await writeFile(join(scratch, 'data/festivals/screenings.json'), JSON.stringify(content));
    await buildFestivalCalendar({ root: scratch, payload: data });
    return JSON.parse(await readFile(join(scratch, 'out/festivals/data.json'), 'utf8'));
  };
  const ready = await build(feed), broken = structuredClone(feed);
  broken.sources.find(s => s.festivalId === festival.id).rows[0].mins = -1;
  const isolated = await build(broken);
  assert.deepEqual(isolated.schedule, ready.schedule, 'broken Golden Horse does not change ordinary payload');
  assert.deepEqual(isolated.screenings.extraSources, ready.screenings.extraSources, 'XR retained');
  assert.equal(isolated.screenings.sources.find(s => s.festivalId === festival.id).status, 'failed');
  let served = structuredClone(ready);
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/festivals/data.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(served)); return; }
      const file = path.endsWith('/') ? path + 'index.html' : path;
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript' }[extname(file)] || 'text/plain') + '; charset=utf-8');
      res.end(await readFile(join(scratch, 'out', file)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
  const errors = [], external = [];
  const watch = async page => {
    await page.clock.setFixedTime(new Date(now));
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (!r.url().startsWith(base)) external.push(r.url()); });
  };
  let page = await context.newPage(); await watch(page);
  const originals = { 'kaiyan.sessions': JSON.stringify([saved[0]]), 'kaiyan.favorites': '{"movies":["保留"]}', [SCREENINGS_KEY]: JSON.stringify([xr]) };
  await context.addInitScript(values => {
    for (const [key, value] of Object.entries(values)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }, originals);
  const open = async (view = 'screenings') => { await page.goto(base + '/festivals/?view=' + view); await page.locator('#app').waitFor({ state: 'visible' }); };
  await open();
  await page.locator('#festival-select').selectOption(festival.id);
  assert.equal(await page.locator('#month-items .item').count(), 2);
  assert.match(await page.locator('#source-list').textContent(), /測試金馬：已取得 · 2 場/);
  assert.match(await page.locator('#month-items [data-screening-id="' + golden.id + '"]').innerText(), /23:30 — 翌日 01:00（估計）/);
  await page.locator('#film-search').fill('星空'); assert.equal(await page.locator('#month-items .item').count(), 1);
  assert.match(await page.locator('#month-items').innerText(), /合輯，一張場次：星空／日出/);
  await page.locator('#month-items [data-save="' + compilation.id + '"]').click();
  await page.locator('#film-search').fill('');
  await page.locator('#month-items [data-save="' + golden.id + '"]').click();
  await page.close(); page = await context.newPage(); await watch(page); await open('saved');
  assert.equal(await page.locator('#month-items .item').count(), 4, 'ordinary, XR and both Golden Horse saves coexist');
  const download = page.waitForEvent('download'); await page.locator('#export').click();
  const ics = await readFile(await (await download).path(), 'utf8');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 4);
  assert.match(ics, /DTSTART:20990101T153000Z/); assert.match(ics, /DTEND:20990101T170000Z/);
  assert.equal(new Set(ics.match(/UID:[^\r\n]+/g)).size, 4);
  const stored = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SCREENINGS_KEY);
  assert.deepEqual(stored, [xr, compilation, golden]);
  const currentGolden = served.screenings.sources.find(s => s.festivalId === festival.id);
  const retimed = currentGolden.rows.find(r => r.id === golden.id); retimed.mins += 10; retimed.endMins += 10;
  await open('saved');
  assert.equal(await page.locator('#month-items [data-session-state="changed"]').count(), 1);
  assert.match(await page.locator('#export-note').innerText(), /可匯出 3 場/);
  assert.deepEqual(await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SCREENINGS_KEY), stored);
  await page.locator('#month-items [data-session-state="changed"] button', { hasText: '確認異動' }).click();
  assert.match(await page.locator('#export-note').innerText(), /可匯出 4 場/);
  currentGolden.status = 'failed';
  await open('saved'); assert.equal(await page.locator('#month-items [data-session-state="unverified"]').count(), 2);
  assert.match(await page.locator('#export-note').innerText(), /可匯出 2 場/);
  assert.equal(await page.locator('#month-items [data-screening-id="' + xr.id + '"][data-session-state="current"]').count(), 1);
  served = structuredClone(isolated);
  await open('saved'); assert.equal(await page.locator('#month-items [data-session-state="stale"]').count(), 2);
  for (const width of [320, 360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['screenings', 'saved', 'festivals']) {
      await page.locator('#mode-' + mode).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Golden Horse no overflow ' + width + ' ' + mode);
    }
  }
  const unchanged = await page.evaluate(() => [localStorage.getItem('kaiyan.sessions'), localStorage.getItem('kaiyan.favorites')]);
  assert.deepEqual(unchanged, [originals['kaiyan.sessions'], originals['kaiyan.favorites']]);
  assert.deepEqual((await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SCREENINGS_KEY))[0], xr);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('Golden Horse UI OK: actual parser rows, member search, save/reopen, mixed XR/ordinary ICS, change/failure isolation and five widths');
} finally {
  await browser?.close(); if (server) await new Promise(ok => server.close(ok));
  await rm(scratch, { recursive: true, force: true });
}
