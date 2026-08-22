'use strict';

/**
 * tests/subscription.chargeByServer.test.js
 * Subscription.chargeByServer の単体テスト
 *
 * DB接続はモック化。
 * テスト対象:
 *   - 正常系（引き落とし + サーバー加算 + next_charge_at 更新）
 *   - 残高不足 → suspended への自動遷移
 *   - 二重課金防止（next_charge_at がまだ未到来）
 *   - 状態チェック（inactive/suspended な契約は課金しない）
 *   - なりすまし防止（serverId チェック）
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
const Subscription = require('../src/models/Subscription');

// テスト用のサブスクデータ（active・課金期限到来済み）
function makeSub(overrides = {}) {
  return {
    id: 1,
    user_id: 10,
    server_id: 5,
    amount: '500',
    interval_days: 30,
    status: 'active',
    next_charge_at: new Date(Date.now() - 1000), // 1秒前 = 期限到来済み
    ...overrides,
  };
}

describe('Subscription.chargeByServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 正常系 ──────────────────────────────────────────────────
  test('正常系: 引き落とし・サーバー加算・next_charge_at 更新が行われる', async () => {
    const sub = makeSub();

    client.query
      .mockResolvedValueOnce(undefined)              // BEGIN
      .mockResolvedValueOnce({ rows: [sub] })        // SELECT subscriptions FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ total_points: '2000' }] }) // SELECT users FOR UPDATE
      .mockResolvedValueOnce(undefined)              // UPDATE users (引き落とし)
      .mockResolvedValueOnce(undefined)              // UPDATE server_accounts (加算)
      .mockResolvedValueOnce(undefined)              // INSERT point_transactions
      .mockResolvedValueOnce(undefined)              // UPDATE subscriptions (next_charge_at)
      .mockResolvedValueOnce(undefined);             // COMMIT

    const result = await Subscription.chargeByServer({ subId: 1, serverId: 5 });

    expect(result.status).toBe('active');
    expect(result.amount).toBe('500');
    expect(result.nextChargeAt).toBeInstanceOf(Date);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  test('next_charge_at は interval_days 分だけ前回値に加算される（ドリフトしない）', async () => {
    const prevChargeAt = new Date(Date.now() - 1000);
    const sub = makeSub({ interval_days: 7, next_charge_at: prevChargeAt });

    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [sub] })
      .mockResolvedValueOnce({ rows: [{ total_points: '1000' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const result = await Subscription.chargeByServer({ subId: 1, serverId: 5 });

    // 7日後 = prevChargeAt + 7 * 86400 * 1000
    const expectedNext = new Date(prevChargeAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(result.nextChargeAt.getTime()).toBe(expectedNext.getTime());
  });

  // ─── 残高不足 → suspended ────────────────────────────────────
  test('残高不足の場合 suspended に変更してから 402 をスローする', async () => {
    const sub = makeSub({ amount: '1000' });

    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [sub] })
      .mockResolvedValueOnce({ rows: [{ total_points: '100' }] }) // 残高100 < 金額1000
      .mockResolvedValueOnce(undefined)   // UPDATE subscriptions → suspended
      .mockResolvedValueOnce(undefined);  // COMMIT（suspended で終わる）

    await expect(
      Subscription.chargeByServer({ subId: 1, serverId: 5 })
    ).rejects.toMatchObject({
      message: 'Insufficient points',
      statusCode: 402,
      data: { current: '100', required: '1000' },
    });

    // suspendedへの更新が呼ばれること
    const suspendCall = client.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes("status = 'suspended'")
    );
    expect(suspendCall).toBeTruthy();
  });

  // ─── 二重課金防止 ────────────────────────────────────────────
  test('next_charge_at がまだ未来の場合は 425 をスローする（二重課金防止）', async () => {
    const sub = makeSub({
      next_charge_at: new Date(Date.now() + 60_000), // まだ1分先
    });

    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [sub] });

    await expect(
      Subscription.chargeByServer({ subId: 1, serverId: 5 })
    ).rejects.toMatchObject({ statusCode: 425 });

    // UPDATE users が呼ばれないこと（ポイントが変動しない）
    const updateUserCalls = client.query.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE users')
    );
    expect(updateUserCalls).toHaveLength(0);
  });

  // ─── 状態チェック ────────────────────────────────────────────
  test('suspended な契約は課金できない（409 をスローする）', async () => {
    const sub = makeSub({ status: 'suspended' });

    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [sub] });

    await expect(
      Subscription.chargeByServer({ subId: 1, serverId: 5 })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('cancelled な契約は課金できない（409 をスローする）', async () => {
    const sub = makeSub({ status: 'cancelled' });

    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [sub] });

    await expect(
      Subscription.chargeByServer({ subId: 1, serverId: 5 })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // ─── なりすまし防止 ───────────────────────────────────────────
  test('serverId が違う場合は 404 をスローする（他サーバーのサブスクに触れない）', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] }); // WHERE server_id = $2 に一致しない

    await expect(
      Subscription.chargeByServer({ subId: 1, serverId: 999 })
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── DB障害時のROLLBACK ──────────────────────────────────────
  test('UPDATE users で障害が発生してもROLLBACKする', async () => {
    const sub = makeSub();

    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [sub] })
      .mockResolvedValueOnce({ rows: [{ total_points: '2000' }] })
      .mockRejectedValueOnce(new Error('DB error'));

    await expect(
      Subscription.chargeByServer({ subId: 1, serverId: 5 })
    ).rejects.toThrow('DB error');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // ─── release() 保証 ──────────────────────────────────────────
  test('成功・失敗どちらでも必ず client.release() が呼ばれる', async () => {
    // 失敗ケース（サブスクなし）
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] });

    try { await Subscription.chargeByServer({ subId: 1, serverId: 5 }); } catch { /* expected */ }
    expect(client.release).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();

    // 成功ケース
    const sub = makeSub();
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [sub] })
      .mockResolvedValueOnce({ rows: [{ total_points: '2000' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await Subscription.chargeByServer({ subId: 1, serverId: 5 });
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
