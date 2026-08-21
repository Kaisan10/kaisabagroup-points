'use strict';

/**
 * serverRegister.js — サーバー自己登録フロー
 *
 * セキュリティ設計:
 *   - register-request は認証不要だが IP 単位のレート制限を適用
 *   - トークンは crypto.randomBytes(32) = 256bit の乱数（推測不可能）
 *   - register-confirm はセッション認証必須 + FOR UPDATE で二重登録を防止
 *   - APIキーは DB にハッシュのみ保存。平文はレスポンスに一度だけ返す
 *   - ポーリング (register-status) は status のみ返す（APIキーは返さない）
 */

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../config/database');
const ServerAccount = require('../models/ServerAccount');

// レート制限: register-request は IP 単位で 1分5回まで
const registerRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

// レート制限: ポーリング用
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

/** 64文字の16進乱数トークンを生成（256bit エントロピー） */
function generateRegToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── POST /api/server/register-request ────────────────────────────────────
// 認証不要。プラグインが起動時に呼ぶ。登録確認URLを返す。
router.post('/register-request', registerRequestLimiter, async (req, res) => {
  try {
    const { server_name } = req.body;

    // バリデーション
    if (!server_name || typeof server_name !== 'string' || server_name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'server_name is required' });
    }
    if (server_name.trim().length > 100) {
      return res.status(400).json({ success: false, error: 'server_name too long (max 100)' });
    }

    const token     = generateRegToken();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10分

    await pool.query(
      `INSERT INTO server_registration_tokens (token, server_name, expires_at)
       VALUES ($1, $2, $3)`,
      [token, server_name.trim(), expiresAt]
    );

    const siteUrl = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const registrationUrl = `${siteUrl}/register-server?token=${token}`;

    return res.json({
      success: true,
      data: {
        registration_url: registrationUrl,
        expires_in: 600, // 秒
      },
    });
  } catch (err) {
    console.error('❌ register-request error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── GET /api/server/register-status/:token ───────────────────────────────
// プラグインがポーリングして登録完了を確認する。
// セキュリティ: APIキーはここでは返さない（Web UI に一度だけ表示済み）
router.get('/register-status/:token', statusLimiter, async (req, res) => {
  try {
    const token = String(req.params.token).trim().toLowerCase();

    // トークン形式チェック（64文字の16進数のみ許可）
    if (!/^[0-9a-f]{64}$/.test(token)) {
      return res.status(400).json({ success: false, error: 'Invalid token format' });
    }

    const result = await pool.query(
      `SELECT status, server_name, expires_at
       FROM server_registration_tokens
       WHERE token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Token not found' });
    }

    const row = result.rows[0];

    // pending かつ期限切れなら expired に更新
    if (row.status === 'pending' && new Date() > new Date(row.expires_at)) {
      await pool.query(
        `UPDATE server_registration_tokens SET status = 'expired' WHERE token = $1`,
        [token]
      );
      return res.json({ success: true, data: { status: 'expired' } });
    }

    return res.json({
      success: true,
      data: {
        status:      row.status,
        server_name: row.server_name,
      },
    });
  } catch (err) {
    console.error('❌ register-status error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── POST /api/server/register-confirm ────────────────────────────────────
// ログイン済みユーザーがWebから登録を承認する。
//
// セキュリティ:
//   - セッション認証必須（ログインしていないと 401）
//   - FOR UPDATE でトークン行をロック → 二重登録防止
//   - 期限切れ・完了済みトークンは拒否
//   - APIキーは SHA-256 ハッシュのみ DB に保存。平文は一度だけ返す
router.post('/register-confirm', async (req, res) => {
  // セッションチェック
  if (!req.session?.user?.id) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, error: 'token is required' });
    }
    const cleanToken = token.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(cleanToken)) {
      return res.status(400).json({ success: false, error: 'Invalid token format' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // トークンを行ロックして取得（同時リクエスト対策）
      const result = await client.query(
        `SELECT id, server_name, status, expires_at
         FROM server_registration_tokens
         WHERE token = $1
         FOR UPDATE`,
        [cleanToken]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Token not found' });
      }

      const row = result.rows[0];

      if (row.status === 'completed') {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'Already registered' });
      }
      if (row.status === 'expired' || new Date() > new Date(row.expires_at)) {
        await client.query('ROLLBACK');
        return res.status(410).json({ success: false, error: 'Token has expired' });
      }

      // サービスアカウントを作成（ServerAccount.create内でAPIキーのハッシュがDBに保存される）
      const { account, plainApiKey } = await ServerAccount.create({
        name:        row.server_name,
        ownerUserId: req.session.user.id,
      });

      // トークンステータスを completed に更新
      await client.query(
        `UPDATE server_registration_tokens SET status = 'completed' WHERE id = $1`,
        [row.id]
      );

      await client.query('COMMIT');

      console.log(`✅ サーバー自己登録完了: server_id=${account.id} name="${account.name}" owner=${req.session.user.username}`);

      // APIキーはここで一度だけ返す
      return res.status(201).json({
        success: true,
        data: {
          server_name:    account.name,
          api_key:        plainApiKey, // ← 一度のみ
          api_key_prefix: account.api_key_prefix,
          message: 'このAPIキーは二度と表示されません。今すぐコピーしてプラグインの設定ファイルに保存してください。',
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ register-confirm error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
