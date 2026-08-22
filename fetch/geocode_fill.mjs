// 把 data/cinemas.json 裡「有地址但沒座標」的影城補上經緯度。
//
// fetch/cinemas.mjs 負責蒐集地址與可靠來源的座標（秀泰 API 直接給、部分官網有嵌地圖）；
// 這支只做剩下的地理編碼，分開的原因是 Nominatim 規定每秒最多一次請求，
// 混在主抓取器裡會讓整輪變得又慢又容易半途失敗。
//
// 台灣地址在 Nominatim 上直接查常常失敗（門牌層級資料不全），所以逐步放寬：
// 完整地址 → 去掉樓層/巷弄 → 只留到路名 → 加上「台灣」。每退一步精度變差，
// 所以記錄實際命中的查法（precision），前端才知道這個座標可不可信。
import { readFile, writeFile } from 'node:fs/promises';

const UA = 'kaiyan-showtimes/1.0 (https://github.com/YHHuan/kaiyan-showtimes)';
const DELAY_MS = 1200; // Nominatim 使用政策：每秒最多 1 次
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const path = new URL('../data/cinemas.json', import.meta.url).pathname;
const data = JSON.parse(await readFile(path, 'utf8'));

// 由細到粗的查法。愈後面精度愈差，只在前面都查不到時才用。
function queries(address) {
  const out = [];
  const a = address.trim();
  out.push(['full', a]);
  const noFloor = a.replace(/[0-9０-９]+\s*[樓F](之[0-9]+)?.*$/, '').replace(/[,，、].*$/, '').trim();
  if (noFloor && noFloor !== a) out.push(['no-floor', noFloor]);
  const road = noFloor.match(/^(.{2,3}[市縣].{1,4}[區鄉鎮市].*?[路街道大道](?:[一二三四五六七八九十]段)?)/);
  if (road) out.push(['road', road[1]]);
  return out.map(([p, q]) => [p, q.includes('台灣') ? q : `台灣${q}`]);
}

async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=tw`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!j.length) return null;
  return { lat: Number(j[0].lat), lng: Number(j[0].lon) };
}

const todo = Object.entries(data).filter(([, v]) => v.address && !(v.lat && v.lng));
console.log(`待補座標 ${todo.length} 家（Nominatim 每秒 1 次，約需 ${Math.ceil((todo.length * DELAY_MS) / 1000 / 60)} 分鐘）`);

let ok = 0;
for (const [name, info] of todo) {
  let hit = null;
  for (const [precision, q] of queries(info.address)) {
    await sleep(DELAY_MS);
    try {
      const r = await geocode(q);
      if (r) { hit = { ...r, precision, query: q }; break; }
    } catch (e) {
      console.log(`  ${name}: ${e.message}`);
    }
  }
  if (hit) {
    // 台灣本島大致範圍，落在外面代表查錯了（常見於只查到路名的情況）
    if (hit.lat < 21.5 || hit.lat > 25.5 || hit.lng < 119.3 || hit.lng > 122.2) {
      console.log(`  ${name}: 座標落在台灣範圍外，捨棄（${hit.lat},${hit.lng}）`);
      continue;
    }
    data[name].lat = hit.lat;
    data[name].lng = hit.lng;
    data[name].geoPrecision = hit.precision;
    data[name].source = `${data[name].source || ''}+nominatim(${hit.precision})`.replace(/^\+/, '');
    ok++;
    console.log(`  ✓ ${name} (${hit.precision})`);
  } else {
    console.log(`  ✗ ${name}：查無座標`);
  }
}

await writeFile(path, JSON.stringify(data, null, 1));
const total = Object.keys(data).length;
const withGeo = Object.values(data).filter((v) => v.lat && v.lng).length;
console.log(`\n補上 ${ok} 家，目前 ${withGeo}/${total} 家有座標`);
