'use strict';

const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const ServerAccount = require('../models/ServerAccount');
const PendingTransaction = require('../models/PendingTransaction');
const { pool } = require('../config/database');
const User = require('../models/User');

// ─── 全エンドポイントにセッション認証を適用 ──────────────────────────────
router.use(requireAuth);

// ─── ヘルパー: エラーを安全にレスポンスに変換 ─────────────────────────────
function handleError(res, err) {
  const status  = err.statusCode || 500;
  // 500エラーの場合はDBエラーなどの生メッセージを隠蔽する
  const message = status === 500 ? '内部サーバーエラーが発生しました。' : (err.message || 'Internal server error');
  if (status === 500) console.error('❌ operator API error:', err);
  return res.status(status).json({
    success: false,
    error: message,
    ...(err.data ? { data: err.data } : {}),
  });
}

/**
 * 自分が owner のサービスアカウントを取得し、
 * アクセス権を確認するヘルパー。
 * serverId が指定された場合は一致するものだけを返す。
 */
async function resolveOwnedAccount(userId, serverId) {
  const accounts = await ServerAccount.findByOwner(userId);
  if (!serverId) return accounts;

  const id = parseInt(serverId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('Invalid server_id'), { statusCode: 400 });
  }
  const account = accounts.find(a => a.id === id);
  if (!account) {
    throw Object.assign(
      new Error('Server account not found or you are not the owner'),
      { statusCode: 403 }
    );
  }
  return account;
}

// ─── GET /api/operator/me ─────────────────────────────────────────────────
// 自分が所有するサービスアカウント一覧を返す
router.get('/me', async (req, res) => {
  try {
    const accounts = await ServerAccount.findByOwner(req.session.user.id);
    return res.json({ success: true, data: accounts });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/operator/tx/pending ─────────────────────────────────────────
// 自分のサービスアカウントの承認待ち取引一覧
// Query: ?server_id=<number>  （複数サーバーを持つ場合に絞り込み）
router.get('/tx/pending', async (req, res) => {
  try {
    const accounts = await resolveOwnedAccount(
      req.session.user.id,
      req.query.server_id || null
    );

    // 単一アカウントか全アカウントかで分岐
    const targets = Array.isArray(accounts) ? accounts : [accounts];

    const results = await Promise.all(
      targets.map(a => PendingTransaction.listPendingForServer(a.id)
        .then(txs => txs.map(tx => ({ ...tx, server_name: a.name })))
      )
    );

    // 全サーバーの結果をフラットにして created_at 昇順でソート
    const flat = results.flat().sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );

    return res.json({ success: true, data: flat });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/operator/tx/:id/approve ───────────────────────────────────
// 運営者が取引を承認する（Web UI から）
router.post('/tx/:id/approve', async (req, res) => {
  try {
    const txId = parseInt(req.params.id, 10);
    if (!Number.isInteger(txId) || txId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid transaction id' });
    }

    // どのサービスアカウントに属する取引かは DB 側で確認するが、
    // まず自分が owner かどうかをここで確認する
    const accounts = await ServerAccount.findByOwner(req.session.user.id);
    if (accounts.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'You do not own any service accounts',
      });
    }

    // 自分のアカウントIDのいずれかに属する取引かを sellerApprove 内で確認
    // （server_id が一致しない場合は 404 が返る）
    // 複数アカウントの場合は順番に試みる
    let result = null;
    let lastErr = null;
    for (const account of accounts) {
      try {
        result = await PendingTransaction.sellerApprove({
          txId,
          sellerServerId: account.id,
        });
        break;
      } catch (e) {
        lastErr = e;
        // 404 は「このサーバーの取引ではない」なので次を試す
        if (e.statusCode !== 404) throw e;
      }
    }

    if (!result) throw lastErr;

    console.log(`✅ 運営者承認: tx_id=${txId} user=${req.session.user.username}`);
    return res.json({
      success: true,
      data: {
        status:   result.status,
        amount:   result.amount,
        item_name: result.itemName,
        message:  '取引が完了しました',
      }
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/operator/tx/:id/reject ────────────────────────────────────
// 運営者が取引を拒否する（Web UI から）
router.post('/tx/:id/reject', async (req, res) => {
  try {
    const txId = parseInt(req.params.id, 10);
    if (!Number.isInteger(txId) || txId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid transaction id' });
    }

    const accounts = await ServerAccount.findByOwner(req.session.user.id);
    if (accounts.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'You do not own any service accounts',
      });
    }

    let result = null;
    let lastErr = null;
    for (const account of accounts) {
      try {
        result = await PendingTransaction.reject({
          txId,
          serverId: account.id,
          by:       'seller',
        });
        break;
      } catch (e) {
        lastErr = e;
        if (e.statusCode !== 404) throw e;
      }
    }

    if (!result) throw lastErr;

    console.log(`🚫 運営者拒否: tx_id=${txId} user=${req.session.user.username}`);
    return res.json({ success: true, data: { status: result.status } });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/operator/products ───────────────────────────────────────────
// 自分のサービスアカウントの商品一覧
// Query: ?server_id=<number>
router.get('/products', async (req, res) => {
  try {
    const account = await resolveOwnedAccount(
      req.session.user.id,
      req.query.server_id
    );
    if (!account || Array.isArray(account)) {
      return res.status(400).json({ success: false, error: 'server_id required' });
    }

    const products = await ServerAccount.listProducts(account.id, true);
    return res.json({ success: true, data: products });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/operator/products ──────────────────────────────────────────
// 商品を追加する
// Body: { server_id, name, price, description? }
router.post('/products', async (req, res) => {
  try {
    const { server_id, name, price, description } = req.body;

    const account = await resolveOwnedAccount(req.session.user.id, server_id);
    if (Array.isArray(account)) {
      return res.status(400).json({ success: false, error: 'server_id required' });
    }

    // バリデーション
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'name required' });
    }
    if (name.trim().length > 200) {
      return res.status(400).json({ success: false, error: 'name too long (max 200)' });
    }

    const priceNum = Number(price);
    if (!Number.isInteger(priceNum) || priceNum <= 0) {
      return res.status(400).json({ success: false, error: 'price must be a positive integer' });
    }
    if (priceNum > 1_000_000) {
      return res.status(400).json({ success: false, error: 'price too large (max 1,000,000)' });
    }

    const product = await ServerAccount.addProduct({
      serverId:    account.id,
      name:        name.trim(),
      price:       priceNum,
      description: description ? String(description).trim().slice(0, 500) : null,
    });

    return res.status(201).json({ success: true, data: product });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── PATCH /api/operator/products/:id ────────────────────────────────────
// 商品を更新する
// Body: { server_id, name?, price?, description?, is_active? }
router.patch('/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid product id' });
    }

    const { server_id, ...fields } = req.body;

    const account = await resolveOwnedAccount(req.session.user.id, server_id);
    if (Array.isArray(account)) {
      return res.status(400).json({ success: false, error: 'server_id required' });
    }

    // price の追加バリデーション
    if ('price' in fields) {
      const p = Number(fields.price);
      if (!Number.isInteger(p) || p <= 0 || p > 1_000_000) {
        return res.status(400).json({ success: false, error: 'price must be a positive integer (max 1,000,000)' });
      }
    }

    // name の長さ制限
    if ('name' in fields && String(fields.name).trim().length > 200) {
      return res.status(400).json({ success: false, error: 'name too long (max 200)' });
    }

    const product = await ServerAccount.updateProduct(productId, account.id, fields);
    return res.json({ success: true, data: product });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── DELETE /api/operator/products/:id ───────────────────────────────────
// 商品を無効化する（物理削除はしない）
// Body: { server_id }
router.delete('/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid product id' });
    }

    const { server_id } = req.body;
    const account = await resolveOwnedAccount(req.session.user.id, server_id);
    if (Array.isArray(account)) {
      return res.status(400).json({ success: false, error: 'server_id required' });
    }

    // is_active = false にする（物理削除しない。取引履歴との整合性保持のため）
    await ServerAccount.updateProduct(productId, account.id, { is_active: false });
    return res.json({ success: true, message: 'Product deactivated' });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/operator/service-accounts ──────────────────────────────────
// WebUIからサービスアカウントを作成する
// 2個目以降は50ptの手数料が必要（振込先: SERVICE_ACCOUNT_FEE_RECIPIENT のサービスアカウント）
// Body: { name }
const SERVICE_ACCOUNT_FEE = 50n;

router.post('/service-accounts', async (req, res) => {
  try {
    const { name } = req.body;
    const userId = req.session.user.id;

    // name バリデーション（先にチェック）
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (name.length < 5 || !/^[\x21-\x7E]+$/.test(name)) {
      return res.status(400).json({ success: false, error: 'サービスアカウント名は5文字以上の半角英数字と記号のみ使用可能です（スペース不可）' });
    }

    // 既存アカウント数を確認
    const existing = await ServerAccount.findByOwner(userId);
    const needsFee = existing.length >= 1;

    if (!needsFee) {
      // 1個目: 無料で作成（ServerAccount.create() 内でもバリデーション・重複チェックあり）
      const { account, plainApiKey } = await ServerAccount.create({ name, ownerUserId: userId });
      return res.status(201).json({ success: true, data: { account, api_key: plainApiKey } });
    }

    // 2個目以降: 振込先サービスアカウントを確認してから 50pt 手数料を徴収して作成
    const feeRecipientName = process.env.SERVICE_ACCOUNT_FEE_RECIPIENT;
    if (!feeRecipientName) {
      return res.status(503).json({ success: false, error: 'サービスアカウントの作成が一時的に利用できません（設定不備）' });
    }

    // 振込先サービスアカウントをDBから取得
    const recipientRes = await pool.query(
      'SELECT id FROM server_accounts WHERE name = $1 AND is_active = TRUE LIMIT 1',
      [feeRecipientName]
    );
    if (recipientRes.rows.length === 0) {
      return res.status(503).json({ success: false, error: 'サービスアカウントの作成が一時的に利用できません（設定不備）' });
    }
    const recipientAccountId = recipientRes.rows[0].id;

    // 残高チェック・手数料振込・アカウント作成を1トランザクションでアトミックに実行
    const { generateApiKey, hashApiKey, keyPrefix } = require('../utils/apiKey');
    const plainKey = generateApiKey();
    const keyHash  = hashApiKey(plainKey);
    const prefix   = keyPrefix(plainKey);

    const client = await pool.connect();
    let newAccount;
    try {
      await client.query('BEGIN');

      // ユーザー残高をFOR UPDATEで取得
      const userRes = await client.query(
        'SELECT total_points FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (userRes.rows.length === 0) throw Object.assign(new Error('User not found'), { statusCode: 404 });

      const currentPoints = BigInt(userRes.rows[0].total_points);
      if (currentPoints < SERVICE_ACCOUNT_FEE) {
        throw Object.assign(
          new Error(`ポイントが不足しています（必要: ${SERVICE_ACCOUNT_FEE}pt、残高: ${currentPoints}pt）`),
          { statusCode: 402 }
        );
      }

      // ユーザーからポイントを引く
      await client.query(
        'UPDATE users SET total_points = total_points - $1 WHERE id = $2',
        [SERVICE_ACCOUNT_FEE.toString(), userId]
      );
      await client.query(
        `INSERT INTO point_transactions (user_id, amount, transaction_type, description)
         VALUES ($1, $2, 'service_account_fee', 'サービスアカウント作成手数料')`,
        [userId, (-SERVICE_ACCOUNT_FEE).toString()]
      );

      // 振込先サービスアカウントに加算
      await client.query(
        'UPDATE server_accounts SET balance = balance + $1 WHERE id = $2',
        [SERVICE_ACCOUNT_FEE.toString(), recipientAccountId]
      );

      // サービスアカウントを作成（ServerAccount.create() の >=1 制限を迂回してここで直接INSERT）
      const insertRes = await client.query(
        `INSERT INTO server_accounts
           (name, api_key_hash, api_key_prefix, owner_user_id, webhook_url, redirect_uris)
         VALUES ($1, $2, $3, $4, NULL, NULL)
         RETURNING id, name, api_key_prefix, owner_user_id, balance,
                   webhook_url, redirect_uris, seller_approval, created_at, is_active`,
        [name.trim(), keyHash, prefix, userId]
      );
      newAccount = insertRes.rows[0];

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      if (err.statusCode === 402 || err.statusCode === 404) {
        return res.status(err.statusCode).json({ success: false, error: err.message });
      }
      throw err;
    }
    client.release();

    console.log(`✅ サービスアカウント作成（有料）: user=${req.session.user.username} fee=${SERVICE_ACCOUNT_FEE}pt → ${feeRecipientName}`);
    return res.status(201).json({
      success: true,
      data: { account: newAccount, api_key: plainKey },
      fee_paid: Number(SERVICE_ACCOUNT_FEE),
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── PATCH /api/operator/service-accounts/:id ─────────────────────────────
// サービスアカウントを更新する（コールバックURLなど）
// Body: { redirect_uris? }
router.patch('/service-accounts/:id', async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid account id' });
    }

    const { redirect_uris } = req.body;

    // 自分のアカウントか確認
    const account = await resolveOwnedAccount(req.session.user.id, accountId);
    if (Array.isArray(account)) {
      return res.status(400).json({ success: false, error: 'server_id required' });
    }

    // 更新処理
    const { pool } = require('../config/database');
    const result = await pool.query(
      `UPDATE server_accounts SET redirect_uris = $1 WHERE id = $2 RETURNING redirect_uris`,
      [redirect_uris !== undefined ? redirect_uris : account.redirect_uris, accountId]
    );

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── DELETE /api/operator/service-accounts/:id ──────────────────────────────
// サービスアカウントを削除する（物理または論理削除）
router.delete('/service-accounts/:id', async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid account id' });
    }
    const success = await ServerAccount.deleteAccount(accountId, req.session.user.id);
    return res.json({ success: true, message: success ? '物理削除しました' : '論理削除しました' });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/operator/service-accounts/:id/withdraw ────────────────────
// サービスアカウントの残高をオーナー個人のポイントに引き出す
// Body: { amount }
router.post('/service-accounts/:id/withdraw', async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid account id' });
    }

    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: '引き出し額は正の整数である必要があります' });
    }

    await ServerAccount.withdrawToOwner(accountId, req.session.user.id, amount);
    
    console.log(`✅ サービスアカウントから出金: account_id=${accountId} user=${req.session.user.username} amount=${amount}`);
    return res.json({ success: true, message: `${amount}pt を個人の残高に引き出しました` });
  } catch (err) {
    return handleError(res, err);
  }
});

module.exports = router;
