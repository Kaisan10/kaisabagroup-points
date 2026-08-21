'use strict';

/**
 * tests/user.addPoints.test.js
 * User.addPoints / User.addPointsIfUnique の単体テスト
 *
 * DB接続はすべてモック化する。
 * テスト対象: ポイント付与・重複防止・BigInt精度・ROLLBACK保証
 */

jest.mock('../src/config/database', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return {
    pool: {
      connect: jest.fn().mockResolvedValue(mockClient),
    },
    _mockClient: mockClient,
  };
});

const { pool, _mockClient: client } = require('../src/config/database');
const User = require('../src/models/User');

// ──────────────────────────────────────────────────────────────
// User.addPoints
// ──────────────────────────────────────────────────────────────
describe('User.addPoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 正常系 ──────────────────────────────────────────────────
  test('正常にポイントを付与してCOMMITする', async () => {
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // UPDATE users
      .mockResolvedValueOnce(undefined) // INSERT point_transactions
      .mockResolvedValueOnce(undefined); // COMMIT

    await expect(
      User.addPoints(1, 500, 'forum_reward', 'テスト報酬')
    ).resolves.toBeUndefined();

    // BEGIN → UPDATE → INSERT → COMMIT の順で呼ばれること
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(4, 'COMMIT');
  });

  test('BigInt精度: Number.MAX_SAFE_INTEGER を超える金額でも正確に扱える', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    // 例外なく完了すればOK（BigIntで扱えることの確認）
    await expect(
      User.addPoints(1, BigInt('9007199254740994'), 'forum_reward', 'BigIntテスト')
    ).resolves.toBeUndefined();

    // UPDATE の引数に正確な文字列が渡されること
    const updateCall = client.query.mock.calls[1];
    expect(updateCall[1][0]).toBe('9007199254740994');
  });

  // ─── DB障害時のROLLBACK ──────────────────────────────────────
  test('INSERT中にDB障害が発生してもROLLBACKする', async () => {
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // UPDATE users (成功)
      .mockRejectedValueOnce(new Error('DB error')); // INSERT で障害

    await expect(
      User.addPoints(1, 100, 'forum_reward')
    ).rejects.toThrow('DB error');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── client.release() ────────────────────────────────────────
  test('成功・失敗どちらでも必ず client.release() が呼ばれる', async () => {
    // 失敗ケース
    client.query
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fail'));

    try { await User.addPoints(1, 100, 'forum_reward'); } catch (_) {}
    expect(client.release).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();

    // 成功ケース
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await User.addPoints(1, 100, 'forum_reward');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────
// User.addPointsIfUnique
// ──────────────────────────────────────────────────────────────
describe('User.addPointsIfUnique', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 正常系（初回付与） ──────────────────────────────────────
  test('同一タイプの取引がなければポイントを付与して success:true を返す', async () => {
    client.query
      .mockResolvedValueOnce(undefined)            // BEGIN
      .mockResolvedValueOnce({ rows: [] })         // 重複チェック → なし
      .mockResolvedValueOnce(undefined)            // UPDATE users
      .mockResolvedValueOnce(undefined)            // INSERT point_transactions
      .mockResolvedValueOnce(undefined);           // COMMIT

    const result = await User.addPointsIfUnique({
      userId: 1,
      amount: 200,
      transactionType: 'like_reward',
      description: 'いいね報酬',
    });

    expect(result).toEqual({ success: true });
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  // ─── 重複防止 ────────────────────────────────────────────────
  test('同一タイプの取引が既に存在する場合は success:false を返し付与しない', async () => {
    client.query
      .mockResolvedValueOnce(undefined)               // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }); // 重複チェック → 既存あり

    const result = await User.addPointsIfUnique({
      userId: 1,
      amount: 200,
      transactionType: 'like_reward',
    });

    expect(result).toEqual({ success: false, message: 'Already awarded for this period' });

    // ROLLBACK されていること（ポイントは変更されない）
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');

    // UPDATEは呼ばれていないこと
    const queryCalls = client.query.mock.calls.map(c => c[0]);
    expect(queryCalls.some(q => q && q.includes('UPDATE users'))).toBe(false);
  });

  // ─── since オプション ────────────────────────────────────────
  test('since を指定すると重複チェッククエリにパラメータが追加される', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const since = new Date('2025-01-01T00:00:00Z');
    await User.addPointsIfUnique({
      userId: 1,
      amount: 50,
      transactionType: 'monthly_bonus',
      since,
    });

    // 重複チェッククエリの第2引数（params）に since が含まれること
    const checkCall = client.query.mock.calls[1];
    expect(checkCall[1]).toContain(since);
  });

  // ─── DB障害時のROLLBACK ──────────────────────────────────────
  test('UPDATE中にDB障害が発生してもROLLBACKし例外を再スローする', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('constraint violation'));

    await expect(
      User.addPointsIfUnique({ userId: 1, amount: 100, transactionType: 'bonus' })
    ).rejects.toThrow('constraint violation');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── release() ───────────────────────────────────────────────
  test('成功・失敗どちらでも必ず client.release() が呼ばれる', async () => {
    // 重複ケース（success:false）
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });

    await User.addPointsIfUnique({ userId: 1, amount: 100, transactionType: 'bonus' });
    expect(client.release).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();

    // 成功ケース
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await User.addPointsIfUnique({ userId: 1, amount: 100, transactionType: 'bonus' });
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
