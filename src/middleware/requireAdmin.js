'use strict';

/**
 * requireAdmin.js — 管理者認証ミドルウェア
 *
 * 2種類の認証方式をサポート:
 *   1. セッション認証（Webダッシュボード用）: ADMIN_USERNAME と一致するユーザー
 *   2. Bearer トークン（curl / API 用）: ADMIN_TOKEN と完全一致
 *
 * セキュリティ:
 *   - Bearer トークン比較は crypto.timingSafeEqual でタイミング攻撃を防止
 *   - セッション認証は ADMIN_USERNAME が設定されている場合のみ有効
 *   - どちらも設定されていない場合は 500 を返す（設定ミスの早期発見）
 */

const crypto = require('crypto');

function requireAdmin(req, res, next) {
  const adminUsername = (process.env.ADMIN_USERNAME || '').trim();
  const adminToken    = (process.env.ADMIN_TOKEN || '').trim();

  // ─── ① セッション認証（Web UI 用）────────────────────────────────────────
  // セッションに保持されている is_admin フラグをチェック
  if (req.session?.user?.is_admin === true) {
    return next();
  }

  // ─── ② Bearer トークン認証（curl / API 用）──────────────────────────────
  if (!adminToken) {
    console.error('⚠️  ADMIN_TOKEN が未設定です。ADMIN_USERNAME または ADMIN_TOKEN を .env に設定してください。');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  const authHeader = req.headers['authorization'] || '';
  const match      = authHeader.match(/^Bearer\s+(.+)$/i);
  const provided   = match ? match[1] : '';

  try {
    const a       = Buffer.from(provided,   'utf8');
    const b       = Buffer.from(adminToken, 'utf8');
    const isEqual = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!isEqual) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  } catch {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  next();
}

module.exports = requireAdmin;
