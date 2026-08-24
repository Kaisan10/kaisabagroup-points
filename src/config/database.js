const { Pool } = require('pg');

// BIGINT (OID=20) を文字列として受け取る
// JS の Number 精度限界を避けるため、計算が必要な場合は BigInt() を使用する
require('pg').types.setTypeParser(20, val => val);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ★ 重要: アイドル状態のクライアントでエラーが発生した場合（PostgreSQL再起動など）
// ここで捕捉しないと unhandled 'error' event でプロセスがクラッシュする
pool.on('error', (err, _client) => {
  console.error('⚠️ DBプールでエラーが発生しました（PostgreSQL再起動等）:', err.message);
  // エラーを捕捉するだけでよい。pg-pool が自動的に接続を破棄し、
  // 次のリクエスト時に新しい接続を確立する
});

// データベーステーブルを作成
async function initDatabase() {
  try {
    // usersテーブル
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        discourse_id INTEGER UNIQUE NOT NULL,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) NOT NULL,
        avatar_url TEXT,
        minecraft_id VARCHAR(255),
        total_points BIGINT DEFAULT 0 CHECK (total_points >= 0),
        is_suspended BOOLEAN DEFAULT FALSE,
        is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // avatar_url, ranking_opt_in, trusted_auto_approveカラムの追加（既存テーブル用）
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='avatar_url') THEN
          ALTER TABLE users ADD COLUMN avatar_url TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='ranking_opt_in') THEN
          ALTER TABLE users ADD COLUMN ranking_opt_in BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='trusted_auto_approve') THEN
          ALTER TABLE users ADD COLUMN trusted_auto_approve BOOLEAN DEFAULT FALSE;
        END IF;
      END $$;
    `);


    // point_transactionsテーブル
    await pool.query(`
      CREATE TABLE IF NOT EXISTS point_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount BIGINT NOT NULL,
        transaction_type VARCHAR(50) NOT NULL,
        reference_id INTEGER,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // minecraft_link_tokensテーブル（ワンタイムトークン）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS minecraft_link_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(10) UNIQUE NOT NULL,
        minecraft_username VARCHAR(255),
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // redeem_code_usesテーブル（引き換えコード使用履歴）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS redeem_code_uses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        code VARCHAR(255) NOT NULL,
        points_awarded BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, code)
      )
    `);

    // sessionテーブル（connect-pg-simple用）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid varchar NOT NULL COLLATE "default",
        sess json NOT NULL,
        expire timestamp(6) NOT NULL,
        CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
      ) WITH (OIDS=FALSE)
    `);


    // ─── 経済システム: サービスアカウント ───────────────────────────────────
    // APIキーは SHA-256 ハッシュのみ保存（平文は初回のみ返す）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS server_accounts (
        id               SERIAL PRIMARY KEY,
        name             VARCHAR(100) NOT NULL,
        api_key_hash     VARCHAR(64) UNIQUE NOT NULL,
        api_key_prefix   VARCHAR(8) NOT NULL,
        owner_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        balance          BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
        webhook_url      VARCHAR(500),
        seller_approval  VARCHAR(20) NOT NULL DEFAULT 'web'
                           CHECK (seller_approval IN ('web', 'minecraft')),
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        is_active        BOOLEAN DEFAULT TRUE,
        is_trusted       BOOLEAN DEFAULT FALSE,
        allowed_ips      TEXT,
        tx_limit         BIGINT DEFAULT 0
      )
    `);

    // ─── 経済システム: 商品マスタ ──────────────────────────────────────────
    // クライアント(プラグイン)から金額を受け取らず、ここで価格を管理する
    await pool.query(`
      CREATE TABLE IF NOT EXISTS server_products (
        id                SERIAL PRIMARY KEY,
        server_product_id INTEGER,
        server_id         INTEGER NOT NULL REFERENCES server_accounts(id) ON DELETE CASCADE,
        name              VARCHAR(200) NOT NULL,
        price             BIGINT NOT NULL CHECK (price > 0),
        description       TEXT,
        is_active         BOOLEAN DEFAULT TRUE,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── 経済システム: ペンディング取引 ────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_transactions (
        id                 SERIAL PRIMARY KEY,
        tx_token           VARCHAR(32) UNIQUE NOT NULL,
        server_id          INTEGER NOT NULL REFERENCES server_accounts(id) ON DELETE RESTRICT,
        buyer_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        product_id         INTEGER REFERENCES server_products(id) ON DELETE SET NULL,
        amount             BIGINT NOT NULL CHECK (amount > 0),
        item_name          VARCHAR(200) NOT NULL,
        status             VARCHAR(20) NOT NULL DEFAULT 'pending_buyer'
                             CHECK (status IN (
                               'pending_buyer','pending_seller',
                               'completed','rejected','expired'
                             )),
        buyer_confirm_code VARCHAR(16) NOT NULL,
        buyer_approved_at  TIMESTAMPTZ,
        seller_approved_at TIMESTAMPTZ,
        rejected_by        VARCHAR(20)
                             CHECK (rejected_by IS NULL OR rejected_by IN ('buyer','seller')),
        expires_at         TIMESTAMPTZ NOT NULL,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── point_transactions: 送受信者トレース用カラム追加 ──────────────────
    // 既存データには影響しない（NULLable で追加）
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'point_transactions' AND column_name = 'sender_type'
        ) THEN
          ALTER TABLE point_transactions
            ADD COLUMN sender_type   VARCHAR(20),
            ADD COLUMN sender_id     INTEGER,
            ADD COLUMN receiver_type VARCHAR(20),
            ADD COLUMN receiver_id   INTEGER,
            ADD COLUMN pending_tx_id INTEGER REFERENCES pending_transactions(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // ─── インデックス作成 ────────────────────────────────────────────────
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_discourse_id ON users(discourse_id)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON point_transactions(user_id)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_link_tokens_token ON minecraft_link_tokens(token)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_redeem_code_uses_code ON redeem_code_uses(code)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_redeem_code_uses_user_id ON redeem_code_uses(user_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_server_accounts_owner ON server_accounts(owner_user_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_server_products_server ON server_products(server_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_pending_tx_token ON pending_transactions(tx_token)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_pending_tx_status ON pending_transactions(status)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_pending_tx_buyer ON pending_transactions(buyer_user_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_pending_tx_server ON pending_transactions(server_id)
    `);

    // ─── 確認コード廃止: buyer_confirm_code を nullable に ──────────────────
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE pending_transactions ALTER COLUMN buyer_confirm_code DROP NOT NULL;
      EXCEPTION WHEN duplicate_column THEN NULL;
               WHEN undefined_column THEN NULL; END $$;
    `);

    // ─── 受取人ユーザーID追加: recipient_user_id ───────────────────────────
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'pending_transactions' AND column_name = 'recipient_user_id'
        ) THEN
          ALTER TABLE pending_transactions ADD COLUMN recipient_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // server_id を nullable に（受取人がユーザーのみの場合を考慮）
    await pool.query(`
      ALTER TABLE pending_transactions ALTER COLUMN server_id DROP NOT NULL;
    `);

    // ─── users: ランキング参加フラグ ───────────────────────────────────────
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'ranking_opt_in'
        ) THEN
          ALTER TABLE users ADD COLUMN ranking_opt_in BOOLEAN DEFAULT FALSE;
        END IF;
      END $$;
    `);

    // ─── users: アカウント停止フラグ ───────────────────────────────────────
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'is_suspended'
        ) THEN
          ALTER TABLE users ADD COLUMN is_suspended BOOLEAN DEFAULT FALSE;
        END IF;
      END $$;
    `);

    // ─── サーバー自己登録トークン ──────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS server_registration_tokens (
        id          SERIAL PRIMARY KEY,
        token       VARCHAR(64) UNIQUE NOT NULL,
        server_name VARCHAR(100) NOT NULL,
        status      VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','completed','expired')),
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reg_tokens_token
        ON server_registration_tokens(token)
    `);

    // ─── 通報テーブル ──────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id           SERIAL PRIMARY KEY,
        reporter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category     VARCHAR(30) NOT NULL
                       CHECK (category IN ('scam','other')),
        description  TEXT NOT NULL,
        is_dismissed BOOLEAN DEFAULT FALSE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reports_reporter
        ON reports(reporter_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reports_created
        ON reports(created_at)
    `);

    // ─── サブスクリプションテーブル ────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id             SERIAL PRIMARY KEY,
        server_id      INTEGER NOT NULL REFERENCES server_accounts(id) ON DELETE RESTRICT,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        product_id     INTEGER REFERENCES server_products(id) ON DELETE SET NULL,
        amount         BIGINT NOT NULL CHECK (amount > 0),
        interval_days  INTEGER NOT NULL CHECK (interval_days > 0),
        next_charge_at TIMESTAMPTZ,
        status         TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','active','suspended','cancelled')),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user
        ON subscriptions(user_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_server
        ON subscriptions(server_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_next_charge
        ON subscriptions(next_charge_at) WHERE status = 'active'
    `);

    // ─── BIGINT マイグレーション（既存DBのINTEGERカラムを拡張）────────────────
    await pool.query(`
      DO $$ BEGIN
        -- users.total_points
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name='users' AND column_name='total_points') = 'integer' THEN
          ALTER TABLE users ALTER COLUMN total_points TYPE BIGINT;
        END IF;
        -- point_transactions.amount
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name='point_transactions' AND column_name='amount') = 'integer' THEN
          ALTER TABLE point_transactions ALTER COLUMN amount TYPE BIGINT;
        END IF;
        -- redeem_code_uses.points_awarded
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name='redeem_code_uses' AND column_name='points_awarded') = 'integer' THEN
          ALTER TABLE redeem_code_uses ALTER COLUMN points_awarded TYPE BIGINT;
        END IF;
        -- server_accounts.balance
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name='server_accounts' AND column_name='balance') = 'integer' THEN
          ALTER TABLE server_accounts ALTER COLUMN balance TYPE BIGINT;
        END IF;
        -- server_products.price
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name='server_products' AND column_name='price') = 'integer' THEN
          ALTER TABLE server_products ALTER COLUMN price TYPE BIGINT;
        END IF;
        -- pending_transactions.amount
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name='pending_transactions' AND column_name='amount') = 'integer' THEN
          ALTER TABLE pending_transactions ALTER COLUMN amount TYPE BIGINT;
        END IF;

        -- users.username UNIQUE 制約追加
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'users_username_key'
        ) THEN
          -- 重複がないことを前提とする（監査で確認済み）
          ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
        END IF;

        -- users.is_admin カラム追加（既存の boolean カラム追加ロジックがあるが、より確実に）
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'is_admin'
        ) THEN
          ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE;
          
          -- 初期管理者の設定
          IF current_setting('app.admin_username', true) IS NOT NULL THEN
            UPDATE users SET is_admin = TRUE WHERE username = current_setting('app.admin_username');
          END IF;
        END IF;

        -- users.total_points CHECK 制約追加
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'users_total_points_check'
        ) THEN
          -- マイナスの値がないか確認してから追加（通常はないはず）
          ALTER TABLE users ADD CONSTRAINT users_total_points_check CHECK (total_points >= 0);
        END IF;
      END $$;
    `, []);

    // 管理者フラグの同期（起動のたびに実行して .env の変更を反映させることも可能だが、
    // ここでは安全のため個別のクエリとして実行）
    const adminUsername = (process.env.ADMIN_USERNAME || '').trim();
    if (adminUsername) {
      await pool.query('UPDATE users SET is_admin = TRUE WHERE username = $1', [adminUsername]);
    }

    // ─── server_products: サービス内連番ID追加 ──────────────────────────────
    await pool.query(`
      DO $$ BEGIN
        -- server_product_id カラム追加
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'server_products' AND column_name = 'server_product_id'
        ) THEN
          ALTER TABLE server_products ADD COLUMN server_product_id INTEGER;
        END IF;
        -- 既存データをサービスごとに採番
        UPDATE server_products sp
        SET server_product_id = sub.rn
        FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY server_id ORDER BY id) AS rn
          FROM server_products
          WHERE server_product_id IS NULL
        ) sub
        WHERE sp.id = sub.id;
        -- UNIQUE 制約追加
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'uq_server_product_id'
        ) THEN
          ALTER TABLE server_products
            ADD CONSTRAINT uq_server_product_id UNIQUE (server_id, server_product_id);
        END IF;
      END $$;
    `);

    // ─── 信頼モード: カラム追加 ──────────────────────────────────────────────
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'server_accounts' AND column_name = 'is_trusted') THEN
          ALTER TABLE server_accounts ADD COLUMN is_trusted BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'server_accounts' AND column_name = 'allowed_ips') THEN
          ALTER TABLE server_accounts ADD COLUMN allowed_ips TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'server_accounts' AND column_name = 'tx_limit') THEN
          ALTER TABLE server_accounts ADD COLUMN tx_limit BIGINT DEFAULT 0;
        END IF;
      END $$;
    `);

    // ─── 信頼モード: ユーザー許可設定 ─────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_trusted_servers (
        id               SERIAL PRIMARY KEY,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        server_id        INTEGER NOT NULL REFERENCES server_accounts(id) ON DELETE CASCADE,
        delegate_allowed BOOLEAN NOT NULL DEFAULT FALSE,
        auto_approve     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, server_id)
      )
    `);

    // delegate_allowed カラムの追加（既存テーブル用マイグレーション）
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'user_trusted_servers' AND column_name = 'delegate_allowed'
        ) THEN
          ALTER TABLE user_trusted_servers ADD COLUMN delegate_allowed BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'user_trusted_servers' AND column_name = 'auto_approve'
        ) THEN
          ALTER TABLE user_trusted_servers ADD COLUMN auto_approve BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;
      END $$;
    `);

    // ─── ギフトコード ───────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gift_codes (
        id                SERIAL PRIMARY KEY,
        code              VARCHAR(60) UNIQUE NOT NULL,
        creator_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        points            BIGINT NOT NULL CHECK (points > 0),
        title             VARCHAR(10) NOT NULL,
        memo              TEXT,
        is_used           BOOLEAN NOT NULL DEFAULT FALSE,
        used_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at           TIMESTAMPTZ
      )
    `);
    // title カラムの長さを VARCHAR(10) に縮小（既存テーブル対応）
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'gift_codes' AND column_name = 'title'
            AND character_maximum_length IS DISTINCT FROM 10
        ) THEN
          ALTER TABLE gift_codes ALTER COLUMN title TYPE VARCHAR(10);
        END IF;
      END $$;
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_gift_codes_code
        ON gift_codes(code)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_gift_codes_creator
        ON gift_codes(creator_user_id)
    `);

    // ─── server_accounts: redirect_uris カラム追加 ─────────────────────────
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'server_accounts' AND column_name = 'redirect_uris'
        ) THEN
          ALTER TABLE server_accounts ADD COLUMN redirect_uris TEXT;
        END IF;
      END $$;
    `);

    // ─── OAuth テーブル群 ────────────────────────────────────────────────────
    // 認可コード（ワンタイム）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_auth_codes (
        id           SERIAL PRIMARY KEY,
        code         VARCHAR(64) UNIQUE NOT NULL,
        server_id    INTEGER NOT NULL REFERENCES server_accounts(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scopes       TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        used         BOOLEAN NOT NULL DEFAULT FALSE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_code
        ON oauth_auth_codes(code)
    `);

    // アクセストークン（1時間有効）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_access_tokens (
        id           SERIAL PRIMARY KEY,
        token_hash   VARCHAR(64) UNIQUE NOT NULL,
        token_prefix VARCHAR(8) NOT NULL,
        server_id    INTEGER NOT NULL REFERENCES server_accounts(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scopes       TEXT NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        revoked      BOOLEAN NOT NULL DEFAULT FALSE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_prefix
        ON oauth_access_tokens(token_prefix)
    `);

    // リフレッシュトークン（90日有効・ローテーション）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        id           SERIAL PRIMARY KEY,
        token_hash   VARCHAR(64) UNIQUE NOT NULL,
        token_prefix VARCHAR(8) NOT NULL,
        server_id    INTEGER NOT NULL REFERENCES server_accounts(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scopes       TEXT NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        revoked      BOOLEAN NOT NULL DEFAULT FALSE,
        used         BOOLEAN NOT NULL DEFAULT FALSE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_prefix
        ON oauth_refresh_tokens(token_prefix)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_user
        ON oauth_refresh_tokens(user_id)
    `);

    console.log('✅ データベーステーブル作成完了');
  } catch (err) {
    console.error('❌ データベース初期化エラー:', err);
    throw err;
  }
}

module.exports = { pool, initDatabase };