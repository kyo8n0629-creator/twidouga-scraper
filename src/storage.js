/**
 * 保存層
 * - 現状: JSONファイル (output/urls.json)
 * - 将来: SQLite に差し替え可能なインターフェース
 */

import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { logger } from './logger.js';

/**
 * Storageの基底インターフェース
 * 後で SQLite 実装に差し替える際もこのメソッドを満たせばOK
 */
class StorageBase {
  async loadAll() { return []; }
  async saveAll(_records) {}
  async addBatch(_newRecords) { return 0; }
}

/**
 * JSON実装
 */
class JsonStorage extends StorageBase {
  constructor(dir = CONFIG.OUTPUT_DIR, file = CONFIG.OUTPUT_FILE) {
    super();
    this.dir  = dir;
    this.path = path.join(dir, file);
  }

  async _ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async loadAll() {
    try {
      const txt  = await fs.readFile(this.path, 'utf-8');
      const data = JSON.parse(txt);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      logger.warn('storage load failed:', e.message);
      return [];
    }
  }

  async saveAll(records) {
    await this._ensureDir();
    // アトミック書き込み: 一時ファイルに書いてからrename
    const tmpPath = `${this.path}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(records, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.path);
  }

  /**
   * 既存と新規をマージ・重複除去して保存
   * @param {{url: string, collected_at: string}[]} newRecords
   * @returns {number} 実際に追加された件数
   */
  async addBatch(newRecords) {
    if (!newRecords?.length) return 0;

    const existing = CONFIG.MERGE_WITH_EXISTING ? await this.loadAll() : [];
    const seen     = new Set(existing.map(r => r.url));

    let added = 0;
    for (const r of newRecords) {
      if (!seen.has(r.url)) {
        existing.push(r);
        seen.add(r.url);
        added++;
      }
    }

    await this.saveAll(existing);
    return added;
  }
}

/**
 * SQLite実装のスケルトン（将来用）
 * better-sqlite3 をインストール後にこの実装に切り替える
 *
 * import Database from 'better-sqlite3';
 * class SqliteStorage extends StorageBase { ... }
 */

// 現状はJSONを使う
export const storage = new JsonStorage();

// 将来切り替え用エクスポート
export { JsonStorage, StorageBase };
