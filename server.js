require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { pool, initDatabase } = require('./src/config/database');
const path = require('path');

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const authRoutes     = require('./src/routes/auth');
const webhookRoutes  = require('./src/routes/webhooks');
const adminRoutes    = require('./src/routes/admin');
const minecraftRoutes = require('./src/routes/minecraft');
const linkRoutes     = require('./src/routes/link');
const redeemRoutes   = require('./src/routes/redeem');
const servicesRoutes = require('./src/routes/services');
const requireAuth    = require('./src/middleware/requireAuth');
const serverApiRoutes = require('./src/routes/serverApi');   // 経済システム: プラグイン向け
const operatorRoutes  = require('./src/routes/operator');    // 経済システム: 運営者向け
const User = require('./src/models/User');
const PendingTransaction = require('./src/models/PendingTransaction'); // 期限切れジョブ用
const userApiRoutes         = require('./src/routes/userApi');          // ユーザー取引API
const userInfoApiRoutes     = require('./src/routes/userInfoApi');      // ユーザー情報・ポイントAPI
const reportRoutes          = require('./src/routes/report');           // 通報API
const subscriptionApiRoutes = require('./src/routes/subscriptionApi'); // サブスクリプションAPI
const Subscription          = require('./src/models/Subscription');    // サブスク課金ジョブ用
const serverRegisterRoutes  = require('./src/routes/serverRegister');  // サーバー自己登録
const oauthRoutes           = require('./src/routes/oauth');           // OAuth認証プロバイダールート
const { globalOriginCheck } = require('./src/utils/csrfCheck'); // CSRFオリジンチェック

// --- 必須環境変数のチェック ---
const requiredEnv = [
  'SESSION_SECRET',
  'SITE_URL',
  'DISCOURSE_SECRET',
  'DISCOURSE_URL',
  'ADMIN_USERNAME'
];
const missingEnv = requiredEnv.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`❌ 致命的エラー: 以下の環境変数が設定されていません: ${missingEnv.join(', ')}`);
  console.error('サーバーの実行を停止します。');
  process.exit(1);
}

// 可及的速やかに警告を出す（致命的ではないが重要なもの）
if (!process.env.WEBHOOK_SECRET) console.warn('⚠️  警告: WEBHOOK_SECRET が未設定です。Webhook認証が機能しません。');
if (!process.env.MINECRAFT_API_KEY) console.warn('⚠️  警告: MINECRAFT_API_KEY が未設定です。マイクラ連携機能が制限されます。');
if (!process.env.SERVICE_API_KEY) console.warn('⚠️  警告: SERVICE_API_KEY が未設定です。外部サービスAPIが機能しません。');

// --- BigInt JSON サポート ---
// BigInt は JSON.stringify でエラーになるため、文字列に変換するように定義
BigInt.prototype.toJSON = function() { return this.toString(); };

const app = express();
const PORT = process.env.PORT || 3000;

// EJSテンプレートエンジン
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('view cache', false);

// リバースプロキシ対応
app.set('trust proxy', 1);

// セキュリティヘッダ
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"], // unsafe-inline を削除
      "script-src-attr": ["'none'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"], // FAなどのCDNを許可
      "font-src": ["'self'", "https://cdnjs.cloudflare.com"],
      "img-src": ["'self'", 'data:', 'https://cdn.bac0n.f5.si', new URL(process.env.DISCOURSE_URL || 'https://example.com').origin],
      "connect-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'self'"]
    }
  },
  hidePoweredBy: true
}));

// 静的ファイルの提供（レート制限のカウントから除外）
app.use(express.static('public'));

// レート制限（基本）
const baseLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });
app.use(baseLimiter);

// Webhook は HMAC のため raw ボディで受信（global express.json の前に配置）
const webhooksLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use('/webhooks', webhooksLimiter, express.raw({ type: 'application/json' }), webhookRoutes);

// ミドルウェア
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// パスをテンプレートで利用可能にする
app.use((req, res, next) => {
  res.locals.path = req.path;
  next();
});

// 環境変数の必須チェック
if (!process.env.SESSION_SECRET) {
  console.error('❌ SESSION_SECRET が設定されていません');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  if (!process.env.WEBHOOK_SECRET) {
    console.error('❌ WEBHOOK_SECRET が設定されていません（本番必須）');
    process.exit(1);
  }
  if (!process.env.SITE_URL) {
    console.warn('⚠️ SITE_URL が設定されていません（本番推奨）');
  }
}

// セッション設定
app.use(session({

  store: new pgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: false,
    pruneSessionInterval: 60 * 60 * 24 // 24時間ごとに期限切れセッションをクリーンアップ
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7日間
    sameSite: 'lax'
  }
}));


// ルート
app.use('/auth', authRoutes);
// Webhook は HMAC のため raw ボディで受信
// (↑ express.json() の前に移動済み)
// ─── グローバルエラーハンドラ ──────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // 本番環境では必要に応じてプロセスを再起動（外部監視ツール等と連携）
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // 致命的なエラーのため、ログを残して終了
  process.exit(1);
});

// CSRFオリジンチェック（src/utils/csrfCheck.js からインポート）
app.use(globalOriginCheck);

const adminLimiter      = rateLimit({ windowMs: 60 * 1000, max: 20 });
const mcLimiter         = rateLimit({ windowMs: 60 * 1000, max: 60 });
const linkLimiter       = rateLimit({ windowMs: 60 * 1000, max: 30 });
const redeemLimiter     = rateLimit({ windowMs: 60 * 1000, max: 10 });
const giftCreateLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });  // ギフト作成（ポイント操作）
const checkPointsLimiter = rateLimit({ windowMs: 60 * 1000, max: 100 });
const servicesLimiter   = rateLimit({ windowMs: 60 * 1000, max: 60 });
// 経済システム: プラグインは頻繁にポーリングする可能性があるので少し緩め
const serverApiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 120 });
// 運営者Web操作は低頻度なので厳しめ
const operatorLimiter   = rateLimit({ windowMs: 60 * 1000, max: 60 });
const userApiLimiter    = rateLimit({ windowMs: 60 * 1000, max: 60 });  // ユーザー取引API(ポーリング用)
const reportLimiter     = rateLimit({ windowMs: 60 * 1000, max: 10 }); // 通報

// ─── 既存ルート（レガシー互換含む）───────────────────────────────────────────
app.use('/admin',          adminLimiter,  adminRoutes);
app.use('/api/minecraft',  mcLimiter,     minecraftRoutes);
app.use('/api/link',       linkLimiter,   linkRoutes);
app.use('/api/redeem/gift/create', giftCreateLimiter);  // ギフト作成専用レート制限
app.use('/api/redeem',     redeemLimiter, redeemRoutes);
app.use('/api/services',   servicesLimiter, servicesRoutes);

// ─── 新経済システム ──────────────────────────────────────────────
// サーバー自己登録（一部認証不要）→ serverApiRoutesの前にマウント必須
// serverApiRoutesは router.use(serverAuth) で全ルートを保護するため、後続するルータとパスが重なっても設登エンドポイントは到達しない
app.use('/api/server',    serverApiLimiter, serverRegisterRoutes);
// サブスクリプション（APIキー認証）
app.use('/api/server/subscription', serverApiLimiter, subscriptionApiRoutes);
// プラグイン向け（APIキー認証）
app.use('/api/server',    serverApiLimiter, serverApiRoutes);
// 運営者向け（Discourseセッション認証）
app.use('/api/operator',  operatorLimiter,  operatorRoutes);

// ユーザー向け取引API（セッション認証）
app.use('/api/user',      userApiLimiter,   userApiRoutes);
// 通報API（セッション認証）
app.use('/api/report',    reportLimiter,    reportRoutes);

// ユーザー情報・ポイント・ランキングAPI
app.use('/api', checkPointsLimiter, userInfoApiRoutes);

// OAuthルート
app.use('/', oauthRoutes);


app.get('/', async (req, res) => {
  if (req.session.user && !req.query.suspended) {
    return res.redirect('/dashboard');
  } else {
    const cookies = req.headers.cookie
      ? Object.fromEntries(req.headers.cookie.split('; ').map(c => c.split('=')))
      : {};

    if (cookies.manual_logout === '1' || req.query.manual === '1' || req.query.suspended === '1') {
      res.render('login', { discourseUrl: process.env.DISCOURSE_URL });
    } else {
      res.redirect('/auth/discourse/login');
    }
  }
});

// ダッシュボード
app.get('/dashboard', requireAuth.page, (req, res) => {
  res.render('dashboard', { user: req.session.user, discourseUrl: process.env.DISCOURSE_URL });
});

// マイクラ連携ページ
app.get('/link', requireAuth.page, (req, res) => {
  res.render('link', { 
    user: req.session.user, 
    title: 'マイクラ連携', 
    description: 'マイクラとリンクしてポイントシステムを利用しよう' 
  });
});

// サーバー一覧
app.get('/server', requireAuth.page, (req, res) => {
  res.render('server', { 
    user: req.session.user, 
    title: 'サーバーリスト', 
    description: 'かい鯖グループポイントに対応するサーバーを見つけよう' 
  });
});

// サーバー登録確認ページ
app.get('/register-server', (req, res) => {
  res.render('register-server', { user: req.session.user || null });
});

app.get('/gift', requireAuth.page, (req, res) => {
  res.render('gift', { user: req.session.user });
});

// 管理画面（統合版）
app.get('/admin', requireAuth.page, (req, res) => {
  if (!req.session.user.is_admin) {
    return res.status(403).send('Forbidden');
  }
  res.render('admin', { user: req.session.user });
});

// 設定ページ（ログイン必須）
app.get('/settings', requireAuth.page, (req, res) => {
  res.render('settings', { user: req.session.user });
});


// ログアウト
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.cookie('manual_logout', '1', { maxAge: 1000 * 60 * 60 * 24 });
    res.redirect('/');
  });
});

// データベース初期化とサーバー起動
initDatabase()
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`🚀 かい鯖グループポイントサーバー起動！`);
      console.log(`📍 http://localhost:${PORT}`);
      console.log(`🔗 Discourse: ${process.env.DISCOURSE_URL}`);
    });

    // ─── 期限切れ取引の自動処理ジョブ ────────────────────────────────────
    const EXPIRE_INTERVAL_MS = 2 * 60 * 1000;
    const expireJob = setInterval(async () => {
      try {
        const count = await PendingTransaction.expireStale();
        if (count > 0) {
          console.log(`⏰ ${count}件の期限切れ取引を expired に更新しました`);
        }
      } catch (err) {
        console.error('⚠️ 期限切れ取引更新ジョブエラー:', err.message);
      }
    }, EXPIRE_INTERVAL_MS);
    console.log(`⏰ 期限切れ取引ジョブ開始 (${EXPIRE_INTERVAL_MS / 1000}秒間隔)`);

    // ─── サブスクリプション 猶予超過監視ジョブ ───────────────────────────────
    // 課金自体はアプリ側が POST /api/server/subscription/:id/charge を叩くことで実行される。
    // このジョブは猶予期間（interval_days分）超過でも課金されなかった場合に suspended に変更するだけ。
    const SUB_INTERVAL_MS = 5 * 60 * 1000;
    const subscriptionJob = setInterval(async () => {
      try {
        const { suspended } = await Subscription.suspendOverdue();
        if (suspended > 0) {
          console.log(`⚠️ サブスク猶予超過ジョブ: ${suspended}件をsuspendedに変更`);
        }
      } catch (err) {
        console.error('⚠️ サブスク猶予超過ジョブエラー:', err.message);
      }
    }, SUB_INTERVAL_MS);
    console.log(`⚠️ サブスク猶予超過監視ジョブ開始 (${SUB_INTERVAL_MS / 1000}秒間隔)。課金はアプリ側が /charge を叩くことで実行されます。`);

    // ─── Graceful Shutdown (優雅な停止) ──────────────────────────────────
    function gracefulShutdown(signal) {
      console.log(`\n🛑 ${signal} 受信。サーバーを停止します...`);
      
      server.close(async () => {
        console.log('門 HTTPサーバーが正常に終了しました。');
        clearInterval(expireJob);
        clearInterval(subscriptionJob);
        try {
          const { pool } = require('./src/config/database');
          await pool.end();
          console.log('🐘 データベース接続プールを正常にクローズしました。');
          process.exit(0);
        } catch (err) {
          console.error('❌ シャットダウン中にエラーが発生しました:', err);
          process.exit(1);
        }
      });

      setTimeout(() => {
        console.error('⚠️ シャットダウンがタイムアウトしたため、強制終了します。');
        process.exit(1);
      }, 10000);
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  })
  .catch(err => {
    console.error('❌ データベース初期化エラー:', err);
    process.exit(1);
  });