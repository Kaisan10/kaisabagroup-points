'use strict';

// oauth.js — OAuth認証プロバイダールート
//
// エンドポイント:
//   GET  /oauth/authorize        同意画面（ログイン必須）
//   POST /oauth/authorize        同意/拒否の処理
//   POST /api/oauth/token        認可コード→トークン交換 or リフレッシュ
//   POST /api/oauth/revoke       トークン失効
//
// セキュリティ:
//   - redirect_uri はserver_accountsの登録済みリストと完全一致チェック
//   - CSRFはセッション内のstateトークンで防止
//   - client_secret = APIキー（SHA-256ハッシュ照合）

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const OAuthToken  = require('../models/OAuthToken');
const requireAuth = require('../middleware/requireAuth');
const serverAuth  = require('../middleware/serverAuth');
const { verifyApiKey } = require('../utils/apiKey');

// ─── ヘルパー ──────────────────────────────────────────────

function handleError(res, err) {
  const status  = err.statusCode || 500;
  const message = err.message    || 'Internal server error';
  if (status === 500) console.error('❌ oauth error:', err);
  return res.status(status).json({ success: false, error: message });
}

// ─── GET /oauth/authorize ─────────────────────────────────
// 同意画面を表示する。ログイン未済ならDiscourse認証へリダイレクト。
//
// QueryParams:
//   client_id    : server_accounts.id (数値)
//   redirect_uri : コールバックURL（登録済みリストと照合）
//   scope        : スペース区切りスコープ（identity / transaction）
//   state        : CSRF防止用ランダム文字列（外部アプリが生成）
router.get('/authorize', async (req, res) => {
  const { client_id, redirect_uri, scope, state } = req.query;

  // ─ パラメータ検証 ─
  if (!client_id || !redirect_uri || !scope) {
    return res.status(400).render('error', {
      user: req.session.user || null,
      title: '無効なリクエスト',
      message: 'client_id / redirect_uri / scope が必要です。',
    });
  }

  const clientIdNum = parseInt(client_id, 10);
  if (!Number.isInteger(clientIdNum) || clientIdNum <= 0) {
    return res.status(400).render('error', {
      user: req.session.user || null,
      title: '無効なクライアントID',
      message: 'client_id が正しくありません。',
    });
  }

  try {
    // スコープバリデーション
    let normalizedScope;
    try {
      normalizedScope = OAuthToken.validateScopes(scope);
    } catch (e) {
      return res.status(400).render('error', {
        user: req.session.user || null,
        title: '無効なスコープ',
        message: e.message,
      });
    }

    // サーバーアカウント存在確認
    const serverResult = await pool.query(
      'SELECT id, name, redirect_uris FROM server_accounts WHERE id = $1 AND is_active = TRUE',
      [clientIdNum]
    );
    if (serverResult.rows.length === 0) {
      return res.status(404).render('error', {
        user: req.session.user || null,
        title: 'アプリが見つかりません',
        message: '指定されたアプリはこのシステムに登録されていません。',
      });
    }

    // redirect_uri 許可チェック
    const allowed = await OAuthToken.isRedirectUriAllowed(clientIdNum, redirect_uri);
    if (!allowed) {
      return res.status(400).render('error', {
        user: req.session.user || null,
        title: '無効なコールバックURL',
        message: 'このアプリに登録されていないURLです。アプリ開発者に問い合わせてください。',
      });
    }

    // ログイン未済の場合 → ログイン後このURLに戻る
    if (!req.session.user) {
      req.session.oauthReturn = req.originalUrl;
      return res.redirect('/auth/discourse/login');
    }

    const server = serverResult.rows[0];
    const scopeDescs = OAuthToken.scopeDescriptions(normalizedScope);

    // セッションにstateを保存（CSRF防止）
    req.session.oauthState = state || null;

    return res.render('oauth-authorize', {
      user:        req.session.user,
      app:         server,
      scope:       normalizedScope,
      scopeDescs,
      redirectUri: redirect_uri,
      state:       state || '',
      clientId:    clientIdNum,
    });
  } catch (err) {
    console.error('❌ GET /oauth/authorize エラー:', err);
    return res.status(500).render('error', {
      user: req.session.user || null,
      title: 'サーバーエラー',
      message: '処理中にエラーが発生しました。',
    });
  }
});

// ─── POST /oauth/authorize ────────────────────────────────
// 同意ボタン押下後の処理。ログイン必須。
//
// Body (application/x-www-form-urlencoded):
//   action       : 'allow' | 'deny'
//   client_id    : server_accounts.id
//   redirect_uri : コールバックURL
//   scope        : スペース区切りスコープ
//   state        : CSRF防止用文字列
router.post('/authorize', requireAuth, async (req, res) => {
  const { action, client_id, redirect_uri, scope, state } = req.body;

  const clientIdNum = parseInt(client_id, 10);

  try {
    // redirect_uri 再バリデーション（フォーム改ざん防止）
    const allowed = await OAuthToken.isRedirectUriAllowed(clientIdNum, redirect_uri);
    if (!allowed) {
      return res.status(400).json({ error: 'invalid redirect_uri' });
    }

    // 拒否
    if (action === 'deny') {
      const url = new URL(redirect_uri);
      url.searchParams.set('error', 'access_denied');
      if (state) url.searchParams.set('state', state);
      return res.redirect(url.toString());
    }

    // 許可
    if (action !== 'allow') {
      return res.status(400).json({ error: 'invalid action' });
    }

    let normalizedScope;
    try {
      normalizedScope = OAuthToken.validateScopes(scope);
    } catch {
      const url = new URL(redirect_uri);
      url.searchParams.set('error', 'invalid_scope');
      if (state) url.searchParams.set('state', state);
      return res.redirect(url.toString());
    }

    // 認可コード生成
    const code = await OAuthToken.createAuthCode({
      serverId:    clientIdNum,
      userId:      req.session.user.id,
      scopes:      normalizedScope,
      redirectUri: redirect_uri,
    });

    console.log(`🔑 OAuth認可: user=${req.session.user.username} app=${clientIdNum} scope=${normalizedScope}`);

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    return res.redirect(url.toString());

  } catch (err) {
    console.error('❌ POST /oauth/authorize エラー:', err);
    try {
      const url = new URL(redirect_uri);
      url.searchParams.set('error', 'server_error');
      if (state) url.searchParams.set('state', state);
      return res.redirect(url.toString());
    } catch {
      return res.status(500).json({ error: 'server_error' });
    }
  }
});

// ─── POST /api/oauth/token ────────────────────────────────
// 認可コード → アクセストークン + リフレッシュトークン交換
// または リフレッシュトークン → 新しいアクセストークン + リフレッシュトークン
//
// Body:
//   grant_type    : 'authorization_code' | 'refresh_token'
//   client_id     : server_accounts.id
//   client_secret : APIキー (skp_...)
//   --- authorization_code ---
//   code          : 平文認可コード
//   redirect_uri  : 申請時と同一
//   --- refresh_token ---
//   refresh_token : 平文リフレッシュトークン
router.post('/api/oauth/token', async (req, res) => {
  const { grant_type, client_id, client_secret, code, redirect_uri, refresh_token } = req.body;

  if (!client_id || !client_secret) {
    return res.status(401).json({ error: 'client_id and client_secret required' });
  }

  const clientIdNum = parseInt(client_id, 10);
  if (!Number.isInteger(clientIdNum) || clientIdNum <= 0) {
    return res.status(400).json({ error: 'invalid client_id' });
  }

  try {
    // client_secret（=APIキー）でサーバーアカウントを認証
    const prefix = String(client_secret).slice(0, 8);
    const candidates = await pool.query(
      'SELECT id, api_key_hash, is_active FROM server_accounts WHERE api_key_prefix = $1',
      [prefix]
    );
    const serverRow = candidates.rows.find(r => verifyApiKey(client_secret, r.api_key_hash));
    if (!serverRow || !serverRow.is_active) {
      return res.status(401).json({ error: 'invalid_client' });
    }
    // client_idとAPIキーのサーバーが一致することを確認（他人のIDを詐称できない）
    if (serverRow.id !== clientIdNum) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    // ─ grant_type: authorization_code ─
    if (grant_type === 'authorization_code') {
      if (!code || !redirect_uri) {
        return res.status(400).json({ error: 'code and redirect_uri required' });
      }

      const tokens = await OAuthToken.exchangeCode({
        code,
        serverId:    clientIdNum,
        redirectUri: redirect_uri,
      });

      return res.json({
        access_token:  tokens.accessToken,
        token_type:    'Bearer',
        expires_in:    tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope:         tokens.scope,
      });
    }

    // ─ grant_type: refresh_token ─
    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return res.status(400).json({ error: 'refresh_token required' });
      }

      const tokens = await OAuthToken.rotateRefreshToken({
        refreshToken: refresh_token,
        serverId:     clientIdNum,
      });

      return res.json({
        access_token:  tokens.accessToken,
        token_type:    'Bearer',
        expires_in:    tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope:         tokens.scope,
      });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });

  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/oauth/revoke ───────────────────────────────
// トークンを失効させる（アクセス or リフレッシュ）
//
// Body:
//   token         : 平文トークン
//   client_id     : server_accounts.id
//   client_secret : APIキー
router.post('/api/oauth/revoke', async (req, res) => {
  const { token, client_id, client_secret } = req.body;

  if (!token || !client_id || !client_secret) {
    return res.status(400).json({ error: 'token, client_id, client_secret required' });
  }

  const clientIdNum = parseInt(client_id, 10);

  try {
    // client認証
    const prefix = String(client_secret).slice(0, 8);
    const candidates = await pool.query(
      'SELECT id, api_key_hash, is_active FROM server_accounts WHERE api_key_prefix = $1',
      [prefix]
    );
    const serverRow = candidates.rows.find(r => verifyApiKey(client_secret, r.api_key_hash));
    if (!serverRow || !serverRow.is_active || serverRow.id !== clientIdNum) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    await OAuthToken.revokeToken(token, clientIdNum);

    // RFC 7009準拠: 常に200を返す（存在しないトークンでもエラーにしない）
    return res.json({ success: true });
  } catch (err) {
    return handleError(res, err);
  }
});

module.exports = router;
