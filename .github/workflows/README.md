# workflows

`update.yml` — 每天兩次重抓場次並重新發佈網站。

手動觸發：`gh workflow run 更新場次` 或在 Actions 頁面按 Run workflow。

失敗時 GitHub 會寄信給 repo 擁有者；線上網站維持上一次成功的版本。

完整更新另外執行隔離的官方影展場次步驟（`fetch/festivals.mjs`，最多 4 分鐘，`continue-on-error`）。
`data/festivals/` 隨既有 `data` 快取保存，不加入院線健康檢查，失敗保留最後成功資料及原時間並標記未核對。
原 cron 與院線抓取流程不變；`rebuild_only`／`refresh_atmovies_only` 不抓影展。
初次發布影展逐場功能需一次完整更新，只有重建快取不會憑空有新影展資料。
PR CI 使用離線固定資料；官方連線驗證另行記錄，不能把 fixture 通過當作 GitHub runner 已抓取成功。
