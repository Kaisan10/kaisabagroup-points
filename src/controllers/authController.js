const { generateLoginUrl, parseDiscourseResponse } = require('../utils/discourse');
const User = require('../models/User');

// Discourseログインを開始
async function startDiscourseLogin(req, res) {
  try {
    // コールバックURL（このサイトのURL）
    const returnUrl = `${process.env.SITE_URL}/auth/discourse/callback`;
    const { url, nonce } = generateLoginUrl(returnUrl);
    
    // nonceをセッションに保存（検証用）
    req.session.discourse_nonce = nonce;
    
    console.log(`🔐 Discourseログイン開始: ${url}`);
    
    // Discourseのログインページにリダイレクト
    res.redirect(url);
  } catch (err) {
    console.error('❌ Discourseログイン開始エラー:', err);
    res.status(500).send('ログイン処理でエラーが発生しました');
  }
}

// Discourseからのコールバック処理
async function handleDiscourseCallback(req, res) {
  try {
    const { sso, sig } = req.query;

    if (!sso || !sig) {
      return res.status(400).send('不正なリクエストです');
    }

    console.log('🔍 Discourseからのコールバック受信');

    // Discourseからのレスポンスをパース・検証
    const discourseData = parseDiscourseResponse(sso, sig);

    console.log('✅ 署名検証成功:', discourseData.username);

    // nonce検証
    if (!req.session.discourse_nonce || discourseData.nonce !== req.session.discourse_nonce) {
      console.warn('⚠️ Nonce不一致または紛失');
      return res.status(403).send('認証セッションがタイムアウトしたか、不正なリクエストです。もう一度やり直してください。');
    }

    // ユーザーを検索または作成
    const user = await User.findOrCreateByDiscourse(discourseData);

    // セッション固定化対策: ID再生成
    await new Promise((resolve, reject) => {
      req.session.regenerate(err => err ? reject(err) : resolve());
    });

    // セッションにユーザー情報を保存
    req.session.user = {
      id: user.id,
      discourse_id: user.discourse_id,
      username: user.username,
      email: user.email,
      avatar_url: user.avatar_url,
      total_points: user.total_points,
      is_suspended: user.is_suspended,
      is_admin: user.is_admin === true
    };

    // 手動ログアウトCookieをクリア
    res.clearCookie('manual_logout');


    // nonceをクリア
    delete req.session.discourse_nonce;

    console.log(`✅ ログイン成功: ${user.username}`);
    
    // ダッシュボードにリダイレクト
    res.redirect('/dashboard');
  } catch (err) {
    console.error('❌ Discourseコールバックエラー:', err);
    res.status(500).send('認証エラーが発生しました。もう一度やり直してください。');
  }
}

module.exports = {
  startDiscourseLogin,
  handleDiscourseCallback
};