/**
 * スクレイピング本体
 * Puppeteer-extra + stealth で Cloudflare検出を回避
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { extractAll, extractFromPage } from './extractor.js';

puppeteer.use(StealthPlugin());

/**
 * ブラウザ起動（共通設定）
 * メモリリーク防止のため、長時間運用では1回の実行ごとに起動/終了する
 */
async function launchBrowser() {
  return puppeteer.launch({
    headless: CONFIG.HEADLESS ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--no-first-run',
      '--no-default-browser-check',
      `--lang=${CONFIG.LOCALE}`,
      '--window-size=1280,800',
    ],
    defaultViewport: CONFIG.VIEWPORT,
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

/**
 * 通常ブラウザに近いページ設定
 */
async function preparePage(page) {
  // User-Agent上書き
  await page.setUserAgent(CONFIG.USER_AGENT);

  // 受け入れる言語ヘッダ
  await page.setExtraHTTPHeaders({
    'Accept-Language':       'ja,en-US;q=0.9,en;q=0.8',
    'Accept-Encoding':       'gzip, deflate, br',
    'Sec-Fetch-Site':        'none',
    'Sec-Fetch-Mode':        'navigate',
    'Sec-Fetch-User':        '?1',
    'Sec-Fetch-Dest':        'document',
    'Upgrade-Insecure-Requests': '1',
  });

  // タイムゾーン
  await page.emulateTimezone(CONFIG.TIMEZONE);

  // navigator.webdriver の隠蔽（stealthがやってくれるが念のため）
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // languages
    Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'] });
    // plugins
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  // リソースインターセプト（画像/CSS/フォント等をブロック）
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (CONFIG.BLOCKED_RESOURCES.includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

/**
 * 単一ページをスクレイピング
 * @param {import('puppeteer').Browser} browser
 * @param {string} url
 * @returns {Promise<string[]>}
 */
async function scrapeSinglePage(browser, url) {
  const page = await browser.newPage();

  try {
    await preparePage(page);

    logger.debug(`opening: ${url}`);
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout:   CONFIG.PAGE_TIMEOUT_MS,
    });

    if (!response) throw new Error('no response');

    const status = response.status();
    logger.debug(`status: ${status}`);

    // Cloudflareチャレンジ通過待機
    // 「Just a moment...」等のチャレンジが出ていたら、解決まで待つ
    await page.waitForFunction(
      () => {
        const title = document.title || '';
        const body  = document.body?.innerText || '';
        return !/just a moment|checking your browser|attention required/i.test(title + body);
      },
      { timeout: CONFIG.CHALLENGE_WAIT_MS }
    ).catch(() => logger.debug('challenge wait timeout (may already be passed)'));

    // 軽くスクロールしてLazy Loadを発火
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const step = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          if (total >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    }).catch(() => {});

    await new Promise(r => setTimeout(r, CONFIG.POST_LOAD_WAIT_MS));

    // HTMLとDOMから両方抽出
    const html       = await page.content();
    const fromHtml   = extractAll(html);
    const fromPage   = await extractFromPage(page);

    const merged = [...new Set([...fromHtml, ...fromPage])];
    logger.debug(`extracted: ${merged.length} urls (html=${fromHtml.length}, dom=${fromPage.length})`);

    return merged;
  } finally {
    // pageは必ず閉じる（メモリリーク防止）
    await page.close().catch(() => {});
  }
}

/**
 * リトライ付きスクレイピング
 */
async function scrapeWithRetry(browser, url) {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      const urls = await scrapeSinglePage(browser, url);
      if (urls.length > 0) return urls;
      lastError = new Error('no URLs extracted');
    } catch (e) {
      lastError = e;
      logger.warn(`attempt ${attempt}/${CONFIG.MAX_RETRIES} failed: ${e.message}`);
    }

    if (attempt < CONFIG.MAX_RETRIES) {
      const backoff = CONFIG.RETRY_BACKOFF_MS * attempt;
      logger.info(`retrying in ${backoff}ms...`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastError ?? new Error('all retries failed');
}

/**
 * メインエントリ
 * 全TARGET_URLSを巡回 → URL収集 → レコード返却
 */
export async function runScrape() {
  const startTime = Date.now();
  logger.info(`scrape start: ${CONFIG.TARGET_URLS.length} pages`);

  let browser;
  const allRecords = [];

  try {
    browser = await launchBrowser();

    for (let i = 0; i < CONFIG.TARGET_URLS.length; i++) {
      const url   = CONFIG.TARGET_URLS[i];
      const label = url.split('/').pop();

      try {
        const extracted = await scrapeWithRetry(browser, url);
        logger.info(`[${label}] ${extracted.length} URLs`);

        const collectedAt = new Date().toISOString();
        for (const u of extracted) {
          allRecords.push({ url: u, collected_at: collectedAt });
        }
      } catch (e) {
        logger.error(`[${label}] failed: ${e.message}`);
      }

      // ページ間のクールダウン
      if (i < CONFIG.TARGET_URLS.length - 1) {
        await new Promise(r => setTimeout(r, CONFIG.BETWEEN_PAGES_MS));
      }
    }
  } finally {
    // browserは必ず閉じる
    if (browser) {
      await browser.close().catch(e => logger.warn(`browser close error: ${e.message}`));
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`scrape done: ${allRecords.length} records in ${elapsed}s`);

  return allRecords;
}
