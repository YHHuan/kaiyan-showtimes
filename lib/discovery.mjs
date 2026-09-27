// Optional, reviewed discovery metadata. Never changes movie identity or showtime rows.
import { readFile } from 'node:fs/promises';
import { matchKey, versionSignature } from './common.mjs';

const idOk = x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(x) && x !== 'all';
const textOk = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 300;
const dateOk = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)
  && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0, 10) === x;
const urlOk = x => {
  try { const u = new URL(x); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
};
const requireValue = (ok, message) => { if (!ok) throw new Error('discovery: ' + message); };
const listOk = (xs, test, min = 0) => Array.isArray(xs) && xs.length >= min && xs.length <= 1000 && xs.every(test);
function keys(record, allowed) {
  requireValue(record && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).every(k => allowed.includes(k)), 'invalid object / unknown field');
}
function unique(records) {
  requireValue(new Set(records.map(x => x.id)).size === records.length, 'duplicate ID');
}
function source(record) {
  requireValue(urlOk(record.url) && dateOk(record.checkedAt), 'invalid source URL / checkedAt');
}

export function validateCatalog(catalog) {
  keys(catalog, ['version', 'brands', 'works', 'series']);
  requireValue(catalog.version === 1, 'unsupported schema');
  for (const field of ['brands', 'works', 'series']) requireValue(listOk(catalog[field], x => !!x), 'invalid ' + field);
  for (const records of [catalog.brands, catalog.works, catalog.series]) unique(records);
  for (const brand of catalog.brands) {
    keys(brand, ['id', 'label', 'description', 'url', 'checkedAt']);
    requireValue(idOk(brand.id) && textOk(brand.label) && textOk(brand.description), 'invalid brand');
    source(brand);
  }
  const brandIds = new Set(catalog.brands.map(b => b.id));
  const workIds = new Set(catalog.works.map(w => w.id));
  for (const work of catalog.works) {
    keys(work, ['id', 'title', 'aliases', 'english', 'runtimeMin', 'directors', 'sources', 'checkedAt', 'brands']);
    requireValue(idOk(work.id) && textOk(work.title) && dateOk(work.checkedAt), 'invalid work');
    for (const field of ['aliases', 'english', 'directors']) requireValue(listOk(work[field] || [], textOk), 'invalid ' + field);
    requireValue(work.runtimeMin == null || (Number.isInteger(work.runtimeMin) && work.runtimeMin > 0 && work.runtimeMin <= 600), 'invalid runtime');
    requireValue(listOk(work.sources, urlOk, 1), 'work must have safe provenance');
    requireValue(listOk(work.brands, b => {
      keys(b, ['id', 'url']);
      return brandIds.has(b.id) && urlOk(b.url) && work.sources.includes(b.url);
    }), 'invalid membership provenance');
    unique(work.brands);
  }
  for (const series of catalog.series) {
    keys(series, ['id', 'label', 'description', 'url', 'checkedAt', 'startDate', 'endDate', 'screenings']);
    requireValue(idOk(series.id) && textOk(series.label) && textOk(series.description), 'invalid series');
    source(series);
    requireValue(dateOk(series.startDate) && dateOk(series.endDate) && series.startDate <= series.endDate, 'invalid series dates');
    requireValue(listOk(series.screenings, s => {
      keys(s, ['workId', 'cinema', 'date', 'time', 'halls', 'tags', 'url', 'checkedAt', 'bookingUrl']);
      source(s);
      return workIds.has(s.workId) && textOk(s.cinema) && dateOk(s.date)
        && s.date >= series.startDate && s.date <= series.endDate
        && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)
        && listOk(s.halls || [], textOk) && listOk(s.tags || [], textOk)
        && (!s.bookingUrl || urlOk(s.bookingUrl));
    }, 1), 'invalid screening scope');
  }
  return catalog;
}

// A local title is mandatory. English alone is not a work identifier (e.g. The Rover).
// Any available contradictory evidence vetoes a match. Missing evidence is unknown.
export function matchesWork(work, movie, meta = {}, runtimes = [], exactEvent = false) {
  const titles = [work.title, ...(work.aliases || [])];
  if (!titles.some(t => matchKey(t) === matchKey(movie[0]) && versionSignature(t) === versionSignature(movie[0]))) return false;
  if (/版本待確認/.test(movie[0])) return false;
  const english = (work.english || []).map(matchKey);
  const en = movie[1] && matchKey(movie[1]);
  if (en && english.length && !english.includes(en)) return false;
  const durations = [...runtimes, meta.d].filter(x => Number.isFinite(x) && x > 0);
  if (durations.length && Math.max(...durations) - Math.min(...durations) > 5) return false;
  if (work.runtimeMin && durations.some(d => Math.abs(d - work.runtimeMin) > 3)) return false;
  const directors = (work.directors || []).map(matchKey);
  const observedDirectors = String(meta.r || '').split('、').filter(Boolean).map(matchKey);
  const directorMatch = directors.length && observedDirectors.some(d => directors.includes(d));
  if (directors.length && observedDirectors.length && !directorMatch) return false;
  return !!(exactEvent || directorMatch || (work.runtimeMin && durations.length) || (en && english.includes(en)));
}

export function unpackDiscoveryRows(data) {
  return data.packed.split(';').filter(Boolean).flatMap(g => {
    const f = g.split(',');
    const [ci, mi, di, hi, ti, ui] = f.slice(0, 6).map(n => parseInt(n, 36));
    return f[6].split('.').map(t => ({ ci, mi, di, hi, ti, ui, mins: parseInt(t, 36) }));
  });
}

export function buildDiscovery(catalog, data, runtimeEvidence = new Map()) {
  validateCatalog(catalog);
  const rows = unpackDiscoveryRows(data);
  const workMovies = new Map(catalog.works.map(work => [work.id, data.movies.flatMap((movie, mi) =>
    matchesWork(work, movie, data.meta[mi], [...(runtimeEvidence.get(matchKey(movie[0])) || [])]) ? [mi] : [])]));
  // Two reviewed works matching the same movie is ambiguous, not two brand memberships.
  const claimCounts = new Map();
  for (const ids of workMovies.values()) for (const mi of ids) claimCounts.set(mi, (claimCounts.get(mi) || 0) + 1);
  for (const [id, ids] of workMovies) workMovies.set(id, ids.filter(mi => claimCounts.get(mi) === 1));
  const brands = catalog.brands.map(brand => {
    const entries = catalog.works.filter(w => w.brands.some(b => b.id === brand.id)).map(w => ({
      id: w.id, title: w.title, english: (w.english || [])[0] || '', movies: workMovies.get(w.id),
      url: w.brands.find(b => b.id === brand.id).url, checkedAt: w.checkedAt,
    }));
    return { ...brand, entries, movies: [...new Set(entries.flatMap(e => e.movies))] };
  });
  const series = catalog.series.map(({ screenings, ...series }) => {
    const entries = screenings.map(s => {
      const work = catalog.works.find(w => w.id === s.workId);
      const candidates = rows.flatMap((r, ri) => {
        if (data.cinemas[r.ci][0] !== s.cinema || data.dates[r.di] !== s.date
          || r.mins !== Number(s.time.slice(0, 2)) * 60 + Number(s.time.slice(3))
          || (s.halls?.length && !s.halls.includes(data.halls[r.hi]))
          || (s.tags?.length && !s.tags.every(t => String(data.tags[r.ti] || '').split('・').includes(t)))) return [];
        const booking = (data.urls[r.ui] || '').replace(/\{d\}/g, s.date).replace(/\{s\}/g, s.date.replace(/-/g, '/'));
        if (s.bookingUrl && booking !== s.bookingUrl) return [];
        if (claimCounts.get(r.mi) > 1) return [];
        // An exact official event URL + scoped screening can corroborate an otherwise missing runtime.
        const exactEvent = s.bookingUrl && matchesWork(work, data.movies[r.mi], data.meta[r.mi],
          [...(runtimeEvidence.get(matchKey(data.movies[r.mi][0])) || [])], true);
        if (!workMovies.get(work.id).includes(r.mi) && !exactEvent) return [];
        return [ri];
      });
      return { title: work.title, cinema: s.cinema, date: s.date, time: s.time,
        url: s.url, checkedAt: s.checkedAt, rows: candidates.length === 1 ? candidates : [] };
    });
    return { ...series, entries, rows: [...new Set(entries.flatMap(e => e.rows))] };
  });
  return { version: 1, status: 'ready', brands, series };
}

export async function loadDiscovery(path, data, runtimeEvidence, { enabled = true, warn = console.warn } = {}) {
  if (!enabled) return { version: 1, status: 'disabled', brands: [], series: [] };
  try {
    const content = await readFile(path, 'utf8');
    requireValue(content.length <= 2_000_000, 'catalog too large');
    return buildDiscovery(JSON.parse(content), data, runtimeEvidence);
  } catch (err) {
    warn('  片單／系列分類暫不可用；一般場次不受影響：' + err.message);
    return { version: 1, status: 'unavailable', brands: [], series: [] };
  }
}
