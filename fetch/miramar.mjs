// 美麗華大直影城：官方訂票頁用 POST /api/Booking/GetMovie/ 載入完整片單與多日場次。
// 這是唯讀查詢，不接觸選位、購票或會員流程。
import { politeFetch, saveRecords, normTitle } from '../lib/common.mjs';

const BASE = 'https://www.miramarcinemas.tw';
const payload = await politeFetch(`${BASE}/api/Booking/GetMovie/`, {
  asJson: true,
  method: 'POST',
  headers: {
    Referer: `${BASE}/booking/timetable`,
    'Content-Type': 'application/json',
  },
});

if (payload?.RC !== 1 || !Array.isArray(payload?.results?.mMovies)) {
  throw new Error('美麗華官方場次 API 格式可能改了');
}

const records = [];
for (const movie of payload.results.mMovies) {
  const title = normTitle(movie.TitleAlt || movie.Title);
  if (!title) continue;
  for (const day of movie.mShowTimes || []) {
    const date = String(day.date || '').slice(0, 10);
    for (const cinema of day.mCinemas || []) {
      for (const session of cinema.mSessions || []) {
        const time = String(session.Showtime || '').split('T')[1]?.slice(0, 5);
        if (!date || !time) continue;
        records.push({
          source: 'miramar',
          cinema: '美麗華大直影城',
          area: '台北市',
          movie: title,
          movieEn: movie.Title || null,
          rating: movie.Rating || null,
          date,
          time,
          hall: cinema.CinemaTitle || null,
          tags: [],
          url: `${BASE}/booking/timetable`,
        });
      }
    }
  }
}

await saveRecords(new URL('../data/miramar.json', import.meta.url).pathname, records);
