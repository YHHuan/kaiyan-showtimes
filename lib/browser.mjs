// 共用：無頭瀏覽器抓取。
//
// 用途：威秀（Akamai）、新光（API 需簽章 header）、in89（Cloudflare Turnstile）這幾家
// 純 HTTP 請求拿不到資料。與其把人家 JS 裡混淆的簽章金鑰抽出來自己重算（脆弱、且形同複製
// 對方刻意內部化的憑證），不如讓真實瀏覽器跑他們自己的前端，我們只讀結果——
// 跟一般使用者開網頁看場次是同一條路徑，對方改版也不會整個爛掉。
import { chromium } from 'playwright';

export async function withPage(fn, { locale = 'zh-TW' } = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      locale,
      timezoneId: 'Asia/Taipei',
      viewport: { width: 1440, height: 900 },
    });
    // CI runner 的網路比本機慢，預設 30 秒不夠——新光就是因此整支掛掉
    ctx.setDefaultNavigationTimeout(60000);
    ctx.setDefaultTimeout(60000);
    const page = await ctx.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// 等待某個符合 urlPart 的回應出現並回傳其 JSON（在 action 觸發之前就開始監聽）
export function catchJson(page, urlPart, timeout = 40000) {
  return page.waitForResponse((r) => r.url().includes(urlPart) && r.status() === 200, { timeout })
    .then((r) => r.json());
}

// 對單一館別重試。一家超時不該讓整支抓取器歸零——那會讓健康檢查誤判成
// 「解析器壞了」，把整個來源踢掉，實際上只是那一次連線比較慢。
export async function attempt(label, fn, tries = 2) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const last = i === tries;
      console.log(`  ${label}: 第 ${i} 次失敗（${e.message.split('\n')[0]}）${last ? '，放棄' : '，重試'}`);
      if (last) return null;
    }
  }
  return null;
}
