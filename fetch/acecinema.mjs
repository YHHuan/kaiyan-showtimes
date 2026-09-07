// 王牌映画影城：官方「全部場次」是 server-rendered HTML，一頁含所有電影與未來日期。
import { politeFetch, saveRecords, normTitle } from '../lib/common.mjs';

const BASE = 'https://www.acecinema.com.tw';
const LIST_URL = `${BASE}/movie/all`;

const stripHtml = (value) => (value || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&ensp;|&emsp;|&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/\s+/g, ' ')
  .trim();

const ratingName = (value) => stripHtml(value)
  .replace('輔導十二歲級', '輔12級')
  .replace('輔導十五歲級', '輔15級');

function cleanTitle(raw) {
  let movie = stripHtml(raw);
  const tags = [];
  // 官網會把「數位 2D」「經典重映」「系列回顧」寫在片名前綴；移到場次標記，
  // 否則同一部片在跨影城搜尋時會被拆成不同電影。
  for (let i = 0; i < 4; i++) {
    const lead = movie.match(/^\(([^)]{1,24})\)\s*/);
    if (!lead) break;
    tags.push(lead[1].trim());
    movie = movie.slice(lead[0].length).trim();
  }
  return { movie: normTitle(movie), tags };
}

export function parseAceShowtimes(html) {
  const records = [];
  const markers = [...html.matchAll(/<div\s+class=["']col-xs-12 padding_0 movie_list["'][^>]*>/gi)];
  for (let i = 0; i < markers.length; i++) {
    const block = html.slice(markers[i].index, markers[i + 1]?.index ?? html.length);
    const id = block.match(/href=["']\/movie\/dtl\/(\d+)["']/i)?.[1];
    const rawTitle = stripHtml(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1]);
    if (!id || !rawTitle) continue;
    const { movie, tags } = cleanTitle(rawTitle);
    const movieEn = stripHtml(block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1]) || null;
    const info = stripHtml(block.match(/<p\s+class=["']txt_gray["']>([\s\S]*?)<\/p>/i)?.[1]);
    const rating = ratingName(info.split('｜')[1] || '') || null;
    const table = block.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1] || '';
    const url = `${BASE}/booking/res?id=${id}`;

    for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const dateM = row[1].match(/(\d{4})\/(\d{2})\/(\d{2})/);
      if (!dateM) continue;
      const date = `${dateM[1]}-${dateM[2]}-${dateM[3]}`;
      const td = row[1].match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)?.[1] || '';
      for (const timeM of td.matchAll(/\b([0-2]?\d:[0-5]\d)\b/g)) {
        records.push({
          source: 'acecinema',
          cinema: '王牌映画影城',
          area: '台中市',
          movie,
          movieEn,
          rating,
          date,
          time: timeM[1].padStart(5, '0'),
          hall: '一般影廳',
          tags,
          url,
        });
      }
    }
  }
  return records;
}

// 王牌官網從 GitHub runner 偶爾首回應較慢，給它較寬裕的逾時並保留共用重試。
const html = await politeFetch(LIST_URL, { timeoutMs: 60000 });
await saveRecords(new URL('../data/acecinema.json', import.meta.url).pathname, parseAceShowtimes(html));
