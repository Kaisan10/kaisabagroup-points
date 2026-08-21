'use strict';

const { pool } = require('../config/database');
const { generateApiKey, hashApiKey, keyPrefix } = require('../utils/apiKey');

class ServerAccount {
  /**
   * サービスアカウントを作成し、生成した平文APIキーを返す。
   * 平文キーはこの関数が返す値でのみ取得可能（DB には保存しない）。
   *
   * @param {object} opts
   * @param {string} opts.name          サーバー表示名
   * @param {number} opts.ownerUserId   オーナーのユーザーID（必須）
   * @param {string} [opts.webhookUrl]  取引通知先URL
   * @param {string} [opts.redirectUris] OAuthコールバックURL群
   * @returns {{ account: object, plainApiKey: string }}
   */
  static async create({ name, ownerUserId, webhookUrl, redirectUris }) {
    // 入力バリデーション
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw Object.assign(new Error('name is required'), { statusCode: 400 });
    }
    if (name.length < 5 || !/^[\x21-\x7E]+$/.test(name)) {
      throw Object.assign(new Error('サービスアカウント名は5文字以上の半角英数字と記号のみ使用可能です（スペース不可）'), { statusCode: 400 });
    }
    if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) {
      throw Object.assign(new Error('ownerUserId must be a positive integer'), { statusCode: 400 });
    }

    // 1人1つまでの制限 (activeなアカウント)
    const existingCountRes = await pool.query(
      'SELECT COUNT(*) as count FROM server_accounts WHERE owner_user_id = $1 AND is_active = TRUE',
      [ownerUserId]
    );
    if (parseInt(existingCountRes.rows[0].count, 10) >= 1) {
      throw new Error('サービスアカウントは1人1つまでしか作成できません');
    }

    const plainKey  = generateApiKey();
    const keyHash   = hashApiKey(plainKey);
    const prefix    = keyPrefix(plainKey);

    const result = await pool.query(
      `INSERT INTO server_accounts
         (name, api_key_hash, api_key_prefix, owner_user_id, webhook_url, redirect_uris)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, api_key_prefix, owner_user_id, balance,
                 webhook_url, redirect_uris, seller_approval, created_at, is_active`,
      [name.trim(), keyHash, prefix, ownerUserId, webhookUrl || null, redirectUris || null]
    );

    return { account: result.rows[0], plainApiKey: plainKey };
  }

  /**
   * APIキーを再発行する。旧キーは即座に無効化される。
   * @param {number} accountId
   * @returns {{ plainApiKey: string }}
   */
  static async regenerateKey(accountId) {
    const plainKey = generateApiKey();
    const keyHash  = hashApiKey(plainKey);
    const prefix   = keyPrefix(plainKey);

    const result = await pool.query(
      `UPDATE server_accounts
       SET api_key_hash = $1, api_key_prefix = $2
       WHERE id = $3
       RETURNING id`,
      [keyHash, prefix, accountId]
    );

    if (result.rowCount === 0) throw new Error('Account not found');
    return { plainApiKey: plainKey };
  }

  /**
   * ID でアカウントを取得する。
   */
  static async findById(id) {
    const result = await pool.query(
      `SELECT id, name, api_key_prefix, owner_user_id, balance,
              webhook_url, redirect_uris, seller_approval, created_at, is_active,
              is_trusted, allowed_ips, tx_limit
       FROM server_accounts WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * オーナーユーザーIDでアカウント一覧を取得する。
   */
  static async findByOwner(ownerUserId) {
    const result = await pool.query(
      `SELECT id, name, api_key_prefix, owner_user_id, balance,
              webhook_url, redirect_uris, seller_approval, created_at, is_active,
              is_trusted, allowed_ips, tx_limit
       FROM server_accounts WHERE owner_user_id = $1
       ORDER BY created_at ASC`,
      [ownerUserId]
    );
    return result.rows;
  }

  /**
   * 全アカウント一覧（管理者用）。
   */
  static async findAll() {
    const result = await pool.query(
      `SELECT sa.id, sa.name, sa.api_key_prefix, sa.owner_user_id,
              sa.balance, sa.webhook_url, sa.redirect_uris, sa.seller_approval,
              sa.created_at, sa.is_active, u.username AS owner_username,
              sa.is_trusted, sa.allowed_ips, sa.tx_limit
       FROM server_accounts sa
       JOIN users u ON u.id = sa.owner_user_id
       ORDER BY sa.created_at ASC`
    );
    return result.rows;
  }

  /**
   * アカウントの有効/無効を切り替える。
   */
  static async setActive(id, isActive) {
    await pool.query(
      'UPDATE server_accounts SET is_active = $1 WHERE id = $2',
      [Boolean(isActive), id]
    );
  }

  /**
   * サービスアカウントを削除する。
   * 取引やサブスクリプションが存在して物理削除できない場合は論理削除（is_active = false）とする。
   */
  static async deleteAccount(id, ownerUserId) {
    try {
      const res = await pool.query('DELETE FROM server_accounts WHERE id = $1 AND owner_user_id = $2 RETURNING id', [id, ownerUserId]);
      if (res.rowCount === 0) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
      return true; // 物理削除成功
    } catch (err) {
      // ユーザー指摘の通り、23001, 23002, 23503 などを含む整合性制約違反（Class 23）をまとめて処理します
      if (err.code && err.code.startsWith('23')) {
        const result = await pool.query(
          'UPDATE server_accounts SET is_active = FALSE WHERE id = $1 AND owner_user_id = $2 RETURNING id',
          [id, ownerUserId]
        );
        if (result.rowCount === 0) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
        return false; // 論理削除成功
      }
      throw err;
    }
  }

  // ─── 商品管理 ─────────────────────────────────────────────────────────

  static async addProduct({ serverId, name, price, description }) {
    if (!Number.isInteger(price) || price <= 0) throw new Error('price must be positive integer');
    if (!name || String(name).trim().length === 0) throw new Error('name is required');

    const result = await pool.query(
      `INSERT INTO server_products (server_id, server_product_id, name, price, description)
       SELECT $1,
              COALESCE((SELECT MAX(server_product_id) FROM server_products WHERE server_id = $1), 0) + 1,
              $2, $3, $4
       RETURNING server_product_id AS id, name, price, description, is_active, created_at`,
      [serverId, name.trim(), price, description ? String(description).trim() : null]
    );
    return result.rows[0];
  }

  static async listProducts(serverId, includeInactive = false) {
    const where = includeInactive
      ? 'WHERE server_id = $1'
      : 'WHERE server_id = $1 AND is_active = TRUE';
    const result = await pool.query(
      `SELECT server_product_id AS id, name, price, description, is_active, created_at
       FROM server_products ${where} ORDER BY server_product_id ASC`,
      [serverId]
    );
    return result.rows;
  }

  static async updateProduct(serverProductId, serverId, fields) {
    // 更新可能フィールドのホワイトリスト
    const allowed = ['name', 'price', 'description', 'is_active'];
    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const key of allowed) {
      if (key in fields) {
        if (key === 'price') {
          const p = Number(fields.price);
          if (!Number.isInteger(p) || p <= 0) throw new Error('price must be positive integer');
          setClauses.push(`price = $${idx++}`);
          values.push(p);
        } else if (key === 'is_active') {
          setClauses.push(`is_active = $${idx++}`);
          values.push(Boolean(fields.is_active));
        } else {
          setClauses.push(`${key} = $${idx++}`);
          values.push(String(fields[key]).trim());
        }
      }
    }

    if (setClauses.length === 0) throw new Error('No valid fields to update');

    values.push(serverProductId, serverId);
    const result = await pool.query(
      `UPDATE server_products SET ${setClauses.join(', ')}
       WHERE server_product_id = $${idx} AND server_id = $${idx + 1}
       RETURNING server_product_id AS id, name, price, description, is_active`,
      values
    );
    if (result.rowCount === 0) throw new Error('Product not found');
    return result.rows[0];
  }

  /**
   * サービスアカウントの残高をオーナーの個人のポイント残高に引き出す。
   * トランザクションを利用し、金額の移動を安全に行う。
   * @param {number} accountId 
   * @param {number} ownerUserId 
   * @param {number|BigInt} amount 引き出し額
   * @returns {Promise<boolean>}
   */
  static async withdrawToOwner(accountId, ownerUserId, amount) {
    const amountBig = BigInt(amount);
    if (amountBig <= 0n) throw Object.assign(new Error('引き出し額は正の整数である必要があります'), { statusCode: 400 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ユーザー行をFOR UPDATEで取得
      const userRes = await client.query('SELECT total_points FROM users WHERE id = $1 FOR UPDATE', [ownerUserId]);
      if (userRes.rows.length === 0) throw Object.assign(new Error('User not found'), { statusCode: 404 });

      // サービスアカウント行をFOR UPDATEで取得し、所有権と残高を確認
      const serverRes = await client.query(
        'SELECT balance FROM server_accounts WHERE id = $1 AND owner_user_id = $2 FOR UPDATE',
        [accountId, ownerUserId]
      );
      if (serverRes.rows.length === 0) {
        throw Object.assign(new Error('Server account not found or access denied'), { statusCode: 404 });
      }

      const currentBalance = BigInt(serverRes.rows[0].balance);
      if (currentBalance < amountBig) {
        throw Object.assign(new Error('残高が不足しています'), { statusCode: 402 });
      }

      // サービスアカウントの残高を減らす
      await client.query(
        'UPDATE server_accounts SET balance = balance - $1 WHERE id = $2',
        [amountBig.toString(), accountId]
      );

      // ユーザーのポイントを増やす
      await client.query(
        'UPDATE users SET total_points = total_points + $1 WHERE id = $2',
        [amountBig.toString(), ownerUserId]
      );

      // 取引履歴の記録
      await client.query(
        `INSERT INTO point_transactions (user_id, amount, transaction_type, description) 
         VALUES ($1, $2, $3, $4)`,
        [ownerUserId, amountBig.toString(), 'service_withdraw', 'サービスアカウントからの引き出し']
      );

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = ServerAccount;
