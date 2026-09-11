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

async function ensureVisibleMovieCards() {
  if (await page.locator('.favbtn').count()) return;
  if (await page.locator('#tSoon').getAttribute('aria-pressed') !== 'true') {
    if (await page.locator('#extra').getAttribute('hidden') !== null) await page.locator('#more-filters').click();
    await page.locator('#tSoon').click();
    await page.locator('#close-filters').click();
  }
  await page.locator('.favbtn').first().waitFor({ state: 'visible' });
}

async function checkPosterCrops() {
  await page.locator('.poster img').evaluateAll(ims => Promise.all(ims.map(im => im.decode())));
  const failures = await page.locator('.poster').evaluateAll(boxes => boxes.flatMap(box => {
    const title = box.closest('.head').querySelector('h2').textContent;
    const mi = DATA.movies.findIndex(m => m[0] === title), index = DATA.meta[mi]?.i;
    if (!Number.isInteger(index)) return [title + ': missing poster index'];
    const im = box.querySelector('img'), b = box.getBoundingClientRect(), r = im.getBoundingClientRect();
    const cw = im.naturalWidth / DATA.sprite.cols, ch = im.naturalHeight / DATA.sprite.rows;
    const actual = [(b.left - r.left) * im.naturalWidth / r.width, (b.top - r.top) * im.naturalHeight / r.height,
      b.width * im.naturalWidth / r.width, b.height * im.naturalHeight / r.height];
    const expected = [index % DATA.sprite.cols * cw, Math.floor(index / DATA.sprite.cols) * ch, cw, ch];
    return actual.some((v, i) => !Number.isFinite(v) || Math.abs(v - expected[i]) > 0.1) ? [title + ': poster crop mismatch'] : [];
  }));
  if (failures.length) throw new Error(failures.join(' | '));
}

try {
  const response = await page.goto(base, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`首頁 HTTP ${response?.status()}`);
  if (!(await page.title()).includes('開演')) throw new Error('首頁 title 不正確');
  if (await page.locator('#format option').count() < 2) throw new Error('影廳格式選項未產生');
  if (await page.locator('#extra').evaluate((el) => getComputedStyle(el).display) !== 'none') {
    throw new Error('「篩選」面板在初始狀態沒有隱藏');
  }
  for (const selector of ['#vMovie', '#area', '#q', '#more-filters']) {
    const box = await page.locator(selector).boundingBox();
    if (!box || box.height < 44) throw new Error(`手機觸控目標過小：${selector} ${box?.height || 0}px`);
  }
  await page.locator('#more-filters').click();
  if (await page.locator('#extra').getAttribute('role') !== 'dialog' || await page.locator('#filter-backdrop').isHidden()) {
    throw new Error('手機篩選面板沒有以底部對話框開啟');
  }
  await page.locator('#close-filters').click();
  const areaOptions = (await page.locator('#area option').allTextContents()).filter((x) => x !== '全部地區');
  const geographicOrder = ['台北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '台中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'];
  const expectedAreas = geographicOrder.filter((x) => areaOptions.includes(x));
  if (areaOptions.join('|') !== expectedAreas.join('|')) throw new Error(`縣市不是地理順序：${areaOptions.join('、')}`);
  if (!(await page.content()).includes('美麗華大直影城')) throw new Error('缺少美麗華大直影城');
  await ensureVisibleMovieCards();
  if (await page.locator('.credits').count() < 1) throw new Error('電影卡片沒有導演／演員資料');
  await checkPosterCrops();
  const posterTitle = await page.evaluate(() => DATA.movies.find((m, mi) => DATA.meta[mi]?.i > 0)?.[0]);
  if (!posterTitle) throw new Error('缺少可測試的非首格海報');
  await page.goto(base + '?n=1&m=' + encodeURIComponent(posterTitle), { waitUntil: 'domcontentloaded' });
  if (await page.locator('.poster.big').count() !== 1) throw new Error('單片頁缺少海報');
  await checkPosterCrops();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await ensureVisibleMovieCards();

  // 同一家戲院可能每部片都有不同活動頁（TFAI／OPENTIX 就是如此），不能把整家戲院
  // 壓成一個網址。從本輪資料動態找一館兩個不同連結，確認單片頁仍指向該片自己的頁面。
  const linkCase = await page.evaluate(() => {
    const byCinema = {};
    for (const group of DATA.packed.split(';')) {
      const f = group.split(',');
      const ci = parseInt(f[0], 36), mi = parseInt(f[1], 36), di = parseInt(f[2], 36);
      const ui = parseInt(f[5], 36), template = DATA.urls[ui];
      if (!template) continue;
      if (!byCinema[ci]) byCinema[ci] = [];
      if (!byCinema[ci].some((x) => x.template === template)) byCinema[ci].push({ mi, di, template });
    }
    for (const [ciText, samples] of Object.entries(byCinema)) {
      if (samples.length < 2) continue;
      const ci = Number(ciText), sample = samples[1], date = DATA.dates[sample.di];
      return {
        cinema: DATA.cinemas[ci][0],
        movie: DATA.movies[sample.mi][0],
        expected: sample.template
          .replace('{d}', date)
          .replace('{s}', encodeURIComponent(date.replace(/-/g, '/'))),
      };
    }
    return null;
  });
  if (!linkCase) throw new Error('找不到可測試的同館不同活動連結');
  const movieUrl = new URL(base);
  movieUrl.searchParams.set('m', linkCase.movie);
  await page.goto(movieUrl.href, { waitUntil: 'domcontentloaded' });
  const movieLinks = await page.locator('.vlink').filter({ hasText: linkCase.cinema }).evaluateAll((els) => els.map((el) => el.href));
  if (!movieLinks.includes(linkCase.expected)) {
    throw new Error(`單片活動連結配錯：${linkCase.cinema}／${linkCase.movie} → ${movieLinks.join('、')}`);
  }
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await ensureVisibleMovieCards();

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
  // 測試用的假地區會由 onchange 寫入 localStorage；先恢復「全部」，否則 reload 後該 option
  // 已不存在，頁面會維持零結果，接下來自然也沒有足夠高度可測 sticky 控制列。
  await page.locator('#area').selectOption('全部');
  // 回到不帶查詢參數的乾淨首頁；reload 會保留剛才的 q/v，深夜時可能沒有可收藏卡片。
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await ensureVisibleMovieCards();
  const viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  if (viewport.scrollWidth > viewport.width + 1) throw new Error(`手機版出現水平溢出：${viewport.scrollWidth}/${viewport.width}`);
  await page.evaluate(() => scrollTo(0, Math.min(700, document.documentElement.scrollHeight - innerHeight)));
  await page.waitForTimeout(100);
  const compactControls = await page.locator('.controls').boundingBox();
  if (!compactControls || compactControls.height > 70 || await page.locator('.controls').getAttribute('class') !== 'controls is-compact') {
    throw new Error(`捲動後控制列沒有縮小：${compactControls?.height || 0}px`);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(100);

  // 搜尋框要看得懂「片名＋地區＋格式」，即使三者沒有空格。從本輪資料動態挑一場，
  // 避免把測試綁死在某部電影或某一天；4D 泛稱則會選到真正的 4DX／MX4D。
  const compound = await page.evaluate(() => {
    for (const group of DATA.packed.split(';')) {
      const f = group.split(',');
      const ci = parseInt(f[0], 36), mi = parseInt(f[1], 36), di = parseInt(f[2], 36);
      const hi = parseInt(f[3], 36), ti = parseInt(f[4], 36);
      const raw = `${DATA.tags[ti] || ''} ${DATA.halls[hi] || ''}`;
      let format = null;
      if (/MX4D|4DX/i.test(raw)) format = '4D';
      else if (/DOLBY\s*CINEMA/i.test(raw)) format = 'Dolby Cinema';
      else if (/IMAX/i.test(raw)) format = 'IMAX';
      else if (/SCREEN\s*X/i.test(raw)) format = 'ScreenX';
      if (!format) continue;
      const area = DATA.cinemas[ci][1] || '';
      return { di, query: `${DATA.movies[mi][0]}${format}${area.replace(/[市縣]$/, '')}` };
    }
    return null;
  });
  if (!compound) throw new Error('找不到可測試自然語句搜尋的特殊影廳場次');
  await page.locator('.day').nth(compound.di).click();
  await page.locator('#q').fill(compound.query);
  await page.locator('#q').dispatchEvent('input');
  if (!await page.locator('.card').count()) throw new Error(`自然語句搜尋沒有找到場次：${compound.query}`);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await ensureVisibleMovieCards();
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
  if (await page.locator('#tSoon').getAttribute('aria-pressed') !== 'true') {
    await page.locator('#more-filters').click();
    await page.locator('#tSoon').click();
    await page.locator('#close-filters').click();
  }
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
