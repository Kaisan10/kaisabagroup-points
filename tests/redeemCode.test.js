'use strict';

/**
 * tests/redeemCode.test.js
 * RedeemCode.validateCode / RedeemCode.redeemCode の単体テスト
 *
 * DB接続はモック化。YAMLファイルの読み込みもモック化する。
 * テスト対象: コード引き換えによるポイント付与・二重使用防止・ROLLBACK保証
 */

// fs モジュールをモック化してYAMLファイル読み込みを制御
jest.mock('fs');
jest.mock('../src/config/database', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return {
    pool: {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn(),
    },
    _mockClient: mockClient,
  };
});

const fs = require('fs');
const { pool, _mockClient: client } = require('../src/config/database');
const RedeemCode = require('../src/models/RedeemCode');

// テスト用のコード定義（YAMLの代わり）
const VALID_YAML = `
codes:
  - code: TESTCODE2025
    active: true
    points: 500
    description: テスト用コード
  - code: INACTIVE_CODE
    active: false
    points: 100
    description: 無効なコード
`;

beforeEach(() => {
  jest.clearAllMocks();
  fs.readFileSync.mockReturnValue(VALID_YAML);
});

// ──────────────────────────────────────────────────────────────
// RedeemCode.validateCode
// ──────────────────────────────────────────────────────────────
describe('RedeemCode.validateCode', () => {
  test('有効なコードは valid:true と正しいポイント数を返す', async () => {
    const result = await RedeemCode.validateCode('TESTCODE2025');
    expect(result).toMatchObject({
      valid: true,
      code: 'TESTCODE2025',
      points: 500,
    });
  });

  test('小文字でも正規化されて照合される', async () => {
    const result = await RedeemCode.validateCode('testcode2025');
    expect(result.valid).toBe(true);
    expect(result.code).toBe('TESTCODE2025');
  });

  test('前後のスペースが除去されて照合される', async () => {
    const result = await RedeemCode.validateCode('  TESTCODE2025  ');
    expect(result.valid).toBe(true);
  });

  test('存在しないコードは valid:false を返す', async () => {
    const result = await RedeemCode.validateCode('NONEXISTENT');
    expect(result).toMatchObject({ valid: false });
    expect(result.error).toBeTruthy();
  });

  test('active:false のコードは valid:false を返す', async () => {
    const result = await RedeemCode.validateCode('INACTIVE_CODE');
    expect(result).toMatchObject({ valid: false });
    expect(result.error).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────
// RedeemCode.redeemCode
// ──────────────────────────────────────────────────────────────
describe('RedeemCode.redeemCode', () => {
  // ─── 正常系 ────────────────────────────────────────────────
  test('有効なコードを初めて使用するとポイントが付与されて success:true を返す', async () => {
    client.query
      .mockResolvedValueOnce(undefined)  // BEGIN
      .mockResolvedValueOnce(undefined)  // INSERT redeem_code_uses
      .mockResolvedValueOnce(undefined)  // UPDATE users (ポイント付与)
      .mockResolvedValueOnce(undefined)  // INSERT point_transactions
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await RedeemCode.redeemCode(1, 'TESTCODE2025');

    expect(result).toMatchObject({
      success: true,
      code: 'TESTCODE2025',
      points: 500,
    });
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  // ─── 二重使用防止 ───────────────────────────────────────────
  test('同じコードを2回使用すると success:false を返す（一意制約違反）', async () => {
    // PostgreSQL の一意制約違反 (code: 23505)
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    client.query
      .mockResolvedValueOnce(undefined)          // BEGIN
      .mockRejectedValueOnce(uniqueViolation);   // INSERT redeem_code_uses → 制約違反

    const result = await RedeemCode.redeemCode(1, 'TESTCODE2025');

    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/既に使用/);

    // ROLLBACKが呼ばれること
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── 無効なコード ───────────────────────────────────────────
  test('存在しないコードは success:false を返す（DBアクセスなし）', async () => {
    const result = await RedeemCode.redeemCode(1, 'BADCODE');
    expect(result).toMatchObject({ success: false });

    // DBへのアクセスが一切発生しないこと
    expect(client.query).not.toHaveBeenCalled();
  });

  test('inactive なコードは success:false を返す', async () => {
    const result = await RedeemCode.redeemCode(1, 'INACTIVE_CODE');
    expect(result).toMatchObject({ success: false });
    expect(client.query).not.toHaveBeenCalled();
  });

  // ─── ポイント付与の値チェック ──────────────────────────────
  test('付与されるポイント数はYAML定義の値と一致する（クライアントから受け取らない）', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await RedeemCode.redeemCode(1, 'TESTCODE2025');

    // UPDATE users の引数がYAML定義の500ptと一致すること
    const updateCall = client.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE users')
    );
    expect(updateCall[1][0]).toBe('500'); // BigInt → string
  });

  // ─── ROLLBACK保証 ───────────────────────────────────────────
  test('UPDATE中にDB障害が発生してもROLLBACKする', async () => {
    client.query
      .mockResolvedValueOnce(undefined)                           // BEGIN
      .mockResolvedValueOnce(undefined)                           // INSERT redeem_code_uses (成功)
      .mockRejectedValueOnce(new Error('DB connection lost'));    // UPDATE users で障害

    const result = await RedeemCode.redeemCode(1, 'TESTCODE2025');

    // エラーはキャッチされて success:false で返る
    expect(result.success).toBe(false);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── client.release() ──────────────────────────────────────
  test('成功・失敗どちらでも必ず client.release() が呼ばれる', async () => {
    // 失敗ケース（DB障害）
    client.query
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('error'));

    await RedeemCode.redeemCode(1, 'TESTCODE2025');
    expect(client.release).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();
    fs.readFileSync.mockReturnValue(VALID_YAML);

    // 成功ケース
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await RedeemCode.redeemCode(1, 'TESTCODE2025');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────
// 同時引き換え（レースコンディション）
// ──────────────────────────────────────────────────────────────
describe('RedeemCode.redeemCode — 同時引き換え', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.readFileSync.mockReturnValue(VALID_YAML);
  });

  test('同じコードを2ユーザーが同時に引き換えると1つだけ成功する', async () => {
    // DB接続ごとに独立したクライアントを用意
    const clientA = { query: jest.fn(), release: jest.fn() };
    const clientB = { query: jest.fn(), release: jest.fn() };

    // クライアントA: 成功
    clientA.query
      .mockResolvedValueOnce(undefined)  // BEGIN
      .mockResolvedValueOnce(undefined)  // INSERT redeem_code_uses (成功)
      .mockResolvedValueOnce(undefined)  // UPDATE users
      .mockResolvedValueOnce(undefined)  // INSERT point_transactions
      .mockResolvedValueOnce(undefined); // COMMIT

    // クライアントB: DB一意制約違反（同じコードが先にINSERTされた）
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    clientB.query
      .mockResolvedValueOnce(undefined)         // BEGIN
      .mockRejectedValueOnce(uniqueViolation);  // INSERT redeem_code_uses → 23505

    // connectが呼ばれるたびに別クライアントを返す
    pool.connect
      .mockResolvedValueOnce(clientA)
      .mockResolvedValueOnce(clientB);

    const [resultA, resultB] = await Promise.all([
      RedeemCode.redeemCode(1, 'TESTCODE2025'), // ユーザー1
      RedeemCode.redeemCode(2, 'TESTCODE2025'), // ユーザー2（同じコード）
    ]);

    const results = [resultA, resultB];

    // 1つだけ成功していること
    expect(results.filter(r => r.success)).toHaveLength(1);

    // 1つだけ失敗していること
    expect(results.filter(r => !r.success)).toHaveLength(1);
    expect(results.find(r => !r.success).error).toMatch(/既に使用/);

    // 両クライアントで release() が呼ばれること（接続リーク防止）
    expect(clientA.release).toHaveBeenCalledTimes(1);
    expect(clientB.release).toHaveBeenCalledTimes(1);
  });

  test('同じユーザーが同じコードを同時に2回リクエストしても1回分しか付与されない', async () => {
    const clientA = { query: jest.fn(), release: jest.fn() };
    const clientB = { query: jest.fn(), release: jest.fn() };

    // クライアントA: 成功
    clientA.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    // クライアントB: 23505（同一ユーザーの連打）
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    clientB.query
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(uniqueViolation);

    pool.connect
      .mockResolvedValueOnce(clientA)
      .mockResolvedValueOnce(clientB);

    const [r1, r2] = await Promise.all([
      RedeemCode.redeemCode(1, 'TESTCODE2025'),
      RedeemCode.redeemCode(1, 'TESTCODE2025'), // 同じユーザーが同時に連打
    ]);

    // 成功は1回のみ
    const successes = [r1, r2].filter(r => r.success);
    expect(successes).toHaveLength(1);
    expect(successes[0].points).toBe(500); // 1回分のみ付与

    // 成功側クライアントでUPDATE usersが1回だけ実行されたこと
    const updateCalls = clientA.query.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE users')
    );
    expect(updateCalls).toHaveLength(1);

    // 失敗側クライアントでUPDATE usersが実行されていないこと
    const updateCallsB = clientB.query.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE users')
    );
    expect(updateCallsB).toHaveLength(0);
  });

  test('3リクエストが同時に来ても成功は1つだけ', async () => {
    const makeClient = (shouldSucceed) => {
      const c = { query: jest.fn(), release: jest.fn() };
      if (shouldSucceed) {
        c.query
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined);
      } else {
        const err = Object.assign(new Error('duplicate key'), { code: '23505' });
        c.query
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(err);
      }
      return c;
    };

    const [cA, cB, cC] = [makeClient(true), makeClient(false), makeClient(false)];
    pool.connect
      .mockResolvedValueOnce(cA)
      .mockResolvedValueOnce(cB)
      .mockResolvedValueOnce(cC);

    const results = await Promise.all([
      RedeemCode.redeemCode(1, 'TESTCODE2025'),
      RedeemCode.redeemCode(2, 'TESTCODE2025'),
      RedeemCode.redeemCode(3, 'TESTCODE2025'),
    ]);

    expect(results.filter(r => r.success)).toHaveLength(1);
    expect(results.filter(r => !r.success)).toHaveLength(2);

    // 全クライアントで release() が呼ばれること
    [cA, cB, cC].forEach(c => expect(c.release).toHaveBeenCalledTimes(1));
  });
});
