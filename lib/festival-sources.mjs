// Node-only adapters for public official schedules. Never execute source JavaScript.
import { parse, parseFragment } from 'parse5';
import { createHash } from 'node:crypto';
import { addDays, validDate, taipeiDate } from './festival-calendar.mjs';
import { validateScreening, validateScreeningSource, emptyScreeningFeed, recoverScreeningFeed, screeningSources, screeningSourceId } from './festival-screenings.mjs';

export class FestivalSourceError extends Error {}
export class FestivalNotReady extends FestivalSourceError {}
const check = (ok, message) => { if (!ok) throw new FestivalSourceError(message); };
const attr = (node, name) => node?.attrs?.find(a => a.name === name)?.value || '';
const hasClass = (node, name) => attr(node, 'class').split(/\s+/).includes(name);
function all(node, predicate) {
  const result = [];
  const walk = n => { if (predicate(n)) result.push(n); for (const child of n?.childNodes || []) walk(child); };
  walk(node); return result;
}
const byClass = (node, name) => all(node, n => hasClass(n, name));
const byTag = (node, name) => all(node, n => n?.tagName === name);
function rawText(node) {
  if (['script', 'style', 'template'].includes(node?.tagName)) return '';
  return node?.nodeName === '#text' ? node.value : (node?.childNodes || []).map(rawText).join('');
}
const label = node => rawText(node).replace(/\s+/g, ' ').trim();
const clean = value => label(parseFragment(typeof value === 'string' ? value : ''));
const sourceId = value => { check(/^[0-9]+$/.test(String(value)), 'invalid source ID'); return String(value); };
function minutes(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(time || '');
  check(match && Number(match[1]) < 24 && Number(match[2]) < 60, 'invalid official time');
  return Number(match[1]) * 60 + Number(match[2]);
}
function dated(monthDay, festival) {
  const match = /^(\d{1,2})[/.](\d{1,2})$/.exec(monthDay);
  check(match, 'invalid official date');
  const date = festival.startDate.slice(0, 4) + '-' + match[1].padStart(2, '0') + '-' + match[2].padStart(2, '0');
  check(validDate(date) && date >= festival.startDate && date <= festival.endDate, 'wrong edition date');
  return date;
}
const compositeId = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
function finish(rows, festival) {
  check(rows.length > 0, 'empty/incomplete official schedule');
  const ids = new Set();
  for (const s of rows) { validateScreening(s, festival); check(!ids.has(s.id), 'duplicate official session'); ids.add(s.id); }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.mins - b.mins || a.id.localeCompare(b.id));
}
export function parseTIAF(html, festival) {
  check(/<\/html\s*>/i.test(html), 'TIAF truncated response');
  const document = parse(html);
  check(label(byTag(document, 'title')[0]).includes(festival.startDate.slice(0, 4) + ' TIAF'), 'TIAF edition changed');
  const root = all(document, n => attr(n, 'id') === 'dayByDay')[0];
  check(root, 'TIAF timetable missing');
  const rows = [];
  for (const heading of byClass(root, 'theaterName')) {
    const siblings = heading.parentNode.childNodes;
    const table = siblings.slice(siblings.indexOf(heading) + 1).find(n => n.tagName);
    check(hasClass(table, 'timetable'), 'TIAF venue layout changed');
    const cinema = label(heading).replace(/ VIESHOW Cinemas Taichung Taroko Mall$/, '');
    for (const group of byClass(table, 'tr')) {
      const cells = byClass(group, 'showTime');
      if (!cells.length) continue;
      const header = byClass(group, 'th')[0], dateNode = byClass(header, 'date')[0];
      const day = /^(\d{1,2}\.\d{1,2})\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\.$/.exec(label(dateNode));
      check(day, 'TIAF date header changed');
      const date = dated(day[1], festival);
      check(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(date).getUTCDay()] === day[2], 'TIAF weekday/edition mismatch');
      const hall = label(header).replace(label(dateNode), '').trim();
      for (const cell of cells) {
        const movie = label(byTag(cell, 'b')[0]);
        const memberIds = attr(cell, 'data-films');
        check(!memberIds || /^\d+(,\d+)*$/.test(memberIds), 'TIAF program IDs changed');
        // Some public entries (e.g. the children's jury) publish no program ID.
        // The resulting identity also includes venue, hall, date and time below.
        const programId = memberIds ? memberIds.split(',').map(sourceId).sort().join('-') : 'label-' + compositeId([movie]);
        const mins = minutes(label(byClass(cell, 'time')[0]));
        const duration = /^(\d+)\s*min$/i.exec(label(byClass(cell, 'runtime')[0]));
        check(duration, 'TIAF runtime layout changed');
        const runtime = Number(duration[1]);
        const noteText = label(byClass(cell, 'note')[0]);
        const notes = [['★', '映前導讀'], ['☆', '映後座談'], ['▲', '免費入場'], ['※', '親子友善專場']]
          .filter(([symbol]) => noteText.includes(symbol)).map(([, value]) => value);
        rows.push({ id: festival.id + ':' + compositeId([programId, cinema, hall, date, mins]), festivalId: festival.id,
          programId, movie, englishTitle: label(byTag(cell, 'i')[0]), cinema, hall, date, mins,
          runtime, endMins: mins + runtime, endKind: 'runtime', notes, films: [], url: festival.programUrl });
      }
    }
  }
  check(rows.length === byClass(root, 'showTime').length, 'TIAF partially parsed timetable');
  return finish(rows, festival);
}
export function parseWMW(html, festival, dayScript) {
  check(/<\/html\s*>/i.test(html), 'WMW truncated response');
  // WMW offsets are relative to 08:00, not midnight. Reject a changed renderer.
  check(/dayStart\s*:\s*new Date\(null,\s*null,\s*null,\s*8,\s*0,\s*0\)/.test(dayScript), 'WMW time origin changed');
  const eventsJson = html.match(/\bvar events\s*=\s*(\[[^\n\r]*\]);/)?.[1];
  check(eventsJson, 'WMW events missing');
  const events = JSON.parse(eventsJson); // Never eval() / vm / import source code.
  check(Array.isArray(events) && events.length <= 3000, 'invalid WMW events');
  const document = parse(html), halls = new Map();
  for (const block of byClass(document, 'schedule')) {
    const date = dated(attr(block, 'data-date'), festival);
    const names = byTag(byClass(block, 'day-event-title')[0], 'span').map(label);
    const sites = byClass(block, 'day-events').map(n => attr(n, 'class').split(/\s+/).find(v => /^site\d+$/.test(v)));
    check(names.length && names.length === sites.length, 'WMW hall mapping changed');
    sites.forEach((site, i) => {
      const match = /^(光點華山)(\d+廳)$/.exec(names[i]);
      check(site && match && !halls.has(date + site), 'unknown WMW hall');
      halls.set(date + site, { cinema: match[1], hall: match[2] });
    });
  }
  const rows = [];
  for (const event of events) {
    check(typeof event.state === 'boolean', 'WMW visibility changed');
    if (!event.state) continue;
    const date = dated(event.date, festival), venue = halls.get(date + event.site);
    check(venue && Number.isInteger(event.start) && event.start >= 0 && Number.isInteger(event.times), 'invalid WMW session');
    const films = byTag(parseFragment(event.film), 'a').map(node => {
      const match = /^https:\/\/www\.wmw\.org\.tw\/tw\/film\/(\d+)$/.exec(attr(node, 'href'));
      check(match, 'WMW program link changed');
      return { id: match[1], title: label(node) };
    });
    check(films.length, 'WMW program missing');
    const programId = films.map(f => f.id).sort().join('-'), mins = 480 + event.start;
    const info = parseFragment(event.info), notes = [];
    for (const [cls, title] of [['fa-star', '映後座談'], ['fa-star-o', '映後 QA 影片'], ['fa-circle', '映前／映後導讀']]) {
      if (byClass(info, cls).length) notes.push(title);
    }
    rows.push({ id: festival.id + ':' + compositeId([programId, event.site, date, mins]), festivalId: festival.id,
      programId, movie: clean(event.custom_title) || films.map(f => f.title).join('＋'), englishTitle: '', ...venue, date, mins,
      runtime: event.times, endMins: mins + event.times, endKind: 'runtime', notes, films, url: festival.programUrl });
  }
  return finish(rows, festival);
}
export function kffPage(html) {
  const document = parse(html);
  const csrf = attr(byTag(document, 'meta').find(n => attr(n, 'name') === 'csrf-token'), 'content');
  const markJson = html.match(/\bconst _data_mark\s*=\s*(\[[^\n\r]*\]);/)?.[1];
  check(csrf && markJson, 'KFF public schedule layout changed');
  const marks = JSON.parse(markJson);
  check(Array.isArray(marks) && marks.length < 100, 'KFF marks changed');
  return { csrf, marks: new Map(marks.map(m => [sourceId(m.id), clean(m.title)])) };
}
export function parseKFFDay(data, festival, date, marks = new Map(), category = '108') {
  check(['108', '109'].includes(category), 'unsupported KFF category');
  const xr = category === '109', days = data?.[category];
  check(Array.isArray(days) && days.length === 1 && days[0].date === date && Array.isArray(days[0].cinemas), 'KFF date/category mismatch');
  const rows = [];
  for (const cinema of days[0].cinemas) {
    check(Array.isArray(cinema.auditoriums), 'KFF auditoriums missing');
    for (const hall of cinema.auditoriums) {
      check(Array.isArray(hall.programs), 'KFF programs missing');
      for (const group of hall.programs) {
        // XR's parent is a display group, not an extra screening. Every explicit
        // showtime_row entry is one official slot; never generate repetitions.
        const slots = xr ? group.showtime_row : [group];
        check(Array.isArray(slots) && slots.length > 0, 'KFF XR slots missing');
        if (xr) check(Number(group.cate) === 109 && group.date === date && Number(group.cinema) === Number(hall.id)
          && slots.some(s => String(s.id) === String(group.id)), 'KFF XR group identity changed');
        for (const s of slots) {
          const p = s.belong_program;
          check(s.date === date && Number(s.cate) === Number(category) && p && Number(p.cate) === Number(category)
            && Number(p.status) === 1 && Number(s.cinema) === Number(hall.id) && Number(s.belong) === Number(p.id), 'KFF session identity/status changed');
          if (xr) check(Number(s.belong) === Number(group.belong) && Number(p.id) === Number(group.belong_program?.id), 'KFF XR mixed programs');
          const mins = minutes(s.start_time), end = minutes(s.end_time);
          check(Array.isArray(p.film_row) && p.film_row.every(f => String(f.year) === festival.startDate.slice(0, 4)), 'KFF film edition mismatch');
          check(Array.isArray(s.mark), 'KFF marks missing');
          const runtime = /^\d+$/.test(String(p.time_length)) ? Number(p.time_length) : null;
          const notes = s.mark.map(m => marks.get(String(m)) || '官方註記 ' + sourceId(m) + '（請見官網）');
          // Award-winner programs can have a published slot before winners are known.
          if (!p.film_row.length) notes.push('本場片單尚未提供，請見官方');
          if (s.notes) notes.push(clean(s.notes));
          if (xr) {
            notes.unshift('XR 體驗');
            // The public table also displays the parent program's notes. Preserve
            // their scope explicitly; do not call capacity a count of tickets left.
            if (group.notes && clean(group.notes) !== clean(s.notes)) notes.push('官網節目欄備註（請依本場確認）：' + clean(group.notes));
          }
          rows.push({ id: festival.id + (xr ? ':xr:' : ':') + sourceId(s.id), festivalId: festival.id, programId: sourceId(p.id),
            movie: clean(p.title), englishTitle: clean(p.title_en), cinema: clean(cinema.title), hall: clean(hall.title), date, mins,
            runtime, endMins: end < mins ? end + 1440 : end, endKind: 'official', notes,
            films: p.film_row.map(f => ({ id: sourceId(f.id), title: clean(f.title) })),
            url: festival.programUrl + '?' + new URLSearchParams({ date, cate: category }) });
        }
      }
    }
  }
  // Explicit empty days are allowed inside an otherwise nonempty, fully fetched edition.
  const ids = new Set();
  for (const row of rows) {
    validateScreening(row, festival);
    check(!ids.has(row.id), 'duplicate official session'); ids.add(row.id);
  }
  return rows;
}
// The official timetable currently serves this specific no-data response. A
// network error or changed/full page is NOT evidence that no screenings exist.
// Do not guess a future DOM/API or ingest a cached classic/fantastic edition.
export function inspectGoldenHorseAvailability(html) {
  // parse5 defaults to scripting enabled, which hides the noscript anchor. This
  // is a read-only parse of the fallback, not execution of the redirect script.
  const document = parse(html, { scriptingEnabled: false });
  const anchors = byTag(document, 'a');
  const home = anchors.length === 1 && anchors.some(n => /^https:\/\/(?:www\.)?goldenhorse\.org\.tw\/?$/.test(attr(n, 'href'))
    && label(n) === '未自動轉跳，請按這裡。');
  const trigger = byTag(document, 'script').some(n => /^\s*\$\(document\)\.ready\(function\(\)\{fancyAlert\(['"]目前無相關資料['"],\s*function\(\)\{document\.location\.href=\(['"]https:\/\/(?:www\.)?goldenhorse\.org\.tw\/?['"]\);\}\);\}\);\s*$/.test(n.childNodes.map(c => c.value || '').join('')));
  if (home && trigger && label(document) === '未自動轉跳，請按這裡。') throw new FestivalNotReady('Golden Horse official timetable currently reports no data');
  throw new FestivalSourceError('Golden Horse response needs format/edition review; no unverified screenings imported');
}
export function editionDays(festival) {
  const days = [];
  for (let day = festival.startDate; day <= festival.endDate; day = addDays(day, 1)) {
    check(days.length < 35, 'festival fetch horizon too long'); days.push(day);
  }
  return days;
}
// Each source commits atomically: even one failed KFF day keeps the whole last-good
// edition, with its original timestamp. It is never relabeled as a partial success.
export async function refreshScreeningFeed({ festivals, previous, loaders, now = Date.now, onSource = () => {} }) {
  const sources = [];
  const recovered = screeningSources(recoverScreeningFeed(previous, festivals));
  for (const initial of screeningSources(emptyScreeningFeed(festivals))) {
    const festival = festivals.find(f => f.id === initial.festivalId);
    const id = screeningSourceId(initial);
    let prior = initial;
    const old = recovered.find(s => screeningSourceId(s) === id);
    if (old) prior = old;
    const attempt = now(), today = taipeiDate(attempt);
    if (!loaders[id]) { sources.push({ ...prior, status: 'unsupported' }); continue; }
    // Non-year-bound sites must not roll silently into the following edition.
    if (today > addDays(festival.endDate, 7) || today < addDays(festival.startDate, -90)) {
      sources.push({ ...prior, status: 'retired' }); continue;
    }
    let source;
    try {
      const rows = finish(await loaders[id](festival), festival);
      check(!prior.rows.length || rows.length >= prior.rows.length * 0.6, 'suspicious schedule loss');
      const fetchedAt = new Date(now()).toISOString();
      source = validateScreeningSource({ ...initial, status: 'ok', attemptedAt: new Date(attempt).toISOString(), fetchedAt, rows }, festival);
    } catch (error) {
      const waiting = initial.festivalId === 'golden-horse-2026' && error instanceof FestivalNotReady && !prior.rows.length;
      source = { ...(waiting ? initial : prior), status: waiting ? 'not-fetched' : 'failed', attemptedAt: new Date(attempt).toISOString() };
      // Log only controlled error messages in the caller, not upstream bodies/tokens.
      onSource(id, waiting ? 'pending' : 'failed', error instanceof FestivalSourceError || error.message?.startsWith('festival screenings:') ? error.message : 'network or response parsing error');
    }
    validateScreeningSource(source, festival); sources.push(source);
  }
  return { version: 1, sources: sources.filter(s => !s.sourceId), extraSources: sources.filter(s => s.sourceId) };
}
