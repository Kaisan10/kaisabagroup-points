const express = require('express');
const router = express.Router();
const User = require('../models/User');

// API認証ミドルウェア
function authenticateService(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!process.env.SERVICE_API_KEY) {
    console.error('❌ SERVICE_API_KEY is not set in environment variables');
    return res.status(500).json({
      success: false,
      error: 'Server configuration error'
    });
  }

  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(401).json({ success: false, error: 'API key required' });
  }

  try {
    const crypto = require('crypto');
    const a = Buffer.from(apiKey, 'utf8');
    const b = Buffer.from(process.env.SERVICE_API_KEY, 'utf8');
    
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.log('❌ Service API authentication failed');
      return res.status(401).json({
        success: false,
        error: 'Invalid API key'
      });
    }
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  next();
}

// ポイント確認API
router.get('/points/check', authenticateService, async (req, res) => {
  try {
    const { username } = req.query;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Username required',
        message: 'ユーザー名が必要です'
      });
    }

    // ユーザーを検索
    const user = await User.findByUsername(username);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
        message: 'ユーザーが見つかりません'
      });
    }

    res.json({
      success: true,
      data: {
        username: user.username,
        points: Number(user.total_points) || 0,
        minecraft_id: user.minecraft_id || null
      }
    });
  } catch (err) {
    console.error('❌ Service API Error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ユーザー情報取得API（マイクラIDまたはフォーラムユーザー名から検索）
router.get('/user/lookup', authenticateService, async (req, res) => {
  try {
    const { minecraft_id, username } = req.query;

    // どちらか一方は必須
    if (!minecraft_id && !username) {
      return res.status(400).json({
        success: false,
        error: 'minecraft_id or username required',
        message: 'マイクラIDまたはフォーラムのユーザー名のいずれかを指定してください'
      });
    }

    // 両方指定された場合はエラー
    if (minecraft_id && username) {
      return res.status(400).json({
        success: false,
        error: 'Only one parameter allowed',
        message: 'minecraft_idとusernameは同時に指定できません'
      });
    }

    let user;

    // マイクラIDで検索
    if (minecraft_id) {
      const { pool } = require('../config/database');
      const result = await pool.query(
        'SELECT id, username, total_points, minecraft_id FROM users WHERE minecraft_id = $1',
        [minecraft_id.trim()]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'User not found',
          message: 'このマイクラIDに紐づくユーザーが見つかりません'
        });
      }

      user = result.rows[0];
    }
    // フォーラムのユーザー名で検索
    else {
      user = await User.findByUsername(username);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found',
          message: 'このユーザー名のユーザーが見つかりません'
        });
      }
    }

    res.json({
      success: true,
      data: {
        username: user.username,
        minecraft_id: user.minecraft_id || null,
        points: Number(user.total_points) || 0
      }
    });
  } catch (err) {
    console.error('❌ Service API Error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});



module.exports = router;
