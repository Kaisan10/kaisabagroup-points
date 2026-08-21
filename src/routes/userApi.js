'use strict';

/**
 * userApi.js — ユーザー向け取引API
 *
 * セキュリティ設計:
 *   - 全エンドポイントに requireAuth（セッション + is_suspended チェック）
 *   - buyer-approve: DB で buyer_user_id = session.user.id を確認（なりすまし防止）
 *   - FOR UPDATE ロックで同時承認を防止
 *   - pending_buyer 状態のみ承認可能（状態機械の保護）
 *   - expires_at > NOW() を DB クエリ内で検証
 */

const express  = require('express');
const router   = express.Router();
const requireAuth = require('../middleware/requireAuth');
const PendingTransaction = require('../models/PendingTransaction');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const OAuthToken = require('../models/OAuthToken');

// 全エンドポイントにセッション認証を適用
router.use(requireAuth);

function handleError(res, err) {
  const status  = err.statusCode || 500;
  const message = err.message    || 'Internal server error';
  if (status === 500) console.error('❌ userApi error:', err);
  return res.status(status).json({ success: false, error: message, ...(err.data ? { data: err.data } : {}) });
}

// ─── GET /api/user/tx/pending ──────────────────────────────────────────────
// 自分宛の pending_buyer 取引一覧（ダッシュボードのポーリング用）
router.get('/tx/pending', async (req, res) => {
  try {
    const txs = await PendingTransaction.listPendingForBuyer(req.session.user.id);
    return res.json({ success: true, data: txs });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/user/tx/:id/buyer-approve ──────────────────────────────────
// Webから買い手承認。confirm_code不要（セッションで本人確認済み）。
router.post('/tx/:id/buyer-approve', async (req, res) => {
  try {
    const txId = parseInt(req.params.id, 10);
    if (!Number.isInteger(txId) || txId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid transaction id' });
    }

    const result = await PendingTransaction.buyerApproveByUser({
      txId,
      userId: req.session.user.id,
    });

    console.log(`✅ 買い手Web承認: tx_id=${txId} user=${req.session.user.username}`);
    return res.json({ success: true, data: { status: result.status } });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/user/tx/:id/reject ─────────────────────────────────────────
// Webから買い手拒否。
router.post('/tx/:id/reject', async (req, res) => {
  try {
    const txId = parseInt(req.params.id, 10);
    if (!Number.isInteger(txId) || txId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid transaction id' });
    }

    const result = await PendingTransaction.rejectByBuyer({
      txId,
      userId: req.session.user.id,
    });

    console.log(`🚫 買い手Web拒否: tx_id=${txId} user=${req.session.user.username}`);
    return res.json({ success: true, data: { status: result.status } });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/user/ranking-opt-in ────────────────────────────────────────
// ランキング参加設定を変更する
router.post('/ranking-opt-in', async (req, res) => {
  const { opt_in } = req.body;
  if (typeof opt_in !== 'boolean') {
    return res.status(400).json({ success: false, error: 'opt_in must be boolean' });
  }
  try {
    await User.setRankingOptIn(req.session.user.id, opt_in);
    return res.json({ success: true });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/user/subscriptions ──────────────────────────────────────────
// ユーザーの有効サブスク一覧（ダッシュボードポーリング用）
router.get('/subscriptions', async (req, res) => {
  try {
    const subs = await Subscription.listByUser(req.session.user.id);
    return res.json({ success: true, data: subs });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/user/subscription/:id/approve ──────────────────────────────
// ユーザーがサブスクを初回同意する
router.post('/subscription/:id/approve', async (req, res) => {
  try {
    const subId = parseInt(req.params.id, 10);
    if (!Number.isInteger(subId) || subId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid subscription id' });
    }

    const result = await Subscription.approveByUser({
      subId,
      userId: req.session.user.id,
    });

    console.log(`✅ サブスク承認: sub_id=${subId} user=${req.session.user.username}`);
    return res.json({ success: true, data: { status: result.status, next_charge_at: result.nextChargeAt } });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/user/subscription/:id/cancel ───────────────────────────────
// ユーザー側からサブスクをキャンセルする
router.post('/subscription/:id/cancel', async (req, res) => {
  try {
    const subId = parseInt(req.params.id, 10);
    if (!Number.isInteger(subId) || subId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid subscription id' });
    }

    const result = await Subscription.cancelByUser({
      subId,
      userId: req.session.user.id,
    });

    console.log(`🚫 サブスクキャンセル(user): sub_id=${subId} user=${req.session.user.username}`);
    return res.json({ success: true, data: { id: result.id, status: result.status } });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/user/trusted-servers ────────────────────────────────────────
// 信頼サーバー一覧と、自分の設定状態（自動承認・操作許可）を返す
router.get('/trusted-servers', async (req, res) => {
  const { pool } = require('../config/database');
  try {
    const userId = req.session.user.id;

    // 信頼サーバー一覧と、ユーザーごとの設定を JOIN して取得
    const result = await pool.query(
      `SELECT sa.id, sa.name,
              COALESCE(uts.delegate_allowed, FALSE) AS delegate_allowed,
              COALESCE(uts.auto_approve, FALSE) AS auto_approve
       FROM server_accounts sa
       LEFT JOIN user_trusted_servers uts
         ON uts.server_id = sa.id AND uts.user_id = $1
       WHERE sa.is_trusted = TRUE AND sa.is_active = TRUE
       ORDER BY sa.name ASC`,
      [userId]
    );

    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/user/trusted-servers/:id/settings ────────────────────────
// 特定の信頼サーバーへの「自動承認」および「操作許可（プレイヤーショップ委任）」をオンオフする
//
// @param {number}  :id               server_accounts.id
// @body  {boolean} [auto_approve]     true: 許可 / false: 取り消し
// @body  {boolean} [delegate_allowed] true: 許可 / false: 取り消し
router.post('/trusted-servers/:id/settings', async (req, res) => {
  const { pool } = require('../config/database');
  try {
    const serverId = parseInt(req.params.id, 10);
    if (!Number.isInteger(serverId) || serverId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid server id' });
    }

    const { auto_approve, delegate_allowed } = req.body;
    
    // 少なくとも1つの設定が含まれているかチェック
    if (auto_approve === undefined && delegate_allowed === undefined) {
      return res.status(400).json({ success: false, error: 'No settings provided' });
    }

    const userId = req.session.user.id;

    // 対象が信頼サーバーかチェック（なりすまし防止）
    const serverCheck = await pool.query(
      'SELECT id FROM server_accounts WHERE id = $1 AND is_trusted = TRUE AND is_active = TRUE',
      [serverId]
    );
    if (serverCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Trusted server not found' });
    }

    // 新規作成時のデフォルト値用
    const initialAutoApprove = auto_approve !== undefined ? Boolean(auto_approve) : false;
    const initialDelegate = delegate_allowed !== undefined ? Boolean(delegate_allowed) : false;

    // UPSERT: レコードがなければ作成、あれば指定された値だけ更新
    const updates = [];
    if (auto_approve !== undefined) {
      updates.push('auto_approve = EXCLUDED.auto_approve');
    }
    if (delegate_allowed !== undefined) {
      updates.push('delegate_allowed = EXCLUDED.delegate_allowed');
    }

    await pool.query(
      `INSERT INTO user_trusted_servers (user_id, server_id, auto_approve, delegate_allowed)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, server_id)
       DO UPDATE SET ${updates.join(', ')}`,
      [userId, serverId, initialAutoApprove, initialDelegate]
    );

    console.log(`🔑 信頼サーバー設定変更: user=${req.session.user.username} server_id=${serverId} auto_approve=${auto_approve} delegate=${delegate_allowed}`);
    return res.json({ success: true });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/user/authorized-apps ───────────────────────────────────────
// ユーザーが連携を許可している外部アプリ一覧を取得する
router.get('/authorized-apps', async (req, res) => {
  try {
    const apps = await OAuthToken.listAuthorizedApps(req.session.user.id);
    return res.json({ success: true, data: apps });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/user/authorized-apps/:id/revoke ───────────────────────────
// 外部アプリの連携を解除する
router.post('/authorized-apps/:id/revoke', async (req, res) => {
  try {
    const serverId = parseInt(req.params.id, 10);
    if (!Number.isInteger(serverId) || serverId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid server id' });
    }

    await OAuthToken.revokeAllForUserServer(req.session.user.id, serverId);

    console.log(`🔒 アプリ連携解除: user=${req.session.user.username} server_id=${serverId}`);
    return res.json({ success: true });
  } catch (err) {
    return handleError(res, err);
  }
});

module.exports = router;

