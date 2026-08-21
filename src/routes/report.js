'use strict';

/**
 * report.js — 通報API
 *
 * セキュリティ設計:
 *   - requireAuth でセッション認証 + is_suspended チェック
 *   - カテゴリはホワイトリストで検証（SQL インジェクション対策）
 *   - 説明文の長さを厳密にバリデーション（20〜2000文字）
 *   - 1時間以内に5件超の通報でアカウントを一時停止（is_suspended = TRUE）
 *   - レート超過後は即時停止 → 以降の requireAuth で 403 を返す
 */

const express  = require('express');
const router   = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { pool } = require('../config/database');

router.use(requireAuth);

const VALID_CATEGORIES = ['scam', 'other'];
const MIN_DESC_LEN     = 20;
const MAX_DESC_LEN     = 2000;
const RATE_MAX         = 5;   // 1時間以内の通報上限

// ─── POST /api/report ──────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { category, description } = req.body;
    const reporterId = req.session.user.id;

    // カテゴリバリデーション（ホワイトリスト）
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({
        success: false,
        error: `category は次のいずれかを指定してください: ${VALID_CATEGORIES.join(', ')}`,
      });
    }

    // 説明バリデーション
    if (!description || typeof description !== 'string') {
      return res.status(400).json({ success: false, error: 'description is required' });
    }
    const desc = description.trim();
    if (desc.length < MIN_DESC_LEN) {
      return res.status(400).json({
        success: false,
        error: `説明は${MIN_DESC_LEN}文字以上入力してください（現在: ${desc.length}文字）`,
      });
    }
    if (desc.length > MAX_DESC_LEN) {
      return res.status(400).json({
        success: false,
        error: `説明は${MAX_DESC_LEN}文字以内にしてください`,
      });
    }

    // レート制限チェック（1時間以内の通報数）
    const rateResult = await pool.query(
      `SELECT COUNT(*) FROM reports
       WHERE reporter_id = $1
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [reporterId]
    );
    const recentCount = Number(rateResult.rows[0].count);

    if (recentCount >= RATE_MAX) {
      const adminUsername = (process.env.ADMIN_USERNAME || '').trim();
      if (req.session.user.username !== adminUsername) {
        // 上限超過: アカウントを一時停止
        await pool.query(
          'UPDATE users SET is_suspended = TRUE WHERE id = $1',
          [reporterId]
        );
        console.warn(`⚠️ 通報レート超過によりアカウント停止: user_id=${reporterId}`);
        return res.status(429).json({
          success: false,
          error: '短時間に大量の通報が検出されたため、アカウントを一時停止しました。',
        });
      }
    }

    // 通報を保存（パラメータ化クエリで SQL インジェクション対策）
    await pool.query(
      `INSERT INTO reports (reporter_id, category, description) VALUES ($1, $2, $3)`,
      [reporterId, category, desc]
    );

    console.log(`📣 通報受信: reporter_id=${reporterId} category=${category}`);
    return res.json({ success: true, message: '通報を受け付けました。ご協力ありがとうございます。' });
  } catch (err) {
    console.error('❌ report error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
