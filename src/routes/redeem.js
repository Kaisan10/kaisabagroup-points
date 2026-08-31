const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const RedeemCode = require('../models/RedeemCode');
const User = require('../models/User');
const { pool } = require('../config/database');

const requireAuth = require('../middleware/requireAuth');

// ── ギフトコード生成（crypto でセキュアなランダム文字列）───────────────
// 形式: GFT-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX (40文字, 128bit エントロピー)
function generateGiftCode() {
  const part = () => crypto.randomBytes(4).toString('hex').toUpperCase();
  return `GFT-${part()}-${part()}-${part()}-${part()}`;
}

// ── 入力バリデーション ────────────────────────────────────────────────
function validatePoints(points) {
  const n = Number(points);
  return Number.isInteger(n) && n > 0 && n <= 9_000_000_000_000;
}

function validateTitle(title) {
  return typeof title === 'string' && title.trim().length > 0 && title.trim().length <= 10;
}

function validateMemo(memo) {
  if (memo === undefined || memo === null || memo === '') return true;
  return typeof memo === 'string' && memo.length <= 50;
}

// ── ギフトコード作成 POST /api/redeem/gift/create ────────────────────
router.post('/gift/create', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { points, title, memo } = req.body;

    // ── バリデーション
    if (!validatePoints(points)) {
      return res.status(400).json({ success: false, error: 'ポイント数が無効です（1以上の整数を指定してください）' });
    }
    if (!validateTitle(title)) {
      return res.status(400).json({ success: false, error: 'タイトルを入力してください（1〜10文字）' });
    }
    if (!validateMemo(memo)) {
      return res.status(400).json({ success: false, error: 'メモは50文字以内で入力してください' });
    }

    // 停止中ユーザーはギフト作成不可
    if (req.session.user.is_suspended) {
      return res.status(403).json({ success: false, error: 'アカウントが停止されています' });
    }

    // 手数料の振込先サービスアカウントを確認
    const feeRecipientName = process.env.SERVICE_ACCOUNT_FEE_RECIPIENT;
    if (!feeRecipientName) {
      return res.status(503).json({ success: false, error: 'ギフト作成が一時的に利用できません（設定不備）' });
    }
    const recipientRes = await pool.query(
      'SELECT id FROM server_accounts WHERE name = $1 AND is_active = TRUE LIMIT 1',
      [feeRecipientName]
    );
    if (recipientRes.rows.length === 0) {
      return res.status(503).json({ success: false, error: 'ギフト作成が一時的に利用できません（設定不備）' });
    }
    const recipientAccountId = recipientRes.rows[0].id;

    const pointsBig = BigInt(Math.floor(Number(points)));
    // 手数料: 1%切り上げ（最低1pt）
    const feeBig = BigInt(Math.max(1, Math.ceil(Number(pointsBig) * 0.01)));
    const totalDeductBig = pointsBig + feeBig;
    const cleanTitle = title.trim();
    const cleanMemo  = (memo && typeof memo === 'string') ? memo.trim() : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 残高確認（行ロック）
      const userRow = await client.query(
        'SELECT total_points FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (userRow.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'ユーザーが見つかりません' });
      }

      const currentPoints = BigInt(userRow.rows[0].total_points);
      if (currentPoints < totalDeductBig) {
        await client.query('ROLLBACK');
        return res.status(402).json({ success: false, error: `ポイントが不足しています（残高: ${currentPoints.toLocaleString('en')}pt、必要: ${totalDeductBig.toLocaleString('en')}pt）` });
      }

      // コード生成（衝突時は最大5回リトライ）
      let code = null;
      for (let i = 0; i < 5; i++) {
        const candidate = generateGiftCode();
        const exist = await client.query('SELECT id FROM gift_codes WHERE code = $1', [candidate]);
        if (exist.rows.length === 0) { code = candidate; break; }
      }
      if (!code) {
        await client.query('ROLLBACK');
        return res.status(500).json({ success: false, error: 'コード生成に失敗しました。もう一度お試しください' });
      }

      // ユーザーから合計（ギフト分 + 手数料）を減算
      await client.query(
        'UPDATE users SET total_points = total_points - $1 WHERE id = $2',
        [totalDeductBig.toString(), userId]
      );

      // gift_codes に登録
      await client.query(
        `INSERT INTO gift_codes (code, creator_user_id, points, title, memo)
         VALUES ($1, $2, $3, $4, $5)`,
        [code, userId, pointsBig.toString(), cleanTitle, cleanMemo]
      );

      // 送り主の point_transactions に記録（ギフト分）
      const senderDesc = `ギフト送付: ${cleanTitle}`;
      await client.query(
        `INSERT INTO point_transactions (user_id, amount, transaction_type, description)
         VALUES ($1, $2, $3, $4)`,
        [userId, (-pointsBig).toString(), 'gift_sent', senderDesc]
      );

      // 手数料の point_transactions に記録
      await client.query(
        `INSERT INTO point_transactions (user_id, amount, transaction_type, description)
         VALUES ($1, $2, 'gift_fee', 'ギフト作成手数料')`,
        [userId, (-feeBig).toString()]
      );

      // 振込先サービスアカウントのbalanceに手数料を加算
      await client.query(
        'UPDATE server_accounts SET balance = balance + $1 WHERE id = $2',
        [feeBig.toString(), recipientAccountId]
      );

      await client.query('COMMIT');

      // セッションのポイントを更新
      req.session.user.total_points = Number(currentPoints - totalDeductBig);

      console.log(`✅ ギフトコード作成: User ${userId} -${pointsBig}pt fee=${feeBig}pt → ${feeRecipientName} code="${code}"`);

      res.json({
        success: true,
        data: {
          code,
          points: Number(pointsBig),
          fee: Number(feeBig),
          title: cleanTitle,
          memo: cleanMemo,
        }
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    console.error('❌ ギフトコード作成エラー:', err);
    res.status(500).json({ success: false, error: 'サーバーエラーが発生しました' });
  }
});

// ── ギフトコード照会 GET /api/redeem/gift/info?code=XXX ─────────────
// 引き換え前にコード情報を確認するためのエンドポイント
router.get('/gift/info', requireAuth, async (req, res) => {
  try {
    const { code } = req.query;

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'コードを指定してください' });
    }

    const cleanCode = code.trim().toUpperCase();

    const result = await pool.query(
      `SELECT g.points, g.title, g.memo, g.is_used, u.username AS creator_username
       FROM gift_codes g
       JOIN users u ON u.id = g.creator_user_id
       WHERE g.code = $1`,
      [cleanCode]
    );

    if (result.rows.length === 0) {
      // YAMLコードかもしれないので、存在しない場合は汎用メッセージ
      return res.status(404).json({ success: false, error: 'ギフトコードが見つかりません' });
    }

    const row = result.rows[0];
    if (row.is_used) {
      return res.status(410).json({ success: false, error: 'このギフトコードは既に使用されています' });
    }

    res.json({
      success: true,
      data: {
        points: Number(row.points),
        title: row.title,
        memo: row.memo,
        sender_username: row.creator_username,
      }
    });

  } catch (err) {
    console.error('❌ ギフトコード照会エラー:', err);
    res.status(500).json({ success: false, error: 'サーバーエラーが発生しました' });
  }
});

// ── コード引き換え POST /api/redeem/code ────────────────────────────
// YAMLコード → ギフトコードの順で検索
router.post('/code', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const userId = req.session.user.id;

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'コードを入力してください' });
    }

    const cleanCode = code.trim();

    // ── 1. YAMLコード引き換え（既存ロジック）
    const validation = await RedeemCode.validateCode(cleanCode);
    if (validation.valid) {
      const result = await RedeemCode.redeemCode(userId, cleanCode);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }
      const updatedUser = await User.findById(userId);
      return res.json({
        success: true,
        message: `${result.points}ポイントを獲得しました！`,
        data: {
          type: 'yaml_code',
          code: result.code,
          points_awarded: result.points,
          description: result.description,
          new_total_points: Number(updatedUser.total_points),
        }
      });
    }

    // ── 2. ギフトコード引き換え（アトミック）
    const codeUpper = cleanCode.toUpperCase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ギフトコードを SELECT FOR UPDATE でロック
      const giftRow = await client.query(
        `SELECT g.id, g.points, g.title, g.memo, g.is_used, g.creator_user_id,
                u.username AS creator_username
         FROM gift_codes g
         JOIN users u ON u.id = g.creator_user_id
         WHERE g.code = $1
         FOR UPDATE`,
        [codeUpper]
      );

      if (giftRow.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'コードが見つかりません' });
      }

      const gift = giftRow.rows[0];

      if (gift.is_used) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'このコードは既に使用されています' });
      }

      const pointsBig = BigInt(gift.points);
      const creatorName = gift.creator_username;
      const giftTitle = gift.title;

      // ギフトコードを使用済みに更新
      await client.query(
        `UPDATE gift_codes
         SET is_used = TRUE, used_by_user_id = $1, used_at = NOW()
         WHERE id = $2`,
        [userId, gift.id]
      );

      // 受取人のポイントを加算
      await client.query(
        'UPDATE users SET total_points = total_points + $1 WHERE id = $2',
        [pointsBig.toString(), userId]
      );

      // 受取人の履歴: "<送り主名>: <タイトル>"
      const receiverDesc = `${creatorName}: ${giftTitle}`;
      await client.query(
        `INSERT INTO point_transactions (user_id, amount, transaction_type, description)
         VALUES ($1, $2, $3, $4)`,
        [userId, pointsBig.toString(), 'gift_received', receiverDesc]
      );

      await client.query('COMMIT');

      const updatedUser = await User.findById(userId);

      console.log(`✅ ギフト引き換え: User ${userId} +${pointsBig}pt from "${creatorName}" code="${codeUpper}"`);

      return res.json({
        success: true,
        message: `${Number(pointsBig).toLocaleString('en')}ポイントを獲得しました！`,
        data: {
          type: 'gift',
          code: codeUpper,
          points_awarded: Number(pointsBig),
          sender_username: creatorName,
          title: giftTitle,
          memo: gift.memo,
          new_total_points: Number(updatedUser.total_points),
        }
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    console.error('❌ コード引き換えエラー:', err);
    res.status(500).json({ success: false, error: 'サーバーエラーが発生しました' });
  }
});

module.exports = router;
