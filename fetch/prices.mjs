// 各院線官方票價。唯讀 GET，用 lib/common.mjs 的 politeFetch 限速（固定 UA、間隔、重試一次）。
//
// 只收「一般公開牌價」：全票／優待票／早場票／愛心票這類任何人現場或線上都能直接買到的價格。
// 信用卡優惠、會員價／儲值價、套票（雙人套票、爆米花組合餐等）一律不收——規則複雜、常變、
// 效期短，維護成本遠高於價值，收了還容易讓使用者誤以為那是隨到隨買的價格。
//
// 涵蓋範圍（可自動重抓，逐次執行都會打官網重新解析）：
//   秀泰（15 館）—— 官方 bootstrap API，每館各自的 meta.ticketTypes。
//   樂聲影城(西門町)（1 館）—— 官方票價頁是乾淨的 HTML table。
//   美麗新 大直皇家影城（1 館）—— miramarcinemas.tw 官方票價頁是乾淨的 HTML table。
//     這個網域用的是「美麗華影城」舊品牌名，但實測 /Movie/Index?type=now 有 2026-08 的
//     現正熱映清單，是持續在維護的現役官網，不是停用的舊快照。
//
// 涵蓋範圍（票價表本身是一張圖片，沒有 OCR 工具可用，無法逐次自動解析）：
//   美麗新 台茂美麗新影城（1 館）、喜樂時代影城（4 館）—— 下面用常數硬編碼，
//   是人工開瀏覽器讀圖轉譯的結果，每筆都附了來源頁與來源圖片網址；之後要覆核/更新
//   只能重新人工讀一次圖，這支程式沒辦法自動驗證這幾筆有沒有過期。
//
// 試過但找不到公開票價表、誠實放棄的：
//   國賓 www.ambassador.com.tw —— 找過首頁導覽、/home/GroupTicket、/home/MemberContract、
//     /home/NewsList、booking 子網域的訂票 FAQ 頁（service-instruction.html，內容是退換票/
//     取票規則，沒有票價）、Wayback Machine 上舊的 theater_intro_a2/a5/b1 等頁（現在都回
//     ASP.NET 的「處理您的要求時發生錯誤」頁，代表已停用）。找不到任何一頁列出全票/優待票
//     金額，這家看起來沒有把牌價放上官網，只在現場售票口公告。
//   in89 www.in89cinemax.com —— 頁面是 Vue 動態渲染，curl／WebFetch 都只拿到未渲染的樣板殼
//     （例如常見問題頁看到的是還沒替換的 {{ls.question_title}}/{{ls.question_detail}}）。
//     跟 fetch/in89.mjs 開頭註解講的原因一樣：這站沒有無頭瀏覽器就讀不到內容，而這次任務
//     明確不准用 playwright，所以整個 in89 跳過。
//   新光 www.skcinemas.com —— Next.js 頁面同樣是空殼，實際票價要靠帶簽章 token 的內部 API，
//     跟 fetch/skcinemas.mjs 裡 GetSessionByCinemasIDForApp 需要前端 JS 算 token 是同一個
//     問題，純 curl 拿不到，一樣需要無頭瀏覽器，任務說明也預期這家可能抓不到。

import { politeFetch } from '../lib/common.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const OUT_PATH = new URL('../data/prices.json', import.meta.url).pathname;
const fetchedAt = new Date().toISOString();
const prices = {};

function setCinema(name, entry) {
  prices[name] = entry;
}

// ---------------- 秀泰（15 館，官方 bootstrap API） ----------------
async function fetchShowtimes() {
  const { payload } = await politeFetch('https://capi.showtimes.com.tw/4/app/bootstrap', { asJson: true });
  let n = 0;
  for (const corp of payload.corporations || []) {
    const ticketTypes = corp.meta?.ticketTypes;
    if (!ticketTypes?.length) continue;
    // 「丹普廳 (單人套票)」「(雙人套票)」這類是套票，不收
    const tiers = ticketTypes
      .filter((tt) => !/套票/.test(tt.format))
      .map((tt) => ({ format: tt.format, prices: Object.fromEntries(tt.prices.map((p) => [p.t, p.p])) }));
    if (!tiers.length) continue;
    setCinema(corp.name, {
      source: '官方',
      url: 'https://www.showtimes.com.tw/ticketing',
      updatedAt: fetchedAt,
      tiers,
    });
    n++;
  }
  console.log(`秀泰：${n} 館`);
}

// ---------------- 樂聲影城(西門町)（1 館，官方 HTML table） ----------------
async function fetchLux() {
  const url = 'https://www.luxcinema.com.tw/web/2020_ticket_types';
  const html = await politeFetch(url);
  // 頁面「一般票種」區塊到「套票套餐」區塊之間，是巨幕廳／一般廳兩欄 x 早場/全票/優待/愛心四列
  const section = html.split('套票套餐')[0].split('一般票種')[1] || '';
  const rows = [];
  for (const block of section.split('class="row money_row"').slice(1)) {
    const labelM = block.match(/t_s">\s*([^<]+?)\s*(?:<br|<\/div)/);
    const nums = [...block.matchAll(/price_no[^>]*><b>\$<\/b>(\d+)/g)].map((m) => Number(m[1]));
    const noteM = block.match(/one_bottom_left[^>]*>([^<]+)</);
    if (!labelM || nums.length < 2) continue;
    rows.push({ label: labelM[1].trim(), xl: nums[0], general: nums[1], note: noteM?.[1].trim() });
  }
  if (rows.length < 4) throw new Error(`樂聲票價表結構可能改了，只解到 ${rows.length} 列（預期至少 4：早場/全票/優待/愛心）`);
  const byHall = (key) => Object.fromEntries(rows.map((r) => [r.label, r[key]]));
  const noteText = rows.find((r) => r.note)?.note;
  setCinema('樂聲影城(西門町)', {
    source: '官方',
    url,
    updatedAt: fetchedAt,
    tiers: [
      { format: '巨幕廳', prices: byHall('xl') },
      { format: '一般廳', prices: byHall('general') },
    ],
    ...(noteText ? { note: `優待票/愛心票：${noteText}` } : {}),
  });
  console.log('樂聲：1 館');
}

// ---------------- 美麗新 大直皇家影城（1 館，官方 HTML table） ----------------
async function fetchMiranewDazhi() {
  const url = 'https://www.miramarcinemas.tw/Home/dazhiprice';
  const html = await politeFetch(url);
  const tableM = html.match(/<h6>[\s\S]*?票價表[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/);
  if (!tableM) throw new Error('大直皇家票價表結構可能改了，找不到 <table>');
  const num = (s) => {
    const m = s.match(/\d+/);
    return m ? Number(m[0]) : null;
  };
  const tiers = [];
  for (const tr of tableM[1].split(/<tr>/).slice(1)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    if (tds.length < 4) continue;
    const [mode, early, adult, concession] = tds;
    const p = {};
    if (num(early) != null) p['早場票'] = num(early);
    if (num(adult) != null) p['全票'] = num(adult);
    if (num(concession) != null) p['優待票'] = num(concession);
    if (Object.keys(p).length) tiers.push({ format: mode, prices: p });
  }
  if (!tiers.length) throw new Error('大直皇家票價表解到 0 列');
  setCinema('台北大直美麗新皇家影城', {
    source: '官方',
    url,
    updatedAt: fetchedAt,
    tiers,
    note:
      '早場票適用時間：06:00–12:00前；全票/優待票適用時間：12:01–翌日05:59前。' +
      '片長超過2小時30分鐘加收20元，之後每30分鐘再加10元；HFR版加價10元。' +
      '愛心票/敬老票為全票半價，須本人現場出示證件購買，官網未列出固定金額，故未併入上表。',
  });
  console.log('美麗新 大直皇家：1 館');
}

// ---------------- 美麗新 台茂、喜樂時代：票價表是圖片，人工讀圖轉譯後硬編碼 ----------------
// 這幾筆無法用文字解析，數字是人工開瀏覽器讀官方票價圖片轉譯（讀圖時間見 updatedAt）。
// url 是圖片所在的官方頁面；imageUrl 是圖片本身，方便之後覆核直接對照。
function addImageSourcedPrices() {
  setCinema('桃園台茂美麗新影城', {
    source: '官方（票價表為圖片，人工讀圖轉譯，非本程式自動解析）',
    url: 'https://www.miranewcinemas.com/Booking/TaimallPrice',
    imageUrl: 'https://www.miranewcinemas.com/Content/img/TicketPrice/Taimall/img_price_tm-1.jpg',
    updatedAt: fetchedAt,
    tiers: [
      { format: '標準廳 2D', prices: { 早場票: 280, 全票: 330, 優待票: 310, 愛心票: 165 } },
      { format: '標準廳 3D', prices: { 早場票: 350, 全票: 400, 優待票: 380, 愛心票: 200 } },
      { format: 'IMAX巨型銀幕版 2D', prices: { 全票: 430, 優待票: 410, 愛心票: 215 } },
      { format: 'IMAX巨型銀幕版 3D', prices: { 全票: 500, 優待票: 480, 愛心票: 250 } },
    ],
    note:
      '優待票=學生/孩童/軍警，愛心票=愛心/敬老，購票請主動出示證件。' +
      '早場票適用時間：06:00–12:00前；全票/優待票適用時間：12:01–翌日05:59前。' +
      '片長超過2小時30分鐘依比例加價，加價比例以官網公告為準。IMAX巨型銀幕版無早場票。' +
      '另有「儲值優惠票」（會員價）與 PINK SOFA 雙人套票，本表不收。',
  });

  // 喜樂時代影城 4 館：官方每館票價頁都是圖片，只收「非會員」列（儲值會員/一般會員=會員價，
  // 喜樂床座=套票，皆不收）。早場票條件原文為「12:00前場次」。
  const century = [
    {
      name: '喜樂時代影城 今日店',
      url: 'https://ximen.centuryasia.com.tw/Ticket_Value.aspx',
      imageUrl: 'https://ximen.centuryasia.com.tw/img/%E7%A5%A8%E5%83%B9%E7%89%88%E4%BD%8Ds_%E5%B7%A5%E4%BD%9C%E5%8D%80%E5%9F%9F%201.png',
      p2d: { 早場票: 250, 全票: 310, 優待票: 280, 愛心票: 155 },
      p3d: { 早場票: 280, 全票: 340, 優待票: 310, 愛心票: 170 },
    },
    {
      name: '喜樂時代影城 永和店',
      url: 'https://beyond.centuryasia.com.tw/Ticket_Value.aspx',
      imageUrl: 'https://beyond.centuryasia.com.tw/img/20260201%E7%A5%A8%E5%83%B9.jpg',
      p2d: { 早場票: 260, 全票: 320, 優待票: 290, 愛心票: 160 },
      p3d: { 早場票: 290, 全票: 350, 優待票: 320, 愛心票: 175 },
    },
    {
      name: '喜樂時代影城 高雄店',
      url: 'https://ksml.centuryasia.com.tw/Ticket_Value.aspx',
      imageUrl: 'https://ksml.centuryasia.com.tw/img/2026%20%E5%AE%98%E7%B6%B2%E7%A5%A8%E5%83%B9%E8%A1%A8.jpg',
      p2d: { 早場票: 240, 全票: 290, 優待票: 260, 愛心票: 145 },
      p3d: { 早場票: 270, 全票: 320, 優待票: 290, 愛心票: 160 },
    },
    {
      name: '喜樂時代影城 南港店',
      url: 'https://www.centuryasia.com.tw/news-info.html?sitem=SN&sid=2030',
      imageUrl: 'https://ticket.centuryasia.com.tw/CenturyImages/News/Ng/SN20260127115136.jpg',
      p2d: { 早場票: 270, 全票: 330, 優待票: 300, 愛心票: 165 },
      p3d: { 早場票: 300, 全票: 360, 優待票: 330, 愛心票: 180 },
    },
  ];
  for (const c of century) {
    setCinema(c.name, {
      source: '官方（票價表為圖片，人工讀圖轉譯，非本程式自動解析）',
      url: c.url,
      imageUrl: c.imageUrl,
      updatedAt: fetchedAt,
      tiers: [
        { format: '2D', prices: c.p2d },
        { format: '3D', prices: c.p3d },
      ],
      note:
        '以上為非會員牌價；學生/軍警優待票、愛心/敬老票購票時須出示證件。' +
        '早場票：12:00前場次。官網另有儲值會員/一般會員價格與喜樂床座套票，本表不收（會員價/套票不收）。' +
        '此為一般廳牌價，若館內有 DOLBY 等特殊廳，官網未列出對應價格，未併入上表。',
    });
  }
  console.log('美麗新 台茂：1 館（圖片轉譯）');
  console.log('喜樂時代：4 館（圖片轉譯）');
}

// ---------------- 執行 ----------------
const sources = [
  ['秀泰', fetchShowtimes],
  ['樂聲', fetchLux],
  ['美麗新 大直皇家', fetchMiranewDazhi],
];
for (const [label, fn] of sources) {
  try {
    await fn();
  } catch (e) {
    console.error(`${label} 抓取失敗，這家跳過：${e.message}`);
  }
}
addImageSourcedPrices();

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, JSON.stringify(prices, null, 1));

const cinemaCount = Object.keys(prices).length;
const tierCount = Object.values(prices).reduce((sum, c) => sum + c.tiers.length, 0);
console.log(`\ndata/prices.json：共 ${cinemaCount} 家影城、${tierCount} 個票價層級`);
