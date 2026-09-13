import { normTitle, todayISO, matchKey } from './common.mjs';
import { canonicalRecord } from './movie-identity.mjs';

export const htmlText = value => String(value || '').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/\s+/g, ' ').trim();

export function validDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(Date.parse(date + 'T00:00:00Z'))
    && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
}

// 喜樂時代舊售票系統的 ProgramID 僅限分館；介紹頁核對 ID 與片名後才採用片長。
export function parseCenturyMovieEvidence(html, { id, movie }) {
  const action = htmlText(html.match(/<form\b[^>]*action="([^"]+)"/i)?.[1]);
  const url = new URL(action || '/', 'https://ticket.centuryasia.com.tw');
  const title = normTitle(htmlText(html.match(/<div\s+class="movie_news_fc">([\s\S]*?)<\/div>/i)?.[1]));
  const runtime = Number(htmlText(html).match(/片長[：:]\s*(\d+)\s*分/)?.[1]);
  if (url.searchParams.get('ProgramID') !== id || !title || matchKey(title) !== matchKey(movie) || !runtime) {
    throw new Error('喜樂時代電影介紹的 ID、片名或片長未通過核對');
  }
  return runtime;
}

export function parseAtmovies(html, { code, region, name, area, official, expectedDate = todayISO() }) {
  const dateMatch = html.match(/<h[234][^>]*>\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*\(/i);
  const date = dateMatch && [dateMatch[1], dateMatch[2].padStart(2, '0'), dateMatch[3].padStart(2, '0')].join('-');
  if (!validDate(date) || date !== expectedDate) throw new Error(`場次日期不符：預期 ${expectedDate}，頁面 ${date || '缺少日期'}`);
  const dates = new Set([date]);
  const linkRe = /href=["']\/showtime\/(t\w+)\/(a\w+)\/(\d{4})(\d{2})(\d{2})\/["']/gi;
  for (const m of html.matchAll(linkRe)) {
    const d = `${m[3]}-${m[4]}-${m[5]}`;
    if (m[1] === code && m[2] === region && validDate(d) && d >= date && Date.parse(d) - Date.parse(date) <= 14 * 86400000) dates.add(d);
  }
  const records = [];
  const CERT = { G: '普遍級', P: '保護級', F2: '輔12級', F5: '輔15級', R: '限制級' };
  const blocks = html.split(/<ul\s+id=["']theaterShowtimeTable["']\s*>/i).slice(1);
  let broken = 0;
  for (const rawBlock of blocks) {
    const block = rawBlock.split('<!-- theaterShowtimeBlock')[0];
    const title = block.match(/<li\s+class=["']filmTitle["']>\s*(?:<img[^>]*>\s*)?<a\s+href=["']\/movie\/(\w+)\/["'][^>]*>([^<]*)/i);
    if (!title) { broken++; continue; }
    const rawMovie = normTitle(htmlText(title[2]));
    // 保留所有原始片名／作品年份，不把 (2024)、(真人版) 當裝飾刪掉。
    const tags = [...block.matchAll(/<li(?:\s[^>]*)?>\s*([^<]+?)\s*<\/li>/gi)]
      .map(m => htmlText(m[1])).filter(t => t && !/^\d{1,2}[：:]\d{2}$/.test(t)
        && !/片長|其他戲院|更新時間/.test(t));
    const timeMatches = [...block.matchAll(/<li(?:\s[^>]*)?>\s*(\d{1,2})[：:](\d{2})\s*<\/li>/gi)];
    for (const t of timeMatches) {
      if (+t[1] > 23 || +t[2] > 59) { broken++; continue; }
      records.push(canonicalRecord({ source: 'atmovies', cinema: name, area, movie: rawMovie, rawMovie,
        sourceMovieId: title[1], sourceRuntimeMin: Number(block.match(/片長[：:]\s*(\d+)\s*分/)?.[1]) || null,
        sourceUrl: `https://www.atmovies.com.tw/showtime/${code}/${region}/${date.replace(/-/g, '')}/`,
        rating: CERT[block.match(/cer_(\w+)\.gif/)?.[1]] || null,
        date, time: `${t[1].padStart(2, '0')}:${t[2]}`, hall: null, tags: [...new Set(tags)],
        url: official || `https://www.atmovies.com.tw/showtime/${code}/${region}/` }));
    }
  }
  if (broken || (!records.length && !/無場次|暫無|尚未公布|尚無場次/.test(htmlText(html)))) {
    throw new Error(`場次解析不完整：${broken} 個異常區塊，${records.length} 筆`);
  }
  return { date, dates: [...dates].sort(), records };
}

export function parseSkcinemas(html, { id, name, area, today = todayISO() }) {
  const records = [];
  const movies = html.split(/<div\s+class="pt-5 pb-3">/i).slice(1);
  for (const movieBlock of movies) {
    const rawMovie = normTitle(htmlText(movieBlock.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1]));
    if (!rawMovie) continue;
    const rating = { 0: '普遍級', 6: '保護級', 12: '輔12級', 15: '輔15級', 18: '限制級' }[movieBlock.match(/age_(\d+)\.png/)?.[1]] || null;
    const days = [...movieBlock.matchAll(/<h5[^>]*>\s*<strong>\s*(\d{2})-(\d{2})[^<]*<\/strong>\s*<\/h5>/gi)];
    for (let i = 0; i < days.length; i++) {
      const day = days[i], block = movieBlock.slice(day.index, days[i + 1]?.index ?? movieBlock.length);
      const year = Number(today.slice(0, 4));
      const dates = [year - 1, year, year + 1].map(y => `${y}-${day[1]}-${day[2]}`)
        .filter(d => validDate(d) && d >= today && Date.parse(d) - Date.parse(today) <= 90 * 86400000);
      if (dates.length !== 1) continue;
      const tag = htmlText(block.match(/<span\s+class="badge[^\"]*">([\s\S]*?)<\/span>/i)?.[1]);
      for (const button of block.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
        const urlText = button[1].match(/data-action-url="([^"]+)"/)?.[1];
        const time = htmlText(button[2]);
        if (!urlText || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) continue;
        const url = new URL(htmlText(urlText), 'https://www.skcinemas.com');
        if (url.origin !== 'https://www.skcinemas.com' || url.searchParams.get('cinemaId') !== id) throw new Error('新光回傳錯誤館別');
        records.push(canonicalRecord({ source: 'skcinemas', cinema: name, area, movie: rawMovie, rawMovie,
          sourceMovieId: url.searchParams.get('filmId'), sourceSessionId: url.searchParams.get('sessionId'),
          sourceUrl: `https://www.skcinemas.com/Sessions/Sessions?cinemaId=${id}`,
          date: dates[0], time, rating, hall: null, tags: tag ? [tag] : [],
          // 公開查詢頁穩定可用，購票按鈕可能要求會員，不在抓取時呼叫它。
          url: `https://www.skcinemas.com/Sessions/Sessions?cinemaId=${id}` }));
      }
    }
  }
  if (!records.length) throw new Error('新光場次頁未取得可驗證的場次（不是正常無場次）');
  return records;
}
