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
  const areaOptions = (await page.locator('#area option').allTextContents()).filter((x) => x !== '全部地區');
  const geographicOrder = ['台北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '台中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'];
  const expectedAreas = geographicOrder.filter((x) => areaOptions.includes(x));
  if (areaOptions.join('|') !== expectedAreas.join('|')) throw new Error(`縣市不是地理順序：${areaOptions.join('、')}`);
  if (!(await page.content()).includes('美麗華大直影城')) throw new Error('缺少美麗華大直影城');
  if (await page.locator('.credits').count() < 1) throw new Error('電影卡片沒有導演／演員資料');
  await page.evaluate(() => {
    const option = document.createElement('option');
    option.value = '__測試無場次__';
    option.textContent = '測試無場次';
    document.querySelector('#area').appendChild(option);
  });
  await page.locator('#area').selectOption('__測試無場次__');
  await page.locator('#q').fill('美麗華大直影城');
  await page.locator('#q').dispatchEvent('input');
  await page.locator('#vCinema').click();
  if (!(await page.locator('.empty b').innerText()).includes('有收錄「美麗華大直影城」')) {
    throw new Error('已收錄戲院的無場次提示不正確');
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
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
  await page.locator('#planStart').fill('20:00');
  await page.locator('#planStart').dispatchEvent('change');
  await page.locator('#planEnd').fill('04:00');
  await page.locator('#planEnd').dispatchEvent('change');
  // 測試可能在深夜執行；納入今天已開演場次，避免「當下沒有未開演場次」造成時間依賴。
  if (await page.locator('#tSoon').getAttribute('aria-pressed') !== 'true') await page.locator('#tSoon').click();
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
