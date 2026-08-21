(function() {
  'use strict';

  const $ = id => document.getElementById(id);

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  async function loadSuspendedUsers() {
    const tbody = $('suspended-tbody');
    try {
      const res = await fetch('/admin/users/suspended');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      if (data.data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="empty-state">停止中のユーザーはいません</td></tr>';
        return;
      }

      tbody.innerHTML = data.data.map(u => `
        <tr>
          <td>
            <div class="user-cell">
              <img src="${escHtml(u.avatar_url) || 'https://cdn.bac0n.f5.si/img/kg.png'}" class="user-avatar-sm">
              <span>${escHtml(u.username)}</span>
            </div>
          </td>
          <td>${new Date(u.last_login).toLocaleString('ja-JP')}</td>
          <td>
            <button class="btn btn--ghost btn--sm" data-action="unsuspend" data-id="${u.id}" data-name="${u.username}">
              <i class="fa-solid fa-user-check"></i> 停止解除
            </button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="3" class="empty-state text-danger">エラー: ${err.message}</td></tr>`;
    }
  }

  async function loadReports() {
    const tbody = $('reports-tbody');
    try {
      const res = await fetch('/admin/reports');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      if (data.data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">通報はありません</td></tr>';
        return;
      }

      tbody.innerHTML = data.data.map(r => {
        const dateStr = new Date(r.created_at).toLocaleString('ja-JP');
        const dismissBtn = !r.is_dismissed
          ? `<button class="btn btn--primary btn--sm" data-action="dismiss" data-id="${r.id}">
               <i class="fa-solid fa-check"></i> 処理
             </button>`
          : '<span class="text-muted">処理済み</span>';

        const countBadge = r.count > 1 ? `<span class="count-badge">x${r.count}</span>` : '';

        return `
          <tr class="${r.is_dismissed ? 'dismissed' : ''}">
            <td>
               <div class="user-cell">
                 <span>${escHtml(r.reporter_username)}</span>
                 ${r.is_suspended ? '<span class="badge badge--danger" style="font-size:10px">停止中</span>' : ''}
               </div>
            </td>
            <td><span class="badge badge--muted">${r.category === 'scam' ? '詐欺・スパム' : 'その他'}</span></td>
            <td class="description-cell">${countBadge}${escHtml(r.description.trim())}</td>
            <td>${dateStr}</td>
            <td>${dismissBtn}</td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state text-danger">エラー: ${err.message}</td></tr>`;
    }
  }

  async function unsuspend(id, name) {
    if (!(await confirmModal('停止解除の確認', `ユーザー「${name}」の停止を解除しますか？`))) return;
    const res = await fetch(`/admin/users/${id}/unsuspend`, { method: 'PATCH' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    loadSuspendedUsers();
    loadReports(); // 通報側のバッジ更新のため
  }

  async function dismiss(id) {
    if (!(await confirmModal('処理の確認', `この通報（および同一ユーザーからの同一内容）を処理済みにしますか？`))) return;
    const res = await fetch(`/admin/reports/${id}/dismiss`, { method: 'PATCH' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    loadReports();
  }

  async function loadServices() {
    const tbody = $('services-tbody');
    try {
      const res = await fetch('/admin/server/list');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      if (data.data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">サービスは登録されていません</td></tr>';
        return;
      }

      tbody.innerHTML = data.data.map(s => {
        return `
          <tr>
            <td>
               <div style="font-weight: bold;">${escHtml(s.name)}</div>
               <div style="font-size: 12px; color: var(--color-text-muted);">オーナー: ${escHtml(s.owner_username)}</div>
            </td>
            <td>
               <div>${s.is_active ? '<span class="badge badge--success">有効</span>' : '<span class="badge badge--danger">無効</span>'}</div>
               <div style="font-family: monospace; font-size: 12px; margin-top: 4px;">${escHtml(s.api_key_prefix)}...</div>
            </td>
            <td>
               <div style="display: flex; flex-direction: column; gap: 5px; font-size: 12px;">
                 <label><input type="checkbox" id="trusted_${s.id}" ${s.is_trusted ? 'checked' : ''}> 信頼モード有効</label>
                 <input type="text" id="ips_${s.id}" value="${escHtml(s.allowed_ips || '')}" placeholder="許可IP (カンマ区切り/空で無制限)" style="padding: 4px; border: 1px solid #ccc; border-radius: 4px;">
                 <input type="number" id="limit_${s.id}" value="${s.tx_limit || 0}" placeholder="1回の取引上限額" style="padding: 4px; border: 1px solid #ccc; border-radius: 4px;">
               </div>
            </td>
            <td>
               <button class="btn btn--primary btn--sm" data-action="save_trusted" data-id="${s.id}">
                 <i class="fa-solid fa-save"></i> 保存
               </button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state text-danger">エラー: ${err.message}</td></tr>`;
    }
  }

  async function saveTrustedSettings(id) {
    const is_trusted = $(`trusted_${id}`).checked;
    const allowed_ips = $(`ips_${id}`).value.trim();
    const tx_limit = parseInt($(`limit_${id}`).value, 10) || 0;

    try {
      const res = await fetch(`/admin/server/${id}/trusted`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_trusted, allowed_ips, tx_limit })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      alert('保存しました。');
      loadServices();
    } catch (err) {
      alert('エラー: ' + err.message);
    }
  }

  // イベント委譲
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    
    const { action, id, name } = btn.dataset;
    btn.disabled = true;

    try {
      if (action === 'unsuspend') await unsuspend(id, name);
      if (action === 'dismiss') await dismiss(id);
      if (action === 'save_trusted') await saveTrustedSettings(id);
    } catch (err) {
      alert('エラーが発生しました: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // 初期ロード
  loadSuspendedUsers();
  loadReports();
  loadServices();

  // 定期更新（任意）
  setInterval(loadReports, 30000);
})();
