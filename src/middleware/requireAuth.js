'use strict';

/**
 * requireAuth.js — セッション認証 + アカウント停止チェック
 *
 * セキュリティ設計:
 *   - セッションの存在確認（ログインチェック）
 *   - DB の is_suspended フラグを確認（停止中ユーザーは即時 403）
 *   - 主キー (id) での単一行ルックアップなので高速
 *   - DB エラー時は 500 を返す（セーフフェイル）
 */

const { pool } = require('../config/database');

/**
 * requireAuth — API向け認証ミドルウェア
 * JSONでエラーを返す
 */
async function requireAuth(req, res, next) {
  if (!req.session?.user?.id) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  try {
    const result = await pool.query(
      'SELECT is_suspended FROM users WHERE id = $1',
      [req.session.user.id]
    );

    if (result.rows.length === 0) {
      req.session.destroy?.();
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    const isSuspended = result.rows[0].is_suspended;
    const isAdmin = req.session.user.is_admin === true;

    if (isSuspended && !isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'アカウントが一時停止されています。管理者にお問い合わせください。',
      });
    }

    next();
  } catch (err) {
    console.error('❌ requireAuth DB error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * requireAuth.page — ページ表示向け認証ミドルウェア
 * セッション破壊してリダイレクトする
 */
requireAuth.page = async function(req, res, next) {
  if (!req.session?.user?.id) {
    return res.redirect('/');
  }

  try {
    const result = await pool.query(
      'SELECT is_suspended FROM users WHERE id = $1',
      [req.session.user.id]
    );

    if (result.rows.length === 0) {
      req.session.destroy(() => res.redirect('/'));
      return;
    }

    const isSuspended = result.rows[0].is_suspended;
    const isAdmin = req.session.user.is_admin === true;

    // セッション情報の同期
    req.session.user.is_suspended = isSuspended;

    if (isSuspended && !isAdmin) {
      // 停止中の場合、ダッシュボード以外へのアクセスを制限する（ループ防止のためクエリを確認）
      if (req.path !== '/dashboard') {
        return res.redirect('/dashboard?suspended=1');
      }
    }

    next();
  } catch (err) {
    console.error('❌ requireAuth.page DB error:', err);
    res.status(500).send('内部サーバーエラーが発生しました');
  }
};

module.exports = requireAuth;
