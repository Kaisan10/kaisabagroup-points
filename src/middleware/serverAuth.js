'use strict';

const { pool } = require('../config/database');
const { verifyApiKey } = require('../utils/apiKey');

/**
 * サーバーAPIキー認証ミドルウェア。
 * X-API-Key ヘッダを読み、server_accounts テーブルと照合する。
 * 認証成功時は req.serverAccount にアカウント情報を付与する。
 *
 * ゼロトラスト原則:
 *   - 全ての API キーは DB のハッシュと比較（平文保存なし）
 *   - is_active = false のアカウントは拒否
 *   - エラー時は詳細を漏らさず 401 を返す
 */
async function serverAuth(req, res, next) {
  // 既に認証済みの場合はスキップ（多重実行防止）
  if (req.serverAccount) {
    return next();
  }

  let rawKey = req.headers['x-api-key'] || req.headers['api-key'];
  if (!rawKey && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    rawKey = req.headers.authorization.slice(7);
  }

  // ヘッダが存在しない
  if (!rawKey || typeof rawKey !== 'string') {
    return res.status(401).json({ success: false, error: 'API key required' });
  }

  // キー形式の簡易チェック（skp_ プレフィクス）
  if (!rawKey.startsWith('skp_') || rawKey.length < 20) {
    return res.status(401).json({ success: false, error: 'Invalid API key format' });
  }

  try {
    // プレフィクスで候補を絞ってから全件比較（インデックス活用 + タイミング攻撃対策の両立）
    const prefix = rawKey.slice(0, 8);
    const result = await pool.query(
      `SELECT id, name, api_key_hash, owner_user_id, balance, webhook_url,
              seller_approval, is_active, is_trusted, allowed_ips, tx_limit
       FROM server_accounts
       WHERE api_key_prefix = $1`,
      [prefix]
    );

    // 候補がない場合も 401（存在確認を可能にしない）
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    // 候補の中からハッシュ比較で一致を探す
    const account = result.rows.find(row => verifyApiKey(rawKey, row.api_key_hash));

    if (!account) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    if (!account.is_active) {
      return res.status(403).json({ success: false, error: 'Server account is disabled' });
    }

    // IPアドレス制限の検証（信頼モードかつ allowed_ips が設定されている場合）
    if (account.is_trusted && account.allowed_ips) {
      // カンマ区切りのリストを配列化してトリム
      const allowedList = account.allowed_ips.split(',').map(ip => ip.trim()).filter(ip => ip.length > 0);
      if (allowedList.length > 0) {
        const actualIp = req.ip;

        if (!allowedList.includes(actualIp)) {
          console.warn(`⚠️ 信頼モードIP制限: 許可されていないIPからのアクセス - IP: ${actualIp}, サーバー: ${account.name}`);
          return res.status(403).json({ success: false, error: 'IP address not allowed for trusted mode' });
        }
      }
    }

    // ── 委任（Delegate）の処理 ──
    // 信頼サーバーが特定のプレイヤーのサービスアカウントの権限で操作を行うための仕組み
    const delegateMcId = req.headers['x-delegate-mc-id'];
    if (delegateMcId && typeof delegateMcId === 'string') {
      if (!account.is_trusted) {
        return res.status(403).json({ success: false, error: 'Only trusted servers can use delegation' });
      }

      // 対象プレイヤーのユーザーIDを取得
      const userResult = await pool.query(
        'SELECT id FROM users WHERE minecraft_id = $1',
        [delegateMcId.trim()]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Delegate target player not found' });
      }
      const targetUserId = userResult.rows[0].id;

      // 対象プレイヤーがこの信頼サーバーに操作を許可しているか確認
      const permResult = await pool.query(
        `SELECT delegate_allowed FROM user_trusted_servers
         WHERE user_id = $1 AND server_id = $2`,
        [targetUserId, account.id]
      );
      if (permResult.rows.length === 0 || !permResult.rows[0].delegate_allowed) {
        return res.status(403).json({ success: false, error: 'Player has not allowed delegation to this server' });
      }

      // 対象プレイヤーのサービスアカウントを取得（1人1つの有効なアカウントを想定）
      const delegateAccountResult = await pool.query(
        `SELECT id, name, api_key_hash, owner_user_id, balance, webhook_url,
                seller_approval, is_active, is_trusted, allowed_ips, tx_limit
         FROM server_accounts
         WHERE owner_user_id = $1 AND is_active = TRUE
         LIMIT 1`,
        [targetUserId]
      );

      if (delegateAccountResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Delegate target player does not have an active service account' });
      }

      // リクエストのアカウントを代理アカウントにすり替える
      // (元の信頼サーバーの情報が必要な場合のために req.originalServerAccount に退避)
      req.originalServerAccount = account;
      req.serverAccount = delegateAccountResult.rows[0];
      
      console.log(`🔄 委任実行: ${account.name} -> ${req.serverAccount.name} (mc_id: ${delegateMcId})`);
      return next();
    }

    // リクエストにアカウント情報を付与して次へ
    req.serverAccount = account;
    next();
  } catch (err) {
    console.error('❌ serverAuth エラー:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = serverAuth;
