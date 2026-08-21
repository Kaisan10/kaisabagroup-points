{
  'use strict';
  let currentToken = '';

  async function checkLinkStatus() {
    try {
      const response = await fetch('/api/link/status');
      const data = await response.json();

      const statusDisplay = document.getElementById('status-display');
      const linkedStatus = document.getElementById('linked-status');
      const notLinkedStatus = document.getElementById('not-linked-status');

      if (!statusDisplay || !linkedStatus || !notLinkedStatus) return;

      if (data.linked) {
        statusDisplay.className = 'status linked';

        // アイコンとテキストを作成（innerHTMLと各要素のセキュアな属性セットを併用）
        statusDisplay.innerHTML = `
        <div class="status-icon"><i class="fa-solid fa-circle-check"></i></div>
        <div class="status-content">
          <div class="status-text">リンク済み</div>
          <div class="minecraft-id" id="mc-id-display"></div>
        </div>
      `;
        const mcIdDisplay = document.getElementById('mc-id-display');
        if (mcIdDisplay) mcIdDisplay.textContent = data.minecraft_id;

        linkedStatus.style.display = 'block';
        notLinkedStatus.style.display = 'none';
      } else {
        statusDisplay.className = 'status not-linked';
        statusDisplay.innerHTML = `
        <div class="status-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
        <div class="status-content">
          <div class="status-text">リンクされていません</div>
          <div class="status-description">マイクラとリンクすると、ゲーム内でポイントを確認・使用できます</div>
        </div>
      `;
        linkedStatus.style.display = 'none';
        notLinkedStatus.style.display = 'block';
      }
    } catch (err) {
      console.error('ステータス取得エラー:', err);
    }
  }

  async function generateToken() {
    const btn = document.getElementById('generate-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成中...';

    try {
      const response = await fetch('/api/link/generate', { method: 'POST' });
      const data = await response.json();

      if (data.success) {
        currentToken = data.token;
        const command = `/pt link ${data.token}`;
        document.getElementById('command-text').textContent = command;
        document.getElementById('command-display').classList.add('active');
      } else {
        await alertModal('エラー', 'トークン生成に失敗しました');
      }
    } catch (err) {
      console.error('トークン生成エラー:', err);
      await alertModal('エラー', 'エラーが発生しました');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-link"></i> 新しいトークンを発行';
    }
  }

  function copyCommand() {
    const commandText = document.getElementById('command-text');
    if (!commandText) return;
    const text = commandText.textContent;
    navigator.clipboard.writeText(text).then(() => {
      const copyBtn = document.querySelector('.copy-btn');
      if (!copyBtn) return;
      const originalHTML = copyBtn.innerHTML;
      copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> コピー完了！';
      setTimeout(() => {
        copyBtn.innerHTML = originalHTML;
      }, 2000);
    }).catch(async err => {
      console.error('コピー失敗:', err);
      await alertModal('エラー', 'コピーに失敗しました');
    });
  }

  async function unlinkAccount() {
    if (!(await confirmModal('リンク解除', 'マイクラIDのリンクを解除しますか？'))) {
      return;
    }

    try {
      const response = await fetch('/api/link/unlink', { method: 'POST' });
      const data = await response.json();

      if (data.success) {
        await alertModal('完了', 'リンクを解除しました');
        checkLinkStatus();
      }
    } catch (err) {
      console.error('リンク解除エラー:', err);
      await alertModal('エラー', 'エラーが発生しました');
    }
  }

  // 初期化とタイマー
  const init = () => {
    if (!document.getElementById('status-display')) return;

    checkLinkStatus();
    setInterval(checkLinkStatus, 5000);

    // イベントリスナーの登録（インラインハンドラ削除のため）
    const generateBtn = document.getElementById('generate-btn');
    if (generateBtn) generateBtn.addEventListener('click', generateToken);

    const copyBtn = document.querySelector('.copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', copyCommand);

    const unlinkBtn = document.querySelector('#linked-status .btn--danger');
    if (unlinkBtn) unlinkBtn.addEventListener('click', unlinkAccount);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
