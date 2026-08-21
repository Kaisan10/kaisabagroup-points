'use strict';

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { pool } = require('../config/database');

// ─── GET /api/user ──────────────────────────────────────────────────────────
// ログイン中ユーザーの情報を返す
router.get('/user', async (req, res) => {
  if (!req.session.user || !req.session.user.id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const user = await User.findById(req.session.user.id);
    if (!user) {
      req.session.destroy?.();
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // セッションのユーザー情報を最新化（必要なフィールドのみ）
    req.session.user = {
      id: user.id,
      username: user.username,
      total_points: Number(user.total_points) || 0,
      email: user.email || '',
      avatar_url: user.avatar_url || '',
      is_suspended: user.is_suspended === true,
      is_admin: user.is_admin === true,
      ranking_opt_in: user.ranking_opt_in === true,
      trusted_auto_approve: user.trusted_auto_approve === true,
    };

    const responseUser = { ...req.session.user };
    delete responseUser.email;
    res.json(responseUser);
  } catch (err) {
    console.error('❌ /api/user エラー:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/points/history ────────────────────────────────────────────────
// ログイン中ユーザーのポイント履歴を返す
router.get('/points/history', async (req, res) => {
  if (!req.session.user || !req.session.user.id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const MAX_HISTORY_LIMIT = Number(process.env.MAX_HISTORY_LIMIT || 200);
  const raw = req.query.limit;
  const limit = raw === undefined ? 50 : Number(raw);

  if (!Number.isInteger(limit) || limit <= 0) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  if (limit > MAX_HISTORY_LIMIT) {
    return res.status(400).json({ error: `limit too large (max ${MAX_HISTORY_LIMIT})` });
  }

  try {
    const items = await User.getPointHistory(req.session.user.id, limit);
    const data = items.map(row => ({
      id: row.id,
      amount: Number(row.amount),
      transaction_type: row.transaction_type,
      description: row.description || '',
      created_at: row.created_at
    }));
    res.json({ items: data });
  } catch (err) {
    console.error('❌ /api/points/history エラー:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/points/check ──────────────────────────────────────────────────
// ユーザー名またはマイクラIDでポイント残高を確認する（認証不要）
router.get('/points/check', async (req, res) => {
  try {
    const { username, minecraft_id } = req.query;

    if (!username && !minecraft_id) {
      return res.status(400).json({
        success: false,
        error: 'username or minecraft_id required',
        message: 'フォーラムのユーザー名またはマイクラのユーザー名を指定してください'
      });
    }

    if (username && minecraft_id) {
      return res.status(400).json({
        success: false,
        error: 'Only one parameter allowed',
        message: '同時に指定できません'
      });
    }

    let query, params;

    if (username) {
      query = 'SELECT id, username, total_points, minecraft_id FROM users WHERE LOWER(username) = LOWER($1)';
      params = [username.trim()];
    } else {
      query = 'SELECT id, username, total_points, minecraft_id FROM users WHERE minecraft_id = $1';
      params = [minecraft_id.trim()];
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        error: 'User not found',
        message: 'ユーザーが見つかりません'
      });
    }

    const user = result.rows[0];
    res.json({
      success: true,
      data: {
        username: user.username,
        points: Number(user.total_points) || 0,
        minecraft_id: user.minecraft_id || null
      }
    });
  } catch (err) {
    console.error('❌ /api/points/check エラー:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'サーバーエラーが発生しました'
    });
  }
});

// ─── GET /api/ranking ───────────────────────────────────────────────────────
// ポイントランキングを返す
router.get('/ranking', async (req, res) => {
  try {
    const LIMIT_MAX = 100;
    const rawLimit  = parseInt(req.query.limit,  10);
    const rawOffset = parseInt(req.query.offset, 10);
    const limit  = Number.isFinite(rawLimit)  && rawLimit  > 0 ? Math.min(rawLimit, LIMIT_MAX) : 10;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    const [rows, total] = await Promise.all([
      User.getRanking(limit, offset),
      User.getRankingCount(),
    ]);

    const data = rows.map(u => ({
      rank: Number(u.rank),
      username: u.username,
      avatar_url: u.avatar_url || '',
      total_points: Number(u.total_points) || 0,
    }));

    res.json({ success: true, data, total });
  } catch (err) {
    console.error('❌ /api/ranking エラー:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
