// 國賓影城：server-rendered HTML；TheaterList 拿各館 GUID，再逐館逐日抓 Showtime 頁解析
import { politeFetch, saveRecords, normTitle, todayISO } from '../lib/common.mjs';

const BASE = 'https://www.ambassador.com.tw';
const DAYS = 7; // 實測各館約公開 6~7 天

const listHtml = await politeFetch(`${BASE}/home/TheaterList`);
const theaters = [];
for (const m of listHtml.matchAll(/href="[^"]*Showtime\?ID=([a-f0-9-]{36})[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
  const lines = m[2].replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) continue;
  const [name, address = ''] = lines;
  if (theaters.some((t) => t.id === m[1])) continue;
  theaters.push({ id: m[1], name, area: address.slice(0, 3) });
}
console.log(`國賓據點 ${theaters.length} 家:`, theaters.map((t) => t.name).join('、'));

const records = [];
for (const th of theaters) {
  for (let d = 0; d < DAYS; d++) {
    const date = todayISO(d);
    const dt = encodeURIComponent(date.replace(/-/g, '/'));
    let html;
    try {
      html = await politeFetch(`${BASE}/home/Showtime?ID=${th.id}&DT=${dt}`);
    } catch (e) {
      console.log(`  ${th.name} ${date}: ${e.message}`);
      continue;
    }
    // 每部片一個 showtime-item 區塊
    for (const item of html.split(/<div class='showtime-item'>/).slice(1)) {
      const t = item.match(/<h3><a [^>]*>([^<]+)<span class='eng'>([^<]*)<\/span>/);
      if (!t) continue;
      const rating = (item.match(/tag_s@2x\.png'[^>]*>([^<]*級[^<]*)</) || [])[1]?.trim() || null;
      // 版本區塊：<p class='tag-seat'>(數位‧英文版)片名</p> 之後接場次 <ul>
      const parts = item.split(/<p class='tag-seat'>/).slice(1);
      for (const part of parts) {
        const ver = (part.match(/^\(([^)]*)\)/) || [])[1] || null;
        for (const s of part.matchAll(/<h6>\s*([0-9]{1,2}:[0-9]{2})\s*<\/h6><p><span class='float-left info'>([^<]*)</g)) {
          records.push({
            source: 'ambassador',
            cinema: th.name,
            area: th.area,
            movie: normTitle(t[1].trim()),
            movieEn: t[2].trim() || null,
            rating,
            date,
            time: s[1].padStart(5, '0'),
            hall: s[2].trim() || null,
            tags: ver ? [ver] : [],
            url: `${BASE}/home/Showtime?ID=${th.id}&DT=${dt}`,
          });
        }
      }
    }
  }
  console.log(`  ${th.name}: 累計 ${records.length}`);
}

await saveRecords(new URL('../data/ambassador.json', import.meta.url).pathname, records);
