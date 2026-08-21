const express = require('express');
const router = express.Router();
const User = require('../models/User');
const crypto = require('crypto');
const { pool } = require('../config/database');

// トークン生成ヘルパー
function generateToken() {
  // 6文字のランダムなトークン（数字と大文字）
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 似た文字を除外
  let token = '';
  for (let i = 0; i < 6; i++) {
    const randomIndex = crypto.randomInt(0, chars.length);
    token += chars.charAt(randomIndex);
  }
  return token;
}

// API認証ミドルウェア（簡易版）
function authenticateAPI(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!process.env.MINECRAFT_API_KEY) {
    console.error('❌ MINECRAFT_API_KEY is not set in environment variables');
    return res.status(500).json({ success: false, error: 'Server configuration error' });
  }

  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(401).json({ success: false, error: 'API key required' });
  }

  try {
    const a = Buffer.from(apiKey, 'utf8');
    const b = Buffer.from(process.env.MINECRAFT_API_KEY, 'utf8');
    
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.log('❌ Minecraft API authentication failed');
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  
  console.log('✅ API認証成功');
  next();
}

// ─── GET /api/minecraft/points ──────────────────────────────────────────────
// ユーザーをユーザー名で検索しポイントを取得する（統合エンドポイント）
//
// Query:
//   ?username=<discourse_username>   Discourseユーザー名で検索
//   ?mc_id=<minecraft_id>            マイクラIDで検索
//
// いずれか1つを必ず指定する。
router.get('/points', authenticateAPI, async (req, res) => {
  const { username, mc_id } = req.query;

  if (!username && !mc_id) {
    return res.status(400).json({ success: false, error: 'username or mc_id query param required' });
  }
  if (username && mc_id) {
    return res.status(400).json({ success: false, error: 'Specify only one of username or mc_id' });
  }

  try {
    let result;
    if (username) {
      result = await pool.query(
        'SELECT id, username, total_points, minecraft_id FROM users WHERE LOWER(username) = LOWER($1)',
        [String(username).trim()]
      );
    } else {
      result = await pool.query(
        'SELECT id, username, total_points, minecraft_id FROM users WHERE minecraft_id = $1',
        [String(mc_id).trim()]
      );
    }

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        error: 'User not found',
        message: 'このユーザーは登録されていません'
      });
    }

    const user = result.rows[0];
    res.json({
      success: true,
      data: {
        username: user.username,
        points: user.total_points,
        minecraft_id: user.minecraft_id
      }
    });
  } catch (err) {
    console.error('❌ ポイント取得エラー:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// ユーザー名でポイントを取得
// @deprecated GET /api/minecraft/points?username=<username> を使用してください
router.get('/points/:username', authenticateAPI, async (req, res) => {
  try {
    const { username } = req.params;
    
    const result = await pool.query(
      'SELECT id, username, total_points, minecraft_id FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.json({
        success: false,
        error: 'User not found',
        message: 'このユーザーはポイントシステムに登録されていません'
      });
    }
    
    const user = result.rows[0];
    res.json({
      success: true,
      data: {
        username: user.username,
        points: user.total_points,
        minecraft_id: user.minecraft_id
      }
    });
  } catch (err) {
    console.error('❌ ポイント取得エラー:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// マイクラIDでポイントを取得
// @deprecated GET /api/minecraft/points?mc_id=<minecraft_id> を使用してください
router.get('/points/mc/:minecraft_id', authenticateAPI, async (req, res) => {
  try {
    const { minecraft_id } = req.params;
    
    const result = await pool.query(
      'SELECT id, username, total_points, minecraft_id FROM users WHERE minecraft_id = $1',
      [minecraft_id]
    );
    
    if (result.rows.length === 0) {
      return res.json({
        success: false,
        error: 'User not found',
        message: 'このマイクラIDは登録されていません'
      });
    }
    
    const user = result.rows[0];
    res.json({
      success: true,
      data: {
        username: user.username,
        points: user.total_points,
        minecraft_id: user.minecraft_id
      }
    });
  } catch (err) {
    console.error('❌ ポイント取得エラー:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});



// マイクラIDを登録
router.post('/link', authenticateAPI, async (req, res) => {
  try {
    console.log('📥 /link リクエスト受信:', req.body);
    
    const { token, minecraft_username } = req.body;
    
    console.log('  token:', token);
    console.log('  minecraft_username:', minecraft_username);
    
    if (!token || !minecraft_username) {
      console.log('❌ 必須パラメータが不足');
      return res.status(400).json({
        success: false,
        error: 'Token and minecraft_username required'
      });
    }

    // マイクラIDの形式バリデーション（2～16文字の英数字、アンダースコア、ピリオド）
    // XSS対策も兼ねる
    const mcIdRegex = /^[a-zA-Z0-9_.]{2,16}$/;
    if (!mcIdRegex.test(minecraft_username)) {
      console.log(`❌ 不正なマイクラID形式: ${minecraft_username}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid Minecraft ID format',
        message: 'マイクラIDの形式が不正です（2～16文字の英数字とアンダースコア、ピリオドのみ）'
      });
    }
    
    
    
    // トークンを検証
    const tokenResult = await pool.query(
      `SELECT user_id, expires_at, used 
       FROM minecraft_link_tokens 
       WHERE token = $1`,
      [token.toUpperCase()]
    );
    
    if (tokenResult.rows.length === 0) {
      return res.json({
        success: false,
        error: 'Invalid token',
        message: 'トークンが無効です'
      });
    }
    
    const tokenData = tokenResult.rows[0];
    
    // 使用済みチェック
    if (tokenData.used) {
      return res.json({
        success: false,
        error: 'Token already used',
        message: 'このトークンは既に使用されています'
      });
    }
    
    // 期限チェック
    if (new Date() > new Date(tokenData.expires_at)) {
      return res.json({
        success: false,
        error: 'Token expired',
        message: 'トークンの有効期限が切れています'
      });
    }
    
    // マイクラIDが既に使用されていないかチェック
    const existingUser = await pool.query(
      'SELECT username FROM users WHERE minecraft_id = $1',
      [minecraft_username]
    );
    
    if (existingUser.rows.length > 0) {
      return res.json({
        success: false,
        error: 'Minecraft ID already linked',
        message: `このマイクラIDは既に${existingUser.rows[0].username}にリンクされています`
      });
    }
    
    // マイクラIDを更新
    await pool.query(
      'UPDATE users SET minecraft_id = $1 WHERE id = $2',
      [minecraft_username, tokenData.user_id]
    );
    
    // トークンを使用済みにする
    await pool.query(
      'UPDATE minecraft_link_tokens SET used = TRUE, minecraft_username = $1 WHERE token = $2',
      [minecraft_username, token.toUpperCase()]
    );
    
    // ユーザー情報取得
    const userResult = await pool.query(
      'SELECT username FROM users WHERE id = $1',
      [tokenData.user_id]
    );
    
    const username = userResult.rows[0].username;
    
    res.json({
      success: true,
      message: `${minecraft_username}を${username}のアカウントにリンクしました！`,
      data: {
        username: username,
        minecraft_id: minecraft_username
      }
    });
  } catch (err) {
    console.error('❌ マイクラID登録エラー:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

module.exports = router;