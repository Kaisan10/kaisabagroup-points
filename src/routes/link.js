const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const crypto = require('crypto');
const requireAuth = require('../middleware/requireAuth');

// トークン生成ヘルパー
function generateToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = '';
  for (let i = 0; i < 6; i++) {
    const randomIndex = crypto.randomInt(0, chars.length);
    token += chars.charAt(randomIndex);
  }
  return token;
}

// トークン発行
router.post('/generate', requireAuth, async (req, res) => {
  
  try {
    // 既存の未使用トークンを削除
    await pool.query(
      'DELETE FROM minecraft_link_tokens WHERE user_id = $1 AND used = FALSE',
      [req.session.user.id]
    );
    
    // 新しいトークンを生成（重複しないまで）
    let token;
    let exists = true;
    
    while (exists) {
      token = generateToken();
      const result = await pool.query(
        'SELECT id FROM minecraft_link_tokens WHERE token = $1',
        [token]
      );
      exists = result.rows.length > 0;
    }
    
    // トークンを保存（5分間有効）
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    
    await pool.query(
      `INSERT INTO minecraft_link_tokens (user_id, token, expires_at) 
       VALUES ($1, $2, $3)`,
      [req.session.user.id, token, expiresAt]
    );
    
    res.json({
      success: true,
      token: token,
      expires_in: 300 // 秒
    });
  } catch (err) {
    console.error('❌ トークン発行エラー:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 現在のリンク状態を取得
router.get('/status', requireAuth, async (req, res) => {
  
  try {
    const result = await pool.query(
      'SELECT minecraft_id FROM users WHERE id = $1',
      [req.session.user.id]
    );
    
    const minecraft_id = result.rows[0]?.minecraft_id;
    
    res.json({
      linked: !!minecraft_id,
      minecraft_id: minecraft_id || null
    });
  } catch (err) {
    console.error('❌ リンク状態取得エラー:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// リンク解除
router.post('/unlink', requireAuth, async (req, res) => {
  
  try {
    await pool.query(
      'UPDATE users SET minecraft_id = NULL WHERE id = $1',
      [req.session.user.id]
    );
    
    res.json({
      success: true,
      message: 'マイクラIDのリンクを解除しました'
    });
  } catch (err) {
    console.error('❌ リンク解除エラー:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;