// 影城經緯度資料庫：data/cinemas.json，供「離我最近」距離排序功能使用。
// 影城名稱鍵值刻意跟各 fetch/*.mjs 產出的 `cinema` 欄位完全一致，方便 build_site.mjs
// 直接用場次記錄的 cinema 名稱查表（本檔不動 build_site.mjs，查表邏輯留給之後接線）。
//
// 座標／地址來源，依可靠度排序：
//   1. 秀泰（15館）：capi.showtimes.com.tw bootstrap API 直接给 meta.latLng，最準。
//   2. 光點華山電影館：官網 aboutus/location.html 內嵌 Google Maps iframe 的 pb 參數
//      本身就帶精確經緯度（2d=lng, 3d=lat），比地理編碼準，直接解析 iframe URL。
//   3. 國賓（9館）、美麗新（2館）、府中15：官網是 server-rendered 純 HTML，地址現抓，
//      再用 Nominatim 地理編碼補經緯度。
//   4. 新光（5館）、喜樂時代（4館）、in89（2館）、樂聲（1館）、威秀含MUVIE（20館）、
//      以及其餘藝文/獨立館（10館）：官網不是 SPA 動態渲染就是沒有可靠端點，改用
//      開眼電影網（atmovies.com.tw）的戲院場次頁——那頁面固定有純文字「地址:」「電話:」
//      兩行，fetch/atmovies.mjs 已經在用同一批頁面抓場次，這裡只是多讀兩行地址資訊。
//      戲院代碼是逐一核對過的（部分沿用 fetch/atmovies.mjs 的 VIESHOW/ARTHOUSE/
//      SKCINEMAS_BACKUP 白名單，新光/喜樂時代/in89/樂聲的代碼是另外查證，見下方註解），
//      再用 Nominatim 補經緯度。
//
// Nominatim 地理編碼策略：台灣地址「門牌號」在 OSM 上的資料覆蓋率不完整，純住址查詢
// 常常完全查不到，或退化成整條路隨機一點回傳（那樣座標可能偏移幾公里，等於用猜的）；
// 但台灣連鎖影城多半在 OSM 上被標成 amenity=cinema/theatre 的 POI 節點、名稱和門牌都
// 對得上（實測「國賓大戲院」「誠品電影院」「百老匯影城公館店」「府中15」用完整館名查
// 都直接命中，門牌號跟官方地址逐字相符）。所以策略是「先用完整館名＋縣市查 POI，查不到
// 或行政區對不上再退回門牌地址查」，兩種查法都要求命中結果的縣市（必要）與行政區
// （已知時也必要）要跟我們已知地址一致，結果類型不能是籠統的道路／行政區界——查不到
// 就是查不到，寧可 lat/lng 留 null 也不要拿路口中點或同名分店的座標充數。
import { politeFetch } from '../lib/common.mjs';
import { writeFile, mkdir } from 'node:fs/promises';

const OUT_PATH = new URL('../data/cinemas.json', import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// ============================================================
// Nominatim 地理編碼（政策要求每秒最多 1 次；這裡用 1300ms，比政策更保守）
// ============================================================
const NOMINATIM_UA = 'kaiyan-showtimes/1.0 (https://github.com/YHHuan/kaiyan-showtimes)';
const NOMINATIM_DELAY_MS = 1300;
let lastNominatim = 0;

async function nominatimSearch(q) {
  const wait = lastNominatim + NOMINATIM_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=5&addressdetails=1&countrycodes=tw`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 1) { console.log(`  [nominatim 查詢失敗] ${q}: ${e.message}`); return []; }
      await sleep(1500);
    }
  }
}

const cityOf = (address) => (address.match(/^(\S+?[市縣])/) || [])[1] || null;
const districtOf = (address) => (address.match(/[市縣](\S+?[區鄉鎮市])/) || [])[1] || null;
const sameCity = (known, text) =>
  !!known && (text.includes(known) || text.includes(known.replace('台', '臺')) || text.includes(known.replace('臺', '台')));

function pickHit(results, { city, district, requireNonRoad }) {
  for (const item of results) {
    if (requireNonRoad && (item.class === 'highway' || item.addresstype === 'road')) continue;
    if (item.class === 'boundary' || item.class === 'place') continue; // 只是行政界/地名中心點，不是實際地點
    if (!sameCity(city, item.display_name)) continue;
    if (district && !item.display_name.includes(district)) continue; // 縣市對但行政區不對，不可信，跳過
    return { lat: Number(item.lat), lng: Number(item.lon), osmName: item.display_name };
  }
  return null;
}

// 查不到就回 null（lat/lng 留白），絕不用附近地標或同名分店的座標頂替。
async function geocode(cinemaName, address) {
  const city = cityOf(address);
  const district = districtOf(address);

  const nameHit = pickHit(await nominatimSearch(`${cinemaName} ${city || ''}`.trim()), { city, district });
  if (nameHit) return { lat: nameHit.lat, lng: nameHit.lng, method: 'osm-poi-name' };

  const addrHit = pickHit(await nominatimSearch(address), { city, district, requireNonRoad: true });
  if (addrHit) return { lat: addrHit.lat, lng: addrHit.lng, method: 'osm-address' };

  return null;
}

const records = {};
function addRecord(name, fields) {
  if (records[name]) { console.log(`  [警告] 重複的影城名稱，後者覆蓋前者: ${name}`); }
  records[name] = fields;
}

// ============================================================
// 1. 秀泰（15館）：bootstrap API 直接給 lat/lng，不必地理編碼
// ============================================================
async function fetchShowtimes() {
  const { payload } = await politeFetch('https://capi.showtimes.com.tw/4/app/bootstrap', { asJson: true });
  for (const c of payload.corporations || []) {
    const [lat, lng] = (c.meta?.latLng || '').split(',').map(Number);
    addRecord(c.name, {
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      address: c.address || null,
      phone: (c.phones || [])[0] || null,
      transit: stripHtml(c.meta?.transit) || null,
      buses: c.meta?.buses || null,
      source: 'showtimes-bootstrap-api',
      url: 'https://www.showtimes.com.tw/ticketing',
    });
  }
  console.log(`[秀泰] ${payload.corporations?.length || 0} 館，座標直接來自官方 API`);
}

// ============================================================
// 2. 國賓（9館）：TheaterList 頁面本身就含地址（跟 fetch/ambassador.mjs 同一招）
// ============================================================
async function fetchAmbassador() {
  const html = await politeFetch('https://www.ambassador.com.tw/home/TheaterList');
  const theaters = [];
  for (const m of html.matchAll(/href="[^"]*Showtime\?ID=([a-f0-9-]{36})[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    const lines = m[2].replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (theaters.some((t) => t.id === m[1])) continue;
    const [name, address = '', phone = ''] = lines;
    theaters.push({ id: m[1], name, address, phone });
  }
  console.log(`[國賓] TheaterList 找到 ${theaters.length} 館，開始逐館地理編碼`);
  for (const th of theaters) {
    const geo = await geocode(th.name, th.address);
    addRecord(th.name, {
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
      address: th.address,
      phone: th.phone || null,
      transit: null,
      source: geo ? `ambassador-official-site+nominatim(${geo.method})` : 'ambassador-official-site (查無座標)',
      url: `https://www.ambassador.com.tw/home/Showtime?ID=${th.id}`,
    });
    console.log(`  ${th.name}: ${th.address} -> ${geo ? `${geo.lat},${geo.lng} (${geo.method})` : '查無座標'}`);
  }
}

// ============================================================
// 3. 美麗新（2館）：AboutUs 頁面是 server-rendered，含地址、服務電話
//    type 參數是逐一 curl 各連結／WebSearch 查到的固定值，非猜測。
// ============================================================
async function fetchMiranew() {
  const PAGES = [
    { name: '台北大直美麗新皇家影城', type: 'dazhi_royal' },
    { name: '桃園台茂美麗新影城', type: 'dazhi_taimall' },
  ];
  for (const p of PAGES) {
    const url = `https://www.miranewcinemas.com/AboutUs/Index?type=${p.type}`;
    const html = await politeFetch(url);
    const addrM = html.match(/<p class="title">地址<\/p>\s*<p>\s*([\s\S]*?)<\/p>/);
    const phoneM = html.match(/<p class="title">服務電話<\/p>\s*<p>\s*([\s\S]*?)<\/p>/);
    const address = addrM ? stripHtml(addrM[1]).replace(/<br\s*\/?>/g, '') : null;
    const phone = phoneM ? stripHtml(phoneM[1]) : null;
    if (!address) { console.log(`  [美麗新] ${p.name}: 找不到地址，頁面結構可能改了`); continue; }
    const geo = await geocode(p.name, address);
    addRecord(p.name, {
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
      address,
      phone,
      transit: null,
      source: geo ? `miranew-official-site+nominatim(${geo.method})` : 'miranew-official-site (查無座標)',
      url,
    });
    console.log(`[美麗新] ${p.name}: ${address} -> ${geo ? `${geo.lat},${geo.lng} (${geo.method})` : '查無座標'}`);
  }
}

// ============================================================
// 4. 光點華山電影館、府中15：官網 server-rendered，地址現抓；
//    光點華山的地址頁剛好內嵌 Google Maps iframe，直接解析 pb 參數拿精確座標，
//    比地理編碼準，不必再查 Nominatim。
// ============================================================
async function fetchArthouseOfficial() {
  // -- 光點華山電影館 --
  {
    const url = 'http://www.spot-hs.org.tw/aboutus/location.html';
    const html = await politeFetch(url);
    const addrM = html.match(/＜地址＞[\s\S]*?<p>\s*([\s\S]*?)\s*<\/p>/);
    const transitM = html.match(/＜捷運＞[\s\S]*?aboutuscom2">\s*<h6>\s*([\s\S]*?)<\/h6>/);
    const iframeM = html.match(/<iframe[^>]*src="[^"]*!2d([\d.]+)!3d([\d.]+)[^"]*"/);
    const address = addrM ? stripHtml(addrM[1]) : null;
    const transit = transitM ? stripHtml(transitM[1]) : null;
    const lng = iframeM ? Number(iframeM[1]) : null;
    const lat = iframeM ? Number(iframeM[2]) : null;
    addRecord('光點華山電影館', {
      lat, lng, address, phone: null, transit,
      source: iframeM ? 'spot-hs-official-site (Google Maps 內嵌座標)' : 'spot-hs-official-site (查無座標)',
      url,
    });
    console.log(`[光點華山電影館] ${address} -> ${lat},${lng}`);
  }
  // -- 府中15 --
  {
    const url = 'https://www.fuzhong15.ntpc.gov.tw/';
    const html = await politeFetch(url);
    const addrM = html.match(/地址：\s*(?:\d{5,6})?([^<]+)</);
    const address = addrM ? stripHtml(addrM[1]) : null;
    if (!address) { console.log('  [府中15] 找不到地址，頁面結構可能改了'); return; }
    const geo = await geocode('府中15', address);
    addRecord('府中15', {
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
      address, phone: null, transit: null,
      source: geo ? `fuzhong15-official-site+nominatim(${geo.method})` : 'fuzhong15-official-site (查無座標)',
      url,
    });
    console.log(`[府中15] ${address} -> ${geo ? `${geo.lat},${geo.lng} (${geo.method})` : '查無座標'}`);
  }
}

// ============================================================
// 5. 其餘 42 館：改用開眼電影網（atmovies.com.tw）戲院場次頁的「地址:」「電話:」兩行。
//    代碼→本站官方館名對照表（逐一 curl 核對過地址跟官方資料一致，見各段註解）。
// ============================================================
const ATMOVIES_CINEMAS = {
  // -- 威秀（含MUVIE，20館）：代碼沿用 fetch/atmovies.mjs 的 VIESHOW 白名單，名稱本來就一致 --
  t02a01: { name: '台北信義威秀', region: 'a02' },
  t02a11: { name: 'MUVIE CINEMAS台北松仁威秀', region: 'a02' },
  t02a12: { name: '台北南港LaLaport威秀影城', region: 'a02' },
  t02b14: { name: '台北京站威秀', region: 'a02' },
  t02b08: { name: '台北西門威秀影城', region: 'a02' },
  t02e07: { name: '板橋大遠百威秀影城', region: 'a02' },
  t02e12: { name: '林口三井OUTLET威秀影城', region: 'a02' },
  t02e20: { name: '中和環球威秀影城', region: 'a02' },
  t02e21: { name: '新店裕隆城威秀影城', region: 'a02' },
  t03308: { name: '桃園統領威秀影城', region: 'a03' },
  t03317: { name: '桃園桃知道威秀影城', region: 'a03' },
  t03505: { name: '新竹大遠百威秀影城', region: 'a35' },
  t03508: { name: '新竹巨城威秀影城', region: 'a35' },
  t04402: { name: '台中老虎城威秀', region: 'a04' },
  t04407: { name: '台中大遠百威秀影城', region: 'a04' },
  t04409: { name: '台中iFG遠雄廣場威秀影城', region: 'a04' },
  t06609: { name: '台南大遠百威秀影城', region: 'a06' },
  t06610: { name: '台南南紡威秀影城', region: 'a06' },
  t06611: { name: '台南FOCUS威秀影城', region: 'a06' },
  t07703: { name: '高雄大遠百威秀影城', region: 'a07' },

  // -- 藝文/獨立館（10館）：代碼沿用 fetch/atmovies.mjs 的 ARTHOUSE 白名單，名稱本來就一致 --
  t02a08: { name: '誠品電影院', region: 'a02' },
  t02d20: { name: '光點台北電影院', region: 'a02' },
  t02b07: { name: '真善美戲院', region: 'a02' },
  t02f05: { name: '景美佳佳戲院', region: 'a02' },
  t02a03: { name: '微風影城', region: 'a02' },
  t02a05: { name: '總督影城', region: 'a02' },
  t02a06: { name: '哈拉影城', region: 'a02' },
  t02c01: { name: '百老匯影城公館店', region: 'a02' },
  t02e03: { name: '新莊鴻金寶麻吉影城', region: 'a02' },
  t02e04: { name: '三重天台戲院', region: 'a02' },

  // -- 新光（5館）：atmovies 上的館名跟 fetch/skcinemas.mjs 的官方館名不同，這裡對照到官方
  //    名稱（跟 fetch/atmovies.mjs 的 SKCINEMAS_BACKUP 同一組代碼、同一組核對依據：
  //    地址與 skcinemas.mjs 館名一一對應——西寧南路＝台北獅子林、忠誠路＝台北天母、
  //    中壢區春德路＝桃園青埔【行政區屬中壢區】、中港路＝台中中港、西門路＝台南西門）--
  t02b05: { name: '台北獅子林新光影城', region: 'a02' },
  t02d04: { name: '台北天母新光影城', region: 'a02' },
  t03315: { name: '桃園青埔新光影城', region: 'a03' },
  t04401: { name: '台中中港新光影城', region: 'a04' },
  t06607: { name: '台南西門新光影城', region: 'a06' },

  // -- 喜樂時代（4館）：atmovies 代碼是逐一在 a02/a07 地區頁搜尋「喜樂時代」核對出來的，
  //    對照到 fetch/centuryasia.mjs 用的官方分店名（今日店/南港店/永和店/高雄店）--
  t02a09: { name: '喜樂時代影城 南港店', region: 'a02' },
  t02b06: { name: '喜樂時代影城 今日店', region: 'a02' },
  t02e17: { name: '喜樂時代影城 永和店', region: 'a02' },
  t07730: { name: '喜樂時代影城 高雄店', region: 'a07' }, // atmovies 上寫「高雄總圖店」，跟官方 GetTheaterList 的「高雄店」是同一館

  // -- in89（2館）：代碼由 WebSearch 查到並用地址核對過 --
  t03307: { name: '桃園站前_in89豪華影城', region: 'a03' },
  t07702: { name: '高雄鹽埕_in89駁二電影院', region: 'a07' },

  // -- 樂聲（1館）：地址跟維基百科（台北市萬華區武昌街二段85號）一致 --
  t02b03: { name: '樂聲影城(西門町)', region: 'a02' },
};

async function fetchAtmoviesAddresses() {
  const entries = Object.entries(ATMOVIES_CINEMAS);
  console.log(`[開眼代抓地址] 共 ${entries.length} 館`);
  for (const [code, { name, region }] of entries) {
    const url = `https://www.atmovies.com.tw/showtime/${code}/${region}/`;
    let html;
    try {
      html = await politeFetch(url);
    } catch (e) {
      console.log(`  ${name}: ${e.message}`);
      continue;
    }
    const addrM = html.match(/地址[:：]\s*([^\n<]+?)\s*(?:<|$)/);
    const phoneM = html.match(/電話[:：]\s*([^\n<]+?)\s*(?:<|$)/);
    const address = addrM ? stripHtml(addrM[1]) : null;
    const phone = phoneM ? stripHtml(phoneM[1]) : null;
    if (!address) {
      console.log(`  ${name}: 開眼頁面找不到地址`);
      addRecord(name, { lat: null, lng: null, address: null, phone, transit: null, source: 'atmovies-theater-page (查無地址)', url });
      continue;
    }
    const geo = await geocode(name, address);
    addRecord(name, {
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
      address,
      phone,
      transit: null,
      source: geo ? `atmovies-theater-page+nominatim(${geo.method})` : 'atmovies-theater-page (查無座標)',
      url,
    });
    console.log(`  ${name}: ${address} -> ${geo ? `${geo.lat},${geo.lng} (${geo.method})` : '查無座標'}`);
  }
}

// ============================================================
await fetchShowtimes();
await fetchAmbassador();
await fetchMiranew();
await fetchArthouseOfficial();
await fetchAtmoviesAddresses();

const total = Object.keys(records).length;
const withLatLng = Object.values(records).filter((r) => r.lat != null && r.lng != null).length;
const withAddress = Object.values(records).filter((r) => r.address).length;
const missing = Object.entries(records).filter(([, r]) => r.lat == null || r.lng == null).map(([n]) => n);

await mkdir(new URL('../data/', import.meta.url).pathname, { recursive: true });
await writeFile(OUT_PATH, JSON.stringify(records, null, 1));

console.log(`\n${OUT_PATH}`);
console.log(`總影城數: ${total}`);
console.log(`有座標: ${withLatLng} (${((withLatLng / total) * 100).toFixed(1)}%)`);
console.log(`有地址: ${withAddress}`);
console.log(`查無座標的影城 (${missing.length}): ${missing.join('、')}`);
