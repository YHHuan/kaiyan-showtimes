// 秀泰影城：capi.showtimes.com.tw/4/app/bootstrap 一支 API 含 15 館全部場次（約兩週）
// 注意：startedAt 是 UTC，要 +8 轉台北時間；listedAt 是「營業日」（凌晨場掛前一天）
import { politeFetch, saveRecords, normTitle } from '../lib/common.mjs';

const RATING = { g: '普遍級', p: '保護級', pg12: '輔12級', pg15: '輔15級', r: '限制級' };

const { payload } = await politeFetch('https://capi.showtimes.com.tw/4/app/bootstrap', { asJson: true });

const corps = new Map(payload.corporations.map((c) => [c.id, { name: c.name, area: (c.address || '').slice(0, 3) }]));
const progs = new Map(payload.programs.map((p) => [p.id, p]));

const records = [];
for (const [corpId, group] of Object.entries(payload.eventsForCorporations)) {
  const corp = corps.get(Number(corpId));
  if (!corp) continue;
  const venues = new Map((group.venues || []).map((v) => [v.id, v.name]));
  for (const ev of group.events || []) {
    if (ev.status !== 'active') continue;
    const prog = progs.get(ev.programId);
    if (!prog) continue;
    const local = new Date(new Date(ev.startedAt).getTime() + 8 * 3600000);
    const p = (n) => String(n).padStart(2, '0');
    records.push({
      source: 'showtimes',
      cinema: corp.name,
      area: corp.area,
      movie: normTitle(prog.name),
      movieEn: prog.nameAlternative || null,
      rating: RATING[prog.rating] || prog.rating || null,
      date: (ev.listedAt || ev.startedAt).slice(0, 10),
      time: `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}`,
      hall: venues.get(ev.venueId) || null,
      tags: ev.meta?.format ? [ev.meta.format] : [],
      url: 'https://www.showtimes.com.tw/ticketing',
    });
  }
}

await saveRecords(new URL('../data/showtimes.json', import.meta.url).pathname, records);
