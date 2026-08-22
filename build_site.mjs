// 讀 data/*.json → 合併去重 → 壓成查表結構 → 內嵌海報 → 套 site_template.html → out/index.html
//
// 為什麼要壓：一萬多筆場次直接塞 JSON 會讓頁面破 4MB。改成「字典 + 索引列」後約剩三成。
// 為什麼海報要內嵌 data URI：發佈出去的是單一 HTML 檔，相對路徑的圖片檔不會跟著走。
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { matchKey, foldTitle } from './lib/common.mjs';

const root = new URL('.', import.meta.url).pathname;
const SOURCE_NAMES = {
  showtimes: '秀泰',
  ambassador: '國賓',
  centuryasia: '喜樂時代',
  skcinemas: '新光',
  miranew: '美麗新',
  in89: 'in89',
  atmovies: '開眼(藝文館)',
  arthouse: '光點華山/府中15',
  lux: '樂聲',
};

// ── 讀取場次 ────────────────────────────────────────────────
// 排程跑起來後，某家抓失敗時我們會沿用上一輪的檔案。這裡靠 _status.json 的時間戳
// 把太舊的整個剔掉——寧可少一家，也不要拿三天前的場次騙人。
const FRESH_HOURS = 72;
let status = {};
try {
  status = JSON.parse(await readFile(`${root}data/_status.json`, 'utf8'));
} catch {}

const all = [];
const staleSources = [];
const freshness = {};
for (const f of (await readdir(`${root}data`)).filter((f) => f.endsWith('.json') && !f.startsWith('_') && f !== 'movie_meta.json')) {
  const source = f.replace(/\.json$/, '');
  const st = status[source];
  const ageH = st ? (Date.now() - Date.parse(st.fetchedAt)) / 3600000 : null;
  if (ageH != null && ageH > FRESH_HOURS) {
    staleSources.push(`${source}(${ageH.toFixed(0)}h)`);
    console.log(`  ${f}: 略過——已 ${ageH.toFixed(0)} 小時未更新`);
    continue;
  }
  const rows = JSON.parse(await readFile(`${root}data/${f}`, 'utf8'));
  // data/ 底下不是每個 json 都是場次陣列（prices/cinemas/movie_meta 是查表用的物件），
  // 用型別判斷比維護排除清單穩固——之後新增查表檔也不會再炸掉建置。
  if (!Array.isArray(rows)) continue;
  all.push(...rows);
  if (ageH != null) freshness[source] = ageH;
  console.log(`  ${f}: ${rows.length}${ageH != null && ageH > 26 ? `（${ageH.toFixed(0)}h 前，本輪未更新）` : ''}`);
}

// 今天（台北時區）之前的場次直接丟掉——府中15 之類會公布整月表，含已過去的日期
const todayTPE = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

const seen = new Set();
const merged = all.filter((r) => {
  if (!r.date || !r.time || !r.movie) return false;
  if (r.date < todayTPE) return false;
  const k = `${r.cinema}|${r.movie}|${r.date}|${r.time}|${r.hall || ''}|${(r.tags || []).join()}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// ── 電影 metadata（海報縮圖轉 data URI）──────────────────────
let meta = {};
try {
  meta = JSON.parse(await readFile(`${root}data/movie_meta.json`, 'utf8'));
} catch {
  console.log('  (無 movie_meta.json，跳過海報與簡介)');
}

// 海報要內嵌進單一 HTML。逐張存 data URI 太肥（66 張 WebP ≈ 368KB），
// 改成用 ffmpeg 把全部海報拼成一張 sprite，前端用 background-position 取用——
// 同樣的圖只剩幾十 KB，因為相鄰畫格能一起壓。
// 畫格就是實際顯示尺寸（62×93）——整份頁面要塞進單一 HTML 的體積上限，
// 這裡每多一點解析度都要用 KB 去換，62px 已足夠一般螢幕。
const CELL_W = 62;
const CELL_H = 93;
const SPRITE_COLS = 10;
const SPRITE_QUALITY = '15';

async function buildSprite(relPaths) {
  if (!relPaths.length) return null;
  const cache = `${root}.cache`;
  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  let n = 0;
  const ok = [];
  for (const rel of relPaths) {
    const dst = `${cache}/${String(n).padStart(3, '0')}.png`;
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${root}${rel}`,
        '-vf', `scale=${CELL_W}:${CELL_H}:force_original_aspect_ratio=increase,crop=${CELL_W}:${CELL_H}`,
        dst], { stdio: 'ignore' });
      ok.push(rel);
      n++;
    } catch {}
  }
  if (!n) return null;
  const rows = Math.ceil(n / SPRITE_COLS);
  const sprite = `${cache}/sprite.webp`;
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-start_number', '0', '-i', `${cache}/%03d.png`,
      '-filter_complex', `tile=${SPRITE_COLS}x${rows}:padding=0`,
      '-c:v', 'libwebp', '-quality', SPRITE_QUALITY, '-frames:v', '1', sprite], { stdio: 'ignore' });
  } catch (e) {
    console.log('  (sprite 產生失敗，海報略過)', e.message);
    return null;
  }
  const buf = await readFile(sprite);
  return { uri: `data:image/webp;base64,${buf.toString('base64')}`, index: new Map(ok.map((r, i) => [r, i])), rows, bytes: buf.length };
}

// ── 壓成查表結構 ────────────────────────────────────────────
const intern = () => {
  const list = [];
  const idx = new Map();
  return {
    list,
    id(v) {
      const k = JSON.stringify(v ?? null);
      if (idx.has(k)) return idx.get(k);
      const i = list.length;
      list.push(v ?? null);
      idx.set(k, i);
      return i;
    },
  };
};

const cinemas = intern();
const movies = intern();
const halls = intern();
const tags = intern();
const urls = intern();
const dates = intern();

// 特別場歸戶：「蜘蛛人：重生日 經典美漫場」併回「蜘蛛人：重生日」，場次名稱降級成標記。
// 只在「本片確實也單獨存在」時才併，避免把真的叫「…場」的片名切壞。
const allKeys = new Set(merged.map((r) => matchKey(r.movie)));
const hasBase = (t) => allKeys.has(matchKey(t));
const foldCache = new Map();
let eventFolded = 0;
for (const r of merged) {
  if (!foldCache.has(r.movie)) foldCache.set(r.movie, foldTitle(r.movie, hasBase));
  const sp = foldCache.get(r.movie);
  if (!sp) continue;
  r.tags = [...sp.marks, ...(r.tags || [])];
  r.movie = sp.base;
  eventFolded++;
}

// 同片歸戶：各家片名寫法不同（「愛重奏」/「愛重奏.」/「愛重奏(2026重映)」）用 matchKey 合併，
// 顯示名取「出現最多次」的那個寫法，同票數時取最短的（通常最乾淨）。
const variants = new Map();
for (const r of merged) {
  const k = matchKey(r.movie);
  let v = variants.get(k);
  if (!v) { v = { titles: new Map(), en: null, rating: null }; variants.set(k, v); }
  v.titles.set(r.movie, (v.titles.get(r.movie) || 0) + 1);
  if (!v.en && r.movieEn) v.en = r.movieEn;
  if (!v.rating && r.rating) v.rating = r.rating;
}

// 來源截斷的片名：「電影蠟筆小新：奇奇怪怪！我的妖怪」其實是「…我的妖怪假期」被切掉尾巴。
// 只在「夠長的前綴 + 只差幾個字」時才併，避免把系列作（例：續集）誤併。
const keysByLen = [...variants.keys()].sort((a, b) => a.length - b.length);
let truncFolded = 0;
for (const short of keysByLen) {
  if (!variants.has(short) || short.length < 8) continue;
  const full = keysByLen.find(
    (k) => k !== short && k.length > short.length && k.length - short.length <= 3 && k.startsWith(short) && variants.has(k),
  );
  if (!full) continue;
  const from = variants.get(short);
  const to = variants.get(full);
  // 截斷版的片名登記進來（讓場次對得上），但票數給 0——顯示名要用完整的那個
  for (const t of from.titles.keys()) if (!to.titles.has(t)) to.titles.set(t, 0);
  to.en = to.en || from.en;
  to.rating = to.rating || from.rating;
  variants.delete(short);
  truncFolded++;
}

const movieInfo = new Map(); // 原始片名 → 統一後的顯示資訊
for (const [, v] of variants) {
  const title = [...v.titles.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0]
    .replace(/[\s.．。・、,，_＿-]+$/, '') // 尾綴殘留標點（例：「驀然回首.」）
    .replace(/^(.{3,})\s+\1$/, '$1')      // 來源自帶的整段重複（府中15：「療癒心傷劇場版 療癒心傷劇場版」）
    .trim();
  const info = { title, en: v.en, rating: v.rating };
  for (const orig of v.titles.keys()) movieInfo.set(orig, info);
}
const mergedTitles = [...variants.values()].filter((v) => v.titles.size > 1).length;

// 日期先照時序 intern，日期列才會由近到遠排好
[...new Set(merged.map((r) => r.date))].sort().forEach((d) => dates.id(d));

// 場次編碼：整份要內嵌成單一 HTML，JSON 陣列的引號逗號括號本身就佔掉一半體積。
// 改成「同戲院同片同日同廳同標籤」壓成一組，時間存分鐘數、全部用 36 進位字串接起來：
//   組間 ';'　組內欄位 ','　同組多個時間 '.'
// 13,767 筆從 458KB 降到約 100KB。
// 訂票連結改成「每家戲院一個樣板」，不再逐場次存一個索引——這是 packed 裡最貴的欄位之一。
// 國賓的網址帶查詢日期，換成 {d} 佔位符，前端再把使用者選的日期填回去。
const urlVotes = new Map();
for (const r of merged) {
  const ci = cinemas.id([r.cinema, r.area || '']);
  // {d}=2026-08-21 形式、{s}=2026/08/21 形式（各站寫法不同，佔位符自己帶格式）
  const tpl = (r.url || '')
    .replace(r.date, '{d}')
    .replace(r.date.replace(/-/g, '/'), '{s}')
    .replace(encodeURIComponent(r.date.replace(/-/g, '/')), '{s}');
  if (!urlVotes.has(ci)) urlVotes.set(ci, new Map());
  const m = urlVotes.get(ci);
  m.set(tpl, (m.get(tpl) || 0) + 1);
}
const cinemaUrl = [];
for (const [ci, m] of urlVotes) {
  cinemaUrl[ci] = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const groups = new Map();
for (const r of merged) {
  const mi = movieInfo.get(r.movie);
  const key = [
    cinemas.id([r.cinema, r.area || '']),
    movies.id([mi.title, mi.en, mi.rating]),
    dates.id(r.date),
    halls.id(r.hall),
    tags.id((r.tags || []).filter(Boolean).join('・') || null),
  ];
  const k = key.join(',');
  if (!groups.has(k)) groups.set(k, { key, times: [] });
  groups.get(k).times.push(Number(r.time.slice(0, 2)) * 60 + Number(r.time.slice(3, 5)));
}

const b36 = (n) => n.toString(36);
const packed = [...groups.values()]
  .map((g) => g.key.map(b36).join(',') + ',' + [...new Set(g.times)].sort((a, b) => a - b).map(b36).join('.'))
  .join(';');
const rows = merged; // 只用來計數

// ── 票價（data/prices.json）──────────────────────────────
// 只取「全票」的最低價當作比較基準，標示成「起」。各家把票價按影廳規格分級，
// 而場次的規格標籤（「數位 英語」）跟票價表的規格名（「2D數位電影」）對不起來，
// 硬對會給出錯的數字；顯示最低全票價＋連到官方票價頁是誠實又有用的折衷。
let prices = {};
try {
  prices = JSON.parse(await readFile(`${root}data/prices.json`, 'utf8'));
} catch {}

const priceByCinema = {};
for (const [cinema, info] of Object.entries(prices)) {
  const full = (info.tiers || [])
    .map((t) => t.prices?.['全票'])
    .filter((n) => typeof n === 'number');
  if (!full.length) continue;
  priceByCinema[cinema] = {
    from: Math.min(...full),
    url: info.url || null,
    manual: /人工讀圖/.test(info.source || ''), // 這幾家的票價表是圖片，數字靠人工轉譯、不會自動更新
  };
}

// ── 影城地點（data/cinemas.json）──────────────────────────
// 只帶座標與交通指引到前端；距離在瀏覽器端算（使用者的位置不該離開他的裝置）。
let geo = {};
try {
  geo = JSON.parse(await readFile(`${root}data/cinemas.json`, 'utf8'));
} catch {}

// 電影 metadata 對齊 movies 索引（meta 的鍵是各來源原始片名，一樣用 matchKey 對上）
const metaByKey = new Map();
for (const [k, v] of Object.entries(meta)) {
  const mk = matchKey(k);
  if (!metaByKey.has(mk) || (v.synopsis && !metaByKey.get(mk).synopsis)) metaByKey.set(mk, v);
}

// 先決定哪些片有海報（決定 sprite 的排列順序），再拼 sprite
const posterPaths = [];
for (let i = 0; i < movies.list.length; i++) {
  const m = metaByKey.get(matchKey(movies.list[i][0]));
  if (m?.thumb && !posterPaths.includes(m.thumb)) posterPaths.push(m.thumb);
}
const sprite = await buildSprite(posterPaths);

const metaByIdx = {};
for (let i = 0; i < movies.list.length; i++) {
  const m = metaByKey.get(matchKey(movies.list[i][0]));
  if (!m) continue;
  const entry = {};
  // 卡片上只顯示兩行，截短可觀地縮小內嵌體積
  if (m.synopsis) entry.s = m.synopsis.length > 88 ? m.synopsis.slice(0, 88) + '…' : m.synopsis;
  if (m.runtimeMin) entry.d = m.runtimeMin;
  const pi = sprite?.index.get(m.thumb);
  if (pi != null) entry.i = pi;
  if (Object.keys(entry).length) metaByIdx[i] = entry;
}

const cinemaPrice = cinemas.list.map((c) => {
  const p = priceByCinema[c[0]];
  return p ? [p.from, p.url, p.manual ? 1 : 0] : null;
});

// 對齊 cinemas 索引：[緯度, 經度, 交通指引]；查不到座標的給 null
const cinemaGeo = cinemas.list.map((c) => {
  const g = geo[c[0]];
  if (!g || typeof g.lat !== 'number' || typeof g.lng !== 'number') return null;
  // 第四個值：座標是否只精確到路名（geocode 退而求其次的結果）。
  // 用來決定前端要不要顯示到百公尺——排序沒問題，但別假裝知道確切門牌。
  const rough = g.geoPrecision === 'road' ? 1 : 0;
  return [Number(g.lat.toFixed(5)), Number(g.lng.toFixed(5)), g.transit || null, rough];
});

const payload = {
  cinemas: cinemas.list,
  prices: cinemaPrice,
  geo: cinemaGeo,
  movies: movies.list,
  halls: halls.list,
  tags: tags.list,
  urls: cinemaUrl,
  dates: dates.list,
  packed,
  meta: metaByIdx,
  sprite: sprite ? { uri: sprite.uri, cols: SPRITE_COLS, rows: sprite.rows } : null,
};

const withGeo = cinemaGeo.filter(Boolean).length;
const withPoster = Object.values(metaByIdx).filter((m) => m.i != null).length;
const withSyn = Object.values(metaByIdx).filter((m) => m.s).length;
const sources = [...new Set(merged.map((r) => r.source))].map((s) => SOURCE_NAMES[s] || s).join('、');
const generated = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

// 頁面上要能看出哪幾家是這輪抓的、哪幾家沿用舊資料、哪幾家整個缺席——
// 場次資料的價值全靠使用者相信它，所以寧可把不確定攤開講。
const lagging = Object.entries(freshness)
  .filter(([, h]) => h > 26)
  .map(([s, h]) => `${SOURCE_NAMES[s] || s}（${h.toFixed(0)} 小時前）`);

// 整個沒抓到的來源也要講。先前只報「有資料但過舊」，
// 結果新光與 in89 整個消失時網站一聲不吭，使用者看到的是「這幾家今天沒場次」。
const present = new Set(merged.map((r) => r.source));

// 有些來源抓不到時會由開眼補上（見 fetch/atmovies.mjs）。這種情況要說「改用備援、只有今天」，
// 不能說「查不到」——新光的場次明明在站上，講成查不到反而是誤導。
const FALLBACK = { skcinemas: /新光/ };
const cinemaNames = new Set(merged.map((r) => r.cinema));
const coveredByBackup = (src) =>
  FALLBACK[src] && [...cinemaNames].some((n) => FALLBACK[src].test(n));

const missing = Object.keys(SOURCE_NAMES).filter((s) => !present.has(s));
const absent = missing.filter((s) => !coveredByBackup(s)).map((s) => SOURCE_NAMES[s]);
const viaBackup = missing.filter(coveredByBackup).map((s) => SOURCE_NAMES[s]);

const notice =
  (absent.length ? `本輪未取得：${absent.join('、')}，這幾家的場次暫時查不到。` : '') +
  (viaBackup.length ? `${viaBackup.join('、')}官方來源今日取得失敗，改用開眼的資料，因此只有當天場次。` : '') +
  (lagging.length ? `沿用前一輪資料：${lagging.join('、')}。` : '') +
  (staleSources.length ? `已停用過期來源：${staleSources.join('、')}。` : '');

const tpl = await readFile(`${root}site_template.html`, 'utf8');
const html = tpl
  .replace('__DATA__', () => JSON.stringify(payload))
  .replace(/__SOURCES__/g, sources)
  .replace(/__GENERATED__/g, generated)
  .replace(/__NOTICE__/g, notice)
  .replace(/__NCINEMA__/g, String(cinemas.list.length))
  .replace(/__NMOVIE__/g, String(movies.list.length))
  .replace(/__NSESSION__/g, rows.length.toLocaleString('en-US'));

await mkdir(`${root}out`, { recursive: true }); // 乾淨 checkout 下 out/ 不存在（已 gitignore）
await writeFile(`${root}out/index.html`, html);
console.log(
  `\nout/index.html: ${rows.length} 場次 / ${cinemas.list.length} 影城 / ${movies.list.length} 部片` +
    `（${mergedTitles} 部跨影城異名合併、${eventFolded} 個特別場歸戶、海報 ${withPoster}、簡介 ${withSyn}、座標 ${withGeo}）` +
    `, ${(html.length / 1024 / 1024).toFixed(2)} MB`,
);
