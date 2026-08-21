// 喜樂時代影城：官方乾淨 JSON API（分店→片單→日期→場次）
//
// 註：www.centuryasia.com.tw 的 GetMovieNow API 只有南港店（Nangang）回得出資料，
// 永和（Beyond）、今日（Ximen）、高雄（Kaohsiung）都回 {status:false, msg:"查無資料"}——
// 逆向確認這三店其實正常有場次，只是掛在另一個子網域的舊售票系統
// ticket.centuryasia.com.tw/<分店代碼小寫>/，走「片單頁 → 逐片逐日 POST 場次 AJAX」的流程：
//   1. GET  /<siteFolder>/index.aspx                                   拿片單（ProgramID + 片名）
//   2. POST /<siteFolder>/ImportOldMovieWeb/ajax/Program_ShowMovieTime.ashx
//      body: ProgramID / Date / Location（留空＝全部廳）/ CodeControl（留空＝不篩版本）
//      → 回傳當天各廳場次；此站前端日期選單固定顯示「今天起 14 天」，故直接迴圈 14 天。
// 全程唯讀 GET/POST 查詢頁與查詢用 AJAX，不觸碰 buyticket_process 等下單流程。
import { politeFetch, saveRecords, normTitle, todayISO } from '../lib/common.mjs';

const BASE = 'https://www.centuryasia.com.tw/Movie';
const TICKET_BASE = 'https://ticket.centuryasia.com.tw';
const AREA = { Nangang: '台北市', Ximen: '台北市', Beyond: '新北市', Kaohsiung: '高雄市' };
// www API 有資料的店，走原本乾淨 JSON 流程；其餘走 ticket 子網域舊系統（值＝網址資料夾，小寫）
const TICKET_SITE_FOLDER = { Beyond: 'beyond', Ximen: 'ximen', Kaohsiung: 'kaohsiung' };
const TICKET_DAYS = 14; // 售票頁日期選單實測固定顯示今天起 14 天

const records = [];
const { Data: theaters } = await politeFetch(`${BASE}/GetTheaterList`, { asJson: true });

for (const th of theaters.filter((t) => t.item_value)) {
  const cinema = `喜樂時代影城 ${th.item_name}`;
  const siteCode = th.item_value;
  if (TICKET_SITE_FOLDER[siteCode]) {
    await fetchViaTicketSite(siteCode, cinema);
  } else {
    await fetchViaMovieNowApi(siteCode, cinema);
  }
  console.log(`  ${cinema}: 累計 ${records.length}`);
}

await saveRecords(new URL('../data/centuryasia.json', import.meta.url).pathname, records);

// www.centuryasia.com.tw 乾淨 JSON API：分店→片單→日期→場次
async function fetchViaMovieNowApi(siteCode, cinema) {
  const { Data: rawMovies } = await politeFetch(`${BASE}/GetMovieNow/${siteCode}`, { asJson: true });
  for (const mv of (rawMovies || []).filter((m) => m.item_value)) {
    const { Data: rawDates } = await politeFetch(`${BASE}/GetMovieDate/${siteCode}/${mv.item_value}`, { asJson: true });
    for (const dt of (rawDates || []).filter((d) => d.item_value)) {
      const { Data: times } = await politeFetch(`${BASE}/GetMovieTime/${siteCode}/${mv.item_value}/${dt.item_value}`, { asJson: true });
      for (const s of times || []) {
        const tag = (s.showname?.match(/\(([^)]+)\)/) || [])[1] || null;
        // API 偶爾回缺 ShowDate/ShowTime 的雜訊列：時間從 showname 補、日期用查詢參數補
        const time = s.ShowTime || (s.showname?.match(/^(\d{1,2}:\d{2})/) || [])[1];
        if (!time) continue;
        records.push({
          source: 'centuryasia',
          cinema,
          area: AREA[siteCode] || '',
          movie: normTitle(mv.item_name),
          date: s.ShowDate || dt.item_value,
          time,
          hall: s.hall || null,
          tags: tag ? [tag] : [],
          url: 'https://www.centuryasia.com.tw/',
        });
      }
    }
  }
}

// ticket.centuryasia.com.tw 舊售票系統：片單頁 + 逐片逐日 AJAX 場次查詢
async function fetchViaTicketSite(siteCode, cinema) {
  const folder = TICKET_SITE_FOLDER[siteCode];
  const indexUrl = `${TICKET_BASE}/${folder}/index.aspx`;
  const indexHtml = await politeFetch(indexUrl);
  const movieRe = /movie_timetable\.aspx\?ProgramID=(\d+)&amp;TimeDetail=False"><img src="Uploads\/\d+\.jpg"\s*\/><\/a><div class="trn_text">\s*<div class="trn_mn">\s*<span>([^<]+)<\/span>/g;
  const movies = [];
  const seenId = new Set();
  for (const m of indexHtml.matchAll(movieRe)) {
    if (seenId.has(m[1])) continue;
    seenId.add(m[1]);
    movies.push({ id: m[1], title: m[2] });
  }

  const ashxUrl = `${TICKET_BASE}/${folder}/ImportOldMovieWeb/ajax/Program_ShowMovieTime.ashx`;
  for (const mv of movies) {
    for (let d = 0; d < TICKET_DAYS; d++) {
      const date = todayISO(d);
      let rooms;
      try {
        rooms = await politeFetch(ashxUrl, {
          asJson: true,
          method: 'POST',
          form: { ProgramID: mv.id, Date: date, Location: '', CodeControl: '' },
          headers: { Referer: `${TICKET_BASE}/${folder}/movie_timetable.aspx?ProgramID=${mv.id}` },
        });
      } catch (e) {
        console.log(`  ${cinema} ${mv.title} ${date}: ${e.message}`);
        continue;
      }
      for (const room of rooms || []) {
        for (const s of room.mytime || []) {
          if (!s.ShowTime) continue;
          const tags = [room.progsubid, s.Language].filter(Boolean);
          records.push({
            source: 'centuryasia',
            cinema,
            area: AREA[siteCode] || '',
            movie: normTitle(mv.title),
            date,
            time: s.ShowTime,
            hall: room.RoomName || null,
            tags,
            url: indexUrl,
          });
        }
      }
    }
  }
}
