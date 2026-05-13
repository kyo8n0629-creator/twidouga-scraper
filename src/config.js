/**
 * 設定ファイル
 * 環境変数で上書き可能
 */

export const CONFIG = {
  // ── 巡回対象URL（配列で管理） ───────────────────────────────
  TARGET_URLS: [
    'https://www.twidouga.net/jp/realtime_t1.php',
    'https://www.twidouga.net/jp/realtime_t2.php',
    'https://www.twidouga.net/jp/realtime_t3.php',
  ],

  // ── Puppeteer設定 ──────────────────────────────────────────
  HEADLESS:        process.env.HEADLESS !== 'false', // デフォルトheadless、デバッグ時はfalse
  USER_AGENT:      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  VIEWPORT:        { width: 1280, height: 800 },
  LOCALE:          'ja-JP',
  TIMEZONE:        'Asia/Tokyo',

  // ── タイミング ──────────────────────────────────────────────
  PAGE_TIMEOUT_MS:    45000,  // ページロードタイムアウト
  CHALLENGE_WAIT_MS:  8000,   // Cloudflareチャレンジ通過待機
  POST_LOAD_WAIT_MS:  2000,   // DOM描画完了待機
  BETWEEN_PAGES_MS:   3000,   // ページ間のクールダウン

  // ── リトライ ────────────────────────────────────────────────
  MAX_RETRIES:        3,
  RETRY_BACKOFF_MS:   5000,   // 失敗時の待機時間（リトライごとに倍増）

  // ── 出力 ───────────────────────────────────────────────────
  OUTPUT_DIR:         'output',
  OUTPUT_FILE:        'urls.json',
  MERGE_WITH_EXISTING: true,  // 既存ファイルとマージするか

  // ── リソースブロック（軽量化用） ─────────────────────────────
  BLOCKED_RESOURCES: ['image', 'stylesheet', 'font', 'media'],

  // ── ログ ───────────────────────────────────────────────────
  LOG_LEVEL: process.env.LOG_LEVEL || 'info', // 'debug' | 'info' | 'warn' | 'error'
};
