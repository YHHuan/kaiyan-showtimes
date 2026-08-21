// 美麗新影城：場次 JSON 整包內嵌在 timetable 頁的 var CinemaList = '...'
import { politeFetch, saveRecords, normTitle } from '../lib/common.mjs';

function areaOf(name) {
  if (/台茂|桃園/.test(name)) return '桃園市';
  if (/淡海|淡水|板橋|新莊|三重|中和|永和/.test(name)) return '新北市';
  if (/大直|台北|信義|士林/.test(name)) return '台北市';
  return '';
}

const html = await politeFetch('https://www.miranewcinemas.com/booking/timetable');
const m = html.match(/var CinemaList = '([\s\S]*?)';/);
if (!m) throw new Error('找不到 CinemaList 內嵌 JSON，頁面結構可能改了');
// 內容是 JS 單引號字串包住的 JSON（雙引號以 \" 逸出）→ 先解字串再解 JSON
const payload = JSON.parse(JSON.parse(`"${m[1].replace(/\\'/g, "'")}"`));

const records = [];
for (const c of payload.Data.CinemaGroup || []) {
  for (const mv of c.MovieInfo || []) {
    for (const day of mv.ShowDateList || []) {
      const date = day.ShowDateISO.slice(0, 10);
      for (const hallGroup of day.ShowTimeList || []) {
        for (const s of hallGroup.SessionList || []) {
          records.push({
            source: 'miranew',
            cinema: c.CinemaCName,
            area: areaOf(c.CinemaCName),
            movie: normTitle(mv.MovieCName),
            date,
            time: s.ShowTime,
            hall: hallGroup.MovieHallCht || null,
            // Rate 是分級（PG-15/G/P），不是影廳規格——放進 tags 會在場次上顯示成版本標籤
            rating: mv.Rate || null,
            tags: [],
            url: 'https://www.miranewcinemas.com/booking/timetable',
          });
        }
      }
    }
  }
}

await saveRecords(new URL('../data/miranew.json', import.meta.url).pathname, records);
