import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateFestivals, scheduleIndex } from './lib/festival-calendar.mjs';
import { emptyScreeningFeed, validateScreeningSource } from './lib/festival-screenings.mjs';

// Optional, offline-only build. The caller contains failures after the main site is built.
export async function buildFestivalCalendar({ root, payload, enabled = true }) {
  if (!enabled) throw new Error('影展日曆已停用');
  const catalog = validateFestivals(JSON.parse(await readFile(join(root, 'catalog/festivals.json'), 'utf8')));
  const schedule = Object.fromEntries(['cinemas', 'movies', 'dates', 'halls', 'tags', 'urls', 'packed', 'aliases', 'cinemaAliases'].map(k => [k, payload[k]]));
  schedule.meta = Object.fromEntries(Object.entries(payload.meta || {}).map(([k, v]) => [k, { d: v.d || null }]));
  scheduleIndex(schedule);
  const seriesIds = payload.discovery?.status === 'ready' ? (payload.discovery.series || []).map(s => s.id) : [];
  // Optional feed corruption must not take the existing period/saved calendar down.
  const screenings = emptyScreeningFeed(catalog.festivals);
  try {
    const raw = await readFile(join(root, 'data/festivals/screenings.json'), 'utf8');
    if (raw.length > 10000000) throw new Error('oversized feed');
    const feed = JSON.parse(raw);
    if (feed.version !== 1 || !Array.isArray(feed.sources)) throw new Error('invalid feed');
    for (let i = 0; i < screenings.sources.length; i++) {
      const matches = feed.sources.filter(s => s?.festivalId === screenings.sources[i].festivalId);
      if (!matches.length) continue;
      try {
        if (matches.length !== 1) throw new Error('duplicate provider');
        screenings.sources[i] = validateScreeningSource(matches[0], catalog.festivals[i]);
      } catch { screenings.sources[i].status = 'failed'; }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') for (const s of screenings.sources) if (s.status !== 'unsupported') s.status = 'failed';
  }
  const data = { version: 1, generatedAt: payload.updatedAt, ...catalog, seriesIds, schedule, screenings };
  const out = join(root, 'out/festivals');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'data.json'), JSON.stringify(data));
  for (const file of ['festival-calendar.mjs', 'festival-screenings.mjs']) await copyFile(join(root, 'lib', file), join(out, file));
  // Keep the first release's module URL working for already-open/cached pages.
  await writeFile(join(out, 'model.mjs'), "export * from './festival-calendar.mjs';\n");
  for (const file of ['app.mjs', 'style.css', 'index.html']) await copyFile(join(root, 'web/festivals', file), join(out, file));
  return { festivals: catalog.festivals.length, screenings: screenings.sources.reduce((n, s) => n + s.rows.length, 0) };
}
