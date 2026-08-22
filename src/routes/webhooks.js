const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');


const webhookSecret = process.env.WEBHOOK_SECRET || null;

function getRawBody(req) {
  // server.js で express.raw を適用すると Buffer が入る
  if (Buffer.isBuffer(req.body)) return req.body;
  // フォールバック: オブジェクトなら安定化のため元文字列化
  try {
    return Buffer.from(JSON.stringify(req.body || {}), 'utf8');
  } catch {
    return Buffer.from('', 'utf8');
  }
}

// 署名検証の共通関数
function verifySignature(req) {
  if (!webhookSecret) {
    console.warn('⚠️ WEBHOOK_SECRET not set - rejecting webhook');
    return false;
  }

  const signature = req.get('x-discourse-event-signature') || '';
  
  if (!signature) {
    console.warn('⚠️ webhook rejected: missing signature');
    return false;
  }

  const raw = getRawBody(req);
  const hmac = crypto.createHmac('sha256', webhookSecret);
  hmac.update(raw);
  const calculatedSignature = 'sha256=' + hmac.digest('hex');

  const signatureBuffer = Buffer.from(signature);
  const calculatedBuffer = Buffer.from(calculatedSignature);

  if (signatureBuffer.length !== calculatedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, calculatedBuffer)) {
    console.warn(`⚠️ webhook rejected: signature mismatch`);
    return false;
  }

  console.log('✅ Signature verified');
  return true;
}

// トピック作成のポイント付与
router.post('/discourse/topic-created', async (req, res) => {
  try {
    // pingイベントの処理
    const eventType = req.get('x-discourse-event-type') || req.get('x-discourse-event');
    if (eventType === 'ping') {
      console.log('✅ Ping event received');
      return res.status(200).json({ success: true });
    }

    // 署名検証
    if (!verifySignature(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const raw = getRawBody(req);
    let bodyJson;
    try { bodyJson = JSON.parse(raw.toString('utf8') || '{}'); } catch { bodyJson = {}; }
    console.log('📥 Topic created webhook body:', JSON.stringify(bodyJson));

    const topic = bodyJson.topic;
    if (!topic) {
      console.warn('⚠️ webhook: topic フィールドがありません');
      return res.status(400).json({ error: 'Invalid payload: missing topic' });
    }

    const rawUsername =
      topic.created_by?.username ||
      topic.author_username ||
      bodyJson.username ||
      '';

    const username = String(rawUsername).trim();
    console.log('ℹ️ Topic created by:', username);

    if (!username) {
      return res.status(400).json({ error: 'Invalid payload: missing username' });
    }

    const user = await User.findByUsername(username);
    if (!user) {
      console.log(`❌ ユーザーが見つかりません: ${username}`);
      return res.status(404).json({ error: 'User not found' });
    }

    // 今日既にポイントを獲得しているか確認し、無ければ付与（アトミック）
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await User.addPointsIfUnique({
      userId: user.id,
      amount: 10,
      transactionType: 'topic_created',
      description: 'フォーラムで新しいトピックを作成',
      since: today
    });

    if (!result.success) {
      console.log(`ℹ️ ${username}は今日既にトピック作成ポイントを獲得しています`);
      return res.status(200).json({ message: result.message });
    }

    console.log(`✅ 10ポイント awarded to ${username} (user id ${user.id})`);
    res.status(200).json({ message: 'Points awarded successfully' });
  } catch (err) {
    console.error('❌ Topic created webhookエラー:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 投稿作成のポイント付与（返信のみ）
router.post('/discourse/post-created', async (req, res) => {
  try {
    // pingイベントの処理
    const eventType = req.get('x-discourse-event-type') || req.get('x-discourse-event');
    if (eventType === 'ping') {
      console.log('✅ Ping event received');
      return res.status(200).json({ success: true });
    }

    // 署名検証
    if (!verifySignature(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const raw = getRawBody(req);
    let bodyJson;
    try { bodyJson = JSON.parse(raw.toString('utf8') || '{}'); } catch { bodyJson = {}; }
    console.log('📥 Post created webhook body:', JSON.stringify(bodyJson));

    const post = bodyJson.post;
    if (!post) {
      console.warn('⚠️ webhook: post フィールドがありません');
      return res.status(400).json({ error: 'Invalid payload: missing post' });
    }

    // post_number が 1 の場合はトピック作成なのでスキップ
    if (post.post_number === 1) {
      console.log('ℹ️ これはトピック作成投稿なのでスキップします');
      return res.status(200).json({ message: 'Skipped: topic creation post' });
    }

    const rawUsername = post.username || '';
    const username = String(rawUsername).trim();
    console.log('ℹ️ Post created by:', username);

    if (!username) {
      return res.status(400).json({ error: 'Invalid payload: missing username' });
    }

    const user = await User.findByUsername(username);
    if (!user) {
      console.log(`❌ ユーザーが見つかりません: ${username}`);
      return res.status(404).json({ error: 'User not found' });
    }

    // 3時間以内に返信ポイントを獲得しているか確認し、無ければ付与（アトミック）
    const threeHoursAgo = new Date();
    threeHoursAgo.setHours(threeHoursAgo.getHours() - 3);

    const result = await User.addPointsIfUnique({
      userId: user.id,
      amount: 5,
      transactionType: 'post_reply',
      description: 'フォーラムでトピックに返信',
      since: threeHoursAgo
    });

    if (!result.success) {
      console.log(`ℹ️ ${username}は3時間以内に既に返信ポイントを獲得しています`);
      return res.status(200).json({ message: result.message });
    }

    console.log(`✅ 5ポイント awarded to ${username} (user id ${user.id})`);
    res.status(200).json({ message: 'Points awarded successfully' });
  } catch (err) {
    console.error('❌ Post created webhookエラー:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;