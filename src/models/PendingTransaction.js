'use strict';

/**
 * PendingTransaction.js — 経済システム取引モデル
 *
 * 変更点（確認コード廃止）:
 *   - buyer_confirm_code の生成・検証を廃止
 *   - 買い手承認は Web UI のセッション認証に一本化
 *   - buyerApprove() を削除し buyerApproveByUser() に置換
 *   - rejectByBuyer(), listPendingForBuyer() を追加
 */

const crypto = require('crypto');
const { pool } = require('../config/database');
const User = require('./User');

const TX_TOKEN_BYTES = 16; // 32文字の16進数
const TX_TTL_MS = 5 * 60 * 1000; // 5分

function generateTxToken() {
  return crypto.randomBytes(TX_TOKEN_BYTES).toString('hex').toUpperCase();
}

class PendingTransaction {
  /**
   * 取引を開始する（status: pending_buyer）。
   *
   * ゼロトラスト:
   *   - amount はサーバー側の商品マスタから取得（クライアントから受け取らない）
   *   - buyer の存在は minecraft_id から DB で確認
   *   - confirm_code は廃止（Web UI のセッション認証に変更）
   *
   * @param {object} opts
   * @param {number}  opts.serverId         server_accounts.id (facilitator)
   * @param {number}  [opts.recipientUserId] 受取人の user.id (任意、指定があればこちらへ加算)
   * @param {string}  [opts.buyerMcId]     購入者の minecraft_id
   * @param {number}  [opts.buyerUserId]   購入者の user.id（OAuth連携などの場合）
   * @param {number}  opts.productId     server_products.id
   * @returns {object} { txToken, amount, itemName, expiresAt }
   */
  static async initiate({ serverId, recipientUserId, buyerMcId, buyerUserId, productId, isTrusted, txLimit }) {
    // 1. 商品を検証（サーバー所有かつ有効なもの）
    const productResult = await pool.query(
      `SELECT id, name, price FROM server_products
       WHERE server_product_id = $1 AND server_id = $2 AND is_active = TRUE`,
      [productId, serverId]
    );
    if (productResult.rows.length === 0) {
      throw Object.assign(new Error('Product not found or inactive'), { statusCode: 404 });
    }
    const product = productResult.rows[0];

    // 2. 購入者を特定（mc_id または user_id）
    let buyerResult;
    if (buyerUserId) {
      buyerResult = await pool.query(
        `SELECT id, total_points FROM users WHERE id = $1`,
        [buyerUserId]
      );
    } else if (buyerMcId) {
      buyerResult = await pool.query(
        `SELECT id, total_points FROM users WHERE minecraft_id = $1`,
        [buyerMcId]
      );
    } else {
      throw Object.assign(new Error('buyerMcId or buyerUserId is required'), { statusCode: 400 });
    }

    if (buyerResult.rows.length === 0) {
      throw Object.assign(
        new Error(buyerMcId ? 'Buyer not found. Player must link their account first.' : 'Buyer not found.'),
        { statusCode: 404 }
      );
    }
    const buyer = buyerResult.rows[0];

    // 3. 残高事前チェック（確定ではないが早期エラー）
    const buyerPoints = BigInt(buyer.total_points);
    const productPrice = BigInt(product.price);

    if (buyerPoints < productPrice) {
      throw Object.assign(
        new Error('Insufficient points'),
        { statusCode: 402, data: { current: buyerPoints.toString(), required: productPrice.toString() } }
      );
    }

    // 信頼モードの上限額チェック
    if (isTrusted && txLimit && BigInt(txLimit) > 0n && productPrice > BigInt(txLimit)) {
      throw Object.assign(
        new Error('Transaction amount exceeds trusted mode limit'),
        { statusCode: 403 }
      );
    }

    // 4. 同一プレイヤーの未処理取引が多すぎないかチェック（スパム防止）
    const pendingCount = await pool.query(
      `SELECT COUNT(*) FROM pending_transactions
       WHERE buyer_user_id = $1
         AND status IN ('pending_buyer','pending_seller')
         AND expires_at > NOW()`,
      [buyer.id]
    );
    if (Number(pendingCount.rows[0].count) >= 5) {
      throw Object.assign(
        new Error('Too many pending transactions. Please complete or cancel existing ones.'),
        { statusCode: 429 }
      );
    }

    // 信頼モードの事前許可チェック（ユーザーがこのサーバーに対して自動承認を許可しているか確認）
    let isAutoApproved = false;
    if (isTrusted) {
      const optInCheck = await pool.query(
        'SELECT auto_approve FROM user_trusted_servers WHERE user_id = $1 AND server_id = $2',
        [buyer.id, serverId]
      );
      if (optInCheck.rows.length > 0 && optInCheck.rows[0].auto_approve === true) {
        isAutoApproved = true;
      }
    }

    // 5. 取引レコードを作成
    const txToken   = generateTxToken();
    const expiresAt = new Date(Date.now() + TX_TTL_MS);
    const initialStatus = isAutoApproved ? 'pending_seller' : 'pending_buyer';
    const buyerApprovedAt = isAutoApproved ? new Date() : null;

    const insertResult = await pool.query(
      `INSERT INTO pending_transactions
         (tx_token, server_id, recipient_user_id, buyer_user_id, product_id, amount, item_name, expires_at, status, buyer_approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, tx_token, amount, item_name, status, expires_at`,
      [txToken, serverId, recipientUserId || null, buyer.id, product.id, productPrice.toString(), product.name, expiresAt, initialStatus, buyerApprovedAt]
    );

    const tx = insertResult.rows[0];
    return {
      txToken:   tx.tx_token,
      amount:    tx.amount,
      itemName:  tx.item_name,
      expiresAt: tx.expires_at,
    };
  }

  /**
   * 買い手がWebから承認する（pending_buyer → pending_seller）。
   * セッション認証済みのユーザーIDで買い手確認する（confirm_code 不要）。
   *
   * セキュリティ:
   *   - buyer_user_id = userId の確認でなりすまし防止
   *   - FOR UPDATE ロックで同時承認を防止
   *   - pending_buyer 状態のみ承認可能（状態機械の保護）
   *   - expires_at チェックで期限切れ取引の承認を防止
   *   - 404 で返すことでトランザクションの存在を漏洩しない
   *
   * @param {object} opts
   * @param {number}  opts.txId    pending_transactions.id
   * @param {number}  opts.userId  セッションの user.id（買い手確認用）
   */
  static async buyerApproveByUser({ txId, userId }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 行ロックして取得（同時リクエスト対策）
      // buyer_user_id = userId の条件でなりすまし防止
      const result = await client.query(
        `SELECT id, status, expires_at, buyer_user_id
         FROM pending_transactions
         WHERE id = $1 AND buyer_user_id = $2
         FOR UPDATE`,
        [txId, userId]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        // buyer_user_id ≠ userId の場合も 404 で返す（情報漏洩防止）
        throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });
      }

      const tx = result.rows[0];
      PendingTransaction._assertActive(tx);

      if (tx.status !== 'pending_buyer') {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`Cannot approve: status is ${tx.status}`),
          { statusCode: 409 }
        );
      }

      await client.query(
        `UPDATE pending_transactions
         SET status = 'pending_seller', buyer_approved_at = NOW()
         WHERE id = $1`,
        [tx.id]
      );

      await client.query('COMMIT');
      return { status: 'pending_seller', txId: tx.id };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 買い手がWebから拒否する。
   *
   * セキュリティ:
   *   - buyer_user_id = userId の確認でなりすまし防止
   *   - pending_buyer 状態のみ拒否可能
   *
   * @param {object} opts
   * @param {number}  opts.txId    pending_transactions.id
   * @param {number}  opts.userId  セッションの user.id
   */
  static async rejectByBuyer({ txId, userId }) {
    const result = await pool.query(
      `UPDATE pending_transactions
       SET status = 'rejected', rejected_by = 'buyer'
       WHERE id = $1 AND buyer_user_id = $2
         AND status = 'pending_buyer'
       RETURNING id, status`,
      [txId, userId]
    );
    if (result.rowCount === 0) {
      throw Object.assign(
        new Error('Transaction not found or cannot be rejected'),
        { statusCode: 404 }
      );
    }
    return result.rows[0];
  }

  /**
   * 自分宛の pending_buyer 取引一覧（ダッシュボードのポーリング用）。
   *
   * @param {number} userId  buyer_user_id
   */
  static async listPendingForBuyer(userId) {
    const result = await pool.query(
      `SELECT pt.id, pt.tx_token, pt.amount, pt.item_name, pt.status,
              pt.expires_at, pt.created_at,
              sa.name AS server_name,
              u_rec.username AS recipient_username
       FROM pending_transactions pt
       LEFT JOIN server_accounts sa ON sa.id = pt.server_id
       LEFT JOIN users u_rec ON u_rec.id = pt.recipient_user_id
       WHERE pt.buyer_user_id = $1
         AND pt.status = 'pending_buyer'
         AND pt.expires_at > NOW()
       ORDER BY pt.created_at ASC`,
      [userId]
    );
    return result.rows;
  }

  /**
   * 売り手（運営者）の承認を記録し、取引を実行する。
   * ユーザー残高 ↔ サーバー残高 の移動を DB トランザクション内で原子的に実行。
   *
   * @param {object} opts
   * @param {number}  opts.txId           pending_transactions.id
   * @param {number}  opts.sellerServerId 承認する運営者のサーバーID（なりすまし防止）
   */
  static async sellerApprove({ txId, sellerServerId }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT pt.id, pt.status, pt.expires_at, pt.buyer_user_id,
                pt.amount, pt.server_id, pt.recipient_user_id, pt.item_name,
                u.total_points AS buyer_points
         FROM pending_transactions pt
         JOIN users u ON u.id = pt.buyer_user_id
         WHERE pt.id = $1 AND pt.server_id = $2
         FOR UPDATE`,
        [txId, sellerServerId]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });
      }

      const tx = result.rows[0];
      PendingTransaction._assertActive(tx);

      if (tx.status !== 'pending_seller') {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`Cannot approve: status is ${tx.status}`),
          { statusCode: 409 }
        );
      }

      const buyerPoints = BigInt(tx.buyer_points);
      const txAmount = BigInt(tx.amount);

      // 残高を再確認（initiate から時間が経過している可能性）
      if (buyerPoints < txAmount) {
        await client.query(
          `UPDATE pending_transactions
           SET status = 'rejected', rejected_by = 'seller'
           WHERE id = $1`,
          [tx.id]
        );
        await client.query('COMMIT');
        throw Object.assign(
          new Error('Buyer has insufficient points'),
          { statusCode: 402, data: { current: buyerPoints.toString(), required: txAmount.toString() } }
        );
      }

      // ─── 原子的な残高移動 ────────────────────────────────
      // ① 買い手から引く
      await client.query(
        'UPDATE users SET total_points = total_points - $1 WHERE id = $2',
        [txAmount.toString(), tx.buyer_user_id]
      );

      // ② 加算先（ユーザー or サーバー）
      if (tx.recipient_user_id) {
        await client.query(
          'UPDATE users SET total_points = total_points + $1 WHERE id = $2',
          [txAmount.toString(), tx.recipient_user_id]
        );
      } else {
        await client.query(
          'UPDATE server_accounts SET balance = balance + $1 WHERE id = $2',
          [txAmount.toString(), tx.server_id]
        );
      }

      // ③ point_transactions に記録
      // 買い手側（支出）
      await client.query(
        `INSERT INTO point_transactions
           (user_id, amount, transaction_type, description,
            sender_type, sender_id, receiver_type, receiver_id, pending_tx_id)
         VALUES ($1, $2, 'server_purchase', $3, 'user', $1, $4, $5, $6)`,
        [
          tx.buyer_user_id,
          -tx.amount,
          `購入: ${tx.item_name}`,
          tx.recipient_user_id ? 'user' : 'server',
          tx.recipient_user_id || tx.server_id,
          tx.id
        ]
      );

      // 受け取り側がユーザーならその履歴も残す
      if (tx.recipient_user_id) {
        await client.query(
          `INSERT INTO point_transactions
             (user_id, amount, transaction_type, description,
              sender_type, sender_id, receiver_type, receiver_id, pending_tx_id)
           VALUES ($1, $2, 'receive_points', $3, 'user', $4, 'user', $1, $5)`,
          [
            tx.recipient_user_id,
            tx.amount,
            `販売受取: ${tx.item_name}`,
            tx.buyer_user_id,
            tx.id
          ]
        );
      }

      // ④ pending_transactions を completed に更新
      await client.query(
        `UPDATE pending_transactions
         SET status = 'completed', seller_approved_at = NOW()
         WHERE id = $1`,
        [tx.id]
      );

      await client.query('COMMIT');
      console.log(`✅ 取引完了: tx_id=${tx.id} amount=${txAmount} item=${tx.item_name}`);
      return { status: 'completed', amount: txAmount.toString(), itemName: tx.item_name };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * トークンを使用して売り手承認を実行する（プラグイン用）。
   */
  static async sellerApproveByToken({ txToken, serverId }) {
    // トークンから ID を解決
    const result = await pool.query(
      'SELECT id FROM pending_transactions WHERE tx_token = $1 AND server_id = $2',
      [txToken, serverId]
    );

    if (result.rows.length === 0) {
      throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });
    }

    return await this.sellerApprove({ txId: result.rows[0].id, sellerServerId: serverId });
  }

  /**
   * 取引を拒否する（売り手・キャンセル用）。
   *
   * @param {object} opts
   * @param {number}  opts.txId
   * @param {number}  opts.serverId
   * @param {'buyer'|'seller'} opts.by
   */
  static async reject({ txId, serverId, by }) {
    const result = await pool.query(
      `UPDATE pending_transactions
       SET status = 'rejected', rejected_by = $1
       WHERE id = $2 AND server_id = $3
         AND status IN ('pending_buyer','pending_seller')
       RETURNING id, status`,
      [by, txId, serverId]
    );
    if (result.rowCount === 0) {
      throw Object.assign(
        new Error('Transaction not found or already in terminal state'),
        { statusCode: 404 }
      );
    }
    return result.rows[0];
  }

  /**
   * トークン文字列で取引を検索する。
   */
  static async findByToken(txToken, serverId) {
    const result = await pool.query(
      `SELECT id, tx_token, server_id, buyer_user_id, product_id,
              amount, item_name, status, buyer_approved_at,
              seller_approved_at, rejected_by, expires_at, created_at
       FROM pending_transactions
       WHERE tx_token = $1 AND server_id = $2`,
      [txToken, serverId]
    );
    return result.rows[0] || null;
  }

  /**
   * 運営者の承認待ち一覧（Webダッシュボード用）。
   */
  static async listPendingForServer(serverId) {
    const result = await pool.query(
      `SELECT pt.id, pt.tx_token, pt.amount, pt.item_name, pt.status,
              pt.buyer_approved_at, pt.expires_at, pt.created_at,
              u.username AS buyer_username, u.minecraft_id AS buyer_mc_id
       FROM pending_transactions pt
       JOIN users u ON u.id = pt.buyer_user_id
       WHERE pt.server_id = $1
         AND pt.status = 'pending_seller'
         AND pt.expires_at > NOW()
       ORDER BY pt.created_at ASC`,
      [serverId]
    );
    return result.rows;
  }

  /**
   * 期限切れの取引を一括で expired にする（定期ジョブから呼ぶ）。
   * @returns {number} 更新件数
   */
  static async expireStale() {
    const result = await pool.query(
      `UPDATE pending_transactions
       SET status = 'expired'
       WHERE status IN ('pending_buyer','pending_seller')
         AND expires_at <= NOW()`
    );
    return result.rowCount;
  }

  // ── private helper ────────────────────────────────────────────────────

  static _assertActive(tx) {
    if (tx.status === 'expired' || new Date() > new Date(tx.expires_at)) {
      throw Object.assign(new Error('Transaction has expired'), { statusCode: 410 });
    }
    if (tx.status === 'completed') {
      throw Object.assign(new Error('Transaction already completed'), { statusCode: 409 });
    }
    if (tx.status === 'rejected') {
      throw Object.assign(new Error('Transaction was rejected'), { statusCode: 409 });
    }
  }
}

module.exports = PendingTransaction;
