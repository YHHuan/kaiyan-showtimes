// 藝文/獨立影院：府中15（新北市政府文化局，紀錄片放映院）、光點華山電影館（台灣電影文化協會）
// 兩館皆為 server-rendered HTML，無 JSON API，故用正規表示式解析。
//
// 府中15：xcmovie 頁 <table class="ListTable"> 逐場次一列（日期/時間/片名/片長/級別）；
//   片名欄常見【專題名稱】前綴（如【聽．視界電影院】），視為 tag；售票方式（報名/索取/販售）
//   也一併收進 tags（對使用者是實用資訊：報名制代表要先登記，不是到場就能看）。
//   預設頁＝當月，頁面另有「下個月」連結（class="next_month"）→ 跟著抓一次，涵蓋約 2 個月。
//
// 光點華山：schedule.html 單頁，一廳/二廳左右並排、每廳各 9 個 date-keyed
//   <table id="YYYYMMDD">（同一個 id 依序出現兩次＝先一廳後二廳，用出現順序判斷廳別）。
//   片名欄第一行片名、第二行常是英文片名，但也可能是純活動註記（如 (海報場)、+講座），
//   片名本身也可能帶 (特別場)/(情人節場) 或「+ QA」尾註——一併解析成 tags，不誤植進片名/英文片名。
import { politeFetch, saveRecords, normTitle } from '../lib/common.mjs';

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

// ---------- 府中15（板橋，新北市文化局紀錄片放映院） ----------
async function fetchFuzhong15() {
  const BASE = 'https://www.fuzhong15.ntpc.gov.tw';
  const XSMSID = '0m361641875264878260';
  const TICKET = { apply: '報名制', request: '索取制', sell: '販售制' };
  const clean = (raw) => decode(raw.replace(/<[^>]+>/g, '')).trim();

  async function fetchMonth(url) {
    const html = await politeFetch(url);
    // 頁面用隱藏欄位標示目前查詢的月份區間（YYYY-MM-01），比自己算年份/跨年更可靠
    const yearM = html.match(/id="BeginReleaseDate"[^>]*value="(\d{4})-\d{2}-\d{2}"/);
    const year = yearM ? yearM[1] : String(new Date().getFullYear());
    const tableM = html.match(/<table class="ListTable">([\s\S]*?)<\/table>/);
    const rows = [];
    if (tableM) {
      for (const rowHtml of tableM[1].match(/<tr>[\s\S]*?<\/tr>/g) || []) {
        const dateM = rowHtml.match(/<td class="cat">(\d{2})\/(\d{2})\([^)]*\)<\/td>/);
        const timeM = rowHtml.match(/<td class="cat">(\d{1,2}:\d{2})<\/td>/);
        const titleM = rowHtml.match(/<a[^>]*title="([^"]*)"[^>]*>/);
        if (!dateM || !timeM || !titleM) continue; // 表頭列或非資料列
        const ratingM = rowHtml.match(/<td class="cat">([^<]*級)<\/td>/);
        const ticketM = rowHtml.match(/class="ticketing_method (\w+)"/);

        let title = decode(titleM[1]);
        const tags = [];
        const bracketM = title.match(/^【([^】]+)】\s*/);
        if (bracketM) {
          tags.push(bracketM[1]); // 專題/系列名稱（如「聽．視界電影院」），最有賣點的資訊放第一個
          title = title.slice(bracketM[0].length);
        }
        if (/數位修復|4K修復|修復版/.test(title)) tags.push('數位修復');
        if (/\d+週年/.test(title)) tags.push('週年紀念');
        if (/經典重映/.test(title)) tags.push('經典重映');
        if (ticketM && TICKET[ticketM[1]]) tags.push(TICKET[ticketM[1]]);

        rows.push({
          source: 'arthouse',
          cinema: '府中15',
          area: '新北市',
          movie: normTitle(title),
          rating: ratingM ? clean(ratingM[1]) : null,
          date: `${year}-${dateM[1]}-${dateM[2]}`,
          time: timeM[1].padStart(5, '0'),
          hall: '紀錄片放映院',
          tags,
          url: `${BASE}/xcmovie?xsmsid=${XSMSID}`,
        });
      }
    }
    const nextM =
      html.match(/<a[^>]*href="([^"]+)"[^>]*class="next_month"/) ||
      html.match(/class="next_month"[^>]*href="([^"]+)"/);
    const nextUrl = nextM ? new URL(nextM[1], BASE).href : null;
    return { rows, nextUrl };
  }

  const month0 = await fetchMonth(`${BASE}/xcmovie?xsmsid=${XSMSID}`);
  const records = [...month0.rows];
  if (month0.nextUrl) {
    const month1 = await fetchMonth(month0.nextUrl);
    records.push(...month1.rows);
  }
  console.log(`府中15: ${records.length} 筆（含次月）`);
  return records;
}

// ---------- 光點華山電影館（台灣電影文化協會） ----------
async function fetchSpotHuashan() {
  const BASE = 'https://www.spot-hs.org.tw';
  const url = `${BASE}/movie/schedule.html`;
  const RATING = { 護: '保護級', 普: '普遍級', 輔: '輔導級', 輔12: '輔12級', 輔15: '輔15級', 限: '限制級' };
  const clean = (raw) => decode(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();

  const html = await politeFetch(url);
  const records = [];
  const seenDate = new Map(); // dateId -> 已出現次數：同一 id 第 1 次＝一廳、第 2 次＝二廳
  const tableRe = /<table[^>]*\bid="(\d{8})"[^>]*>([\s\S]*?)<\/table>/g;
  let tm;
  while ((tm = tableRe.exec(html))) {
    const dateId = tm[1];
    const seenCount = seenDate.get(dateId) || 0;
    seenDate.set(dateId, seenCount + 1);
    const hall = seenCount === 0 ? '一廳' : '二廳';
    const date = `${dateId.slice(0, 4)}-${dateId.slice(4, 6)}-${dateId.slice(6, 8)}`;

    for (const rowHtml of tm[2].match(/<tr>[\s\S]*?<\/tr>/g) || []) {
      const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      // 每個date-table的第一列多一格「日期」欄（rowspan 撐開），後續列只有 5 格
      const cells = tds.length === 6 ? tds.slice(1) : tds.length === 5 ? tds : null;
      if (!cells) continue;
      const [timeRaw, titleRaw, , , ratingRaw] = cells;
      const time = clean(timeRaw);
      if (!/^\d{1,2}:\d{2}$/.test(time)) continue; // 補位空白列（該廳當天場次不足6場時的佔位列）

      const lines = clean(titleRaw)
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      let l0 = lines[0] || '';
      const l1 = lines[1] || null;
      const tags = [];
      let pm;
      // 片名尾端的 (特別場)/(情人節場) 這類註記可能不只一組，逐一剝掉
      while ((pm = l0.match(/\s*\(([^()]+)\)\s*$/))) {
        tags.push(pm[1].trim());
        l0 = l0.slice(0, pm.index).trim();
      }
      // 片名尾端「+ QA」「+ 講座」這類活動註記
      if ((pm = l0.match(/\s*\+\s*([^+]+)$/))) {
        tags.push(pm[1].trim());
        l0 = l0.slice(0, pm.index).trim();
      }
      let movieEn = null;
      if (l1) {
        if ((pm = l1.match(/^\(([^()]+)\)$/))) tags.push(pm[1].trim());
        else if ((pm = l1.match(/^\+\s*(.+)$/))) tags.push(pm[1].trim());
        else movieEn = l1;
      }
      const ratingTxt = clean(ratingRaw);

      records.push({
        source: 'arthouse',
        cinema: '光點華山電影館',
        area: '台北市',
        movie: normTitle(l0),
        movieEn,
        rating: RATING[ratingTxt] || ratingTxt || null,
        date,
        time: time.padStart(5, '0'),
        hall,
        tags,
        url,
      });
    }
  }
  console.log(`光點華山電影館: ${records.length} 筆`);
  return records;
}

const records = [...(await fetchFuzhong15()), ...(await fetchSpotHuashan())];
await saveRecords(new URL('../data/arthouse.json', import.meta.url).pathname, records);
