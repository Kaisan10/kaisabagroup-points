{
  'use strict';

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  function refreshPoints() {
    window.getCurrentUser(true)
      .then(user => {
        if (!user) return;
        const el = $('total-points');
        if (el) el.textContent = user.total_points.toLocaleString();
      })
      .catch(() => { });
  }

  let currentLimit = 10;
  const maxLimit = 200;
  let isLoading = false;

  function formatHistoryRow(item) {
    const d = new Date(item.created_at);
    const pad = n => String(n).padStart(2, '0');
    const isCurrentYear = d.getFullYear() === new Date().getFullYear();
    const dateStr = isCurrentYear ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())}` : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    const dt = `${dateStr} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const cls = item.amount >= 0 ? 'amount-plus' : 'amount-minus';
    const amt = (item.amount >= 0 ? '+' : '') + item.amount;
    const desc = (item.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<tr><td>${dt}</td><td class="${cls}">${amt}</td><td>${desc}</td></tr>`;
  }

  function loadHistory() {
    if (isLoading) return;
    isLoading = true;

    const lmBtn = $('load-more-btn');
    if (lmBtn) { lmBtn.disabled = true; lmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    fetch(`/api/points/history?limit=${currentLimit}`)
      .then(r => { if (!r.ok) throw new Error('failed'); return r.json(); })
      .then(({ items }) => {
        const tbody = $('history-tbody');
        const container = $('load-more-container');
        if (!tbody || !container) return;
        if (!Array.isArray(items)) throw new Error('Invalid');

        if (items.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3" class="empty-state">履歴はまだありません</td></tr>';
          container.style.display = 'none';
          return;
        }
        tbody.innerHTML = items.map(formatHistoryRow).join('');

        if (currentLimit >= maxLimit) {
          container.innerHTML = '<div class="max-limit-notice"><i class="fa-solid fa-info-circle"></i> これ以上の履歴を表示できません</div>';
          container.style.display = 'block';
        } else if (items.length >= currentLimit) {
          container.innerHTML = '<button class="btn btn--primary" id="load-more-btn"><i class="fa-solid fa-chevron-down"></i> もっと見る</button>';
          container.style.display = 'block';
          $('load-more-btn').addEventListener('click', () => { if (!isLoading) { currentLimit += 10; loadHistory(); } });
        } else {
          container.style.display = 'none';
        }
      })
      .catch(() => {
        const t = $('history-tbody');
        if (t) t.innerHTML = '<tr><td colspan="3" class="empty-state text-danger">履歴の取得に失敗しました</td></tr>';
      })
      .finally(() => { isLoading = false; });
  }

  let isRedeeming = false;

  function showRedeemMsg(message, type) {
    const el = $('redeem-message');
    if (!el) return;
    const alertType = type === 'success' ? 'success' : type === 'info' ? 'info' : 'error';
    el.className = `alert alert--${alertType} is-visible mt-16`;
    el.textContent = message;
    if (type === 'success') setTimeout(() => el.classList.remove('is-visible'), 5000);
  }

  // 送り主情報のリセット
  function resetSenderInfo() {
    const el = $('gift-sender-info');
    if (el) el.style.display = 'none';
  }

  // 送り主情報の表示（ギフトコードの場合のみ）
  function showSenderInfo(senderUsername, title, memo) {
    const el = $('gift-sender-info');
    const nameEl = $('gift-sender-name');
    const titleEl = $('gift-sender-title');
    const memoContainer = $('gift-sender-memo-container');
    const memoEl = $('gift-sender-memo');
    
    if (!el || !nameEl || !titleEl || !memoContainer || !memoEl) return;
    
    nameEl.textContent = senderUsername;
    titleEl.textContent = title;
    
    if (memo) {
      memoEl.textContent = memo;
      memoContainer.style.display = 'block';
    } else {
      memoContainer.style.display = 'none';
    }
    
    el.style.display = 'flex';
  }

  function handleRedeem(event) {
    event.preventDefault();
    if (isRedeeming) return;

    const input = $('redeem-code-input');
    const btn = $('redeem-btn');
    if (!input || !btn) return;

    const code = input.value.trim().toUpperCase();
    if (!code) { showRedeemMsg('コードを入力してください', 'error'); return; }
    // ギフトコード(GFT-XXXX-XXXX-XXXX-XXXX)は40文字 ＋ YAMLコードも許可するため50文字まで
    if (code.length > 50) { showRedeemMsg('コードが長すぎます（最大50文字）', 'error'); return; }
    if (!/^[A-Z0-9_-]+$/.test(code)) {
      showRedeemMsg('コードは英数字・ハイフン・アンダースコアのみ使用できます', 'error');
      return;
    }

    isRedeeming = true;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 処理中...';
    $('redeem-message')?.classList.remove('is-visible');
    resetSenderInfo();

    fetch('/api/redeem/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code }),
    })
      .then(r => r.ok ? r.json() : r.json().then(d => { throw new Error(d.error || 'エラーが発生しました'); }))
      .then(data => {
        if (data.success) {
          showRedeemMsg(`✅ ${data.data.points_awarded.toLocaleString()}ポイントを獲得しました！`, 'success');
          input.value = '';
          // ギフトコードの場合は送り主情報を表示
          if (data.data.type === 'gift' && data.data.sender_username) {
            showSenderInfo(data.data.sender_username, data.data.title, data.data.memo);
          }
          refreshPoints();
          currentLimit = 10;
          loadHistory();
        } else {
          showRedeemMsg(`❌ ${data.error || 'エラーが発生しました'}`, 'error');
        }
      })
      .catch(err => showRedeemMsg(`❌ ${err.message || 'サーバーエラー'}`, 'error'))
      .finally(() => {
        isRedeeming = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-gift"></i> 引き換え';
      });
  }

  // ── ギフト作成 ──────────────────────────────────────────────────
  let isCreatingGift = false;

  function showGiftCreateMsg(message, type) {
    const el = $('gift-create-message');
    if (!el) return;
    const alertType = type === 'success' ? 'success' : type === 'info' ? 'info' : 'error';
    el.className = `alert alert--${alertType} is-visible mt-16`;
    el.textContent = message;
  }

  function handleGiftCreate(event) {
    event.preventDefault();
    if (isCreatingGift) return;

    const pointsInput = $('gift-points-input');
    const titleInput  = $('gift-title-input');
    const memoInput   = $('gift-memo-input');
    const btn = $('gift-create-btn');
    if (!pointsInput || !titleInput || !btn) return;

    // クライアント側バリデーション
    const points = parseInt(pointsInput.value, 10);
    const title  = titleInput.value.trim();
    const memo   = memoInput ? memoInput.value.trim() : '';

    if (!Number.isInteger(points) || points <= 0) {
      showGiftCreateMsg('ポイント数は1以上の整数を入力してください', 'error');
      return;
    }
    if (!title) {
      showGiftCreateMsg('タイトルを入力してください', 'error');
      return;
    }
    if (memo.length > 50) {
      showGiftCreateMsg('メモは50文字以内で入力してください', 'error');
      return;
    }
    if (title.length > 10) {
      showGiftCreateMsg('タイトルは10文字以内で入力してください', 'error');
      return;
    }

    // フォーム送信時はモーダルを表示するだけ
    $('gift-confirm-points').textContent = points.toLocaleString();
    $('gift-confirm-title').textContent = title;
    $('gift-confirm-memo').textContent = memo || '（なし）';
    
    // 現在の入力値を保持しておく（作成実行時に使う）
    window.currentGiftRequest = { points, title, memo: memo || undefined };
    
    // モーダルを開く
    const modal = $('gift-confirm-modal');
    if (modal) modal.classList.add('is-open');
  }

  // ── ギフト作成実行（モーダルから呼ばれる） ──────────────────────
  function executeGiftCreate() {
    if (isCreatingGift || !window.currentGiftRequest) return;
    
    const { points, title, memo } = window.currentGiftRequest;
    const btn = $('gift-confirm-submit-btn');
    const modal = $('gift-confirm-modal');
    
    isCreatingGift = true;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 作成中...';
    $('gift-create-message')?.classList.remove('is-visible');
    $('gift-code-result') && ($('gift-code-result').style.display = 'none');

    fetch('/api/redeem/gift/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ points, title, memo }),
    })
      .then(r => r.json())
      .then(data => {
        if (modal) modal.classList.remove('is-open'); // モーダルを閉じる
        
        if (data.success) {
          showGiftCreateMsg('✅ ギフトコードを作成しました！', 'success');
          // コード表示（XSS対策: textContent）
          const codeEl = $('gift-code-value');
          const resultEl = $('gift-code-result');
          if (codeEl && resultEl) {
            codeEl.textContent = data.data.code;
            resultEl.style.display = 'block';
          }
          // フォームリセット
          const pointsInput = $('gift-points-input');
          const titleInput  = $('gift-title-input');
          const memoInput   = $('gift-memo-input');
          if (pointsInput) pointsInput.value = '';
          if (titleInput) titleInput.value  = '';
          if (memoInput) memoInput.value = '';
          const tc = $('gift-title-count'); if (tc) tc.textContent = '0';
          const mc = $('gift-memo-count');  if (mc) mc.textContent = '0';
          refreshPoints();
          currentLimit = 10;
          loadHistory();
        } else {
          showGiftCreateMsg(`❌ ${data.error || 'エラーが発生しました'}`, 'error');
        }
      })
      .catch(() => {
        if (modal) modal.classList.remove('is-open');
        showGiftCreateMsg('❌ サーバーエラーが発生しました', 'error');
      })
      .finally(() => {
        isCreatingGift = false;
        btn.disabled = false;
        btn.innerHTML = '作成する';
        window.currentGiftRequest = null;
      });
  }

  function initGiftConfirmModal() {
    const modal = $('gift-confirm-modal');
    const closeBtn = $('gift-confirm-modal-close');
    const cancelBtn = $('gift-confirm-cancel-btn');
    const submitBtn = $('gift-confirm-submit-btn');
    
    if (!modal || !closeBtn || !cancelBtn || !submitBtn) return;
    
    const closeModal = () => modal.classList.remove('is-open');
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    
    submitBtn.addEventListener('click', executeGiftCreate);
  }

  // ── タブ切り替え ─────────────────────────────────────────────────
  function initGiftTabs() {
    const tabRedeem = $('tab-redeem');
    const tabCreate = $('tab-create');
    const panelRedeem = $('tab-panel-redeem');
    const panelCreate = $('tab-panel-create');
    if (!tabRedeem || !tabCreate || !panelRedeem || !panelCreate) return;

    function activateTab(activeTab, activePanel, inactiveTab, inactivePanel) {
      activeTab.classList.add('is-active');
      activeTab.setAttribute('aria-selected', 'true');
      inactiveTab.classList.remove('is-active');
      inactiveTab.setAttribute('aria-selected', 'false');
      activePanel.style.display = '';
      inactivePanel.style.display = 'none';
    }

    tabRedeem.addEventListener('click', () => activateTab(tabRedeem, panelRedeem, tabCreate, panelCreate));
    tabCreate.addEventListener('click', () => activateTab(tabCreate, panelCreate, tabRedeem, panelRedeem));
  }

  // ── コピーボタン ─────────────────────────────────────────────────
  function initGiftCopyBtn() {
    const copyBtn = $('gift-code-copy-btn');
    if (!copyBtn) return;
    copyBtn.addEventListener('click', () => {
      const codeEl = $('gift-code-value');
      if (!codeEl) return;
      navigator.clipboard.writeText(codeEl.textContent).then(() => {
        copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
        setTimeout(() => { copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 2000);
      }).catch(() => {
        const range = document.createRange();
        range.selectNode(codeEl);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        window.getSelection().removeAllRanges();
      });
    });
  }

  // ── 共有モーダル ──────────────────────────────────────────────────
  function initGiftShare() {
    const shareBtn = $('gift-share-btn');
    const modal = $('gift-share-modal');
    const closeBtn = $('gift-share-modal-close');
    const copyBtn = $('gift-share-copy-btn');
    const urlInput = $('gift-share-url');
    const msgEl = $('gift-share-message');
    const codeEl = $('gift-code-value');

    if (!shareBtn || !modal || !closeBtn || !copyBtn || !urlInput || !msgEl || !codeEl) return;

    // モーダルを開く
    shareBtn.addEventListener('click', () => {
      const code = codeEl.textContent.trim();
      if (!code) return;
      
      const shareUrl = `${window.location.origin}/gift?code=${encodeURIComponent(code)}`;
      urlInput.value = shareUrl;
      msgEl.style.display = 'none';
      modal.classList.add('is-open');
    });

    // 閉じる処理
    const closeModal = () => modal.classList.remove('is-open');
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    // URLをコピー
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(urlInput.value).then(() => {
        msgEl.className = 'alert alert--success is-visible mt-16';
        msgEl.textContent = '✅ URLをコピーしました！';
        msgEl.style.display = 'block';
        setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
      }).catch(() => {
        // フォールバック
        urlInput.select();
        document.execCommand('copy');
        msgEl.className = 'alert alert--success is-visible mt-16';
        msgEl.textContent = '✅ URLをコピーしました！';
        msgEl.style.display = 'block';
        setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
      });
    });
  }

  // ── 文字数カウンター ─────────────────────────────────────────────
  function initCharCounters() {
    [['gift-title-input', 'gift-title-count'], ['gift-memo-input', 'gift-memo-count']].forEach(([inputId, countId]) => {
      const inp = $(inputId);
      const cnt = $(countId);
      if (!inp || !cnt) return;
      inp.addEventListener('input', () => { cnt.textContent = inp.value.length; });
    });
  }

  const notifiedTxIds = new Set();

  async function pollPendingTx() {
    try {
      const res = await fetch('/api/user/tx/pending');
      if (!res.ok) return;
      const data = await res.json();
      renderPendingBanner(data.data || []);
    } catch { /* ignore */ }
  }

  function renderPendingBanner(txs) {
    const banner = $('pending-banner');
    if (!banner) return;
    if (txs.length === 0) { banner.style.display = 'none'; return; }

    const tx = txs[0];
    banner.style.display = '';
    banner.dataset.txId = tx.id;

    const recipientDisplayName = tx.recipient_username ? (tx.recipient_username + ' さん') : tx.server_name;
    const sName = $('pending-server-name');
    const iName = $('pending-item-name');
    const amt = $('pending-amount');
    // URLパラメータのservice_nameがあればそちらを優先（取引元サービスが明示）
    if (sName) sName.textContent = _urlServiceName || recipientDisplayName;
    if (iName) iName.textContent = tx.item_name;
    if (amt) amt.textContent = tx.amount.toLocaleString() + ' pt';

    if (!notifiedTxIds.has(tx.id)) {
      notifiedTxIds.add(tx.id);
      sendBrowserNotification(
        `購入承認リクエスト: ${tx.item_name} (${tx.amount}pt)`,
        `${recipientDisplayName} からのリクエストです`
      );
    }
  }

  // URL パラメータから return_url / service_name を取得
  const _urlParams = new URLSearchParams(window.location.search);
  const _returnUrl = _urlParams.get('return_url') || '';
  const _urlServiceName = _urlParams.get('service_name') || '';

  async function approvePendingTx() {
    const banner = $('pending-banner');
    const txId = banner?.dataset?.txId;
    if (!txId) return;

    const btn = $('pending-approve-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
      const res = await fetch(`/api/user/tx/${txId}/buyer-approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      banner.style.display = 'none';
      // return_url が設定されていればリダイレクト
      if (_returnUrl) {
        window.location.href = _returnUrl;
        return;
      }
      refreshPoints();
      loadHistory();
      await pollPendingTx();
    } catch (e) {
      await alertModal('エラー', '承認に失敗しました: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-check"></i> 承認する';
    }
  }

  async function rejectPendingTx() {
    const banner = $('pending-banner');
    const txId = banner?.dataset?.txId;
    if (!txId) return;
    if (!(await confirmModal('拒否の確認', 'この購入リクエストを断りますか？'))) return;

    const btn = $('pending-reject-btn');
    if (!btn) return;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/user/tx/${txId}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      banner.style.display = 'none';
      await pollPendingTx();
    } catch (e) {
      await alertModal('エラー', '拒否に失敗しました: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  let rankingAllData = [];
  let rankingExpanded = false;
  let rankingPage = 0;
  let rankingPageSize = 10;
  let rankingMyUser = '';

  const _avatarImgCache = new Map();
  function _getAvatarEl(username, url, cls) {
    const k = username + '\x00' + cls;
    if (!_avatarImgCache.has(k)) {
      const img = document.createElement('img');
      img.src = url; img.alt = username; img.className = cls;
      _avatarImgCache.set(k, img);
    }
    return _avatarImgCache.get(k);
  }

  function buildRankingTable(entries) {
    if (!entries || entries.length === 0) {
      const d = document.createElement('div');
      d.className = 'empty-state';
      d.innerHTML = '<p>参加者がいません</p>';
      return d;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'data-table-wrapper';
    const table = document.createElement('table');
    table.className = 'data-table';
    const tbody = document.createElement('tbody');

    for (const entry of entries) {
      const isMe = entry.username === rankingMyUser;
      const tr = document.createElement('tr');
      if (isMe) tr.className = 'row-highlight';

      const td1 = document.createElement('td');
      td1.setAttribute('style', 'text-align:center;width:60px;');
      td1.innerHTML = `<span class="rank-badge">${entry.rank}</span>`;

      const td2 = document.createElement('td');
      const flex = document.createElement('div');
      flex.className = 'flex-center gap-8';
      if (entry.avatar_url) {
        flex.appendChild(_getAvatarEl(entry.username, entry.avatar_url, 'user-avatar-xsm'));
      } else {
        const s = document.createElement('span');
        s.className = 'user-avatar-xsm user-avatar-xsm--fallback';
        s.innerHTML = '<i class="fa-solid fa-user"></i>';
        flex.appendChild(s);
      }
      const nameSpan = document.createElement('span');
      nameSpan.style.fontWeight = '600';
      nameSpan.textContent = entry.username;
      flex.appendChild(nameSpan);
      if (isMe) {
        const badge = document.createElement('span');
        badge.className = 'badge badge--seller';
        badge.style.cssText = 'font-size:11px;padding:1px 7px;';
        badge.textContent = 'あなた';
        flex.appendChild(badge);
      }
      td2.appendChild(flex);

      const td3 = document.createElement('td');
      td3.setAttribute('style', 'text-align:right;white-space:nowrap;');
      td3.innerHTML = `<span class="amount-plus">${entry.total_points.toLocaleString()} pt</span>`;

      tr.append(td1, td2, td3);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  function renderRankingList() {
    const listEl = $('ranking-list');
    if (!listEl) return;

    if (rankingAllData.length === 0) {
      const d = document.createElement('div');
      d.className = 'empty-state';
      d.innerHTML = '<p>参加者がいません</p>';
      listEl.replaceChildren(d);
      return;
    }

    if (rankingExpanded) {
      const total = rankingAllData.length;
      const start = rankingPage * rankingPageSize;
      const end = Math.min(start + rankingPageSize, total);
      listEl.replaceChildren(buildRankingTable(rankingAllData.slice(start, end)));

      const prevBtn = $('ranking-prev-btn');
      const nextBtn = $('ranking-next-btn');
      if (prevBtn) prevBtn.disabled = rankingPage === 0;
      if (nextBtn) nextBtn.disabled = end >= total;

      document.querySelectorAll('.ranking-page-size-btn').forEach(btn => {
        btn.classList.toggle('is-active', parseInt(btn.dataset.size) === rankingPageSize);
      });
    } else {
      const fragment = document.createDocumentFragment();
      fragment.appendChild(buildRankingTable(rankingAllData.slice(0, 3)));

      const myEntry = rankingAllData.find(e => e.username === rankingMyUser);
      if (myEntry && myEntry.rank > 3) {
        const divider = document.createElement('div');
        divider.className = 'mt-8';

        const innerWrapper = document.createElement('div');
        innerWrapper.className = 'data-table-wrapper';
        const table = document.createElement('table');
        table.className = 'data-table';
        const tbody = document.createElement('tbody');

        const tr = document.createElement('tr');
        tr.className = 'row-highlight';

        const td1 = document.createElement('td');
        td1.setAttribute('style', 'text-align:center;width:60px;');
        td1.innerHTML = `<span class="rank-badge">${myEntry.rank}</span>`;

        const td2 = document.createElement('td');
        const flex = document.createElement('div');
        flex.className = 'flex-center gap-8';
        if (myEntry.avatar_url) {
          flex.appendChild(_getAvatarEl(myEntry.username, myEntry.avatar_url, 'user-avatar-xsm'));
        } else {
          const s = document.createElement('span');
          s.className = 'user-avatar-xsm user-avatar-xsm--fallback';
          s.innerHTML = '<i class="fa-solid fa-user"></i>';
          flex.appendChild(s);
        }
        const nameSpan = document.createElement('span');
        nameSpan.style.fontWeight = '600';
        nameSpan.textContent = myEntry.username;
        flex.appendChild(nameSpan);
        const badge = document.createElement('span');
        badge.className = 'badge badge--seller';
        badge.style.cssText = 'font-size:11px;padding:1px 7px;';
        badge.textContent = 'あなた';
        flex.appendChild(badge);
        td2.appendChild(flex);

        const td3 = document.createElement('td');
        td3.setAttribute('style', 'text-align:right;white-space:nowrap;');
        td3.innerHTML = `<span class="amount-plus">${myEntry.total_points.toLocaleString()} pt</span>`;

        tr.append(td1, td2, td3);
        tbody.appendChild(tr);
        table.appendChild(tbody);
        innerWrapper.appendChild(table);
        divider.appendChild(innerWrapper);
        fragment.appendChild(divider);
      }

      listEl.replaceChildren(fragment);
    }
  }

  function toggleRankingExpand() {
    rankingExpanded = !rankingExpanded;

    const btn = $('ranking-expand-btn');
    const pagination = $('ranking-pagination');
    const card = $('ranking-card');
    if (!card) return;

    const startHeight = card.offsetHeight;
    card.style.height = startHeight + 'px';

    if (rankingExpanded) {
      rankingPage = 0;
      if (pagination) pagination.style.display = '';
      if (btn) {
        btn.setAttribute('aria-expanded', 'true');
        btn.innerHTML = '<i class="fa-solid fa-compress"></i>';
      }
      renderRankingList();

      card.offsetHeight;
      card.classList.add('is-animating');
      requestAnimationFrame(() => {
        card.style.height = card.scrollHeight + 'px';
      });

    } else {
      const listEl = $('ranking-list');
      const listHeightBefore = listEl ? listEl.offsetHeight : 0;
      const paginationHeight = pagination ? pagination.offsetHeight : 0;

      if (pagination) pagination.style.display = 'none';
      if (btn) {
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = '<i class="fa-solid fa-expand"></i>';
      }
      renderRankingList();

      const listHeightAfter = listEl ? listEl.scrollHeight : 0;
      const targetHeight = startHeight - paginationHeight - (listHeightBefore - listHeightAfter);

      card.offsetHeight;
      card.classList.add('is-animating');
      requestAnimationFrame(() => {
        card.style.height = Math.max(targetHeight, 0) + 'px';
      });
    }

    setTimeout(() => {
      card.style.height = '';
      card.classList.remove('is-animating');
    }, 400);
  }

  function renderRanking(data, myUser) {
    rankingAllData = data || [];
    rankingMyUser = myUser || '';

    const myRankEl = $('my-rank');
    if (myRankEl) {
      const myEntry = rankingAllData.find(e => e.username === rankingMyUser);
      myRankEl.textContent = myEntry ? `${myEntry.rank}位` : (rankingAllData.length === 0 ? '—' : '-');
    }

    renderRankingList();
  }

  function initRankingControls() {
    $('ranking-expand-btn')?.addEventListener('click', toggleRankingExpand);

    $('ranking-prev-btn')?.addEventListener('click', () => {
      if (rankingPage > 0) { rankingPage--; renderRankingList(); }
    });

    $('ranking-next-btn')?.addEventListener('click', () => {
      if ((rankingPage + 1) * rankingPageSize < rankingAllData.length) {
        rankingPage++;
        renderRankingList();
      }
    });

    document.querySelectorAll('.ranking-page-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        rankingPageSize = parseInt(btn.dataset.size);
        rankingPage = 0;
        renderRankingList();
      });
    });
  }

  async function loadRanking(user) {
    try {
      const res = await fetch('/api/ranking');
      if (!res.ok) throw new Error();
      const { data } = await res.json();
      renderRanking(data || [], user ? user.username : '');
    } catch {
      const listEl = $('ranking-list');
      if (listEl) listEl.innerHTML = `<div class="alert alert--error is-visible">ランキングの取得に失敗しました</div>`;
    }
  }

  const notifiedSubIds = new Set();

  async function pollSubscriptions() {
    try {
      const res = await fetch('/api/user/subscriptions');
      if (!res.ok) return;
      const data = await res.json();
      renderSubPendingBanner(data.data || []);
      renderSubscriptionList(data.data || []);
    } catch { /* ignore */ }
  }

  function renderSubPendingBanner(subs) {
    const banner = $('sub-pending-banner');
    if (!banner) return;
    const pending = subs.filter(s => s.status === 'pending');
    if (pending.length === 0) { banner.style.display = 'none'; return; }

    const sub = pending[0];
    banner.style.display = '';
    banner.dataset.subId = sub.id;

    const body = $('sub-pending-body');
    if (body) {
      body.innerHTML =
        `<strong>${escHtml(sub.server_name)}</strong> から ` +
        `「<strong>${escHtml(sub.product_name || '—')}</strong>」の ` +
        `サブスクリプションが申請されています。<br>` +
        `<span style="color:#531dab;font-weight:700;">` +
        `${Number(sub.amount).toLocaleString()} ポイント / ${sub.interval_days} 日ごと</span> に課金されます。` +
        `<br><small style="color:#888;">最初の課金は同意した時点で即時に行われます。</small>`;
    }

    if (!notifiedSubIds.has(sub.id)) {
      notifiedSubIds.add(sub.id);
      sendBrowserNotification(
        `サブスク承認リクエスト: ${sub.server_name}`,
        `${sub.product_name} — ${Number(sub.amount).toLocaleString()}pt / ${sub.interval_days}日ごと`
      );
    }
  }

  function renderSubscriptionList(subs) {
    const container = $('subscriptions-list');
    if (!container) return;

    // pending はバナーで表示するので一覧からは除外しない（全状態を表示）
    if (subs.length === 0) {
      container.innerHTML = '<p class="empty-state" style="padding:20px 0;">有効なサブスクリプションはありません</p>';
      return;
    }

    const statusLabel = {
      pending: ['badge--pending', '承認待ち'],
      active: ['badge--success', '有効'],
      suspended: ['badge--danger', '停止中（残高不足）'],
    };

    const rows = subs.map(sub => {
      const [badgeCls, label] = statusLabel[sub.status] || ['badge--muted', sub.status];
      const nextCharge = sub.next_charge_at
        ? new Date(sub.next_charge_at).toLocaleDateString('ja-JP')
        : '—';
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px 0;border-bottom:1px solid var(--color-border);">
          <div>
            <div style="font-weight:600;">${escHtml(sub.server_name)}</div>
            <div style="font-size:13px;color:var(--color-text-sub);">
              ${escHtml(sub.product_name || '—')} —
              <span style="color:var(--color-primary);font-weight:600;">${Number(sub.amount).toLocaleString()} pt</span>
              / ${sub.interval_days}日ごと
              ${sub.status === 'active' ? `<span style="color:#888;"> · 次回: ${nextCharge}</span>` : ''}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="badge ${badgeCls}">${label}</span>
            ${sub.status !== 'pending'
          ? `<button class="btn btn--ghost btn--sm sub-cancel-btn" data-sub-id="${sub.id}">
                   <i class="fa-solid fa-xmark"></i> キャンセル
                 </button>`
          : ''}
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `<div>${rows}</div>`;

    container.querySelectorAll('.sub-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => cancelSubscription(Number(btn.dataset.subId)));
    });
  }

  async function approveSubscription() {
    const banner = $('sub-pending-banner');
    const subId = banner?.dataset?.subId;
    if (!subId) return;

    const btn = $('sub-approve-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
      const res = await fetch(`/api/user/subscription/${subId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || (data.data && JSON.stringify(data.data)));
      banner.style.display = 'none';
      refreshPoints();
      loadHistory();
      await pollSubscriptions();
    } catch (e) {
      await alertModal('エラー', 'サブスク承認に失敗しました: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-check"></i> 同意して開始する';
    }
  }

  async function rejectSubPending() {
    const banner = $('sub-pending-banner');
    const subId = banner?.dataset?.subId;
    if (!subId) return;
    if (!(await confirmModal('キャンセルの確認', 'このサブスクリプションをキャンセルしますか？'))) return;

    const btn = $('sub-reject-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/user/subscription/${subId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      banner.style.display = 'none';
      await pollSubscriptions();
    } catch (e) {
      await alertModal('エラー', 'キャンセルに失敗しました: ' + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function cancelSubscription(subId) {
    if (!(await confirmModal('キャンセルの確認', 'このサブスクリプションをキャンセルしますか？'))) return;
    try {
      const res = await fetch(`/api/user/subscription/${subId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      await pollSubscriptions();
    } catch (e) {
      await alertModal('エラー', 'キャンセルに失敗しました: ' + e.message);
    }
  }

  // ── Minecraft連携カードの表示制御 ────────────────────────────
  // /api/link/status で連携状態を確認し、未連携時のみカードを表示する
  async function initMinecraftCard() {
    const card = $('minecraft-link-card');
    if (!card) return;
    try {
      const res = await fetch('/api/link/status');
      if (!res.ok) return;
      const data = await res.json();
      // 未連携（linked=false）のときだけカードと2列グリッドを有効にする
      if (!data.linked) {
        card.style.display = '';
        const grid = $('action-grid');
        if (grid) grid.classList.add('two-col-grid');
      }
    } catch {
      // 取得失敗時はカードを非表示のままにする（表示しない側に倒す）
    }
  }

  // ── アコーディオン初期化 ─────────────────────────────────────
  // 「ポイントの貯め方」アコーディオンのトグル処理
  function initAccordions() {
    document.querySelectorAll('.accordion__trigger').forEach(trigger => {
      const accordion = trigger.closest('.accordion');
      const bodyId = trigger.getAttribute('aria-controls');
      const body = bodyId ? document.getElementById(bodyId) : null;
      if (!accordion || !body) return;

      trigger.addEventListener('click', () => {
        const isOpen = accordion.classList.toggle('is-open');
        trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        body.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
      });
    });
  }

  (async () => {
    if (!$('welcome-message')) return;

    let currentUser = null;
    try {
      currentUser = await window.getCurrentUser();
      if (!currentUser) return;
      const pEl = $('total-points');
      if (pEl) pEl.textContent = currentUser.total_points.toLocaleString();
    } catch { /* ignore */ }

    loadHistory();
    pollPendingTx();
    pollSubscriptions();
    loadRanking(currentUser);
    initRankingControls();
    initMinecraftCard();
    initAccordions();
    setInterval(pollPendingTx, 10000);
    setInterval(pollSubscriptions, 15000);
    setInterval(refreshPoints, 30000);

    $('redeem-form')?.addEventListener('submit', handleRedeem);
    $('gift-create-form')?.addEventListener('submit', handleGiftCreate);
    $('pending-approve-btn')?.addEventListener('click', approvePendingTx);
    $('pending-reject-btn')?.addEventListener('click', rejectPendingTx);
    $('sub-approve-btn')?.addEventListener('click', approveSubscription);
    $('sub-reject-btn')?.addEventListener('click', rejectSubPending);
    initGiftTabs();
    initGiftCopyBtn();
    initGiftShare();
    initGiftConfirmModal();
    initCharCounters();
  })();
}