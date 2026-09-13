# 2026-09-13 場次漏收與作品混淆修正

起因：搜尋《驀然回首》時，天母新光明明有場次，網站卻不容易找到。
稽核發現不只是漏抓：真人版與動畫版被同名歸戶、來源已開放多日但抓取器仍只取今天，
以及新光官網改版後舊 API 已不再出現。

## 修正範圍

| 問題 | 修正與防退化方式 |
|---|---|
| 真人／動畫共用片名、片長與海報 | 保留來源 ID、原片名、片長；核實《驀然回首》兩版，來源不明時標「版本待確認」，禁止借用另一版介紹 |
| 新光仍等舊 API | 改讀官方公開 HTML `/Sessions/Sessions?cinemaId=…`，核對館別、電影 ID、日期及格式；未公布廳名不杜撰 |
| 開眼只抓今天 | 跟隨實際公布的 `/YYYYMMDD/` 連結，核對頁面日期，不猜尚未公布的檔期 |
| 4DX、國語／日語標記遺失 | 解析片名之外的獨立格式／配音標籤；4D 仍只對應 4DX／MX4D，不包含 ULTRA 3D |
| 同片異名拆卡 | 核實《超異能快感2／魔法之書》《粽邪4／坤蒂拉娜》；同開眼 ID 的改名可歸戶，不跨分館猜其他系統的 ID |
| 全來源總量掩蓋漏館、跨日空窗 | 官網與備援逐館逐日選用；保留各筆抓取時間、掉館名冊、失敗日期；介面提供資料缺口與官方入口 |
| 深夜測試擋住更新 | 功能测试固定時鐘、以日期值導航；健康檢查仍依真實台北日期判定 |

延伸處理：

- 王牌同時排映 100 分鐘真人版及 57 分鐘動畫版，改保留電影 ID 與片長。
- 美麗新的真人版標為 101 分鐘，納入經官方頁核實的來源差異。
- 喜樂時代永和／今日店的裸名，從該館該 ProgramID 的介紹頁核對 57 分鐘；舊售票 ID 加上分館範圍。
- 歷史狀態與新資料共用縣市正規化，避免花蓮市／花蓮縣、台東市／台東縣重複影城。
- 舊收藏與連結保留：確定的別名可找回；裸名《驀然回首》提醒重新選版本，不清除使用者收藏。
- 排程保持一天兩次、不使用 LLM，改為台北 05:17／17:17 啟動；完成時間仍可能延遲。

## 查證來源

- [天母新光官方多日場次](https://www.skcinemas.com/Sessions/Sessions?cinemaId=1005)
- [開眼真人版 ID fljp39094466](https://www.atmovies.com.tw/movie/fljp39094466/)、[動畫版 ID fljp31711040](https://www.atmovies.com.tw/movie/fljp31711040/)
- [王牌官方全部場次](https://www.acecinema.com.tw/movie/all)、[美麗新官方時刻表](https://www.miranewcinemas.com/booking/timetable)
- [喜樂時代永和動畫版介紹](https://ticket.centuryasia.com.tw/beyond/movie_timetable.aspx?ProgramID=0000244&TimeDetail=True)、[今日店動畫版介紹](https://ticket.centuryasia.com.tw/ximen/movie_timetable.aspx?ProgramID=0000296&TimeDetail=True)
- [GitHub 排程延遲說明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 驗證

- `npm run check`、`bash -n run-all.sh`：語法檢查。
- `node --test tests/identity.mjs tests/sources.mjs tests/coverage.mjs`：17 項來源、作品比對、實際建站及覆蓋回歸測試。
- `npm run smoke`：另含跨日搜尋、4DX、配音、舊收藏、資料缺口、海報裁切及手機／桌機瀏覽器測試。
- 新光官方本機實抓五館均成功；天母真人版可取得 9/13–9/16 場次。開眼實抓 36 館的已公布多日資料。

來源可能尚未公布某日期、短暫連不上，或片長互相矛盾。這些情況會保留警告、限制使用不可靠資料，
不把「未取得」說成「沒有放映」。各次實際覆蓋與未解矛盾以網站 `site-status.json` 為準。
