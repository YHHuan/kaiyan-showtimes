// in89 豪華數位影城：頁面本身是 Vue 動態渲染（curl 只拿到空殼），用無頭瀏覽器讀渲染後的 DOM。
// 場次掛在 a[data-field]（"YYYY-MM-DD HH:MM:SS"），廳別在同區塊的 .time-array。
// 注意不能只認 a.selectTime：訂票截止後站方會拿掉那個 class（連結變灰），
// 但場次本身還在。只認 selectTime 會漏掉當天較早的場次，深夜更是整場空。
// 西門館（TheaterId=3）已於 2026-05-31 停業，只剩桃園站前(1)、高雄駁二(2)。
import { withPage, attempt } from '../lib/browser.mjs';
import { saveRecords, normTitle } from '../lib/common.mjs';

const THEATERS = [
  { id: '1', area: '桃園市' },
  { id: '2', area: '高雄市' },
];
const DAYS = 7;

const records = await withPage(async (page) => {
  const out = [];
  for (const th of THEATERS) {
    // 不要等 networkidle——這站有分析與廣告請求，CI 上永遠靜不下來（實測兩次都 60 秒逾時）。
    // 改成等 DOM 可用後，直接等真正要解析的節點出現，這才是「載好了」的正確判準。
    const loaded = await attempt(`in89 ${th.id}`, async () => {
      await page.goto(`https://www.in89cinemax.com/film_list.aspx?TheaterId=${th.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('div.list a[data-field]', { timeout: 45000 });
      return true;
    });
    if (!loaded) continue;
    await page.waitForTimeout(1200);

    const cinema = (await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /in89/i.test(e.textContent || '') && (e.textContent || '').length < 30);
      return el ? el.textContent.trim() : null;
    })) || `in89豪華影城 ${th.id}`;

    const seenDates = new Set();
    for (let d = 0; d < DAYS; d++) {
      const day = await page.evaluate(() => {
        const label = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^\d{4}-\d{2}-\d{2}/.test((e.textContent || '').trim()));
        const rows = [];
        for (const block of document.querySelectorAll('div.list')) {
          const ps = [...block.querySelectorAll('.movie_info p')].map((p) => p.textContent.replace(/\s+/g, ' ').trim());
          const title = ps[0];
          if (!title) continue;
          const en = ps[1] && !/^片|^分|^上映/.test(ps[1]) ? ps[1] : null;
          const format = ps.find((t) => /2D|3D|數位|IMAX/.test(t)) || null;
          const rating = (ps.find((t) => /^分\s*級/.test(t)) || '').replace(/^分\s*級:\s*/, '') || null;
          for (const info of block.querySelectorAll('.stage_info')) {
            const a = info.querySelector('a[data-field]');
            if (!a) continue;
            const field = a.getAttribute('data-field');
            if (!field) continue;
            const hall = info.querySelector('.time-array div');
            rows.push({ title, en, format, rating, field, hall: hall ? hall.textContent.trim() : null });
          }
        }
        return { label: label ? label.textContent.trim().slice(0, 10) : null, rows };
      });

      if (!day.label || seenDates.has(day.label)) break; // 日期沒再往前推＝已到最後一天
      seenDates.add(day.label);
      for (const r of day.rows) {
        const [date, time] = r.field.split(' ');
        out.push({
          source: 'in89',
          cinema,
          area: th.area,
          movie: normTitle(r.title),
          movieEn: r.en,
          rating: r.rating,
          date,
          time: (time || '').slice(0, 5),
          hall: r.hall,
          tags: r.format ? [r.format] : [],
          url: `https://www.in89cinemax.com/film_list.aspx?TheaterId=${th.id}`,
        });
      }

      const next = await page.$('a.date_next');
      if (!next) break;
      await next.click();
      await page.waitForTimeout(1600);
    }
    console.log(`  ${cinema}: 累計 ${out.length}（${seenDates.size} 天）`);
  }
  return out;
});

await saveRecords(new URL('../data/in89.json', import.meta.url).pathname, records);
