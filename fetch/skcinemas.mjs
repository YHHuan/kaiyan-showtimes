// 新光改版後公開場次直接寫在 HTML，不再等待舊 App API。
import { readFile } from 'node:fs/promises';
import { politeFetch, saveRecords, todayISO } from '../lib/common.mjs';
import { parseSkcinemas } from '../lib/schedule-parsers.mjs';
import { SK_CINEMAS, cinemaName } from '../lib/cinema-coverage.mjs';

const path = new URL('../data/skcinemas.json', import.meta.url).pathname;
let previous = [], status = {};
try { previous = JSON.parse(await readFile(path, 'utf8')); } catch {}
try { status = JSON.parse(await readFile(new URL('../data/_status.json', import.meta.url), 'utf8')); } catch {}
const records = [], cinemas = {};
for (const c of SK_CINEMAS) {
  const url = 'https://www.skcinemas.com/Sessions/Sessions?cinemaId=' + c.id;
  try {
    const html = await politeFetch(url, { timeoutMs: 12000 });
    const rows = parseSkcinemas(html, c);
    records.push(...rows);
    cinemas[c.name] = { state: 'ok', area: c.area, url };
    console.log('  ' + c.name + ': ' + rows.length + ' 筆 / ' + new Set(rows.map(r => r.date)).size + ' 天');
  } catch (e) {
    cinemas[c.name] = { state: 'failed', area: c.area, url, error: e.message.split('\n')[0] };
    records.push(...previous.filter(r => cinemaName(r.cinema) === c.name && r.date >= todayISO())
      .map(r => ({ ...r, fetchedAt: r.fetchedAt || status.skcinemas?.fetchedAt || '1970-01-01T00:00:00Z' })));
    console.log('  ' + c.name + ': ' + e.message + '；交由逐館備援補足');
  }
}
await saveRecords(path, records, { cinemas, parserVersion: 2 });
