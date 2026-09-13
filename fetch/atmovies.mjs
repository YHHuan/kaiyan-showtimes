// 開眼電影網（atmovies.com.tw）：補洞來源，用來抓「其他來源涵蓋不到」的獨立／藝文／
// 二輪戲院場次（例如誠品電影院、光點台北：官網不是圖片就是 JS 動態渲染，curl 抓不到），
// 以及官方站無法從 GitHub runner 穩定取得的來源：威秀／MUVIE（全站 Akamai 擋爬蟲，無頭瀏覽器也 403）、
// 新光（本機抓得到，但 GitHub Actions 雲端 IP 連 TCP 都被擋，10 次全逾時）、
// 美麗新（官方站會拒絕 GitHub Actions 雲端 IP），以及王牌映画（官網只接受部分
// 網路區域，GitHub runner 與公開雲端代理皆連線失敗）。
//
// 開眼現已提供 /YYYYMMDD/ 日期連結；循實際公布的日期抓取，不猜測尚未公布的檔期。
//
// 已排除的重複來源：
//   - 光點華山電影館、府中15：已有 fetch/arthouse.mjs 直接抓官網（spot-hs.org.tw /
//     fuzhong15.ntpc.gov.tw），資料更完整（多天、真廳別），這裡刻意不重複收，避免同一場次
//     用不同 hall/tags 值在合併後被當成兩筆不同紀錄。
//   - 秀泰、國賓、美麗華、喜樂時代、in89、樂聲：這些連鎖已有其他 fetch/*.mjs 涵蓋
//     官方資料，不用開眼補。
//   - 威秀／MUVIE：我們從來沒有官方資料，這裡無條件抓（見下方 VIESHOW）。
//   - 新光、美麗新、王牌：官方與備援都抓取，建站逐館逐日選用（lib/cinema-coverage.mjs），
//     避免同一館兩份不同命名/來源的資料重複上架，也避免全來源總量掩蓋單館缺漏。
//
// 編碼：伺服器回應 Content-Type: text/html;charset=UTF-8，且動態內容（片名/場次）本身
// 就是合法 UTF-8；只有頁面最上方少數寫死的 <meta name="author"/"copyright"> 樣板字串是舊站
// 遺留的亂碼（U+FFFD），跟場次資料無關，不影響解析。
import { readFile } from 'node:fs/promises';
import { politeFetch, saveRecords, todayISO } from '../lib/common.mjs';
import { parseAtmovies } from '../lib/schedule-parsers.mjs';
import { SK_CINEMAS } from '../lib/cinema-coverage.mjs';

const BASE = 'https://www.atmovies.com.tw';

// 戲院代碼 → { 名稱, 縣市, 地區代碼 }
// 代碼怎麼來的：curl `${BASE}/showtime/`（找地區代碼 a01~a89 對照表）與各地區的
// `${BASE}/showtime/{regionCode}/`，解析 <ul id="theaterList"> 內
// <a href="/showtime/{code}/{regionCode}/">館名</a>（依 <li class="typeN">分區▼</li> 分組：
// 台北東區/西區/南區/北區、新北市、台北二輪）。地區代碼：a02=台北市＋新北市合併
// （實測 a01 是基隆，不是台北）、a03=桃園、a35=新竹、a04=台中、a06=台南、a07=高雄。
// 白名單只收「非九大連鎖」的獨立單館／二輪戲院，逐一查證經營者後才收錄（見各行註解），
// 且與 fetch/arthouse.mjs 互不重複。
// 光點台北、真善美、TFAI 已由 fetch/arthouse2.mjs 抓官方／售票來源，
// 從這裡移除避免同一場次兩個來源、標籤不一致時冒出重複。
const ARTHOUSE = {
  // -- 使用者指名／本任務起因：查「愛重奏」在誠品／光點查不到 --
  t02a08: { name: '誠品電影院', area: '台北市', region: 'a02', official: 'https://meet.eslite.com/tw/tc/gallery/movieschedule/201803020001' }, // 官網 arthouse.eslite.com 是舊式 ASP.NET WebForms，純 GET 抓不到場次時間

  // -- 使用者指名的其餘藝文館 --
  // 注意：TFAI 開眼頁面本身也只有一張場次看板圖（<div class="theaterboard"><img.../></div>），
  // 沒有逐場次文字，實測會是 0 筆——留在白名單是誠實反映「兩邊都抓不到」，不是漏解析。

  // -- 開眼「台北二輪▼」分區，範例即景美佳佳（使用者原話） --
  t02f05: { name: '景美佳佳戲院', area: '台北市', region: 'a02', official: 'https://reurl.cc/AL3Ej' },

  // -- 開眼台北/新北列表中其餘看起來獨立（非九大連鎖）的單館戲院 --
  // 逐一 WebSearch＋curl 查證經營者：均為獨立單館或僅 1~2 館的小型品牌，非威秀/秀泰/
  // 國賓/新光/美麗新/美麗華/喜樂時代/in89/樂聲任一連鎖旗下。其中多數官網其實也是
  // server-rendered（可另建 fetch/*.mjs 直接抓，資料會比開眼更完整），但目前本專案
  // 還沒有其他來源涵蓋它們，使用開眼已公布的多日資料。
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
// official 用的是「線上訂票系統」而不是「場次查詢」——使用者回報點場次查詢進去
// 還要再選一次。威秀官網導覽列自己同時有這兩個連結，我們原本取到的是查詢那個。
// 該站有 Akamai 擋爬，網址是從 Wayback 存檔（2026-08-21 首頁、2026-06-11 訂票頁）
// 查證的：頁面標題「威秀影城線上訂票系統」、含 22 家分館的選單。
const VIESHOW = {
  t02a01: { name: '台北信義威秀', area: '台北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t02a11: { name: 'MUVIE CINEMAS台北松仁威秀', area: '台北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t02a12: { name: '台北南港LaLaport威秀影城', area: '台北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t02b14: { name: '台北京站威秀', area: '台北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t02b08: { name: '台北西門威秀影城', area: '台北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t02e07: { name: '板橋大遠百威秀影城', area: '新北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t02e12: { name: '林口三井OUTLET威秀影城', area: '新北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t02e20: { name: '中和環球威秀影城', area: '新北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t02e21: { name: '新店裕隆城威秀影城', area: '新北市', region: 'a02', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t03308: { name: '桃園統領威秀影城', area: '桃園市', region: 'a03', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t03317: { name: '桃園桃知道威秀影城', area: '桃園市', region: 'a03', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t03505: { name: '新竹大遠百威秀影城', area: '新竹市', region: 'a35', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t03508: { name: '新竹巨城威秀影城', area: '新竹市', region: 'a35', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t04402: { name: '台中老虎城威秀', area: '台中市', region: 'a04', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t04407: { name: '台中大遠百威秀影城', area: '台中市', region: 'a04', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t04409: { name: '台中iFG遠雄廣場威秀影城', area: '台中市', region: 'a04', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t06609: { name: '台南大遠百威秀影城', area: '台南市', region: 'a06', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t06610: { name: '台南南紡威秀影城', area: '台南市', region: 'a06', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t06611: { name: '台南FOCUS威秀影城', area: '台南市', region: 'a06', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
  t07703: { name: '高雄大遠百威秀影城', area: '高雄市', region: 'a07', official: 'https://www.vscinemas.com.tw/vsTicketing/ticketing/ticket.aspx' },
};

// 新光影城（skcinemas.com，5 館）：官方來源 fetch/skcinemas.mjs 本機抓得到，但雲端 CI
// 曾連不上（見檔頭說明），建站依分館與日期決定是否以開眼備援頂替。
// 代碼查證方式同 VIESHOW：curl 對應地區頁，確認每一筆的
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

// 美麗新官方來源在本機可取得多天資料，但 GitHub Actions 雲端 IP 偶爾會收到 403。
// 代碼來自開眼台北、桃園地區頁；名稱刻意和 fetch/miranew.mjs 一致，讓收藏與篩選穩定。
const MIRANEW_BACKUP = {
  t02d06: { name: '台北大直美麗新皇家影城', area: '台北市', region: 'a02', official: 'https://www.miranewcinemas.com/booking/timetable' },
  t03301: { name: '桃園台茂美麗新影城', area: '桃園市', region: 'a03', official: 'https://www.miranewcinemas.com/booking/timetable' },
};

// 王牌官方頁是第一來源；若 GitHub Actions 所在的海外網路連不上，就用開眼的多日場次
// 補上。t04428 由開眼台中地區清單與官網地址、館名交叉核對。
const ACECINEMA_BACKUP = {
  t04428: { name: '王牌映画影城', area: '台中市', region: 'a04', official: 'https://www.acecinema.com.tw/movie/all' },
};


const CINEMAS = { ...ARTHOUSE, ...VIESHOW, ...SKCINEMAS_BACKUP, ...MIRANEW_BACKUP, ...ACECINEMA_BACKUP };
// 官方與備援都保留，建站逐館逐日選新鮮官方優先；不能因其他分館總筆數夠多就略過漏館。
for (const c of Object.values(CINEMAS)) {
  const sk = SK_CINEMAS.find(x => x.name === c.name);
  if (sk) c.official = 'https://www.skcinemas.com/Sessions/Sessions?cinemaId=' + sk.id;
}
const path = new URL('../data/atmovies.json', import.meta.url).pathname;
let previous = [], status = {};
try { previous = JSON.parse(await readFile(path, 'utf8')); } catch {}
try { status = JSON.parse(await readFile(new URL('../data/_status.json', import.meta.url), 'utf8')); } catch {}
const today = todayISO(), records = [], cinemas = {};
const retain = (name, date) => previous.filter(r => r.cinema === name && r.date >= today && (!date || r.date === date))
  .map(r => ({ ...r, fetchedAt: r.fetchedAt || status.atmovies?.fetchedAt || '1970-01-01T00:00:00Z' }));
for (const [code, config] of Object.entries(CINEMAS)) {
  const rootUrl = BASE + '/showtime/' + code + '/' + config.region + '/';
  const configWithCode = { ...config, code, expectedDate: today };
  let first;
  try {
    const html = await politeFetch(rootUrl);
    try { first = parseAtmovies(html, configWithCode); }
    catch (e) {
      // 午夜時根頁快取可能仍是昨天；明確日期頁仍須通過頁面日期檢查。
      if (!e.message.includes('場次日期不符')) throw e;
      first = parseAtmovies(await politeFetch(rootUrl + today.replace(/-/g, '') + '/'), configWithCode);
    }
  } catch (e) {
    cinemas[config.name] = { state: 'failed', area: config.area, url: config.official, error: e.message };
    records.push(...retain(config.name));
    console.log('  ' + config.name + ': 抓取失敗，保留尚未過期資料；' + e.message);
    continue;
  }
  const failedDates = [], fresh = [];
  for (const date of first.dates) {
    if (date < today) continue;
    try {
      const parsed = date === today ? first : parseAtmovies(
        await politeFetch(rootUrl + date.replace(/-/g, '') + '/'), { ...configWithCode, expectedDate: date });
      fresh.push(...parsed.records.map(r => ({ ...r, fetchedAt: new Date().toISOString() })));
    } catch (e) {
      failedDates.push(date);
      records.push(...retain(config.name, date));
      console.log('  ' + config.name + ' ' + date + ': ' + e.message);
    }
  }
  records.push(...fresh);
  cinemas[config.name] = { state: failedDates.length ? 'partial' : 'ok', area: config.area, url: config.official,
    announcedDates: first.dates, failedDates, ...(fresh.length ? { lastSuccessAt: new Date().toISOString() } : {}) };
  console.log('  ' + config.name + ': ' + fresh.length + ' 筆 / ' + new Set(fresh.map(r => r.date)).size + ' 天'
    + (failedDates.length ? '；' + failedDates.length + ' 天取得失敗' : ''));
}
await saveRecords(path, records, { cinemas, parserVersion: 2 });
