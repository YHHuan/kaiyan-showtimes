import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { buildFestivalCalendar } from '../build_festivals.mjs';
import { SCREENINGS_KEY } from '../lib/festival-screenings.mjs';
import { festivalFixture, now } from './festival-fixture.mjs';
import { screeningFixture } from './festival-screenings-fixture.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'kaiyan-screenings-ui-'));
const { data, saved } = festivalFixture(), { row, feed, catalog } = screeningFixture();
let browser, server;
try {
  for (const dir of ['catalog', 'data/festivals', 'lib', 'web/festivals']) await mkdir(join(scratch, dir), { recursive: true });
  for (const file of ['lib/festival-calendar.mjs', 'lib/festival-screenings.mjs', 'web/festivals/app.mjs', 'web/festivals/style.css', 'web/festivals/index.html']) {
    await copyFile(new URL('../' + file, import.meta.url), join(scratch, file));
  }
  await writeFile(join(scratch, 'catalog/festivals.json'), JSON.stringify(catalog));
  await writeFile(join(scratch, 'data/festivals/screenings.json'), JSON.stringify(feed));
  await buildFestivalCalendar({ root: scratch, payload: data });
  const ready = JSON.parse(await readFile(join(scratch, 'out/festivals/data.json'), 'utf8'));
  assert.equal(ready.screenings.sources[0].rows.length, 2);
  // Corrupt only the new feed: old periods and ordinary saved calendar still build.
  await writeFile(join(scratch, 'data/festivals/screenings.json'), '{broken');
  await buildFestivalCalendar({ root: scratch, payload: data });
  const fallback = JSON.parse(await readFile(join(scratch, 'out/festivals/data.json'), 'utf8'));
  assert.equal(fallback.festivals.length, catalog.festivals.length); assert.deepEqual(fallback.schedule, ready.schedule);
  assert.ok(fallback.screenings.sources.every(s => !s.rows.length));
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
  const page = await context.newPage(), errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (!r.url().startsWith(base)) external.push(r.url()); });
  await page.clock.setFixedTime(new Date(now));
  const original = { sessions: JSON.stringify(saved), favorites: JSON.stringify({ movies: ['保留的電影'] }) };
  await page.addInitScript(({ sessions, favorites }) => {
    localStorage.setItem('kaiyan.sessions', sessions); localStorage.setItem('kaiyan.favorites', favorites);
  }, original);
  const open = async (view = 'screenings') => { await page.goto(base + '/festivals/?view=' + view); await page.locator('#app').waitFor({ state: 'visible' }); };
  await open();
  assert.equal(await page.locator('#mode-screenings').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#month-items .item').count(), 2);
  assert.equal(await page.locator('#export').isVisible(), false, 'never exports the whole screening timetable');
  await page.locator('#film-search').fill('星空'); assert.equal(await page.locator('#month-items .item').count(), 2);
  await page.locator('#film-search').fill('missing'); assert.equal(await page.locator('#month-items .item').count(), 0);
  assert.match(await page.locator('#month-items').innerText(), /不等於尚未公布/);
  await page.locator('#film-search').fill('TWO'); assert.equal(await page.locator('#month-items .item').count(), 2);
  await page.locator('#festival-select').selectOption('test-two'); assert.equal(await page.locator('#month-items .item').count(), 0);
  await page.locator('#festival-select').selectOption('all');
  await page.locator('#month-items [data-save="test-one:100"]').click();
  assert.deepEqual(await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SCREENINGS_KEY), [row]);
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#month-items [data-save="test-one:100"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#mode-saved').click();
  assert.equal(await page.locator('#month-items .item').count(), 6);
  assert.match(await page.locator('#conflict-note').innerText(), /2 組可能撞期/);
  assert.match(await page.locator('#export-note').innerText(), /可匯出 4 場/);
  const download = async () => { const pending = page.waitForEvent('download'); await page.locator('#export').click(); return await readFile(await (await pending).path(), 'utf8'); };
  let ics = await download(); assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 4);
  assert.match(ics, /DTSTART:20990101T151500Z/); assert.match(ics, /DTEND:20990101T161500Z/);
  // A changed stable official ID must show both old and new choices, not auto-move.
  served.screenings.sources[0].rows[0].mins += 10;
  await open('saved'); assert.equal(await page.locator('#month-items [data-session-state="changed"]').count(), 1);
  assert.match(await page.locator('#export-note').innerText(), /可匯出 3 場/);
  assert.equal((await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SCREENINGS_KEY))[0].mins, row.mins);
  await page.locator('#month-items [data-session-state="changed"] button', { hasText: '確認異動' }).first().click();
  assert.match(await page.locator('#export-note').innerText(), /可匯出 4 場/);
  assert.equal((await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SCREENINGS_KEY))[0].mins, row.mins + 10);
  // Missing current row retains the saved snapshot and excludes only that export.
  served.screenings.sources[0].rows = [];
  await open('saved'); assert.equal(await page.locator('#month-items [data-screening-id="test-one:100"][data-session-state="missing"]').count(), 1);
  assert.match(await page.locator('#export-note').innerText(), /可匯出 3 場/);
  served = structuredClone(ready); served.screenings.sources[0].status = 'failed';
  await open(); assert.equal(await page.locator('#month-items [data-save="test-one:101"]').isDisabled(), true);
  await page.locator('#mode-saved').click(); assert.match(await page.locator('#export-note').innerText(), /可匯出 3 場/);
  const snapshot = await page.evaluate(k => localStorage.getItem(k), SCREENINGS_KEY);
  served = structuredClone(ready);
  await open();
  for (const width of [320, 360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['screenings', 'saved', 'festivals']) {
      await page.locator('#mode-' + mode).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no overflow ' + width + ' ' + mode);
    }
  }
  const other = await context.newPage(); await other.clock.setFixedTime(new Date(now));
  await other.goto(base + '/festivals/'); await other.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#mode-screenings').click();
  await other.locator('#month-items [data-save="test-one:101"]').click();
  await page.waitForFunction(() => document.querySelector('#month-items [data-save="test-one:101"]').getAttribute('aria-pressed') === 'true');
  await other.close();
  const originalAfter = await page.evaluate(() => ({ sessions: localStorage.getItem('kaiyan.sessions'), favorites: localStorage.getItem('kaiyan.favorites') }));
  assert.deepEqual(originalAfter, original, 'ordinary favorites byte-for-byte unchanged');
  // A source-supplied title is text, never HTML.
  served.screenings.sources[0].rows[1].movie = '<img id="injected" src=x onerror="alert(1)">';
  await open(); assert.equal(await page.locator('#injected').count(), 0); assert.match(await page.locator('#month-items').innerText(), /<img id=/);
  // Corrupt the new storage key: warn and refuse replacement, keep original keys.
  await page.evaluate(k => localStorage.setItem(k, '{broken'), SCREENINGS_KEY); await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#month-items [data-save="test-one:100"]').click();
  assert.match(await page.locator('#action-status').innerText(), /無法儲存/);
  assert.equal(await page.evaluate(k => localStorage.getItem(k), SCREENINGS_KEY), '{broken');
  await page.evaluate(({ k, v }) => localStorage.setItem(k, v), { k: SCREENINGS_KEY, v: snapshot });
  served.screenings = { invalid: true }; await open('saved');
  assert.equal(await page.locator('#month-items .item').count(), 6, 'corrupt optional feed does not hide original or saved snapshots');
  assert.match(await page.locator('#export-note').innerText(), /可匯出 3 場/);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('festival screenings UI OK: search/filter/save/reload, mixed conflicts/ICS, explicit change confirmation, missing/failed/corrupt feed, immutable core storage, cross-tab, text-only rendering and 5 viewport sizes');
} finally {
  await browser?.close(); if (server) await new Promise(ok => server.close(ok));
  await rm(scratch, { recursive: true, force: true });
}
