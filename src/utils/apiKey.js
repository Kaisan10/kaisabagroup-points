'use strict';

const crypto = require('crypto');

/**
 * 暗号学的に安全なAPIキーを生成する。
 * 形式: `skp_` + 48バイトのランダム16進数 = 100文字
 * "skp" = Server Key Point の略
 */
function generateApiKey() {
  const random = crypto.randomBytes(48).toString('hex'); // 96文字
  return `skp_${random}`;
}

/**
 * APIキーを SHA-256 でハッシュ化して返す（DBに保存する値）。
 * @param {string} plainKey
 * @returns {string} 64文字の16進数ハッシュ
 */
function hashApiKey(plainKey) {
  return crypto.createHash('sha256').update(plainKey, 'utf8').digest('hex');
}

/**
 * リクエストヘッダのAPIキーを DB に保存されたハッシュと安全に比較する。
 * タイミング攻撃対策として timingSafeEqual を使用。
 * @param {string} plainKey  クライアントが送ってきた平文キー
 * @param {string} storedHash  DBに保存されているSHA-256ハッシュ
 * @returns {boolean}
 */
function verifyApiKey(plainKey, storedHash) {
  if (typeof plainKey !== 'string' || typeof storedHash !== 'string') return false;
  try {
    const incoming = Buffer.from(hashApiKey(plainKey), 'hex');
    const stored   = Buffer.from(storedHash, 'hex');
    if (incoming.length !== stored.length) return false;
    return crypto.timingSafeEqual(incoming, stored);
  } catch {
    return false;
  }
}

/**
 * UIやログ表示用の識別子（先頭8文字）を返す。
 * 平文キーを渡すことを想定。
 * @param {string} plainKey
 * @returns {string}
 */
function keyPrefix(plainKey) {
  return String(plainKey).slice(0, 8);
}

module.exports = { generateApiKey, hashApiKey, verifyApiKey, keyPrefix };
