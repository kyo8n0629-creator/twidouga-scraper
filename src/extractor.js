/**
 * URL抽出ロジック
 * HTML文字列 / DOM要素 / aタグ群 のいずれからもX URLを抽出
 */

import { load } from 'cheerio';

// ── 正規表現 ─────────────────────────────────────────────────
// (a) フルURL形式: https://x.com/user/status/123 / https://twitter.com/user/status/123
const RE_FULL_URL  = /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+\/status\/(\d{15,})/gi;

// (b) hrefの中: ?や&を含む可能性、HTMLエンティティ含む
const RE_HREF      = /href=["']([^"']*(?:twitter|x)\.com\/[^"']*\/status\/\d{15,}[^"']*)["']/gi;

// (c) realtime.php?id=12345 のような twidouga 内部URL → x.com URLに変換
const RE_REALTIME  = /\/realtime\.php\?id=(\d{15,})/gi;

// (d) data-id="12345" や tweet_id: 12345 のような属性パターン
const RE_DATA_ID   = /(?:tweet[_-]?id|status[_-]?id|data-id)[\s=:"']+(\d{15,})/gi;

/**
 * 1つのURLを正規化
 * - twitter.com → x.com
 * - クエリパラメータ除去
 * - HTMLエンティティ復元
 * - 末尾のスラッシュ除去
 * @returns {string | null}
 */
function normalize(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  let url = rawUrl
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .trim();

  // status を含まないものは弾く
  const m = url.match(/\/status\/(\d{15,})/);
  if (!m) return null;
  const tweetId = m[1];

  // ユーザー名抽出（任意）
  const userMatch = url.match(/(?:twitter|x)\.com\/([^/?#]+)\/status\//i);
  const user = userMatch && userMatch[1] !== 'i' && userMatch[1] !== 'web' ? userMatch[1] : 'i';

  return `https://x.com/${user}/status/${tweetId}`;
}

/**
 * tweetID単体からx.com URLを構築
 */
function buildFromId(tweetId) {
  if (!/^\d{15,}$/.test(tweetId)) return null;
  return `https://x.com/i/status/${tweetId}`;
}

/**
 * HTML文字列からX URLを抽出（正規表現ベース）
 * @param {string} html
 * @returns {string[]}
 */
export function extractFromHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const urls = new Set();

  // (a) フルURL
  for (const m of html.matchAll(RE_FULL_URL)) {
    const u = normalize(m[0]);
    if (u) urls.add(u);
  }
  // (b) href属性
  for (const m of html.matchAll(RE_HREF)) {
    const u = normalize(m[1]);
    if (u) urls.add(u);
  }
  // (c) realtime.php?id=
  for (const m of html.matchAll(RE_REALTIME)) {
    const u = buildFromId(m[1]);
    if (u) urls.add(u);
  }
  // (d) data属性
  for (const m of html.matchAll(RE_DATA_ID)) {
    const u = buildFromId(m[1]);
    if (u) urls.add(u);
  }

  return [...urls];
}

/**
 * HTML文字列からX URLを抽出（Cheerio DOM解析ベース）
 * 動的に書き換えられたhref等を正確に取れる
 */
export function extractFromDom(html) {
  if (!html) return [];
  const urls = new Set();

  try {
    const $ = load(html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/(?:twitter|x)\.com\/.+\/status\/\d{15,}/i.test(href)) {
        const u = normalize(href);
        if (u) urls.add(u);
      } else {
        // twidouga 内部リンク（realtime.php?id=）
        const m = href.match(/\/realtime\.php\?id=(\d{15,})/);
        if (m) {
          const u = buildFromId(m[1]);
          if (u) urls.add(u);
        }
      }
    });
    // data属性
    $('[data-tweet-id], [data-status-id], [data-id]').each((_, el) => {
      const attrs = el.attribs || {};
      for (const key of ['data-tweet-id', 'data-status-id', 'data-id']) {
        const v = attrs[key];
        if (v && /^\d{15,}$/.test(v)) {
          const u = buildFromId(v);
          if (u) urls.add(u);
        }
      }
    });
  } catch (e) {
    // cheerioパース失敗時は無視（正規表現側で拾える）
  }

  return [...urls];
}

/**
 * HTMLから両方の方法でURL抽出し、マージ・重複除去
 */
export function extractAll(html) {
  const fromRegex = extractFromHtml(html);
  const fromDom   = extractFromDom(html);
  return [...new Set([...fromRegex, ...fromDom])];
}

/**
 * Puppeteer の page からも直接抽出（描画後のDOMアクセス）
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string[]>}
 */
export async function extractFromPage(page) {
  try {
    const hrefs = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors.map(a => a.href).filter(h => h.includes('/status/'));
    });
    const urls = new Set();
    for (const href of hrefs) {
      const u = normalize(href);
      if (u) urls.add(u);
    }
    return [...urls];
  } catch {
    return [];
  }
}
