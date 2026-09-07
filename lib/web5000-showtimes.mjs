// 日日新與親親使用同一套 Web5000 影城頁面：場次已完整寫在 server-rendered HTML。
// 解析器獨立出來，讓兩個來源各自抓取／記錄健康度，網站模板改版時也只需修一處。
import { matchKey, normTitle } from './common.mjs';

const RATING = {
  0: '普遍級',
  6: '保護級',
  12: '輔12級',
  15: '輔15級',
  18: '限制級',
};

const stripHtml = (value) => (value || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/\s+/g, ' ')
  .trim();

const versionTag = (version, movie) => {
  const clean = stripHtml(version);
  if (!clean || matchKey(clean) === matchKey(movie)) return [];
  // 日日新的普通場常把片名再寫一次；只留下對選場真正有用的語言／格式標記。
  return /(?:\b[234]D\b|國語|台語|英語|日語|韓語|中文版|日文版|原音|配音|IMAX|ATMOS|VISION)/i.test(clean)
    ? [clean]
    : [];
};

export function parseWeb5000Showtimes(html, {
  source,
  cinema,
  baseUrl,
  scheduleUrl,
  halls,
}) {
  const records = [];
  const movieMarkers = [...html.matchAll(/<div\s+class=["']showtime-item["'][^>]*\bid=["']m_(\d+)["'][^>]*>/gi)];

  for (let i = 0; i < movieMarkers.length; i++) {
    const marker = movieMarkers[i];
    const block = html.slice(marker.index, movieMarkers[i + 1]?.index ?? html.length);
    const titleM = block.match(/<div\s+class=["']m_title["']>([\s\S]*?)(?:<span\s+class=["']eng["']>([\s\S]*?)<\/span>)?<\/div>/i);
    const movie = normTitle(stripHtml(titleM?.[1]));
    const movieEn = stripHtml(titleM?.[2]) || null;
    if (!movie) continue;

    const ratingCode = block.match(/\/images\/regrading\/(\d+)\.gif/i)?.[1];
    const rating = RATING[ratingCode] || null;
    const detailM = block.match(/href=["']([^"']*product\.php\?_path=product_detail[^"']*)["']/i);
    const url = detailM ? new URL(detailM[1].replace(/&amp;/g, '&'), baseUrl).href : scheduleUrl;
    const dateMarkers = [...block.matchAll(/<span\s+class=["']dateDisplay["']>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/gi)];

    for (let d = 0; d < dateMarkers.length; d++) {
      const date = dateMarkers[d][1];
      const dateBlock = block.slice(dateMarkers[d].index, dateMarkers[d + 1]?.index ?? block.length);
      const versionMarkers = [...dateBlock.matchAll(/<div\s+class=["']dateMovie["'][^>]*>/gi)];

      for (let v = 0; v < versionMarkers.length; v++) {
        const versionBlock = dateBlock.slice(versionMarkers[v].index, versionMarkers[v + 1]?.index ?? dateBlock.length);
        const version = stripHtml(versionBlock.match(/<b[^>]*>([\s\S]*?)<\/b>/i)?.[1]);
        const tags = versionTag(version, movie);

        for (const li of versionBlock.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
          const time = li[1].match(/class=["']float-left info["'][^>]*>\s*([0-2]?\d:[0-5]\d)\s*</i)?.[1];
          if (!time) continue;
          const hallCode = li[1].match(/cinema_pic\/([a-z0-9_-]+)\.png/i)?.[1]?.toLowerCase();
          records.push({
            source,
            cinema,
            area: '台中市',
            movie,
            movieEn,
            rating,
            date,
            time: time.padStart(5, '0'),
            hall: halls[hallCode] || null,
            tags,
            url,
          });
        }
      }
    }
  }

  return records;
}
