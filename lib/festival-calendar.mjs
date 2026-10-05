// Pure browser/Node helpers for the optional calendar. Never writes original favorites.
export const FOLLOW_KEY = 'kaiyan.festivals.v1';
const DAY = 86400000;
const text = (s, max = 300) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const id = s => typeof s === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(s);
export function validDate(s) {
  return typeof s === 'string' && /^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}
export function safeUrl(s) {
  try { const u = new URL(s); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && s.length <= 2048 ? u.href : ''; }
  catch { return ''; }
}
function requireValue(ok, message) { if (!ok) throw new Error('festival calendar: ' + message); }
export function validateFestivals(catalog) {
  requireValue(catalog?.version === 1 && Array.isArray(catalog.festivals) && catalog.festivals.length <= 200, 'invalid catalog');
  const ids = new Set();
  for (const f of catalog.festivals) {
    requireValue(f && Object.keys(f).every(k => ['id', 'name', 'shortName', 'startDate', 'endDate', 'cities', 'url', 'programUrl', 'sourceUrl', 'checkedAt', 'seriesId'].includes(k)), 'unknown festival field');
    requireValue(id(f.id) && !ids.has(f.id) && text(f.name) && text(f.shortName, 20), 'invalid/duplicate festival');
    requireValue(validDate(f.startDate) && validDate(f.endDate) && f.startDate <= f.endDate
      && Date.parse(f.endDate) - Date.parse(f.startDate) <= 120 * DAY, 'invalid period');
    requireValue(validDate(f.checkedAt) && [f.url, f.programUrl, f.sourceUrl].every(u => safeUrl(u) && u.startsWith('https://')), 'invalid provenance');
    requireValue(Array.isArray(f.cities) && f.cities.length > 0 && f.cities.length <= 25 && f.cities.every(c => text(c, 20)), 'invalid cities');
    requireValue(f.seriesId == null || id(f.seriesId), 'invalid series');
    ids.add(f.id);
  }
  return catalog;
}
export const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const taipeiDate = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
export const monthValid = month => typeof month === 'string' && validDate(month + '-01');
export function shiftMonth(month, delta) {
  requireValue(monthValid(month) && Number.isInteger(delta), 'invalid month');
  const d = new Date(month + '-01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + delta);
  const result = d.toISOString().slice(0, 7);
  return monthValid(result) ? result : month;
}
export function monthDays(month) {
  requireValue(monthValid(month), 'invalid month');
  const first = month + '-01';
  const offset = new Date(first + 'T00:00:00Z').getUTCDay();
  return Array.from({ length: 42 }, (_, i) => addDays(first, i - offset));
}
export const inPeriod = (date, f) => date >= f.startDate && date <= f.endDate;
export const reviewOld = (f, today) => Date.parse(today) - Date.parse(f.checkedAt) > 30 * DAY;
export function readFollows(storage) {
  const raw = storage.getItem(FOLLOW_KEY);
  if (raw === null) return [];
  const value = JSON.parse(raw);
  requireValue(Array.isArray(value) && value.length <= 1000 && value.every(id), 'invalid saved festival follows');
  return [...new Set(value)];
}
export function toggleFollow(storage, festivalId) {
  requireValue(id(festivalId), 'invalid festival ID');
  const current = readFollows(storage); // Re-read to preserve other tabs and retired festival IDs.
  const next = current.includes(festivalId) ? current.filter(x => x !== festivalId) : [...current, festivalId];
  requireValue(next.length <= 1000, 'too many festival follows');
  storage.setItem(FOLLOW_KEY, JSON.stringify(next));
  return next;
}
const canonical = (map, s) => map && Object.hasOwn(map, s) && typeof map[s] === 'string' ? map[s] : s;
const cleanTag = s => s.replace(/(?:^|・)\s*(?:&copy;|&#169;|&#x0*a9;|©)?\s*@movies\s+All rights reserved\s+開眼電影網版權所有\s*$/i, '').trim();
export const startTime = s => Date.parse(s.date + 'T00:00:00+08:00') + s.mins * 60000;
export function savedKey(s, schedule = {}) {
  return JSON.stringify([canonical(schedule.aliases, s.movie), canonical(schedule.cinemaAliases, s.cinema), s.date, s.mins, s.hall, cleanTag(s.tag)]);
}
export function readSavedSessions(storage, schedule = {}) {
  const separate = storage.getItem('kaiyan.sessions');
  const value = separate === null ? (JSON.parse(storage.getItem('kaiyan.favorites') || '{}')?.sessions || []) : JSON.parse(separate);
  requireValue(Array.isArray(value) && value.length <= 5000, 'invalid saved sessions');
  const result = new Map();
  for (const s of value) {
    if (!s || !text(s.movie, 1000) || !text(s.cinema, 1000) || !validDate(s.date)
      || !Number.isInteger(s.mins) || s.mins < 0 || s.mins >= 2880
      || ![s.hall, s.tag].every(v => typeof v === 'string' && v.length <= 1000)) continue;
    const clean = { movie: s.movie, cinema: s.cinema, date: s.date, mins: s.mins, hall: s.hall, tag: cleanTag(s.tag) };
    result.set(savedKey(clean, schedule), clean);
  }
  return [...result.values()]; // Deliberately no migration/write to original keys.
}
export function scheduleIndex(data) {
  const index = new Map();
  requireValue(data && typeof data.packed === 'string' && data.packed.length <= 5000000, 'invalid schedule');
  for (const key of ['cinemas', 'movies', 'dates', 'halls', 'tags', 'urls']) requireValue(Array.isArray(data[key]), 'invalid schedule table');
  for (const group of data.packed.split(';').filter(Boolean)) {
    const fields = group.split(',');
    requireValue([7, 8].includes(fields.length) && fields.slice(0, 6).every(v => /^[0-9a-z]+$/.test(v)), 'invalid packed group');
    const [ci, mi, di, hi, ti, ui] = fields.slice(0, 6).map(x => parseInt(x, 36));
    const movie = data.movies[mi]?.[0], cinema = data.cinemas[ci]?.[0], date = data.dates[di];
    requireValue(text(movie, 1000) && text(cinema, 1000) && validDate(date)
      && [[data.halls, hi], [data.tags, ti], [data.urls, ui]].every(([list, i]) => i < list.length && (list[i] === null || typeof list[i] === 'string')), 'invalid row reference');
    for (const minute of fields[6].split('.')) {
      const mins = parseInt(minute, 36);
      requireValue(/^[0-9a-z]+$/.test(minute) && mins >= 0 && mins < 2880, 'invalid time');
      const s = { movie, cinema, date, mins, hall: data.halls[hi] || '', tag: data.tags[ti] || '' };
      const key = savedKey(s, data);
      const runtime = data.meta?.[mi]?.d;
      const entry = { ...s, runtime: Number.isFinite(runtime) && runtime > 0 && runtime <= 600 ? runtime : null,
        url: safeUrl((data.urls[ui] || '').replaceAll('{d}', date).replaceAll('{s}', encodeURIComponent(date.replaceAll('-', '/')))) };
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(entry);
    }
  }
  return index;
}
export function resolveSaved(saved, schedule, index, generatedAt, now = Date.now()) {
  const age = now - Date.parse(generatedAt);
  const stale = !Number.isFinite(age) || age < -300000 || age > 72 * 3600000;
  return saved.map(s => {
    const start = startTime(s), matches = index.get(savedKey(s, schedule)) || [];
    const urls = [...new Set(matches.map(r => r.url).filter(Boolean))];
    const durations = [...new Set(matches.map(r => r.runtime))];
    const runtime = durations.length === 1 ? durations[0] : null;
    const state = start <= now ? 'past' : stale ? 'stale' : !matches.length ? 'missing' : urls.length > 1 ? 'ambiguous' : 'current';
    return { ...s, key: savedKey(s, schedule), venueKey: canonical(schedule.cinemaAliases, s.cinema), start, day: taipeiDate(start), state,
      end: state === 'current' && runtime ? start + (runtime + 12) * 60000 : null,
      url: state === 'current' ? urls[0] || '' : '', runtime: state === 'current' ? runtime : null };
  }).sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}
export function conflicts(sessions, bufferMinutes = 15) {
  requireValue([0, 15, 30, 60].includes(bufferMinutes), 'invalid transfer buffer');
  const valid = sessions.filter(s => s.state === 'current').sort((a, b) => a.start - b.start);
  const result = [];
  for (let i = 0; i < valid.length; i++) {
    const a = valid[i];
    if (!a.end) continue;
    for (let j = i + 1; j < valid.length; j++) {
      const b = valid[j];
      if (b.start >= a.end + bufferMinutes * 60000) break;
      if (b.start < a.end) result.push({ a: a.key, b: b.key, kind: 'overlap' });
      else if ((a.venueKey || a.cinema) !== (b.venueKey || b.cinema) && b.start < a.end + bufferMinutes * 60000) result.push({ a: a.key, b: b.key, kind: 'transfer' });
    }
  }
  return result;
}
const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const utcStamp = t => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function foldLine(line) {
  const lines = []; let part = '', bytes = 0;
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    if (bytes + size > 75) { lines.push(part); part = ' '; bytes = 1; }
    part += ch; bytes += size;
  }
  lines.push(part); return lines.join('\r\n');
}
async function uid(key) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('') + '@kaiyan-calendar';
}
export async function exportCalendar({ festivals = [], sessions = [], now = Date.now() }) {
  validateFestivals({ version: 1, festivals });
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kaiyan//Optional Calendar//ZH-TW', 'CALSCALE:GREGORIAN'];
  const seen = new Set();
  for (const f of festivals) {
    lines.push('BEGIN:VEVENT', 'UID:' + await uid('festival:' + f.id), 'DTSTAMP:' + utcStamp(now),
      'DTSTART;VALUE=DATE:' + f.startDate.replaceAll('-', ''), 'DTEND;VALUE=DATE:' + addDays(f.endDate, 1).replaceAll('-', ''),
      'SUMMARY:' + icsText(f.name + '｜影展檔期'), 'LOCATION:' + icsText(f.cities.join('、')),
      'DESCRIPTION:' + icsText('這是影展期間，不是電影場次或購票證明。檔期核對：' + f.checkedAt + '。改期請以官方公告為準；匯入後不會自動同步。'),
      'URL:' + safeUrl(f.url), 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  for (const s of sessions) {
    if (s.state !== 'current' || !Number.isFinite(s.start) || s.start <= now || seen.has(s.key)) continue;
    seen.add(s.key);
    lines.push('BEGIN:VEVENT', 'UID:' + await uid('session:' + s.key), 'DTSTAMP:' + utcStamp(now),
      'DTSTART:' + utcStamp(s.start), 'SUMMARY:' + icsText(s.movie), 'LOCATION:' + icsText(s.cinema + (s.hall ? ' ' + s.hall : '')),
      'DESCRIPTION:' + icsText((s.tag ? s.tag + '。' : '') + (s.end ? '散場為片長＋12分鐘估算，不含映後及交通。' : '片長未提供，未設定結束時間。') + '購票前請再核對官方。匯入後不會自動同步異動。'));
    if (Number.isFinite(s.end) && s.end > s.start) lines.push('DTEND:' + utcStamp(s.end));
    if (safeUrl(s.url)) lines.push('URL:' + safeUrl(s.url));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR', '');
  return lines.map(foldLine).join('\r\n');
}
