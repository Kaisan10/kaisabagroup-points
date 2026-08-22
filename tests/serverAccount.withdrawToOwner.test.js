'use strict';

/**
 * tests/serverAccount.withdrawToOwner.test.js
 * ServerAccount.withdrawToOwner の単体テスト
 *
 * DB接続はすべてモック化する。
 * テスト対象: サーバー残高→個人ポイントへの安全な移動
 */

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

// apiKey ユーティリティもモック化（DB接続不要にする）
jest.mock('../src/utils/apiKey', () => ({
  generateApiKey: jest.fn(() => 'skp_testkey123456789abcde'),
  hashApiKey: jest.fn(() => 'hashed_key'),
  keyPrefix: jest.fn(() => 'skp_testk'),
}));

const { _mockClient: client } = require('../src/config/database');
const ServerAccount = require('../src/models/ServerAccount');

describe('ServerAccount.withdrawToOwner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 正常系 ──────────────────────────────────────────────────
  test('残高が十分なら引き出しが成功してtrueを返す', async () => {
    client.query
      .mockResolvedValueOnce(undefined)                                      // BEGIN
      .mockResolvedValueOnce({ rows: [{ total_points: '5000' }] })           // SELECT users FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ balance: '3000' }] })                // SELECT server_accounts FOR UPDATE
      .mockResolvedValueOnce(undefined)                                      // UPDATE server_accounts (残高減少)
      .mockResolvedValueOnce(undefined)                                      // UPDATE users (ポイント増加)
      .mockResolvedValueOnce(undefined)                                      // INSERT point_transactions
      .mockResolvedValueOnce(undefined);                                     // COMMIT

    const result = await ServerAccount.withdrawToOwner(1, 10, 1000);
    expect(result).toBe(true);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  test('BigInt精度: 大きな金額でも正確に処理される', async () => {
    const bigAmount = BigInt('9007199254740994');
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ total_points: '99999999999999999' }] })
      .mockResolvedValueOnce({ rows: [{ balance: '99999999999999999' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const result = await ServerAccount.withdrawToOwner(1, 10, bigAmount);
    expect(result).toBe(true);

    // UPDATE server_accounts の引数が正確な文字列であること
    const serverUpdateCall = client.query.mock.calls[3];
    expect(serverUpdateCall[1][0]).toBe('9007199254740994');
  });

  // ─── 残高不足 ────────────────────────────────────────────────
  test('サーバー残高不足の場合 statusCode:402 のエラーをスローする', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ total_points: '10000' }] })
      .mockResolvedValueOnce({ rows: [{ balance: '100' }] }); // 残高100なのに500引き出し

    await expect(
      ServerAccount.withdrawToOwner(1, 10, 500)
    ).rejects.toMatchObject({
      message: '残高が不足しています',
      statusCode: 402,
    });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── 金額バリデーション ───────────────────────────────────────
  test('引き出し額が0以下の場合は statusCode:400 のエラーをスローする', async () => {
    await expect(
      ServerAccount.withdrawToOwner(1, 10, 0)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('引き出し額が負の場合は statusCode:400 のエラーをスローする', async () => {
    await expect(
      ServerAccount.withdrawToOwner(1, 10, -100)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ─── ユーザー不在 ────────────────────────────────────────────
  test('ユーザーが存在しない場合は statusCode:404 のエラーをスローする', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] }); // ユーザーなし

    await expect(
      ServerAccount.withdrawToOwner(1, 999, 100)
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'User not found',
    });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── サーバーアカウント不在・所有権違反 ──────────────────────
  test('サーバーアカウントが存在しない or 所有者が違う場合は 404 エラー', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ total_points: '1000' }] })
      .mockResolvedValueOnce({ rows: [] }); // アカウントなし

    await expect(
      ServerAccount.withdrawToOwner(99, 10, 100)
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'Server account not found or access denied',
    });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── DB障害時のROLLBACK ──────────────────────────────────────
  test('UPDATE中にDB障害が発生してもROLLBACKする', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ total_points: '5000' }] })
      .mockResolvedValueOnce({ rows: [{ balance: '3000' }] })
      .mockRejectedValueOnce(new Error('DB connection lost')); // UPDATE で障害

    await expect(
      ServerAccount.withdrawToOwner(1, 10, 1000)
    ).rejects.toThrow('DB connection lost');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── client.release() ────────────────────────────────────────
  test('成功・失敗どちらでも必ず client.release() が呼ばれる', async () => {
    // 失敗ケース（残高不足）
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ total_points: '1000' }] })
      .mockResolvedValueOnce({ rows: [{ balance: '50' }] });

    try { await ServerAccount.withdrawToOwner(1, 10, 100); } catch { /* expected */ }
    expect(client.release).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();

    // 成功ケース
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ total_points: '5000' }] })
      .mockResolvedValueOnce({ rows: [{ balance: '3000' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await ServerAccount.withdrawToOwner(1, 10, 500);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
