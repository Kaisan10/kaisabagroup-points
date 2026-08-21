'use strict';

/**
 * subscriptionApi.js — サブスクリプションAPI（サーバー/プラグイン向け）
 *
 * 認証: serverAuth（X-API-Key: skp_xxxxx）
 *
 * エンドポイント:
 *   POST   /api/server/subscription/initiate   サブスク登録開始
 *   POST   /api/server/subscription/:id/charge アプリによる課金実行（next_charge_at 到来後のみ）
 *   GET    /api/server/subscription            自サーバーのサブスク一覧
 *   GET    /api/server/subscription/:id        特定サブスクの状態確認（ポーリング用）
 *   DELETE /api/server/subscription/:id        サーバー側からキャンセル
 */

const express = require('express');
const router = express.Router();
const serverAuth = require('../middleware/serverAuth');
const Subscription = require('../models/Subscription');

// 全エンドポイントにサーバーAPIキー認証を適用
router.use(serverAuth);

function handleError(res, err) {
  const status  = err.statusCode || 500;
  const message = err.message    || 'Internal server error';
  if (status === 500) console.error('❌ subscriptionApi error:', err);
  return res.status(status).json({
    success: false,
    error:   message,
    ...(err.data ? { data: err.data } : {}),
  });
}

// ─── POST /api/server/subscription/initiate ──────────────────────────────
// サブスク登録を開始する（ユーザーのダッシュボードに承認待ち表示が出る）
//
// Body: { username: string, product_id: number, interval_days: number }
router.post('/initiate', async (req, res) => {
  try {
    const { username, product_id, interval_days } = req.body;

    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'username (string) required' });
    }

    const productIdNum = Number(product_id);
    if (!Number.isInteger(productIdNum) || productIdNum <= 0) {
      return res.status(400).json({ success: false, error: 'product_id (positive integer) required' });
    }

    const intervalNum = Number(interval_days);
    if (!Number.isInteger(intervalNum) || intervalNum <= 0) {
      return res.status(400).json({ success: false, error: 'interval_days (positive integer) required' });
    }

    const sub = await Subscription.initiate({
      serverId:     req.serverAccount.id,
      username:     username.trim(),
      productId:    productIdNum,
      intervalDays: intervalNum,
    });

    const siteUrl = process.env.SITE_URL || '';
    console.log(`📋 サブスク登録開始: sub_id=${sub.subscriptionId} user=${sub.username} amount=${sub.amount} interval=${sub.intervalDays}日`);

    return res.status(201).json({
      success: true,
      data: {
        subscription_id: sub.subscriptionId,
        username:        sub.username,
        product_name:    sub.productName,
        amount:          sub.amount,
        interval_days:   sub.intervalDays,
        status:          sub.status,
        message:         `${siteUrl}/dashboard からユーザーの承認を待っています`,
        web_url:         `${siteUrl}/dashboard`,
      }
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/server/subscription ────────────────────────────────────────
// 自サーバーのサブスク一覧を返す
router.get('/', async (req, res) => {
  try {
    const subs = await Subscription.listByServer(req.serverAccount.id);
    return res.json({ success: true, data: subs });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── GET /api/server/subscription/:id ────────────────────────────────────
// 特定サブスクの状態確認（ポーリング用）
router.get('/:id', async (req, res) => {
  try {
    const subId = parseInt(req.params.id, 10);
    if (!Number.isInteger(subId) || subId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid subscription id' });
    }

    const sub = await Subscription.findById(subId);
    if (!sub || sub.server_id !== req.serverAccount.id) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    return res.json({
      success: true,
      data: {
        id:             sub.id,
        username:       sub.username,
        product_name:   sub.product_name,
        amount:         sub.amount,
        interval_days:  sub.interval_days,
        next_charge_at: sub.next_charge_at,
        status:         sub.status,
        created_at:     sub.created_at,
      }
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── POST /api/server/subscription/:id/charge ────────────────────────────
// アプリが課金を要求する。next_charge_at が到来していないと 425 を返す（二重課金防止）。
// 残高不足の場合は 402 を返し、ステータスを suspended に変更する。
router.post('/:id/charge', async (req, res) => {
  try {
    const subId = parseInt(req.params.id, 10);
    if (!Number.isInteger(subId) || subId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid subscription id' });
    }

    const result = await Subscription.chargeByServer({
      subId,
      serverId: req.serverAccount.id,
    });

    return res.json({
      success: true,
      data: {
        status:         result.status,
        amount:         result.amount,
        next_charge_at: result.nextChargeAt,
      },
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// ─── DELETE /api/server/subscription/:id ─────────────────────────────────
// サーバー側からキャンセルする
router.delete('/:id', async (req, res) => {
  try {
    const subId = parseInt(req.params.id, 10);
    if (!Number.isInteger(subId) || subId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid subscription id' });
    }

    const result = await Subscription.cancelByServer({
      subId,
      serverId: req.serverAccount.id,
    });

    return res.json({ success: true, data: { id: result.id, status: result.status } });
  } catch (err) {
    return handleError(res, err);
  }
});

module.exports = router;
