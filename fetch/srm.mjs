// 日日新影城：官方頁面一次列出所有電影、日期、版本、影廳與時間。
import { politeFetch, saveRecords } from '../lib/common.mjs';
import { parseWeb5000Showtimes } from '../lib/web5000-showtimes.mjs';

const scheduleUrl = 'https://srm.com.tw/product.php?_path=product_showtimes';
const html = await politeFetch(scheduleUrl);
const records = parseWeb5000Showtimes(html, {
  source: 'srm',
  cinema: '日日新影城',
  baseUrl: 'https://srm.com.tw/',
  scheduleUrl,
  halls: { generally: '一般廳', star: '星光廳', master: '至尊廳' },
});

await saveRecords(new URL('../data/srm.json', import.meta.url).pathname, records);
