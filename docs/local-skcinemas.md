# 新光本機 JSON 補充

新光公開場次在本機可取得，但 GitHub-hosted runner 曾持續連線失敗。
本機只負責五館的公開查詢與 JSON 上傳；網站建置、測試與部署仍在 GitHub 執行。
不使用 LLM、付費代理、會員登入、訂票操作或 self-hosted runner。

```text
Windows 05:05 / 17:05 → WSL 抓新光五館 → local-showtimes 分支的一份 JSON
                                             ↓ 唯讀、驗證
GitHub 05:17 / 17:17 → 官方＋開眼 → 納入本機 JSON → 測試 → GitHub Pages
```

## 成本與限制

- 不新增主機、網域、付費服務或 LLM 呼叫；本機有少量電力及網路使用。
- Windows 任務以目前使用者、一般權限執行，不存 Windows 密碼、不喚醒電腦。
- 電腦需要開機且使用者已登入（鎖定畫面仍屬登入）。錯過時盡可能補跑，登入也會檢查。
- 每個台北時間 05:05／17:05 時段已成功上傳五館就略過重複觸發；部分失敗可重試。
- 本機只上傳，不額外觸發整站更新。登入補抓完成後，網站通常等下一輪雲端建置納入；
  要立即納入可手動執行既有 workflow 的 `rebuild_only`。
- Windows 任務與 GitHub 排程都不是準點 SLA。電腦關機／未登入時，雲端與開眼仍持續運作。
- 本機資料 26 小時內才有新鮮官方優先權；較舊資料讓較新的開眼接手相同館／日期；
  最多保留 72 小時的官方獨有遠期資料，並顯示失敗／缺口提示，之後完全排除。

## 安全邊界

- 固定上傳 `YHHuan/kaiyan-showtimes` 的 `local-showtimes/skcinemas.json`，不寫 `main`。
- 資料分支是獨立根提交，只含這一份 JSON，不複製程式、workflow、海報或本機檔案。
  發現分支出現其他檔案時上傳器停止，避免覆蓋不在範圍內的內容。
- 上傳白名單只包含片名、時間、館別、公開電影／場次 ID、格式、分級與抓取時間。
  不上傳 cookie、token、瀏覽器資料、使用者收藏或本機檔案路徑。
- 使用已登入的 `gh` 管理認證，程式不讀取或輸出 token；不新增 Actions secrets。
  現有登入權限不會因此自動縮小。若另設專用憑證，僅需這個 repository 的 **Contents: write**，
  不需 Actions、Workflows、管理員或其他 repository 權限。
- 雲端只以 HTTPS GET 讀固定 JSON URL，不 checkout、不執行資料分支的任何檔案。
  限制 900 KB／5,000 場，核對五個館別、日期、時間戳、公開官網 URL、標籤、分級及重複 ID。
- 匯入不改寫原始抓取時間，不讓舊資料覆蓋較新的直接官方結果。
- 本機排程不 `git pull`；只有本機 `main` 且 `lib/`、`scripts/` 沒有未提交變更時才執行。
  維護程式後須先測試、提交，再讓下一輪排程使用。沒有接受外部 PR 的遠端任務入口。

## 初次設定

需要現有 Node、GitHub CLI (`gh`) 登入，以及 Windows 的 WSL 發行版。
不帶參數只抓取及產生本機預覽，不上傳：

```bash
npm run local:preview
node --test tests/local-skcinemas.mjs
```

確認後首次建立專用資料分支：

```bash
node scripts/publish-local-skcinemas.mjs --publish --bootstrap
```

後續手動上傳用 `npm run local:publish`。若沒有任何館成功，上傳器不覆蓋遠端成功快照；
部分失敗館保留原有時間，其他成功館正常更新。

在這台電腦的 WSL 安裝任務；使用 Windows 原生 `schtasks.exe`，不執行 `.ps1` 檔案，
也不更改 PowerShell execution policy：

```bash
node scripts/install-local-skcinemas-task.mjs
```

安裝器不覆蓋同名既有任務；目前 Windows 必須是台北時區，它不會自行更改系統時區。
發行版、Linux 使用者與專案位置取自目前 WSL。產生的任務 XML 只留在 gitignored cache，不上傳帳號或電腦名稱。
若 Windows 權限禁止建立任務，安裝器停止，不提升權限或停用安全控制。

## 檢查、暫停與移除

```powershell
Get-ScheduledTaskInfo -TaskName 'Kaiyan-Local-ShinKong'
Start-ScheduledTask -TaskName 'Kaiyan-Local-ShinKong'
Disable-ScheduledTask -TaskName 'Kaiyan-Local-ShinKong'
# 要恢復時：Enable-ScheduledTask -TaskName 'Kaiyan-Local-ShinKong'
# 確定不再使用時：Unregister-ScheduledTask -TaskName 'Kaiyan-Local-ShinKong'
```

- 本機紀錄：`.cache/local-skcinemas/task.log`（約 256 KB 後輪替，保留上一份）。
- 本機預覽：`.cache/local-skcinemas/preview.json`。
- 最近成功上傳：`.cache/local-skcinemas/published.json`（時間、提交、場次數，不含憑證）。
- 雲端 log 搜尋「本機新光補充」；`site-status.json` 的新光來源會附 `localSnapshotAt`。
- 公開快照：<https://raw.githubusercontent.com/YHHuan/kaiyan-showtimes/local-showtimes/skcinemas.json>。
- GitHub 資料分支保留歷史，方便追查與復原；不是每天把整個網站產物 commit 進主分支。

## 依據

- [GitHub Contents API：上傳與所需權限](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)
- [GitHub Trees API：獨立資料樹](https://docs.github.com/en/rest/git/trees#create-a-tree)
- [Microsoft：原生 schtasks 建立任務](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create)
- [Microsoft：錯過排程補跑、重試與執行限制](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset?view=windowsserver2025-ps)
