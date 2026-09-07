(() => {
  'use strict';
  const API_BASE = String(window.COUPON_API_BASE || '').replace(/\/$/, '');
  const list = document.getElementById('couponList');
  if (!API_BASE || !list) return;

  function installBackupButton() {
    if (document.getElementById('couponBackupBtn')) return;
    const add = list.querySelector('.add-card');
    if (!add) return;
    const button = document.createElement('button');
    button.id = 'couponBackupBtn';
    button.type = 'button';
    button.className = 'coupon-backup-btn';
    button.textContent = 'バックアップ';
    button.addEventListener('click', chooseBackup);
    add.insertAdjacentElement('afterend', button);
  }

  function chooseBackup() {
    const csv = confirm('バックアップ形式を選択してください。\n\nOK：CSV\nキャンセル：JSON');
    downloadBackup(csv ? 'csv' : 'json');
  }

  async function downloadBackup(format) {
    const button = document.getElementById('couponBackupBtn');
    if (button) { button.disabled = true; button.textContent = '作成中...'; }
    try {
      const response = await fetch(`${API_BASE}/api/backup?format=${encodeURIComponent(format)}`);
      if (!response.ok) {
        let message = `通信エラー（${response.status}）`;
        try { message = (await response.json()).error || message; } catch {}
        throw new Error(message);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] || `coupon-backup.${format}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      alert(`バックアップに失敗しました。\n${error.message}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = 'バックアップ'; }
    }
  }

  const style = document.createElement('style');
  style.textContent = '.coupon-backup-btn{width:100%;min-height:46px;margin-top:8px;border:2px solid var(--btn);border-radius:12px;background:var(--card);color:var(--text);font:inherit;font-weight:700}.coupon-backup-btn:disabled{opacity:.55}';
  document.head.appendChild(style);

  new MutationObserver(installBackupButton).observe(list, { childList: true, subtree: true });
  installBackupButton();
})();
