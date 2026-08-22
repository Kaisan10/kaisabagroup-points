'use strict';

/**
 * tests/server.boot.test.js
 * 
 * サーバー起動および主要ルートのE2Eテスト
 * （テスト用データベース kaisaba_points_test を使用）
 */

// テスト環境変数のセットアップ
process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'kaisaba_points_test';
process.env.SITE_URL = 'http://localhost';

const request = require('supertest');
const { app, initDatabase } = require('../server');
const { pool } = require('../src/config/database');

describe('Server Boot & E2E Tests', () => {
  beforeAll(async () => {
    // テーブル作成などを実行
    await initDatabase();
  });

  afterAll(async () => {
    // DB接続プールを閉じてテストをクリーンに終了する
    await pool.end();
  });

  describe('基本ルートのレスポンス確認', () => {
    test('トップページ (/) にアクセスするとリダイレクト（302）される', async () => {
      // トップページはログイン状態によって /dashboard または /auth/discourse/login へリダイレクトされる設計
      const response = await request(app).get('/');
      expect(response.status).toBe(302);
    });

    test('ログインページ (/login) へのアクセス（※手動ログアウト時の動作）', async () => {
      const response = await request(app).get('/?manual=1');
      expect(response.status).toBe(200);
      expect(response.text).toContain('ログイン'); // EJSの出力にログインが含まれるか
    });

    test('存在しないページへのアクセスで404が返る', async () => {
      const response = await request(app).get('/this-path-does-not-exist');
      expect(response.status).toBe(404);
    });
  });

  describe('APIの動作確認（認証エラーなどを含む）', () => {
    test('/api/server/register にAPIキーなしでアクセスすると 401 Error', async () => {
      // serverRegisterRoutes の保護確認
      const response = await request(app)
        .post('/api/server/register')
        .set('Origin', 'http://localhost');
      // ※現在の実装ではプラグインAPIキー必須、あるいはAdminトークン必須
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('success', false);
    });

    test('/api/minecraft/link にトークンなしでアクセスすると 401 Error', async () => {
      const response = await request(app)
        .post('/api/minecraft/link')
        .set('Origin', 'http://localhost');
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body.error).toBe('API key required'); // minecraftRoutes の authenticateAPI エラー
    });
  });
});
