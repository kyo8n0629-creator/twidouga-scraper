/**
 * エントリーポイント
 * - スクレイピング実行
 * - JSON保存
 * - XFEED_URLが設定されていればAPIにPOST
 *
 * 使い方:
 *   node src/index.js                          # JSON保存のみ
 *   XFEED_URL=https://5xfeed.com node src/index.js  # XFeedへもPOST
 *   HEADLESS=false node src/index.js           # デバッグ
 *   LOG_LEVEL=debug node src/index.js          # 詳細ログ
 */

import { runScrape } from './scraper.js';
import { storage }   from './storage.js';
import { logger }    from './logger.js';

const POST_INTERVAL_MS = 300; // POST間隔（XFeed API保護）

/** XFeed /api/videos に1件POST。重複は409で返る */
async function postToXfeed(xfeedUrl, tweetUrl) {
  try {
    const res = await fetch(`${xfeedUrl}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tweet_url:    tweetUrl,
        description:  '',
        manual_tags:  [],
        auto_approve: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok || res.status === 201) return 'ok';
    if (res.status === 409)           return 'duplicate';
    return 'fail';
  } catch {
    return 'fail';
  }
}

/** Supabaseから既存tweet_id一覧を取得（重複POSTを事前に弾く） */
async function getRegisteredTweetIds() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return new Set();

  try {
    const ids   = new Set();
    let offset  = 0;
    const limit = 1000;
    while (true) {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/videos?select=tweet_id&offset=${offset}&limit=${limit}`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
      );
      if (!res.ok) break;
      const data = await res.json();
      if (!data.length) break;
      for (const v of data) if (v.tweet_id) ids.add(v.tweet_id);
      if (data.length < limit) break;
      offset += limit;
      if (offset >= 100000) break;
    }
    return ids;
  } catch (e) {
    logger.warn(`getRegisteredTweetIds failed: ${e.message}`);
    return new Set();
  }
}

function extractTweetId(url) {
  const m = url.match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const start    = Date.now();
  const xfeedUrl = process.env.XFEED_URL;

  try {
    // 1. スクレイピング実行
    const records = await runScrape();

    if (records.length === 0) {
      logger.warn('no URLs collected');
      process.exitCode = 1;
      return;
    }

    // 2. JSON保存（常時）
    const added = await storage.addBatch(records);
    logger.info(`collected=${records.length} new_to_json=${added}`);

    // 3. XFeedへPOST（XFEED_URLが設定されている場合のみ）
    if (xfeedUrl) {
      logger.info(`XFEED_URL=${xfeedUrl} - posting to XFeed...`);

      const registered = await getRegisteredTweetIds();
      logger.info(`registered: ${registered.size}`);

      // 既登録を除外
      const candidates = records.filter(r => {
        const id = extractTweetId(r.url);
        return id && !registered.has(id);
      });
      logger.info(`new candidates: ${candidates.length}`);

      let ok = 0, dup = 0, fail = 0;
      for (const r of candidates) {
        const result = await postToXfeed(xfeedUrl, r.url);
        if      (result === 'ok')        ok++;
        else if (result === 'duplicate') dup++;
        else                              fail++;
        await sleep(POST_INTERVAL_MS);
      }
      logger.info(`xfeed post: ok=${ok} duplicate=${dup} fail=${fail}`);
    } else {
      logger.info('XFEED_URL not set - skipping API post');
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`total elapsed: ${elapsed}s`);
  } catch (e) {
    logger.error('fatal error:', e.message);
    logger.debug(e.stack);
    process.exitCode = 1;
  }
}

// プロセス終了時のクリーンアップ
process.on('SIGINT',  () => { logger.info('SIGINT received');  process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM received'); process.exit(0); });
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection:', reason);
  process.exit(1);
});

main();
