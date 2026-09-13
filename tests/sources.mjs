import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAtmovies, parseSkcinemas, parseCenturyMovieEvidence } from '../lib/schedule-parsers.mjs';
import { identifyMovie, canonicalMetadata, normalizeMovieRecords } from '../lib/movie-identity.mjs';
import { parseAceShowtimes } from '../fetch/acecinema.mjs';
import { parseMiranew } from '../fetch/miranew.mjs';
import { versionSignature, foldTitle } from '../lib/common.mjs';

// 縮小的真實 HTML 結構：片名錨點可缺 </a>；版本文字另列 <li>，不在片名括號內。
const movieBlock = (title, code, length, tag, time) => `<ul id="theaterShowtimeTable">
  <li class="filmTitle"><img src="/images/icon_star_pink.gif"><a href="/movie/${code}/">${title}</li>
  <li><ul><li><img src="/images/cer_G.gif">片長：${length}分</li></ul>
  <ul>${tag ? `<li>${tag}</li>` : ''}<li>${time}</li><li class="theaterElse"><a>其他戲院(75)</a></li></ul></li>
  </ul><!-- theaterShowtimeBlock -->`;
const options = { code: 't02d04', region: 'a02', name: '台北天母新光影城', area: '台北市', expectedDate: '2026-09-13' };
const header = '<h3>2026/09/13 (日)</h3>';

test('來源 ID 區分真人／動畫，保留年份、4DX 與配音，不混用 metadata', () => {
  const html = header + movieBlock('驀然回首', 'fljp39094466', 100, '', '10：55')
    + movieBlock('驀然回首(2024)', 'fljp31711040', 57, '日語發音', '09：35')
    + movieBlock('蜘蛛人：重生日', 'fsptest', 145, '4DX版', '21：25');
  const { records } = parseAtmovies(html, options);
  assert.equal(records[0].movie, '驀然回首(真人版)');
  assert.equal(records[0].sourceMovieId, 'fljp39094466');
  assert.equal(records[0].sourceRuntimeMin, 100);
  assert.equal(records[1].movie, '驀然回首(動畫)');
  assert.equal(records[1].rawMovie, '驀然回首(2024)');
  assert.deepEqual(records[1].tags, ['日語發音']);
  assert.deepEqual(records[2].tags, ['4DX版']);
  const animation = canonicalMetadata('驀然回首', { matchVersion: 2, matchedTitle: '驀然回首', runtimeMin: 58 });
  assert.equal(animation.title, '驀然回首(動畫)');
  assert.equal(canonicalMetadata('驀然回首', { matchVersion: 3, matchedTitle: '驀然回首', runtimeMin: 90 }), null);
});

test('日期必須從頁面核對，僅循同館、合法、範圍內的已公布日期', () => {
  const html = header + `<a href="/showtime/t02d04/a02/20260914/">明天</a>
    <a href="/showtime/t02d04/a02/20260914/">重複</a><a href="/showtime/tOTHER/a02/20260915/">別館</a>
    <a href="/showtime/t02d04/a02/20261031/">太遠</a><a href="/showtime/t02d04/a02/20260931/">錯日</a>`
    + movieBlock('測試片', 'ftest', 100, '國語發音', '12：00');
  assert.deepEqual(parseAtmovies(html, options).dates, ['2026-09-13', '2026-09-14']);
  assert.throws(() => parseAtmovies(html, { ...options, expectedDate: '2026-09-14' }), /日期不符/);
  assert.throws(() => parseAtmovies('<h1>請稍後再試</h1>', options), /日期不符/);
  assert.throws(() => parseAtmovies(header, options), /解析不完整/);
  assert.equal(parseAtmovies(header + '<p>尚未公布場次</p>', options).records.length, 0);
});

test('同一來源 ID 的異名歸戶，未知同名版本不猜，版本矛盾不信任', () => {
  assert.equal(identifyMovie({ movie: '驀然回首', runtimeMin: 100 }).movie, '驀然回首(真人版)');
  assert.equal(identifyMovie({ movie: '驀然回首', runtimeMin: 101 }).movie, '驀然回首(真人版)');
  assert.equal(identifyMovie({ movie: '驀然回首', runtimeMin: 58 }).movie, '驀然回首(動畫)');
  assert.equal(identifyMovie({ movie: '驀然回首' }).uncertain, true);
  assert.equal(identifyMovie({ source: 'arthouse2', movie: '驀然回首', url: 'https://wonderful.movie.com.tw/movie/inner?id=2396' }).movie, '驀然回首(動畫)');
  assert.equal(identifyMovie({ source: 'arthouse2', movie: '驀然回首', url: 'https://wonderful.movie.com.tw/movie/inner?id=9999' }).uncertain, true);
  assert.equal(identifyMovie({ source: 'atmovies', sourceMovieId: 'fljp39094466', movie: '驀然回首(2024)', runtimeMin: 57 }).uncertain, true);
  assert.equal(identifyMovie({ movie: '驀然回首2' }).movie, '驀然回首2');
  assert.equal(identifyMovie({ movie: '超異能快感2', source: 'atmovies', sourceMovieId: 'fpen32588798' }).movie, '超異能快感：魔法之書');
  assert.equal(identifyMovie({ movie: '粽邪4', source: 'atmovies', sourceMovieId: 'frcn38633224' }).movie, '粽邪4：坤蒂拉娜');
  assert.equal(identifyMovie({ movie: '粽邪3' }).movie, '粽邪3');
  const same = normalizeMovieRecords([
    { source: 'atmovies', sourceMovieId: 'fother', movie: '尚未收錄的舊名稱', date: '2026-09-13', sourceRuntimeMin: 101 },
    { source: 'atmovies', sourceMovieId: 'fother', movie: '尚未收錄的新名稱', date: '2026-09-14', sourceRuntimeMin: 101 },
  ]);
  assert.equal(same[0].movie, same[1].movie);
  const cuts = normalizeMovieRecords([
    { source: 'other', sourceMovieId: '1', movie: '測試片', sourceRuntimeMin: 100 },
    { source: 'other', sourceMovieId: '1', movie: '測試片(加長版)', sourceRuntimeMin: 130 },
  ]);
  assert.notEqual(cuts[0].movie, cuts[1].movie);
  const localIds = normalizeMovieRecords([
    { source: 'skcinemas', cinema: '甲館', sourceMovieId: '1', movie: '不同電影甲' },
    { source: 'skcinemas', cinema: '乙館', sourceMovieId: '1', movie: '不同電影乙' },
  ]);
  assert.notEqual(localIds[0].movie, localIds[1].movie, '分館 ID 不保證全連鎖唯一');
  const metadata = { '驀然回首(動畫)': { matchVersion: 3, matchedTitle: '驀然回首(動畫)', runtimeMin: 57,
    sourceIds: [{ source: 'centuryasia', id: '123', rawTitle: '驀然回首', runtimeMin: 57 }] } };
  assert.equal(normalizeMovieRecords([{ source: 'centuryasia', sourceMovieId: '123', movie: '驀然回首' }], metadata)[0].movie, '驀然回首(動畫)');
  assert.equal(normalizeMovieRecords([{ source: 'centuryasia', sourceMovieId: 'DIFFERENT', movie: '驀然回首' }], metadata)[0].identityUncertain, true);
});

test('喜樂時代未標版本的片名，須由該館該 ID 的介紹頁確認片長', () => {
  const html = '<form action="./movie_timetable.aspx?ProgramID=0000244&amp;TimeDetail=True">'
    + '<div class="movie_news_fc"><span>驀然回首</span></div><li>片長：57分鐘</li></form>';
  assert.equal(parseCenturyMovieEvidence(html, { id: '0000244', movie: '驀然回首' }), 57);
  assert.throws(() => parseCenturyMovieEvidence(html, { id: '0000296', movie: '驀然回首' }), /未通過/);
  assert.throws(() => parseCenturyMovieEvidence(html, { id: '0000244', movie: '另一部電影' }), /未通過/);
});

test('王牌同名雙版本、美麗新 101 分鐘來源不再混淆；動畫版本標記不可移除', () => {
  const ace = (id, title, length) => `<div class="col-xs-12 padding_0 movie_list">
    <a href="/movie/dtl/${id}"><h3>${title}</h3></a><h4>Look Back</h4>
    <p class="txt_gray">${length} ｜ 普遍級</p><table><tr><th>2026/09/13</th><td>12:00</td></tr></table></div>`;
  const rows = normalizeMovieRecords(parseAceShowtimes(ace('895', '驀然回首', '1 時 40 分')
    + ace('884', '(經典重映)驀然回首', '57 分')));
  assert.deepEqual(rows.map(r => [r.sourceMovieId, r.movie, r.sourceRuntimeMin]), [
    ['895', '驀然回首(真人版)', 100], ['884', '驀然回首(動畫)', 57],
  ]);
  const payload = { Data: { CinemaGroup: [{ CinemaCName: '美麗新大直影城', MovieInfo: [
    { MovieCName: '驀然回首(普)', MovieLength: 101, ShowDateList: [
      { ShowDateISO: '2026-09-13', ShowTimeList: [{ SessionList: [{ ShowTime: '12:00' }] }] },
    ] },
  ] }] } };
  const embedded = JSON.stringify(JSON.stringify(payload)).slice(1, -1);
  const miranew = normalizeMovieRecords(parseMiranew(`var CinemaList = '${embedded}';`));
  assert.equal(miranew[0].movie, '驀然回首(真人版)');
  assert.equal(miranew[0].sourceRuntimeMin, 101);
  assert.notEqual(versionSignature('測試片(動畫)'), versionSignature('測試片(真人版)'));
  assert.equal(foldTitle('(動畫)測試片', () => true), null);
});

const skBlock = (date, cinemaId = '1005') => `<div class="pt-5 pb-3">
  <img src="/images/ui/age_0.png"><h3 class="">驀然回首(真人版)</h3><hr>
  <div><h5 class="d-inline"><strong>${date} (週日)</strong></h5><span class="badge rounded-pill bg-primary">數位版</span>
  <button data-action-url="/Booking/Booking?cinemaId=${cinemaId}&amp;filmId=HO00004925&amp;sessionId=277637"
    data-sessionId="277637" data-filmId="HO00004925"><strong>10:55</strong></button></div></div>`;
test('新版新光 HTML：電影、館別、日期、格式、來源 ID 及跨年皆驗證', () => {
  const opts = { id: '1005', name: options.name, area: options.area, today: '2026-09-13' };
  const rows = parseSkcinemas(skBlock('09-13') + skBlock('09-14'), opts);
  assert.deepEqual(rows.map(r => r.date), ['2026-09-13', '2026-09-14']);
  assert.equal(rows[0].movie, '驀然回首(真人版)');
  assert.equal(rows[0].hall, null, '未公布的廳名不能杜撰');
  assert.deepEqual(rows[0].tags, ['數位版']);
  assert.equal(rows[0].sourceMovieId, 'HO00004925');
  assert.match(rows[0].url, /Sessions\/Sessions\?cinemaId=1005$/);
  assert.throws(() => parseSkcinemas(skBlock('09-13', '1001'), opts), /錯誤館別/);
  assert.throws(() => parseSkcinemas('<h1>新光首頁</h1>', opts), /未取得/);
  assert.equal(parseSkcinemas(skBlock('01-01'), { ...opts, today: '2026-12-31' })[0].date, '2027-01-01');
});
