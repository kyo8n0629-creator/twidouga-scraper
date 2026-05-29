/**
 * twidouga-scraper.js v5
 * - FlareSolverr経由でCloudflare完全突破
 * - Playwright不要・外部npm依存ゼロ
 * - twidouga.net + twikeep.com対応
 */

const https = require('https');
const http  = require('http');

const CONFIG = {
  targetUrls: [
    'https://www.twidouga.net/jp/realtime_t1.php',
    'https://www.twiero.net/history',
    'https://www.twikeep.com/',
    'https://www.twikeep.com/ranking?range=1w&metric=views',
  ],
  flaresolverr: process.env.FLARESOLVERR_URL || 'http://localhost:8191',
  xfeedUrl:     process.env.XFEED_URL                  || 'https://5xfeed.com',
  supabaseUrl:  process.env.NEXT_PUBLIC_SUPABASE_URL   || '',
  supabaseKey:  process.env.SUPABASE_SERVICE_ROLE_KEY  || '',
  maxPerRun:    9999,
  intervalMs:   500,
  MAX_VIDEOS:   40000000,
};

function httpRequest(url, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const data   = body ? JSON.stringify(body) : null;
    const opts = {
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
    const req = lib.request(opts, res => {
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

function supabase(path, method = 'GET', body = null) {
  return httpRequest(
    `${CONFIG.supabaseUrl}/rest/v1/${path}`,
    method, body,
    { apikey: CONFIG.supabaseKey, Authorization: `Bearer ${CONFIG.supabaseKey}` }
  );
}

async function fetchHtml(url) {
  console.log(`🌐 FlareSolverr → ${url}`);
  const body = JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 });
  return new Promise((resolve, reject) => {
    const parsed = new URL(CONFIG.flaresolverr);
    const req = http.request({
      hostname: parsed.hostname,
      port:     parseInt(parsed.port) || 8191,
      path:     '/v1',
      method:   'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 70000,
    }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (json.status !== 'ok') reject(new Error(`FlareSolverr: ${json.message}`));
          else resolve(json.solution.response);
        } catch (e) { reject(e); }
      });
      r.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('FlareSolverr timeout')); });
    req.write(body);
    req.end();
  });
}

function extractXUrls(html) {
  const urls = new Set();
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+\/status\/(\d{15,})/gi))
    urls.add(m[0].replace('twitter.com', 'x.com').replace(/[?&].*$/, ''));
  for (const m of html.matchAll(/href=["']([^"']*(?:twitter|x)\.com\/[^"']*\/status\/\d{15,}[^"']*)/gi)) {
    const u = m[1].replace(/&amp;/g, '&').replace('twitter.com', 'x.com').replace(/[?&].*$/, '');
    if (u.includes('/status/')) urls.add(u);
  }
  for (const m of html.matchAll(/\/realtime\.php\?id=(\d{15,})/gi))
    urls.add(`https://x.com/i/status/${m[1]}`);
  return [...urls];
}

async function getRegisteredTweetIds() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) return new Set();
  try {
    const res  = await supabase('videos?select=tweet_id&limit=500000');
    const data = JSON.parse(res);
    return new Set(data.map(v => v.tweet_id).filter(Boolean));
  } catch (e) { console.error('Supabaseエラー:', e.message); return new Set(); }
}

async function deleteOldestLowLiked(deleteCount) {
  try {
    const res  = await supabase(`videos?select=id&order=like_count.asc,created_at.asc&limit=${deleteCount}`);
    const data = JSON.parse(res);
    const ids  = data.map(v => v.id);
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      await supabase(`videos?id=in.(${batch.map(id => `"${id}"`).join(',')})`, 'DELETE').catch(() => {});
    }
    console.log(`✅ ${ids.length} 件削除完了`);
  } catch (e) { console.error('削除エラー:', e.message); }
}

async function getTweetInfo(tweetUrl) {
  try {
    const m = tweetUrl.match(/\/status\/(\d+)/);
    if (!m) return { duration: null, isSensitive: null };
    const res  = await httpRequest(`https://api.fxtwitter.com/status/${m[1]}`, 'GET', null);
    const data = JSON.parse(res);
    const tweet  = data?.tweet ?? data;
    const videos = tweet?.media?.videos ?? [];
    return { duration: videos[0]?.duration ?? null, isSensitive: tweet?.possibly_sensitive ?? null };
  } catch { return { duration: null, isSensitive: null }; }
}

async function registerToXfeed(tweetUrl) {
  try {
    const { duration, isSensitive } = await getTweetInfo(tweetUrl);
    await httpRequest(`${CONFIG.xfeedUrl}/api/videos`, 'POST', {
      tweet_url: tweetUrl, description: '', manual_tags: [], is_sensitive: isSensitive,
    });
    return { success: true };
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('409') || msg.includes('already')) return { success: false, reason: 'duplicate' };
    return { success: false, reason: msg.slice(0, 100) };
  }
}

async function generateTags(videoId, thumbnailUrl, tweetText) {
  try {
    await httpRequest(`${CONFIG.xfeedUrl}/api/tags/generate`, 'POST',
      { video_id: videoId, thumbnail_url: thumbnailUrl, tweet_text: tweetText });
    console.log(`   🏷️  タグ生成: ${videoId.slice(0, 8)}...`);
  } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  twidouga/twikeep → xfeed v5             ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const registered   = await getRegisteredTweetIds();
  const currentCount = registered.size;
  console.log(`📊 現在: ${currentCount.toLocaleString()} 件 / 上限 ${CONFIG.MAX_VIDEOS.toLocaleString()} 件`);

  if (currentCount >= CONFIG.MAX_VIDEOS) {
    await deleteOldestLowLiked(currentCount - CONFIG.MAX_VIDEOS + CONFIG.maxPerRun);
    const newSet = await getRegisteredTweetIds();
    registered.clear(); newSet.forEach(id => registered.add(id));
  }

  const allUrls = new Set();
  for (const targetUrl of CONFIG.targetUrls) {
    console.log(`\n📥 ${targetUrl}`);
    try {
      const html = await fetchHtml(targetUrl);
      const urls = extractXUrls(html);
      console.log(`   → ${urls.length} 件発見`);
      for (const u of urls) allUrls.add(u);
    } catch (e) { console.error(`   ✗ ${e.message}`); }
    await sleep(1500);
  }

  console.log(`\n📋 合計: ${allUrls.size} 件`);
  const newUrls = [...allUrls].filter(url => {
    const m = url.match(/\/status\/(\d+)/);
    return m && !registered.has(m[1]);
  });
  console.log(`🆕 新規: ${newUrls.length} 件\n`);
  if (!newUrls.length) { console.log('✅ 新規登録なし'); return; }

  const toRegister = newUrls.slice(0, CONFIG.maxPerRun);
  let ok = 0, dup = 0, fail = 0;
  for (let i = 0; i < toRegister.length; i++) {
    const url = toRegister[i];
    process.stdout.write(`[${String(i+1).padStart(3)}/${toRegister.length}] ${url.slice(0,55)}... `);
    const r = await registerToXfeed(url);
    if (r.success) {
      console.log('✅'); ok++;
      try {
        const tid = url.match(/\/status\/(\d+)/)?.[1];
        if (tid) {
          const res  = await supabase(`videos?tweet_id=eq.${tid}&select=id,thumbnail_url,description`);
          const d    = JSON.parse(res);
          if (d?.[0]) await generateTags(d[0].id, d[0].thumbnail_url, d[0].description);
        }
      } catch {}
    } else if (r.reason === 'duplicate') { console.log('⏭️'); dup++; }
    else { console.log(`❌ ${r.reason}`); fail++; }
    await sleep(CONFIG.intervalMs);
  }

  console.log(`\n✅ ${ok}件登録 ⏭️ ${dup}件重複 ❌ ${fail}件失敗`);
}

main().catch(e => { console.error('致命的エラー:', e); process.exit(1); });
