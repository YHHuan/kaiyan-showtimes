// 親親影城：官方頁面一次列出所有電影、日期、版本、影廳與時間。
import { politeFetch, saveRecords } from '../lib/common.mjs';
import { parseWeb5000Showtimes } from '../lib/web5000-showtimes.mjs';

const scheduleUrl = 'https://www.ccmovie.com.tw/product.php?_path=product_showtimes';
const html = await politeFetch(scheduleUrl);
const records = parseWeb5000Showtimes(html, {
  source: 'ccmovie',
  cinema: '親親影城',
  baseUrl: 'https://www.ccmovie.com.tw/',
  scheduleUrl,
  halls: {
    generally1: '一廳', generally2: '二廳', generally3: '三廳', generally5: '五廳',
    generally6: '六廳', generally7: '七廳', generally8: '八廳',
  },
});

await saveRecords(new URL('../data/ccmovie.json', import.meta.url).pathname, records);
