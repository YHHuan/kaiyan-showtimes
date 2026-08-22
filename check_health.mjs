// 抓完後的健康檢查。排程跑起來之後，最危險的失敗不是「整個掛掉」——那看得出來——
// 而是「某家改版了，解析器安靜地回 0 筆」，網站照樣產出、只是少了半個台灣。
// 這支就是要讓那種安靜的失敗變成吵的失敗。
//
// 判準：
//   1. 硬性下限：每個來源至少要有這麼多筆，低於就是壞了（不是淡季）
//   2. 相對衰退：跟上一輪成功的數字比，掉超過 55% 就可疑
//   3. 新鮮度：超過 FRESH_HOURS 沒更新的來源，資料不再採用
//   4. 全站門檻：總量低於 MIN_TOTAL 就不要發佈，寧可停留在舊版
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('.', import.meta.url).pathname;

// 硬性下限抓得比實際值寬鬆很多，只用來抓「整個解析壞掉」，不是抓淡季少排片
const FLOOR = {
  showtimes: 1500,   // 秀泰 15 館，實測約 5900
  ambassador: 800,   // 國賓 9 館，實測約 3100
  centuryasia: 400,  // 喜樂時代 4 館，實測約 1900
  skcinemas: 300,    // 新光 5 館，實測約 1250
  miranew: 150,      // 美麗新，實測約 720
  in89: 100,         // in89 2 館，實測約 520
  atmovies: 40,      // 開眼補的藝文館，只有當天，實測約 240
  arthouse: 20,      // 光點華山＋府中15，實測約 180
  arthouse2: 25,     // 真善美＋光點台北＋TFAI（TFAI 走 OPENTIX），實測約 128
  lux: 15,           // 樂聲，只公開兩天，實測約 80
};
const DROP_RATIO = 0.45;   // 跌到上一輪的 45% 以下＝可疑
const FRESH_HOURS = 72;    // 超過這個時數沒更新就不採用
const MIN_TOTAL = 6000;    // 全站總場次低於此就別發佈

let status = {};
try {
  status = JSON.parse(await readFile(`${root}data/_status.json`, 'utf8'));
} catch {
  console.error('找不到 data/_status.json——所有抓取器都沒跑過，或跑到一半就掛了。');
  process.exit(1);
}
let history = {};
try {
  history = JSON.parse(await readFile(`${root}data/_history.json`, 'utf8'));
} catch {}

const now = Date.now();
const problems = [];
const warnings = [];
let total = 0;
const healthy = {};

for (const [source, floor] of Object.entries(FLOOR)) {
  const s = status[source];
  if (!s) {
    problems.push(`${source}: 完全沒有抓取紀錄`);
    continue;
  }
  const ageH = (now - Date.parse(s.fetchedAt)) / 3600000;
  if (ageH > FRESH_HOURS) {
    problems.push(`${source}: 資料已 ${ageH.toFixed(0)} 小時未更新（上限 ${FRESH_HOURS}），不予採用`);
    continue;
  }
  if (s.count < floor) {
    problems.push(`${source}: 只有 ${s.count} 筆，低於下限 ${floor} —— 解析器很可能壞了`);
    continue;
  }
  const prev = history[source];
  if (prev && s.count < prev * DROP_RATIO) {
    warnings.push(`${source}: ${prev} → ${s.count} 筆（掉了 ${(100 - (s.count / prev) * 100).toFixed(0)}%），請確認是否改版`);
  }
  if (ageH > 26) {
    warnings.push(`${source}: 沿用 ${ageH.toFixed(0)} 小時前的資料（本輪抓取失敗）`);
  }
  healthy[source] = s.count;
  total += s.count;
}

console.log('來源健康度：');
for (const [k, v] of Object.entries(healthy)) console.log(`  ✓ ${k.padEnd(13)} ${v}`);
for (const w of warnings) console.log(`  ! ${w}`);
for (const p of problems) console.log(`  ✗ ${p}`);
console.log(`\n可用來源 ${Object.keys(healthy).length}/${Object.keys(FLOOR).length}，總場次 ${total}`);

// 更新歷史（只記健康的，免得把壞掉的低數字當成新基準）
await writeFile(`${root}data/_history.json`, JSON.stringify({ ...history, ...healthy }, null, 1));

if (total < MIN_TOTAL) {
  console.error(`\n總場次 ${total} 低於門檻 ${MIN_TOTAL}，不發佈——保留線上既有版本比推一個殘缺的好。`);
  process.exit(1);
}
if (problems.length > Object.keys(FLOOR).length / 2) {
  console.error(`\n過半來源異常（${problems.length}/${Object.keys(FLOOR).length}），不發佈。`);
  process.exit(1);
}
if (problems.length) {
  console.log(`\n有 ${problems.length} 個來源異常但其餘健康，照常發佈（缺的來源會在頁面上標示）。`);
}
