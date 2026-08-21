(function() {
  'use strict';
  (async () => {
    function show(id) {
      ['state-loading','state-pending','state-completed','state-expired','state-notfound','state-already']
        .forEach(s => {
          const el = document.getElementById(s);
          if (el) el.style.display = s === id ? '' : 'none';
        });
    }

    const params = new URLSearchParams(location.search);
    const token  = params.get('token') || '';

    if (!token || !/^[0-9a-f]{64}$/.test(token.toLowerCase())) {
      show('state-notfound');
      return;
    }

    try {
      const userRes = await fetch('/api/user');
      if (!userRes.ok) {
        location.href = `/auth/discourse/login?return_to=${encodeURIComponent(location.href)}`;
        return;
      }
    } catch { show('state-notfound'); return; }

    try {
      const statusRes = await fetch(`/api/server/register-status/${token}`);
      if (!statusRes.ok) { show('state-notfound'); return; }
      const { data } = await statusRes.json();

      if (data.status === 'expired')    { show('state-expired'); return; }
      if (data.status === 'completed')  { show('state-already'); return; }

      const nameEl = document.getElementById('display-server-name');
      if (nameEl) nameEl.textContent = data.server_name;
      show('state-pending');
    } catch { show('state-notfound'); return; }

    const confirmBtn = document.getElementById('confirm-btn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        const btn = document.getElementById('confirm-btn');
        const msg = document.getElementById('pending-msg');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 登録中...';
        msg.textContent = '';

        try {
          const res  = await fetch('/api/server/register-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          });
          const data = await res.json();

          if (!data.success) {
            msg.style.cssText = 'color:#dc2626;';
            msg.textContent = data.error || '登録に失敗しました';
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> 登録する';
            return;
          }

          const apiKeyDisplay = document.getElementById('api-key-display');
          if (apiKeyDisplay) apiKeyDisplay.childNodes[0].textContent = data.data.api_key;

          const copyBtn = document.getElementById('api-key-copy-btn');
          if (copyBtn) {
            copyBtn.addEventListener('click', () => {
              navigator.clipboard.writeText(data.data.api_key).then(() => {
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> コピー済み';
              });
            });
          }

          show('state-completed');
        } catch (e) {
          msg.style.cssText = 'color:#dc2626;';
          msg.textContent = 'エラーが発生しました: ' + e.message;
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-check"></i> 登録する';
        }
      });
    }
  })();
})();
