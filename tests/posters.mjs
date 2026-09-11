import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// 每張測試海報都有四個不同色塊。跨列、最右欄、最後一格都要裁到同一張完整海報，
// 不只檢查圖片已載入：用實際截圖像素確認沒有縮放錯位或混入相鄰電影。
const cols = 10, rows = 3, count = 24, cellW = 62, cellH = 93;
function palette(index) {
  return Array.from({ length: 4 }, (_, quadrant) => [
    20 + (index * 47 + quadrant * 73) % 210,
    20 + (index * 31 + quadrant * 41) % 210,
    20 + (index * 59 + quadrant * 97) % 210,
  ]);
}
const tiles = Array.from({ length: count }, (_, i) => palette(i).map((color, q) =>
  `<rect x="${(i % cols) * cellW + (q % 2) * cellW / 2}" y="${Math.floor(i / cols) * cellH + Math.floor(q / 2) * cellH / 2}" width="${cellW / 2}" height="${cellH / 2}" fill="rgb(${color})"/>`).join('')).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cellW}" height="${rows * cellH}">${tiles}</svg>`;
const data = {
  cinemas: [['測試影城', '台北市']], movies: Array.from({ length: 29 }, (_, i) => ['海報測試' + String(i).padStart(2, '0'), '', '普']),
  dates: ['2030-01-01'], halls: ['大廳'], tags: ['數位'], urls: ['https://example.org/movie'],
  prices: [], geo: [], meta: Object.fromEntries(Array.from({ length: count }, (_, i) => [i, { i, d: 90 }])),
  sprite: { uri: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), cols, rows },
  packed: Array.from({ length: 29 }, (_, i) => [0, i, 0, 0, 0, 0, 1200].map(n => n.toString(36)).join(',')).join(';'),
};
// 缺圖與不合法索引只能略過，不能裁成另一部片或把整張圖集露出來。
data.meta[25] = { i: -1 };
data.meta[26] = { i: cols * rows };
data.meta[27] = { i: 1.5 };
data.meta[28] = { i: '1' };
const template = await readFile(new URL('../site_template.html', import.meta.url), 'utf8');
function html(noSprite) {
  let result = template.replace('__DATA__', () => JSON.stringify({ ...data, sprite: noSprite ? null : data.sprite }))
    .replaceAll('__NOTICE__', '').replaceAll('__SITE_URL__', 'http://localhost')
    .replaceAll('__NCINEMA__', '1').replaceAll('__NMOVIE__', '29').replaceAll('__LASTDATE__', '01/01')
    .replaceAll('__GENERATED__', '2030/1/1 12:00').replaceAll('__SOURCES__', '測試');
  const script = result.match(/<script>([\s\S]*?)<\/script>/)[1];
  return result.replace('__SCRIPT_HASH__', createHash('sha256').update(script).digest('base64'));
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') res.setHeader('Content-Type', 'text/html; charset=utf-8'), res.end(html(url.searchParams.has('no_sprite')));
  else res.writeHead(204).end();
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });
const errors = [];
let checked = 0;
async function checkPoster(page, poster, index, label) {
  await poster.locator('img').evaluate(im => im.decode());
  // 截取海報本身：先置中並等候手機固定列完成收合，避免把浮在上方的控制列當成海報像素。
  await poster.evaluate(async box => {
    for (let i = 0; i < 2; i++) {
      box.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
    }
  });
  assert.ok(await poster.evaluate(box => {
    const b = box.getBoundingClientRect();
    return [b.top + 2, b.bottom - 2].every(y => box.contains(document.elementFromPoint(b.left + b.width / 2, y)));
  }), `${label}: poster must not be covered by sticky controls`);
  const actual = await poster.evaluate(box => {
    const im = box.querySelector('img'), b = box.getBoundingClientRect(), r = im.getBoundingClientRect();
    return [(b.left - r.left) * im.naturalWidth / r.width, (b.top - r.top) * im.naturalHeight / r.height,
      b.width * im.naturalWidth / r.width, b.height * im.naturalHeight / r.height];
  });
  const expected = [index % cols * cellW, Math.floor(index / cols) * cellH, cellW, cellH];
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 0.06, `${label}: crop[${i}] ${value} != ${expected[i]}`));
  const screenshot = await poster.screenshot({ animations: 'disabled' });
  const pixels = await page.evaluate(async encoded => {
    const im = new Image();
    im.src = 'data:image/png;base64,' + encoded;
    await im.decode();
    const canvas = document.createElement('canvas');
    canvas.width = im.naturalWidth; canvas.height = im.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(im, 0, 0);
    const points = [];
    for (const y of [0.07, 0.47, 0.53, 0.93]) for (const x of [0.07, 0.47, 0.53, 0.93]) {
      points.push({ q: (x >= 0.5 ? 1 : 0) + (y >= 0.5 ? 2 : 0), rgb: [...ctx.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data].slice(0, 3) });
    }
    return points;
  }, screenshot.toString('base64'));
  for (const pixel of pixels) pixel.rgb.forEach((v, c) => assert.ok(Math.abs(v - palette(index)[pixel.q][c]) <= 5, `${label}: quadrant ${pixel.q} color ${pixel.rgb} != ${palette(index)[pixel.q]}`));
  checked++;
}
try {
  for (const [width, dpr] of [[1280, 1], [390, 2], [320, 1], [1280, 2]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.clock.setFixedTime(new Date('2030-01-01T12:00:00+08:00'));
    for (const index of [0, 9, 10, 18, 23]) {
      const title = data.movies[index][0], label = `${width}px @${dpr}x movie ${index}`;
      await page.goto(base + '?q=' + encodeURIComponent(title));
      await checkPoster(page, page.locator('.poster'), index, label + ' home');
      await page.getByRole('button', { name: title, exact: true }).click();
      await checkPoster(page, page.locator('.poster.big'), index, label + ' detail');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    // 分享連結直入、重新整理、旋轉／調整視窗及非整數 CSS 尺寸都不依賴先前的縮放狀態。
    await page.goto(base + '?m=' + encodeURIComponent(data.movies[18][0]));
    await page.reload();
    await page.setViewportSize({ width: width < 500 ? 844 : 390, height: 900 });
    await checkPoster(page, page.locator('.poster.big'), 18, `${width} direct/reload/resize`);
    await page.locator('.poster.big').evaluate(box => {
      box.style.width = '55.5px'; box.style.flexBasis = '55.5px'; box.style.height = '83.25px';
    });
    await checkPoster(page, page.locator('.poster.big'), 18, `${width} fractional size`);
    await page.locator('.back').click();
    const card = page.locator('.card').filter({ has: page.getByRole('button', { name: data.movies[18][0], exact: true }) });
    await checkPoster(page, card.locator('.poster'), 18, `${width} return to list`);
    for (const index of [24, 25, 26, 27, 28]) {
      await page.goto(base + '?m=' + encodeURIComponent(data.movies[index][0]));
      assert.equal(await page.locator('.poster').count(), 0, `Invalid poster index ${index} must be omitted`);
    }
    await page.goto(base + '?no_sprite=1');
    assert.equal(await page.locator('.poster').count(), 0);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`posters OK: ${checked} 次海報裁切與像素檢查；首頁／內頁／返回／直連／重載／轉向、手機與桌機、1x／2x、缺圖與錯誤索引`);
} finally {
  await browser.close();
  await new Promise(ok => server.close(ok));
}
