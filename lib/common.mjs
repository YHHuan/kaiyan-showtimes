// 共用工具：禮貌抓取（固定 UA、間隔、重試一次）、寫檔、片名正規化
import { writeFile, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cinemaName, areaName } from './cinema-coverage.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastFetch = 0;
export async function politeFetch(url, {
  asJson = false,
  method = 'GET',
  form = null,
  headers = {},
  timeoutMs = 20000,
} = {}) {
  const wait = lastFetch + DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
  const init = { method, headers: { 'User-Agent': UA, ...headers } };
  // form：一般表單 POST（給部分影城的 .ashx AJAX 端點用，非訂票步驟，唯讀查詢）
  if (form) {
    init.body = new URLSearchParams(form);
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 每次嘗試都要建立新的 signal；逾時的 AbortSignal 不能拿來重試。
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return asJson ? await res.json() : await res.text();
    } catch (e) {
      if (attempt === 1) throw new Error(`fetch failed ${url}: ${e.message}`);
      await sleep(1500);
    }
  }
}

export async function saveRecords(path, records, details = {}) {
  await mkdir(dirname(path), { recursive: true });
  const stamp = new Date().toISOString();
  records = records.map(r => ({ ...r, cinema: cinemaName(r.cinema), area: areaName(r.area), fetchedAt: r.fetchedAt || stamp }));
  let previous = [];
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch {}
  await writeFile(path + '.tmp', JSON.stringify(records, null, 1));
  await rename(path + '.tmp', path);
  await recordStatus(path, records, details, previous, stamp);
  console.log(`${path}: ${records.length} 筆場次`);
}

// 每個來源記下「這批是什麼時候抓的、抓到幾筆」。
// 排程跑起來後這是判斷資料新不新鮮的唯一依據：某家掛掉時我們會沿用上一輪的檔案，
// 沒有這個時間戳就沒辦法分辨「今天抓到的」和「三天前的殘骸」。
async function recordStatus(path, records, details, previous, stamp) {
  const dir = dirname(path);
  const source = path.replace(/.*\//, '').replace(/\.json$/, '');
  const statusPath = `${dir}/_status.json`;
  let status = {};
  try {
    status = JSON.parse(await readFile(statusPath, 'utf8'));
  } catch {}
  const old = status[source] || {};
  const oldCinemas = Object.fromEntries(Object.entries(old.cinemas || {}).map(([name, value]) => [cinemaName(name), value]));
  const outcomes = Object.fromEntries(Object.entries(details.cinemas || {}).map(([name, value]) => [cinemaName(name), value]));
  const names = new Set([...Object.keys(oldCinemas), ...previous.map(r => cinemaName(r.cinema)),
    ...records.map(r => r.cinema), ...Object.keys(outcomes)]);
  const cinemas = {};
  for (const name of names) {
    const rows = records.filter(r => r.cinema === name);
    const before = oldCinemas[name];
    const outcome = outcomes[name] || { state: rows.length ? 'ok' : 'missing' };
    const sample = rows[0] || previous.find(r => cinemaName(r.cinema) === name);
    cinemas[name] = { area: sample?.area || before?.area || outcome.area || '', url: sample?.url || before?.url || outcome.url || '',
      count: rows.length, dates: [...new Set(rows.map(r => r.date))].sort(), attemptedAt: stamp,
      lastSuccessAt: outcome.state === 'ok' ? stamp : before?.lastSuccessAt || old.fetchedAt || null,
      ...outcome };
  }
  status[source] = { fetchedAt: stamp, count: records.length, parserVersion: details.parserVersion || 1, cinemas };
  await writeFile(statusPath + '.tmp', JSON.stringify(status, null, 1));
  await rename(statusPath + '.tmp', statusPath);
}

// 片名正規化：去掉尾端的分級括號與空白差異，讓跨影城同片能歸戶
export function normTitle(t) {
  return (t || '')
    .replace(/\((普|護|保護級|輔12級?|輔15級?|輔導級|限制級|限|PG-?\d*|R|G|P)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 跨影城同片歸戶用的比對鍵。各家片名寫法差很多：
//   「愛重奏」/「愛重奏.」/「愛重奏(2026重映)」
//   「Last Man－全盲搜查官－劇場版」/「LAST MAN 全盲搜查官 劇場版」/「Last Man ー 全盲搜查官 ー 劇場版」
// 重映／修復標示可以合併；剪輯、配音及作品年份必須保留，避免共用錯誤片長。
const VERSION_NOISE = /[（(【\[]?\s*(?:\d+\s*(?:週年|周年)?\s*)?(?:紀念)?(?:數位)?(?:經典)?(?:重映|重播|回歸大銀幕|\d?[kK]?\s*(?:數位)?修復(?:版)?)\s*[）)】\]]?/g;

export function versionSignature(title) {
  const clean = String(title || '').normalize('NFKC').replace(VERSION_NOISE, '').toLowerCase();
  return [...new Set(clean.match(/導演(?:剪輯)?版|導演剪輯|加長版|完整版|特別版|未刪減版|院線版|原版|國語|日語|英語|台語|粵語|韓語|配音|國配|真人版|動畫(?:版)?|字幕|\b(?:19|20)\d{2}\b|\bdirector['’]?s?\s*cut\b|\b(?:extended|uncut|theatrical)\s*(?:edition|version|cut)?\b/g) || [])].sort().join('|');
}

export function matchKey(t) {
  return (t || '')
    .normalize('NFKC')
    .replace(VERSION_NOISE, '')
    .replace(/[－ー–—‐\-_＿]/g, '')          // 破折號、連字號、底線
    .replace(/[.。．・‧·、,，:：!！?？'"'"&＆]/g, '') // 標點與連接符
    .replace(/[《》「」『』〈〉【】()[\]]/g, '') // 括號形式不影響身分，括號內版本文字保留
    .replace(/\s+/g, '')
    .toLowerCase()
    .trim();
}

// 片名裝飾剝除：各家會把「影廳規格」和「特別場名稱」塞進片名，造成同一部片被拆成好幾筆：
//   「DolbyCinema 藍色監獄(真人版)」「（DBOX特別場）蜘蛛人：重生日」
//   「蜘蛛人：重生日 經典美漫場」「【完售加開】《汪汪隊立大功：恐龍大電影》─ 親子限定場」
// 這些都該併回本片、把被剝下來的字串降級成場次標記。
// **語言／版本標記不剝**（國語版 vs 日語版是不同場，觀眾會買錯票）。
const FORMAT_RE = /^(?:DolbyCinema|DolbyVisionAtmos|DolbyAtmos|Dolby|DVA|MX4D-?3D|MX4D|4DX|SCREEN\s?X|SCREENX|IMAX|ULTRA\s?3D|ULTRA|LUXE|ATMOS|LG\s?LED(?:\s?Cinema)?|巨幕|大銀幕)\s*/i;
const EVENT_MARK_RE = /(?:場|音樂會|加開|特映|首映)$/;
const VERSION_MARK_RE = /國語|日語|英語|台語|粵語|韓語|配音|國配|真人版|動畫|字幕|導演|加長|完整|特別版|未刪減|院線版|原版|(?:19|20)\d{2}|director|extended|uncut|theatrical|\d\s?D$/i;

export function foldTitle(title, hasBase) {
  let t = (title || '').trim();
  const marks = [];
  for (let guard = 0; guard < 8; guard++) {
    const before = t;

    const fmt = t.match(FORMAT_RE);
    if (fmt) { marks.push(fmt[0].trim()); t = t.slice(fmt[0].length).trim(); }

    // 前綴括號：（DBOX特別場）、【完售加開】——版本標記除外
    const lead = t.match(/^[（(【\[]([^）)】\]]{1,14})[）)】\]]\s*/);
    if (lead && !VERSION_MARK_RE.test(lead[1])) { marks.push(lead[1]); t = t.slice(lead[0].length).trim(); }

    // 尾綴括號：只收看起來像「場次名稱」的
    const tail = t.match(/\s*[（(【\[]([^）)】\]]{1,14})[）)】\]]$/);
    if (tail && !VERSION_MARK_RE.test(tail[1]) && EVENT_MARK_RE.test(tail[1])) {
      marks.push(tail[1]); t = t.slice(0, t.length - tail[0].length).trim();
    }

    // 無括號的尾綴場次名：「… 經典美漫場」「… 親子音樂會」
    // 尾綴本身不可含收尾括號，否則會貪過頭把「…恐龍大電影》親子音樂會」整段當場次名
    const suf = t.match(/^(.{2,}?)[\s　─—–\-]*([^\s　》）】」]{2,12}(?:場|音樂會))$/);
    if (suf && !VERSION_MARK_RE.test(suf[2])) { marks.push(suf[2]); t = suf[1].trim(); }

    // 「電影歡樂冒險─《汪汪隊立大功：恐龍大電影》」這種把本片包在書名號裡的
    const quoted = t.match(/《([^》]{2,})》/);
    if (quoted && hasBase(quoted[1])) { t = quoted[1].trim(); }

    // 前綴影展名：「航海王映畫祭 航海王劇場版：機關城的鋼鐵巨兵」——本片整段就在裡面，
    // 剩下的又短，就當裝飾剝掉。版本標記（國語/真人版）不算裝飾，必須留著。
    // 要逐個切點試（單一 regex 只會回傳第一個匹配，未必是對的那個切法）。
    for (let cut = 2; cut <= 10 && cut < t.length - 5; cut++) {
      const head = t.slice(0, cut).trim();
      const rest = t.slice(cut).replace(/^[\s　─—–\-]+/, '').trim();
      if (rest.length >= 6 && hasBase(rest) && !VERSION_MARK_RE.test(head)) {
        marks.push(head); t = rest;
        break;
      }
    }

    t = t.replace(/^[《「【]+|[》」】]+$/g, '').replace(/^[─—–\-]\s*/, '').trim();
    if (t === before) break;
  }
  if (!t || t === title || matchKey(t).length < 2 || !hasBase(t)
      || versionSignature(t) !== versionSignature(title)) return null;
  return { base: t, marks: [...new Set(marks)].filter(Boolean) };
}

// 不再用任意「互相包含」配 metadata：續集、剪輯版和同名不同年份都可能被誤配。
// 只接受精確鍵，或已知存在的本片加上可辨識的場次裝飾。
export function resolveMovieKey(title, candidates) {
  const key = matchKey(normTitle(title));
  if (!key) return null;
  if (candidates.has(key)) return key;
  const folded = foldTitle(normTitle(title), (t) => candidates.has(matchKey(t)));
  return folded ? matchKey(folded.base) : null;
}

export function truncatedTitleKey(short, keys) {
  if (short.length < 8) return null;
  const matches = [...keys].filter((full) => full !== short && full.startsWith(short)
    && full.length - short.length <= 3
    && versionSignature(short) === versionSignature(full)
    && !/[0-9一二三四五六七八九十]|續集|[上下前後]集|序章|終章/.test(full.slice(short.length)));
  return matches.length === 1 ? matches[0] : null;
}

// 舊快取沒有記錄實際匹配的片名，無法證明版本相同；更新 metadata 後才重新採用。
export function trustedMovieMeta(title, record) {
  return [2, 3].includes(record?.matchVersion) && typeof record.matchedTitle === 'string'
    && resolveMovieKey(title, new Map([[matchKey(normTitle(record.matchedTitle)), record]])) !== null;
}

// **一律用台北時區算日期，不能用執行環境的本地時區。**
// 這裡踩過一次坑：原本用 getFullYear/getMonth 這種本地時間方法，在我的機器上（台北）
// 是對的，但 GitHub Actions 的 runner 是 UTC。排程的 22:00 UTC 那輪其實是台北隔天 06:00，
// 於是抓取器去要「8/21」的場次，build_site 卻依台北日期把 8/21 全判定成過期整批丟掉——
// 結果是抓到了 1677 筆威秀場次、網頁上一筆都沒有。
export function todayISO(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); // en-CA 給的就是 YYYY-MM-DD
}
