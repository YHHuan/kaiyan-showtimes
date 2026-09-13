// 經來源 ID／官方頁核實的作品對照，不以相似片名猜續集或改編版本。
import { matchKey, normTitle, versionSignature, trustedMovieMeta } from './common.mjs';

export const MOVIE_IDENTITIES = [
  { id: 'look-back-2026', title: '驀然回首(真人版)', aliases: ['驀然回首(真人版)', '驀然回首(2026)'],
    atmovies: ['fljp39094466'], runtimes: [100, 101], ambiguous: ['驀然回首'],
    evidence: ['https://www.atmovies.com.tw/movie/fljp39094466/', 'https://www.miranewcinemas.com/booking/timetable'] },
  { id: 'look-back-2024', title: '驀然回首(動畫)', aliases: ['驀然回首(動畫)', '驀然回首(動畫版)', '驀然回首(2024)'],
    atmovies: ['fljp31711040'], runtimes: [57, 58], ambiguous: ['驀然回首'],
    movieUrls: { arthouse2: ['https://wonderful.movie.com.tw/movie/inner?id=2396'] },
    evidence: 'https://www.atmovies.com.tw/movie/fljp31711040/' },
  { id: 'practical-magic-2', title: '超異能快感：魔法之書', aliases: ['超異能快感2', '超異能快感：魔法之書'],
    atmovies: ['fpen32588798'], evidence: 'https://www.atmovies.com.tw/movie/fpen32588798/' },
  { id: 'the-rope-curse-4', title: '粽邪4：坤蒂拉娜', aliases: ['粽邪4', '粽邪4：坤蒂拉娜'],
    atmovies: ['frcn38633224'], evidence: 'https://www.atmovies.com.tw/movie/frcn38633224/' },
];

// 僅不含歧義的別名可供收藏／舊連結遷移；裸名「驀然回首」不可自動指向任一版。
export const MOVIE_ALIASES = Object.fromEntries(MOVIE_IDENTITIES.flatMap(x => x.aliases.map(a => [a, x.title])));

export function identifyMovie(record) {
  const raw = normTitle(record.rawMovie || record.sourceTitle || record.movie || record.title);
  const key = matchKey(raw);
  const runtime = Number(record.sourceRuntimeMin || record.runtimeMin) || null;
  const sourceId = String(record.sourceMovieId || '');
  const explicit = MOVIE_IDENTITIES.find(x => x.aliases.some(a => matchKey(a) === key));
  const byId = (record.source === 'atmovies' && sourceId
    ? MOVIE_IDENTITIES.find(x => x.atmovies?.includes(sourceId)) : null)
    || MOVIE_IDENTITIES.find(x => x.movieUrls?.[record.source]?.includes(record.sourceUrl || record.url));
  const ambiguous = MOVIE_IDENTITIES.filter(x => x.ambiguous?.some(a => matchKey(a) === key));
  const tagYear = (record.tags || []).find(t => /^(2024|2026)$/.test(t));
  const byEvidence = ambiguous.filter(x => runtime ? x.runtimes?.includes(runtime) : tagYear && x.id.endsWith(tagYear));
  const chosen = byId || explicit || (byEvidence.length === 1 ? byEvidence[0] : null);
  const conflict = (byId && explicit && byId.id !== explicit.id)
    || (chosen?.runtimes && runtime && !chosen.runtimes.includes(runtime));
  if (conflict || (ambiguous.length && !chosen)) {
    return { movie: raw.replace(/\(版本待確認\)$/, '') + '(版本待確認)', uncertain: true, id: null };
  }
  if (chosen) return { movie: chosen.title, id: chosen.id, uncertain: false };
  return { movie: normTitle(record.movie || raw), id: null, uncertain: /版本待確認/.test(raw) };
}

export function canonicalRecord(record) {
  const result = identifyMovie(record);
  const out = { ...record, rawMovie: record.rawMovie || record.movie, movie: result.movie };
  if (result.id) out.movieIdentity = result.id; else delete out.movieIdentity;
  if (result.uncertain) out.identityUncertain = true; else delete out.identityUncertain;
  return out;
}

export function canonicalMetadata(title, record) {
  if (!trustedMovieMeta(title, record)) return null;
  const identity = identifyMovie({ ...record, sourceTitle: record.matchedTitle });
  if (identity.uncertain) return null;
  return { ...record, title: identity.movie, matchedTitle: identity.movie,
    ...(identity.id ? { movieIdentity: identity.id } : {}) };
}

// 開眼全站電影 ID 的文字變動可以歸戶；其他影城 ID 可能僅限分館，不能跨館猜測。
export function normalizeMovieRecords(records, metadata = {}) {
  const proofs = new Map();
  for (const [title, entry] of Object.entries(metadata)) {
    const m = canonicalMetadata(title, entry);
    if (!m) continue;
    for (const proof of m.sourceIds || []) {
      const key = `${proof.source}:${proof.id}`;
      if (proofs.has(key) && proofs.get(key)?.title !== m.title) proofs.set(key, null);
      else if (!proofs.has(key)) proofs.set(key, { ...proof, title: m.title });
    }
  }
  const canonical = records.filter(r => r && typeof r.movie === 'string').map(r => {
    const proof = proofs.get(`${r.source}:${r.sourceMovieId}`);
    // ID 與來源原片名都核對；不拿另一個來源的同名 metadata 猜這一筆。
    const verified = proof && matchKey(proof.rawTitle) === matchKey(r.rawMovie || r.movie);
    return canonicalRecord(verified ? { ...r, movie: proof.title, rawMovie: r.rawMovie || r.movie,
      sourceRuntimeMin: r.sourceRuntimeMin || proof.runtimeMin } : r);
  });
  const ids = new Map();
  for (const r of canonical) {
    if (r.source !== 'atmovies' || !r.sourceMovieId || r.movieIdentity || r.identityUncertain) continue;
    const id = `${r.source}:${r.sourceMovieId}`;
    if (!ids.has(id)) ids.set(id, []);
    ids.get(id).push(r);
  }
  for (const rows of ids.values()) {
    const versions = new Set(rows.map(r => versionSignature(r.movie)));
    const runtimes = rows.map(r => r.sourceRuntimeMin).filter(Number.isFinite);
    if (versions.size > 1 || (runtimes.length && Math.max(...runtimes) - Math.min(...runtimes) > 5)) continue;
    // 同 ID 跨日期改名，以最新日期的寫法為準；相同日期保持來源順序。
    const name = [...rows].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0].movie;
    for (const r of rows) r.movie = name;
  }
  return canonical;
}
