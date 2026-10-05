import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { buildFestivalCalendar } from '../build_festivals.mjs';
import { SCREENINGS_KEY } from '../lib/festival-screenings.mjs';
import { festivalFixture, now } from './festival-fixture.mjs';
import { xrFixture, screeningFixture } from './festival-screenings-fixture.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'kaiyan-xr-ui-'));
const { data, saved } = festivalFixture(), { row } = screeningFixture();
const { feed, catalog, xr, regular } = xrFixture();
let server, browser;
try {
  for (const dir of ['catalog', 'data/festivals', 'lib', 'web/festivals']) await mkdir(join(scratch, dir), { recursive: true });
  for (const file of ['lib/festival-calendar.mjs', 'lib/festival-screenings.mjs', 'web/festivals/app.mjs', 'web/festivals/style.css', 'web/festivals/index.html']) {
    await copyFile(new URL('../' + file, import.meta.url), join(scratch, file));
  }
  await writeFile(join(scratch, 'catalog/festivals.json'), JSON.stringify(catalog));
  const build = async content => {
    await writeFile(join(scratch, 'data/festivals/screenings.json'), JSON.stringify(content));
    await buildFestivalCalendar({ root: scratch, payload: data });
    return JSON.parse(await readFile(join(scratch, 'out/festivals/data.json'), 'utf8'));
  };
  const ready = await build(feed);
  assert.equal(ready.screenings.extraSources[0].rows.length, 2);
  const bad = structuredClone(feed); bad.extraSources[0].rows[0].endMins = 1;
  const isolated = await build(bad);
  assert.equal(isolated.screenings.extraSources[0].status, 'failed');
  assert.equal(isolated.screenings.sources.find(s => s.festivalId === 'kff-2026').rows.length, 1);
  assert.deepEqual(isolated.schedule, ready.schedule, 'bad XR never modifies the ordinary schedule');
  let served = structuredClone(ready), legacyHTML = false;
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/festivals/data.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(served)); return; }
      const file = path.endsWith('/') ? path + 'index.html' : path;
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript' }[extname(file)] || 'text/plain') + '; charset=utf-8');
      let body = await readFile(join(scratch, 'out', file));
      if (legacyHTML && extname(file) === '.html') body = body.toString().replace(/<label>類型 <select id="screening-kind">.*?<\/label>/, '').replace(/<button id="day-more"[^>]*>.*?<\/button>/, '');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
  let page = await context.newPage(); const errors = [], external = [];
  const watch = async p => {
    await p.clock.setFixedTime(new Date(now));
    p.on('pageerror', e => errors.push(e.message));
    p.on('request', r => { if (!r.url().startsWith(base)) external.push(r.url()); });
  };
  await watch(page);
  const original = { 'kaiyan.sessions': JSON.stringify(saved), 'kaiyan.favorites': JSON.stringify({ movies: ['保留'] }),
    [SCREENINGS_KEY]: JSON.stringify([row, regular]) };
  await context.addInitScript(values => {
    for (const [key, value] of Object.entries(values)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }, original);
  const open = async (view = 'screenings') => { await page.goto(base + '/festivals/?view=' + view); await page.locator('#app').waitFor({ state: 'visible' }); };
  await open();
  assert.equal(await page.locator('#month-items .item').count(), 5);
  assert.match(await page.locator('#source-list').textContent(), /測試金馬：官網目前無可讀場次，待公布／核對/);
  assert.match(await page.locator('#source-list').textContent(), /最近檢查.*尚未取得場次/);
  await page.locator('#screening-kind').selectOption('xr');
  assert.equal(await page.locator('#month-items .item').count(), 2);
  assert.equal(await page.locator('#month-items [data-screening-format="screening"]').count(), 0);
  assert.match(await page.locator('#month-items').innerText(), /選片方式依官方/);
  assert.match(await page.locator('#month-items').innerText(), /收藏不是預約或購票/);
  await page.locator('#film-search').fill('星空'); assert.equal(await page.locator('#month-items .item').count(), 2);
  await page.locator('#film-search').fill('不存在'); assert.equal(await page.locator('#month-items .item').count(), 0);
  await page.locator('#film-search').fill('');
  await page.locator('#festival-select').selectOption('kff-2026');
  await page.locator('#screening-kind').selectOption('screening'); assert.equal(await page.locator('#month-items .item').count(), 1);
  await page.locator('#screening-kind').selectOption('all'); assert.equal(await page.locator('#month-items .item').count(), 3);
  await page.locator('#month-items [data-save="kff-2026:xr:100"]').click();
  let stored = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SCREENINGS_KEY);
  assert.deepEqual(stored, [row, regular, xr]);
  await page.close(); page = await context.newPage(); await watch(page); await open('saved');
  assert.equal(await page.locator('#month-items [data-screening-id="kff-2026:xr:100"][data-session-state="current"]').count(), 1);
  assert.match(await page.locator('#export-note').innerText(), /可匯出 6 場/);
  const pending = page.waitForEvent('download'); await page.locator('#export').click();
  const ics = await readFile(await (await pending).path(), 'utf8');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 6); assert.match(ics, /DTSTART:20990101T050000Z/); assert.match(ics, /DTEND:20990101T054000Z/);
  assert.equal(new Set(ics.match(/UID:[^\r\n]+/g)).size, 6);
  served.screenings.extraSources[0].rows[0].mins += 5;
  await open('saved'); assert.equal(await page.locator('#month-items [data-session-state="changed"]').count(), 1);
  assert.match(await page.locator('#export-note').innerText(), /可匯出 5 場/);
  assert.deepEqual(await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SCREENINGS_KEY), stored);
  await page.locator('#month-items [data-session-state="changed"] button', { hasText: '確認異動' }).click();
  stored = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SCREENINGS_KEY);
  assert.equal(stored.at(-1).mins, xr.mins + 5);
  served.screenings.extraSources[0].status = 'failed';
  await open();
  assert.equal(await page.locator('#month-items [data-save="kff-2026:xr:101"]').isDisabled(), true);
  assert.equal(await page.locator('#month-items [data-save="kff-2026:100"]').isDisabled(), false);
  await page.locator('#mode-saved').click(); assert.match(await page.locator('#export-note').innerText(), /可匯出 5 場/);
  assert.equal(await page.locator('#month-items [data-screening-id="kff-2026:xr:100"][data-session-state="unverified"]').count(), 1);
  delete served.screenings.extraSources;
  await open('saved'); assert.equal(await page.locator('#month-items [data-screening-id="kff-2026:xr:100"][data-session-state="missing"]').count(), 1);
  assert.deepEqual(await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SCREENINGS_KEY), stored);
  served = structuredClone(ready); served.screenings.extraSources = { invalid: true };
  await open(); assert.equal(await page.locator('#month-items .item').count(), 3, 'broken extension leaves original sources browsable');
  served = structuredClone(ready);
  await open(); await page.locator('#screening-kind').selectOption('xr');
  await page.locator('#mode-festivals').click();
  await page.locator('#month-items [data-festival-id="kff-2026"] button', { hasText: '挑選個別場次' }).click();
  assert.equal(await page.locator('#screening-kind').inputValue(), 'all');
  assert.equal(await page.locator('#month-items .item').count(), 3);
  served.screenings.extraSources[0].rows = Array.from({ length: 50 }, (_, i) => ({ ...xr, id: 'kff-2026:xr:' + (1000 + i) }));
  await open(); await page.locator('#screening-kind').selectOption('xr');
  assert.equal(await page.locator('#day-items .item').count(), 6);
  assert.equal(await page.locator('#month-items .item').count(), 40);
  assert.match(await page.locator('#day-more').innerText(), /6／50/);
  await page.locator('#day-more').click(); assert.equal(await page.locator('#day-items .item').count(), 12);
  await page.locator('#show-more').click(); assert.equal(await page.locator('#month-items .item').count(), 50);
  await page.locator('#film-search').fill('Experience'); assert.equal(await page.locator('#day-items .item').count(), 6);
  await page.locator('[data-day="2099-01-02"]').click(); assert.equal(await page.locator('#day-more').isVisible(), false);
  await page.locator('[data-day="2099-01-01"]').click(); assert.equal(await page.locator('#day-items .item').count(), 6);
  for (const width of [320, 360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['screenings', 'saved', 'festivals']) {
      await page.locator('#mode-' + mode).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no XR overflow ' + width + ' ' + mode);
    }
  }
  legacyHTML = true;
  await open();
  assert.equal(await page.locator('#screening-kind').count(), 0);
  assert.equal(await page.locator('#day-items .item').count(), 52, 'cached old HTML loads new JS without truncating an unexpandable day');
  await page.locator('#mode-festivals').click();
  await page.locator('#month-items [data-festival-id="kff-2026"] button', { hasText: '挑選個別場次' }).click();
  assert.equal(await page.locator('#month-items .item').count(), 40);
  const unchanged = await page.evaluate(() => [localStorage.getItem('kaiyan.sessions'), localStorage.getItem('kaiyan.favorites')]);
  assert.deepEqual(unchanged, [original['kaiyan.sessions'], original['kaiyan.favorites']]);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('XR UI OK: category/search, independent recovery, save/reopen/confirm/ICS, Golden Horse pending, legacy storage and 5 viewport sizes');
} finally {
  await browser?.close(); if (server) await new Promise(ok => server.close(ok));
  await rm(scratch, { recursive: true, force: true });
}
