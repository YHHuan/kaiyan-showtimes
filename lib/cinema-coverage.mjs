export const CINEMA_ALIASES = {
  台北獅子林新光影城: '台北新光影城', 桃園青埔新光影城: '桃園新光影城',
  台中中港新光影城: '台中新光影城', 台南西門新光影城: '台南新光影城',
};
export const cinemaName = name => Object.hasOwn(CINEMA_ALIASES, name) ? CINEMA_ALIASES[name] : name;
const AREA_ALIASES = {
  臺北市: '台北市', 臺中市: '台中市', 臺南市: '台南市', 臺東縣: '台東縣',
  花蓮市: '花蓮縣', 台東市: '台東縣', 臺東市: '台東縣',
};
export const areaName = name => Object.hasOwn(AREA_ALIASES, name) ? AREA_ALIASES[name] : name;
export const SK_CINEMAS = [
  { id: '1001', name: '台北新光影城', area: '台北市' },
  { id: '1005', name: '台北天母新光影城', area: '台北市' },
  { id: '1004', name: '桃園新光影城', area: '桃園市' },
  { id: '1003', name: '台中新光影城', area: '台中市' },
  { id: '1002', name: '台南新光影城', area: '台南市' },
];

export function freshCinema(status, source, name, now = Date.now(), hours = 26) {
  const s = status[source], c = s?.cinemas?.[cinemaName(name)];
  return !!c && c.state === 'ok' && Number.isFinite(Date.parse(c.lastSuccessAt))
    && now - Date.parse(c.lastSuccessAt) <= hours * 3600000;
}

export function usableRows(rows, status, now = Date.now()) {
  return rows.filter(r => {
    const s = status[r.source], c = s?.cinemas?.[cinemaName(r.cinema)];
    const stamp = r.fetchedAt || c?.lastSuccessAt || s?.fetchedAt;
    return !stamp || (Number.isFinite(Date.parse(stamp)) && now - Date.parse(stamp) <= 72 * 3600000);
  }).map(r => ({ ...r, cinema: cinemaName(r.cinema), area: areaName(r.area) }));
}

// 備援逐館逐日頂替；同一天有新鮮官方資料時不重複列兩套廳別／標籤。
export function selectScheduleRows(rows, status, now = Date.now()) {
  const usable = usableRows(rows, status, now);
  const preferred = new Set(usable.filter(r => r.source !== 'atmovies'
    && freshCinema(status, r.source, r.cinema, now)).map(r => `${r.cinema}|${r.date}`));
  const ages = new Map();
  for (const r of usable) {
    const key = `${r.cinema}|${r.date}`;
    if (!ages.has(key)) ages.set(key, { official: -Infinity, backup: -Infinity });
    const age = ages.get(key), kind = r.source === 'atmovies' ? 'backup' : 'official';
    age[kind] = Math.max(age[kind], Date.parse(r.fetchedAt || status[r.source]?.cinemas?.[r.cinema]?.lastSuccessAt || status[r.source]?.fetchedAt || '1970-01-01T00:00:00Z'));
  }
  return usable.filter(r => {
    const key = `${r.cinema}|${r.date}`, age = ages.get(key);
    if (age.backup === -Infinity || age.official === -Infinity) return true;
    const useOfficial = preferred.has(key) || age.official > age.backup;
    return (r.source !== 'atmovies') === useOfficial;
  });
}

export function cinemaCoverage(rows, status, today, now = Date.now()) {
  const table = new Map();
  function get(name, area = '', url = '') {
    name = cinemaName(name);
    area = areaName(area);
    if (!table.has(name)) table.set(name, { name, area, url, dates: [], count: 0, movies: 0, sources: [],
      lastSuccessAt: null, failedDates: [], state: 'missing' });
    const c = table.get(name); c.area ||= area; c.url ||= url; return c;
  }
  for (const [source, s] of Object.entries(status)) {
    for (const [name, details] of Object.entries(s.cinemas || {})) {
      const c = get(name, details.area, details.url);
      if (details.lastSuccessAt > (c.lastSuccessAt || '')) c.lastSuccessAt = details.lastSuccessAt;
      for (const d of details.failedDates || []) if (!c.failedDates.includes(d)) c.failedDates.push(d);
      if (details.state === 'failed' && !c.failedDates.includes(today)) c.failedDates.push(today);
    }
  }
  const movieSets = new Map();
  const successfulDates = new Map();
  for (const r of selectScheduleRows(rows, status, now)) {
    const c = get(r.cinema, r.area, r.url);
    if (!c.dates.includes(r.date)) c.dates.push(r.date);
    if (!c.sources.includes(r.source)) c.sources.push(r.source);
    const sourceCinema = status[r.source]?.cinemas?.[c.name];
    if (sourceCinema?.state !== 'failed' && !sourceCinema?.failedDates?.includes(r.date)) {
      if (!successfulDates.has(c.name)) successfulDates.set(c.name, new Set());
      successfulDates.get(c.name).add(r.date);
    }
    const stamp = r.fetchedAt || status[r.source]?.fetchedAt;
    if (stamp > (c.lastSuccessAt || '')) c.lastSuccessAt = stamp;
    if (r.date >= today) {
      c.count++;
      if (!movieSets.has(c.name)) movieSets.set(c.name, new Set());
      movieSets.get(c.name).add(r.movieIdentity || r.movie);
    }
  }
  for (const c of table.values()) {
    c.dates.sort(); c.movies = movieSets.get(c.name)?.size || 0;
    c.failedDates = c.failedDates.filter(d => !successfulDates.get(c.name)?.has(d));
    c.state = !c.count ? 'missing' : c.failedDates.some(d => d >= today) ? 'partial'
      : !c.dates.includes(today) ? 'no-today' : !c.dates.some(d => d > today) ? 'today-only' : 'ok';
  }
  return [...table.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));
}
