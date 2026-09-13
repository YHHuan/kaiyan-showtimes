// 本機只送公開場次 JSON；雲端不下載、checkout 或執行資料分支的程式。
import { SK_CINEMAS, cinemaName } from './cinema-coverage.mjs';
import { canonicalRecord } from './movie-identity.mjs';
import { validDate } from './schedule-parsers.mjs';

export const LOCAL_REPOSITORY = 'YHHuan/kaiyan-showtimes';
export const LOCAL_BRANCH = 'local-showtimes';
export const LOCAL_FILE = 'skcinemas.json';
export const LOCAL_URL = `https://raw.githubusercontent.com/${LOCAL_REPOSITORY}/${LOCAL_BRANCH}/${LOCAL_FILE}`;
export const MAX_SNAPSHOT_BYTES = 900_000;
export const MAX_LOCAL_AGE_MS = 72 * 3600000;
const FRESH_MS = 26 * 3600000;
const CLOCK_SKEW_MS = 5 * 60000;
export const skcinemasUrl = id => `https://www.skcinemas.com/Sessions/Sessions?cinemaId=${id}`;
export const taipeiDay = value => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

function objectKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`${label} 欄位不合格`);
}
function timestamp(value, now, label) {
  const time = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(time) || new Date(time).toISOString() !== value
      || time > now + CLOCK_SKEW_MS) throw new Error(`${label} 時間不合格`);
  return time;
}
function shortText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} 文字不合格`);
  }
  return value;
}

// 重建白名單物件，不把未知欄位（例如 cookie、token 或本機路徑）帶到公開分支。
export function snapshotRecord(row) {
  return {
    source: 'skcinemas', cinema: row.cinema, area: row.area,
    movie: row.movie, rawMovie: row.rawMovie || row.movie,
    sourceMovieId: row.sourceMovieId, sourceSessionId: row.sourceSessionId,
    sourceUrl: row.sourceUrl, date: row.date, time: row.time,
    rating: row.rating ?? null, hall: null, tags: row.tags || [], url: row.url, fetchedAt: row.fetchedAt,
  };
}

export function validateLocalSnapshot(input, { now = Date.now() } = {}) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  if (!text || Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw new Error('本機場次 JSON 過大或空白');
  const s = JSON.parse(text);
  objectKeys(s, ['schemaVersion', 'source', 'generatedAt', 'cinemas', 'records'], '快照');
  if (s.schemaVersion !== 1 || s.source !== 'skcinemas') throw new Error('本機快照版本或來源不符');
  const generatedAt = timestamp(s.generatedAt, now, '快照');
  if (!Array.isArray(s.cinemas) || s.cinemas.length !== SK_CINEMAS.length
      || !Array.isArray(s.records) || s.records.length > 5000) throw new Error('本機館別或場次數量不合格');
  const seen = new Set();
  const cinemas = s.cinemas.map(c => {
    objectKeys(c, ['id', 'name', 'area', 'state', 'attemptedAt', 'lastSuccessAt'], '館別');
    const known = SK_CINEMAS.find(k => k.id === c.id);
    if (!known || known.name !== c.name || known.area !== c.area || seen.has(c.id)
        || !['ok', 'failed'].includes(c.state)) throw new Error('本機回傳未知或重複館別');
    seen.add(c.id);
    const attempt = timestamp(c.attemptedAt, now, '館別嘗試');
    if (attempt > generatedAt) throw new Error('館別嘗試晚於快照');
    if (c.lastSuccessAt !== null) {
      if (timestamp(c.lastSuccessAt, now, '館別成功') > attempt) throw new Error('成功時間晚於嘗試');
    } else if (c.state === 'ok') throw new Error('成功館別沒有成功時間');
    return { ...known, state: c.state, attemptedAt: c.attemptedAt, lastSuccessAt: c.lastSuccessAt };
  });
  const sessionKeys = new Set();
  const records = s.records.map(r => {
    objectKeys(r, ['source', 'cinema', 'area', 'movie', 'rawMovie', 'sourceMovieId', 'sourceSessionId',
      'sourceUrl', 'date', 'time', 'rating', 'hall', 'tags', 'url', 'fetchedAt'], '場次');
    const c = cinemas.find(k => k.name === r.cinema);
    if (!c || r.area !== c.area || r.source !== 'skcinemas'
        || r.url !== skcinemasUrl(c.id) || r.sourceUrl !== r.url || r.hall !== null) {
      throw new Error('場次館別、來源或連結不合格');
    }
    const fetchedAt = timestamp(r.fetchedAt, now, '場次');
    if (r.fetchedAt !== c.lastSuccessAt || fetchedAt > generatedAt) throw new Error('場次原始時間與館別不符');
    if (!validDate(r.date) || r.date < taipeiDay(fetchedAt)
        || Date.parse(r.date) - Date.parse(taipeiDay(fetchedAt)) > 90 * 86400000
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) throw new Error('場次日期或時刻不合格');
    for (const field of ['sourceMovieId', 'sourceSessionId']) {
      if (typeof r[field] !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(r[field])) throw new Error('場次來源 ID 不合格');
    }
    shortText(r.movie, 240, '片名'); shortText(r.rawMovie, 240, '原始片名');
    if (!Array.isArray(r.tags) || r.tags.length > 12) throw new Error('場次標籤不合格');
    r.tags.forEach(t => shortText(t, 120, '標籤'));
    if (![null, '普遍級', '保護級', '輔12級', '輔15級', '限制級'].includes(r.rating)) throw new Error('分級不合格');
    const key = `${c.id}|${r.sourceSessionId}`;
    if (sessionKeys.has(key)) throw new Error('本機快照有重複場次 ID');
    sessionKeys.add(key);
    return snapshotRecord(canonicalRecord(r));
  });
  for (const c of cinemas) {
    if (c.state === 'ok' && !records.some(r => r.cinema === c.name)) throw new Error('成功館別卻沒有場次');
  }
  return { schemaVersion: 1, source: 'skcinemas', generatedAt: s.generatedAt, cinemas, records };
}

// Windows 登入／補跑可多次觸發，但每個 05:05 / 17:05 時段成功一次就略過。
export function latestLocalSlot(now = Date.now()) {
  const day = taipeiDay(now);
  const morning = Date.parse(`${day}T05:05:00+08:00`);
  const evening = Date.parse(`${day}T17:05:00+08:00`);
  return now >= evening ? evening : now >= morning ? morning : evening - 86400000;
}
export const localUploadDue = (lastPublishedAt, now = Date.now()) => {
  const last = Date.parse(lastPublishedAt);
  return !Number.isFinite(last) || last > now + CLOCK_SKEW_MS || last < latestLocalSlot(now);
};

export function mergeLocalSnapshot(snapshot, currentRows, currentSource = {}, { now = Date.now() } = {}) {
  const s = validateLocalSnapshot(snapshot, { now });
  let records = [...currentRows];
  const cinemas = { ...currentSource.cinemas };
  const imported = [];
  for (const c of s.cinemas) {
    const age = now - Date.parse(c.lastSuccessAt);
    if (!c.lastSuccessAt || age > MAX_LOCAL_AGE_MS) continue;
    const incoming = s.records.filter(r => r.cinema === c.name && r.date >= taipeiDay(now));
    if (!incoming.length) continue;
    const before = records.filter(r => cinemaName(r.cinema) === c.name);
    const beforeTime = Math.max(-Infinity, ...before.map(r => Date.parse(r.fetchedAt || currentSource.cinemas?.[c.name]?.lastSuccessAt || '1970-01-01T00:00:00Z')));
    if (beforeTime > Date.parse(c.lastSuccessAt)) continue; // 本輪直接抓到的官方資料更新，不倒退。
    const fresh = c.state === 'ok' && age <= FRESH_MS;
    records = records.filter(r => cinemaName(r.cinema) !== c.name).concat(incoming.map(canonicalRecord));
    const dates = [...new Set(incoming.map(r => r.date))].sort();
    cinemas[c.name] = {
      area: c.area, url: skcinemasUrl(c.id), count: incoming.length, dates,
      state: fresh ? 'ok' : 'failed', attemptedAt: c.attemptedAt, lastSuccessAt: c.lastSuccessAt,
      fetchMethod: 'local-snapshot', failedDates: fresh ? [] : [...new Set([taipeiDay(now), ...dates])].sort(),
    };
    imported.push(c.name);
  }
  if (!imported.length) return { records: currentRows, source: currentSource, imported };
  const stamps = records.map(r => r.fetchedAt).filter(t => Number.isFinite(Date.parse(t))).sort();
  return {
    records, imported,
    source: { ...currentSource, fetchedAt: stamps.at(-1) || currentSource.fetchedAt,
      count: records.length, parserVersion: 2, cinemas, localSnapshotAt: s.generatedAt },
  };
}
