/**
 * 設定ファイル
 * 環境変数で上書き可能
 */

export const CONFIG = {
  // ── 巡回対象URL ────────────────────────────────────────────
  // realtime_t1.php のみ（t2, t3 は Cloudflare 連続アクセスで弾かれるため）
  TARGET_URLS: [
    'https://www.twidouga.net/jp/realtime_t1.php',
  ],

  // ── Puppeteer設定 ──────────────────────────────────────────
  HEADLESS:        process.env.HEADLESS !== 'false',
  USER_AGENT:      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  VIEWPORT:        { width: 1280, height: 800 },
  LOCALE:          'ja-JP',
  TIMEZONE:        'Asia/Tokyo',

  // ── タイミング ──────────────────────────────────────────────
  PAGE_TIMEOUT_MS:    45000,
  CHALLENGE_WAIT_MS:  8000,
  POST_LOAD_WAIT_MS:  2000,
  BETWEEN_PAGES_MS:   3000,

  // ── リトライ ────────────────────────────────────────────────
  MAX_RETRIES:        3,
  RETRY_BACKOFF_MS:   5000,

  // ── 出力 ───────────────────────────────────────────────────
  OUTPUT_DIR:         'output',
  OUTPUT_FILE:        'urls.json',
  MERGE_WITH_EXISTING: true,

  // ── リソースブロック ────────────────────────────────────────
  BLOCKED_RESOURCES: ['image', 'stylesheet', 'font', 'media'],

  // ── ログ ───────────────────────────────────────────────────
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};
