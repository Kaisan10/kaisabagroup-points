{
  'use strict';
  /* settings.js — 設定ページのフロントエンドロジック */

  // ── ユーティリティ ─────────────────────────────────────────────

  // $ は common.js にあるが、再定義してもブロック内なので安全
  function $(id) { return document.getElementById(id); }

  function showAlert(el, type, msg) {
    el.className = `alert alert--${type} is-visible`;
    el.textContent = msg;
  }

  function hideAlert(el) {
    el.className = 'alert';
    el.textContent = '';
  }

  function statusBadge(status) {
    const map = {
      pending_buyer: ['pending', '買い手待ち'],
      pending_seller: ['seller', '承認待ち'],
      completed: ['success', '完了'],
      rejected: ['danger', '拒否'],
      expired: ['muted', '期限切れ'],
    };
    const [cls, label] = map[status] || ['muted', status];
    return `<span class="badge badge--${cls}">${label}</span>`;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString('ja-JP', {
      month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  // ── サービスアカウント一覧 ────────────────────────────────────

  let myServers = [];
  let selectedServerId = null;

  async function loadServers() {
    const listEl = $('servers-list');
    if (!listEl) return;
    try {
      const res = await fetch('/api/operator/me');
      if (!res.ok) throw new Error('サービスアカウント情報の取得に失敗しました');
      const data = await res.json();
      myServers = data.data || [];
      renderServers();

      if (myServers.length > 0) {
        selectedServerId = myServers[0].id;
        const sPending = $('section-pending');
        const sProducts = $('section-products');
        if (sPending) sPending.style.display = '';
        if (sProducts) sProducts.style.display = '';
        buildServerSelect();
        loadPending();
        loadProducts();
      }
    } catch (e) {
      if (listEl) listEl.innerHTML =
        `<div class="alert alert--error is-visible">${e.message}</div>`;
    }
  }

  function renderServers() {
    const listEl = $('servers-list');
    if (!listEl) return;

    // 作成ボタンの表示制御
    const createBtn = $('create-service-account-btn');
    if (createBtn) {
      const activeCount = myServers.filter(s => s.is_active).length;
      createBtn.style.display = activeCount > 0 ? 'none' : 'inline-block';
    }

    if (myServers.length === 0) {
      listEl.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-server"></i>
        <p>サービスアカウントが登録されていません。</p>
        <p class="text-muted mt-8">
          右上の「＋ 作成」ボタンからサービスアカウントを作成してください。
        </p>
      </div>`;
      return;
    }

    const rows = myServers.map(s => `
    <tr>
      <td class="text-bold">${escHtml(s.name)}</td>
      <td>
        <span class="text-primary text-bold">${s.balance.toLocaleString()} pt</span>
        ${s.balance > 0 ? `<button class="btn btn--ghost btn--sm btn-withdraw-sa ml-8" data-id="${s.id}" data-balance="${s.balance}" title="引き出す"><i class="fa-solid fa-coins"></i> 引き出す</button>` : ''}
      </td>
      <td><code style="font-size:12px;color:var(--color-text-sub);">${escHtml(s.api_key_prefix)}...</code></td>
      <td>${s.is_active
        ? '<span class="badge badge--success">有効</span>'
        : '<span class="badge badge--muted">停止中</span>'}</td>
      <td style="text-align:right;">
        <button class="btn btn--ghost btn--sm btn-edit-oauth" data-id="${s.id}" data-uris="${escHtml(s.redirect_uris || '')}" title="OAuth設定">
          <i class="fa-solid fa-link"></i> OAuth
        </button>
        <button class="btn btn--danger btn--sm btn-delete-sa" data-id="${s.id}" title="削除">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </td>
    </tr>`).join('');

    listEl.innerHTML = `
    <div class="table-wrapper">
      <table class="table">
        <thead><tr>
          <th>サービスアカウント名</th><th>残高</th><th>APIキー識別子</th><th>状態</th><th style="text-align:right;">操作</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

    listEl.querySelectorAll('.btn-delete-sa').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        if (id) deleteServiceAccount(id);
      });
    });

    listEl.querySelectorAll('.btn-edit-oauth').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const uris = e.currentTarget.getAttribute('data-uris');
        if (id) openEditOauthModal(id, uris);
      });
    });

    listEl.querySelectorAll('.btn-withdraw-sa').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const balance = parseInt(e.currentTarget.getAttribute('data-balance'), 10);
        if (id) openWithdrawModal(id, balance);
      });
    });
  }

  // ── サービスアカウント出金 ──────────────────────────────────────

  const withdrawModal = $('withdraw-sa-modal');
  
  function openWithdrawModal(id, balance) {
    $('withdraw-sa-id').value = id;
    $('withdraw-sa-amount').value = '';
    $('withdraw-sa-amount').max = balance;
    $('withdraw-sa-balance-display').textContent = `現在の残高: ${balance.toLocaleString()} pt`;
    hideAlert($('withdraw-sa-msg'));
    withdrawModal.classList.add('is-open');
  }

  $('withdraw-sa-cancel')?.addEventListener('click', () => {
    withdrawModal.classList.remove('is-open');
  });

  $('withdraw-sa-submit')?.addEventListener('click', async () => {
    const id = $('withdraw-sa-id').value;
    const amount = parseInt($('withdraw-sa-amount').value, 10);
    const msg = $('withdraw-sa-msg');
    hideAlert(msg);

    if (!Number.isInteger(amount) || amount <= 0) {
      showAlert(msg, 'error', '正しい引き出し額を入力してください');
      return;
    }

    const btn = $('withdraw-sa-submit');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/operator/service-accounts/${id}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '引き出しに失敗しました');

      withdrawModal.classList.remove('is-open');
      await alertModal('出金完了', data.message);
      
      // 個人残高も更新される可能性があるため、右上のポイント表示などを更新させるためリロードするのが一番確実
      window.location.reload();
    } catch (e) {
      showAlert(msg, 'error', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ── サービスアカウント作成 ＆ 削除 ────────────────────────────────────

  const createModal = $('create-sa-modal');
  const apikeyModal = $('apikey-sa-modal');

  $('create-service-account-btn')?.addEventListener('click', () => {
    $('sa-name-input').value = '';
    hideAlert($('create-sa-msg'));
    createModal.classList.add('is-open');
  });

  $('create-sa-cancel')?.addEventListener('click', () => {
    createModal.classList.remove('is-open');
  });

    $('create-sa-submit')?.addEventListener('click', async () => {
    const name = $('sa-name-input').value.trim();
    const msg = $('create-sa-msg');
    hideAlert(msg);
    if (!name) { showAlert(msg, 'error', '名前を入力してください'); return; }

    const btn = $('create-sa-submit');
    btn.disabled = true;
    try {
      const res = await fetch('/api/operator/service-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '作成に失敗しました');

      createModal.classList.remove('is-open');

      // APIキーを表示
      $('sa-apikey-display').value = data.data.api_key;
      apikeyModal.classList.add('is-open');

      loadServers();
    } catch (e) {
      showAlert(msg, 'error', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('apikey-sa-close')?.addEventListener('click', () => {
    apikeyModal.classList.remove('is-open');
    $('sa-apikey-display').value = ''; // メモリからも消す
  });

  // ── サービスアカウントのOAuth設定編集 ──────────────────────────────────
  const editOauthModal = $('edit-oauth-modal');

  function openEditOauthModal(id, uris) {
    $('edit-oauth-sa-id').value = id;
    $('oauth-client-id-display').textContent = id;
    $('edit-oauth-uris-input').value = uris || '';
    hideAlert($('edit-oauth-msg'));
    editOauthModal.classList.add('is-open');
  }

  $('edit-oauth-cancel')?.addEventListener('click', () => {
    editOauthModal.classList.remove('is-open');
  });

  $('edit-oauth-submit')?.addEventListener('click', async () => {
    const id = $('edit-oauth-sa-id').value;
    const uris = $('edit-oauth-uris-input').value;
    const msg = $('edit-oauth-msg');
    hideAlert(msg);

    const btn = $('edit-oauth-submit');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/operator/service-accounts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: uris }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存に失敗しました');

      editOauthModal.classList.remove('is-open');
      loadServers(); // リスト再描画
    } catch (e) {
      showAlert(msg, 'error', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ── クリックでコピー機能 ─────────────────────────────────────────
  document.querySelectorAll('.copyable-text').forEach(el => {
    el.addEventListener('click', async (e) => {
      const target = e.currentTarget;
      if (target.dataset.copying) return; // 連続クリック防止
      
      const copyType = target.getAttribute('data-copy-type');
      let copyText = '';
      const originalText = target.textContent;
      
      if (copyType === 'id') {
        copyText = target.textContent;
      } else if (copyType === 'url') {
        const path = target.getAttribute('data-copy-value');
        copyText = window.location.origin + path;
      }
      
      if (!copyText) return;

      try {
        await navigator.clipboard.writeText(copyText);
        target.dataset.copying = 'true';
        target.textContent = 'コピーしました！';
        target.style.color = 'var(--color-success)';
        
        setTimeout(() => {
          target.textContent = originalText;
          target.style.color = '';
          delete target.dataset.copying;
        }, 2000);
      } catch (err) {
        console.error('Copy failed', err);
      }
    });
  });

  window.deleteServiceAccount = async function (id) {
    let hasChildren = false;
    try {
      const res = await fetch(`/api/operator/products?server_id=${id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.data && data.data.length > 0) hasChildren = true;
      }
    } catch (e) {
      // ignore
    }

    if (hasChildren) {
      if (!(await confirmModal('削除の確認', 'このサービスアカウントには登録されている商品などがあります。\n削除すると、それらも利用できなくなりますが本当によろしいですか？'))) return;
    } else {
      if (!(await confirmModal('削除の確認', '本当にこのサービスアカウントを削除しますか？'))) return;
    }

    try {
      const res = await fetch(`/api/operator/service-accounts/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '削除に失敗しました');
      loadServers();
    } catch (e) {
      await alertModal('エラー', e.message);
    }
  };

  function buildServerSelect() {
    const sel = $('product-server-select');
    if (!sel) return;
    sel.innerHTML = myServers.map(s =>
      `<option value="${s.id}">${escHtml(s.name)}</option>`
    ).join('');
    sel.value = selectedServerId;
    sel.addEventListener('change', () => {
      selectedServerId = Number(sel.value);
      loadProducts();
    });
    // サーバーが1台のみなら非表示
    if (myServers.length <= 1) sel.style.display = 'none';
  }

  // ── 承認待ち取引 ──────────────────────────────────────────────

  async function loadPending() {
    const pList = $('pending-list');
    if (!pList) return;
    pList.innerHTML =
      '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> 読み込み中...</div>';
    try {
      const res = await fetch('/api/operator/tx/pending');
      if (!res.ok) throw new Error('取引情報の取得に失敗しました');
      const data = await res.json();
      renderPending(data.data || []);
    } catch (e) {
      if (pList) pList.innerHTML =
        `<div class="alert alert--error is-visible">${e.message}</div>`;
    }
  }

  function renderPending(txs) {
    const pList = $('pending-list');
    if (!pList) return;
    if (txs.length === 0) {
      pList.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-check-circle" style="color:var(--color-success);"></i>
        承認待ちの取引はありません
      </div>`;
      return;
    }

    const rows = txs.map(tx => `
    <tr id="tx-row-${tx.id}">
      <td>${escHtml(tx.buyer_username)}<br>
          <span class="text-muted">${escHtml(tx.buyer_mc_id || '-')}</span></td>
      <td class="text-bold">${escHtml(tx.item_name)}</td>
      <td><span class="text-primary text-bold">${tx.amount.toLocaleString()} pt</span></td>
      <td>${statusBadge(tx.status)}</td>
      <td>${fmtDate(tx.expires_at)}</td>
      <td>
        <div class="flex gap-8">
          <button class="btn btn--success btn--sm btn-approve-tx" data-id="${tx.id}">
            <i class="fa-solid fa-check"></i> 承認
          </button>
          <button class="btn btn--danger btn--sm btn-reject-tx" data-id="${tx.id}">
            <i class="fa-solid fa-xmark"></i> 拒否
          </button>
        </div>
      </td>
    </tr>`).join('');

    pList.innerHTML = `
    <div class="table-wrapper">
      <table class="table">
        <thead><tr>
          <th>プレイヤー</th><th>商品</th><th>金額</th><th>状態</th><th>期限</th><th>操作</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

    pList.querySelectorAll('.btn-approve-tx').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        if (id) approveTx(id);
      });
    });

    pList.querySelectorAll('.btn-reject-tx').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        if (id) rejectTx(id);
      });
    });
  }

  window.approveTx = async function (id) {
    if (!(await confirmModal('承認の確認', 'この取引を承認しますか？ポイントが移動します。'))) return;
    try {
      const res = await fetch(`/api/operator/tx/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      // 成功: 行を視覚的に更新
      const row = $(`tx-row-${id}`);
      if (row) row.innerHTML =
        `<td colspan="6" class="text-success text-bold" style="text-align:center;padding:12px;">
        ✅ 承認完了 — ${data.data.amount.toLocaleString()}pt 移動
      </td>`;
      // サーバー残高を再取得
      loadServers();
    } catch (e) {
      await alertModal('エラー', '承認に失敗しました: ' + e.message);
    }
  };

  window.rejectTx = async function (id) {
    if (!(await confirmModal('拒否の確認', 'この取引を拒否しますか？'))) return;
    try {
      const res = await fetch(`/api/operator/tx/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const row = $(`tx-row-${id}`);
      if (row) row.innerHTML =
        `<td colspan="6" class="text-sub" style="text-align:center;padding:12px;">
        拒否しました
      </td>`;
    } catch (e) {
      await alertModal('エラー', '拒否に失敗しました: ' + e.message);
    }
  };

  // ── 商品管理 ──────────────────────────────────────────────────

  let currentProducts = [];

  async function loadProducts() {
    if (!selectedServerId) return;
    const tbody = $('products-tbody');
    if (!tbody) return;
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty-state">読み込み中...</td></tr>';
    try {
      const res = await fetch(`/api/operator/products?server_id=${selectedServerId}`);
      if (!res.ok) throw new Error('商品情報の取得に失敗しました');
      const data = await res.json();
      currentProducts = data.data || [];
      renderProducts();
    } catch (e) {
      if (tbody) tbody.innerHTML =
        `<tr><td colspan="6" class="alert alert--error is-visible">${e.message}</td></tr>`;
    }
  }

  function renderProducts() {
    const tbody = $('products-tbody');
    if (!tbody) return;
    if (currentProducts.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6"><div class="empty-state"><i class="fa-solid fa-box-open"></i>商品がありません</div></td></tr>';
      return;
    }

    tbody.innerHTML = currentProducts.map(p => `
    <tr id="product-row-${p.id}">
      <td class="text-bold text-muted">${p.id}</td>
      <td class="text-bold">${escHtml(p.name)}</td>
      <td><span class="text-primary text-bold">${p.price.toLocaleString()} pt</span></td>
      <td class="text-sub">${escHtml(p.description || '-')}</td>
      <td>${p.is_active
        ? '<span class="badge badge--success">有効</span>'
        : '<span class="badge badge--muted">無効</span>'}</td>
      <td>
        <button class="btn btn--ghost btn--sm btn-toggle-product" data-id="${p.id}" data-active="${!p.is_active}">
          ${p.is_active ? '<i class="fa-solid fa-eye-slash"></i> 無効化' : '<i class="fa-solid fa-eye"></i> 有効化'}
        </button>
      </td>
    </tr>`).join('');

    tbody.querySelectorAll('.btn-toggle-product').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const active = e.currentTarget.getAttribute('data-active') === 'true';
        if (id) toggleProduct(id, active);
      });
    });
  }

  window.toggleProduct = async function (productId, newActive) {
    try {
      const res = await fetch(`/api/operator/products/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: selectedServerId, is_active: newActive }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      loadProducts();
    } catch (e) {
      await alertModal('エラー', '更新に失敗しました: ' + e.message);
    }
  };

  // 商品追加
  $('add-product-btn')?.addEventListener('click', async () => {
    const name = $('product-name').value.trim();
    const price = parseInt($('product-price').value, 10);
    const desc = $('product-desc').value.trim();
    const msg = $('add-product-msg');

    hideAlert(msg);

    if (!name) { showAlert(msg, 'error', '商品名を入力してください'); return; }
    if (!Number.isInteger(price) || price <= 0) {
      showAlert(msg, 'error', '価格は1以上の整数で入力してください'); return;
    }
    if (!selectedServerId) { showAlert(msg, 'error', 'サーバーを選択してください'); return; }

    const btn = $('add-product-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/operator/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: selectedServerId, name, price, description: desc || undefined }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      showAlert(msg, 'success', `「${name}」を追加しました`);
      $('product-name').value = '';
      $('product-price').value = '';
      $('product-desc').value = '';
      loadProducts();
    } catch (e) {
      showAlert(msg, 'error', '追加に失敗しました: ' + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // 承認待ち更新ボタン
  $('refresh-pending-btn')?.addEventListener('click', loadPending);

  // ── XSS対策ヘルパー ───────────────────────────────────────────

  function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ── ブラウザ通知設定 ──────────────────────────────────────────

  function initNotificationSettings() {
    const toggle = $('notif-toggle');
    const warn = $('notif-permission-warn');
    const reqBtn = $('request-notif-btn');
    if (!toggle) return;

    // 保存済み設定を反映
    toggle.checked = localStorage.getItem('notifications_enabled') === 'true';

    function checkPermission() {
      const perm = ('Notification' in window) ? Notification.permission : 'denied';
      if (warn) warn.style.display = (perm !== 'granted') ? 'block' : 'none';
    }
    checkPermission();

    reqBtn?.addEventListener('click', async () => {
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        checkPermission();
        toggle.checked = true;
        localStorage.setItem('notifications_enabled', 'true');
      }
    });

    toggle.addEventListener('change', () => {
      localStorage.setItem('notifications_enabled', toggle.checked ? 'true' : 'false');
    });
  }

  // ── 信頼モード（自動承認）設定 ────────────────────────────────────

  async function initTrustedServers() {
    // ── 信頼サーバー個別一覧の取得と表示 ──
    const listEl = $('trusted-servers-list');
    if (!listEl) return;
    
    try {
      const res = await fetch('/api/user/trusted-servers');
      if (!res.ok) throw new Error('一覧の取得に失敗しました');
      const data = await res.json();
      const servers = data.data || [];

      if (servers.length === 0) {
        listEl.innerHTML = '<div class="empty-state">信頼サーバーは登録されていません。</div>';
      } else {
        const rows = servers.map(s => `
          <div style="display:flex; flex-direction:column; padding:16px; border:1px solid var(--color-border); border-radius:8px; margin-bottom:12px; background:var(--color-surface);">
            <div style="margin-bottom:12px; border-bottom:1px solid var(--color-border); padding-bottom:8px;">
              <p class="text-bold"><i class="fa-solid fa-server text-sub"></i> ${escHtml(s.name)}</p>
            </div>
            <div style="display:flex; flex-direction:column; gap:12px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="text-sub">自動承認</span>
                <label class="toggle-switch">
                  <input type="checkbox" class="server-setting-toggle" data-id="${s.id}" data-type="auto_approve" ${s.auto_approve ? 'checked' : ''}>
                  <span class="toggle-switch__track"></span>
                </label>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="text-sub">操作許可</span>
                <label class="toggle-switch">
                  <input type="checkbox" class="server-setting-toggle" data-id="${s.id}" data-type="delegate_allowed" ${s.delegate_allowed ? 'checked' : ''}>
                  <span class="toggle-switch__track"></span>
                </label>
              </div>
            </div>
          </div>
        `).join('');
        listEl.innerHTML = rows;

        // 個別トグルのイベントリスナー設定
        listEl.querySelectorAll('.server-setting-toggle').forEach(chk => {
          chk.addEventListener('change', async (e) => {
            const serverId = e.target.getAttribute('data-id');
            const type = e.target.getAttribute('data-type');
            const value = e.target.checked;
            e.target.disabled = true;
            try {
              const body = {};
              body[type] = value;
              
              const res = await fetch(`/api/user/trusted-servers/${serverId}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              });
              const data = await res.json();
              if (!data.success) throw new Error(data.error);
            } catch (err) {
              e.target.checked = !value;
              await alertModal('エラー', '設定の保存に失敗しました: ' + err.message);
            } finally {
              e.target.disabled = false;
            }
          });
        });
      }
    } catch (e) {
      listEl.innerHTML = `<div class="alert alert--error is-visible">${e.message}</div>`;
    }
  }

  // ── 連携中のアプリ（OAuth）設定 ────────────────────────────────────

  async function initAuthorizedApps() {
    const listEl = $('authorized-apps-list');
    if (!listEl) return;
    
    try {
      const res = await fetch('/api/user/authorized-apps');
      if (!res.ok) throw new Error('一覧の取得に失敗しました');
      const data = await res.json();
      const apps = data.data || [];

      if (apps.length === 0) {
        listEl.innerHTML = '<div class="empty-state">連携中のアプリはありません。</div>';
      } else {
        const rows = apps.map(app => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:16px; border:1px solid var(--color-border); border-radius:8px; margin-bottom:12px; background:var(--color-surface);">
            <div>
              <p class="text-bold mb-4"><i class="fa-solid fa-link text-primary"></i> ${escHtml(app.app_name)}</p>
              <p class="text-sub" style="font-size:0.9em;">許可スコープ: ${escHtml(app.scopes.replace('identity', 'ユーザー情報').replace('transaction', 'ポイント取引'))}</p>
              <p class="text-muted" style="font-size:0.85em; margin-top:4px;">連携日: ${fmtDate(app.authorized_at)}</p>
            </div>
            <div>
              <button class="btn btn--danger btn--sm btn-revoke-app" data-id="${app.server_id}">
                <i class="fa-solid fa-unlink"></i> 連携解除
              </button>
            </div>
          </div>
        `).join('');
        listEl.innerHTML = rows;

        listEl.querySelectorAll('.btn-revoke-app').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            if (!(await confirmModal('連携解除', 'このアプリとの連携を解除しますか？'))) return;
            const serverId = e.currentTarget.getAttribute('data-id');
            e.currentTarget.disabled = true;
            try {
              const res = await fetch(`/api/user/authorized-apps/${serverId}/revoke`, {
                method: 'POST'
              });
              const data = await res.json();
              if (!data.success) throw new Error(data.error);
              initAuthorizedApps(); // リロード
            } catch (err) {
              await alertModal('エラー', '連携解除に失敗しました: ' + err.message);
              e.currentTarget.disabled = false;
            }
          });
        });
      }
    } catch (e) {
      listEl.innerHTML = `<div class="alert alert--error is-visible">${e.message}</div>`;
    }
  }

  // ヘルプモーダルの制御
  const helpModal = $('trusted-help-modal');
  $('trusted-help-btn')?.addEventListener('click', () => helpModal?.classList.add('is-open'));
  $('trusted-help-close')?.addEventListener('click', () => helpModal?.classList.remove('is-open'));

  // ── ランキング参加設定 ────────────────────────────────────────


  async function initRankingSettings() {
    const toggle = $('ranking-toggle');
    const msg = $('ranking-toggle-msg');
    if (!toggle) return;

    // 現在の設定をAPIから取得
    try {
      const user = await window.getCurrentUser();
      if (user) {
        toggle.checked = user.ranking_opt_in === true;
      }
    } catch { /* ignore */ }

    toggle.addEventListener('change', async () => {
      const optIn = toggle.checked;
      toggle.disabled = true;
      msg.className = 'alert';
      msg.textContent = '';
      try {
        const res = await fetch('/api/user/ranking-opt-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opt_in: optIn }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        msg.className = 'alert alert--success is-visible';
        msg.textContent = optIn ? 'ランキングに参加しました。' : 'ランキングの参加を取り消しました。';
        setTimeout(() => { msg.className = 'alert'; msg.textContent = ''; }, 3000);
      } catch (e) {
        toggle.checked = !optIn; // 元に戻す
        msg.className = 'alert alert--error is-visible';
        msg.textContent = '設定の保存に失敗しました: ' + e.message;
      } finally {
        toggle.disabled = false;
      }
    });
  }

  // ── 初期化 ────────────────────────────────────────────────────

  // ── タブ切り替え ──────────────────────────────────────────────
  // タブボタンとパネルを紐付けてアクティブ状態を管理する
  function initSettingsTabs() {
    const tabs = document.querySelectorAll('.tab__btn');
    const panels = document.querySelectorAll('.tab__panel');

    /**
     * 指定したタブをアクティブにする
     * @param {string} tabId - data-tab 属性の値
     */
    function activateTab(tabId) {
      tabs.forEach(btn => {
        const isActive = btn.dataset.tab === tabId;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      panels.forEach(panel => {
        panel.classList.toggle('is-active', panel.id === `tab-${tabId}`);
      });
      // URLハッシュに保存（戻る・進む・共有に対応）
      history.replaceState(null, '', `#${tabId}`);
    }

    tabs.forEach(btn => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });

    // ページロード時にURLハッシュがあれば対応するタブを開く
    const hash = location.hash.replace('#', '');
    const validTabs = ['account', 'server', 'trusted'];
    if (hash && validTabs.includes(hash)) {
      activateTab(hash);
    }
  }

  (async () => {
    initSettingsTabs();

    // 常に実行する設定項目
    initNotificationSettings();
    await initRankingSettings();
    await initTrustedServers();
    await initAuthorizedApps();

    if (!$('servers-list')) return; // サービスアカウント管理が不要ならここで終了
    await loadServers();
  })();
}
