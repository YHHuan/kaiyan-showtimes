// 使用 Windows 原生 schtasks 建立一般權限任務，不變更 PowerShell execution policy。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { taipeiDay } from '../lib/local-skcinemas.mjs';

const exec = promisify(execFile);
const taskName = 'Kaiyan-Local-ShinKong';
const repo = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const options = { timeout: 30000, maxBuffer: 1_000_000, encoding: 'utf8' };
const readonly = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  + '@{zone=(Get-TimeZone).Id; user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; windows=$env:WINDIR} | ConvertTo-Json -Compress'], options);
const host = JSON.parse(readonly.stdout.trim());
if (host.zone !== 'Taipei Standard Time') throw new Error('Windows 不是台北時區；沒有自動更改時區');
const distribution = process.env.WSL_DISTRO_NAME;
if (!distribution) throw new Error('請在目標 Windows 的 WSL 內執行安裝器');
const linuxUser = (await exec('id', ['-un'], options)).stdout.trim();
for (const value of [repo, distribution, linuxUser]) {
  if (!value || /["\r\n]/.test(value)) throw new Error('WSL 參數含有不合法字元');
}
try {
  await exec('schtasks.exe', ['/Query', '/TN', taskName], options);
  console.log('同名任務已存在，不覆蓋；請先核對其動作與觸發時間');
  process.exit(0);
} catch (e) {
  if (e.code !== 1) throw e;
  // 查詢不存在回 1；若其實是權限問題，後面的原生建立指令仍須通過 Windows 權限檢查。
}
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const args = `--distribution "${distribution}" --user "${linuxUser}" --cd "${repo}" --exec /usr/bin/bash scripts/local-skcinemas.sh`;
const day = taipeiDay(Date.now());
const definition = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Kaiyan: fetch five public Shin Kong schedules and upload JSON only. No LLM, no remote runner, no auto-pull.</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger><StartBoundary>${day}T05:05:00+08:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
    <CalendarTrigger><StartBoundary>${day}T17:05:00+08:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(host.user)}</UserId></LogonTrigger>
  </Triggers>
  <Principals><Principal id="Collector"><UserId>${xml(host.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden>
    <WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Priority>7</Priority>
    <RestartOnFailure><Interval>PT10M</Interval><Count>1</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Collector"><Exec><Command>${xml(host.windows)}\\System32\\wsl.exe</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>
</Task>`;
const cache = new URL('../.cache/local-skcinemas/', import.meta.url);
await mkdir(cache, { recursive: true });
const configPath = fileURLToPath(new URL('windows-task.xml', cache));
// schtasks 以 Unicode 讀取 XML；UTF-16LE + BOM 避免「無法切換編碼」。
await writeFile(configPath, '\uFEFF' + definition, 'utf16le'); // 設定產物留在 gitignored cache，不上傳電腦／帳號名稱。
const windowsPath = (await exec('wslpath', ['-w', configPath], options)).stdout.trim();
// 刻意不使用 /F；若建立時另一個同名任務出現，不可無聲覆蓋。
try {
  await exec('schtasks.exe', ['/Create', '/TN', taskName, '/XML', windowsPath, '/HRESULT'], { ...options, encoding: 'buffer' });
} catch (error) {
  const raw = error.stderr || error.stdout || Buffer.alloc(0);
  const utf8 = raw.toString('utf8');
  const detail = (utf8.includes('\uFFFD') ? new TextDecoder('big5').decode(raw) : utf8).trim().slice(0, 700);
  throw new Error(`Windows 未建立任務（${error.code}）：${detail}；未提升權限、未變更安全政策`);
}
console.log(`已建立 ${taskName}：台北 05:05／17:05、登入補跑、一般權限；未修改 execution policy`);
