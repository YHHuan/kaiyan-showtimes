// 開眼電影網（atmovies.com.tw）：補洞來源，用來抓「其他來源涵蓋不到」的獨立／藝文／
// 二輪戲院場次（例如誠品電影院、光點台北：官網不是圖片就是 JS 動態渲染，curl 抓不到），
// 以及兩個完全沒有官方資料可用的連鎖：威秀／MUVIE（全站 Akamai 擋爬蟲，無頭瀏覽器也 403）、
// 新光（本機抓得到，但 GitHub Actions 雲端 IP 連 TCP 都被擋，10 次全逾時）。
//
// 開眼本身是 server-rendered HTML，好抓，但限制是場次頁只顯示「當天」，沒有日期參數可翻頁
// （實測 /showtime/{code}/a02/ 不吃 date query，也沒找到任何翻頁連結），所以本檔只產出今天一天。
//
// 已排除的重複來源：
//   - 光點華山電影館、府中15：已有 fetch/arthouse.mjs 直接抓官網（spot-hs.org.tw /
//     fuzhong15.ntpc.gov.tw），資料更完整（多天、真廳別），這裡刻意不重複收，避免同一場次
//     用不同 hall/tags 值在合併後被當成兩筆不同紀錄。
//   - 秀泰、國賓、美麗新/美麗華、喜樂時代、in89、樂聲：這些連鎖已有其他 fetch/*.mjs 涵蓋
//     官方資料，不用開眼補。
//   - 威秀／MUVIE：我們從來沒有官方資料，這裡無條件抓（見下方 VIESHOW）。
//   - 新光：官方來源（fetch/skcinemas.mjs）本機抓得到，只在它抓失敗／資料過期時才用開眼
//     頂替，避免同一館兩份不同命名/來源的資料重複上架（見下方 SKCINEMAS_BACKUP 與
//     shouldUseSkcinemasBackup()）。
//
// 編碼：伺服器回應 Content-Type: text/html;charset=UTF-8，且動態內容（片名/場次）本身
// 就是合法 UTF-8；只有頁面最上方少數寫死的 <meta name="author"/"copyright"> 樣板字串是舊站
// 遺留的亂碼（U+FFFD），跟場次資料無關，不影響解析。
import { readFile } from 'node:fs/promises';
import { politeFetch, saveRecords, normTitle, todayISO } from '../lib/common.mjs';

const BASE = 'https://www.atmovies.com.tw';

// 戲院代碼 → { 名稱, 縣市, 地區代碼 }
// 代碼怎麼來的：curl `${BASE}/showtime/`（找地區代碼 a01~a89 對照表）與各地區的
// `${BASE}/showtime/{regionCode}/`，解析 <ul id="theaterList"> 內
// <a href="/showtime/{code}/{regionCode}/">館名</a>（依 <li class="typeN">分區▼</li> 分組：
// 台北東區/西區/南區/北區、新北市、台北二輪）。地區代碼：a02=台北市＋新北市合併
// （實測 a01 是基隆，不是台北）、a03=桃園、a35=新竹、a04=台中、a06=台南、a07=高雄。
// 白名單只收「非九大連鎖」的獨立單館／二輪戲院，逐一查證經營者後才收錄（見各行註解），
// 且與 fetch/arthouse.mjs 互不重複。
const ARTHOUSE = {
  // -- 使用者指名／本任務起因：查「愛重奏」在誠品／光點查不到 --
  t02a08: { name: '誠品電影院', area: '台北市', region: 'a02', official: 'https://meet.eslite.com/tw/tc/gallery/movieschedule/201803020001' }, // 官網 arthouse.eslite.com 是舊式 ASP.NET WebForms，純 GET 抓不到場次時間
  t02d20: { name: '光點台北電影院', area: '台北市', region: 'a02', official: 'http://www.spot.org.tw/schedule/schedule_one.html' }, // 官網 spot.org.tw 場次表整月是一張 JPG 圖片，無文字

  // -- 使用者指名的其餘藝文館 --
  t02b07: { name: '真善美戲院', area: '台北市', region: 'a02', official: 'http://wonderful.movie.com.tw/time' }, // 官網 wonderful.movie.com.tw 場次靠 AJAX 動態載入，curl 拿不到時間
  t02e22: { name: '國家電影及視聽文化中心', area: '新北市', region: 'a02', official: 'https://www.tfai.org.tw/program/calendar' }, // 官網 tfai.org.tw 被 Cloudflare Managed Challenge 擋下（403）
  // 注意：TFAI 開眼頁面本身也只有一張場次看板圖（<div class="theaterboard"><img.../></div>），
  // 沒有逐場次文字，實測會是 0 筆——留在白名單是誠實反映「兩邊都抓不到」，不是漏解析。

  // -- 開眼「台北二輪▼」分區，範例即景美佳佳（使用者原話） --
  t02f05: { name: '景美佳佳戲院', area: '台北市', region: 'a02', official: 'https://reurl.cc/AL3Ej' },

  // -- 開眼台北/新北列表中其餘看起來獨立（非九大連鎖）的單館戲院 --
  // 逐一 WebSearch＋curl 查證經營者：均為獨立單館或僅 1~2 館的小型品牌，非威秀/秀泰/
  // 國賓/新光/美麗新/美麗華/喜樂時代/in89/樂聲任一連鎖旗下。其中多數官網其實也是
  // server-rendered（可另建 fetch/*.mjs 直接抓，資料會比開眼更完整），但目前本專案
  // 還沒有任何來源涵蓋它們，先用開眼補上「至少有今天」。
  t02a03: { name: '微風影城', area: '台北市', region: 'a02', official: 'https://breezecinemas.tixi.com.tw/' }, // 2022 起微風集團自營，非國賓/威秀旗下
  t02a05: { name: '總督影城', area: '台北市', region: 'a02', official: 'https://governor.tixi.com.tw/' }, // 獨立單館，總督影城事業股份有限公司
  t02a06: { name: '哈拉影城', area: '台北市', region: 'a02', official: 'http://halarcity.com.tw/browsing/Cinemas/Details/0000000001' }, // 哈拉生活集團，2008年起脫離秀泰代管，獨立經營
  t02c01: { name: '百老匯影城公館店', area: '台北市', region: 'a02', official: 'https://www.broadway-cineplex.com.tw/book.html?obj=Taipei' }, // 獨立品牌，僅公館+新竹竹北兩館；官網 Vue.js 動態渲染，curl 抓不到場次
  t02e03: { name: '新莊鴻金寶麻吉影城', area: '新北市', region: 'a02', official: 'http://machicinema.wordpress.com/' }, // 萬念福開發事業，附屬鴻金寶麻吉廣場的獨立單館
  t02e04: { name: '三重天台戲院', area: '新北市', region: 'a02', official: 'http://www.t-movies.com.tw/' }, // 天台廣場獨立單館
};

// 威秀影城（含 MUVIE CINEMAS）：全站有 Akamai 機器人防護，無頭瀏覽器也回 403，
// 完全沒有可用的官方端點，所以無條件抓（不像新光有官方來源可比對）。
// 代碼來自實測 curl `${BASE}/showtime/{a02,a03,a35,a04,a06,a07}/`，逐一比對
// <a href="/showtime/{code}/{region}/" onMouseOver="...戲院時間表">「網站」超連結
// 均指向 https://www.vscinemas.com.tw/，確認是威秀集團官方分館（MUVIE 亦屬同集團）。
// 開眼「嘉義」地區（a05）目前沒有威秀分館，故不列——依開眼實際列出的為準，不用猜的。
const VIESHOW = {
  t02a01: { name: '台北信義威秀', area: '台北市', region: 'a02', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t02a11: { name: 'MUVIE CINEMAS台北松仁威秀', area: '台北市', region: 'a02', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t02a12: { name: '台北南港LaLaport威秀影城', area: '台北市', region: 'a02', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t02b14: { name: '台北京站威秀', area: '台北市', region: 'a02', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t02b08: { name: '台北西門威秀影城', area: '台北市', region: 'a02', official: 'http://www.vscinemas.com.tw/ShowTimes/' },
  t02e07: { name: '板橋大遠百威秀影城', area: '新北市', region: 'a02', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t02e12: { name: '林口三井OUTLET威秀影城', area: '新北市', region: 'a02', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t02e20: { name: '中和環球威秀影城', area: '新北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsweb/theater/detail.aspx?id=25' },
  t02e21: { name: '新店裕隆城威秀影城', area: '新北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsweb/theater/detail.aspx?id=28' },
  t03308: { name: '桃園統領威秀影城', area: '桃園市', region: 'a03', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t03317: { name: '桃園桃知道威秀影城', area: '桃園市', region: 'a03', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t03505: { name: '新竹大遠百威秀影城', area: '新竹市', region: 'a35', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t03508: { name: '新竹巨城威秀影城', area: '新竹市', region: 'a35', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t04402: { name: '台中老虎城威秀', area: '台中市', region: 'a04', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t04407: { name: '台中大遠百威秀影城', area: '台中市', region: 'a04', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t04409: { name: '台中iFG遠雄廣場威秀影城', area: '台中市', region: 'a04', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t06609: { name: '台南大遠百威秀影城', area: '台南市', region: 'a06', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t06610: { name: '台南南紡威秀影城', area: '台南市', region: 'a06', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t06611: { name: '台南FOCUS威秀影城', area: '台南市', region: 'a06', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
  t07703: { name: '高雄大遠百威秀影城', area: '高雄市', region: 'a07', official: 'https://www.vscinemas.com.tw/ShowTimes/' },
};

// 新光影城（skcinemas.com，5 館）：官方來源 fetch/skcinemas.mjs 本機抓得到，但雲端 CI
// 連不上（見檔頭說明），只在官方來源缺席／過期時才用這份開眼備援頂替，見
// shouldUseSkcinemasBackup()。代碼查證方式同 VIESHOW：curl 對應地區頁，確認每一筆的
// 「網站」超連結都指向 https://www.skcinemas.com/sessions（與 fetch/skcinemas.mjs 抓的
// 官方站同一個網域），且地址與 skcinemas.mjs 裡的館名一一對應（西寧南路＝台北獅子林、
// 忠誠路＝台北天母、中壢區春德路＝桃園青埔【行政區屬中壢區】、中港路＝台中中港、
// 西門路＝台南西門）。名稱刻意沿用開眼頁面上的原始館名（未加「獅子林/中港/西門」等
// 分館別名），避免看起來像杜撰資訊。
const SKCINEMAS_BACKUP = {
  t02b05: { name: '台北新光影城', area: '台北市', region: 'a02', official: 'https://www.skcinemas.com/sessions' },
  t02d04: { name: '台北天母新光影城', area: '台北市', region: 'a02', official: 'https://www.skcinemas.com/sessions?c=1005' },
  t03315: { name: '桃園新光影城', area: '桃園市', region: 'a03', official: 'https://www.skcinemas.com/sessions' },
  t04401: { name: '台中新光影城', area: '台中市', region: 'a04', official: 'https://www.skcinemas.com/sessions' },
  t06607: { name: '台南新光影城', area: '台南市', region: 'a06', official: 'https://www.skcinemas.com/sessions' },
};

// 新光要不要啟用開眼備援：讀 data/_status.json，沒有 skcinemas 這個鍵，或它的
// fetchedAt 距今超過 26 小時，就視為「官方抓取失敗／過期」，啟用備援；否則跳過
// （官方資料還新鮮，不要讓同一館出現兩份來源、命名都不同的重複紀錄）。
async function shouldUseSkcinemasBackup() {
  const statusPath = new URL('../data/_status.json', import.meta.url).pathname;
  let status;
  try {
    status = JSON.parse(await readFile(statusPath, 'utf8'));
  } catch {
    return true; // 讀不到狀態檔，視同官方來源缺席
  }
  const sk = status.skcinemas;
  if (!sk?.fetchedAt) return true;
  // 光看時間戳不夠：抓取失敗時仍會寫入一筆 count 為 0、時間卻很新的狀態，
  // 只檢查新鮮度會誤以為官方資料好好的，備援因此不啟動（CI 上實際發生過）。
  if (!(sk.count > 300)) return true;
  const ageHours = (Date.now() - new Date(sk.fetchedAt).getTime()) / 3600000;
  return !(ageHours <= 26);
}

const CINEMAS = { ...ARTHOUSE, ...VIESHOW };
if (await shouldUseSkcinemasBackup()) {
  Object.assign(CINEMAS, SKCINEMAS_BACKUP);
  console.log('  [新光] 官方來源缺席、過期或抓取失敗，啟用開眼備援');
} else {
  console.log('  [新光] 官方來源新鮮，略過開眼備援，避免重複');
}

// 分級圖示代碼 → 中文級別。開眼用 <img src="/images/cer_X.gif"> 標示分級，沒有 alt 文字，
// 對照台灣現行五級分級制度（普遍/保護/輔12/輔15/限制）逐一實測比對出來。
const CERT = { G: '普遍級', P: '保護級', F2: '輔12級', F5: '輔15級', R: '限制級' };

const date = todayISO(); // 開眼場次頁沒有日期參數可翻頁，只能拿到「今天」
const records = [];

for (const [code, { name, area, region, official }] of Object.entries(CINEMAS)) {
  const url = `${BASE}/showtime/${code}/${region}/`;
  // 連結優先給該戲院自己的場次/訂票頁——開眼是我們的資料來源，但使用者要買票得回官網。
  // official 取自開眼戲院頁上的「網站:」欄位。
  const linkUrl = official || url;
  let html;
  try {
    html = await politeFetch(url);
  } catch (e) {
    console.log(`  ${name}: ${e.message}`);
    continue;
  }

  let count = 0;
  // 每部片一個 <ul id="theaterShowtimeTable"> 區塊
  for (const rawBlock of html.split('<ul id="theaterShowtimeTable">').slice(1)) {
    // 只取到本片區塊結束（<!-- theaterShowtimeBlock ... -->），避免最後一部片的區塊
    // 一路吃到頁尾側欄（快速選單/廣告），裡面文字剛好也可能長得像 HH：MM
    const block = rawBlock.split('<!-- theaterShowtimeBlock')[0];

    // 片名錨點常缺 </a> 收尾（開眼原始碼本身如此，如「魯冰花(數位修復版)</li>」），
    // 用 [^<] 吃到下一個 < 就好，不管後面接的是 </a> 還是 </li>
    const titleM = block.match(/<li class="filmTitle">\s*(?:<img[^>]*>\s*)?<a href="\/movie\/\w+\/">([^<]*)/);
    if (!titleM) continue;

    // 片名尾端的 (數位修復版)(影展) 這類版本標記，逐一剝出來放進 tags
    let rawTitle = titleM[1].trim();
    const tags = [];
    let m;
    while ((m = rawTitle.match(/\(([^()]*)\)\s*$/))) {
      tags.unshift(m[1]);
      rawTitle = rawTitle.slice(0, m.index).trim();
    }
    const movie = normTitle(rawTitle);
    if (!movie) continue;

    const certM = block.match(/cer_(\w+)\.gif/);
    const rating = certM ? CERT[certM[1]] || certM[1] : null;

    // 場次時間是全形冒號 HH：MM（不是 ASCII 的 :），開眼原始碼就是這樣寫的
    for (const t of block.matchAll(/<li>(\d{1,2})：(\d{2})<\/li>/g)) {
      records.push({
        source: 'atmovies',
        cinema: name,
        area,
        movie,
        rating,
        date,
        time: `${t[1].padStart(2, '0')}:${t[2]}`,
        hall: null, // 開眼這些館的場次頁沒有標廳別
        tags,
        url: linkUrl,
      });
      count++;
    }
  }
  console.log(`  ${name}: ${count} 筆`);
}

await saveRecords(new URL('../data/atmovies.json', import.meta.url).pathname, records);
