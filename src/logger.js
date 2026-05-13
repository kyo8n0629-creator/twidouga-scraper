/**
 * シンプルなロガー
 * タイムスタンプ付きで標準出力
 */

import { CONFIG } from './config.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[CONFIG.LOG_LEVEL] ?? 1;

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function log(level, ...args) {
  if (LEVELS[level] < CURRENT_LEVEL) return;
  const prefix = `[${ts()}] [${level.toUpperCase()}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
}

export const logger = {
  debug: (...a) => log('debug', ...a),
  info:  (...a) => log('info',  ...a),
  warn:  (...a) => log('warn',  ...a),
  error: (...a) => log('error', ...a),
};
