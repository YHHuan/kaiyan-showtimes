// Optional pure-code refresh, deliberately outside run-all's core source health.
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateFestivals } from '../lib/festival-calendar.mjs';
import { emptyScreeningFeed, recoverScreeningFeed, screeningSources, screeningSourceId, KFF_XR_SOURCE } from '../lib/festival-screenings.mjs';
import { parseTIAF, parseWMW, kffPage, parseKFFDay, inspectGoldenHorseAvailability, editionDays, refreshScreeningFeed, FestivalSourceError } from '../lib/festival-sources.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--cache-dir')) throw new Error('Usage: node fetch/festivals.mjs [--cache-dir PATH]');
const directory = args.length ? resolve(args[1]) : join(root, 'data/festivals');
const destination = join(directory, 'screenings.json');
const { festivals } = validateFestivals(JSON.parse(await readFile(join(root, 'catalog/festivals.json'), 'utf8')));
let previous;
try { previous = JSON.parse(await readFile(destination, 'utf8')); } catch { previous = emptyScreeningFeed(festivals); }
async function persist(feed) {
  await mkdir(directory, { recursive: true });
  const temp = destination + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(feed)); await rename(temp, destination);
}
// Persist an attempted/failed state first. A killed runner must not advertise an
// earlier cache as a successful refresh. Keep all last-good rows and timestamps.
const attempted = structuredClone(recoverScreeningFeed(previous, festivals));
const enabled = new Set(screeningSources(emptyScreeningFeed(festivals)).filter(s => s.status !== 'unsupported').map(screeningSourceId));
for (const source of screeningSources(attempted)) {
  if (enabled.has(screeningSourceId(source))) Object.assign(source, { status: 'failed', attemptedAt: new Date().toISOString() });
}
await persist(attempted);
const deadline = Date.now() + 180000;
async function request(url, options = {}, sourceDeadline = deadline) {
  const remaining = Math.min(12000, Math.min(deadline, sourceDeadline) - Date.now());
  if (remaining <= 0) throw new Error('festival request budget exhausted');
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(remaining),
    headers: { 'User-Agent': 'KaiyanShowtimes/1.0 (+https://github.com/YHHuan/kaiyan-showtimes)', ...options.headers } });
  if (!response.ok) { await response.body?.cancel(); throw new Error('official response unavailable'); }
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8000000) throw new Error('official response exceeded limit');
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks).toString('utf8'), headers: response.headers };
}
async function fetchKFF(f, category) {
  const sourceDeadline = Date.now() + (category === '108' ? 90000 : 60000);
  const page = await request(f.programUrl, {}, sourceDeadline), { csrf, marks } = kffPage(page.body);
  // Fresh anonymous session, exactly the request made by the public timetable.
  // Never persist or log these cookies/CSRF values. No user's login is used.
  const cookie = page.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
  const rows = [];
  for (const date of editionDays(f)) {
    if (Date.now() > sourceDeadline) throw new Error('KFF request budget exhausted');
    await delay(300);
    const result = await request('https://www.kff.tw/schedule/ajax', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-TOKEN': csrf, Cookie: cookie,
        Referer: f.programUrl, 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ select_cate: category, datepicker_date: date }) }, sourceDeadline);
    try { rows.push(...parseKFFDay(JSON.parse(result.body), f, date, marks, category)); }
    catch (error) {
      const reason = error instanceof FestivalSourceError || error.message?.startsWith('festival screenings:') ? error.message : 'invalid JSON';
      throw new FestivalSourceError('KFF ' + category + ' ' + date + ': ' + reason);
    }
  }
  return rows;
}
const loaders = {
  'tiaf-2026': async f => parseTIAF((await request(f.programUrl)).body, f),
  'wmw-2026': async f => {
    const html = (await request(f.programUrl)).body;
    const script = (await request('https://www.wmw.org.tw/assest/js/day.events.js')).body;
    return parseWMW(html, f, script);
  },
  'kff-2026': f => fetchKFF(f, '108'),
  [KFF_XR_SOURCE]: f => fetchKFF(f, '109'),
  'golden-horse-2026': async f => inspectGoldenHorseAvailability((await request(f.programUrl)).body)
};
const feed = await refreshScreeningFeed({ festivals, previous, loaders,
  onSource: (id, status, reason) => console.warn('[festivals] ' + id + ': ' + reason
    + (status === 'pending' ? '; waiting for official data, no invented rows' : '; retaining original last-good timestamp')) });
await persist(feed);
for (const source of screeningSources(feed)) console.log('[festivals]', screeningSourceId(source), source.status, source.rows.length + ' screenings', source.fetchedAt || 'no successful fetch');
if (screeningSources(feed).some(s => s.status === 'failed')) process.exitCode = 1;
