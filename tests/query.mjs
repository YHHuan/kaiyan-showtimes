import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// 美國夏令時間切換日刻意落在查詢的隔日，海外裝置也必須保留台北日期與時間。
const template = await readFile(new URL('../site_template.html', import.meta.url), 'utf8');
const samples = [
  [0, 0, 0, 1260, 0], [0, 0, 0, 1380, 0], [1, 0, 0, 1080, 0], [2, 0, 0, 1020, 0],
  [1, 1, 1, 60, 1], [1, 1, 1, 180, 1], [1, 1, 0, 1200, 2],
  [1, 2, 0, 780, 0], [1, 2, 0, 1200, 0], [1, 2, 0, 60, 0],
  [1, 2, 1, 120, 0], [1, 2, 1, 241, 0], [1, 2, 1, 780, 0], [1, 2, 2, 60, 0],
  [2, 3, 0, 1080, 0], [2, 4, 0, 1080, 0],
];
const data = {
  cinemas: [['台北測試影城', '台北市'], ['台中測試影城', '台中市'], ['台南測試影城', '台南市']],
  movies: [['台北物語', 'Taipei Story', '普'], ['蜘蛛人：重生日', 'Spider-Man', '普'], ['未知片長電影', '', '普'], ['氣氛', 'Atmosphere', '普'], ['台北物語2', '', '普']],
  dates: ['2030-03-09', '2030-03-10', '2030-03-11'], halls: ['大廳'], tags: ['數位・英語', '4DX・英語', 'ULTRA 3D・英語'],
  urls: ['https://example.org/book?date={d}'], prices: [], geo: [], meta: { 0: { d: 90 }, 1: { d: 90 }, 3: { d: 90 }, 4: { d: 90 } }, sprite: null,
  packed: samples.map(([ci, mi, di, mins, ti]) => [ci, mi, di, 0, ti, 0, mins].map(n => n.toString(36)).join(',')).join(';'),
};
let html = template.replace('__DATA__', () => JSON.stringify(data))
  .replaceAll('__NOTICE__', '').replaceAll('__SITE_URL__', 'http://localhost')
  .replaceAll('__NCINEMA__', '3').replaceAll('__NMOVIE__', '5').replaceAll('__LASTDATE__', '03/11')
  .replaceAll('__GENERATED__', '2030/3/9 12:00').replaceAll('__SOURCES__', '測試');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
html = html.replace('__SCRIPT_HASH__', createHash('sha256').update(script).digest('base64'));
const server = createServer((req, res) => {
  if (new URL(req.url, 'http://localhost').pathname === '/') res.setHeader('Content-Type', 'text/html; charset=utf-8'), res.end(html);
  else res.writeHead(204).end();
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });
const errors = [];
async function calendar(page, row) {
  const pending = page.waitForEvent('download');
  await row.locator('.calbtn').click();
  const download = await pending;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.setFixedTime(new Date('2030-03-09T12:00:00+08:00'));
  await page.goto(base + '?v=plan&ps=20:00&pe=04:00&n=1');
  const rows = page.locator('.planrow');
  assert.deepEqual(await rows.locator('.plantime').evaluateAll(els => els.map(el => el.firstChild.textContent)), ['20:00', '20:00', '21:00', '23:00', '01:00', '02:00'], '需跨日期排序，不得把所選日凌晨當成隔天或放進超時場次');
  assert.match(await page.locator('#summary').innerText(), /2030-03-09 20:00–翌日 04:00/);
  const overnight = rows.filter({ hasText: '01:00' });
  assert.match(await overnight.locator('.plantime').innerText(), /翌日 03\/10/);
  assert.equal(await overnight.locator('.bookbtn').getAttribute('href'), 'https://example.org/book?date=2030-03-10');
  const ics = await calendar(page, overnight);
  assert.match(ics, /DTSTART;TZID=Asia\/Taipei:20300310T010000/);
  assert.match(ics, /DTEND;TZID=Asia\/Taipei:20300310T024200/, '夏令時間不能把台北 02:42 改成 03:42');
  await overnight.locator('.favbtn').click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('kaiyan.sessions'))[0].date), '2030-03-10');
  const unknown = rows.filter({ hasText: '未知片長電影' });
  assert.equal(await unknown.count(), 2);
  assert.match(await unknown.first().innerText(), /片長未提供，無法確認散場時間/);
  const unknownIcs = await calendar(page, unknown.last());
  assert.doesNotMatch(unknownIcs, /DTEND/);
  assert.match(unknownIcs, /未設定結束時間/);

  await page.goto(base + '?v=plan&ps=18:00&pe=23:59&n=1');
  assert.equal(await page.locator('.planrow').filter({ hasText: '未知片長電影' }).count(), 1, '片長未知也必須檢查開始時間上下界');
  assert.equal(await page.locator('.planrow .plantime').filter({ hasText: '翌日' }).count(), 0);
  await page.goto(base + '?v=plan&ps=20:00&pe=00:42&n=1');
  assert.ok(await page.locator('.planrow .plantime').filter({ hasText: '23:00' }).count(), '恰好截止時間散場可納入');
  await page.goto(base + '?v=plan&ps=20:00&pe=00:41&n=1');
  assert.equal(await page.locator('.planrow .plantime').filter({ hasText: '23:00' }).count(), 0, '晚一分鐘也須排除');

  async function query(text, extra = {}) {
    const params = new URLSearchParams({ q: text, v: 'cinema', n: '1', ...extra });
    await page.goto(base + '?' + params);
    return page.locator('#list .card h2').allTextContents();
  }
  assert.deepEqual(new Set(await query('台北物語')), new Set(['台北測試影城', '台中測試影城', '台南測試影城']), '完整片名不得自動限縮台北市');
  assert.deepEqual(await query('臺北物語台中'), ['台中測試影城']);
  assert.deepEqual(await query('台北物語2'), ['台南測試影城'], '長片名優先於前作');
  assert.deepEqual(await query('Atmosphere'), ['台南測試影城'], '英文片名內 Atmos 不可當成影廳條件');
  assert.deepEqual(await query('蜘蛛人4D台中', { d: '2030-03-10' }), ['台中測試影城']);
  assert.deepEqual(await query('蜘蛛人4D台中'), [], 'ULTRA 3D 不屬於 4D');
  assert.deepEqual(await query('蜘蛛人ULTRA3D台中'), ['台中測試影城']);
  await page.goto(base + '?m=台北物語&v=plan');
  assert.equal(await page.locator('#vMovie').getAttribute('aria-pressed'), 'true', '單片網址不應混入時間檢視');

  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(base + '?v=plan&ps=20:00&pe=04:00&n=1');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px 不可水平溢出`);
  }
  assert.deepEqual(errors, []);
  console.log('query OK: 跨午夜、片長未知、散場邊界、排序、訂票日期、收藏日期、海外行事曆、完整片名與 4D 複合搜尋');
} finally {
  await browser.close();
  await new Promise(ok => server.close(ok));
}
