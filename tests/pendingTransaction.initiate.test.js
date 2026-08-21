'use strict';

/**
 * tests/pendingTransaction.initiate.test.js
 * PendingTransaction.initiate のゼロトラスト設計テスト
 *
 * 検証ポイント:
 *   - 商品価格はDBの商品マスタから取得（クライアントから受け取らない）
 *   - 残高不足は早期エラー (statusCode: 402)
 *   - 不正な商品IDは 404
 *   - 信頼モード上限額チェック
 */

jest.mock('../src/config/database', () => {
  return {
    pool: {
      query: jest.fn(),
      connect: jest.fn(),
    },
  };
});

const { pool } = require('../src/config/database');
const PendingTransaction = require('../src/models/PendingTransaction');

describe('PendingTransaction.initiate — ゼロトラスト設計', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 商品不在 ────────────────────────────────────────────────────
  test('存在しない商品IDは statusCode:404 のエラーをスローする', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }); // 商品が見つからない

    await expect(
      PendingTransaction.initiate({
        serverId: 1,
        buyerMcId: 'TestPlayer',
        productId: 999,
      })
    ).rejects.toMatchObject({
      message: 'Product not found or inactive',
      statusCode: 404,
    });
  });

  // ─── 残高不足の早期エラー ─────────────────────────────────────────
  test('残高不足の場合 statusCode:402 のエラーをスローする（クライアントが金額を改ざんできない）', async () => {
    pool.query
      // 商品マスタ: 価格は DB 側が決定（クライアントから受け取らない）
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'テストアイテム', price: '500' }] })
      // 購入者
      .mockResolvedValueOnce({ rows: [{ id: 10, total_points: '100' }] });

    await expect(
      PendingTransaction.initiate({
        serverId: 1,
        buyerMcId: 'PoorPlayer',
        productId: 1,
      })
    ).rejects.toMatchObject({
      message: 'Insufficient points',
      statusCode: 402,
      data: { current: '100', required: '500' },
    });
  });

  // ─── buyerMcId・buyerUserId 両方なし ─────────────────────────────
  test('buyerMcId と buyerUserId が両方ない場合は 400 エラー', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'アイテム', price: '100' }] });

    await expect(
      PendingTransaction.initiate({
        serverId: 1,
        productId: 1,
        // buyerMcId も buyerUserId もなし
      })
    ).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  // ─── 信頼モード上限額チェック ──────────────────────────────────────
  test('信頼モード: 取引額が txLimit を超える場合は 403 エラー', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'HighValueItem', price: '10000' }] })
      .mockResolvedValueOnce({ rows: [{ id: 10, total_points: '999999' }] });

    await expect(
      PendingTransaction.initiate({
        serverId: 1,
        buyerMcId: 'RichPlayer',
        productId: 1,
        isTrusted: true,
        txLimit: '1000', // 上限 1000pt なのに商品価格は 10000pt
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'Transaction amount exceeds trusted mode limit',
    });
  });

  // ─── 購入者不在 ──────────────────────────────────────────────────
  test('minecraft_id が存在しないプレイヤーは 404 エラー', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'アイテム', price: '100' }] })
      .mockResolvedValueOnce({ rows: [] }); // プレイヤーなし

    await expect(
      PendingTransaction.initiate({
        serverId: 1,
        buyerMcId: 'UnknownPlayer',
        productId: 1,
      })
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
