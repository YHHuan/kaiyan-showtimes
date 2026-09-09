import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// 固定日期與兩個同時、不同廳的場次，測試收藏在每日索引重排及資料消失後的行為。
const template = await readFile(new URL('../site_template.html', import.meta.url), 'utf8');
let reordered = false;
let missing = false;
function fixture() {
  const movies = (reordered ? ['測試乙片', '測試甲片'] : ['測試甲片', '測試乙片']).map(x => [x, '', '普']);
  const cinemas = (reordered ? ['台中測試影城', '台北測試影城'] : ['台北測試影城', '台中測試影城']).map(x => [x, x.startsWith('台北') ? '台北市' : '台中市']);
  const halls = reordered ? ['小廳', '大廳'] : ['大廳', '小廳'];
  const tags = ['數位・英語', '3D・英語'];
  const dates = ['2030-01-01', '2030-01-02', '2030-01-03'];
  const urls = reordered ? ['https://example.org/b-new', 'https://example.org/a-new'] : ['https://example.org/a', 'https://example.org/b'];
  const samples = [
    ['測試甲片', '台北測試影城', 0, '大廳', 0, 1200],
    ['測試甲片', '台北測試影城', 0, '小廳', 1, 1200],
    ['測試甲片', '台北測試影城', 2, '大廳', 0, 1080],
    ['測試乙片', '台中測試影城', 0, '小廳', 0, 780],
    ['測試乙片', '台中測試影城', 1, '小廳', 0, 1200],
  ].filter(x => !missing || x[0] !== '測試甲片');
  const packed = samples.map(([movie, cinema, di, hall, ti, mins]) => [
    cinemas.findIndex(x => x[0] === cinema), movies.findIndex(x => x[0] === movie), di,
    halls.indexOf(hall), ti, urls.findIndex(x => x.includes(movie === '測試甲片' ? '/a' : '/b')), mins,
  ].map(x => x.toString(36)).join(',')).join(';');
  return { cinemas, movies, halls, tags, dates, urls, packed, prices: [], geo: [], meta: { 0: { d: 100 }, 1: { d: 90 } }, sprite: null };
}
function html() {
  let result = template.replace('__DATA__', () => JSON.stringify(fixture()))
    .replaceAll('__NOTICE__', '').replaceAll('__SITE_URL__', 'http://localhost')
    .replaceAll('__NCINEMA__', '2').replaceAll('__NMOVIE__', '2').replaceAll('__LASTDATE__', '01/03')
    .replaceAll('__GENERATED__', '2030/1/1 12:00').replaceAll('__SOURCES__', '測試');
  const script = result.match(/<script>([\s\S]*?)<\/script>/)[1];
  return result.replace('__SCRIPT_HASH__', createHash('sha256').update(script).digest('base64'));
}
const server = createServer((req, res) => {
  if (new URL(req.url, 'http://localhost').pathname === '/') res.setHeader('Content-Type', 'text/html; charset=utf-8'), res.end(html());
  else res.writeHead(204).end();
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });
const errors = [];
async function newPage(context) {
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.setFixedTime(new Date('2030-01-01T12:00:00+08:00'));
  return page;
}
async function stored(page) {
  return page.evaluate(() => ({ ...JSON.parse(localStorage.getItem('kaiyan.favorites') || '{}'), sessions: JSON.parse(localStorage.getItem('kaiyan.sessions') || '[]') }));
}
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
  let page = await newPage(context);
  await page.goto(base);
  await page.evaluate(() => localStorage.setItem('kaiyan.favorites', JSON.stringify({ movies: ['早已下檔的電影'], cinemas: ['台北測試影城'] })));
  await page.reload();
  await page.getByRole('button', { name: '收藏 測試甲片', exact: true }).click();
  await page.getByRole('button', { name: '測試甲片', exact: true }).click();
  const time = page.locator('.t').filter({ hasText: '20:00' }).first();
  await time.click();
  assert.equal(await time.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.t[aria-pressed="true"]').count(), 1, '同時不同廳不可一併收藏');
  assert.deepEqual((await stored(page)).sessions[0], { movie: '測試甲片', cinema: '台北測試影城', date: '2030-01-01', mins: 1200, hall: '大廳', tag: '數位・英語' });

  // 收藏總覽忽略目前的查詢日期／篩選，且包含舊版已下檔的收藏。
  await page.locator('#my-favorites').click();
  assert.equal(await page.locator('.saved-session').count(), 1);
  assert.match(await page.locator('#list').innerText(), /早已下檔的電影/);
  assert.match(await page.locator('#list').innerText(), /目前未查到未來場次，收藏仍會保留/);
  assert.equal(await page.locator('.saved-session .bookbtn').getAttribute('href'), 'https://example.org/a');
  const beforeReset = await stored(page);
  await page.goto(base + '?v=plan&a=台中市&f=3D&ps=20:00&pe=04:00&mp=300&md=5&q=不存在&m=測試甲片&dd=2030-01-03&fav=1&e=1&n=1&t=1');
  await page.locator('#home').click();
  assert.equal(new URL(page.url()).search, '', '首頁應清空網址條件');
  assert.equal(await page.locator('#area').inputValue(), '全部');
  assert.equal(await page.locator('#q').inputValue(), '');
  assert.equal(await page.locator('#vMovie').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#planStart').inputValue(), '18:00');
  assert.equal(await page.locator('#planEnd').inputValue(), '23:59');
  assert.deepEqual(await stored(page), beforeReset, '重設不能刪除收藏');
  await page.reload();
  assert.equal(new URL(page.url()).search, '', '重開首頁不能復活舊篩選');

  // 關閉分頁再開同一瀏覽器：收藏仍在；每日重排後使用更新過的該片購票網址。
  await page.close();
  reordered = true;
  page = await newPage(context);
  await page.goto(base + '?saved=1');
  assert.equal(await page.locator('.saved-session .bookbtn').getAttribute('href'), 'https://example.org/a-new');
  assert.equal(await page.locator('.saved-session').count(), 1);
  await page.locator('#home').click();
  await page.getByRole('button', { name: '測試甲片', exact: true }).click();
  assert.equal(await page.locator('.t[aria-pressed="true"]').count(), 1, '索引重排後仍應認得相同場次');

  // 同瀏覽器分頁之間同步；另一個獨立瀏覽器沒有這份收藏。
  const otherTab = await newPage(context);
  await otherTab.goto(base + '?saved=1');
  await page.locator('.t[aria-pressed="true"]').click();
  await otherTab.locator('.saved-session').waitFor({ state: 'detached' });
  await page.locator('.t').filter({ hasText: '20:00' }).first().click();
  await otherTab.locator('.saved-session').waitFor();
  // 模擬尚未重新整理的舊版分頁：它只會寫 movies/cinemas，不能覆蓋單場收藏。
  await otherTab.evaluate(() => {
    const old = JSON.parse(localStorage.getItem('kaiyan.favorites'));
    localStorage.setItem('kaiyan.favorites', JSON.stringify({ movies: old.movies, cinemas: old.cinemas }));
  });
  await page.reload();
  assert.equal(await page.locator('.t[aria-pressed="true"]').count(), 1, '舊版分頁寫入不能刪掉場次收藏');
  const separate = await browser.newContext();
  const separatePage = await newPage(separate);
  await separatePage.goto(base + '?saved=1');
  assert.match(await separatePage.locator('#list').innerText(), /先留下一部想看的電影吧/);
  await separate.close();

  // 上游未取得場次時保留快照，不能誤報「取消」或提供另一部片的購票網址。
  missing = true;
  await page.goto(base + '?saved=1');
  assert.match(await page.locator('.saved-session').innerText(), /本輪未查到此場次/);
  assert.equal(await page.locator('.saved-session a, .saved-session .calbtn').count(), 0);
  await page.clock.setFixedTime(new Date('2030-01-02T00:01:00+08:00'));
  await page.reload();
  assert.match(await page.locator('.saved-session').innerText(), /已開演／已過期/);
  await page.locator('#home').click();
  assert.equal(await page.locator('.day[aria-pressed="true"] b').innerText(), '01/02', '跨午夜／海外裝置仍以台北日期為準');
  assert.equal(await page.locator('.day').count(), 2, '隔天不可繼續列昨天的日期');

  // 瀏覽器拒絕寫入時不能假裝成功，壞掉的舊收藏資料也不能讓整頁當掉。
  missing = false;
  await page.goto(base);
  await page.evaluate(() => {
    Storage.prototype.setItem = function () { throw new DOMException('blocked', 'QuotaExceededError'); };
  });
  const failButton = page.getByRole('button', { name: '收藏 測試乙片', exact: true });
  await failButton.click();
  assert.equal(await failButton.getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('#save-status').innerText(), /無法儲存收藏/);
  await page.reload();
  await page.evaluate(() => localStorage.setItem('kaiyan.favorites', '{broken'));
  await page.goto(base + '?saved=1');
  assert.equal(await page.locator('.saved-session').count(), 1, '電影收藏資料毀損時仍應保留獨立的場次收藏');
  await page.evaluate(() => {
    localStorage.setItem('kaiyan.favorites', '{broken');
    localStorage.setItem('kaiyan.sessions', '{broken');
  });
  await page.goto(base + '?saved=1');
  assert.match(await page.locator('#list').innerText(), /先留下一部想看的電影吧/);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['', '?m=測試甲片', '?saved=1']) {
      await page.goto(base + path);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px 畫面不可水平溢出`);
    }
  }
  assert.deepEqual(errors, [], '瀏覽器不可拋出未處理錯誤');
  console.log('saved OK: 首頁重設、舊收藏相容、單場辨識、重開保存、資料重排、多分頁同步、過期與缺漏、儲存失敗、台北跨日、手機與桌機');
} finally {
  await browser.close();
  await new Promise(ok => server.close(ok));
}
