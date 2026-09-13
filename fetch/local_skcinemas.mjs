// 公開、固定位置的 JSON 是可選補充；不存在、過期或驗證失敗時繼續保留開眼備援。
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { LOCAL_URL, MAX_SNAPSHOT_BYTES, mergeLocalSnapshot } from '../lib/local-skcinemas.mjs';

const dir = new URL('../data/', import.meta.url);
try {
  const response = await fetch(LOCAL_URL, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('JSON 超過大小上限');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let rows = [], status = {};
  try { rows = JSON.parse(await readFile(new URL('skcinemas.json', dir), 'utf8')); } catch {}
  try { status = JSON.parse(await readFile(new URL('_status.json', dir), 'utf8')); } catch {}
  const result = mergeLocalSnapshot(text, rows, status.skcinemas);
  if (result.imported.length) {
    await mkdir(dir, { recursive: true });
    status.skcinemas = result.source;
    for (const [name, data] of [['skcinemas.json', result.records], ['_status.json', status]]) {
      const target = new URL(name, dir), temp = new URL(`${name}.tmp`, dir);
      await writeFile(temp, JSON.stringify(data, null, 1));
      await rename(temp, target);
    }
    console.log(`本機新光補充：${result.imported.join('、')}；保留原始抓取時間 ${result.source.fetchedAt}`);
  } else console.log('本機新光補充：沒有比現有資料更新的有效場次，不改動資料');
} catch (error) {
  // 僅列摘要；不把第三方回應內容當命令、錯誤堆疊或 HTML 發佈。
  console.log(`本機新光補充略過：${error.message.split('\n')[0]}；既有官方／開眼備援繼續運作`);
}
