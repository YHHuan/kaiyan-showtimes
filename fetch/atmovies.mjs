// 開眼電影網（atmovies.com.tw）：補洞來源，用來抓「其他來源涵蓋不到」的獨立／藝文／
// 二輪戲院場次（例如誠品電影院、光點台北：官網不是圖片就是 JS 動態渲染，curl 抓不到）。
//
// 開眼本身是 server-rendered HTML，好抓，但限制是場次頁只顯示「當天」，沒有日期參數可翻頁
// （實測 /showtime/{code}/a02/ 不吃 date query，也沒找到任何翻頁連結），所以本檔只產出今天一天。
//
// 已排除的重複來源：
//   - 光點華山電影館、府中15：已有 fetch/arthouse.mjs 直接抓官網（spot-hs.org.tw /
//     fuzhong15.ntpc.gov.tw），資料更完整（多天、真廳別），這裡刻意不重複收，避免同一場次
//     用不同 hall/tags 值在合併後被當成兩筆不同紀錄。
//   - 威秀、MUVIE、秀泰、國賓、新光、美麗新/美麗華、喜樂時代、in89、樂聲：這些連鎖已有
//     其他 fetch/*.mjs 涵蓋，或官網本身好抓值得另外處理，不用開眼補。
//
// 編碼：伺服器回應 Content-Type: text/html;charset=UTF-8，且動態內容（片名/場次）本身
// 就是合法 UTF-8；只有頁面最上方少數寫死的 <meta name="author"/"copyright"> 樣板字串是舊站
// 遺留的亂碼（U+FFFD），跟場次資料無關，不影響解析。
import { politeFetch, saveRecords, normTitle, todayISO } from '../lib/common.mjs';

const BASE = 'https://www.atmovies.com.tw';
const REGION = 'a02'; // 開眼把台北市＋新北市合併在同一個地區代碼下（實測 a01 是基隆，不是台北）

// 戲院代碼 → { 名稱, 縣市 }
// 代碼怎麼來的：curl `${BASE}/showtime/a02/`，解析 <ul id="theaterList"> 內
// <a href="/showtime/{code}/a02/">館名</a>（依 <li class="typeN">分區▼</li> 分組：
// 台北東區/西區/南區/北區、新北市、台北二輪）。白名單只收「非九大連鎖」的獨立單館／
// 二輪戲院，逐一查證經營者後才收錄（見各行註解），且與 fetch/arthouse.mjs 互不重複。
const CINEMAS = {
  // -- 使用者指名／本任務起因：查「愛重奏」在誠品／光點查不到 --
  t02a08: { name: '誠品電影院', area: '台北市' }, // 官網 arthouse.eslite.com 是舊式 ASP.NET WebForms，純 GET 抓不到場次時間
  t02d20: { name: '光點台北電影院', area: '台北市' }, // 官網 spot.org.tw 場次表整月是一張 JPG 圖片，無文字

  // -- 使用者指名的其餘藝文館 --
  t02b07: { name: '真善美戲院', area: '台北市' }, // 官網 wonderful.movie.com.tw 場次靠 AJAX 動態載入，curl 拿不到時間
  t02e22: { name: '國家電影及視聽文化中心', area: '新北市' }, // 官網 tfai.org.tw 被 Cloudflare Managed Challenge 擋下（403）
  // 注意：TFAI 開眼頁面本身也只有一張場次看板圖（<div class="theaterboard"><img.../></div>），
  // 沒有逐場次文字，實測會是 0 筆——留在白名單是誠實反映「兩邊都抓不到」，不是漏解析。

  // -- 開眼「台北二輪▼」分區，範例即景美佳佳（使用者原話） --
  t02f05: { name: '景美佳佳戲院', area: '台北市' },

  // -- 開眼台北/新北列表中其餘看起來獨立（非九大連鎖）的單館戲院 --
  // 逐一 WebSearch＋curl 查證經營者：均為獨立單館或僅 1~2 館的小型品牌，非威秀/秀泰/
  // 國賓/新光/美麗新/美麗華/喜樂時代/in89/樂聲任一連鎖旗下。其中多數官網其實也是
  // server-rendered（可另建 fetch/*.mjs 直接抓，資料會比開眼更完整），但目前本專案
  // 還沒有任何來源涵蓋它們，先用開眼補上「至少有今天」。
  t02a03: { name: '微風影城', area: '台北市' }, // 2022 起微風集團自營，非國賓/威秀旗下
  t02a05: { name: '總督影城', area: '台北市' }, // 獨立單館，總督影城事業股份有限公司
  t02a06: { name: '哈拉影城', area: '台北市' }, // 哈拉生活集團，2008年起脫離秀泰代管，獨立經營
  t02c01: { name: '百老匯影城公館店', area: '台北市' }, // 獨立品牌，僅公館+新竹竹北兩館；官網 Vue.js 動態渲染，curl 抓不到場次
  t02e03: { name: '新莊鴻金寶麻吉影城', area: '新北市' }, // 萬念福開發事業，附屬鴻金寶麻吉廣場的獨立單館
  t02e04: { name: '三重天台戲院', area: '新北市' }, // 天台廣場獨立單館
};

// 分級圖示代碼 → 中文級別。開眼用 <img src="/images/cer_X.gif"> 標示分級，沒有 alt 文字，
// 對照台灣現行五級分級制度（普遍/保護/輔12/輔15/限制）逐一實測比對出來。
const CERT = { G: '普遍級', P: '保護級', F2: '輔12級', F5: '輔15級', R: '限制級' };

const date = todayISO(); // 開眼場次頁沒有日期參數可翻頁，只能拿到「今天」
const records = [];

for (const [code, { name, area }] of Object.entries(CINEMAS)) {
  const url = `${BASE}/showtime/${code}/${REGION}/`;
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
        url,
      });
      count++;
    }
  }
  console.log(`  ${name}: ${count} 筆`);
}

await saveRecords(new URL('../data/atmovies.json', import.meta.url).pathname, records);
