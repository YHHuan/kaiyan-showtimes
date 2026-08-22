// 藝文館二號：補 fetch/arthouse.mjs 沒收的「未來場次」缺口。
//
// 起因：光點華山、府中15（fetch/arthouse.mjs）已有官網抓取器，有未來檔期；但真善美、
// 誠品電影院、光點台北、國家電影及視聽文化中心(TFAI) 只能靠 fetch/atmovies.mjs 從開眼
// 補「今天」，未來檔期全缺（開眼場次頁沒有日期參數可翻頁）。這支負責把「未來」補回來。
// 用 playwright（lib/browser.mjs）逐一探過官網後才發現：以下三館其實不需要無頭瀏覽器，
// 純 curl（politeFetch）就拿得到未來場次；只有誠品電影院官網被 Cloudflare 擋下，
// headless Chromium 一樣 403（見檔尾「已排除」說明），沒有納入。
//
// 真善美劇院：wonderful.movie.com.tw/time 是 server-rendered HTML，<select> 裡就是
//   「片ID→片名」對照表；每部片的場次要另外打 /lightbox/index?id={id}（原本是點擊海報
//   跳出的燈箱視窗，magnific-popup 用 AJAX 載入），純 GET 就拿得到未來 5~7 天的場次表
//   （<ul class="time_list"> 一天一組，含日期＋多個時間）。年份頁面沒給，用今天的台北
//   日期推算（唯一會跨年的情況是今天 12 月、場次落在下一年 1 月）。
//   官網沒有標廳別（片場提供 A/B 兩廳但場次表不分），hall 一律 null。
//
// 光點台北電影院（台北之家）：月節目表首頁（schedule/schedule_one.html）確認過真的是
//   整頁 JPG 圖片，如題目所述；但每部片另有一張「文字版」電影介紹頁：
//   movies/{YYYYMM}/m{N}/movies{YYYYMM}_m{N}.html（N 從 1 開始連號，站方沒有目錄頁，
//   逐一遞增探到 404 為止），裡面除了片名/英文片名/導演/年份/分級，還有一個
//   「本片放映時刻」表格（沒場次時只有「schedule」這個沒被替換掉的樣板字、無表格，
//   代表該片本月/次月尚未排片，略過）。同時抓當月與下個月，下個月站方通常還沒排滿
//   （只有零星幾部片有頁面），照實抓多少算多少。
//
// 國家電影及視聽文化中心 TFAI：官網 tfai.org.tw 本身也被 Cloudflare 擋下（headless
//   瀏覽器一樣 403，和 curl 一樣的下場，不是單純 UA 問題）。但 TFAI 的售票／節目資訊
//   實際上是靠 OPENTIX 兩廳院文化生活（opentix.life）在管，而且 OPENTIX 站是
//   server-rendered（Nuxt SSR），純 curl 就拿得到完整場次：
//   1) 打 TFAI 在 OPENTIX 的策展節目清單 API（org id 由 opentix.life/o/tfai 頁面實測
//      得來，見 TFAI_ORG_ID），拿到目前所有策展單元（如「零時ê望：流動．世界．台語片」
//      「TFAI PICKS」）與底下每部片的 event id；
//   2) 逐一打每個 event 的頁面 https://www.opentix.life/event/{id}，從
//      <meta name="keywords"> 拿到策展方自己標的關鍵字標籤（影展單元／數位修復等，
//      直接就是這個網站要的 tags），從內嵌的 schema.org JSON-LD（<script
//      type="application/ld+json">，每一場次各自一個 @type:"Event" 區塊）拿到
//      逐場次的日期時間與廳別（location.name，如「國家電影及視聽文化中心-大影格」）。
//   只收 displayCategory==='電影' 的項目（type===0）；純講座／座談這類「活動/學習」
//   沒有對應的「片名」，schema 沒有活動類型可放，這裡不收，但如果講座是附掛在某場
//   電影底下，OPENTIX 本來就會把它的關鍵字标進那部片自己的 event 頁面。
//
// 「茉莉人生」查核（本任務起因）：WebSearch＋OPENTIX 站內搜尋（0 筆）都查不到 2026 年
//   9 月的特別場。唯一查到的放映是 2026 第28屆台北電影節「德黑蘭：當代精選」單元，
//   6/26～7/11 於中山堂中正廳／光點華山電影館／誠品電影院聯映（見 README 記錄），
//   當時是「6 月」的活動、且已經放映結束（今天 2026-08-22），不是使用者說的「九月」。
//   OPENTIX、TFAI 策展清單、光點台北目前已公布的月份都沒有看到任何重映/加場資訊。
//   誠實回報：查無九月場次，只查到已結束的六月場次，研判使用者可能記錯月份，或有尚未
//   公開、我們查不到的行程。
//
// 已排除：誠品電影院。官網 arthouse.eslite.com／meet.eslite.com 全站 Cloudflare
//   「Sorry, you have been blocked」（WAF 規則擋下，非需要等待的 JS 挑戰，headless
//   瀏覽器等 5 秒一樣 403），沒有備援端點——它不像 TFAI 有 OPENTIX 撐著：搜尋
//   opentix.life 找不到誠品電影院自己的策展主辦頁，OPENTIX 上目前看得到的誠品電影院
//   場次都是「其他主辦單位」（如台北電影節）借場地辦活動時才會出現，不是誠品自己排的
//   常態商業場次，無法用同一套方法系統性地收。年代售票（ticket.com.tw）查證後也和
//   誠品電影院無關（那是另一個賣演唱會/展覽票的平台，誠品電影院官網本身沒有連過去）。
//   這一館目前真的抓不到未來場次，留給下一輪重新評估（例如若官網哪天換版、或誠品
//   自己也上架 OPENTIX）。
import { politeFetch, saveRecords, normTitle, todayISO } from '../lib/common.mjs';

const decode = (s) =>
  (s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

// 分級簡碼 → 中文全稱（光點台北官網用單字代碼標分級，同 fetch/arthouse.mjs 光點華山那段）
const RATING = { 護: '保護級', 普: '普遍級', 輔: '輔導級', 輔12: '輔12級', 輔15: '輔15級', 限: '限制級' };

// 片名尾端常見的「特別場/影展單元/數位修復」括號註記，剝出來當 tags（同 fetch/arthouse.mjs
// 光點華山那段的做法），標題本身留乾淨的片名。
const TAG_KEYWORDS =
  /數位修復|修復版|經典重映|週年|周年|影展|單元|座談|對談|講座|映後|首映|特映|特別場|限定場|加映|導演版|完整版|4K/;
function stripTrailingTag(title) {
  let t = (title || '').trim();
  const tags = [];
  let m;
  while ((m = t.match(/[（(]([^（）()]{1,20})[）)]\s*$/)) && TAG_KEYWORDS.test(m[1])) {
    tags.unshift(m[1].trim());
    t = t.slice(0, m.index).trim();
  }
  return { title: t, tags };
}

// ---------- 真善美劇院（西門町） ----------
async function fetchWonderful() {
  const BASE = 'https://wonderful.movie.com.tw';
  const html = await politeFetch(`${BASE}/time`);
  // 頁面有兩個 id="search-movie" 的 <select>（手機版導覽列一個是空殼，桌機版才有真正片單），
  // 取最後一份；每份開頭都有個 value="0" 的「電影」佔位選項（篩選器預設值，不是真片），排除。
  const selectBlocks = [...html.matchAll(/<select[^>]*id="search-movie"[^>]*>([\s\S]*?)<\/select>/g)];
  const selectHtml = selectBlocks.length ? selectBlocks[selectBlocks.length - 1][1] : '';
  const movies = [...selectHtml.matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)]
    .filter((m) => m[1] !== '0')
    .map((m) => ({ id: m[1], title: normTitle(decode(m[2])) }));

  const todayY = Number(todayISO().slice(0, 4));
  const todayM = Number(todayISO().slice(5, 7));
  const resolveYear = (month) => (todayM === 12 && Number(month) === 1 ? todayY + 1 : todayY);

  const records = [];
  for (const { id, title } of movies) {
    if (!title) continue;
    let frag;
    try {
      frag = await politeFetch(`${BASE}/lightbox/index?id=${id}`);
    } catch (e) {
      console.log(`  真善美劇院 [${title}]: ${e.message}`);
      continue;
    }
    for (const dayM of frag.matchAll(/<ul class="time_list t-center">([\s\S]*?)<\/ul>/g)) {
      const inner = dayM[1];
      const dateM = inner.match(/(\d{2})\s*\/\s*(\d{2})/);
      if (!dateM) continue;
      const [, month, day] = dateM;
      const year = resolveYear(month);
      const date = `${year}-${month}-${day}`;
      for (const t of inner.matchAll(/<li>\s*(\d{1,2}:\d{2})\s*<\/li>/g)) {
        records.push({
          source: 'arthouse2',
          cinema: '真善美戲院',
          area: '台北市',
          movie: title,
          date,
          time: t[1].padStart(5, '0'),
          hall: null, // 官網場次表不分廳（片場實際有 A/B 兩廳，但未標示在場次上）
          tags: [],
          url: `${BASE}/movie/inner?id=${id}`,
        });
      }
    }
  }
  console.log(`真善美劇院: ${records.length} 筆`);
  return records;
}

// ---------- 光點台北電影院（台北之家） ----------
function nextYYYYMM(yyyymm) {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  return m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, '0')}`;
}

async function fetchSpotTaipei() {
  const BASE = 'https://www.spot.org.tw';
  const thisMonth = todayISO().slice(0, 7).replace('-', '');
  const months = [thisMonth, nextYYYYMM(thisMonth)];

  const records = [];
  for (const ym of months) {
    const urlYear = Number(ym.slice(0, 4));
    const urlMonth = Number(ym.slice(4, 6));
    for (let n = 1; n <= 20; n++) {
      const url = `${BASE}/movies/${ym}/m${n}/movies${ym}_m${n}.html`;
      let html;
      try {
        html = await politeFetch(url);
      } catch {
        break; // 連號到底，第一次 404 就代表這個月沒有更多片了
      }

      const titleM = html.match(/<td class="movie_title">([^<]*)<\/td>/);
      if (!titleM) continue;
      // class="movie_title_eng" 同時出現在外層 <td>（緊接著一個 <table>，抓到的是空字串）
      // 跟內層真正放英文片名的 <td> 上，且結尾有的接 <br />、有的直接 </td>，兩種都要吃
      const engMatches = [...html.matchAll(/class="movie_title_eng">([^<]*)/g)].map((m) => m[1].trim()).filter(Boolean);
      const movieEnRaw = engMatches.length ? engMatches[0] : null;
      const metaM = html.match(/<td class="movie_dir"><p>([\s\S]*?)<\/p>/);
      let rating = null;
      if (metaM) {
        // 這行本身可能夾雜 <br /> 之類的標籤（分級碼常常剛好在 </p> 前一個 <br />），先去標籤再切
        const clean = decode(metaM[1].replace(/<[^>]+>/g, ' '));
        const parts = clean.split('|').map((s) => s.trim()).filter(Boolean);
        const code = parts.length ? parts[parts.length - 1] : null;
        rating = code ? RATING[code] || code : null;
      }

      const { title: baseTitle, tags: titleTags } = stripTrailingTag(decode(titleM[1]));
      const movie = normTitle(baseTitle);
      if (!movie) continue;
      const movieEn = movieEnRaw ? decode(movieEnRaw).trim() : null;

      for (const sm of html.matchAll(/<td>(\d{1,2})\/(\d{1,2})\([^)]*\)<\/td>\s*<td>(\d{1,2}:\d{2})<\/td>/g)) {
        const [, mo, day, time] = sm;
        const year = urlMonth === 12 && Number(mo) === 1 ? urlYear + 1 : urlYear;
        records.push({
          source: 'arthouse2',
          cinema: '光點台北電影院',
          area: '台北市',
          movie,
          movieEn,
          rating,
          date: `${year}-${String(mo).padStart(2, '0')}-${day.padStart(2, '0')}`,
          time: time.padStart(5, '0'),
          hall: null, // 單廳影院，官網不特別標廳名
          tags: titleTags,
          url,
        });
      }
    }
  }
  console.log(`光點台北電影院: ${records.length} 筆`);
  return records;
}

// ---------- 國家電影及視聽文化中心 TFAI（經 OPENTIX） ----------
// org id 來源：無頭瀏覽器開 https://www.opentix.life/o/tfai 時實測攔到的內部 API
// https://csm.api.opentix.life/organizers/1435869159970869249/topics —— 頁面本身
// 是 Vue/Nuxt 動態渲染看不到 id，但這個 topics API 是 SSR，直接 curl 就有資料。
const TFAI_ORG_ID = '1435869159970869249';

async function fetchTfai() {
  const eventTags = new Map(); // eventId -> Set(策展單元名稱)
  let topics;
  try {
    const json = await politeFetch(
      `https://csm.api.opentix.life/organizers/${TFAI_ORG_ID}/topics?topicPage=1&topicRowCount=20&contentRowCount=50`,
      { asJson: true }
    );
    topics = json?.result?.data || [];
  } catch (e) {
    console.log(`  國家電影及視聽文化中心: 節目清單抓取失敗（${e.message}）`);
    return [];
  }

  for (const topic of topics) {
    const topicName = (topic.name || '').replace(/^【|】$/g, '').trim();
    for (const item of topic.contents || []) {
      // type 0 = 節目（電影／活動）；type 2 = 套票，不是實際場次，跳過
      if (item.type !== 0 || item.displayCategory !== '電影') continue;
      if (!eventTags.has(item.id)) eventTags.set(item.id, new Set());
      if (topicName) eventTags.get(item.id).add(topicName);
    }
  }

  const records = [];
  for (const [id, topicSet] of eventTags) {
    const url = `https://www.opentix.life/event/${id}`;
    let html;
    try {
      html = await politeFetch(url);
    } catch (e) {
      console.log(`  [TFAI event ${id}]: ${e.message}`);
      continue;
    }

    const titleM = html.match(/data-hid="og:title" property="og:title" content="([^"]+?)\s*—\s*OPENTIX/);
    if (!titleM) continue;
    const { title: baseTitle, tags: titleTags } = stripTrailingTag(decode(titleM[1]));
    const movie = normTitle(baseTitle);
    if (!movie) continue;

    const kwM = html.match(/data-hid="keywords" name="keywords" content="([^"]*)"/);
    const kwTags = kwM
      ? decode(kwM[1])
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s && s !== 'TFAI')
      : [];
    const tags = [...new Set([...topicSet, ...kwTags, ...titleTags])];

    // 分級寫在「節目介紹」內文段落裡（class="summernoteBoxContent"，頁面第一個這樣的區塊），
    // 不能直接對整頁 html 抓「級別：」——最前面 <meta name="description"> 屬性值裡也有一份同樣的
    // 文字但完全沒有標籤分隔欄位（國影電影編號/放映規格/級別/片長全部黏在一起），會抓過量。
    // 內文段落本身格式也不統一（有的直接 <p>級別：普遍級</p>，有的分成兩個 <span> 包住），
    // 統一先把 </p>、<br 轉成換行、拔掉所有標籤，再逐行找「級別」那行。
    const introM = html.match(/class="summernoteBoxContent"[^>]*>([\s\S]{0,4000})/);
    let rating = null;
    if (introM) {
      const plain = decode(introM[1].replace(/<\/p>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
      const line = plain.split('\n').map((l) => l.trim()).find((l) => /^級別[：:]/.test(l));
      if (line) rating = line.replace(/^級別[：:]\s*/, '').trim() || null;
    }

    for (const ldM of html.matchAll(/<script data-n-head="ssr" type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      let data;
      try {
        data = JSON.parse(ldM[1]);
      } catch {
        continue;
      }
      if (data['@type'] !== 'Event' || !data.startDate) continue;
      const dtM = data.startDate.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (!dtM) continue;
      const [, y, mo, d, hh, mm] = dtM;
      const hall = (data.location?.name || '').replace(/^國家電影及視聽文化中心-?/, '') || null;
      records.push({
        source: 'arthouse2',
        cinema: '國家電影及視聽文化中心',
        area: '新北市',
        movie,
        rating,
        date: `${y}-${mo}-${d}`,
        time: `${hh}:${mm}`,
        hall,
        tags,
        url,
      });
    }
  }
  console.log(`國家電影及視聽文化中心: ${records.length} 筆`);
  return records;
}

const records = [...(await fetchWonderful()), ...(await fetchSpotTaipei()), ...(await fetchTfai())];
await saveRecords(new URL('../data/arthouse2.json', import.meta.url).pathname, records);
