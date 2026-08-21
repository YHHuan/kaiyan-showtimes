// 樂聲影城（西門町）：server-rendered HTML；片單頁拿 film_id，逐片抓場次（官方只公開今+明兩天）
import { politeFetch, saveRecords, normTitle } from '../lib/common.mjs';

const BASE = 'https://www.luxcinema.com.tw/web';
const HALL = { XL: '巨幕XL廳(800席)', L: '大廳(218席)' };

const listHtml = await politeFetch(`${BASE}/2020.php?type=ShowTimes`);
const ids = [...new Set([...listHtml.matchAll(/2020-movie_item\.php\?film_id=(\d+)/g)].map((m) => m[1]))];
console.log(`樂聲片單 ${ids.length} 部`);

const records = [];
for (const id of ids) {
  const html = await politeFetch(`${BASE}/2020-movie_item.php?film_id=${id}`);
  const title = (html.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1]?.trim();
  if (!title) continue;
  const rating = (html.match(/級別\s*\|\s*([^<\s]+)/) || [])[1] || null;
  for (const s of html.matchAll(/showtime=(\d{4}-\d{2}-\d{2})[^"]*"><b>\s*([0-9]{1,2}:[0-9]{2})\s*(?:<span>\|<\/span>([A-Z]+))?/g)) {
    records.push({
      source: 'lux',
      cinema: '樂聲影城(西門町)',
      area: '台北市',
      movie: normTitle(title),
      rating,
      date: s[1],
      time: s[2].padStart(5, '0'),
      hall: HALL[s[3]] || HALL.XL, // 頁面慣例：無標記者為巨幕XL廳
      tags: [],
      url: `${BASE}/2020-movie_item.php?film_id=${id}`,
    });
  }
}

await saveRecords(new URL('../data/lux.json', import.meta.url).pathname, records);
