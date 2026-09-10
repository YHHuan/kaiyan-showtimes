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
    for (const file of ['build_site.mjs', 'site_template.html', 'lib/common.mjs', 'fetch/movie_meta.mjs']) {
      await copyFile(new URL('../' + file, import.meta.url), join(scratch, file));
    }
    const titles = [base, base + ' 加長版', base + ' 導演剪輯版', '舊快取測試片', '來源誤配測試片 加長版'];
    await writeFile(join(scratch, 'data', 'showtimes.json'), JSON.stringify(titles.map((movie, i) => ({
      movie, cinema: '測試影城', area: '台北市', date: '2099-01-01', time: '20:00', hall: '測試廳', tags: [], url: `https://example.org/movie/${i}`,
    }))));
    const meta = Object.fromEntries(titles.slice(0, 3).map((title, i) => [title, {
      title, matchedTitle: title, matchVersion: 2, runtimeMin: 90 + i * 30, synopsis: '版本 ' + i,
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
