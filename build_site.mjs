// 讀 data/*.json → 合併去重 → 壓成查表結構 → 內嵌海報 → 套 site_template.html → out/index.html
//
// 為什麼要壓：一萬多筆場次直接塞 JSON 會讓頁面破 4MB。改成「字典 + 索引列」後約剩三成。
// 為什麼海報要內嵌 data URI：發佈出去的是單一 HTML 檔，相對路徑的圖片檔不會跟著走。
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { matchKey, foldTitle } from './lib/common.mjs';

const root = new URL('.', import.meta.url).pathname;
const SITE_URL = (process.env.SITE_URL || 'https://yhhuan.github.io/kaiyan-showtimes').replace(/\/$/, '');

// 所有外部網址最後都會進 href。來源若意外混入 javascript:、data: 或壞掉的字串，
// 寧可拿掉連結也不要讓每日資料更新變成注入入口。
function safeHttpUrl(value) {
  if (!value) return '';
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch { return ''; }
}
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

// ── 剩餘座位 ────────────────────────────────────────────
// 新光／美麗新／in89 的來源有給剩餘席次。但「剩 44 席」本身無法判讀——
// 44 席在小廳是客滿邊緣、在大廳是空的。in89 有給總席次，另外兩家沒有，
// 所以用「同一影廳出現過的最大餘位」當容量估計（開賣初期的場次通常接近滿座）。
const hallCap = new Map();
for (const r of merged) {
  if (typeof r.seats !== 'number') continue;
  const key = `${r.cinema}|${r.hall || ''}`;
  const cap = typeof r.total === 'number' ? r.total : r.seats;
  hallCap.set(key, Math.max(hallCap.get(key) || 0, cap));
}

// 只分三段。精確數字會讓人以為是即時的，但這是抓取當下的快照。
function seatLevel(r) {
  if (typeof r.seats !== 'number') return null;
  const cap = hallCap.get(`${r.cinema}|${r.hall || ''}`);
  if (!cap || cap < 10) return null;          // 樣本太少，估不準就不要標
  const ratio = r.seats / cap;
  if (ratio >= 0.5) return 1;                  // 空位多
  if (ratio >= 0.15) return 2;                 // 剩一些
  return 3;                                    // 快滿了
}

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
  const tpl = safeHttpUrl(r.url)
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
  if (!groups.has(k)) groups.set(k, { key, times: [], seats: [] });
  groups.get(k).times.push(Number(r.time.slice(0, 2)) * 60 + Number(r.time.slice(3, 5)));
  groups.get(k).seats.push(seatLevel(r) || 0);
}

const b36 = (n) => n.toString(36);
// 時間與座位等級要對齊，所以先一起排序再各自輸出（去重以時間為準）
const packed = [...groups.values()]
  .map((g) => {
    const seen = new Set();
    const pairs = g.times
      .map((t, i) => [t, g.seats[i]])
      .filter(([t]) => (seen.has(t) ? false : (seen.add(t), true)))
      .sort((a, b) => a[0] - b[0]);
    const times = pairs.map(([t]) => b36(t)).join('.');
    const seats = pairs.map(([, s]) => s).join('');
    return g.key.map(b36).join(',') + ',' + times + (seats.replace(/0/g, '') ? ',' + seats : '');
  })
  .join(';');
const rows = merged; // 只用來產生索引頁；前端的精確場次數在 groups 去重後計算
const sessionCount = [...groups.values()].reduce((n, g) => n + new Set(g.times).size, 0);

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
    url: safeHttpUrl(info.url) || null,
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

// JSON 會直接放進 <script>。即使上游片名出現 </script> 也不能讓它提早關閉標籤；
// U+2028/U+2029 則避開舊 JavaScript parser 對行分隔字元的差異。
const serializedPayload = JSON.stringify(payload)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

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
let html = tpl
  .replace('__DATA__', () => serializedPayload)
  .replace(/__SOURCES__/g, sources)
  .replace(/__GENERATED__/g, generated)
  .replace(/__NOTICE__/g, notice)
  .replace(/__SITE_URL__/g, SITE_URL)
  .replace(/__NCINEMA__/g, String(cinemas.list.length))
  .replace(/__NMOVIE__/g, String(movies.list.length))
  .replace(/__NSESSION__/g, sessionCount.toLocaleString('en-US'))
  .replace(/__LASTDATE__/g, dates.list.length ? dates.list[dates.list.length - 1].slice(5).replace('-', '/') : '—');

// CSP 不允許任意 inline script；資料每天變動，因此建置後為「這一份」script 計算 hash。
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!inlineScript) throw new Error('找不到主程式，無法產生 CSP hash');
const scriptHash = createHash('sha256').update(inlineScript).digest('base64');
html = html.replace('__SCRIPT_HASH__', scriptHash);

await mkdir(`${root}out`, { recursive: true }); // 乾淨 checkout 下 out/ 不存在（已 gitignore）
await writeFile(`${root}out/index.html`, html);

const generatedAt = new Date().toISOString();
const siteStatus = {
  generatedAt,
  generatedTaipei: generated,
  counts: {
    sessions: sessionCount,
    cinemas: cinemas.list.length,
    geocodedCinemas: withGeo,
    movies: movies.list.length,
    dates: dates.list.length,
  },
  coverage: { firstDate: dates.list[0] || null, lastDate: dates.list.at(-1) || null },
  sources: [...present].sort().map((source) => ({
    id: source,
    name: SOURCE_NAMES[source] || source,
    ageHours: freshness[source] == null ? null : Number(freshness[source].toFixed(1)),
  })),
  warnings: { absent, viaBackup, lagging, staleSources },
};
await writeFile(`${root}out/site-status.json`, JSON.stringify(siteStatus, null, 2) + '\n');

// 搜尋引擎不會執行所有互動操作，另產生穩定的「電影／戲院／日期」文字頁。
// 這些頁同時也是無 JavaScript 或低階裝置的可讀退路，不複製海報、不引入第三方追蹤。
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const slugFor = (label) => {
  const clean = String(label).normalize('NFKC').trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 48) || 'item';
  return `${clean}-${createHash('sha256').update(String(label)).digest('hex').slice(0, 8)}`;
};
const urlPath = (kind, slug) => `${kind}/${encodeURIComponent(slug)}/`;
const displaySeen = new Set();
const displayRows = merged.map((r) => ({
  ...r,
  movieTitle: movieInfo.get(r.movie)?.title || r.movie,
  sourceUrl: safeHttpUrl(r.url),
})).filter((r) => {
  const key = [r.cinema, r.movieTitle, r.date, r.time, r.hall || '', (r.tags || []).join('・')].join('|');
  if (displaySeen.has(key)) return false;
  displaySeen.add(key);
  return true;
});

const groupRows = (key) => {
  const out = new Map();
  for (const row of displayRows) {
    const value = row[key];
    if (!out.has(value)) out.set(value, []);
    out.get(value).push(row);
  }
  return out;
};

const seoPage = ({ title, description, canonical, headings, values, mainHref }) => `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}｜開演</title><meta name="description" content="${esc(description)}">
<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; upgrade-insecure-requests">
<link rel="canonical" href="${esc(canonical)}"><link rel="icon" href="../../favicon.svg" type="image/svg+xml">
<style>body{margin:0;background:#f3f0e8;color:#171613;font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;line-height:1.6}main{max-width:900px;margin:auto;padding:38px 20px 80px}a{color:#855126}h1{font-family:"PMingLiU",serif;margin:.2em 0}.muted{color:#69655e}table{width:100%;border-collapse:collapse;margin:24px 0;background:#faf8f2}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #d5d0c4;vertical-align:top}th{font-size:.8rem;color:#69655e}@media(max-width:640px){th:nth-child(4),td:nth-child(4){display:none}th,td{padding:8px 4px}}</style>
</head><body><main><p><a href="${esc(mainHref)}">← 回到互動版查詢</a></p><h1>${esc(title)}</h1><p>${esc(description)}</p>
<p class="muted">更新於 ${esc(generated)}；場次與票價以影城官方公告為準。</p>
<table><thead><tr>${headings.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
${values.map((cells) => `<tr>${cells.map((cell, i) => `<td>${i === cells.length - 1 && cell.href ? `<a href="${esc(cell.href)}" target="_blank" rel="noopener noreferrer">${esc(cell.text)}</a>` : esc(cell.text)}</td>`).join('')}</tr>`).join('\n')}
</tbody></table><p><a href="${esc(mainHref)}">用地區、時段、語言、影廳格式與距離繼續篩選 →</a></p></main></body></html>`;

const sitemapPaths = [''];
async function writeSeoGroup(kind, grouped, makePage) {
  for (const [label, sourceRows] of grouped) {
    const slug = slugFor(label);
    const rel = urlPath(kind, slug);
    const dir = `${root}out/${kind}/${slug}`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/index.html`, makePage(label, sourceRows, `${SITE_URL}/${rel}`));
    sitemapPaths.push(rel);
  }
}

const sortedRows = (sourceRows) => [...sourceRows].sort((a, b) =>
  a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.cinema.localeCompare(b.cinema));
const linkCell = (r) => ({ text: r.sourceUrl ? '影城訂票／場次頁 →' : '請洽影城', href: r.sourceUrl || null });

await writeSeoGroup('movie', groupRows('movieTitle'), (label, sourceRows, canonical) => seoPage({
  title: `${label} 電影時刻`,
  description: `${label} 的跨影城、跨日期電影場次，共 ${sourceRows.length} 場。`,
  canonical,
  headings: ['日期', '戲院', '時間／版本', '官方來源'],
  values: sortedRows(sourceRows).map((r) => [
    { text: r.date }, { text: `${r.cinema}${r.area ? `・${r.area}` : ''}` },
    { text: `${r.time}${r.tags?.length ? `・${r.tags.join('・')}` : r.hall ? `・${r.hall}` : ''}` }, linkCell(r),
  ]),
  mainHref: `${SITE_URL}/?m=${encodeURIComponent(label)}`,
}));

await writeSeoGroup('cinema', groupRows('cinema'), (label, sourceRows, canonical) => seoPage({
  title: `${label} 電影時刻`,
  description: `${label} 的未來電影場次，共 ${sourceRows.length} 場。`,
  canonical,
  headings: ['日期', '電影', '時間／版本', '官方來源'],
  values: sortedRows(sourceRows).map((r) => [
    { text: r.date }, { text: r.movieTitle },
    { text: `${r.time}${r.tags?.length ? `・${r.tags.join('・')}` : r.hall ? `・${r.hall}` : ''}` }, linkCell(r),
  ]),
  mainHref: `${SITE_URL}/?q=${encodeURIComponent(label)}&v=cinema`,
}));

await writeSeoGroup('date', groupRows('date'), (label, sourceRows, canonical) => seoPage({
  title: `${label} 全台電影時刻`,
  description: `${label} 的全台電影場次，共 ${sourceRows.length} 場。`,
  canonical,
  headings: ['電影', '戲院', '時間／版本', '官方來源'],
  values: sortedRows(sourceRows).map((r) => [
    { text: r.movieTitle }, { text: `${r.cinema}${r.area ? `・${r.area}` : ''}` },
    { text: `${r.time}${r.tags?.length ? `・${r.tags.join('・')}` : r.hall ? `・${r.hall}` : ''}` }, linkCell(r),
  ]),
  mainHref: `${SITE_URL}/?d=${encodeURIComponent(label)}`,
}));

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapPaths
  .map((p) => `  <url><loc>${esc(`${SITE_URL}/${p}`)}</loc><lastmod>${todayTPE}</lastmod></url>`).join('\n')}\n</urlset>\n`;
await writeFile(`${root}out/sitemap.xml`, sitemap);
await writeFile(`${root}out/robots.txt`, `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
console.log(
  `\nout/index.html: ${sessionCount} 場次 / ${cinemas.list.length} 影城 / ${movies.list.length} 部片` +
    `（${mergedTitles} 部跨影城異名合併、${eventFolded} 個特別場歸戶、海報 ${withPoster}、簡介 ${withSyn}、座標 ${withGeo}）` +
    `, ${(html.length / 1024 / 1024).toFixed(2)} MB；另產生 ${sitemapPaths.length - 1} 個索引頁`,
);
