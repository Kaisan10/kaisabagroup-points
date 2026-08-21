'use strict';

/**
 * tests/user.deductPoints.test.js
 * User.deductPoints の単体テスト
 *
 * DB接続はすべてモック化する。
 * テスト対象: 残高不足チェック・BigInt演算・トランザクション整合性
 */

// pg pool をモック化（DB接続なし）
jest.mock('../src/config/database', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return {
    pool: {
      connect: jest.fn().mockResolvedValue(mockClient),
    },
    _mockClient: mockClient, // テストから参照するため公開
  };
});

const { pool, _mockClient: client } = require('../src/config/database');
const User = require('../src/models/User');

describe('User.deductPoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 残高不足エラー ──────────────────────────────────────────────
  test('残高不足の場合 statusCode:402 のエラーをスローする', async () => {
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({          // SELECT ... FOR UPDATE
        rows: [{ total_points: '50' }], // 残高 50pt
      });

    await expect(
      User.deductPoints(1, 100, 'purchase', 'テスト購入')
    ).rejects.toMatchObject({
      message: 'Insufficient points',
      statusCode: 402,
    });

    // ROLLBACKが呼ばれていること
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── 正常系 ──────────────────────────────────────────────────────
  test('残高が十分なら正しく差し引いて新残高を返す', async () => {
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ total_points: '1000' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce(undefined) // UPDATE users
      .mockResolvedValueOnce(undefined) // INSERT point_transactions
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await User.deductPoints(1, 300, 'purchase', 'テスト購入');
    expect(result).toBe('700'); // 1000 - 300 = 700
  });

  test('BigInt精度: 大きな数値でも正確に計算される', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ total_points: '9007199254740993' }] }) // Number最大値+1
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const result = await User.deductPoints(1, 1, 'purchase', 'BigIntテスト');
    expect(result).toBe('9007199254740992'); // Number.MAX_SAFE_INTEGER
  });

  // ─── ユーザー不在 ────────────────────────────────────────────────
  test('ユーザーが存在しない場合はエラーをスローする', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] }); // ユーザーなし

    await expect(
      User.deductPoints(999, 100, 'purchase')
    ).rejects.toThrow('User not found');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── DB障害時のROLLBACK ──────────────────────────────────────────
  test('UPDATE中にDB障害が発生してもROLLBACKする', async () => {
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ total_points: '500' }] }) // SELECT
      .mockRejectedValueOnce(new Error('DB connection lost')); // UPDATE で障害

    await expect(
      User.deductPoints(1, 100, 'purchase')
    ).rejects.toThrow('DB connection lost');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── release() 呼び出し ───────────────────────────────────────────
  test('成功・失敗どちらでも必ず client.release() が呼ばれる', async () => {
    // 失敗ケース
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ total_points: '10' }] });

    try {
      await User.deductPoints(1, 100, 'purchase');
    } catch (_) {}

    expect(client.release).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();

    // 成功ケース
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ total_points: '200' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await User.deductPoints(1, 100, 'purchase');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
