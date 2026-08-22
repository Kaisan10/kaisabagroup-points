'use strict';

/**
 * tests/discourse.test.js
 * discourse ユーティリティの単体テスト
 *
 * DB接続不要 — 純粋なロジックのみ（crypto モジュール使用）
 * テスト対象:
 *   - generateSignature / verifySignature: HMAC-SHA256 署名の生成と検証
 *   - generateLoginUrl: URL構築、nonce生成、パラメータエンコード
 *   - parseDiscourseResponse: Base64デコード、署名検証、必須フィールドチェック
 */

const { generateLoginUrl, parseDiscourseResponse, verifySignature } = require('../src/utils/discourse');

// 環境変数のモック
const ORIGINAL_SECRET = process.env.DISCOURSE_SECRET;
const ORIGINAL_URL = process.env.DISCOURSE_URL;

beforeAll(() => {
  process.env.DISCOURSE_SECRET = 'test_secret_key_12345';
  process.env.DISCOURSE_URL = 'https://forum.example.com';
});

afterAll(() => {
  process.env.DISCOURSE_SECRET = ORIGINAL_SECRET;
  process.env.DISCOURSE_URL = ORIGINAL_URL;
});

describe('verifySignature (および内部の generateSignature)', () => {
  test('正しい署名は検証に成功する', () => {
    const payload = 'some_base64_encoded_payload';
    const secret = 'my_secret';
    // crypto.createHmac('sha256', secret).update(payload).digest('hex')
    const crypto = require('crypto');
    const validSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    expect(verifySignature(payload, validSignature, secret)).toBe(true);
  });

  test('間違った署名は検証に失敗する', () => {
    const payload = 'some_payload';
    const secret = 'my_secret';
    expect(verifySignature(payload, 'wrong_signature', secret)).toBe(false);
  });

  test('署名が空の場合は失敗する', () => {
    expect(verifySignature('payload', '', 'secret')).toBe(false);
    expect(verifySignature('payload', null, 'secret')).toBe(false);
    expect(verifySignature('payload', undefined, 'secret')).toBe(false);
  });

  test('シークレットが違うと検証に失敗する', () => {
    const payload = 'some_payload';
    const crypto = require('crypto');
    const signature = crypto.createHmac('sha256', 'secret_A').update(payload).digest('hex');

    expect(verifySignature(payload, signature, 'secret_B')).toBe(false);
  });
});

describe('generateLoginUrl', () => {
  test('正しいフォーマットのURLとnonceを生成する', () => {
    const returnUrl = 'https://myapp.example.com/auth/callback';
    const result = generateLoginUrl(returnUrl);

    expect(result.nonce).toHaveLength(32); // 16bytes hex
    expect(result.url).toMatch(/^https:\/\/forum\.example\.com\/session\/sso_provider\?sso=.*&sig=.*$/);

    // URLからssoとsigを取り出して検証
    const urlObj = new URL(result.url);
    const ssoParam = urlObj.searchParams.get('sso');
    const sigParam = urlObj.searchParams.get('sig');

    expect(ssoParam).toBeTruthy();
    expect(sigParam).toBeTruthy();

    // 署名が正しいか検証
    expect(verifySignature(ssoParam, sigParam, process.env.DISCOURSE_SECRET)).toBe(true);

    // ssoパラメータの中身をデコードして確認
    const decoded = Buffer.from(ssoParam, 'base64').toString('utf8');
    const params = new URLSearchParams(decoded);
    expect(params.get('nonce')).toBe(result.nonce);
    expect(params.get('return_sso_url')).toBe(returnUrl);
  });
});

describe('parseDiscourseResponse', () => {
  // テスト用の有効なレスポンスを生成するヘルパー
  const createValidResponse = (overrides = {}) => {
    const params = new URLSearchParams({
      nonce: 'test_nonce_123',
      email: 'user@example.com',
      external_id: '12345',
      username: 'testuser',
      name: 'Test User',
      avatar_url: 'https://example.com/avatar.png',
      admin: 'false',
      moderator: 'false',
      ...overrides
    });
    const sso = Buffer.from(params.toString()).toString('base64');
    const crypto = require('crypto');
    const sig = crypto.createHmac('sha256', process.env.DISCOURSE_SECRET).update(sso).digest('hex');
    return { sso, sig };
  };

  test('有効な署名とペイロードで正しくユーザー情報をパースする', () => {
    const { sso, sig } = createValidResponse();
    const user = parseDiscourseResponse(sso, sig);

    expect(user).toMatchObject({
      nonce: 'test_nonce_123',
      email: 'user@example.com',
      external_id: '12345',
      username: 'testuser',
      name: 'Test User',
      avatar_url: 'https://example.com/avatar.png',
      admin: false,
      moderator: false
    });
  });

  test('adminとmoderatorの文字列"true"をbooleanに変換する', () => {
    const { sso, sig } = createValidResponse({ admin: 'true', moderator: 'true' });
    const user = parseDiscourseResponse(sso, sig);

    expect(user.admin).toBe(true);
    expect(user.moderator).toBe(true);
  });

  test('署名が不正な場合はエラーをスローする', () => {
    const { sso } = createValidResponse();
    expect(() => {
      parseDiscourseResponse(sso, 'invalid_signature');
    }).toThrow('Invalid signature');
  });

  test('必須フィールド(external_id)が欠落している場合はエラーをスローする', () => {
    const { sso, sig } = createValidResponse({ external_id: '' });
    expect(() => {
      parseDiscourseResponse(sso, sig);
    }).toThrow('Missing required fields');
  });

  test('必須フィールド(email)が欠落している場合はエラーをスローする', () => {
    const { sso, sig } = createValidResponse({ email: '' });
    expect(() => {
      parseDiscourseResponse(sso, sig);
    }).toThrow('Missing required fields');
  });

  test('必須フィールド(username)が欠落している場合はエラーをスローする', () => {
    const { sso, sig } = createValidResponse({ username: '' });
    expect(() => {
      parseDiscourseResponse(sso, sig);
    }).toThrow('Missing required fields');
  });
});
