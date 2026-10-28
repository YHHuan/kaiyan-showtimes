import { cinemaName, selectScheduleRows } from './cinema-coverage.mjs';

// The normal multi-day floor stays in place. A smaller catalog can publish only
// when its fresh current-day coverage independently proves nationwide usability.
export function publicationHealth({ total, rows, status, coverage, history = {},
  healthySources, today, now = Date.now(), minTotal = 6000 }) {
  if (total >= minTotal) return { ok: true, basis: 'multi-day-volume', total, minTotal };

  const roster = new Set([...coverage.map(c => cinemaName(c.name)),
    ...Object.keys(history._cinemas || {}).map(cinemaName)]);
  const byName = new Map(coverage.map(c => [cinemaName(c.name), c]));
  const missing = [...roster].filter(name => !(byName.get(name)?.count > 0));
  const accepted = new Set(healthySources);
  const sessions = new Set(), freshCinemas = new Set();
  for (const r of selectScheduleRows(rows, status, now)) {
    const name = cinemaName(r.cinema), s = status[r.source], c = s?.cinemas?.[name];
    if (r.date !== today || !roster.has(name) || !accepted.has(r.source)) continue;
    if (c?.state === 'failed' || c?.failedDates?.includes(today) || s?.lastAttemptState === 'failed') continue;
    const stamp = Date.parse(r.fetchedAt || c?.lastSuccessAt || s?.fetchedAt || '');
    if (!Number.isFinite(stamp) || stamp > now || now - stamp > 26 * 3600000) continue;
    const time = /^(\d{1,2}):([0-5]\d)$/.exec(r.time || '');
    const movie = String(r.movieIdentity || r.movie || '').trim();
    if (!time || Number(time[1]) >= 48 || !movie) continue;
    sessions.add(JSON.stringify([name, movie, `${time[1].padStart(2, '0')}:${time[2]}`,
      r.hall || '', [...new Set(r.tags || [])].sort()]));
    freshCinemas.add(name);
  }
  const minimumToday = Math.ceil(minTotal / 2);
  const minimumCinemas = Math.ceil(roster.size * 0.8);
  const ok = roster.size >= 75 && missing.length === 0
    && freshCinemas.size >= minimumCinemas && sessions.size >= minimumToday;
  return { ok, basis: ok ? 'fresh-day-coverage' : 'insufficient-coverage', total, minTotal,
    roster: roster.size, missing, freshTodayCinemas: freshCinemas.size, minimumCinemas,
    freshTodaySessions: sessions.size, minimumToday };
}
