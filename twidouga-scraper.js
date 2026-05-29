/**
 * twidouga-scraper.js v4
 * - Playwright で twidouga.net をスクレイピング（403回避）
 * - 20分おきに3ページをローテーション（GitHub Actions cron）
 * - TARGET_PAGE env で対象ページを指定（1/2/3、未指定は分で自動選択）
 * - 15分（900秒）超の動画はスキップ
 */

const { chromium } = require('playwright');
const https = require('https');
const http  = require('http');

// ページ選択: 環境変数 or 分でローテーション
function selectTargetUrl() {
  const all = [
    'https://www.twidouga.net/jp/realtime_t1.php',
    'https://www.twidouga.net/jp/realtime_t2.php',
    'https://www.twidouga.net/jp/realtime_t3.php',
    'https://www.twikeep.com/history?random=1',
    'https://www.twikeep.com/',
    'https://www.twikeep.com/ranking?range=1w&metric=views',
  ];
  const page = process.env.TARGET_PAGE;
  if (page && ['1','2','3'].includes(page)) {
    return [all[parseInt(page) - 1]];
  }
  // 分で自動選択: 0-19→t1, 20-39→t2, 40-59→t3
  const min = new Date().getMinutes();
  const idx = Math.floor(min / 20) % 3;
  return [all[idx]];
}

const CONFIG = {
  targetUrls: selectTargetUrl(),
  xfeedUrl:    process.env.XFEED_URL    || 'https://5xfeed.com',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL    || '',
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY   || '',
  maxPerRun:   50,
  intervalMs:  1500,
  MAX_VIDEOS:  400000,
};

console.log(`\n対象ページ: ${CONFIG.targetUrls[0].split('/').pop()}`);

// ─── HTTP helper ─────────────────────────────────────────────
function fetchWithBody(url, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const data   = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'Mozilla/5.0',
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 30000,
    };
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(text);
        else reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function supabase(path, method = 'GET', body = null, extra = {}) {
  return fetchWithBody(
    `${CONFIG.supabaseUrl}/rest/v1/${path}`,
    method, body,
    { 'apikey': CONFIG.supabaseKey, 'Authorization': `Bearer ${CONFIG.supabaseKey}`, ...extra }
  );
}

async function getRegisteredTweetIds() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) return new Set();
  try {
    const res  = await supabase('videos?select=tweet_id&limit=500000');
    const data = JSON.parse(res);
    return new Set(data.map(v => v.tweet_id).filter(Boolean));
  } catch (e) {
    console.error('Supabaseエラー:', e.message);
    return new Set();
  }
}

async function deleteOldestLowLiked(deleteCount) {
  try {
    const res  = await supabase(`videos?select=id&order=like_count.asc,created_at.asc&limit=${deleteCount}`);
    const data = JSON.parse(res);
    if (!data.length) return;
    for (let i = 0; i < data.length; i += 100) {
      const batch = data.slice(i, i + 100);
      const ids = batch.map(v => `"${v.id}"`).join(',');
      await supabase(`videos?id=in.(${ids})`, 'DELETE').catch(() => {});
    }
    console.log(`削除完了: ${data.length}件`);
  } catch (e) {
    console.error('削除エラー:', e.message);
  }
}

async function getVideoDuration(tweetUrl) {
  try {
    const m = tweetUrl.match(/\/status\/(\d+)/);
    if (!m) return null;
    const res  = await fetch(`https://api.fxtwitter.com/status/${m[1]}`);
    const data = await res.json();
    const videos = data?.tweet?.media?.videos ?? [];
    return videos[0]?.duration ?? null;
  } catch { return null; }
}

async function registerToXfeed(tweetUrl) {
  try {
    const duration = await getVideoDuration(tweetUrl);
    if (duration !== null && duration > 900) {
      console.log(`  ⏭️  スキップ（${Math.floor(duration/60)}分超）`);
      return { success: false, reason: 'too_long' };
    }
    await fetchWithBody(`${CONFIG.xfeedUrl}/api/videos`, 'POST', {
      tweet_url: tweetUrl, description: '', manual_tags: [],
    });
    return { success: true };
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('409') || msg.includes('already')) return { success: false, reason: 'duplicate' };
    return { success: false, reason: msg.slice(0, 100) };
  }
}

function extractXUrls(html) {
  const urls = new Set();
  for (const m of html.matchAll(/https?:\/\/(?:twitter|x)\.com\/\w+\/status\/(\d+)/gi))
    urls.add(m[0].replace('twitter.com', 'x.com').replace(/[?&].*$/, ''));
  for (const m of html.matchAll(/href=["']([^"']*(?:twitter|x)\.com\/[^"']*\/status\/\d+[^"']*)/gi)) {
    const url = m[1].replace(/&amp;/g, '&').replace('twitter.com', 'x.com').replace(/[?&].*$/, '');
    if (url.includes('/status/')) urls.add(url);
  }
  return [...urls];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const registered = await getRegisteredTweetIds();
  console.log(`登録済み: ${registered.size.toLocaleString()}件`);

  if (registered.size >= CONFIG.MAX_VIDEOS) {
    await deleteOldestLowLiked(registered.size - CONFIG.MAX_VIDEOS + CONFIG.maxPerRun);
  }

  console.log('ブラウザ起動中...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    viewport: { width: 1280, height: 800 },
  });

  const allUrls = new Set();
  try {
    for (const targetUrl of CONFIG.targetUrls) {
      console.log(`取得中: ${targetUrl.split('/').pop()}`);
      try {
        const page = await context.newPage();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        await page.evaluate(async () => {
          await new Promise(resolve => {
            let total = 0;
            const timer = setInterval(() => {
              window.scrollBy(0, 500); total += 500;
              if (total >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
            }, 200);
          });
        });
        await page.waitForTimeout(2000);
        const html  = await page.content();
        const hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href).filter(h => h.includes('/status/'))
        );
        const urls = extractXUrls(html);
        hrefs.forEach(h => {
          const n = h.replace('twitter.com', 'x.com').replace(/[?&].*$/, '');
          if (n.includes('/status/')) urls.push(n);
        });
        const unique = [...new Set(urls)];
        console.log(`  発見: ${unique.length}件`);
        unique.forEach(u => allUrls.add(u));
        await page.close();
      } catch (e) {
        console.error(`  エラー: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  const newUrls = [...allUrls].filter(url => {
    const m = url.match(/\/status\/(\d+)/);
    return m && !registered.has(m[1]);
  });
  console.log(`新規: ${newUrls.length}件`);

  if (!newUrls.length) { console.log('新規なし、終了'); return; }

  const toRegister = newUrls.slice(0, CONFIG.maxPerRun);
  let success = 0, duplicate = 0, failed = 0;

  for (let i = 0; i < toRegister.length; i++) {
    const url = toRegister[i];
    const r = await registerToXfeed(url);
    if (r.success)               { console.log(`✅ ${url.slice(-19)}`); success++; }
    else if (r.reason === 'duplicate') { duplicate++; }
    else if (r.reason === 'too_long')  { /* skip */ }
    else                               { console.log(`❌ ${r.reason}`); failed++; }
    await sleep(CONFIG.intervalMs);
  }

  console.log(`\n完了: 成功=${success} 重複=${duplicate} 失敗=${failed}`);
}

main().catch(e => { console.error('致命的エラー:', e); process.exit(1); });
