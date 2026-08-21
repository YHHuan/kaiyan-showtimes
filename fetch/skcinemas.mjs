// 新光影城：場次 API 需要 timestamp/DID/token 簽章 header（token 由前端 JS 產生），
// 純 curl 會被回 9002「資料驗證異常」。用無頭瀏覽器載入官方場次頁、讀它自己發出的回應。
// 影城代碼由實測點擊各頁籤得到（?c=xxxx）。
import { withPage, catchJson } from '../lib/browser.mjs';
import { saveRecords, normTitle } from '../lib/common.mjs';

const CINEMAS = [
  { id: '1001', name: '台北獅子林新光影城', area: '台北市' },
  { id: '1005', name: '台北天母新光影城', area: '台北市' },
  { id: '1004', name: '桃園青埔新光影城', area: '桃園市' },
  { id: '1003', name: '台中中港新光影城', area: '台中市' },
  { id: '1002', name: '台南西門新光影城', area: '台南市' },
];

const records = await withPage(async (page) => {
  const out = [];
  for (const c of CINEMAS) {
    const pending = catchJson(page, 'GetSessionByCinemasIDForApp').catch(() => null);
    await page.goto(`https://www.skcinemas.com/sessions?c=${c.id}`, { waitUntil: 'domcontentloaded' });
    const res = await pending;
    const data = res?.data;
    if (!data?.Session?.length) {
      console.log(`  ${c.name}: 無資料（可能站方暫時異常）`);
      continue;
    }
    const films = new Map(data.SessionFilm.map((f) => [f.FilmNameID, f]));
    let n = 0;
    for (const s of data.Session) {
      // 站方偶爾把其他館的場次一起回來，只留這一館的
      if (s.CinemasID && s.CinemasID !== c.id) continue;
      const film = films.get(s.FilmNameID);
      if (!film) continue;
      out.push({
        source: 'skcinemas',
        cinema: c.name,
        area: c.area,
        movie: normTitle(film.FilmName),
        date: (s.BusinessDate || s.ShowDate).replace(/\//g, '-'),
        time: (s.ShowTime || '').slice(0, 5),
        hall: s.ScreenName || null,
        tags: [s.FilmType || film.FilmType].filter(Boolean),
        url: `https://www.skcinemas.com/sessions?c=${c.id}`,
      });
      n++;
    }
    console.log(`  ${c.name}: ${n}`);
    await page.waitForTimeout(600);
  }
  return out;
});

await saveRecords(new URL('../data/skcinemas.json', import.meta.url).pathname, records);
