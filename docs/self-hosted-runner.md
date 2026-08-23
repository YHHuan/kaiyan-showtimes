# 用自己的機器當 runner（解決新光抓不到的問題）

## 為什麼要做這件事

新光影城在 GitHub 的雲端機器上**連 TCP 都建不起來**（`net::ERR_CONNECTION_TIMED_OUT`，
十次嘗試全失敗），但在家用網路上一直是穩定的 1,100 筆。研判是對方防火牆擋資料中心 IP。

目前的處理是退而求其次用開眼的資料，只有當天場次。**如果排程改跑在你自己的機器上，
新光就能拿回完整的未來一週檔期。**

順帶的好處：本機有瀏覽器快取與較穩的網路，整輪會快不少；而且雲端 runner 的
IP 段被更多站台列入黑名單只是時間問題，自己的機器不受這個趨勢影響。

## 前提

- 一台不關機、能上網的機器（Linux 或 WSL 都可以）
- 已安裝 Node 22+、ffmpeg
- **這台機器會執行 repo 裡的程式**。因為是自己的 repo、自己寫的程式，這沒問題；
  但別把 self-hosted runner 掛在會接受外部 PR 的公開 repo 上——那等於讓陌生人
  在你家機器上執行程式碼。這個 repo 目前不收外部 PR，所以安全。

## 設定

1. GitHub repo → Settings → Actions → Runners → New self-hosted runner，
   照它給的指令下載並設定（會需要一組一次性 token）。
2. 裝成常駐服務，開機自動啟動：

```bash
cd ~/actions-runner
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

3. 把 workflow 的 `runs-on` 改成自己的 runner：

```yaml
jobs:
  build:
    runs-on: self-hosted    # 原本是 ubuntu-latest
```

4. `deploy` 那個 job **維持 `ubuntu-latest`**——它只是把產出丟給 GitHub Pages，
   不需要碰任何影城網站，用雲端跑比較單純。

## 改用自己機器之後要注意

- **機器關機或斷網 = 場次停止更新**。網站不會壞（維持上一版），頁尾會顯示
  最後更新時間，但資料會愈來愈舊。健康檢查的 72 小時門檻會在第三天把過期
  來源整個剔除。
- 想要兩者兼得，可以讓 workflow 兩種 runner 都試：先跑 self-hosted，
  失敗時 fallback 到 ubuntu-latest（那輪就少新光）。這需要把 job 拆成兩個
  加上 `continue-on-error` 與 `if: failure()`，維護成本較高，先不做。
- runner 會佔用機器資源約 15 分鐘／輪，一天兩輪。

## 怎麼確認有效

改完之後手動觸發一次，看 log 裡的這一行：

```
=== skcinemas ===
  台北獅子林新光影城: 40
  ...
data/skcinemas.json: 1102 筆場次
```

如果還是 `net::ERR_CONNECTION_TIMED_OUT`，代表不是 IP 的問題，要重新診斷。
