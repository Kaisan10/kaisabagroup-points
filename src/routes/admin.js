'use strict';

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const ServerAccount = require('../models/ServerAccount');
const requireAdmin = require('../middleware/requireAdmin');
const { pool } = require('../config/database');

// ─── 全エンドポイントに管理者認証を適用 ──────────────────────────────────
router.use(requireAdmin);

// ─── 既存: ポイント手動追加 ──────────────────────────────────────────────
router.post('/points/add', async (req, res) => {
  try {
    const { username, user_id, amount, transaction_type = 'admin_award', description = '' } = req.body;

    const amountBig = BigInt(amount || 0);
    if (amountBig <= 0n || amountBig > 100000n) {
      return res.status(400).json({ success: false, error: 'Invalid amount (must be between 1 and 100000)' });
    }

    const safeDesc = String(description || '').slice(0, 500);
    if (!username && !user_id) {
      return res.status(400).json({ success: false, error: 'username or user_id required' });
    }

    let user = null;
    if (user_id) user = await User.findById(Number(user_id));
    else         user = await User.findByUsername(username);

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    await User.addPoints(user.id, amountBig, transaction_type, safeDesc);
    return res.json({ success: true, message: 'Points added', user_id: user.id, amount: amountBig.toString() });
  } catch (err) {
    console.error('❌ admin points error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── サービスアカウント作成 ──────────────────────────────────────────────
// POST /admin/server/create
// Body: { name, owner_username (or owner_user_id), webhook_url? }
router.post('/server/create', async (req, res) => {
  try {
    const { name, owner_username, owner_user_id, webhook_url } = req.body;

    // name バリデーション
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ success: false, error: 'name too long (max 100)' });
    }

    // オーナー解決
    let owner = null;
    if (owner_user_id) {
      owner = await User.findById(Number(owner_user_id));
    } else if (owner_username) {
      owner = await User.findByUsername(owner_username);
    } else {
      return res.status(400).json({ success: false, error: 'owner_username or owner_user_id required' });
    }

    if (!owner) return res.status(404).json({ success: false, error: 'Owner user not found' });

    // webhook_url のバリデーション（任意）
    if (webhook_url) {
      try { new URL(webhook_url); } catch {
        return res.status(400).json({ success: false, error: 'Invalid webhook_url' });
      }
    }

    const { account, plainApiKey } = await ServerAccount.create({
      name:        name.trim(),
      ownerUserId: owner.id,
      webhookUrl:  webhook_url || null,
    });

    console.log(`✅ サービスアカウント作成: id=${account.id} name=${account.name} owner=${owner.username}`);

    // 平文キーはここで一度だけ返す
    return res.status(201).json({
      success: true,
      message: 'Service account created. Save the api_key now — it will never be shown again.',
      data: {
        id:             account.id,
        name:           account.name,
        owner_username: owner.username,
        api_key:        plainApiKey, // ← 一度のみ
        api_key_prefix: account.api_key_prefix,
        created_at:     account.created_at,
      }
    });
  } catch (err) {
    console.error('❌ admin server/create error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── APIキー再発行 ───────────────────────────────────────────────────────
// POST /admin/server/:id/regenerate-key
router.post('/server/:id/regenerate-key', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }

    const account = await ServerAccount.findById(id);
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

    const { plainApiKey } = await ServerAccount.regenerateKey(id);
    console.log(`✅ APIキー再発行: server_account id=${id}`);

    return res.json({
      success: true,
      message: 'API key regenerated. Old key is now invalid. Save the new key — it will never be shown again.',
      data: {
        id,
        api_key: plainApiKey, // ← 一度のみ
      }
    });
  } catch (err) {
    console.error('❌ admin regenerate-key error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── サーバーアカウント一覧 ───────────────────────────────────────────────
// GET /admin/server/list
router.get('/server/list', async (req, res) => {
  try {
    const accounts = await ServerAccount.findAll();
    return res.json({ success: true, data: accounts });
  } catch (err) {
    console.error('❌ admin server/list error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── サーバーアカウント有効/無効 ──────────────────────────────────────────
// PATCH /admin/server/:id/active
router.patch('/server/:id/active', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ success: false, error: 'is_active (boolean) required' });
    }
    await ServerAccount.setActive(id, is_active);
    return res.json({ success: true, message: `Account ${is_active ? 'enabled' : 'disabled'}` });
  } catch (err) {
    console.error('❌ admin server/active error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── サーバーアカウント信頼モード設定 ────────────────────────────────────
// PATCH /admin/server/:id/trusted
router.patch('/server/:id/trusted', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    const { is_trusted, allowed_ips, tx_limit } = req.body;

    const updates = [];
    const values = [];
    let idx = 1;

    if (is_trusted !== undefined) {
      updates.push(`is_trusted = $${idx++}`);
      values.push(Boolean(is_trusted));
    }
    if (allowed_ips !== undefined) {
      updates.push(`allowed_ips = $${idx++}`);
      values.push(allowed_ips ? String(allowed_ips).trim() : null);
    }
    if (tx_limit !== undefined) {
      const limit = BigInt(tx_limit);
      if (limit < 0n) return res.status(400).json({ success: false, error: 'tx_limit must be >= 0' });
      updates.push(`tx_limit = $${idx++}`);
      values.push(limit.toString());
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE server_accounts SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id`,
      values
    );

    if (result.rowCount === 0) return res.status(404).json({ success: false, error: 'Account not found' });
    
    return res.json({ success: true, message: 'Server account trusted settings updated' });
  } catch (err) {
    console.error('❌ admin server trusted error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── 経済統計 ────────────────────────────────────────────────────────────
// GET /admin/economy/stats
router.get('/economy/stats', async (req, res) => {
  try {
    const [usersSum, serversSum, txCount, pendingCount] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(total_points), 0) AS total FROM users'),
      pool.query('SELECT COALESCE(SUM(balance), 0) AS total FROM server_accounts'),
      pool.query('SELECT COUNT(*) AS total FROM point_transactions'),
      pool.query(
        `SELECT COUNT(*) AS total FROM pending_transactions
         WHERE status IN ('pending_buyer','pending_seller')`
      ),
    ]);

    return res.json({
      success: true,
      data: {
        total_user_points:   Number(usersSum.rows[0].total),
        total_server_balance: Number(serversSum.rows[0].total),
        total_in_circulation: Number(usersSum.rows[0].total) + Number(serversSum.rows[0].total),
        total_transactions:  Number(txCount.rows[0].total),
        pending_transactions: Number(pendingCount.rows[0].total),
      }
    });
  } catch (err) {
    console.error('❌ admin economy/stats error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


// ─── 通報管理 ────────────────────────────────────────────────────────────

// GET /admin/reports/count — 未処理の通報数を返す（通知用）
router.get('/reports/count', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) AS count FROM reports WHERE is_dismissed = FALSE');
    return res.json({ success: true, count: parseInt(result.rows[0].count, 10) });
  } catch (err) {
    console.error('❌ admin reports count error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /admin/users/suspended — 停止中ユーザー一覧
router.get('/users/suspended', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, avatar_url, last_login FROM users WHERE is_suspended = TRUE ORDER BY last_login DESC'
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('❌ admin suspended users error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /admin/reports — 全通報一覧（重複をまとめて表示、最大30グループ）
router.get('/reports', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         MIN(r.id) as id,
         r.category, 
         r.description, 
         r.reporter_id, 
         u.username AS reporter_username,
         u.is_suspended,
         COUNT(*) as count,
         MAX(r.created_at) as created_at,
         r.is_dismissed
       FROM reports r
       JOIN users u ON u.id = r.reporter_id
       WHERE r.is_dismissed = FALSE
       GROUP BY r.category, r.description, r.reporter_id, u.username, u.is_suspended, r.is_dismissed
       ORDER BY created_at DESC
       LIMIT 30`
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('❌ admin reports error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PATCH /admin/reports/:id/dismiss — 同一内容の通報をすべて処理済みにする
router.patch('/reports/:id/dismiss', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }

    // まず対象の通報情報を取得
    const target = await pool.query(
      'SELECT reporter_id, category, description FROM reports WHERE id = $1',
      [id]
    );

    if (target.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    const { reporter_id, category, description } = target.rows[0];

    // 同一ユーザーからの同一内容（カテゴリ・説明）の未処理通報をすべて処理済みに
    await pool.query(
      `UPDATE reports SET is_dismissed = TRUE 
       WHERE reporter_id = $1 AND category = $2 AND description = $3 AND is_dismissed = FALSE`,
      [reporter_id, category, description]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ admin dismiss error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PATCH /admin/users/:id/unsuspend — アカウント停止を解除する
router.patch('/users/:id/unsuspend', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    const result = await pool.query(
      'UPDATE users SET is_suspended = FALSE WHERE id = $1 RETURNING id, username',
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // 停止解除時に通報制限のリセット（古い通報記録を削除）
    await pool.query('DELETE FROM reports WHERE reporter_id = $1', [id]);

    console.log(`✅ アカウント停止解除: user_id=${id} username=${result.rows[0].username}`);
    return res.json({ success: true, data: { id, username: result.rows[0].username } });
  } catch (err) {
    console.error('❌ admin unsuspend error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── テスト用: 購入フロー一括実行 ────────────────────────────────────────
// POST /admin/test/purchase-flow
// Minecraft なしで取引フロー全体を動作確認する（管理者トークン必須）
router.post('/test/purchase-flow', async (req, res) => {
  try {
    const { buyer_mc_id, seller_server_id, product_id } = req.body;

    if (!buyer_mc_id || !seller_server_id || !product_id) {
      return res.status(400).json({
        success: false,
        error: 'buyer_mc_id, seller_server_id, product_id are required',
      });
    }

    const serverIdNum  = parseInt(seller_server_id, 10);
    const productIdNum = parseInt(product_id, 10);

    if (!Number.isInteger(serverIdNum) || serverIdNum <= 0 ||
        !Number.isInteger(productIdNum) || productIdNum <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid seller_server_id or product_id' });
    }

    // 1. 購入者の取引前残高を取得
    const buyerBefore = await pool.query(
      'SELECT id, total_points FROM users WHERE minecraft_id = $1',
      [buyer_mc_id]
    );
    if (buyerBefore.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Buyer not found (minecraft_id not linked)' });
    }
    const buyerId           = buyerBefore.rows[0].id;
    const buyerPointsBefore = Number(buyerBefore.rows[0].total_points);

    const serverBefore = await pool.query(
      'SELECT balance FROM server_accounts WHERE id = $1',
      [serverIdNum]
    );
    if (serverBefore.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Server account not found' });
    }
    const serverBalanceBefore = Number(serverBefore.rows[0].balance);

    // 2. 取引開始（プラグイン相当）
    const PendingTransactionModel = require('../models/PendingTransaction');
    const tx = await PendingTransactionModel.initiate({
      serverId:  serverIdNum,
      buyerMcId: buyer_mc_id,
      productId: productIdNum,
    });

    // 3. tx_token から id を取得
    const txRecord = await pool.query(
      'SELECT id FROM pending_transactions WHERE tx_token = $1',
      [tx.txToken]
    );
    const txId = txRecord.rows[0].id;

    // 4. 買い手承認（Web 相当: ユーザーID 直接指定）
    await PendingTransactionModel.buyerApproveByUser({ txId, userId: buyerId });

    // 5. 売り手承認（ポイント移動が原子的に実行される）
    const result = await PendingTransactionModel.sellerApprove({ txId, sellerServerId: serverIdNum });

    // 6. 残高を再取得して検証
    const buyerAfter  = await pool.query('SELECT total_points FROM users WHERE id = $1', [buyerId]);
    const serverAfter = await pool.query('SELECT balance FROM server_accounts WHERE id = $1', [serverIdNum]);
    const buyerPointsAfter   = Number(buyerAfter.rows[0].total_points);
    const serverBalanceAfter = Number(serverAfter.rows[0].balance);
    const conservationCheck  =
      (buyerPointsBefore - buyerPointsAfter) === (serverBalanceAfter - serverBalanceBefore);

    console.log(`🧪 テスト購入フロー完了: tx_id=${txId} buyer=${buyer_mc_id} amount=${tx.amount} conservation=${conservationCheck}`);

    return res.json({
      success: true,
      data: {
        tx_id:              txId,
        status:             result.status,
        amount:             tx.amount,
        buyer_before:       buyerPointsBefore,
        buyer_after:        buyerPointsAfter,
        server_before:      serverBalanceBefore,
        server_after:       serverBalanceAfter,
        conservation_check: conservationCheck,
      },
    });
  } catch (err) {
    console.error('❌ admin test/purchase-flow error:', err);
    const status  = err.statusCode || 500;
    const message = err.message    || 'Internal server error';
    return res.status(status).json({
      success: false,
      error:   message,
      ...(err.data ? { data: err.data } : {}),
    });
  }
});

module.exports = router;