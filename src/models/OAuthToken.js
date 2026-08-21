'use strict';

// OAuthToken.js — OAuth認証プロバイダー用トークン管理モデル
//
// トークン戦略:
//   - アクセストークン: 1時間有効 (apt_ プレフィックス)
//   - リフレッシュトークン: 90日有効・使用ごとにローテーション (rpt_ プレフィックス)
//   - 認可コード: 10分有効・ワンタイム (oac_ プレフィックス)
//   - すべてSHA-256ハッシュのみDB保存（平文は1度だけ返す）

const crypto = require('crypto');
const { pool } = require('../config/database');

// ─── 定数 ─────────────────────────────────────────────────
const ACCESS_TOKEN_TTL_MS  = 60 * 60 * 1000;           // 1時間
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90日
const AUTH_CODE_TTL_MS     = 10 * 60 * 1000;           // 10分

// 許可されているスコープ一覧
const VALID_SCOPES = ['identity', 'transaction'];

// ─── ヘルパー ──────────────────────────────────────────────

/**
 * プレフィックス付きランダムトークンを生成する。
 * @param {string} prefix - 'apt_' | 'rpt_' | 'oac_'
 * @returns {string} 平文トークン
 */
function generateToken(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * トークン or コードをSHA-256ハッシュ化する。
 * @param {string} token
 * @returns {string} 64文字16進数ハッシュ
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * DBの検索用プレフィックス（先頭8文字）を返す。
 * @param {string} token
 * @returns {string}
 */
function tokenPrefix(token) {
  return token.slice(0, 8);
}

/**
 * スコープ文字列をバリデートして正規化する。
 * @param {string|string[]} scopeInput - スペース区切り文字列 or 配列
 * @returns {string} 正規化済みスコープ文字列
 * @throws 無効なスコープが含まれる場合
 */
function validateScopes(scopeInput) {
  const requested = Array.isArray(scopeInput)
    ? scopeInput
    : String(scopeInput).split(' ').filter(Boolean);

  for (const s of requested) {
    if (!VALID_SCOPES.includes(s)) {
      throw Object.assign(new Error(`Invalid scope: ${s}`), { statusCode: 400 });
    }
  }
  return [...new Set(requested)].join(' ');
}

class OAuthToken {
  // ─── 認可コード ─────────────────────────────────────────

  /**
   * 認可コードを生成してDBに保存する。
   *
   * @param {object} opts
   * @param {number} opts.serverId    - server_accounts.id
   * @param {number} opts.userId      - users.id
   * @param {string} opts.scopes      - スペース区切りスコープ文字列
   * @param {string} opts.redirectUri - コールバックURI
   * @returns {Promise<string>} 平文認可コード
   */
  static async createAuthCode({ serverId, userId, scopes, redirectUri }) {
    const plainCode  = generateToken('oac_');
    const codeHash   = hashToken(plainCode);
    const expiresAt  = new Date(Date.now() + AUTH_CODE_TTL_MS);

    await pool.query(
      `INSERT INTO oauth_auth_codes (code, server_id, user_id, scopes, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [codeHash, serverId, userId, scopes, redirectUri, expiresAt]
    );

    return plainCode;
  }

  /**
   * 認可コードを検証し、アクセストークン＋リフレッシュトークンを発行する。
   * コードはワンタイムなので使用済みにマークする。
   *
   * @param {object} opts
   * @param {string} opts.code        - 平文認可コード
   * @param {number} opts.serverId    - X-API-Keyで認証済みのサーバーID
   * @param {string} opts.redirectUri - 申請時と一致確認
   * @returns {Promise<{accessToken, refreshToken, expiresIn, scope}>}
   */
  static async exchangeCode({ code, serverId, redirectUri }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const codeHash = hashToken(code);
      const result = await client.query(
        `SELECT id, server_id, user_id, scopes, redirect_uri, expires_at, used
         FROM oauth_auth_codes
         WHERE code = $1 FOR UPDATE`,
        [codeHash]
      );

      if (result.rows.length === 0) {
        throw Object.assign(new Error('Invalid authorization code'), { statusCode: 400 });
      }

      const row = result.rows[0];

      // ワンタイムチェック
      if (row.used) {
        throw Object.assign(new Error('Authorization code already used'), { statusCode: 400 });
      }
      // 有効期限チェック
      if (new Date() > new Date(row.expires_at)) {
        throw Object.assign(new Error('Authorization code expired'), { statusCode: 400 });
      }
      // サーバーIDチェック（他サーバーのコードを使えない）
      if (row.server_id !== serverId) {
        throw Object.assign(new Error('Invalid authorization code'), { statusCode: 400 });
      }
      // redirect_uriチェック
      if (row.redirect_uri !== redirectUri) {
        throw Object.assign(new Error('redirect_uri mismatch'), { statusCode: 400 });
      }

      // コードを使用済みにする
      await client.query(
        'UPDATE oauth_auth_codes SET used = TRUE WHERE id = $1',
        [row.id]
      );

      // アクセストークン発行
      const plainAt   = generateToken('apt_');
      const atHash    = hashToken(plainAt);
      const atPrefix  = tokenPrefix(plainAt);
      const atExpires = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);

      await client.query(
        `INSERT INTO oauth_access_tokens (token_hash, token_prefix, server_id, user_id, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [atHash, atPrefix, serverId, row.user_id, row.scopes, atExpires]
      );

      // リフレッシュトークン発行
      const plainRt   = generateToken('rpt_');
      const rtHash    = hashToken(plainRt);
      const rtPrefix  = tokenPrefix(plainRt);
      const rtExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

      await client.query(
        `INSERT INTO oauth_refresh_tokens (token_hash, token_prefix, server_id, user_id, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rtHash, rtPrefix, serverId, row.user_id, row.scopes, rtExpires]
      );

      await client.query('COMMIT');

      return {
        accessToken:  plainAt,
        refreshToken: plainRt,
        expiresIn:    Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        scope:        row.scopes,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── アクセストークン ────────────────────────────────────

  /**
   * アクセストークンを検証し、ユーザー情報を返す。
   *
   * @param {string} token      - 平文アクセストークン (apt_...)
   * @param {number} serverId   - 呼び出し元サーバーID（他サーバーのトークンを使えない）
   * @param {string} [needScope] - 要求スコープ（省略時はスコープチェックなし）
   * @returns {Promise<{userId, scopes}>}
   */
  static async verifyAccessToken(token, serverId, needScope = null) {
    if (!token || !token.startsWith('apt_')) {
      throw Object.assign(new Error('Invalid access token'), { statusCode: 401 });
    }

    const hash   = hashToken(token);
    const prefix = tokenPrefix(token);

    // プレフィックスで候補を絞り、ハッシュで完全一致を確認
    const result = await pool.query(
      `SELECT id, token_hash, server_id, user_id, scopes, expires_at, revoked
       FROM oauth_access_tokens
       WHERE token_prefix = $1`,
      [prefix]
    );

    const row = result.rows.find(r => r.token_hash === hash);
    if (!row) {
      throw Object.assign(new Error('Invalid access token'), { statusCode: 401 });
    }
    if (row.revoked) {
      throw Object.assign(new Error('Access token revoked'), { statusCode: 401 });
    }
    if (new Date() > new Date(row.expires_at)) {
      throw Object.assign(new Error('Access token expired'), { statusCode: 401 });
    }
    if (row.server_id !== serverId) {
      throw Object.assign(new Error('Access token not issued for this client'), { statusCode: 401 });
    }

    // スコープチェック
    if (needScope) {
      const grantedScopes = row.scopes.split(' ');
      if (!grantedScopes.includes(needScope)) {
        throw Object.assign(
          new Error(`Insufficient scope: ${needScope} required`),
          { statusCode: 403 }
        );
      }
    }

    return { userId: row.user_id, scopes: row.scopes };
  }

  // ─── リフレッシュトークン ────────────────────────────────

  /**
   * リフレッシュトークンを使って新しいアクセストークン＋リフレッシュトークンを発行する。
   * 旧リフレッシュトークンは使用済みにし、新しいものへの参照を保持（ローテーション）。
   * 旧トークンが既に使用済みなら、そのユーザーのトークンを全失効（盗難検知）。
   *
   * @param {object} opts
   * @param {string} opts.refreshToken - 平文リフレッシュトークン (rpt_...)
   * @param {number} opts.serverId     - 呼び出し元サーバーID
   * @returns {Promise<{accessToken, refreshToken, expiresIn, scope}>}
   */
  static async rotateRefreshToken({ refreshToken, serverId }) {
    if (!refreshToken || !refreshToken.startsWith('rpt_')) {
      throw Object.assign(new Error('Invalid refresh token'), { statusCode: 400 });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const hash   = hashToken(refreshToken);
      const prefix = tokenPrefix(refreshToken);

      const result = await client.query(
        `SELECT id, server_id, user_id, scopes, expires_at, used, revoked
         FROM oauth_refresh_tokens
         WHERE token_prefix = $1 FOR UPDATE`,
        [prefix]
      );
      const row = result.rows.find(r => r.token_hash === hash);

      if (!row) {
        throw Object.assign(new Error('Invalid refresh token'), { statusCode: 400 });
      }
      if (row.revoked) {
        throw Object.assign(new Error('Refresh token revoked'), { statusCode: 400 });
      }
      if (row.server_id !== serverId) {
        throw Object.assign(new Error('Refresh token not issued for this client'), { statusCode: 400 });
      }
      if (new Date() > new Date(row.expires_at)) {
        throw Object.assign(new Error('Refresh token expired'), { statusCode: 400 });
      }

      // 盗難検知: 既に使用済みのトークンを再利用しようとした場合
      // → このユーザーのこのサーバーのトークンを全て失効させる
      if (row.used) {
        await client.query(
          `UPDATE oauth_refresh_tokens SET revoked = TRUE
           WHERE user_id = $1 AND server_id = $2`,
          [row.user_id, serverId]
        );
        await client.query(
          `UPDATE oauth_access_tokens SET revoked = TRUE
           WHERE user_id = $1 AND server_id = $2`,
          [row.user_id, serverId]
        );
        await client.query('COMMIT');
        console.warn(`⚠️ OAuthリフレッシュトークン再利用検知: user_id=${row.user_id} server_id=${serverId} - 全トークン失効`);
        throw Object.assign(new Error('Refresh token reuse detected'), { statusCode: 400 });
      }

      // 旧リフレッシュトークンを使用済みにする
      await client.query(
        'UPDATE oauth_refresh_tokens SET used = TRUE WHERE id = $1',
        [row.id]
      );

      // 新アクセストークン発行
      const plainAt   = generateToken('apt_');
      const atHash    = hashToken(plainAt);
      const atPrefix  = tokenPrefix(plainAt);
      const atExpires = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);

      await client.query(
        `INSERT INTO oauth_access_tokens (token_hash, token_prefix, server_id, user_id, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [atHash, atPrefix, serverId, row.user_id, row.scopes, atExpires]
      );

      // 新リフレッシュトークン発行
      const plainRt   = generateToken('rpt_');
      const rtHash    = hashToken(plainRt);
      const rtPrefix  = tokenPrefix(plainRt);
      const rtExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

      const newRtResult = await client.query(
        `INSERT INTO oauth_refresh_tokens (token_hash, token_prefix, server_id, user_id, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [rtHash, rtPrefix, serverId, row.user_id, row.scopes, rtExpires]
      );

      // 旧トークンから新トークンへの参照を記録
      await client.query(
        'UPDATE oauth_refresh_tokens SET replaced_by = $1 WHERE id = $2',
        [newRtResult.rows[0].id, row.id]
      );

      await client.query('COMMIT');

      return {
        accessToken:  plainAt,
        refreshToken: plainRt,
        expiresIn:    Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        scope:        row.scopes,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── 失効 ───────────────────────────────────────────────

  /**
   * 指定トークン（アクセス or リフレッシュ）を失効させる。
   * サーバーIDが一致しない場合は無視（エラーにしない）。
   *
   * @param {string} token    - 平文トークン
   * @param {number} serverId - 呼び出し元サーバーID
   */
  static async revokeToken(token, serverId) {
    if (!token) return;
    const hash   = hashToken(token);
    const prefix = tokenPrefix(token);

    if (token.startsWith('apt_')) {
      await pool.query(
        'UPDATE oauth_access_tokens SET revoked = TRUE WHERE token_prefix = $1 AND token_hash = $2 AND server_id = $3',
        [prefix, hash, serverId]
      );
    } else if (token.startsWith('rpt_')) {
      await pool.query(
        'UPDATE oauth_refresh_tokens SET revoked = TRUE WHERE token_prefix = $1 AND token_hash = $2 AND server_id = $3',
        [prefix, hash, serverId]
      );
    }
  }

  /**
   * 指定ユーザーの特定サーバーへの全トークンを失効させる（連携解除用）。
   *
   * @param {number} userId
   * @param {number} serverId
   */
  static async revokeAllForUserServer(userId, serverId) {
    await pool.query(
      'UPDATE oauth_access_tokens SET revoked = TRUE WHERE user_id = $1 AND server_id = $2',
      [userId, serverId]
    );
    await pool.query(
      'UPDATE oauth_refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND server_id = $2',
      [userId, serverId]
    );
  }

  // ─── ユーザー連携アプリ一覧 ─────────────────────────────

  /**
   * ユーザーが許可している連携アプリ一覧を返す（設定ページ用）。
   * 有効なリフレッシュトークンが存在するアプリのみ表示。
   *
   * @param {number} userId
   * @returns {Promise<Array>}
   */
  static async listAuthorizedApps(userId) {
    const result = await pool.query(
      `SELECT DISTINCT ON (rt.server_id)
              sa.id AS server_id,
              sa.name AS app_name,
              rt.scopes,
              rt.created_at AS authorized_at,
              rt.expires_at AS refresh_expires_at
       FROM oauth_refresh_tokens rt
       JOIN server_accounts sa ON sa.id = rt.server_id
       WHERE rt.user_id = $1
         AND rt.revoked = FALSE
         AND rt.used = FALSE
         AND rt.expires_at > NOW()
       ORDER BY rt.server_id, rt.created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  // ─── redirect_uri バリデーション ─────────────────────────

  /**
   * 外部アプリのredirect_uriがサーバーアカウントの登録済みリストに含まれるか確認する。
   *
   * @param {number} serverId
   * @param {string} redirectUri
   * @returns {Promise<boolean>}
   */
  static async isRedirectUriAllowed(serverId, redirectUri) {
    const result = await pool.query(
      'SELECT redirect_uris FROM server_accounts WHERE id = $1 AND is_active = TRUE',
      [serverId]
    );
    if (result.rows.length === 0) return false;

    const raw = result.rows[0].redirect_uris;
    if (!raw) return false;

    const allowed = raw.split('\n').map(u => u.trim()).filter(Boolean);
    return allowed.includes(redirectUri);
  }

  // ─── スコープユーティリティ ──────────────────────────────

  /**
   * スコープをバリデートして正規化する。
   * @param {string} scopeStr
   * @returns {string}
   */
  static validateScopes(scopeStr) {
    return validateScopes(scopeStr);
  }

  /**
   * スコープの日本語説明を返す（同意画面用）。
   * @param {string} scopeStr
   * @returns {Array<{scope, label, description}>}
   */
  static scopeDescriptions(scopeStr) {
    const map = {
      identity: {
        scope: 'identity',
        icon: 'fa-user',
        label: 'ユーザー情報',
        description: 'ユーザー名・ユーザーID・Minecraft ID（メールアドレスは含まれません）',
      },
      transaction: {
        scope: 'transaction',
        icon: 'fa-coins',
        label: 'ポイント取引',
        description: 'このアプリがあなたの代わりに取引を開始できます（承認はダッシュボードで行います）',
      },
    };
    return scopeStr.split(' ').filter(Boolean).map(s => map[s]).filter(Boolean);
  }
}

module.exports = OAuthToken;
