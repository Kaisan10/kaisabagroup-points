const { pool } = require('../config/database');

class User {
  // Discourse IDでユーザーを検索または作成
  static async findOrCreateByDiscourse(discourseData) {
    try {
      // 既存ユーザーを検索
      let result = await pool.query(
        'SELECT * FROM users WHERE discourse_id = $1',
        [discourseData.external_id]
      );

      if (result.rows.length > 0) {
        const user = result.rows[0];
        // 既存ユーザー: 最終ログイン時刻、アバターURL、およびユーザー名を更新
        // (Discourse側でユーザー名が変更された場合に対応)
        await pool.query(
          'UPDATE users SET last_login = CURRENT_TIMESTAMP, avatar_url = $2, username = $3 WHERE id = $1',
          [user.id, discourseData.avatar_url, discourseData.username]
        );
        return { ...user, avatar_url: discourseData.avatar_url, username: discourseData.username };
      }


      // 新規ユーザーを作成
      result = await pool.query(
        `INSERT INTO users (discourse_id, username, email, avatar_url, total_points) 
         VALUES ($1, $2, $3, $4, 0) 
         RETURNING *`,
        [discourseData.external_id, discourseData.username, discourseData.email, discourseData.avatar_url]
      );


      console.log(`✅ 新規ユーザー作成: ${discourseData.username}`);
      return result.rows[0];
    } catch (err) {
      console.error('❌ ユーザー検索/作成エラー:', err);
      throw err;
    }
  }

  // ユーザーIDでユーザー情報を取得
  static async findById(id) {
    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [id]
      );
      return result.rows[0] || null;
    } catch (err) {
      console.error('❌ ユーザー取得エラー:', err);
      throw err;
    }
  }

  // ユーザー名でユーザーを検索（大文字小文字を無視して検索）
  static async findByUsername(username) {
    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1',
        [username.trim()]
      );
      return result.rows[0] || null;
    } catch (err) {
      console.error('❌ ユーザー検索エラー:', err);
      throw err;
    }
  }

  // ポイントを追加
  static async addPoints(userId, amount, transactionType, description = '') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ユーザーのポイントを更新（BigInt加算）
      await client.query(
        'UPDATE users SET total_points = total_points + $1 WHERE id = $2',
        [amount.toString(), userId]
      );

      // トランザクション記録を追加
      await client.query(
        `INSERT INTO point_transactions (user_id, amount, transaction_type, description) 
         VALUES ($1, $2, $3, $4)`,
        [userId, amount.toString(), transactionType, description]
      );

      await client.query('COMMIT');
      console.log(`✅ ポイント追加: User ${userId} +${amount}pt (${transactionType})`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ ポイント追加エラー:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 重複を避けてポイントを追加する（アトミック）
   * 特定の期間内に同じタイプの取引がない場合のみ実行
   * 
   * @param {object} opts
   * @param {number} opts.userId
   * @param {BigInt|number} opts.amount
   * @param {string} opts.transactionType
   * @param {string} opts.description
   * @param {Date} [opts.since] この日時以降に同一タイプがあれば重複とみなす
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  static async addPointsIfUnique({ userId, amount, transactionType, description = '', since }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 重複チェック（行ロックを伴わないがトランザクション内で実行）
      let checkQuery = `
        SELECT id FROM point_transactions 
        WHERE user_id = $1 AND transaction_type = $2
      `;
      const checkParams = [userId, transactionType];

      if (since) {
        checkQuery += ' AND created_at >= $3';
        checkParams.push(since);
      }

      const checkResult = await client.query(checkQuery, checkParams);
      if (checkResult.rows.length > 0) {
        await client.query('ROLLBACK');
        return { success: false, message: 'Already awarded for this period' };
      }

      // ポイントを更新
      await client.query(
        'UPDATE users SET total_points = total_points + $1 WHERE id = $2',
        [amount.toString(), userId]
      );

      // トランザクション記録を追加
      await client.query(
        `INSERT INTO point_transactions (user_id, amount, transaction_type, description) 
         VALUES ($1, $2, $3, $4)`,
        [userId, amount.toString(), transactionType, description]
      );

      await client.query('COMMIT');
      console.log(`✅ ポイント追加(Unique): User ${userId} +${amount}pt (${transactionType})`);
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ ポイント追加(Unique)エラー:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  // ポイント履歴を取得
  static async getPointHistory(userId, limit = 50) {
    try {
      const result = await pool.query(
        `SELECT * FROM point_transactions 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2`,
        [userId, limit]
      );
      return result.rows;
    } catch (err) {
      console.error('❌ ポイント履歴取得エラー:', err);
      throw err;
    }
  }

  // ポイントを消費（残高不足ならエラー）
  static async deductPoints(userId, amount, transactionType, description = '') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 行ロックして現在の残高を取得
      const result = await client.query(
        'SELECT total_points FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );

      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      const currentPoints = BigInt(result.rows[0].total_points);
      const amountBig = BigInt(amount);

      if (currentPoints < amountBig) {
        throw Object.assign(new Error('Insufficient points'), { 
          currentPoints: currentPoints.toString(), 
          required: amountBig.toString(),
          statusCode: 402 
        });
      }

      // ポイントを更新
      const newTotal = currentPoints - amountBig;
      await client.query(
        'UPDATE users SET total_points = $1 WHERE id = $2',
        [newTotal.toString(), userId]
      );

      // トランザクション記録を追加
      await client.query(
        `INSERT INTO point_transactions (user_id, amount, transaction_type, description) 
         VALUES ($1, $2, $3, $4)`,
        [userId, (-amountBig).toString(), transactionType, description]
      );

      await client.query('COMMIT');
      console.log(`✅ ポイント消費: User ${userId} -${amountBig}pt (${transactionType})`);
      return newTotal.toString();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  // ランキング参加設定を更新
  static async setRankingOptIn(userId, optIn) {
    try {
      await pool.query(
        'UPDATE users SET ranking_opt_in = $1 WHERE id = $2',
        [optIn, userId]
      );
    } catch (err) {
      console.error('❌ ランキング設定更新エラー:', err);
      throw err;
    }
  }

  // 信頼モードの自動承認設定を更新
  static async setTrustedAutoApprove(userId, optIn) {
    try {
      await pool.query(
        'UPDATE users SET trusted_auto_approve = $1 WHERE id = $2',
        [optIn, userId]
      );
    } catch (err) {
      console.error('❌ 信頼モード自動承認設定更新エラー:', err);
      throw err;
    }
  }

  // ランキング取得（参加しているユーザーのみ、offset/limit対応）
  static async getRanking(limit = 10, offset = 0) {
    try {
      const result = await pool.query(
        `SELECT id, username, avatar_url, total_points,
                ROW_NUMBER() OVER (ORDER BY total_points DESC) AS rank
         FROM users
         WHERE ranking_opt_in = TRUE AND is_suspended = FALSE
         ORDER BY total_points DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return result.rows;
    } catch (err) {
      console.error('❌ ランキング取得エラー:', err);
      throw err;
    }
  }

  // ランキング参加者の総数を取得
  static async getRankingCount() {
    try {
      const result = await pool.query(
        `SELECT COUNT(*) AS cnt FROM users WHERE ranking_opt_in = TRUE AND is_suspended = FALSE`
      );
      return parseInt(result.rows[0].cnt, 10);
    } catch (err) {
      console.error('❌ ランキング件数取得エラー:', err);
      throw err;
    }
  }

  // 指定ユーザーのランキング順位を取得
  static async getUserRank(userId) {
    try {
      const result = await pool.query(
        `SELECT COUNT(*) + 1 AS rank
         FROM users
         WHERE ranking_opt_in = TRUE AND is_suspended = FALSE
           AND total_points > (SELECT total_points FROM users WHERE id = $1)`,
        [userId]
      );
      return parseInt(result.rows[0].rank, 10);
    } catch (err) {
      console.error('❌ ユーザーランク取得エラー:', err);
      throw err;
    }
  }
}

module.exports = User;