'use strict';

/**
 * Subscription.js — サブスクリプション（定期課金）モデル
 *
 * 設計:
 *   - 初回のみユーザー承認が必要 (status: pending → active)
 *   - 以降の課金はアプリ側が POST /api/server/subscription/:id/charge を叩いたときのみ実行
 *   - アプリが next_charge_at を確認し、期限到来時に /charge を叩く責任を持つ
 *   - 猶予期間（interval_days 分）を超えても課金されなかった場合はジョブが suspended に変更
 *   - amount はサーバー側の商品マスタから取得（クライアントから受け取らない）
 */

const { pool } = require('../config/database');

class Subscription {
  /**
   * サブスク登録を開始する (status: pending)。
   * ユーザーがダッシュボードで承認するまでは pending のまま。
   *
   * @param {object} opts
   * @param {number}  opts.serverId       server_accounts.id
   * @param {string}  opts.username       フォーラムusername（ユーザー特定用）
   * @param {number}  opts.productId      server_products.id
   * @param {number}  opts.intervalDays   課金間隔（日数）
   * @returns {object} サブスクレコード + 表示用情報
   */
  static async initiate({ serverId, username, productId, intervalDays }) {
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

    // 2. ユーザーを username で検索
    const userResult = await pool.query(
      `SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)`,
      [username.trim()]
    );
    if (userResult.rows.length === 0) {
      throw Object.assign(
        new Error('User not found. Please check the username.'),
        { statusCode: 404 }
      );
    }
    const user = userResult.rows[0];

    // 3. intervalDays バリデーション
    const days = Number(intervalDays);
    if (!Number.isInteger(days) || days <= 0) {
      throw Object.assign(new Error('intervalDays must be a positive integer'), { statusCode: 400 });
    }

    // 4. 同一サーバー・ユーザー・商品の active/pending サブスクが既にあるかチェック
    const existing = await pool.query(
      `SELECT id FROM subscriptions
       WHERE server_id = $1 AND user_id = $2 AND product_id = $3
         AND status IN ('pending', 'active')`,
      [serverId, user.id, product.id]
    );
    if (existing.rows.length > 0) {
      throw Object.assign(
        new Error('An active or pending subscription already exists for this user and product'),
        { statusCode: 409 }
      );
    }

    // 5. サブスクレコードを作成（next_charge_at は承認時に設定）
    const insertResult = await pool.query(
      `INSERT INTO subscriptions (server_id, user_id, product_id, amount, interval_days, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id, amount, interval_days, status, created_at`,
      [serverId, user.id, product.id, product.price.toString(), days]
    );

    const sub = insertResult.rows[0];
    return {
      subscriptionId: sub.id,
      userId:         user.id,
      username:       user.username,
      productName:    product.name,
      amount:         sub.amount,
      intervalDays:   sub.interval_days,
      status:         sub.status,
      createdAt:      sub.created_at,
    };
  }

  /**
   * ユーザーがダッシュボードから初回同意する (pending → active)。
   *
   * @param {object} opts
   * @param {number}  opts.subId   subscriptions.id
   * @param {number}  opts.userId  セッションの user.id
   */
  static async approveByUser({ subId, userId }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id, status, amount, server_id, interval_days, user_id
         FROM subscriptions
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [subId, userId]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
      }

      const sub = result.rows[0];
      if (sub.status !== 'pending') {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`Cannot approve: status is ${sub.status}`),
          { statusCode: 409 }
        );
      }

      // 残高事前チェック
      const userResult = await client.query(
        'SELECT total_points FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      const points = BigInt(userResult.rows[0].total_points);
      const amount = BigInt(sub.amount);
      if (points < amount) {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error('Insufficient points'),
          { statusCode: 402, data: { current: points.toString(), required: amount.toString() } }
        );
      }

      // 初回即時引き落とし + サーバーへの加算 + next_charge_at 設定
      await client.query(
        'UPDATE users SET total_points = total_points - $1 WHERE id = $2',
        [amount.toString(), userId]
      );

      // サーバー残高へ加算
      await client.query(
        'UPDATE server_accounts SET balance = balance + $1 WHERE id = $2',
        [amount.toString(), sub.server_id]
      );

      await client.query(
        `INSERT INTO point_transactions
           (user_id, amount, transaction_type, description, sender_type, sender_id, receiver_type, receiver_id)
         VALUES ($1, $2, 'subscription', $3, 'user', $1, 'server', $4)`,
        [userId, (-amount).toString(), `サブスク初回課金`, sub.server_id]
      );

      const nextChargeAt = new Date(Date.now() + sub.interval_days * 24 * 60 * 60 * 1000);
      await client.query(
        `UPDATE subscriptions
         SET status = 'active', next_charge_at = $1
         WHERE id = $2`,
        [nextChargeAt, sub.id]
      );

      await client.query('COMMIT');
      console.log(`✅ サブスク承認: sub_id=${sub.id} user_id=${userId}`);
      return { status: 'active', nextChargeAt };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * サーバー側からキャンセルする。
   *
   * @param {object} opts
   * @param {number}  opts.subId     subscriptions.id
   * @param {number}  opts.serverId  server_accounts.id（なりすまし防止）
   */
  static async cancelByServer({ subId, serverId }) {
    const result = await pool.query(
      `UPDATE subscriptions
       SET status = 'cancelled'
       WHERE id = $1 AND server_id = $2
         AND status IN ('pending','active','suspended')
       RETURNING id, status`,
      [subId, serverId]
    );
    if (result.rowCount === 0) {
      throw Object.assign(
        new Error('Subscription not found or already in terminal state'),
        { statusCode: 404 }
      );
    }
    console.log(`🚫 サブスクキャンセル(server): sub_id=${subId}`);
    return result.rows[0];
  }

  /**
   * ユーザー側からキャンセルする。
   *
   * @param {object} opts
   * @param {number}  opts.subId   subscriptions.id
   * @param {number}  opts.userId  セッションの user.id（なりすまし防止）
   */
  static async cancelByUser({ subId, userId }) {
    const result = await pool.query(
      `UPDATE subscriptions
       SET status = 'cancelled'
       WHERE id = $1 AND user_id = $2
         AND status IN ('pending','active','suspended')
       RETURNING id, status`,
      [subId, userId]
    );
    if (result.rowCount === 0) {
      throw Object.assign(
        new Error('Subscription not found or already in terminal state'),
        { statusCode: 404 }
      );
    }
    console.log(`🚫 サブスクキャンセル(user): sub_id=${subId}`);
    return result.rows[0];
  }

  /**
   * サーバーのサブスク一覧を取得する。
   *
   * @param {number} serverId
   */
  static async listByServer(serverId) {
    const result = await pool.query(
      `SELECT s.id, s.amount, s.interval_days, s.next_charge_at, s.status, s.created_at,
              u.username, u.id AS user_id,
              sp.name AS product_name
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN server_products sp ON sp.id = s.product_id
       WHERE s.server_id = $1
       ORDER BY s.created_at DESC`,
      [serverId]
    );
    return result.rows;
  }

  /**
   * ユーザーの有効サブスク一覧を取得する（ダッシュボード用）。
   * pending/active/suspended を返す（cancelled は除外）。
   *
   * @param {number} userId
   */
  static async listByUser(userId) {
    const result = await pool.query(
      `SELECT s.id, s.amount, s.interval_days, s.next_charge_at, s.status, s.created_at,
              sa.name AS server_name, sa.id AS server_id,
              sp.name AS product_name
       FROM subscriptions s
       JOIN server_accounts sa ON sa.id = s.server_id
       LEFT JOIN server_products sp ON sp.id = s.product_id
       WHERE s.user_id = $1
         AND s.status IN ('pending','active','suspended')
       ORDER BY s.created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  /**
   * IDで単件取得する。
   *
   * @param {number} subId
   */
  static async findById(subId) {
    const result = await pool.query(
      `SELECT s.id, s.server_id, s.user_id, s.product_id,
              s.amount, s.interval_days, s.next_charge_at, s.status, s.created_at,
              sa.name AS server_name,
              u.username,
              sp.name AS product_name
       FROM subscriptions s
       JOIN server_accounts sa ON sa.id = s.server_id
       JOIN users u ON u.id = s.user_id
       LEFT JOIN server_products sp ON sp.id = s.product_id
       WHERE s.id = $1`,
      [subId]
    );
    return result.rows[0] || null;
  }

  /**
   * アプリ（サーバー）が明示的に課金を要求する。
   * next_charge_at が到来していない場合はエラーを返す（二重課金防止）。
   * 残高不足の場合は suspended に変更してエラーを返す。
   *
   * @param {object} opts
   * @param {number}  opts.subId     subscriptions.id
   * @param {number}  opts.serverId  server_accounts.id（なりすまし防止）
   * @returns {object} { status, nextChargeAt, amount }
   */
  static async chargeByServer({ subId, serverId }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // サブスクを取得（行ロック）
      const subResult = await client.query(
        `SELECT id, user_id, server_id, amount, interval_days, status, next_charge_at
         FROM subscriptions
         WHERE id = $1 AND server_id = $2
         FOR UPDATE`,
        [subId, serverId]
      );

      if (subResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
      }

      const sub = subResult.rows[0];

      if (sub.status !== 'active') {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`Cannot charge: status is ${sub.status}`),
          { statusCode: 409 }
        );
      }

      // next_charge_at がまだ到来していない場合は拒否（二重課金防止）
      if (sub.next_charge_at > new Date()) {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error('Not yet due for charging'),
          { statusCode: 425, data: { next_charge_at: sub.next_charge_at } }
        );
      }

      // ユーザー残高を確認（行ロック）
      const userRow = await client.query(
        'SELECT total_points FROM users WHERE id = $1 FOR UPDATE',
        [sub.user_id]
      );
      const points = BigInt(userRow.rows[0].total_points);
      const amount = BigInt(sub.amount);

      if (points < amount) {
        // 残高不足 → suspended
        await client.query(
          `UPDATE subscriptions SET status = 'suspended' WHERE id = $1`,
          [sub.id]
        );
        await client.query('COMMIT');
        console.log(`⚠️ サブスク残高不足→suspended: sub_id=${sub.id} user_id=${sub.user_id}`);
        throw Object.assign(
          new Error('Insufficient points'),
          { statusCode: 402, data: { current: points.toString(), required: amount.toString() } }
        );
      }

      // 引き落とし + サーバーへの加算
      await client.query(
        'UPDATE users SET total_points = total_points - $1 WHERE id = $2',
        [amount.toString(), sub.user_id]
      );

      // サーバー残高へ加算
      await client.query(
        'UPDATE server_accounts SET balance = balance + $1 WHERE id = $2',
        [amount.toString(), sub.server_id]
      );

      await client.query(
        `INSERT INTO point_transactions
           (user_id, amount, transaction_type, description, sender_type, sender_id, receiver_type, receiver_id)
         VALUES ($1, $2, 'subscription', $3, 'user', $1, 'server', $4)`,
        [sub.user_id, (-amount).toString(), 'サブスク定期課金', sub.server_id]
      );

      // next_charge_at をドリフトしないよう前回の値に interval を加算
      const nextChargeAt = new Date(sub.next_charge_at.getTime() + sub.interval_days * 24 * 60 * 60 * 1000);
      await client.query(
        `UPDATE subscriptions SET next_charge_at = $1 WHERE id = $2`,
        [nextChargeAt, sub.id]
      );

      await client.query('COMMIT');
      console.log(`💳 サブスク課金完了(app要求): sub_id=${sub.id} amount=${amount}`);
      return { status: 'active', nextChargeAt, amount: sub.amount };
    } catch (err) {
      // statusCode が付いていれば ROLLBACK 済みなので再スロー
      if (!err.statusCode) {
        await client.query('ROLLBACK');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * バックグラウンドジョブ: 猶予期間（interval_days 分）を超えても課金されていない
   * active なサブスクを suspended に変更する。
   * 実際の課金はアプリ側が /charge エンドポイントを叩くことで行われる。
   *
   * @returns {object} { suspended: number }
   */
  static async suspendOverdue() {
    const client = await pool.connect();
    let suspended = 0;

    try {
      // next_charge_at + interval_days 日（猶予期間）を過ぎたものを対象とする
      const targets = await client.query(
        `SELECT id, user_id
         FROM subscriptions
         WHERE status = 'active'
           AND next_charge_at + (interval_days || ' days')::interval <= NOW()
         FOR UPDATE SKIP LOCKED`
      );

      for (const sub of targets.rows) {
        try {
          await client.query('BEGIN');
          await client.query(
            `UPDATE subscriptions SET status = 'suspended' WHERE id = $1`,
            [sub.id]
          );
          await client.query('COMMIT');
          suspended++;
          console.log(`⚠️ サブスク猶予超過→suspended: sub_id=${sub.id} user_id=${sub.user_id}`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`❌ サブスク猶予超過処理エラー sub_id=${sub.id}:`, err.message);
        }
      }
    } finally {
      client.release();
    }

    return { suspended };
  }
}

module.exports = Subscription;
