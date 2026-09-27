import { readFile } from 'node:fs/promises';

export async function discoveryFixture() {
  const catalog = JSON.parse(await readFile(new URL('../catalog/discovery.json', import.meta.url), 'utf8'));
  const dateMap = { '2026-09-27': '2099-01-01', '2026-10-11': '2099-01-02', '2026-10-18': '2099-01-03', '2026-10-21': '2099-01-04' };
  catalog.series.forEach(s => {
    s.startDate = '2099-01-01'; s.endDate = '2099-01-04';
    s.screenings.forEach(r => { r.date = dateMap[r.date]; });
  });
  const films = [
    ['被偷走的情歌', 'Power Ballad', 98, '約翰卡尼'], ['實境誘捕', 'Primetime', 110, '蘭斯奧本海姆'],
    ['小王子', null, 108], ['高山遊民', 'The Rover', 74, '王安民'], ['尚未核對電影', null, null],
    ['另一部同名英文電影', 'The Rover', 103, 'David Michôd'], ['後座力', 'Pillion', 106, '哈利萊頓'],
    ['男歡女愛', 'Un homme et une femme', 103], ['無法無天', 'City of God', 130],
    ['【女性影展】焦點影人#1', null, null], ['被偷走的情歌 導演剪輯版', 'Power Ballad', 120],
  ];
  const tuples = [ // cinema, movie, date, minute, URL
    [0, 0, 0, 1200, 0], [1, 0, 0, 1260, 0], [0, 1, 0, 1200, 0], [0, 6, 0, 1200, 0],
    [0, 3, 0, 1200, 0], [0, 4, 0, 1200, 0], [0, 5, 0, 1200, 0],
    [0, 2, 0, 660, 0], [1, 2, 0, 660, 0], [0, 2, 0, 800, 0], [0, 2, 1, 660, 0],
    [0, 7, 2, 660, 0], [0, 8, 1, 660, 0], [2, 9, 2, 1000, 1], [2, 9, 3, 910, 1],
    [0, 10, 0, 1200, 0],
  ];
  const data = {
    cinemas: [['誠品電影院', '台北市'], ['台中測試影城', '台中市'], ['光點華山電影館', '台北市']],
    movies: films.map(f => [f[0], f[1], '普']), dates: Object.values(dateMap), halls: ['1廳'], tags: ['法文版'],
    urls: ['https://example.org/book?date={d}', 'https://www.opentix.life/event/2092557870742159361'],
    prices: [], geo: [], meta: Object.fromEntries(films.map((f, i) => [i, { d: f[2], r: f[3] }])), sprite: null,
    packed: tuples.map(([ci, mi, di, mins, ui]) => [ci, mi, di, 0, 0, ui, mins].map(n => n.toString(36)).join(',')).join(';'),
  };
  return { catalog, data };
}
