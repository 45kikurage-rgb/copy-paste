(() => {
  'use strict';
  const API_BASE = String(window.COUPON_API_BASE || '').replace(/\/$/, '');
  const list = document.getElementById('couponList');
  if (!list || !API_BASE) return;

  let couponData = [];
  let overlay = null;
  let form = null;
  let selected = null;
  let syncing = false;

  async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, options);
    const type = response.headers.get('Content-Type') || '';
    const body = type.includes('application/json') ? await response.json() : null;
    if (!response.ok) throw new Error(body?.error || `通信エラー（${response.status}）`);
    return body;
  }

  async function syncEditButtons() {
    if (syncing) return;
    syncing = true;
    try {
      const data = await api('/api/coupons');
      couponData = data.coupons || [];
      const cards = [...list.querySelectorAll('.coupon-card')];
      cards.forEach((card, index) => {
        const coupon = couponData[index];
        if (!coupon || card.querySelector('.coupon-actions')) return;
        const info = card.querySelector('.coupon-info');
        const useBtn = info?.querySelector('.use-btn');
        if (!info || !useBtn) return;
        const actions = document.createElement('div');
        actions.className = 'coupon-actions';
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'edit-btn';
        editBtn.textContent = '編集';
        editBtn.addEventListener('click', () => openEdit(coupon));
        useBtn.replaceWith(actions);
        actions.append(editBtn, useBtn);
      });
    } catch (error) {
      console.warn('編集ボタンの準備に失敗しました', error);
    } finally {
      syncing = false;
    }
  }

  function buildOverlay() {
    overlay = document.createElement('section');
    overlay.className = 'edit-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <div class="edit-wrap">
        <header class="coupon-top">
          <button class="coupon-back" id="closeEditBtn" type="button">◀ 戻る</button>
          <div class="coupon-title">クーポン編集</div>
          <div></div>
        </header>
        <form class="form-card" id="couponEditForm">
          <label class="field">クーポン名
            <input name="name" id="editName" type="text" maxlength="100" required autocomplete="off">
          </label>
          <label class="field">代表画像
            <input name="coverImage" id="editCover" type="file" accept="image/*">
            <span class="field-note">変更しない場合は選択不要です。</span>
          </label>
          <label class="field">編集する期限
            <select id="editExpirySelect" required></select>
          </label>
          <label class="field">利用期限
            <input name="expiresOn" id="editExpiresOn" type="date" required>
          </label>
          <div class="field">クーポンの種類
            <div class="edit-type" id="editTypeLabel"></div>
          </div>
          <label class="field" id="editUrlField">URLを追加
            <textarea name="urls" id="editUrls" placeholder="追加するURLを1行に1件ずつ貼り付け"></textarea>
            <span class="field-note">既存URLはそのまま残り、ここに入力したURLだけ追加されます。</span>
          </label>
          <label class="field" id="editImageField" hidden>利用用クーポン画像を追加
            <input name="couponImages" id="editImages" type="file" accept="image/*" multiple>
            <span class="field-note">既存画像はそのまま残り、選択した画像だけ追加されます。</span>
          </label>
          <div class="edit-help">期限が複数ある場合は「編集する期限」で対象を選べます。別の期限と同じ日に変更した場合は、その期限にまとめられます。</div>
          <div class="edit-result" id="editResult" aria-live="polite"></div>
          <div class="form-actions">
            <button class="dialog-btn is-soft" id="cancelEditBtn" type="button">キャンセル</button>
            <button class="form-submit" id="saveEditBtn" type="submit">変更を保存</button>
          </div>
          <div class="delete-section">
            <button class="delete-coupon-btn" id="deleteCouponBtn" type="button">このクーポンを削除</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    form = overlay.querySelector('#couponEditForm');
    overlay.querySelector('#closeEditBtn').addEventListener('click', closeEdit);
    overlay.querySelector('#cancelEditBtn').addEventListener('click', closeEdit);
    overlay.querySelector('#deleteCouponBtn').addEventListener('click', deleteSelectedCoupon);
    overlay.querySelector('#editExpirySelect').addEventListener('change', event => {
      overlay.querySelector('#editExpiresOn').value = event.target.value;
    });
    form.addEventListener('submit', saveEdit);
  }

  function openEdit(coupon) {
    if (localStorage.getItem('coupon-active-reservation-v1')) {
      alert('予約中のクーポンを完了またはキャンセルしてから編集してください。');
      return;
    }
    if (!overlay) buildOverlay();
    selected = coupon;
    overlay.querySelector('#editName').value = coupon.name;
    overlay.querySelector('#editCover').value = '';
    overlay.querySelector('#editUrls').value = '';
    overlay.querySelector('#editImages').value = '';
    overlay.querySelector('#editTypeLabel').textContent = coupon.type === 'url' ? 'URL型' : '画像型';
    overlay.querySelector('#editUrlField').hidden = coupon.type !== 'url';
    overlay.querySelector('#editImageField').hidden = coupon.type !== 'image';
    const select = overlay.querySelector('#editExpirySelect');
    select.innerHTML = '';
    for (const expiry of coupon.expiries || []) {
      const option = document.createElement('option');
      option.value = expiry.expiresOn;
      option.textContent = `${formatDate(expiry.expiresOn)}（残り ${expiry.remainingCount}枚）`;
      select.appendChild(option);
    }
    const first = coupon.expiries?.[0]?.expiresOn || '';
    select.value = first;
    overlay.querySelector('#editExpiresOn').value = first;
    overlay.querySelector('#editResult').textContent = '';
    overlay.querySelector('#editResult').classList.remove('is-error');
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function closeEdit() {
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    selected = null;
  }

  async function saveEdit(event) {
    event.preventDefault();
    if (!selected) return;
    const result = overlay.querySelector('#editResult');
    const saveBtn = overlay.querySelector('#saveEditBtn');
    const deleteBtn = overlay.querySelector('#deleteCouponBtn');
    result.textContent = '変更を保存しています...';
    result.classList.remove('is-error');
    saveBtn.disabled = true;
    deleteBtn.disabled = true;
    try {
      const data = new FormData(form);
      data.set('currentExpiresOn', overlay.querySelector('#editExpirySelect').value);
      const response = await api(`/api/coupons/${encodeURIComponent(selected.id)}/edit`, { method: 'POST', body: data });
      result.textContent = response.addedCount
        ? `保存しました。追加 ${response.addedCount}件 / 重複 ${response.duplicateCount}件`
        : '変更を保存しました。';
      setTimeout(() => location.reload(), 450);
    } catch (error) {
      result.textContent = error.message;
      result.classList.add('is-error');
    } finally {
      saveBtn.disabled = false;
      deleteBtn.disabled = false;
    }
  }

  async function deleteSelectedCoupon() {
    if (!selected) return;
    if (localStorage.getItem('coupon-active-reservation-v1')) {
      alert('予約中のクーポンを完了またはキャンセルしてから削除してください。');
      return;
    }
    const ok = confirm(`「${selected.name}」を削除しますか？\n\n登録されているURL・画像・代表画像もすべて削除されます。\nこの操作は元に戻せません。`);
    if (!ok) return;

    const result = overlay.querySelector('#editResult');
    const saveBtn = overlay.querySelector('#saveEditBtn');
    const deleteBtn = overlay.querySelector('#deleteCouponBtn');
    result.textContent = 'クーポンを削除しています...';
    result.classList.remove('is-error');
    saveBtn.disabled = true;
    deleteBtn.disabled = true;
    try {
      await api(`/api/coupons/${encodeURIComponent(selected.id)}`, { method: 'DELETE' });
      result.textContent = 'クーポンを削除しました。';
      setTimeout(() => location.reload(), 350);
    } catch (error) {
      result.textContent = error.message;
      result.classList.add('is-error');
      saveBtn.disabled = false;
      deleteBtn.disabled = false;
    }
  }

  function formatDate(value) {
    const [y, m, d] = String(value).split('-');
    return `${y}/${m}/${d}`;
  }

  const observer = new MutationObserver(() => queueMicrotask(syncEditButtons));
  observer.observe(list, { childList: true, subtree: true });
  syncEditButtons();
})();
