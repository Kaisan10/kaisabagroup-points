document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const $ = id => document.getElementById(id);

  if (!code) {
    $('loading-area').style.display = 'none';
    $('error-area').style.display = 'block';
    $('error-message').textContent = 'ギフトコードが指定されていません。';
    return;
  }

  // XSS対策ユーティリティ
  const escHtml = str => {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  // ギフト情報取得
  fetch(`/api/redeem/gift/info?code=${encodeURIComponent(code)}`, { credentials: 'same-origin' })
    .then(r => r.json())
    .then(data => {
      $('loading-area').style.display = 'none';
      if (data.success) {
        $('gift-area').style.display = 'block';
        $('gift-sender').textContent = data.data.sender_username;
        $('gift-title').textContent = data.data.title;
        $('gift-points').textContent = data.data.points.toLocaleString();
        
        // メモがある場合は保存しておく（受け取り後に表示）
        if (data.data.memo) {
          $('gift-memo').textContent = data.data.memo;
        }
      } else {
        $('error-area').style.display = 'block';
        $('error-message').textContent = data.error || 'エラーが発生しました';
      }
    })
    .catch(err => {
      $('loading-area').style.display = 'none';
      $('error-area').style.display = 'block';
      $('error-message').textContent = 'サーバー通信エラーが発生しました。';
    });

  // 受け取り処理
  $('gift-redeem-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = $('gift-redeem-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 処理中...';

    fetch('/api/redeem/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code })
    })
    .then(r => r.ok ? r.json() : r.json().then(d => { throw new Error(d.error || 'エラーが発生しました'); }))
    .then(data => {
      if (data.success) {
        // 成功
        btn.style.display = 'none';
        $('success-actions').style.display = 'block';
        
        // メモがあれば表示
        if ($('gift-memo').textContent.trim() !== '') {
          $('gift-message-area').style.display = 'block';
        }
      } else {
        throw new Error(data.error);
      }
    })
    .catch(err => {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-envelope-open-text"></i> ギフトを受け取る';
      alert('エラー: ' + err.message);
    });
  });
});
