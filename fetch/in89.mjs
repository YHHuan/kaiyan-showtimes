// in89 豪華數位影城：頁面本身是 Vue 動態渲染（curl 只拿到空殼），用無頭瀏覽器讀渲染後的 DOM。
// 場次掛在 a.selectTime 的 data-field（"YYYY-MM-DD HH:MM:SS"），廳別在同區塊的 .time-array。
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
    // 原本吞掉導覽失敗會靜靜產出 0 筆——那正是最難察覺的壞法，改成重試後才放棄
    const loaded = await attempt(`in89 ${th.id}`, async () => {
      await page.goto(`https://www.in89cinemax.com/film_list.aspx?TheaterId=${th.id}`, { waitUntil: 'networkidle' });
      return true;
    });
    if (!loaded) continue;
    await page.waitForTimeout(2500);

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
            const a = info.querySelector('a.selectTime');
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
