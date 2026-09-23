import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

// 真正建站：舊開眼快取含版權文字，加上必須完整保留的長中文／無空白英文格式標籤。
const scratch = await mkdtemp(join(tmpdir(), 'kaiyan-labels-'));
const footer = '&copy; @movies All rights reserved 開眼電影網版權所有';
const longLabels = ['杜比全景聲巨幕影廳・原音中文字幕・映後導演與演員交流特別放映場', 'ULTRALONGLABEL'.repeat(12)];
const movie = '長版本標籤測試片', cinema = '台中iFG遠雄廣場威秀影城';
const dates = ['2099-01-01', '2099-01-02'];
let server, browser;
try {
  for (const dir of ['data', 'lib']) await mkdir(join(scratch, dir));
  for (const file of ['build_site.mjs', 'site_template.html', 'lib/common.mjs', 'lib/movie-identity.mjs', 'lib/cinema-coverage.mjs', 'lib/schedule-parsers.mjs']) {
    await copyFile(new URL('../' + file, import.meta.url), join(scratch, file));
  }
  const baseRow = { source: 'atmovies', movie, cinema, area: '台中市', sourceMovieId: 'flabel', hall: null,
    url: 'https://example.org/book', fetchedAt: '2098-12-31T23:00:00Z' };
  const rows = dates.flatMap(date => [
    { ...baseRow, date, time: '10:00', tags: [longLabels[0]] },
    { ...baseRow, date, time: '12:00', tags: [longLabels[1]] },
    { ...baseRow, date, time: '14:00', tags: ['TITAN廳', footer] },
    { ...baseRow, date, time: '14:00', tags: ['TITAN廳'] }, // 清理後才能正確去重
    { ...baseRow, date, time: '16:00', tags: ['Gold Class・' + footer] },
  ]);
  const cached = JSON.stringify(rows);
  await writeFile(join(scratch, 'data/atmovies.json'), cached);
  execFileSync(process.execPath, [join(scratch, 'build_site.mjs')], { cwd: scratch, stdio: 'pipe' });
  const html = await readFile(join(scratch, 'out/index.html'), 'utf8');
  const data = JSON.parse(html.match(/(?:const|var) DATA\s*=\s*(\{[^\n]+\});/)[1]);
  server = createServer((req, res) => {
    if (new URL(req.url, 'http://localhost').pathname === '/') res.setHeader('Content-Type', 'text/html; charset=utf-8'), res.end(html);
    else res.writeHead(204).end();
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let layouts = 0;
  for (const day of dates) {
    await page.clock.setFixedTime(new Date(day + 'T00:00:00+08:00'));
    for (const width of [320, 390, 640, 641, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const params of [{ v: 'cinema', d: day }, { v: 'movie', d: day }, { m: movie, dd: day }]) {
        await page.goto(base + '?' + new URLSearchParams(params));
        if (params.v === 'movie') await page.locator('.cardtoggle').click();
        const labels = await page.locator('.verlabel').allTextContents();
        for (const label of longLabels) assert.ok(labels.includes(label), '不得截斷合法長標籤');
        const layout = await page.evaluate(() => {
          const bad = [...document.querySelectorAll('.verlabel, .vergroup > .times, .vergroup .t')].flatMap(el => {
            const r = el.getBoundingClientRect();
            if (r.left < 0 || r.right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
              return [{ class: el.className, text: el.textContent.slice(0, 90), left: r.left, right: r.right }];
            }
            if (innerWidth <= 640 && el.matches('.t') && (r.width < 44 || r.height < 44)) return [{ targetTooSmall: true }];
            return [];
          });
          return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bad };
        });
        assert.ok(layout.scrollWidth <= width + 1 && !layout.bad.length,
          `${day} ${width}px ${JSON.stringify(params)}: ${JSON.stringify(layout)}`);
        const time = page.locator('.vergroup .t').first();
        await time.click();
        assert.equal(await time.getAttribute('aria-pressed'), 'true', '時間按鈕不可被遮住或失去收藏功能');
        await time.click();
        layouts++;
      }
    }
  }
  assert.doesNotMatch(JSON.stringify(data.tags), /@movies|版權所有/, '純快取重建也必須清除錯誤標籤');
  const status = JSON.parse(await readFile(join(scratch, 'out/site-status.json'), 'utf8'));
  assert.equal(status.counts.sessions, 8, '在去重前清理，保留各日期和真正不同時間');
  assert.equal(await readFile(join(scratch, 'data/atmovies.json'), 'utf8'), cached, '建站不能覆寫來源快取或刷新抓取時間');

  // 舊瀏覽器曾存下污染標籤，升級後仍要認得同一場，而不是誤報場次消失。
  await page.evaluate(({ movie, cinema, footer }) => localStorage.setItem('kaiyan.sessions', JSON.stringify([
    { movie, cinema, date: '2099-01-02', mins: 840, hall: '', tag: 'TITAN廳・' + footer },
    { movie, cinema, date: '2099-01-02', mins: 840, hall: '', tag: 'TITAN廳' },
  ])), { movie, cinema, footer });
  await page.goto(base + '?saved=1');
  assert.equal(await page.locator('.saved-session').count(), 1, '污染標籤與乾淨收藏應辨識為同一場');
  assert.equal(await page.locator('.saved-session .bookbtn').getAttribute('href'), 'https://example.org/book');
  assert.doesNotMatch(await page.locator('.saved-session').innerText(), /@movies|版權所有|本輪未取得/);
  await page.reload();
  assert.equal(await page.locator('.saved-session .bookbtn').getAttribute('href'), 'https://example.org/book');
  assert.deepEqual(errors, []);
  console.log(`labels OK: ${layouts} 次跨日／電影／戲院／內頁／手機斷點／桌機排版、長標籤完整可讀、舊快取去重、污染收藏相容`);
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(ok => server.close(ok));
  await rm(scratch, { recursive: true, force: true });
}
