import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { matchKey, foldTitle, resolveMovieKey, truncatedTitleKey, trustedMovieMeta } from '../lib/common.mjs';

const base = '一部片名超過八個字的電影';
test('剪輯、語言、年份保留；標點與重映標示可歸戶', () => {
  for (const version of ['加長版', '導演剪輯版', '完整版', '特別版', '未刪減版', '國語版', '日語版', '1995', '2026']) {
    assert.notEqual(matchKey(base), matchKey(`${base} (${version})`), version);
    assert.equal(matchKey(`${base}（${version}）`), matchKey(`${base} ${version}`));
  }
  assert.equal(matchKey('愛重奏(2026重映)'), matchKey('愛重奏.'));
  assert.equal(matchKey('攻殼機動隊(1995)4K數位修復版'), matchKey('攻殼機動隊 (1995)'));
});

test('特別場歸戶及截斷補全不能跨版本或任意選一個續集', () => {
  const hasBase = (t) => matchKey(t) === matchKey(base);
  for (const title of [`(導演剪輯版)${base}`, `《${base}》加長版`, `【1995】${base}`, `國語 ${base}`]) {
    assert.equal(foldTitle(title, hasBase), null, title);
  }
  assert.equal(foldTitle(`（DBOX特別場）${base}`, hasBase)?.base, base);
  assert.equal(foldTitle(`IMAX ${base}`, hasBase)?.base, base);
  assert.equal(truncatedTitleKey(matchKey(base), [matchKey(`${base}加長版`)]), null);
  assert.equal(truncatedTitleKey(matchKey(base), [matchKey(`${base}2`)]), null);
  const short = matchKey('電影蠟筆小新：奇奇怪怪！我的妖怪');
  const full = matchKey('電影蠟筆小新：奇奇怪怪！我的妖怪假期');
  assert.equal(truncatedTitleKey(short, [short, full]), full);
  assert.equal(truncatedTitleKey(short, [full, short + '旅程']), null);
});

test('metadata 不以互相包含猜身分，也不採用缺乏來源片名的舊快取', () => {
  const candidates = new Map([[matchKey(base), {}]]);
  assert.equal(resolveMovieKey(`${base} 加長版`, candidates), null);
  assert.equal(resolveMovieKey(`${base} 2`, candidates), null);
  assert.equal(resolveMovieKey(`（DBOX特別場）${base}`, candidates), matchKey(base));
  assert.equal(trustedMovieMeta(base, { title: base, runtimeMin: 100 }), false);
  assert.equal(trustedMovieMeta(base, { matchVersion: 2, matchedTitle: base }), true);
  assert.equal(trustedMovieMeta(base, { matchVersion: 2, matchedTitle: base + ' 加長版' }), false);
  assert.equal(trustedMovieMeta(base + ' 加長版', { matchVersion: 2, matchedTitle: base }), false);
});

test('實際建站仍分開原版與剪輯版，且只帶入經核對的各自片長', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'kaiyan-identity-'));
  try {
    await mkdir(join(scratch, 'data'));
    await mkdir(join(scratch, 'lib'));
    await mkdir(join(scratch, 'fetch'));
    for (const file of ['build_site.mjs', 'site_template.html', 'lib/common.mjs', 'lib/movie-identity.mjs', 'lib/cinema-coverage.mjs', 'fetch/movie_meta.mjs']) {
      await copyFile(new URL('../' + file, import.meta.url), join(scratch, file));
    }
    const titles = [base, base + ' 加長版', base + ' 導演剪輯版', '舊快取測試片', '來源誤配測試片 加長版'];
    await writeFile(join(scratch, 'data', 'showtimes.json'), JSON.stringify(titles.map((movie, i) => ({
      movie, cinema: '測試影城', area: '台北市', date: '2099-01-01', time: '20:00', hall: '測試廳', tags: [], url: `https://example.org/movie/${i}`,
    }))));
    const meta = Object.fromEntries(titles.slice(0, 3).map((title, i) => [title, {
      title, matchedTitle: title, matchVersion: 3, runtimeMin: 90 + i * 30, synopsis: '版本 ' + i,
    }]));
    meta[titles[3]] = { runtimeMin: 123 };
    meta[titles[4]] = { matchVersion: 2, matchedTitle: '來源誤配測試片', runtimeMin: 124 };
    await writeFile(join(scratch, 'data', 'movie_meta.json'), JSON.stringify(meta));
    execFileSync(process.execPath, [join(scratch, 'build_site.mjs')], { cwd: scratch, stdio: 'pipe' });
    const html = await readFile(join(scratch, 'out', 'index.html'), 'utf8');
    const data = JSON.parse(html.match(/(?:const|var) DATA\s*=\s*(\{[^\n]+\});/)[1]);
    assert.equal(data.movies.length, 5, '建站的後續截斷合併不能重新把版本合回去');
    for (let i = 0; i < 3; i++) {
      const mi = data.movies.findIndex((m) => m[0] === titles[i]);
      assert.equal(data.meta[mi].d, 90 + i * 30);
    }
    for (const title of titles.slice(3)) {
      const mi = data.movies.findIndex((m) => m[0] === title);
      assert.equal(data.meta[mi], undefined, '不可信片長與簡介不可帶到前端');
    }
    // 新版快取通過核對後，部署預檢必須跳過抓取，不能每次重建都重打來源。
    await writeFile(join(scratch, 'data', 'movie_meta.json'), JSON.stringify({ [base]: meta[base] }));
    const output = execFileSync(process.execPath, [join(scratch, 'fetch', 'movie_meta.mjs'), '--if-needed'], { cwd: scratch, encoding: 'utf8' });
    assert.match(output, /沿用本輪快取/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('實際建站以來源 ID 拆開驀然回首，天母真人場不能共用旧動畫資料', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'kaiyan-look-back-'));
  try {
    await mkdir(join(scratch, 'data'));
    await mkdir(join(scratch, 'lib'));
    for (const file of ['build_site.mjs', 'site_template.html', 'lib/common.mjs', 'lib/movie-identity.mjs', 'lib/cinema-coverage.mjs']) {
      await copyFile(new URL('../' + file, import.meta.url), join(scratch, file));
    }
    const baseRow = { source: 'atmovies', area: '台北市', date: '2099-01-01', time: '10:55', tags: [], url: 'https://example.org/book' };
    const records = [
      { ...baseRow, cinema: '台北天母新光影城', movie: '驀然回首', sourceMovieId: 'fljp39094466', sourceRuntimeMin: 100 },
      { ...baseRow, cinema: '王牌映画影城', movie: '驀然回首(2024)', sourceMovieId: 'fljp31711040', sourceRuntimeMin: 57 },
      { ...baseRow, cinema: '來源缺識別資訊的影城', movie: '驀然回首' },
    ];
    await writeFile(join(scratch, 'data', 'atmovies.json'), JSON.stringify(records));
    await writeFile(join(scratch, 'data', 'movie_meta.json'), JSON.stringify({
      '驀然回首': { matchVersion: 2, matchedTitle: '驀然回首', runtimeMin: 58, synopsis: '僅屬於動畫的介紹', directors: ['押山清高'] },
    }));
    execFileSync(process.execPath, [join(scratch, 'build_site.mjs')], { cwd: scratch, stdio: 'pipe' });
    const html = await readFile(join(scratch, 'out', 'index.html'), 'utf8');
    const data = JSON.parse(html.match(/(?:const|var) DATA\s*=\s*(\{[^\n]+\});/)[1]);
    const live = data.movies.findIndex(m => m[0] === '驀然回首(真人版)');
    const animation = data.movies.findIndex(m => m[0] === '驀然回首(動畫)');
    const uncertain = data.movies.findIndex(m => m[0] === '驀然回首(版本待確認)');
    assert.equal(data.movies.length, 3);
    assert.ok(live >= 0 && animation >= 0 && uncertain >= 0);
    assert.equal(data.meta[live].d, 100);
    assert.equal(data.meta[animation].d, 58);
    assert.doesNotMatch(JSON.stringify(data.meta[live]), /僅屬於動畫|押山清高/);
    assert.match(JSON.stringify(data.meta[animation]), /僅屬於動畫/);
    assert.equal(data.meta[uncertain], undefined);
    const tianmu = data.cinemas.findIndex(c => c[0] === '台北天母新光影城');
    const groups = data.packed.split(';').map(g => g.split(',').map(v => parseInt(v, 36)));
    assert.deepEqual(groups.filter(g => g[0] === tianmu).map(g => g[1]), [live]);
    assert.equal(data.aliases['驀然回首'], undefined, '舊收藏的歧義裸名不可自動選版本');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
