import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { MOVIE_ALIASES } from '../lib/movie-identity.mjs';

const template = await readFile(new URL('../site_template.html', import.meta.url), 'utf8');
const samples = [
  [0, 0, 0, 655, 0], [0, 0, 1, 725, 0], [1, 0, 0, 810, 0], [1, 1, 0, 575, 0],
  [1, 2, 0, 1285, 1], [1, 3, 0, 1050, 2], [1, 3, 0, 1170, 0], [1, 4, 0, 1200, 0],
];
const data = {
  cinemas: [['台北天母新光影城', '台北市'], ['台北信義威秀', '台北市'], ['缺資料影城', '台北市']],
  movies: [['驀然回首(真人版)', '', '普'], ['驀然回首(動畫)', '', '普'], ['蜘蛛人：重生日', '', '普'],
    ['劇場版 吉伊卡哇 人魚島的秘密', '', '普'], ['超異能快感：魔法之書', '', '護']],
  dates: ['2030-01-01', '2030-01-02'], halls: [null], tags: ['日語發音', '4DX版', '國語發音'],
  urls: ['https://example.org/book?date={d}'], prices: [], geo: [], sprite: null,
  meta: { 0: { d: 100, r: '是枝裕和' }, 1: { d: 58, r: '押山清高' }, 2: { d: 145 } },
  aliases: MOVIE_ALIASES,
  coverage: [
    { name: '台北天母新光影城', area: '台北市', dates: ['2030-01-01', '2030-01-02'], state: 'ok', url: 'https://example.org/tianmu' },
    { name: '台北信義威秀', area: '台北市', dates: ['2030-01-01'], failedDates: ['2030-01-01'], state: 'partial', url: 'https://example.org/vieshow' },
    { name: '缺資料影城', area: '台北市', dates: [], state: 'missing', url: 'https://example.org/missing' },
  ],
  packed: samples.map(([ci, mi, di, mins, ti]) => [ci, mi, di, 0, ti, 0, mins].map(n => n.toString(36)).join(',')).join(';'),
};
let html = template.replace('__DATA__', () => JSON.stringify(data))
  .replaceAll('__NOTICE__', '').replaceAll('__SITE_URL__', 'http://localhost')
  .replaceAll('__NCINEMA__', '3').replaceAll('__NMOVIE__', '5').replaceAll('__LASTDATE__', '01/02')
  .replaceAll('__GENERATED__', '2030/1/1 08:00').replaceAll('__SOURCES__', '測試');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
html = html.replace('__SCRIPT_HASH__', createHash('sha256').update(script).digest('base64'));
const server = createServer((req, res) => {
  if (new URL(req.url, 'http://localhost').pathname === '/') res.setHeader('Content-Type', 'text/html; charset=utf-8'), res.end(html);
  else res.writeHead(204).end();
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.setFixedTime(new Date('2030-01-01T08:00:00+08:00'));
  await page.goto(base);
  assert.match(await page.locator('#coverage-note').innerText(), /2 家影城的所選日期資料不足/);
  await page.locator('#coverage-note summary').click();
  assert.match(await page.locator('#coverage-note').innerText(), /部分日期抓取失敗/, '保留快取的日期仍必須顯示更新失敗');
  await page.goto(base + '?m=' + encodeURIComponent('驀然回首(真人版)'));
  assert.match(await page.locator('#list').innerText(), /100 分/);
  assert.match(await page.locator('#list').innerText(), /台北天母新光影城/);
  assert.match(await page.locator('#list').innerText(), /01\/02/);
  await page.goto(base + '?m=' + encodeURIComponent('驀然回首(動畫)'));
  assert.match(await page.locator('#list').innerText(), /58 分/);
  assert.doesNotMatch(await page.locator('#list').innerText(), /台北天母新光影城/);
  await page.goto(base + '?' + new URLSearchParams({ q: '蜘蛛人4D台北', m: '蜘蛛人：重生日' }));
  assert.match(await page.locator('#list').innerText(), /21:25/);
  await page.goto(base + '?' + new URLSearchParams({ q: '吉伊卡哇', m: '劇場版 吉伊卡哇 人魚島的秘密', g: '國語' }));
  assert.match(await page.locator('#list').innerText(), /17:30/);
  assert.doesNotMatch(await page.locator('#list').innerText(), /19:30/);
  await page.goto(base + '?' + new URLSearchParams({ q: '吉伊卡哇', m: '劇場版 吉伊卡哇 人魚島的秘密', g: '日語' }));
  assert.match(await page.locator('#list').innerText(), /19:30/);
  assert.doesNotMatch(await page.locator('#list').innerText(), /17:30/);
  await page.goto(base + '?m=' + encodeURIComponent('超異能快感2'));
  assert.match(await page.locator('#list').innerText(), /超異能快感：魔法之書/);
  await page.goto(base + '?q=' + encodeURIComponent('超異能快感2台北'));
  assert.equal(await page.locator('#list .card').count(), 1);
  await page.evaluate(() => localStorage.setItem('kaiyan.favorites', JSON.stringify({ movies: ['超異能快感2', '驀然回首'], cinemas: [] })));
  await page.goto(base + '?saved=1');
  assert.equal(await page.locator('.saved-item').count(), 2);
  assert.match(await page.locator('#list').innerText(), /重新選擇版本/);
  await page.locator('.saved-item').filter({ hasText: '超異能快感2' }).locator('.titlebtn').click();
  assert.match(await page.locator('#list').innerText(), /超異能快感：魔法之書/);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kaiyan.favorites')).movies), ['超異能快感2', '驀然回首']);

  await page.clock.setFixedTime(new Date('2030-01-02T00:01:00+08:00'));
  await page.goto(base);
  assert.match(await page.locator('#summary').innerText(), /2030-01-02/);
  assert.match(await page.locator('#list').innerText(), /驀然回首\(真人版\)/);
  assert.equal(await page.locator('#list .card').count(), 1);
  assert.match(await page.locator('#coverage-note').innerText(), /2 家影城的所選日期資料不足/);
  await page.locator('#coverage-note summary').click();
  assert.match(await page.locator('#coverage-note').innerText(), /不代表沒有放映/);
  assert.equal(await page.locator('#coverage-note a').count(), 2);
  await page.goto(base + '?q=' + encodeURIComponent('缺資料影城'));
  assert.match(await page.locator('.empty').innerText(), /有收錄/);
  assert.match(await page.locator('#coverage-note').innerText(), /1 家影城的所選日期資料不足/);
  await page.clock.setFixedTime(new Date('2030-01-03T00:01:00+08:00'));
  await page.goto(base);
  assert.match(await page.locator('#summary').innerText(), /2030-01-03/);
  assert.equal(await page.locator('#list .card').count(), 0, '資料用完也不能把昨天場次當今天');
  assert.match(await page.locator('#coverage-note').innerText(), /3 家影城的所選日期資料不足/);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('#coverage-note summary').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  assert.deepEqual(errors, []);
  console.log('coverage UI OK: 真人／動畫分流、多日、4DX、配音、別名／收藏相容、海外午夜、缺館與過期提示');
} finally { await browser.close(); await new Promise(ok => server.close(ok)); }
