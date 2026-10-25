// Synthetic schedule structure; no copied upstream program prose or credentials.
export const goldenFestival = { id: 'golden-horse-2026', name: '測試金馬', shortName: '測試金馬',
  startDate: '2026-11-06', endDate: '2026-11-22', cities: ['台北市', '台中市', '高雄市'],
  url: 'https://www.goldenhorse.org.tw/', programUrl: 'https://www.goldenhorse.org.tw/film/programme/schedule/',
  sourceUrl: 'https://www.goldenhorse.org.tw/film/programme/schedule/', checkedAt: '2026-10-25' };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function goldenRow({ festival = goldenFestival, ticket = '200', movie = '晨光', members = [{ id: '100', title: '晨光' }],
  time = '23:30', hall = '11廳', runtime = 90, event = false, industry = false,
  marks = [['★', '影人出席'], ['', '影片拷貝非英語發音且無英文字幕']] } = {}) {
  const year = festival.startDate.slice(0, 4);
  const links = members.map(f => `<span class="film_url"><a href="https://www.goldenhorse.org.tw/film/${event ? 'notesevents/events' : 'programme/films'}/detail/${f.id}${event ? '' : '?search_year=' + year + '&search_category=FF'}">${escape(f.title)}</a></span>`).join('<br>');
  const title = industry ? movie + '( 業界限定場 )' : movie;
  const first = members.length === 1 ? links.replace(escape(members[0].title) + '</a>', escape(title) + '</a>') : escape(title);
  return `<tr class="text-center"><td class="room" style="display:none" rowspan="2"><span>${escape(hall)}<br><img src="https://example.org/access.png"></span></td>
    <td class="time">${time}</td><td class="data"><span class="h4 title">${first}</span>
    <span class="text-size-primary text-light">${runtime}分 | <span>${marks.map(([symbol, note]) => `<span title="${escape(note)}"> ${escape(symbol)} </span>`).join('')}</span>${event ? '' : ' | <span class="txt_rating_y">12+</span>'}</span>
    ${members.length > 1 ? '<span class="h4 title">' + links + '</span>' : ''}</td>
    <td class="add">${ticket === null ? '' : `<a href="https://tghff.tixcraft.com/ticket/area/${year.slice(2)}_ghmf/${ticket}">前往購票</a>`}</td></tr>`;
}
export function goldenHTML({ festival = goldenFestival, date = festival.startDate, rows = [goldenRow({ festival })], cinema = '台北信義威秀', days } = {}) {
  if (!days) {
    days = [];
    for (let stamp = Date.parse(festival.startDate); stamp <= Date.parse(festival.endDate); stamp += 86400000) {
      const [y, m, d] = new Date(stamp).toISOString().slice(0, 10).split('-'); days.push(y + '-' + Number(m) + '-' + Number(d));
    }
  }
  return `<html><head><title>台北金馬影展 Taipei Golden Horse Film Festival</title></head><body><div id="content">
    <form name="schedule"><input id="search_date" name="search_date" value="${date}"></form>
    <table class="table special show-list"><tbody><tr><th colspan="4">${cinema}</th></tr>${rows.join('')}</tbody></table>
    <div id="filmschedule0"></div></div><script>var availableDates = ${JSON.stringify(days)};</script>
    <script>globalThis.untrustedGoldenHorseScriptExecuted = true;</script></body></html>`;
}
