import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { politeFetch } from '../lib/common.mjs';
import { SK_CINEMAS } from '../lib/cinema-coverage.mjs';
import { parseSkcinemas } from '../lib/schedule-parsers.mjs';
import { LOCAL_REPOSITORY, LOCAL_BRANCH, LOCAL_FILE, MAX_LOCAL_AGE_MS, localUploadDue,
  validateLocalSnapshot, snapshotRecord, skcinemasUrl, taipeiDay } from '../lib/local-skcinemas.mjs';

const flags = new Set(process.argv.slice(2));
if ([...flags].some(f => !['--publish', '--bootstrap', '--if-due'].includes(f))) throw new Error('參數僅支援 --publish、--bootstrap、--if-due；不帶參數只預覽');
if (process.env.GITHUB_ACTIONS) throw new Error('本機上傳器不在 GitHub Actions 執行');
const cache = new URL('../.cache/local-skcinemas/', import.meta.url);
const statePath = new URL('published.json', cache);
let state = {};
try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch {}
if (flags.has('--if-due') && !localUploadDue(state.lastPublishedAt)
    && (state.successfulCinemas === SK_CINEMAS.length || Date.now() - Date.parse(state.lastPublishedAt) < 5 * 60000)) {
  console.log('本時段已成功補抓並上傳，略過重複觸發');
  process.exit(0);
}

// token 由現有 gh 登入管理；不讀取、不輸出，也不放在指令列或公開 JSON。
function github(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const args = ['api', '--hostname', 'github.com', '--method', method,
      `repos/${LOCAL_REPOSITORY}/${endpoint}`, '-H', 'Accept: application/vnd.github+json'];
    if (body !== undefined) args.push('--input', '-');
    const child = spawn('gh', args, { env: { ...process.env, GH_DEBUG: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = [];
    let size = 0;
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.on('error', e => { clearTimeout(timeout); reject(e); });
    child.stdout.on('data', b => { size += b.length; if (size > 4_000_000) child.kill('SIGTERM'); else output.push(b); });
    child.stderr.on('data', b => { if (errors.length < 20) errors.push(b); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        const status = Number(Buffer.concat(errors).toString('utf8').match(/HTTP (\d{3})/)?.[1]) || 0;
        reject(Object.assign(new Error(`GitHub ${method} ${endpoint.split('?')[0]} 失敗（${status || '連線或登入'}）`), { status }));
      } else {
        try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))); } catch { reject(new Error('GitHub 未回傳 JSON')); }
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

let previous = null, fileSha = null, branchExists = false;
if (flags.has('--publish')) {
  let ref;
  try { ref = await github('GET', `git/ref/heads/${LOCAL_BRANCH}`); branchExists = true; }
  catch (e) { if (e.status !== 404) throw e; }
  if (branchExists) {
    const commit = await github('GET', `git/commits/${ref.object.sha}`);
    const tree = await github('GET', `git/trees/${commit.tree.sha}`);
    if (tree.truncated || tree.tree.length !== 1 || tree.tree[0].path !== LOCAL_FILE
        || tree.tree[0].type !== 'blob' || tree.tree[0].mode !== '100644') {
      throw new Error('資料分支含有預期外檔案，停止上傳以免覆蓋其他內容');
    }
    const file = await github('GET', `contents/${LOCAL_FILE}?ref=${ref.object.sha}`);
    if (file.encoding !== 'base64') throw new Error('遠端 JSON 格式或大小異常');
    previous = validateLocalSnapshot(Buffer.from(file.content, 'base64').toString('utf8'));
    fileSha = file.sha;
  } else if (!flags.has('--bootstrap')) throw new Error('資料分支尚不存在；首次設定請明確使用 --bootstrap');
} else {
  try { previous = validateLocalSnapshot(await readFile(new URL('preview.json', cache), 'utf8')); } catch {}
}

const records = [], cinemas = [];
let successes = 0;
for (const c of SK_CINEMAS) {
  try {
    const html = await politeFetch(skcinemasUrl(c.id), { timeoutMs: 12000 });
    const rows = parseSkcinemas(html, c);
    const stamp = new Date().toISOString();
    records.push(...rows.map(r => snapshotRecord({ ...r, fetchedAt: stamp })));
    cinemas.push({ ...c, state: 'ok', attemptedAt: stamp, lastSuccessAt: stamp });
    successes++;
    console.log(`${c.name}：${rows.length} 筆 / ${new Set(rows.map(r => r.date)).size} 天`);
  } catch (e) {
    const old = previous?.cinemas.find(k => k.id === c.id);
    const keep = old?.lastSuccessAt && Date.now() - Date.parse(old.lastSuccessAt) <= MAX_LOCAL_AGE_MS;
    if (keep) records.push(...previous.records.filter(r => r.cinema === c.name && r.date >= taipeiDay(Date.now())));
    cinemas.push({ ...c, state: 'failed', attemptedAt: new Date().toISOString(), lastSuccessAt: keep ? old.lastSuccessAt : null });
    console.log(`${c.name}：取得失敗，保留原始時間或交由開眼；${e.message.split('\n')[0]}`);
  }
}
if (!successes) throw new Error('五館均失敗，不覆蓋遠端成功快照');
const snapshot = validateLocalSnapshot({ schemaVersion: 1, source: 'skcinemas', generatedAt: new Date().toISOString(), cinemas, records });
const text = JSON.stringify(snapshot);
await mkdir(cache, { recursive: true });
await writeFile(new URL('preview.json.tmp', cache), text);
await rename(new URL('preview.json.tmp', cache), new URL('preview.json', cache));
if (!flags.has('--publish')) {
  console.log(`僅預覽：${records.length} 筆，${Buffer.byteLength(text)} bytes；未上傳、未部署`);
  process.exit(0);
}

const identity = { name: 'Kaiyan local collector', email: 'kaiyan-local@users.noreply.github.com' };
const message = `更新本機新光場次 ${snapshot.generatedAt} [skip ci]`;
let published;
if (!branchExists) {
  // 建立只含一份 JSON 的獨立根提交；不複製 main，不切換本機分支。
  const tree = await github('POST', 'git/trees', { tree: [{ path: LOCAL_FILE, mode: '100644', type: 'blob', content: text }] });
  const commit = await github('POST', 'git/commits', { message, tree: tree.sha, parents: [], author: identity, committer: identity });
  await github('POST', 'git/refs', { ref: `refs/heads/${LOCAL_BRANCH}`, sha: commit.sha });
  published = commit.sha;
} else {
  const result = await github('PUT', `contents/${LOCAL_FILE}`, { message, branch: LOCAL_BRANCH,
    sha: fileSha, content: Buffer.from(text).toString('base64'), committer: identity });
  published = result.commit.sha;
}
await writeFile(new URL('published.json.tmp', cache), JSON.stringify({ lastPublishedAt: snapshot.generatedAt,
  commit: published, records: records.length, successfulCinemas: successes }, null, 2));
await rename(new URL('published.json.tmp', cache), statePath);
console.log(`已上傳 ${LOCAL_REPOSITORY}/${LOCAL_BRANCH}/${LOCAL_FILE}：${records.length} 筆，提交 ${published}`);
console.log('雲端下次更新時自動納入；本機不執行遠端 workflow，也沒有呼叫 LLM');
if (successes < SK_CINEMAS.length) process.exitCode = 1;
