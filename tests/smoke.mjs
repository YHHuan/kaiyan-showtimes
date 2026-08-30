import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(new URL('..', import.meta.url).pathname);
const out = resolve(root, 'out');
const types = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

async function localFile(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidates = [resolve(out, clean || 'index.html'), resolve(root, clean || 'index.html')];
  for (let file of candidates) {
    if (!file.startsWith(out + sep) && !file.startsWith(root + sep)) continue;
    try {
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      return { file, body: await readFile(file) };
    } catch {}
  }
  return null;
}

const server = createServer(async (req, res) => {
  const found = await localFile(new URL(req.url, 'http://localhost').pathname);
  if (!found) { res.writeHead(404).end('not found'); return; }
  res.setHeader('Content-Type', types[extname(found.file)] || 'application/octet-stream');
  res.writeHead(200).end(found.body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const address = server.address();
const base = `http://127.0.0.1:${address.port}/`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

try {
  const response = await page.goto(base, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`首頁 HTTP ${response?.status()}`);
  if (!(await page.title()).includes('開演')) throw new Error('首頁 title 不正確');
  if (await page.locator('#format option').count() < 2) throw new Error('影廳格式選項未產生');
  const viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  if (viewport.scrollWidth > viewport.width + 1) throw new Error(`手機版出現水平溢出：${viewport.scrollWidth}/${viewport.width}`);
  if (process.env.SCREENSHOT_DIR) {
    await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, 'home-mobile.png') });
  }

  const firstFavorite = page.locator('.favbtn').first();
  await firstFavorite.click();
  if (await firstFavorite.getAttribute('aria-pressed') !== 'true') throw new Error('收藏切換失敗');
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (await page.locator('.favbtn[aria-pressed="true"]').count() < 1) throw new Error('收藏未保存於本機');

  await page.locator('#vPlan').click();
  await page.locator('#planStart').fill('00:00');
  await page.locator('#planStart').dispatchEvent('change');
  await page.locator('#planEnd').fill('23:59');
  await page.locator('#planEnd').dispatchEvent('change');
  await page.locator('.planrow').first().waitFor({ state: 'visible' });
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, 'planner-mobile.png') });
  }
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.calbtn').first().click();
  const download = await downloadPromise;
  if (!download.suggestedFilename().endsWith('.ics')) throw new Error('行事曆下載格式錯誤');

  const manifest = await (await page.request.get(`${base}manifest.webmanifest`)).json();
  if (manifest.name !== '開演｜全台電影時刻' || manifest.icons.length < 2) throw new Error('PWA manifest 不完整');
  const status = await (await page.request.get(`${base}site-status.json`)).json();
  if (!status.counts?.sessions || !status.coverage?.lastDate) throw new Error('site-status.json 不完整');
  const sitemap = await (await page.request.get(`${base}sitemap.xml`)).text();
  if (!sitemap.includes('/movie/') || !sitemap.includes('/cinema/') || !sitemap.includes('/date/')) throw new Error('sitemap 缺少索引頁');
  const moviePath = sitemap.match(/\/movie\/[^<]+\//)?.[0];
  if (!moviePath) throw new Error('sitemap 找不到電影索引網址');
  const seoResponse = await page.request.get(new URL(moviePath.replace(/^\//, ''), base).href);
  if (!seoResponse.ok() || !(await seoResponse.text()).includes('電影時刻')) throw new Error('電影索引頁無法讀取');
  if (errors.length) throw new Error(`瀏覽器錯誤：${errors.join(' | ')}`);
  console.log(`smoke OK: ${status.counts.sessions} 場、${status.counts.cinemas} 影城、${status.counts.movies} 部片`);
} finally {
  await browser.close();
  await new Promise((ok) => server.close(ok));
}
