'use strict';

/**
 * tests/apiKey.test.js
 * apiKey ユーティリティの単体テスト
 *
 * DB接続不要 — 純粋なロジックのみ（crypto モジュール使用）
 * テスト対象:
 *   - generateApiKey: 形式・長さ・一意性
 *   - hashApiKey: SHA-256・冪等性
 *   - verifyApiKey: 正常一致・不一致・型チェック・タイミング攻撃対策
 *   - keyPrefix: 先頭8文字
 */

const { generateApiKey, hashApiKey, verifyApiKey, keyPrefix } = require('../src/utils/apiKey');

describe('generateApiKey', () => {
  test('skp_ プレフィックスで始まる', () => {
    expect(generateApiKey()).toMatch(/^skp_/);
  });

  test('合計100文字（skp_ + 96文字の16進数）', () => {
    expect(generateApiKey()).toHaveLength(100);
  });

  test('16進数文字のみで構成される（skp_部分を除く）', () => {
    const key = generateApiKey();
    expect(key.slice(4)).toMatch(/^[0-9a-f]+$/);
  });

  test('呼び出すたびに異なるキーが生成される', () => {
    const keys = new Set(Array.from({ length: 10 }, () => generateApiKey()));
    expect(keys.size).toBe(10);
  });
});

describe('hashApiKey', () => {
  test('64文字の16進数ハッシュを返す（SHA-256）', () => {
    const hash = hashApiKey('skp_testkey');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test('同じ入力に対して常に同じハッシュを返す（冪等性）', () => {
    const key = 'skp_testkey123';
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  test('異なる入力に対しては異なるハッシュを返す', () => {
    expect(hashApiKey('skp_aaa')).not.toBe(hashApiKey('skp_bbb'));
  });
});

describe('verifyApiKey', () => {
  test('正しいキーとハッシュは true を返す', () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    expect(verifyApiKey(key, hash)).toBe(true);
  });

  test('間違ったキーは false を返す', () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    expect(verifyApiKey('skp_wrongkey', hash)).toBe(false);
  });

  test('1文字でも違うキーは false を返す（タイミング攻撃対策でも正しく検出）', () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    const tampered = key.slice(0, -1) + (key.endsWith('a') ? 'b' : 'a');
    expect(verifyApiKey(tampered, hash)).toBe(false);
  });

  test('plainKey が文字列でない場合は false を返す（型チェック）', () => {
    const hash = hashApiKey('skp_test');
    expect(verifyApiKey(null, hash)).toBe(false);
    expect(verifyApiKey(undefined, hash)).toBe(false);
    expect(verifyApiKey(12345, hash)).toBe(false);
  });

  test('storedHash が文字列でない場合は false を返す（型チェック）', () => {
    expect(verifyApiKey('skp_test', null)).toBe(false);
    expect(verifyApiKey('skp_test', undefined)).toBe(false);
  });

  test('長さが異なるハッシュを渡した場合は false を返す（早期返却）', () => {
    // 有効なキーだが storedHash が短い（長さ不一致）
    const key = generateApiKey();
    expect(verifyApiKey(key, 'abc123')).toBe(false);
  });

  test('空文字列に対しては false を返す', () => {
    expect(verifyApiKey('', '')).toBe(false);
    expect(verifyApiKey('skp_test', '')).toBe(false);
  });
});

describe('keyPrefix', () => {
  test('先頭8文字を返す（skp_xxxx）', () => {
    const key = 'skp_' + 'a'.repeat(96);
    expect(keyPrefix(key)).toBe('skp_aaaa');
  });

  test('generateApiKey の出力に対して skp_xxxx 形式になる', () => {
    const key = generateApiKey();
    const prefix = keyPrefix(key);
    expect(prefix).toHaveLength(8);
    expect(prefix).toMatch(/^skp_/);
  });
});
