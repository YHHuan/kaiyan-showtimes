// Shared browser/Node model. This add-on never writes the ordinary favorites keys.
import { validDate, safeUrl, startTime } from './festival-calendar.mjs';

export const SCREENINGS_KEY = 'kaiyan.festival-sessions.v1';
export const MAX_SCREENINGS = 10000;
export const screeningScopes = {
  'tiaf-2026': '官方場次表已公布的放映場；合輯以整場收藏',
  'kff-2026': '長短片場次；不含 XR、產業及其他活動',
  'wmw-2026': '官方場次表已公布的放映場；合輯以整場收藏'
};
const required = (ok, message) => { if (!ok) throw new Error('festival screenings: ' + message); };
const string = (s, max = 1000) => typeof s === 'string' && s.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s);
const stamp = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));
const https = s => safeUrl(s) && s.startsWith('https://');
const rowFields = ['id', 'festivalId', 'programId', 'movie', 'englishTitle', 'cinema', 'hall', 'date', 'mins', 'runtime', 'endMins', 'endKind', 'notes', 'films', 'url'];
export function validateScreening(s, festival) {
  required(s && Object.keys(s).every(k => rowFields.includes(k)), 'unknown screening field');
  required(typeof s.festivalId === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(s.festivalId)
    && string(s.id, 600) && s.id.startsWith(s.festivalId + ':') && s.id.length > s.festivalId.length + 1
    && string(s.programId, 300) && s.programId.length > 0, 'invalid identity');
  required([s.movie, s.cinema, s.hall].every(v => string(v) && v.trim()) && string(s.englishTitle), 'invalid labels');
  required(validDate(s.date) && Number.isInteger(s.mins) && s.mins >= 0 && s.mins < 1440, 'invalid start');
  required(s.runtime === null || Number.isInteger(s.runtime) && s.runtime > 0 && s.runtime <= 600, 'invalid runtime');
  required(['official', 'runtime', 'unknown'].includes(s.endKind), 'invalid end kind');
  required(s.endKind === 'unknown' ? s.endMins === null : Number.isInteger(s.endMins) && s.endMins > s.mins && s.endMins <= s.mins + 600, 'invalid end');
  required(s.endKind !== 'runtime' || s.runtime && s.endMins === s.mins + s.runtime, 'inconsistent runtime');
  required(Array.isArray(s.notes) && s.notes.length <= 30 && s.notes.every(n => string(n, 2000)), 'invalid notes');
  required(Array.isArray(s.films) && s.films.length <= 100 && s.films.every(f => f && Object.keys(f).every(k => ['id', 'title'].includes(k)) && string(f.id, 100) && f.id && string(f.title) && f.title), 'invalid program members');
  required(https(s.url), 'invalid source URL');
  if (festival) required(s.festivalId === festival.id && s.date >= festival.startDate && s.date <= festival.endDate, 'wrong edition/period');
  return s;
}
export function emptyScreeningFeed(festivals) {
  return { version: 1, sources: festivals.map(f => ({ festivalId: f.id, url: f.programUrl,
    scope: screeningScopes[f.id] || '尚未接入可核對的逐場資料，請見官方',
    status: screeningScopes[f.id] ? 'not-fetched' : 'unsupported', attemptedAt: null, fetchedAt: null, rows: [] })) };
}
export function validateScreeningSource(source, festival) {
  required(source && Object.keys(source).every(k => ['festivalId', 'url', 'scope', 'status', 'attemptedAt', 'fetchedAt', 'rows'].includes(k)), 'unknown source field');
  required(source && source.festivalId === festival?.id && https(source.url) && string(source.scope, 300), 'invalid source');
  required(['ok', 'failed', 'not-fetched', 'unsupported', 'retired'].includes(source.status), 'invalid source state');
  required([source.attemptedAt, source.fetchedAt].every(s => s === null || stamp(s)), 'invalid fetch timestamp');
  required(source.status !== 'ok' || stamp(source.fetchedAt), 'missing fetch timestamp');
  required(Array.isArray(source.rows) && source.rows.length <= MAX_SCREENINGS, 'invalid source rows');
  required(!source.rows.length || stamp(source.fetchedAt), 'undated rows');
  const ids = new Set();
  for (const row of source.rows) { validateScreening(row, festival); required(!ids.has(row.id), 'duplicate screening'); ids.add(row.id); }
  return source;
}
export function validateScreeningFeed(feed, festivals) {
  required(feed?.version === 1 && Array.isArray(feed.sources) && feed.sources.length <= 200, 'invalid feed');
  const seen = new Set();
  for (const source of feed.sources) {
    required(!seen.has(source.festivalId), 'duplicate provider'); seen.add(source.festivalId);
    validateScreeningSource(source, festivals.find(f => f.id === source.festivalId));
  }
  return feed;
}
export function sourceState(source, now = Date.now()) {
  if (!source) return 'missing';
  if (['unsupported', 'not-fetched', 'retired'].includes(source.status)) return source.status;
  const age = now - Date.parse(source.fetchedAt);
  if (!Number.isFinite(age) || age < -300000 || age > 72 * 3600000) return 'stale';
  return source.status === 'ok' ? 'current' : 'unverified';
}
// Include all facts that matter to the saved choice, including program members and notes.
export const screeningSignature = s => JSON.stringify(rowFields.map(k => s[k]));
export function readFestivalSessions(storage) {
  const rows = JSON.parse(storage.getItem(SCREENINGS_KEY) || '[]');
  required(Array.isArray(rows) && rows.length <= 2000, 'invalid saved screenings');
  const seen = new Set();
  for (const s of rows) { validateScreening(s); required(!seen.has(s.id), 'duplicate saved screening'); seen.add(s.id); }
  return rows;
}
export function saveFestivalSession(storage, row) {
  validateScreening(row);
  const rows = readFestivalSessions(storage).filter(s => s.id !== row.id);
  required(rows.length < 2000, 'too many saved screenings');
  rows.push(Object.fromEntries(rowFields.map(k => [k, row[k]])));
  storage.setItem(SCREENINGS_KEY, JSON.stringify(rows));
}
export function removeFestivalSession(storage, id) {
  const rows = readFestivalSessions(storage).filter(s => s.id !== id);
  storage.setItem(SCREENINGS_KEY, JSON.stringify(rows));
}
function present(row, state, source, festivals, aliases = {}) {
  const start = startTime(row);
  // Exact venue aliases verified against each festival's official venue page.
  // These affect transfer warnings only, never movie/session merging or core data.
  const reviewed = { 'wmw-2026': { '光點華山': '光點華山電影館' },
    'tiaf-2026': { 'iFG遠雄廣場威秀': '台中iFG遠雄廣場威秀影城' } }[row.festivalId] || {};
  const venue = Object.hasOwn(reviewed, row.cinema) ? reviewed[row.cinema] : row.cinema;
  const venueKey = Object.hasOwn(aliases, venue) ? aliases[venue] : venue;
  return { ...row, kind: 'festival', key: 'festival:' + row.id, start, day: row.date, state, venueKey,
    festivalName: festivals.find(f => f.id === row.festivalId)?.name || row.festivalId,
    end: state === 'current' && row.endMins !== null ? start + (row.endMins - row.mins) * 60000 : null,
    tag: row.notes.join(' · '), fetchedAt: source?.fetchedAt || null, url: state === 'current' ? row.url : '', sourceUrl: row.url };
}
export function availableScreenings(feed, festivals, aliases = {}, now = Date.now()) {
  return feed.sources.flatMap(source => source.rows.map(row => present(row,
    startTime(row) <= now ? 'past' : ['unsupported', 'not-fetched', 'retired'].includes(sourceState(source, now)) ? 'missing' : sourceState(source, now), source, festivals, aliases)))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
export function resolveFestivalSessions(saved, feed, festivals, aliases = {}, now = Date.now()) {
  const rows = new Map(feed.sources.flatMap(s => s.rows.map(row => [row.id, row])));
  return saved.map(row => {
    const source = feed.sources.find(s => s.festivalId === row.festivalId);
    const current = rows.get(row.id);
    const sourceStatus = sourceState(source, now);
    const changed = current && screeningSignature(current) !== screeningSignature(row);
    const state = changed && sourceStatus === 'current' ? 'changed' : startTime(row) <= now ? 'past'
      : sourceStatus !== 'current' ? (['not-fetched', 'unsupported', 'retired', 'missing'].includes(sourceStatus) ? 'missing' : sourceStatus)
        : !current ? 'missing' : 'current';
    return { ...present(row, state, source, festivals, aliases), replacement: state === 'changed' ? current : null };
  }).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
export function matchesScreening(s, query) {
  const normalize = v => v.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  return normalize([s.movie, s.englishTitle, ...s.films.map(f => f.title)].join(' ')).includes(normalize(query));
}
