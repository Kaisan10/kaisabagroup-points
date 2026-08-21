const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { pool } = require('../config/database');

class RedeemCode {
  // YAMLファイルからコードを読み込む
  static loadCodes() {
    try {
      const filePath = path.join(__dirname, '../../redeem_codes.yaml');
      const fileContents = fs.readFileSync(filePath, 'utf8');
      const data = yaml.load(fileContents);
      return data.codes || [];
    } catch (err) {
      console.error('❌ 引き換えコードファイル読み込みエラー:', err);
      return [];
    }
  }

  // コードが有効かどうかをチェック
  static async validateCode(code) {
    try {
      const codes = this.loadCodes();
      const codeUpper = code.toUpperCase().trim();
      
      // コード定義を検索
      const codeDef = codes.find(c => c.code.toUpperCase() === codeUpper);
      
      if (!codeDef) {
        return {
          valid: false,
          error: 'コードが見つかりません'
        };
      }

      if (!codeDef.active) {
        return {
          valid: false,
          error: 'このコードは無効です'
        };
      }

      return {
        valid: true,
        code: codeDef.code,
        points: codeDef.points,
        description: codeDef.description
      };
    } catch (err) {
      console.error('❌ コード検証エラー:', err);
      return {
        valid: false,
        error: 'コード検証中にエラーが発生しました'
      };
    }
  }

  // ユーザーが既にこのコードを使用しているかチェック
  static async isCodeUsedByUser(userId, code) {
    try {
      const codeUpper = code.toUpperCase().trim();
      const result = await pool.query(
        'SELECT id FROM redeem_code_uses WHERE user_id = $1 AND code = $2',
        [userId, codeUpper]
      );
      return result.rows.length > 0;
    } catch (err) {
      console.error('❌ コード使用チェックエラー:', err);
      throw err;
    }
  }

  // コードを使用済みとして記録
  static async markCodeAsUsed(userId, code, points) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const codeUpper = code.toUpperCase().trim();
      
      // 使用履歴を記録
      await client.query(
        'INSERT INTO redeem_code_uses (user_id, code, points_awarded) VALUES ($1, $2, $3)',
        [userId, codeUpper, points]
      );

      await client.query('COMMIT');
      console.log(`✅ コード使用記録: User ${userId} がコード "${codeUpper}" を使用（${points}ポイント）`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ コード使用記録エラー:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  // コード引き換え処理（検証 + 使用記録 + ポイント付与 を原子的に実行）
  static async redeemCode(userId, code) {
    try {
      // 1. コードの有効性をチェック (YAML読み込み)
      const validation = await this.validateCode(code);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 2. 使用済みとして記録
        const codeUpper = validation.code.toUpperCase().trim();
        const pointsBig = BigInt(validation.points);

        await client.query(
          'INSERT INTO redeem_code_uses (user_id, code, points_awarded) VALUES ($1, $2, $3)',
          [userId, codeUpper, pointsBig.toString()]
        );

        // 3. ポイントを付与
        await client.query(
          'UPDATE users SET total_points = total_points + $1 WHERE id = $2',
          [pointsBig.toString(), userId]
        );

        // 4. トランザクション記録を追加
        await client.query(
          `INSERT INTO point_transactions (user_id, amount, transaction_type, description) 
           VALUES ($1, $2, $3, $4)`,
          [userId, pointsBig.toString(), 'code_redemption', `コード引き換え: ${codeUpper} - ${validation.description}`]
        );

        await client.query('COMMIT');
        console.log(`✅ コード引き換え成功: User ${userId} code="${codeUpper}" (+${pointsBig}pt)`);
        
        return {
          success: true,
          code: validation.code,
          points: validation.points,
          description: validation.description
        };
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
          return { success: false, error: 'このコードは既に使用されています' };
        }
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('❌ コード引き換えプロセスエラー:', err);
      return { success: false, error: 'コード引き換え中にエラーが発生しました' };
    }
  }
}

module.exports = RedeemCode;

