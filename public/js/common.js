'use strict';
/* common.js — 全ページ共通のクライアントサイドロジック */

// ── ユーティリティ ──────────────────────────────
window.sendBrowserNotification = function(title, body) {
  if (localStorage.getItem('notifications_enabled') !== 'true') return;
  if (Notification.permission !== 'granted') return;
  try { new Notification(title, { body }); } catch { /* ignore */ }
};

function $(id) { return document.getElementById(id); }

// ── ユーザーメニュードロップダウン ──────────────────────────────
(function () {
  const menu    = $('user-menu');
  const trigger = $('user-menu-trigger');
  if (!menu || !trigger) return;

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    menu.classList.toggle('is-open');
  });
  document.addEventListener('click', function () {
    menu.classList.remove('is-open');
  });
}());

// ── 通報モーダル ─────────────────────────────────────────────────
(function () {
  const modal = $('report-modal');
  const form  = $('report-form');
  const btn   = $('report-btn');
  const close = $('report-modal-close');
  const cancel = $('report-cancel-btn');
  if (!modal || !form) return;

  function openReportModal() {
    modal.classList.add('is-open');
    $('user-menu')?.classList.remove('is-open');
  }
  function closeReportModal() {
    modal.classList.remove('is-open');
    form.reset();
    const msgEl = $('report-msg');
    if (msgEl) { msgEl.className = 'alert'; msgEl.textContent = ''; }
  }
  function showReportMsg(type, text) {
    const el = $('report-msg');
    if (!el) return;
    const alertType = type === 'error' ? 'error' : 'success';
    el.className = `alert alert--${alertType} is-visible`;
    el.textContent = text;
  }

  btn?.addEventListener('click', openReportModal);
  close?.addEventListener('click', closeReportModal);
  cancel?.addEventListener('click', closeReportModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeReportModal(); });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const msgEl = $('report-msg');
    if (msgEl) { msgEl.className = 'alert'; msgEl.textContent = ''; }

    const category  = $('report-category').value;
    const desc      = $('report-desc').value.trim();
    const submitBtn = $('report-submit-btn');

    if (!category)        { showReportMsg('error', 'カテゴリを選択してください'); return; }
    if (desc.length < 20) { showReportMsg('error', `説明は20文字以上必要です（現在: ${desc.length}文字）`); return; }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 送信中...';

    try {
      const res  = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, description: desc }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      showReportMsg('success', data.message);
      setTimeout(closeReportModal, 2000);
    } catch (err) {
      showReportMsg('error', err.message || 'エラーが発生しました');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-flag"></i> 送信する';
    }
  });
}());

// ── SPAエンジン & 読み込みバー ─────────────────────────────────────
(function () {
  const barContainer = document.createElement('div');
  barContainer.className = 'loading-bar-container';
  const bar = document.createElement('div');
  bar.className = 'loading-bar';
  barContainer.appendChild(bar);
  document.body.appendChild(barContainer);

  let activeIntervals = [];
  const originalSetInterval = window.setInterval;
  window.setInterval = (fn, delay) => {
    const id = originalSetInterval(fn, delay);
    activeIntervals.push(id);
    return id;
  };

  let cardAnimObserver = null;

  function clearPageResources() {
    activeIntervals.forEach(clearInterval);
    activeIntervals = [];

    // Intersection Observer をページ離脱時に切断（メモリリーク防止）
    if (cardAnimObserver) {
      cardAnimObserver.disconnect();
      cardAnimObserver = null;
    }

    const addedScripts = document.querySelectorAll('script[data-spa-script]');
    addedScripts.forEach(s => s.remove());
  }

  let isNavigating = false;
  let progressTimer = null;
  let isBarVisible = false;
  let latestPercent = 0;

  // ── 共通モーダルロジック ──────────────────────────────
  window.confirmModal = (title, message) => {
    return new Promise(resolve => {
      const modal = $('confirm-modal');
      const titleEl = $('confirm-modal-title');
      const bodyEl = $('confirm-modal-body');
      let okBtn = $('confirm-modal-ok');
      let cancelBtn = $('confirm-modal-cancel');

      // クローンを作成して古いイベントリスナーを削除する
      const newOkBtn = okBtn.cloneNode(true);
      const newCancelBtn = cancelBtn.cloneNode(true);
      okBtn.parentNode.replaceChild(newOkBtn, okBtn);
      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
      okBtn = newOkBtn;
      cancelBtn = newCancelBtn;

      titleEl.textContent = title;
      bodyEl.textContent = message;
      cancelBtn.style.display = 'inline-block';
      
      const onOk = () => { close(); resolve(true); };
      const onCancel = () => { close(); resolve(false); };
      const close = () => {
        modal.classList.remove('is-open');
      };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      modal.classList.add('is-open');
    });
  };

  window.alertModal = (title, message) => {
    return new Promise(resolve => {
      const modal = $('confirm-modal');
      const titleEl = $('confirm-modal-title');
      const bodyEl = $('confirm-modal-body');
      const okBtn = $('confirm-modal-ok');
      const cancelBtn = $('confirm-modal-cancel');

      titleEl.textContent = title;
      bodyEl.textContent = message;
      cancelBtn.style.display = 'none';
      
      const onOk = () => {
        modal.classList.remove('is-open');
        okBtn.removeEventListener('click', onOk);
        resolve();
      };

      okBtn.addEventListener('click', onOk);
      modal.classList.add('is-open');
    });
  };

  function setProgress(percent) {
    latestPercent = percent;
    if (percent >= 100) {
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
      if (isBarVisible) {
        bar.style.width = '100%';
        setTimeout(() => {
          bar.style.opacity = '0';
          setTimeout(() => {
            bar.style.width = '0%';
            isBarVisible = false;
          }, 300);
        }, 200);
      }
    } else {
      // 250ms以上かかっている場合のみ表示を開始する（爆速読み込み時のチラつき防止）
      if (!isBarVisible && !progressTimer) {
        progressTimer = setTimeout(() => {
          isBarVisible = true;
          bar.style.opacity = '1';
          bar.style.width = latestPercent + '%';
        }, 250);
      } else if (isBarVisible) {
        bar.style.width = percent + '%';
      }
    }
  }

  async function navigateTo(url, push = true) {
    if (isNavigating) return;
    const currentPath = new URL(window.location.href).pathname;
    const targetPath  = new URL(url, window.location.origin).pathname;
    if (currentPath === targetPath && push) return;

    isNavigating = true;
    setProgress(30);
    const main = document.querySelector('main');
    if (main) main.classList.add('is-loading');

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Fetch failed');
      setProgress(70);

      const html = await res.text();
      const parser = new DOMParser();
      const newDoc = parser.parseFromString(html, 'text/html');

      // ── Headの更新 ──────────────────────────────────
      // タイトル
      document.title = newDoc.title;
      // メタ記述
      const newDesc = newDoc.querySelector('meta[name="description"]')?.content;
      if (newDesc) {
        document.querySelector('meta[name="description"]')?.setAttribute('content', newDesc);
      }
      // ページ固有スタイル（<style> と <link rel="stylesheet">）の入れ替え
      // 前のページでSPAが追加したスタイルを削除
      document.querySelectorAll('style[data-spa-head], link[data-spa-head]').forEach(el => el.remove());
      // 新しいページのヘッドからスタイルを抽出して追加
      newDoc.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(el => {
        // すでにベースにあるものはスキップ（共通CSSなど）
        if (el.href && (el.href.includes('common.css') || el.href.includes('all.min.css'))) return;
        
        const clone = el.cloneNode(true);
        clone.setAttribute('data-spa-head', 'true');
        document.head.appendChild(clone);
      });

      // ヘッダーのアクティブ状態更新
      document.querySelectorAll('.header-item').forEach(item => {
        const itemPath = new URL(item.href, window.location.origin).pathname;
        if (itemPath === targetPath) {
          item.classList.add('is-active');
        } else {
          item.classList.remove('is-active');
        }
      });

      // ── リソースクリア ──────────────────────────────
      clearPageResources();

      // ── コンテンツ差し替え ──────────────────────────
      const newMain = newDoc.querySelector('main');
      if (main && newMain) {
        main.innerHTML = newMain.innerHTML;
        main.className = newMain.className;

        // ── ビューポート内カードのみアニメーション ──────
        // 全カードを非表示状態にしてからObserverで入ったものだけ表示
        const cards = main.querySelectorAll('.card');
        cards.forEach(card => {
          card.style.opacity = '0';
        });

        if (cardAnimObserver) cardAnimObserver.disconnect();
        cardAnimObserver = new IntersectionObserver((entries, obs) => {
          entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const card = entry.target;
            card.style.opacity = '';
            card.classList.add('card--animate-in');
            obs.unobserve(card); // 一度アニメしたら監視終了
          });
        }, { threshold: 0.05 }); // 5%でも見えたら発火

        cards.forEach(card => cardAnimObserver.observe(card));
      }

      // ── スクリプトの再実行 ──────────────────────────
      for (const s of newDoc.querySelectorAll('body script')) {
        const newScript = document.createElement('script');
        newScript.setAttribute('data-spa-script', 'true');

        if (s.src) {
          if (s.src.includes('common.js')) continue;
          // CSP違反を避けるためsrc属性を使用。タイムスタンプで再実行を促す。
          newScript.src = s.src + (s.src.includes('?') ? '&' : '?') + 'spa_ts=' + Date.now();
          document.body.appendChild(newScript);
        } else {
          console.warn('Inline script skipped due to CSP restrictions.');
        }
      }

      if (push) history.pushState({ spa: true }, '', url);
      window.scrollTo(0, 0);
      setProgress(100);

    } catch (err) {
      console.error('SPA Navigation Error:', err);
      if (push) window.location.href = url;
    } finally {
      if (main) main.classList.remove('is-loading');
      isNavigating = false;
    }
  }

  // リンククリックのインターセプト
  document.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (!a || !a.href) return;

    try {
      const url = new URL(a.href, window.location.origin);
      const isInternal = url.origin === window.location.origin;
      const isSpecial = a.target === '_blank' || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey;
      const isAsset = a.href.match(/\.(png|jpg|jpeg|gif|pdf|zip|svg)$/i);
      const isExternalLink = a.href.includes('/logout') || a.href.includes('/auth/'); // 認証系はリロード

      if (isInternal && !isSpecial && !isAsset && !isExternalLink) {
        e.preventDefault();
        navigateTo(a.href);
      }
    } catch (e) {
      // Invalid URL or other issue, let browser handle it
    }
  });

  // ブラウザの戻る・進む対応
  window.addEventListener('popstate', () => {
    navigateTo(window.location.href, false);
  });
  // ── 管理者向け通報通知 ────────────────────────────────
  let lastReportCount = null;
  async function pollReportsCount() {
    try {
      const res = await fetch('/admin/reports/count');
      if (!res.ok) return;
      const data = await res.json();
      
      const lastNotifiedAt = parseInt(localStorage.getItem('admin_last_notified_at') || '0', 10);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      // 初回ロード時はカウントを覚えるだけ
      if (lastReportCount === null) {
        lastReportCount = data.count;
        return;
      }

      // 通知条件: 未処理件数が増えている、かつ(1時間以上経過している or 初めての通知)
      if (data.count > 0 && data.count > lastReportCount) {
        if (now - lastNotifiedAt > oneHour) {
          window.sendBrowserNotification(
            '⚠️ 未処理の通報があります',
            `現在 ${data.count} 件の未処理通報があります。ご確認をお願いします。`
          );
          localStorage.setItem('admin_last_notified_at', now.toString());
        }
      }
      
      lastReportCount = data.count;
    } catch { /* ignore */ }
  }

  // ユーザー情報の取得（キャッシュ付き）
  window.getCurrentUser = (() => {
    let userPromise = null;
    return (forceRefresh = false) => {
      if (!userPromise || forceRefresh) {
        userPromise = fetch('/api/user').then(res => {
          if (!res.ok) {
            if (res.status === 401) location.href = '/';
            if (res.status === 403) location.href = '/logout?manual=1';
            userPromise = null;
            return null;
          }
          return res.json();
        }).catch(() => {
          userPromise = null;
          return null;
        });
      }
      return userPromise;
    };
  })();

  // 初期化時に自分が管理者かチェックしてポーリング開始
  (async () => {
    try {
      const user = await window.getCurrentUser();
      if (user && user.is_admin) {
        pollReportsCount();
        // SPAのクリア対象にならないよう元のsetIntervalを使用
        originalSetInterval(pollReportsCount, 60000); // 1分おきにチェック
      }
    } catch { /* ignore */ }
  })();
}());
