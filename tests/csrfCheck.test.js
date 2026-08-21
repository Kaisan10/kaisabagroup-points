'use strict';

/**
 * tests/csrfCheck.test.js
 * globalOriginCheck ミドルウェアの単体テスト
 *
 * DB接続不要 — 純粋なロジックのみ
 */

const { globalOriginCheck } = require('../src/utils/csrfCheck');

// 環境変数をセット
const SITE_URL = 'https://points.example.com';
process.env.SITE_URL = SITE_URL;

/** Expressのreq/resを模倣するヘルパー */
function makeReq({ method = 'POST', path = '/test', headers = {} } = {}) {
  return {
    method,
    path,
    headers,
    get(name) {
      return this.headers[name.toLowerCase()] || null;
    },
  };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

describe('globalOriginCheck', () => {
  // ─── GET系はパス ────────────────────────────────────────────────
  test('GET リクエストはチェックなしでパスする', () => {
    const next = jest.fn();
    const req = makeReq({ method: 'GET' });
    globalOriginCheck(req, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('HEAD リクエストはチェックなしでパスする', () => {
    const next = jest.fn();
    globalOriginCheck(makeReq({ method: 'HEAD' }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ─── 正規Origin ─────────────────────────────────────────────────
  test('正規のOriginヘッダーがある POST はパスする', () => {
    const next = jest.fn();
    const req = makeReq({
      method: 'POST',
      headers: { origin: SITE_URL },
    });
    globalOriginCheck(req, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('正規のRefererヘッダーがある POST はパスする', () => {
    const next = jest.fn();
    const req = makeReq({
      method: 'POST',
      headers: { referer: `${SITE_URL}/dashboard` },
    });
    globalOriginCheck(req, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ─── 不正Origin ─────────────────────────────────────────────────
  test('異なるOriginの POST は 403 を返す', () => {
    const next = jest.fn();
    const res = makeRes();
    const req = makeReq({
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    });
    globalOriginCheck(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('CSRF Forbidden');
  });

  test('異なるOriginの DELETE は 403 を返す', () => {
    const next = jest.fn();
    const res = makeRes();
    const req = makeReq({
      method: 'DELETE',
      headers: { origin: 'https://attacker.com' },
    });
    globalOriginCheck(req, res, next);
    expect(res._status).toBe(403);
  });

  // ─── Origin/Referer なし ─────────────────────────────────────────
  test('Origin/Referer なしの POST は 403 を返す', () => {
    const next = jest.fn();
    const res = makeRes();
    const req = makeReq({ method: 'POST', headers: {} });
    globalOriginCheck(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  test('Origin/Referer なしの PATCH は 403 を返す', () => {
    const next = jest.fn();
    const res = makeRes();
    const req = makeReq({ method: 'PATCH', headers: {} });
    globalOriginCheck(req, res, next);
    expect(res._status).toBe(403);
  });

  // ─── APIキーがあるサーバー間通信 ─────────────────────────────────
  test('APIキーあり + APIパスの POST はOriginなしでもパスする', () => {
    const next = jest.fn();
    const req = makeReq({
      method: 'POST',
      path: '/api/server/buy',
      headers: { 'x-api-key': 'skp_testkey123456789' },
    });
    globalOriginCheck(req, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('APIキーあり + 異なるOriginでもAPIパスならパスする', () => {
    const next = jest.fn();
    const req = makeReq({
      method: 'POST',
      path: '/api/server/balance',
      headers: {
        'x-api-key': 'skp_testkey123456789',
        origin: 'https://minecraft.plugin.local',
      },
    });
    globalOriginCheck(req, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('APIキーありでも非APIパスの場合は 403 を返す', () => {
    const next = jest.fn();
    const res = makeRes();
    const req = makeReq({
      method: 'POST',
      path: '/some/page',
      headers: {
        'x-api-key': 'skp_testkey123456789',
        origin: 'https://evil.example.com',
      },
    });
    globalOriginCheck(req, res, next);
    expect(res._status).toBe(403);
  });

  test('Bearerトークンでも /api/server/ パスはパスする', () => {
    const next = jest.fn();
    const req = makeReq({
      method: 'POST',
      path: '/api/server/buy',
      headers: { authorization: 'Bearer skp_testkey123456789' },
    });
    globalOriginCheck(req, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ─── SITE_URL 未設定 ──────────────────────────────────────────────
  test('SITE_URL が空の場合は全リクエストをパスする', () => {
    const original = process.env.SITE_URL;
    process.env.SITE_URL = '';
    const next = jest.fn();
    globalOriginCheck(makeReq({ method: 'POST' }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    process.env.SITE_URL = original;
  });
});
