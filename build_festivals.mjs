import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateFestivals, scheduleIndex } from './lib/festival-calendar.mjs';

// Optional, offline-only build. The caller contains failures after the main site is built.
export async function buildFestivalCalendar({ root, payload, enabled = true }) {
  if (!enabled) throw new Error('影展日曆已停用');
  const catalog = validateFestivals(JSON.parse(await readFile(join(root, 'catalog/festivals.json'), 'utf8')));
  const schedule = Object.fromEntries(['cinemas', 'movies', 'dates', 'halls', 'tags', 'urls', 'packed', 'aliases', 'cinemaAliases'].map(k => [k, payload[k]]));
  schedule.meta = Object.fromEntries(Object.entries(payload.meta || {}).map(([k, v]) => [k, { d: v.d || null }]));
  scheduleIndex(schedule);
  const seriesIds = payload.discovery?.status === 'ready' ? (payload.discovery.series || []).map(s => s.id) : [];
  const data = { version: 1, generatedAt: payload.updatedAt, ...catalog, seriesIds, schedule };
  const out = join(root, 'out/festivals');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'data.json'), JSON.stringify(data));
  await copyFile(join(root, 'lib/festival-calendar.mjs'), join(out, 'model.mjs'));
  for (const file of ['app.mjs', 'style.css', 'index.html']) await copyFile(join(root, 'web/festivals', file), join(out, file));
  return { festivals: catalog.festivals.length };
}
