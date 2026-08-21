const crypto = require('crypto');

// HMAC-SHA256で署名を生成
function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

// 署名を検証
function verifySignature(payload, signature, secret) {
  const expectedSignature = generateSignature(payload, secret);
  const a = Buffer.from(signature || '', 'hex');
  const b = Buffer.from(expectedSignature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// DiscourseConnectプロバイダーへのログインURLを生成
function generateLoginUrl(returnUrl) {
  const nonce = crypto.randomBytes(16).toString('hex');
  
  // パラメータを構築
  const params = new URLSearchParams({
    nonce: nonce,
    return_sso_url: returnUrl
  });
  
  const payload = Buffer.from(params.toString()).toString('base64');
  const signature = generateSignature(payload, process.env.DISCOURSE_SECRET);
  
  // DiscourseのSSO Providerエンドポイント
  const url = `${process.env.DISCOURSE_URL}/session/sso_provider?sso=${encodeURIComponent(payload)}&sig=${signature}`;
  
  return {
    url,
    nonce
  };
}

// Discourseからのレスポンスをパース
function parseDiscourseResponse(sso, sig) {
  // 署名検証
  if (!verifySignature(sso, sig, process.env.DISCOURSE_SECRET)) {
    throw new Error('Invalid signature - 署名が不正です');
  }

  // Base64デコード
  const decoded = Buffer.from(sso, 'base64').toString('utf8');
  
  // パラメータをパース
  const params = new URLSearchParams(decoded);
  
  const userData = {
    nonce: params.get('nonce'),
    email: params.get('email'),
    external_id: params.get('external_id'), // Discourse user ID
    username: params.get('username'),
    name: params.get('name'),
    avatar_url: params.get('avatar_url'),
    admin: params.get('admin') === 'true',
    moderator: params.get('moderator') === 'true'
  };
  
  // 必須フィールドのチェック
  if (!userData.external_id || !userData.email || !userData.username) {
    throw new Error('Missing required fields from Discourse');
  }

  return userData;
}

module.exports = {
  generateLoginUrl,
  parseDiscourseResponse,
  verifySignature
};