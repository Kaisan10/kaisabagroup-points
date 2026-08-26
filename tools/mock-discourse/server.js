'use strict';

/**
 * Mock Discourse SSO プロバイダー（開発環境専用）
 *
 * 本物の Discourse と同じ DiscourseConnect プロトコルを実装します。
 * アプリ側から見ると本物と区別できません。
 *
 * 起動: node tools/mock-discourse/server.js
 * 必要な環境変数: DISCOURSE_SECRET（アプリの .env から自動読み込み）
 */

const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

// ── 環境変数の読み込み ───────────────────────────────────────────────────────
// このファイルは tools/mock-discourse/server.js にあるため、../../.env = プロジェクトルートの .env
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');
const app     = express();
app.use(express.urlencoded({ extended: true }));

const PORT   = parseInt(process.env.MOCK_DISCOURSE_PORT || '4002', 10);
const SECRET = process.env.DISCOURSE_SECRET;

if (!SECRET) {
  console.error('❌ DISCOURSE_SECRET が設定されていません（.env を確認してください）');
  process.exit(1);
}

// ── ユーザー定義の読み込み ────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users.json');
function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

// ── ユーティリティ ────────────────────────────────────────────────────────────
function hmac(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const idx = c.indexOf('=');
    if (idx < 0) return;
    const k = c.slice(0, idx).trim();
    const v = c.slice(idx + 1).trim();
    if (k) cookies[k] = v;
  });
  return cookies;
}

function setCookies(res, userIndex, autoLogin) {
  const maxAge = 60 * 60 * 24 * 30; // 30日
  const base   = `Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly`;
  res.setHeader('Set-Cookie', [
    `mock_last_user=${userIndex}; ${base}`,
    `mock_auto_login=${autoLogin ? '1' : '0'}; ${base}`
  ]);
}

function buildRedirectUrl(returnUrl, nonce, user) {
  const responseParams = new URLSearchParams({
    nonce,
    email:       user.email,
    external_id: String(user.external_id),
    username:    user.username,
    name:        user.name || user.username,
    avatar_url:  user.avatar_url || '',
    admin:       String(!!user.admin),
    moderator:   'false'
  });
  const payload = Buffer.from(responseParams.toString()).toString('base64');
  const sig     = hmac(payload);
  return `${returnUrl}?sso=${encodeURIComponent(payload)}&sig=${sig}`;
}

// ── UI HTML ──────────────────────────────────────────────────────────────────
function renderForm(users, sso, sig, currentUserIndex) {
  const userCards = users.map((u, i) => `
    <label class="user-card ${i === currentUserIndex ? 'active' : ''}">
      <input type="radio" name="user_index" value="${i}" ${i === currentUserIndex ? 'checked' : ''} required>
      <div class="user-details">
        <span class="name">${escapeHtml(u.username)}</span>
        <span class="meta">${escapeHtml(u.email)}${u.admin ? ' &nbsp;👑' : ''}</span>
      </div>
    </label>`).join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mock Discourse SSO</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1d27;
      border: 1px solid #2d3148;
      border-radius: 12px;
      padding: 32px;
      width: 100%;
      max-width: 420px;
    }
    .badge {
      display: inline-block;
      background: #f59e0b22;
      color: #f59e0b;
      border: 1px solid #f59e0b44;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1px;
      padding: 2px 8px;
      margin-bottom: 12px;
    }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
    .subtitle { font-size: 13px; color: #64748b; margin-bottom: 24px; }
    .user-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid #2d3148;
      border-radius: 8px;
      cursor: pointer;
      margin-bottom: 8px;
      transition: border-color 0.15s, background 0.15s;
    }
    .user-card:hover { border-color: #4f46e5; background: #1e2035; }
    .user-card.active { border-color: #4f46e5; background: #1e2035; }
    .user-card input[type="radio"] { accent-color: #4f46e5; width: 16px; height: 16px; flex-shrink: 0; }
    .user-details { display: flex; flex-direction: column; gap: 2px; }
    .name { font-weight: 600; font-size: 14px; }
    .meta { font-size: 12px; color: #64748b; }
    .auto-login-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 16px 0;
      font-size: 13px;
      color: #94a3b8;
      cursor: pointer;
    }
    .auto-login-row input { accent-color: #4f46e5; width: 15px; height: 15px; cursor: pointer; }
    button {
      width: 100%;
      padding: 11px;
      background: #4f46e5;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #4338ca; }
    .reset-link {
      display: block;
      text-align: center;
      margin-top: 14px;
      font-size: 12px;
      color: #475569;
      text-decoration: none;
    }
    .reset-link:hover { color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">DEV ONLY</div>
    <h1>Mock Discourse SSO</h1>
    <p class="subtitle">開発環境専用の認証モック。本番には影響しません。</p>
    <form method="POST" action="/session/sso_provider">
      <input type="hidden" name="sso" value="${escapeHtml(sso)}">
      <input type="hidden" name="sig" value="${escapeHtml(sig)}">
      ${userCards}
      <label class="auto-login-row">
        <input type="checkbox" name="auto_login" value="1">
        次回から自動ログイン（選択をスキップ）
      </label>
      <button type="submit">このユーザーでログイン</button>
    </form>
    <a class="reset-link" href="/reset">⚙ 自動ログインをリセット</a>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── ルート ───────────────────────────────────────────────────────────────────

// GET /session/sso_provider  ← アプリがリダイレクトしてくる
app.get('/session/sso_provider', (req, res) => {
  const { sso, sig } = req.query;

  if (!sso || !sig) {
    return res.status(400).send('sso / sig パラメータが必要です');
  }

  // 署名検証（timing-safe 比較）
  const expectedBuf = Buffer.from(hmac(sso));
  const actualBuf   = Buffer.from(String(sig));
  if (expectedBuf.length !== actualBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return res.status(403).send('署名が不正です（DISCOURSE_SECRET を確認してください）');
  }

  const decoded   = Buffer.from(sso, 'base64').toString('utf8');
  const params    = new URLSearchParams(decoded);
  const nonce     = params.get('nonce');
  const returnUrl = params.get('return_sso_url');

  if (!nonce || !returnUrl) {
    return res.status(400).send('nonce または return_sso_url が見つかりません');
  }

  const cookies       = parseCookies(req);
  const autoLogin     = cookies['mock_auto_login'] === '1';
  const lastUserIndex = cookies['mock_last_user'] !== undefined
    ? parseInt(cookies['mock_last_user'], 10)
    : -1;

  const users = loadUsers();

  // auto-login が有効かつ有効なユーザーが記憶されていれば即リダイレクト
  if (autoLogin && lastUserIndex >= 0 && lastUserIndex < users.length) {
    const user = users[lastUserIndex];
    setCookies(res, lastUserIndex, true);
    return res.redirect(buildRedirectUrl(returnUrl, nonce, user));
  }

  // フォームを表示
  res.send(renderForm(users, sso, sig, lastUserIndex));
});

// POST /session/sso_provider  ← フォーム送信
app.post('/session/sso_provider', (req, res) => {
  const { sso, sig, user_index, auto_login } = req.body;

  if (!sso || !sig) {
    return res.status(400).send('sso / sig が見つかりません');
  }

  // 署名検証（timing-safe 比較）
  const expectedBuf = Buffer.from(hmac(sso));
  const actualBuf   = Buffer.from(String(sig));
  if (expectedBuf.length !== actualBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return res.status(403).send('署名が不正です');
  }

  const decoded   = Buffer.from(sso, 'base64').toString('utf8');
  const params    = new URLSearchParams(decoded);
  const nonce     = params.get('nonce');
  const returnUrl = params.get('return_sso_url');

  if (!nonce || !returnUrl) {
    return res.status(400).send('nonce または return_sso_url が見つかりません');
  }

  const users     = loadUsers();
  const userIndex = parseInt(user_index, 10);
  const user      = users[userIndex];

  if (!user) {
    return res.status(400).send('ユーザーが選択されていません');
  }

  const wantsAutoLogin = auto_login === '1';
  setCookies(res, userIndex, wantsAutoLogin);

  res.redirect(buildRedirectUrl(returnUrl, nonce, user));
});

// GET /reset  ← 自動ログインリセット
app.get('/reset', (req, res) => {
  const expired = 'Path=/; Max-Age=0; SameSite=Lax; HttpOnly';
  res.setHeader('Set-Cookie', [
    `mock_last_user=; ${expired}`,
    `mock_auto_login=0; ${expired}`
  ]);
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>リセット完了</title>
  <style>
    body { font-family: sans-serif; background: #0f1117; color: #e2e8f0;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1d27; border: 1px solid #2d3148; border-radius: 12px; padding: 32px; text-align: center; }
    p { color: #64748b; margin-top: 8px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>✅ 自動ログインをリセットしました</h2>
    <p>次回のログイン時はユーザー選択画面が表示されます。</p>
  </div>
</body>
</html>`);
});

// ── 起動 ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const host = process.env.MOCK_DISCOURSE_HOST || 'localhost';
  console.log(`🎭 Mock Discourse SSO 起動中 → http://${host}:${PORT}`);
  console.log(`   /reset にアクセスすると自動ログインをリセットできます`);
  const users = loadUsers();
  users.forEach((u, i) => {
    console.log(`   [${i}] ${u.username} (${u.email})${u.admin ? ' 👑' : ''}`);
  });
});
