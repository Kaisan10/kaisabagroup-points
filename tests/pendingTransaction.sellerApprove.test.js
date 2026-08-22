'use strict';

/**
 * tests/pendingTransaction.sellerApprove.test.js
 * PendingTransaction.sellerApprove の単体テスト
 *
 * DB接続はモック化。
 * テスト対象:
 *   - 正常系（buyer→server / buyer→recipient ルート）
 *   - sellerApprove時の残高再確認（initiate後に残高が減った場合）
 *   - 状態機械の保護（wrong status / expired / completed / rejected）
 *   - なりすまし防止（sellerServerId チェック）
 *   - ROLLBACK・release() 保証
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

const { _mockClient: client } = require('../src/config/database');
const PendingTransaction = require('../src/models/PendingTransaction');

// テスト用の取引データ（pending_seller 状態）
function makeTx(overrides = {}) {
  return {
    id: 1,
    status: 'pending_seller',
    expires_at: new Date(Date.now() + 60_000), // 1分後
    buyer_user_id: 10,
    recipient_user_id: null,
    amount: '300',
    server_id: 5,
    item_name: 'テストアイテム',
    buyer_points: '1000',
    ...overrides,
  };
}

describe('PendingTransaction.sellerApprove', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 正常系: buyer → server残高 ──────────────────────────────
  test('正常系: buyer→server残高 への移動が完了してstatusがcompletedになる', async () => {
    const tx = makeTx(); // recipient_user_id: null → サーバー残高へ

    client.query
      .mockResolvedValueOnce(undefined)            // BEGIN
      .mockResolvedValueOnce({ rows: [tx] })       // SELECT FOR UPDATE
      .mockResolvedValueOnce(undefined)            // UPDATE users (buyer 引く)
      .mockResolvedValueOnce(undefined)            // UPDATE server_accounts (server 加算)
      .mockResolvedValueOnce(undefined)            // INSERT point_transactions (buyer側)
      .mockResolvedValueOnce(undefined)            // UPDATE pending_transactions → completed
      .mockResolvedValueOnce(undefined);           // COMMIT

    const result = await PendingTransaction.sellerApprove({ txId: 1, sellerServerId: 5 });

    expect(result).toMatchObject({ status: 'completed', amount: '300', itemName: 'テストアイテム' });
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  // ─── 正常系: buyer → recipient_user ────────────────────────────
  test('正常系: buyer→受取人ユーザー への移動が完了する（point_transactionsが2件記録される）', async () => {
    const tx = makeTx({ recipient_user_id: 20 }); // 受取人あり

    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [tx] })
      .mockResolvedValueOnce(undefined)            // UPDATE users (buyer 引く)
      .mockResolvedValueOnce(undefined)            // UPDATE users (recipient 加算)
      .mockResolvedValueOnce(undefined)            // INSERT point_transactions (buyer側)
      .mockResolvedValueOnce(undefined)            // INSERT point_transactions (recipient側)
      .mockResolvedValueOnce(undefined)            // UPDATE pending_transactions
      .mockResolvedValueOnce(undefined);           // COMMIT

    const result = await PendingTransaction.sellerApprove({ txId: 1, sellerServerId: 5 });
    expect(result.status).toBe('completed');

    // point_transactions が2回INSERTされること（buyer側 + recipient側）
    const insertCalls = client.query.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO point_transactions')
    );
    expect(insertCalls).toHaveLength(2);
  });

  // ─── sellerApprove時の残高再確認 ──────────────────────────────
  test('sellerApprove時に残高が不足していたら rejected にして 402 をスローする', async () => {
    const tx = makeTx({ amount: '2000', buyer_points: '500' }); // 残高500 < 金額2000

    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [tx] })
      .mockResolvedValueOnce(undefined)  // UPDATE pending_transactions → rejected
      .mockResolvedValueOnce(undefined); // COMMIT（rejected で終わる）

    await expect(
      PendingTransaction.sellerApprove({ txId: 1, sellerServerId: 5 })
    ).rejects.toMatchObject({
      message: 'Buyer has insufficient points',
      statusCode: 402,
    });

    // rejected に更新されること
    const rejectCall = client.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes("status = 'rejected'")
    );
    expect(rejectCall).toBeTruthy();
  });

  // ─── 状態機械の保護 ───────────────────────────────────────────
  test('status が pending_buyer のまま sellerApprove しようとすると 409 をスローする', async () => {
    const tx = makeTx({ status: 'pending_buyer' });
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [tx] });

    await expect(
      PendingTransaction.sellerApprove({ txId: 1, sellerServerId: 5 })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('expired な取引を承認しようとすると 410 をスローする', async () => {
    const tx = makeTx({ status: 'expired', expires_at: new Date(Date.now() - 1000) });
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [tx] });

    await expect(
      PendingTransaction.sellerApprove({ txId: 1, sellerServerId: 5 })
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  test('completed な取引を再承認しようとすると 409 をスローする', async () => {
    const tx = makeTx({ status: 'completed' });
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [tx] });

    await expect(
      PendingTransaction.sellerApprove({ txId: 1, sellerServerId: 5 })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // ─── なりすまし防止 ────────────────────────────────────────────
  test('sellerServerId が違う場合は 404 をスローする（他サーバーの取引に触れない）', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] }); // WHERE server_id = $2 に一致しない

    await expect(
      PendingTransaction.sellerApprove({ txId: 1, sellerServerId: 999 }) // 正しくないserverId
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── ROLLBACK保証 ─────────────────────────────────────────────
  test('UPDATE中にDB障害が発生してもROLLBACKする', async () => {
    const tx = makeTx();
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [tx] })
      .mockRejectedValueOnce(new Error('DB error'));

    await expect(
      PendingTransaction.sellerApprove({ txId: 1, sellerServerId: 5 })
    ).rejects.toThrow('DB error');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── release() 保証 ───────────────────────────────────────────
  test('成功・失敗どちらでも必ず client.release() が呼ばれる', async () => {
    // 失敗ケース（取引なし）
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] });

    try { await PendingTransaction.sellerApprove({ txId: 1, sellerServerId: 5 }); } catch { /* expected */ }
    expect(client.release).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();

    // 成功ケース
    const tx = makeTx();
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [tx] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await PendingTransaction.sellerApprove({ txId: 1, sellerServerId: 5 });
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
