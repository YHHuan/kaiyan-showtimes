export const now = Date.parse('2099-01-01T12:00:00+08:00');
export function festivalFixture() {
  const festival = { id: 'test-one', name: '跨年測試影展', shortName: '跨年影展', startDate: '2098-12-30', endDate: '2099-01-05',
    cities: ['台北市'], url: 'https://example.org/fest', programUrl: 'https://example.org/program', sourceUrl: 'https://example.org/notice', checkedAt: '2098-12-25' };
  const catalog = { version: 1, festivals: [festival,
    { ...festival, id: 'test-two', name: '第二個測試影展', shortName: '第二影展', startDate: '2099-01-01', endDate: '2099-01-03', cities: ['台中市'], seriesId: 'test-series' },
    { ...festival, id: 'test-three', name: '二月測試影展', shortName: '二月影展', startDate: '2099-02-01', endDate: '2099-02-10' }] };
  const tuples = [[0, 0, 0, 1, 1, 0, 1410], [1, 1, 1, 0, 0, 3, 60], [0, 2, 0, 0, 0, 0, 1200],
    [0, 3, 0, 0, 0, 1, 1110], [0, 3, 0, 0, 0, 2, 1110]];
  const data = { cinemas: [['測試影城', '台北市'], ['測試藝文館', '台中市']], movies: [['晚場電影'], ['續場電影'], ['片長未提供'], ['雙入口合輯']],
    dates: ['2099-01-01', '2099-01-02'], halls: [null, '1廳'], tags: [null, '字幕版'],
    urls: ['https://example.org/book?date={d}', 'https://example.org/event/a', 'https://example.org/event/b', 'https://example.org/book?date={s}'],
    packed: tuples.map(t => t.map(x => x.toString(36)).join(',')).join(';'), meta: { 0: { d: 100 }, 1: { d: 90 }, 3: { d: 120 } },
    aliases: { 舊片名: '晚場電影' }, cinemaAliases: { 舊戲院: '測試影城' }, updatedAt: new Date(now).toISOString(),
    discovery: { version: 1, status: 'ready', series: [{ id: 'test-series' }] } };
  const saved = [
    { movie: '晚場電影', cinema: '測試影城', date: '2099-01-01', mins: 1410, hall: '1廳', tag: '字幕版' },
    { movie: '續場電影', cinema: '測試藝文館', date: '2099-01-02', mins: 60, hall: '', tag: '' },
    { movie: '片長未提供', cinema: '測試影城', date: '2099-01-01', mins: 1200, hall: '', tag: '' },
    { movie: '雙入口合輯', cinema: '測試影城', date: '2099-01-01', mins: 1110, hall: '', tag: '' },
    { movie: '本輪沒有的收藏', cinema: '測試影城', date: '2099-01-01', mins: 1000, hall: '', tag: '' }
  ];
  return { catalog, data, saved, tuples };
}
