import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

// 重現 2026/9/17 起的 CI 失敗；版本、同片多活動及收藏都走真正的建站與頁面。
const scratch = await mkdtemp(join(tmpdir(), 'kaiyan-activity-links-'));
let server, browser;
try {
  for (const dir of ['data', 'lib', 'assets', '.cache/local-skcinemas']) await mkdir(join(scratch, dir), { recursive: true });
  for (const file of ['build_site.mjs', 'site_template.html', 'lib/common.mjs', 'lib/movie-identity.mjs', 'lib/cinema-coverage.mjs']) {
    await copyFile(new URL('../' + file, import.meta.url), join(scratch, file));
  }
  await copyFile(new URL('../icon-192.png', import.meta.url), join(scratch, 'assets', 'fixture.png'));
  const publisherState = '{"lastPublishedAt":"2099-01-01T00:00:00Z"}';
  await writeFile(join(scratch, '.cache/local-skcinemas/published.json'), publisherState);
  const original = '復仇者聯盟：終局之戰', encore = original + ' 加碼重映', activity = '同片不同活動入口';
  const baseRow = { source: 'srm', cinema: '日日新影城', area: '台中市', date: '2099-01-01', hall: '一般廳', tags: [] };
  const url = id => 'https://srm.com.tw/product.php?_path=product_detail&upid=32&id=' + id;
  const rows = [
    { ...baseRow, movie: original, time: '10:00', sourceMovieId: '818', sourceRuntimeMin: 206, url: url('818') },
    { ...baseRow, movie: encore, time: '12:10', sourceMovieId: '833', sourceRuntimeMin: 182, url: url('833') },
    { ...baseRow, movie: activity, time: '20:00', url: url('event-a') },
    { ...baseRow, movie: activity, time: '20:00', url: url('event-b') },
    { ...baseRow, movie: activity, time: '20:00', url: url('event-a') }, // 真正重複才去重
    { ...baseRow, movie: '遙遠銀河彼端的新世界', time: '16:00', sourceMovieId: '901', sourceRuntimeMin: 90, url: url('901') },
    { ...baseRow, movie: '遙遠銀河彼端的新世界旅程', time: '18:00', sourceMovieId: '902', sourceRuntimeMin: 90, url: url('902') },
    { ...baseRow, movie: '一段很長很長的冒險故事', time: '15:00', sourceRuntimeMin: 90, url: url('903') },
    { ...baseRow, movie: '一段很長很長的冒險故事旅程', time: '17:00', sourceRuntimeMin: 120, url: url('904') },
  ];
  await writeFile(join(scratch, 'data/srm.json'), JSON.stringify(rows));
  await writeFile(join(scratch, 'data/movie_meta.json'), JSON.stringify(Object.fromEntries([
    [original, 206], [encore, 182], [activity, 90],
  ].map(([title, runtimeMin]) => [title, {
    matchedTitle: title, matchVersion: 3, runtimeMin, synopsis: title, thumb: 'assets/fixture.png',
  }]))));
  execFileSync(process.execPath, [join(scratch, 'build_site.mjs')], { cwd: scratch, stdio: 'pipe' });
  const html = await readFile(join(scratch, 'out/index.html'), 'utf8');
  const data = JSON.parse(html.match(/(?:const|var) DATA\s*=\s*(\{[^\n]+\});/)[1]);
  const originalIdx = data.movies.findIndex(m => m[0] === original), encoreIdx = data.movies.findIndex(m => m[0] === encore);
  assert.ok(originalIdx >= 0 && encoreIdx >= 0 && originalIdx !== encoreIdx, '不同版本不能被截斷補全合併');
  assert.equal(data.meta[originalIdx].d, 206);
  assert.equal(data.meta[encoreIdx].d, 182);
  assert.equal(data.movies.length, 7, '同館不同來源 ID 或片長衝突不能只憑相近片名合併');
  const activityIdx = data.movies.findIndex(m => m[0] === activity);
  const groups = data.packed.split(';').map(g => g.split(','));
  const activityGroups = groups.filter(g => parseInt(g[1], 36) === activityIdx);
  assert.equal(activityGroups.length, 2, '同片同時但不同活動 URL 不能被去重丟掉；相同 URL 不應重複');
  assert.deepEqual(activityGroups.map(g => data.urls[parseInt(g[5], 36)]).sort(), [url('event-a'), url('event-b')]);
  assert.ok(data.sprite, '確實執行海報建置以測試快取隔離');
  assert.equal(await readFile(join(scratch, '.cache/local-skcinemas/published.json'), 'utf8'), publisherState,
    '重建海報不可清除新光本機排程的狀態／鎖檔');

  server = createServer((req, res) => {
    if (new URL(req.url, 'http://localhost').pathname === '/') res.setHeader('Content-Type', 'text/html; charset=utf-8'), res.end(html);
    else res.writeHead(204).end();
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.clock.setFixedTime(new Date('2099-01-01T08:00:00+08:00'));
  for (const [movie, id, otherId, duration] of [[original, '818', '833', 206], [encore, '833', '818', 182]]) {
    await page.goto(base + '?m=' + encodeURIComponent(movie));
    assert.match(await page.locator('#list').innerText(), new RegExp(duration + ' 分'));
    const links = await page.locator('.vlink').evaluateAll(els => els.map(el => el.href));
    assert.ok(links.includes(url(id)));
    assert.ok(!links.includes(url(otherId)), '不能把另一個版本的活動連結混進來');
  }
  for (const query of ['?m=' + encodeURIComponent(activity), '?v=cinema']) {
    await page.goto(base + query);
    for (const id of ['event-a', 'event-b']) {
      const row = page.locator('.venue').filter({ has: page.locator('a.vlink[href="' + url(id) + '"]') });
      assert.equal(await row.count(), 1, '電影與戲院檢視都要保留每個活動入口');
      assert.match(await row.innerText(), /20:00/);
    }
  }
  await page.goto(base + '?m=' + encodeURIComponent(activity));
  await page.locator('.t').first().click();
  await page.goto(base + '?saved=1');
  assert.equal(await page.locator('.saved-session').count(), 1, '保留既有收藏格式與場次辨識');
  assert.match(await page.locator('.saved-session').innerText(), /多個活動入口/);
  assert.equal(await page.locator('.saved-session .calbtn').count(), 0, '歧義收藏不能把任選的活動網址寫入行事曆');
  assert.deepEqual((await page.locator('.saved-session .bookbtn').evaluateAll(els => els.map(el => el.href))).sort(),
    [url('event-a'), url('event-b')], '歧義收藏必須提供所有本輪入口，不能任選最後一筆');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('kaiyan.sessions')));
  assert.equal(saved[0].url, undefined, '不保存過期購票連結');
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const query of ['?m=' + encodeURIComponent(activity), '?v=cinema', '?saved=1']) {
      await page.goto(base + query);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px 不可水平溢出`);
    }
  }
  assert.deepEqual(errors, []);
  console.log('activity links OK: 版本／來源 ID／片長保護、同時多入口去重、電影／戲院／收藏連結、海報快取隔離、手機與桌機');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(ok => server.close(ok));
  await rm(scratch, { recursive: true, force: true });
}
