// 電影 metadata 管線：從各來源的官方端點蒐集海報／簡介／分級／片長，
// 依 data/*.json（動態掃描，排除 movie_meta.json 本身）出現的片名建立對照表，並下載海報縮圖。
//
// 來源優先順序（越前面覆蓋 metaSource 的欄位優先權越高，缺欄位再由後面補）：
//   1. 秀泰 bootstrap：capi.showtimes.com.tw/4/app/bootstrap
//      單一請求（~1.6MB JSON）就拿到 77 部片的完整簡介/海報(coverImagePortrait.url)/分級/片長(秒)。
//   2. 喜樂時代：Movie/GetMovieBooking（片單+海報）→ Movie/GetMovieInfo/<programid>（簡介/片長）
//   3. 國賓：    home/Showtime?ID=<館>&DT=<日期>（片名/海報/分級/片長/MID）→ home/MovieContent?MID=<GUID>（簡介）
//   4. 樂聲：    2020.php?type=ShowTimes（片單頁海報）→ 2020-movie_item.php?film_id=<id>（簡介/分級/片長）
//   5. 美麗新：  首頁抓 NowShowing 的 MovieId 清單 → 逐一 Movie/Detail?type=NowShowing&MovieId=<GUID>
//               （注意：這支只回「該部片」的資料，不是全片單，要逐一請求；頁內嵌 JSON 的跳脫格式
//                跟 miranew.mjs 的 CinemaList 不同，見下方 unescapeEmbeddedJson 註解）
//   6. 開眼電影網（atmovies）：上面 5 個來源都查無時的最後防線，尤其是藝文/影展小眾片
//      （秀泰、連鎖院線都不會有）。用官方搜尋表單 POST search.atmovies.com.tw/search/
//      （必須帶 Referer，否則永遠 "No Result"）拿到片碼，再抓 /movie/<code>/ detail 頁面。
//      逐一片名查、無法批次，且沒有台灣分級文字，分級改用 data/*.json 本身既有的 rating 欄位補。
//
// 跨來源同片名常有裝飾性差異（版本前綴、特映場標籤、全形/半形標點等），故另建一個「寬鬆比對鍵」
// （looseKey）只用於「這是不是同一部片」的判斷；查無精確比對鍵時，再退一步用「互相包含」比對。
// 輸出的 JSON 鍵仍是 data/*.json 原始的片名字串（未再次正規化）。

import { readFile, writeFile, mkdir, rm, unlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { politeFetch, normTitle, todayISO } from '../lib/common.mjs';

const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FFMPEG = `${process.env.HOME}/.local/bin/ffmpeg`;
const ROOT = new URL('..', import.meta.url);
const POSTER_DIR = new URL('assets/posters/', ROOT);
const SCRATCH_DIR = '/tmp/claude-1000/-home-salmonyhh-repos-kinglite/77598456-46b7-48ad-b460-4535f4266353/scratchpad';
const REQUEST_DELAY_MS = 250;
const SYNOPSIS_MAX = 120;

// ---------- 小工具 ----------

function truncateSynopsis(s) {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length <= SYNOPSIS_MAX ? t : `${t.slice(0, SYNOPSIS_MAX)}…`;
}

function parseRuntimeHM(s) {
  // "1時39分" / "45分" -> 分鐘數
  const m = (s || '').match(/(?:(\d+)\s*時)?\s*(\d+)\s*分/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 60 + parseInt(m[2], 10);
}

// 去掉開頭/結尾的裝飾性括號註記（版本、特映場、重映標示等）跟英文廳別標籤前綴，
// 只用於「這是不是同一部片」的寬鬆比對，不影響輸出的片名鍵。
function stripAnnotations(t) {
  let s = (t || '').trim();
  for (let i = 0; i < 4; i++) {
    const s2 = s
      .replace(/^[（(【\[「『《〈][^（）()【】[\]「」『』《》〈〉]{1,12}[）)】\]」』》〉]\s*/, '')
      .replace(/\s*[（(【\[「『《〈][^（）()【】[\]「」『』《》〈〉]{1,16}[）)】\]」』》〉]$/, '');
    if (s2 === s) break;
    s = s2.trim();
  }
  // "DolbyCinema 藍色監獄" / "DolbyVisionAtmos 藍色監獄" 這種英文服務標籤 + 空白 + 中文片名
  s = s.replace(/^[A-Za-z][A-Za-z0-9]{2,}\s+(?=[一-鿿])/, '');
  return s.trim();
}

function looseKey(t) {
  return stripAnnotations(t)
    .normalize('NFKC')
    .replace(/[·．‧・,，、。.！!？?'’"“”\s:：\-—]/g, '')
    .toLowerCase();
}

function cleanEn(s) {
  const t = normTitle(s || '');
  return t || null;
}

// ---------- 通用禮貌 fetch（支援 POST，給 atmovies 搜尋用；politeFetch 只支援 GET） ----------

let lastCustomFetch = 0;
async function politeCustom(url, opts = {}) {
  const wait = lastCustomFetch + REQUEST_DELAY_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCustomFetch = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
        body: opts.body,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === 1) throw new Error(`fetch failed ${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// ---------- 來源 1：秀泰 bootstrap（優先度最高） ----------

const SHOWTIMES_RATING_MAP = { g: '普遍級', p: '保護級', pg12: '輔12級', pg15: '輔15級', r: '限制級' };

async function fetchShowtimesBootstrap() {
  const out = [];
  let data;
  try {
    data = await politeFetch('https://capi.showtimes.com.tw/4/app/bootstrap', { asJson: true });
  } catch (e) {
    console.log(`  [showtimes] bootstrap 失敗: ${e.message}`);
    return out;
  }
  const programs = data?.payload?.programs || [];
  for (const p of programs) {
    out.push({
      source: 'showtimes',
      sourceTitle: p.name,
      en: cleanEn(p.nameAlternative),
      posterUrl: p.coverImagePortrait?.url || null,
      synopsis: p.description || null,
      rating: SHOWTIMES_RATING_MAP[(p.rating || '').toLowerCase()] || null,
      // duration 欄位實測是「秒」：橡樹街末日 6000/60=100min（喜樂時代自報 99min）、
      // 陰兒房 6360/60=106min（喜樂時代同為 106min）、奧德賽 10320/60=172min（喜樂時代同為 172min）
      runtimeMin: typeof p.duration === 'number' ? Math.round(p.duration / 60) : null,
    });
  }
  console.log(`  [showtimes] bootstrap ${out.length} 部片（含特映場/未上映）`);
  return out;
}

// ---------- 來源 2：喜樂時代 ----------

async function fetchCenturyAsia() {
  const out = [];
  let listing;
  try {
    listing = await politeFetch('https://www.centuryasia.com.tw/Movie/GetMovieBooking', { asJson: true });
  } catch (e) {
    console.log(`  [centuryasia] GetMovieBooking 失敗: ${e.message}`);
    return out;
  }
  const movies = listing?.Data || [];
  for (const m of movies) {
    let synopsis = null;
    let runtimeMin = null;
    try {
      const info = await politeFetch(`https://www.centuryasia.com.tw/Movie/GetMovieInfo/${m.programid}`, { asJson: true });
      const d = info?.Data;
      if (d) {
        synopsis = d.Introduction || null;
        runtimeMin = d.ShowTimes ? parseInt(d.ShowTimes, 10) || null : null;
      }
    } catch (e) {
      console.log(`  [centuryasia] GetMovieInfo(${m.programid}) 失敗: ${e.message}`);
    }
    out.push({
      source: 'centuryasia',
      sourceTitle: m.cname,
      en: cleanEn(m.ename),
      posterUrl: m.img || null,
      synopsis,
      rating: m.filmleveldesc || null,
      runtimeMin,
    });
  }
  console.log(`  [centuryasia] ${out.length} 部片`);
  return out;
}

// ---------- 來源 3：國賓 ----------

async function fetchAmbassador() {
  const out = [];
  let rows;
  try {
    rows = JSON.parse(await readFile(new URL('../data/ambassador.json', import.meta.url), 'utf8'));
  } catch (e) {
    console.log(`  [ambassador] 讀不到 data/ambassador.json，略過: ${e.message}`);
    return out;
  }
  const theaterIds = [...new Set(rows.map((r) => (r.url.match(/ID=([a-f0-9-]{36})/) || [])[1]).filter(Boolean))];
  const date = todayISO(0);
  const dt = encodeURIComponent(date.replace(/-/g, '/'));

  const byMid = new Map();
  for (const id of theaterIds) {
    let html;
    try {
      html = await politeFetch(`https://www.ambassador.com.tw/home/Showtime?ID=${id}&DT=${dt}`);
    } catch (e) {
      console.log(`  [ambassador] Showtime(${id}) 失敗: ${e.message}`);
      continue;
    }
    for (const item of html.split(/<div class='showtime-item'>/).slice(1)) {
      const posterM = item.match(/<a href='\/home\/MovieContent\?MID=([a-f0-9-]{36})[^']*'><img src='([^']+)'/);
      const h3 = item.match(
        /<h3><a [^>]*>([^<]+)<span class='eng'>([^<]*)<\/span><\/a><p class='info'><span>[^<]*<img[^>]*>([^<]*)<\/span>\|<span>[^<]*<img[^>]*>([^<]*)<\/span>/
      );
      if (!posterM || !h3) continue;
      const mid = posterM[1];
      if (byMid.has(mid)) continue;
      byMid.set(mid, {
        mid,
        title: h3[1].trim(),
        en: cleanEn(h3[2]),
        posterUrl: posterM[2],
        rating: h3[3].trim().replace(/\s*\([A-Z0-9+-]+\)\s*$/, '') || null,
        runtimeMin: parseRuntimeHM(h3[4]),
      });
    }
  }
  console.log(`  [ambassador] ${theaterIds.length} 館 → ${byMid.size} 部不重複片`);

  for (const [mid, rec] of byMid) {
    let synopsis = null;
    try {
      const html = await politeFetch(`https://www.ambassador.com.tw/home/MovieContent?MID=${mid}&DT=${dt}`);
      const m = html.match(/<div class='rating-box'>[\s\S]*?<\/div><p>([\s\S]*?)<\/p>/);
      synopsis = m ? m[1].trim() : null;
    } catch (e) {
      console.log(`  [ambassador] MovieContent(${mid}) 失敗: ${e.message}`);
    }
    out.push({
      source: 'ambassador',
      sourceTitle: rec.title,
      en: rec.en,
      posterUrl: rec.posterUrl,
      synopsis,
      rating: rec.rating,
      runtimeMin: rec.runtimeMin,
    });
  }
  return out;
}

// ---------- 來源 4：樂聲 ----------

async function fetchLux() {
  const out = [];
  let listHtml;
  try {
    listHtml = await politeFetch('https://www.luxcinema.com.tw/web/2020.php?type=ShowTimes');
  } catch (e) {
    console.log(`  [lux] 片單頁失敗: ${e.message}`);
    return out;
  }
  const posterByFilm = new Map();
  const posterRe = /<a href="2020-movie_item\.php\?film_id=(\d+)">\s*<div class="movie_list_box">[\s\S]{0,400}?<img src="([^"]+)" alt="[^"]*">/g;
  let pm;
  while ((pm = posterRe.exec(listHtml))) {
    if (!posterByFilm.has(pm[1])) posterByFilm.set(pm[1], pm[2]);
  }
  const ids = [...new Set([...listHtml.matchAll(/2020-movie_item\.php\?film_id=(\d+)/g)].map((m) => m[1]))];
  console.log(`  [lux] 片單 ${ids.length} 部（海報 ${posterByFilm.size} 部）`);

  for (const id of ids) {
    let html;
    try {
      html = await politeFetch(`https://www.luxcinema.com.tw/web/2020-movie_item.php?film_id=${id}`);
    } catch (e) {
      console.log(`  [lux] item(${id}) 失敗: ${e.message}`);
      continue;
    }
    const title = (html.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1]?.trim();
    if (!title) continue;
    const h3s = [...html.matchAll(/<h3>\s*([\s\S]*?)\s*<\/h3>/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    const en = h3s[0] && !/^\d{4}\//.test(h3s[0]) && !/[\|｜]/.test(h3s[0]) ? cleanEn(h3s[0]) : null;
    const lengthLine = h3s.find((s) => /^長度\s*[|｜]/.test(s));
    const runtimeMin = lengthLine ? parseInt((lengthLine.match(/(\d+)\s*min/) || [])[1], 10) || null : null;
    const rating = (html.match(/級別\s*\|\s*([^<\s]+)/) || [])[1] || null;
    const synM = html.match(/<\/h3>\s*<p>([\s\S]*?)<\/p>/);
    const synopsis = synM ? synM[1].trim() : null;
    out.push({
      source: 'lux',
      sourceTitle: title,
      en,
      posterUrl: posterByFilm.get(id) || null,
      synopsis,
      rating,
      runtimeMin,
    });
  }
  return out;
}

// ---------- 來源 5：美麗新 ----------

// 注意：var MovieList = '...' 是「單層」JSON escape（" 跟 ' 各轉義一次，但既有的
// \r\n（片名/演員欄位常見的換行分隔）沒有再被跳脫），不能套用 miranew.mjs 對
// CinemaList 用的「JSON.parse 兩次」寫法——那樣會把 \r\n 提前解成真正的控制字元，
// 讓第二次 JSON.parse 因「JSON 字串裡出現未跳脫控制字元」而炸掉。這裡改成只還原
// \' 與 \" 兩種跳脫、其餘原樣保留，再單次 JSON.parse。
function unescapeEmbeddedJson(raw) {
  return raw.replace(/\\'/g, "'").replace(/\\"/g, '"');
}

async function fetchMiranew() {
  const out = [];
  let home;
  try {
    home = await politeFetch('https://www.miranewcinemas.com/');
  } catch (e) {
    console.log(`  [miranew] 首頁失敗: ${e.message}`);
    return out;
  }
  // Movie/Detail?MovieId=X 只回傳「該部片」的資料（不是全片單），所以要逐一請求
  const ids = [...new Set([...home.matchAll(/MovieId=([a-f0-9-]{36})/g)].map((m) => m[1]))];
  if (!ids.length) {
    console.log('  [miranew] 首頁找不到任何 MovieId，頁面結構可能改了');
    return out;
  }
  for (const id of ids) {
    let detail;
    try {
      detail = await politeFetch(`https://www.miranewcinemas.com/Movie/Detail?type=NowShowing&MovieId=${id}`);
    } catch (e) {
      console.log(`  [miranew] Movie/Detail(${id}) 失敗: ${e.message}`);
      continue;
    }
    const m = detail.match(/var MovieList = '([\s\S]*?)';/);
    if (!m) {
      console.log(`  [miranew] Movie/Detail(${id}) 找不到內嵌 MovieList JSON`);
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(unescapeEmbeddedJson(m[1]));
    } catch (e) {
      console.log(`  [miranew] Movie/Detail(${id}) JSON 解析失敗: ${e.message}`);
      continue;
    }
    const mv = payload?.Data?.MovieList?.[0];
    if (!mv) continue;
    const ratingFromTitle = (mv.MovieCName?.match(/\(([^)]+)\)\s*$/) || [])[1];
    out.push({
      source: 'miranew',
      sourceTitle: mv.MovieCName,
      en: cleanEn(mv.MovieEName),
      posterUrl: mv.PosterUrl ? `https://www.miranewcinemas.com/MiramarApp/Resource/${mv.PosterUrl}_origin.jpg` : null,
      synopsis: mv.Description || null,
      rating: ratingFromTitle || mv.Rate || null,
      runtimeMin: typeof mv.Duration === 'number' ? mv.Duration : parseInt(mv.Duration, 10) || null,
    });
  }
  console.log(`  [miranew] ${ids.length} 部片（首頁 NowShowing 清單）`);
  return out;
}

// ---------- 來源 6：開眼電影網（atmovies）——最後防線，逐片名查 ----------

// 開眼搜尋是舊版 ASP.NET 表單：POST 到 search.atmovies.com.tw/search/，且「一定要帶 Referer」，
// 沒有 Referer 一律回「No Result~~!」（即使查熱門強片也一樣，實測驗證過）。
async function atmoviesSearch(query) {
  let html;
  try {
    html = await politeCustom('https://search.atmovies.com.tw/search/', {
      method: 'POST',
      headers: {
        Referer: 'https://www.atmovies.com.tw/home/',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: new URLSearchParams({ fr: 'homepage', enc: 'UTF-8', type: 'all', search_term: query }).toString(),
    });
  } catch (e) {
    console.log(`  [atmovies] 搜尋失敗［${query}］: ${e.message}`);
    return null;
  }
  if (/No Result/i.test(html)) return null;
  const m = html.match(/<li class="movie">[\s\S]*?href="\/F\/([a-z0-9]+)\/"[\s\S]*?<p class="title-zh">([^<]*)<\/p>/i);
  return m ? { code: m[1], title: m[2].trim() } : null;
}

function extractAtmoviesSynopsis(html) {
  const startIdx = html.indexOf('劇情簡介');
  if (startIdx === -1) return null;
  const endMarker = html.indexOf('Story info end', startIdx);
  const seg = html.slice(startIdx, endMarker === -1 ? startIdx + 4000 : endMarker);
  const text = seg
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/劇情簡介/, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

async function atmoviesDetail(code) {
  const html = await politeCustom(`https://www.atmovies.com.tw/movie/${code}/`);
  const posterM = html.match(/class="image Poster"[\s\S]*?<img src="([^"]+)"/);
  const runtimeM = html.match(/片長[：:]\s*(\d+)\s*分/);
  return {
    posterUrl: posterM ? `https://www.atmovies.com.tw${posterM[1]}` : null,
    synopsis: extractAtmoviesSynopsis(html),
    runtimeMin: runtimeM ? parseInt(runtimeM[1], 10) : null,
  };
}

async function atmoviesLookup(rawTitle) {
  const query = stripAnnotations(rawTitle);
  if (!query) return null;
  const found = await atmoviesSearch(query);
  if (!found) return null;
  let detail;
  try {
    detail = await atmoviesDetail(found.code);
  } catch (e) {
    console.log(`  [atmovies] 詳情頁失敗［${rawTitle}］(${found.code}): ${e.message}`);
    return null;
  }
  if (!detail.posterUrl && !detail.synopsis) return null;
  return {
    en: null,
    posterUrl: detail.posterUrl,
    synopsis: detail.synopsis,
    rating: null, // 開眼詳情頁沒有台灣分級文字，靠 data/*.json 自帶的 rating 欄位補
    runtimeMin: detail.runtimeMin,
    metaSource: 'atmovies',
  };
}

// ---------- 合併 ----------

// 來源優先權：秀泰 bootstrap 簡介品質最好放最前面，其餘 4 個既有來源其次，
// 開眼(atmovies) 只在前 5 個都查無時才會被叫到，理論上不會跟其他來源同組競爭。
const SOURCE_PRIORITY = { showtimes: 6, centuryasia: 5, ambassador: 4, lux: 3, miranew: 2, atmovies: 1 };

function completeness(rec) {
  return ['posterUrl', 'synopsis', 'rating', 'runtimeMin', 'en'].filter((k) => rec[k]).length;
}

function mergeGroup(candidates) {
  const sorted = [...candidates].sort((a, b) => {
    const p = (SOURCE_PRIORITY[b.source] || 0) - (SOURCE_PRIORITY[a.source] || 0);
    return p !== 0 ? p : completeness(b) - completeness(a);
  });
  const base = sorted[0];
  const merged = { en: base.en, posterUrl: base.posterUrl, synopsis: base.synopsis, rating: base.rating, runtimeMin: base.runtimeMin };
  const sources = new Set([base.source]);
  for (const c of sorted.slice(1)) {
    let contributed = false;
    for (const k of ['en', 'posterUrl', 'synopsis', 'rating', 'runtimeMin']) {
      if (!merged[k] && c[k]) {
        merged[k] = c[k];
        contributed = true;
      }
    }
    if (contributed) sources.add(c.source);
  }
  merged.metaSource = [...sources].join('+');
  return merged;
}

// looseKey 精確比對查無時的最後一步：找一個「互相包含」且夠長的既有群組鍵
// （處理像「航海王映畫祭 航海王劇場版：機關城的鋼鐵巨兵」包住了乾淨片名的情況）
function resolveKey(lk, mergedByKey) {
  if (!lk) return null;
  if (mergedByKey.has(lk)) return lk;
  let best = null;
  for (const k of mergedByKey.keys()) {
    if (k.length < 4 || lk.length < 4) continue;
    if (lk.includes(k) || k.includes(lk)) {
      if (!best || k.length > best.length) best = k;
    }
  }
  return best;
}

// ---------- 海報縮圖 ----------

function extFromUrl(url) {
  const m = url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i);
  return m ? `.${m[1].toLowerCase()}` : '.jpg';
}

let lastImgFetch = 0;
async function politeImgFetch(url) {
  const wait = lastImgFetch + REQUEST_DELAY_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastImgFetch = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const thumbCache = new Map(); // posterUrl -> 縮圖後的 Buffer（跨片名相同海報時省下重複下載/轉檔）

async function makeThumb(title, posterUrl) {
  if (!posterUrl) return null;
  const slug = createHash('md5').update(title).digest('hex');
  const outUrl = new URL(`${slug}.jpg`, POSTER_DIR);
  const relPath = `assets/posters/${slug}.jpg`;

  let thumbBuf = thumbCache.get(posterUrl);
  if (thumbBuf === undefined) {
    let srcBuf;
    try {
      srcBuf = await politeImgFetch(posterUrl);
    } catch (e) {
      console.log(`  海報下載失敗［${title}］: ${e.message}`);
      thumbCache.set(posterUrl, null);
      return null;
    }
    const tmpInPath = `${SCRATCH_DIR}/movie_meta_src_${slug}${extFromUrl(posterUrl)}`;
    const tmpOutPath = `${SCRATCH_DIR}/movie_meta_thumb_${slug}.jpg`;
    await writeFile(tmpInPath, srcBuf);
    try {
      await execFileP(FFMPEG, ['-y', '-loglevel', 'error', '-i', tmpInPath, '-vf', 'scale=140:-1', '-q:v', '8', '-update', '1', tmpOutPath]);
      thumbBuf = await readFile(tmpOutPath);
    } catch (e) {
      console.log(`  縮圖轉檔失敗［${title}］: ${e.message}`);
      thumbBuf = null;
    } finally {
      await unlink(tmpInPath).catch(() => {});
      await unlink(tmpOutPath).catch(() => {});
    }
    thumbCache.set(posterUrl, thumbBuf);
  }
  if (!thumbBuf) return null;
  if (thumbBuf.length > 20 * 1024) {
    console.log(`  縮圖過大 (${thumbBuf.length}B)，捨棄［${title}］`);
    return null;
  }
  await writeFile(outUrl, thumbBuf);
  return relPath;
}

// ---------- 主流程 ----------

async function loadWantedTitles() {
  const dataDirUrl = new URL('../data/', import.meta.url);
  let files = [];
  try {
    files = (await readdir(dataDirUrl)).filter((f) => f.endsWith('.json') && f !== 'movie_meta.json');
  } catch (e) {
    console.log(`讀不到 data/ 目錄: ${e.message}`);
  }
  const titles = new Set();
  const ratingFallback = new Map(); // 片名 -> data/*.json 自帶的 rating（給查無分級的來源當保底）
  for (const f of files) {
    try {
      const rows = JSON.parse(await readFile(new URL(f, dataDirUrl), 'utf8'));
      for (const r of rows) {
        if (!r || !r.movie) continue;
        titles.add(r.movie);
        if (r.rating && !ratingFallback.has(r.movie)) ratingFallback.set(r.movie, r.rating);
      }
    } catch (e) {
      console.log(`讀不到 data/${f}，略過: ${e.message}`);
    }
  }
  console.log(`data/*.json 掃到 ${files.length} 個來源檔：${files.join('、')}`);
  return { titles, ratingFallback };
}

async function main() {
  await rm(POSTER_DIR, { recursive: true, force: true });
  await mkdir(POSTER_DIR, { recursive: true });

  const { titles: wantedTitles, ratingFallback } = await loadWantedTitles();
  console.log(`data/*.json 出現的片名（未去重前跨檔）：${wantedTitles.size} 個`);

  console.log('抓取各來源 metadata…');
  const candidates = [
    ...(await fetchShowtimesBootstrap()),
    ...(await fetchCenturyAsia()),
    ...(await fetchAmbassador()),
    ...(await fetchLux()),
    ...(await fetchMiranew()),
  ];
  console.log(`共 ${candidates.length} 筆來源候選資料（6 個來源中的前 5 個，皆為批次端點）`);

  const groups = new Map();
  for (const c of candidates) {
    const lk = looseKey(c.sourceTitle);
    if (!lk) continue;
    if (!groups.has(lk)) groups.set(lk, []);
    groups.get(lk).push(c);
  }
  const mergedByKey = new Map();
  for (const [lk, list] of groups) mergedByKey.set(lk, mergeGroup(list));
  console.log(`前 5 個來源合併後：${mergedByKey.size} 個不重複片名群組`);

  // 找出前 5 個來源（含互相包含的寬鬆比對）仍查無的片名，逐一查開眼補
  const missingLks = new Set();
  const repTitleOf = new Map(); // lk -> 一個代表性原始片名，當開眼搜尋關鍵字
  for (const title of wantedTitles) {
    const lk = looseKey(title);
    if (!lk) continue;
    if (!repTitleOf.has(lk)) repTitleOf.set(lk, title);
    if (!resolveKey(lk, mergedByKey)) missingLks.add(lk);
  }
  console.log(`前 5 個來源查無、需查開眼補的片名群組：${missingLks.size} 個`);

  console.log('查開眼電影網（atmovies）補齊缺欄位…');
  let atmoviesHit = 0;
  let atmoviesTried = 0;
  for (const lk of missingLks) {
    // 這個 lk 可能已經被前面某次 atmovies 命中、且跟它互相包含而間接補到了，先確認還缺不缺
    if (resolveKey(lk, mergedByKey)) continue;
    atmoviesTried++;
    const rep = repTitleOf.get(lk) || lk;
    let rec = null;
    try {
      rec = await atmoviesLookup(rep);
    } catch (e) {
      console.log(`  [atmovies] 查詢例外［${rep}］: ${e.message}`);
    }
    if (rec) {
      mergedByKey.set(lk, rec);
      atmoviesHit++;
    }
  }
  console.log(`  開眼查了 ${atmoviesTried} 個片名群組，補到 ${atmoviesHit} 個`);

  console.log('比對片名、下載海報縮圖…');
  const result = {};
  let withPoster = 0;
  let withSynopsis = 0;
  let withBoth = 0;
  let matched = 0;
  for (const title of wantedTitles) {
    const lk = looseKey(title);
    if (!lk) continue;
    const key = resolveKey(lk, mergedByKey);
    const rec = key ? mergedByKey.get(key) : null;
    if (!rec) continue;
    matched++;
    const synopsis = truncateSynopsis(rec.synopsis);
    const thumb = await makeThumb(title, rec.posterUrl);
    const rating = rec.rating || ratingFallback.get(title) || null;
    const entry = {
      title,
      en: rec.en || null,
      posterUrl: rec.posterUrl || null,
      synopsis,
      rating,
      runtimeMin: rec.runtimeMin || null,
      metaSource: rec.metaSource,
    };
    if (thumb) entry.thumb = thumb;
    result[title] = entry;
    if (rec.posterUrl) withPoster++;
    if (synopsis) withSynopsis++;
    if (rec.posterUrl && synopsis) withBoth++;
  }

  const outPath = new URL('../data/movie_meta.json', import.meta.url);
  await writeFile(outPath, JSON.stringify(result, null, 1));

  console.log('---');
  console.log(`data/*.json 片名總數：${wantedTitles.size}`);
  console.log(`成功比對到 metadata：${matched}`);
  console.log(`有海報 URL：${withPoster}　有簡介：${withSynopsis}　海報+簡介皆有：${withBoth}`);
  console.log(`完全查無 metadata：${wantedTitles.size - matched}`);
  console.log(`已寫入 ${outPath.pathname}`);
}

await main();
