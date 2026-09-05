'use strict';

/**
 * tests/migration.schema.test.js
 *
 * マイグレーション検証テスト
 * 期待スキーマは database.js の SCHEMA オブジェクトが唯一の情報源。
 * カラムを追加したら database.js の SQL と SCHEMA を同時に更新する。
 * どちらか片方だけ更新した場合にこのテストが失敗して気づける。
 *
 * 実行方法:
 *   DB_NAME=kaisaba_points_test NODE_ENV=test npx jest tests/migration.schema.test.js --forceExit --runInBand
 */

require('dotenv').config();
process.env.NODE_ENV = 'test';
if (!process.env.DB_NAME) {
  throw new Error('DB_NAME が未設定です。例: DB_NAME=kaisaba_points_test npx jest ...');
}

const fs   = require('fs');
const path = require('path');
const { initDatabase } = require('../server');
const { pool, SCHEMA } = require('../src/config/database');

// ─── database.js のソースからインデックス・テーブルを自動抽出 ────────────────
const dbSource  = fs.readFileSync(path.join(__dirname, '../src/config/database.js'), 'utf-8');
const TABLE_RE  = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
const INDEX_RE  = /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+ON\s+(\w+)/gi;

const TABLES  = [...new Set([...dbSource.matchAll(TABLE_RE)].map(m => m[1].toLowerCase()))];
const INDEXES = [...dbSource.matchAll(INDEX_RE)].map(m => ({
  indexName: m[1].toLowerCase(),
  tableName: m[2].toLowerCase(),
}));

if (TABLES.length === 0) throw new Error('database.js から CREATE TABLE が1件も見つかりませんでした');
if (INDEXES.length === 0) throw new Error('database.js から CREATE INDEX が1件も見つかりませんでした');

// ─── ヘルパー ────────────────────────────────────────────────────────────────

const q = (sql, params) => pool.query(sql, params).then(r => r.rows);

const getColumnNames   = t    => q(`SELECT column_name FROM information_schema.columns
                                    WHERE table_schema='public' AND table_name=$1`, [t])
                                 .then(rows => new Set(rows.map(r => r.column_name)));
const getColumnType    = (t,c) => q(`SELECT data_type FROM information_schema.columns
                                    WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t,c])
                                 .then(rows => rows[0]?.data_type ?? null);
const isNullable       = (t,c) => q(`SELECT is_nullable FROM information_schema.columns
                                    WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t,c])
                                 .then(rows => rows[0]?.is_nullable === 'YES');
const tableExists      = t    => q(`SELECT 1 FROM information_schema.tables
                                    WHERE table_schema='public' AND table_name=$1`, [t])
                                 .then(rows => rows.length > 0);
const constraintExists = name => q(`SELECT 1 FROM pg_constraint WHERE conname=$1`, [name])
                                 .then(rows => rows.length > 0);
const getIndexNames    = t    => q(`SELECT indexname FROM pg_indexes
                                    WHERE schemaname='public' AND tablename=$1`, [t])
                                 .then(rows => new Set(rows.map(r => r.indexname)));

// ─────────────────────────────────────────────────────────────────────────────

describe('Migration Schema Tests', () => {
  beforeAll(async () => { await initDatabase(); });
  afterAll(async  () => { await pool.end(); });

  // ─── テーブル存在確認（CREATE TABLE から自動検出） ───────────────────────
  describe('テーブルの存在確認 (database.js から自動検出)', () => {
    test.each(TABLES)('テーブル "%s" が存在する', async tableName => {
      expect(await tableExists(tableName)).toBe(true);
    });
  });

  // ─── SCHEMA 駆動の汎用テスト ─────────────────────────────────────────────
  // カラム・型・nullable・制約は database.js の SCHEMA オブジェクトが唯一の情報源。
  // 新しいカラムを追加したら SQL と SCHEMA の両方を更新する。
  for (const [tableName, def] of Object.entries(SCHEMA)) {
    describe(`${tableName} スキーマ`, () => {

      test('必要なカラムが全て存在する', async () => {
        const cols = await getColumnNames(tableName);
        for (const col of def.columns) {
          expect(cols).toContain(col);
        }
      });

      if (def.bigintCols.length > 0) {
        test.each(def.bigintCols)(
          'カラム "%s" は bigint 型',
          async col => expect(await getColumnType(tableName, col)).toBe('bigint')
        );
      }

      if (def.nullableCols.length > 0) {
        test.each(def.nullableCols)(
          'カラム "%s" は nullable',
          async col => expect(await isNullable(tableName, col)).toBe(true)
        );
      }

      if (def.constraints.length > 0) {
        test.each(def.constraints)(
          '制約 "%s" が存在する',
          async name => expect(await constraintExists(name)).toBe(true)
        );
      }
    });
  }

  // ─── インデックス（CREATE INDEX から自動検出） ───────────────────────────
  describe('インデックス (database.js から自動検出)', () => {
    test.each(INDEXES)(
      'テーブル "$tableName" にインデックス "$indexName" が存在する',
      async ({ tableName, indexName }) => {
        expect(await getIndexNames(tableName)).toContain(indexName);
      }
    );
  });
});
