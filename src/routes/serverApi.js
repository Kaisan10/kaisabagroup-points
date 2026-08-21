'use strict';

const express = require('express');
const router = express.Router();
const serverAuth = require('../middleware/serverAuth');
const ServerAccount = require('../models/ServerAccount');
const PendingTransaction = require('../models/PendingTransaction');
const OAuthToken = require('../models/OAuthToken');
const { pool } = require('../config/database');

// ─── 全エンドポイントにサーバーAPIキー認証を適用 ─────────────────────────
router.use(serverAuth);

// ─── ヘルパー: エラーを安全にレスポンスに変換 ─────────────────────────────
function handleError(res, err) {
  const status  = err.statusCode || 500;
  const message = err.message    || 'Internal server error';
  if (status === 500) console.error('❌ serverApi error:', err);
  return res.status(status).json({
    success: false,
    error:   message,
    ...(err.data ? { data: err.data } : {}),
  });
}

// ─── GET /api/server/balance ──────────────────────────────────────────────
// 自サーバーの残高を返す
router.get('/balance', async (req, res) => {
  try {
    const account = await ServerAccount.findById(req.serverAccount.id);
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

    return res.json({
      success: true,
      data: {
        server_name: account.name,
        balance:     account.balance,
      }
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/server/player ──────────────────────────────────────────────
// プレイヤーをユーザー名で検索しポイント残高を返す（統合エンドポイント）
//
// Query:
//   ?mc_id=<minecraft_id>            マイクラIDで検索
//   ?discourse_username=<username>   Discourseユーザー名で検索
//
// いずれか1つを必ず指定する。
router.get('/player', async (req, res) => {
  const { mc_id, discourse_username } = req.query;

  if (!mc_id && !discourse_username) {
    return res.status(400).json({ success: false, error: 'mc_id or discourse_username query param required' });
  }
  if (mc_id && discourse_username) {
    return res.status(400).json({ success: false, error: 'Specify only one of mc_id or discourse_username' });
  }

  try {
    let result;
    if (mc_id) {
      const mcIdStr = String(mc_id).trim();
      if (!/^[a-zA-Z0-9_]{2,16}$/.test(mcIdStr)) {
        return res.status(400).json({ success: false, error: 'Invalid mc_id format' });
      }
      result = await pool.query(
        'SELECT username, total_points, minecraft_id FROM users WHERE minecraft_id = $1',
        [mcIdStr]
      );
    } else {
      result = await pool.query(
        'SELECT username, total_points, minecraft_id FROM users WHERE LOWER(username) = LOWER($1)',
        [String(discourse_username).trim()]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error:   'Player not found',
        message: 'プレイヤーが見つかりません',
      });
    }

    const user = result.rows[0];
    return res.json({
      success: true,
      data: {
        username:     user.username,
        minecraft_id: user.minecraft_id || null,
        points:       Number(user.total_points),
      }
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/server/player/:mc_id ────────────────────────────────────────────
// @deprecated GET /api/server/player?mc_id=<id> を使用してください
// TODO: 利用者への移行告知後に削除予定。履歴エンドポイントの利用状況を確認してから対応すること。
// プレイヤーのポイント残高を返す（minecraft_id で検索）
router.get('/player/:mc_id', async (req, res) => {
  console.warn('⚠️ Deprecated API: GET /api/server/player/:mc_id — GET /api/server/player?mc_id= を使用してください');
  try {
    const mcId = String(req.params.mc_id).trim();

    // minecraft_id 形式バリデーション（2～16文字の英数字とアンダースコア）
    if (!/^[a-zA-Z0-9_]{2,16}$/.test(mcId)) {
      return res.status(400).json({ success: false, error: 'Invalid minecraft_id format' });
    }

    const result = await pool.query(
      'SELECT username, total_points, minecraft_id FROM users WHERE minecraft_id = $1',
      [mcId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error:   'Player not found or not linked',
        message: 'このプレイヤーはポイントシステムに未登録またはアカウント連携されていません',
      });
    }

    const user = result.rows[0];
    return res.json({
      success: true,
      data: {
        username:     user.username,
        minecraft_id: user.minecraft_id,
        points:       Number(user.total_points),
      }
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/server/player/discourse/:username ──────────────────────────
// @deprecated GET /api/server/player?discourse_username=<username> を使用してください
// Discourseユーザー名でプレイヤーのポイント残高を返す
router.get('/player/discourse/:username', async (req, res) => {
  try {
    const username = String(req.params.username).trim();

    // 念のため空文字チェック
    if (!username) {
      return res.status(400).json({ success: false, error: 'username is required' });
    }

    const result = await pool.query(
      'SELECT username, total_points, minecraft_id FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error:   'User not found',
        message: 'このユーザーはポイントシステムに登録されていません',
      });
    }

    const user = result.rows[0];
    return res.json({
      success: true,
      data: {
        username:     user.username,
        minecraft_id: user.minecraft_id || null,
        points:       Number(user.total_points),
      }
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/server/products ────────────────────────────────────────────
// このサーバーに登録されている有効な商品一覧を返す
router.get('/products', async (req, res) => {
  try {
    const products = await ServerAccount.listProducts(req.serverAccount.id);
    return res.json({ success: true, data: products });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/server/tx/initiate ─────────────────────────────────────────
// 取引を開始する（buy コマンドや外部アプリから呼ばれる）
//
// Body: { product_id: number, mc_id?: string, buyer_token?: string, ... }
//
// ゼロトラスト:
//   - amount はクライアントから受け取らない（商品マスタから取得）
//   - mc_id / buyer_token で購入者を特定
router.post('/tx/initiate', async (req, res) => {
  try {
    const { mc_id, product_id, buyer_token, buyer_discourse_username, recipient_user_id, recipient_mc_id, return_url } = req.body;

    // 入力バリデーション: buyer の指定は mc_id / buyer_token / buyer_discourse_username のいずれか1つ
    const buyerParams = [mc_id, buyer_token, buyer_discourse_username].filter(Boolean);
    if (buyerParams.length === 0) {
      return res.status(400).json({ success: false, error: 'mc_id, buyer_token, or buyer_discourse_username is required' });
    }
    if (buyerParams.length > 1) {
      return res.status(400).json({ success: false, error: 'Specify only one of mc_id, buyer_token, or buyer_discourse_username' });
    }

    if (mc_id) {
      if (typeof mc_id !== 'string' || !mc_id.match(/^[a-zA-Z0-9_.]{2,16}$/)) {
        return res.status(400).json({ success: false, error: 'Invalid mc_id format' });
      }
    }

    const productIdNum = Number(product_id);
    if (!Number.isInteger(productIdNum) || productIdNum <= 0) {
      return res.status(400).json({ success: false, error: 'product_id (positive integer) required' });
    }

    // buyer の特定（buyer_token または buyer_discourse_username → userId に解決）
    let finalBuyerUserId = null;
    if (buyer_token) {
      const tokenData = await OAuthToken.verifyAccessToken(
        buyer_token,
        req.serverAccount.id,
        'transaction'
      );
      finalBuyerUserId = tokenData.userId;
    } else if (buyer_discourse_username) {
      const userResult = await pool.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
        [String(buyer_discourse_username).trim()]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Buyer (discourse username) not found' });
      }
      finalBuyerUserId = userResult.rows[0].id;
    }

    // 受取人の解決
    let finalRecipientId = null;
    if (recipient_user_id) {
      finalRecipientId = Number(recipient_user_id);
    } else if (recipient_mc_id) {
      const recResult = await pool.query('SELECT id FROM users WHERE minecraft_id = $1', [recipient_mc_id]);
      if (recResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Recipient player (mc_id) not found' });
      }
      finalRecipientId = recResult.rows[0].id;
    }

    const tx = await PendingTransaction.initiate({
      serverId:        req.serverAccount.id,
      recipientUserId: finalRecipientId,
      buyerMcId:       mc_id,             // mc_id の場合はこちら
      buyerUserId:     finalBuyerUserId,  // buyer_token の場合はこちら
      productId:       productIdNum,
      isTrusted:       req.serverAccount.is_trusted,
      txLimit:         req.serverAccount.tx_limit
    });

    const siteUrl = process.env.SITE_URL || '';
    console.log(`📤 取引開始: token=${tx.txToken} buyer=${mc_id || 'ID:'+finalBuyerUserId} item=${tx.itemName} amount=${tx.amount}`);

    // return_url が指定されていれば検証してダッシュボードURLに付加する
    let dashboardUrl = `${siteUrl}/dashboard`;
    if (return_url && typeof return_url === 'string') {
      try {
        const parsed = new URL(return_url);
        // http/https のみ許可
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          const params = new URLSearchParams({
            return_url:   return_url,
            service_name: req.serverAccount.name,
          });
          dashboardUrl = `${siteUrl}/dashboard?${params.toString()}`;
        }
      } catch { /* 不正なURLは無視 */ }
    }

    return res.status(201).json({
      success: true,
      data: {
        tx_token:   tx.txToken,
        amount:     tx.amount,
        item_name:  tx.itemName,
        expires_at: tx.expiresAt,
        // プレイヤーにWebのURLを案内する（確認コードは廃止）
        web_url:    dashboardUrl,
        message:    `購入金額: ${tx.amount}pt / ${dashboardUrl} から承認してください`,
      }
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/server/tx/cancel ───────────────────────────────────────────
// 取引をキャンセルする（プラグイン側からの中断）
//
// Body: { tx_token: string }
router.post('/tx/cancel', async (req, res) => {
  try {
    const { tx_token } = req.body;

    if (!tx_token || typeof tx_token !== 'string') {
      return res.status(400).json({ success: false, error: 'tx_token required' });
    }

    // tx_token から id を取得してから reject
    const tx = await PendingTransaction.findByToken(
      tx_token.trim().toUpperCase(),
      req.serverAccount.id
    );
    if (!tx) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    await PendingTransaction.reject({
      txId:     tx.id,
      serverId: req.serverAccount.id,
      by:       'seller', // プラグイン経由のキャンセルは seller 側とみなす
    });

    return res.json({ success: true, data: { status: 'rejected' } });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/server/tx/:tx_token ─────────────────────────────────────────
// 取引の現在の状態を返す（ポーリング用）
router.get('/tx/:tx_token', async (req, res) => {
  try {
    const txToken = String(req.params.tx_token).trim().toUpperCase();

    const tx = await PendingTransaction.findByToken(txToken, req.serverAccount.id);
    if (!tx) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    return res.json({
      success: true,
      data: {
        id:          tx.id,
        tx_token:    tx.tx_token,
        amount:      tx.amount,
        item_name:   tx.item_name,
        status:      tx.status,
        expires_at:  tx.expires_at,
        created_at:  tx.created_at,
      }
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── 内部: webhook 通知（fire-and-forget）────────────────────────────────
async function notifyWebhook(url, payload) {
  const body = JSON.stringify(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);

  try {
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal:  ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── POST /api/server/tx/:tx_token/approve ──────────────────────────────
// プラグイン側での承認（アイテム配布完了後のポイント確定）
router.post('/tx/:tx_token/approve', async (req, res) => {
  try {
    const txToken = String(req.params.tx_token).trim().toUpperCase();
    const serverId = req.serverAccount.id;

    const result = await PendingTransaction.sellerApproveByToken({
      txToken,
      serverId
    });

    return res.json({
      success: true,
      message: 'Transaction completed',
      data: result
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/server/status ───────────────────────────────────────────────
// APIキーのステータス（信頼モードかどうか等）を確認する
router.get('/status', (req, res) => {
  return res.json({
    success: true,
    data: {
      is_trusted: req.serverAccount.is_trusted
    }
  });
});

module.exports = router;
