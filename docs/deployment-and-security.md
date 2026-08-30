# 開演：零成本部署、更新與安全維運

## 建議結論

目前最適合的正式架構就是現有的組合：

- 公開的 GitHub repository 保存程式碼。
- GitHub Actions 每天台北時間 06:00、18:00 抓場次、健康檢查、建站。
- GitHub Pages 只發布產出的靜態檔案。
- 不設會員、資料庫、付款或後台 API；收藏與定位只留在訪客自己的瀏覽器。

在 repository 維持公開、使用標準 GitHub-hosted runner，而且流量與檔案量未超過 GitHub Pages
合理限制的前提下，主機與自動更新成本可維持 **每月 NT$0**。GitHub 官方說明：公開 repository
的標準 Actions runner 免費，GitHub Free 的公開 repository 可使用 Pages；Pages 目前的軟性流量上限為
每月 100 GB、發布內容不可超過 1 GB。

- [GitHub Actions 計費說明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

## 現在不必買網域

`https://yhhuan.github.io/kaiyan-showtimes/` 已是正式 HTTPS 網址，功能、搜尋收錄與分享都能正常運作。
自訂網域的價值主要是「比較短、好記、品牌不綁 GitHub」，不是可靠度或安全性的必要條件。

建議先用免費網址公開一至三個月，確定有人持續使用、站名也不會再改，再決定是否購買網域。
若購買，成本只有註冊商依頂級網域收取的年費，主機仍可留在 GitHub Pages，不必另外租 VPS。

日後設定自訂網域時：

1. 先在 GitHub 帳號驗證網域，避免網域接管。
2. 在 repository 的 **Settings → Pages** 填入自訂網域。
3. 再到 DNS 註冊商設定 `CNAME` 或官方指定的 `A`／`AAAA` 紀錄。
4. 開啟 **Enforce HTTPS**。
5. 不使用 `*.example.com` 這類 wildcard DNS；停用 Pages 前先移除 DNS 指向。

GitHub 的[自訂網域設定文件](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
也特別提醒，先設 DNS 卻沒有先把網域加入 Pages，或留下 wildcard DNS，都可能造成網域接管。

## 自動更新怎麼運作

`.github/workflows/update.yml` 每天跑兩次：

1. 取回上一輪資料快取。
2. 從各影城公開場次頁或 API 唯讀抓取。
3. 健康檢查資料筆數、來源跌幅與新鮮度。
4. 建立互動首頁、電影／戲院／日期索引頁、sitemap 與 `site-status.json`。
5. 只有健康檢查通過才部署；失敗時線上保留上一個成功版本。

維護者可在 GitHub 的 **Actions → 更新場次 → Run workflow** 隨時手動更新。若某來源改版：

- 單一來源短暫失敗：沿用上一輪資料，頁尾明示資料較舊。
- 超過 72 小時：整個來源剔除，不顯示過期場次。
- 全站總量過低或過半來源異常：中止部署，保留上一版。
- 有設定 `TELEGRAM_TOKEN`、`TELEGRAM_CHAT_ID` secrets 時，來源異常會傳 Telegram；沒有設定也不影響網站。

公開狀態可直接看 [`site-status.json`](https://yhhuan.github.io/kaiyan-showtimes/site-status.json)，不用再手動把 README 或使用說明的影城數字改來改去。

## 安全模型

沒有網站可以承諾「不會被駭」，但純靜態站把最常出事的部分直接拿掉了：沒有登入密碼、會員個資、
資料庫、付款資料、管理後台，也沒有可被打 SQL injection 的伺服器。需要防守的重點變成以下四類。

### 1. GitHub 帳號與 repository

- GitHub 帳號開啟 2FA，最好再加 passkey；下載並離線保存 recovery codes。
- 不把 token、cookie、Telegram secret 或瀏覽器登入狀態 commit 進 repository。
- 只給真正需要的人 write 權限；不接受不明來源直接推送主分支。
- 開啟 Dependabot alerts、secret scanning 與 private vulnerability reporting。
- 每月看一次 **Security**、**Actions** 頁面；收到高嚴重度警報時優先處理。

### 2. 自動部署供應鏈

- Workflow 預設只有 `contents: read`；只有 deploy job 才取得 `pages: write` 與短效 `id-token: write`。
- 所有 Actions 固定到完整 commit SHA，避免可移動 tag 被竄改；Dependabot 每週提出安全升級。
- 使用 `npm ci` 嚴格依 lockfile 安裝，checkout 不保留可寫入 repository 的 credential。
- Secrets 只透過 GitHub Actions secrets 注入，而且目前只用於異常通知，不是建站必要條件。

GitHub 官方也建議 workflow 採最小權限並把 Actions 固定到完整 SHA：
[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)。

### 3. 每日抓進來的外部資料

- 電影片名、影城、標籤全部以 `textContent` 建立，不當成 HTML 執行。
- 訂票與票價網址只允許 `http:`、`https:`；其他 scheme 在建置時直接丟棄。
- 首頁使用 Content Security Policy：不載入第三方 script、禁止 frame／object／form，inline script 必須符合每次建置產生的 SHA-256 hash。
- 外部連結使用 `noopener noreferrer`；網站本身不嵌入影城頁面、不處理付款。

### 4. 資料失真與服務中斷

- 健康檢查除了防程式壞掉，也是安全控制：上游回傳異常內容時不會直接覆蓋正常版本。
- GitHub Pages 與自訂網域都強制 HTTPS；不混用 HTTP script 或圖片。
- PWA 線上時採 network-first，避免使用者長期被舊快取困住；離線才退回最近一次成功頁面。
- 來源時間與異常狀態公開顯示，不把「抓不到」偽裝成「今天沒場次」。

## 發生事故時

1. 若只是資料錯誤：在 Actions 暫停排程或修正抓取器；線上先保留上一個正常版本。
2. 若懷疑 GitHub 帳號被入侵：立刻改密碼、撤銷 sessions／PAT／SSH keys、輪替所有 Actions secrets。
3. 若發布內容被竄改：停用 Pages，保留 Actions logs，從已知正常 commit 重新部署。
4. 若自訂網域不再使用：先移除 DNS，再移除 Pages custom domain，避免 dangling DNS 被接管。
5. 安全問題不要貼 token 或利用細節到公開 Issue，依 [`SECURITY.md`](../SECURITY.md) 私下回報。

## 何時才需要換主機

只有出現以下需求才考慮 Cloudflare Pages、Vercel 或付費 VPS：

- 要會員跨裝置同步收藏。
- 要寄個人化通知或做訂閱。
- 要即時查詢而非一天兩次靜態更新。
- 每月流量接近 GitHub Pages 軟性上限。
- 上游明確授權伺服器端 API，並需要保管 API key。

在那之前加後端只會增加帳單、維運與攻擊面；目前的公益查詢站沒有這個必要。
