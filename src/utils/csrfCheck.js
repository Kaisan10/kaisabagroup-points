'use strict';

/**
 * csrfCheck.js — グローバルCSRFオリジンチェック
 *
 * server.js の globalOriginCheck ミドルウェアを切り出したもの。
 * 独立した関数として定義することで単体テストが可能。
 */

/**
 * 状態変更系リクエストにOrigin/Refererチェックを行うExpressミドルウェア。
 * GETはパス、APIキーを持つサーバー間通信は許可。
 */
function globalOriginCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  try {
    const siteUrl = process.env.SITE_URL || '';
    if (!siteUrl) return next();

    const site = new URL(siteUrl);
    const origin = req.get('origin') || '';
    const referer = req.get('referer') || '';
    const checkUrl = origin || referer;

    const isApiPath = req.path.startsWith('/api/server/') || req.path.startsWith('/api/minecraft/')
      || req.path.startsWith('/api/services/') || req.path.startsWith('/api/oauth/');
    const hasApiKey = req.get('x-api-key') || req.get('api-key')
      || (req.headers.authorization && req.headers.authorization.startsWith('Bearer '));

    if (!checkUrl) {
      if (hasApiKey && isApiPath) {
        return next();
      }
      if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        console.warn(`⚠️ CSRF Blocked: Missing Origin/Referer for state-changing ${req.method} ${req.path}`);
        return res.status(403).json({ error: 'Origin or Referer header required for state-changing requests' });
      }
      console.log(`ℹ️ No Origin/Referer for ${req.method} ${req.path} (likely non-browser request)`);
      return next();
    }

    const u = new URL(checkUrl);
    if (u.hostname !== site.hostname) {
      if (hasApiKey && isApiPath) {
        return next();
      }
      console.warn(`🛡️ CSRF Blocked: ${u.hostname} !== ${site.hostname} (${req.method} ${req.path})`);
      return res.status(403).json({ error: 'CSRF Forbidden' });
    }
    return next();
  } catch (_) {
    return res.status(403).json({ error: 'CSRF Forbidden' });
  }
}

module.exports = { globalOriginCheck };
