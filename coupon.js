(() => {
  'use strict';
  const AUTH_KEY = 'portal-auth-ok-v1';
  const RESERVATION_KEY = 'coupon-active-reservation-v1';
  const API_BASE = String(window.COUPON_API_BASE || '').replace(/\/$/, '');
  const isUnconfigured = !API_BASE || API_BASE.includes('YOUR_SUBDOMAIN');

  const couponList = document.getElementById('couponList');
  const pageStatus = document.getElementById('pageStatus');
  const addScreen = document.getElementById('addScreen');
  const couponForm = document.getElementById('couponForm');
  const couponType = document.getElementById('couponType');
  const urlFields = document.getElementById('urlFields');
  const imageFields = document.getElementById('imageFields');
  const registrationResult = document.getElementById('registrationResult');
  const registerBtn = document.getElementById('registerBtn');
  const reservationLayer = document.getElementById('reservationLayer');
  const reservationTitle = document.getElementById('reservationTitle');
  const reservationSummary = document.getElementById('reservationSummary');
  const reservationMessage = document.getElementById('reservationMessage');
  const quantitySection = document.getElementById('quantitySection');
  const quantityInput = document.getElementById('quantityInput');
  const reserveBtn = document.getElementById('reserveBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const useActions = document.getElementById('useActions');
  const confirmActions = document.getElementById('confirmActions');
  const closeReservationBtn = document.getElementById('closeReservationBtn');
  let selectedCoupon = null;
  let activeReservation = loadReservation();
  let countdownTimer = null;

  if (localStorage.getItem(AUTH_KEY) !== '1') {
    location.replace('./');
    return;
  }

  function setPageStatus(message, error = false) {
    pageStatus.textContent = message;
    pageStatus.classList.toggle('is-error', error);
  }

  function setReservationMessage(message, error = false) {
    reservationMessage.textContent = message;
    reservationMessage.classList.toggle('is-error', error);
  }

  async function api(path, options = {}) {
    if (isUnconfigured) throw new Error('Cloudflare WorkerのURLが未設定です。README_COUPON.mdを確認してください。');
    const response = await fetch(`${API_BASE}${path}`, options);
    const type = response.headers.get('Content-Type') || '';
    if (!response.ok) {
      const body = type.includes('application/json') ? await response.json() : {};
      throw new Error(body.error || `通信エラー（${response.status}）`);
    }
    return type.includes('application/json') ? response.json() : response;
  }

  async function loadCoupons() {
    if (isUnconfigured) {
      setPageStatus('Cloudflare側の設定後にクーポン一覧を利用できます。', true);
      renderCoupons([]);
      return;
    }
    setPageStatus('読み込み中...');
    try {
      const data = await api('/api/coupons');
      renderCoupons(data.coupons || []);
      setPageStatus(data.coupons?.length ? '' : '登録済みクーポンはありません。');
    } catch (error) {
      setPageStatus(error.message, true);
      renderCoupons([]);
    }
  }

  function renderCoupons(coupons) {
    couponList.innerHTML = '';
    for (const coupon of coupons) couponList.appendChild(createCouponCard(coupon));
    if (!coupons.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-card';
      empty.textContent = 'クーポンがありません';
      couponList.appendChild(empty);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add-card';
    add.innerHTML = '＋<span>クーポンを追加</span>';
    add.addEventListener('click', openAddScreen);
    couponList.appendChild(add);
  }

  function createCouponCard(coupon) {
    const article = document.createElement('article');
    article.className = 'coupon-card';
    const image = document.createElement('img');
    image.className = 'coupon-cover';
    image.src = coupon.coverUrl;
    image.alt = `${coupon.name}の代表画像`;
    image.loading = 'lazy';
    image.addEventListener('error', () => { image.alt = '代表画像を表示できません'; });

    const info = document.createElement('div');
    info.className = 'coupon-info';
    const title = document.createElement('h2');
    title.className = 'coupon-name';
    title.textContent = coupon.name;
    const meta = document.createElement('div');
    meta.className = 'coupon-meta';
    const type = document.createElement('span');
    type.className = 'coupon-type';
    type.textContent = coupon.type === 'url' ? 'URL型' : '画像型';
    const total = document.createElement('span');
    total.className = 'coupon-total';
    total.textContent = `残り ${coupon.remainingCount}枚`;
    meta.append(type, total);

    const expiryList = document.createElement('div');
    expiryList.className = 'expiry-list';
    for (const expiry of coupon.expiries) {
      if (expiry.remainingCount <= 0) continue;
      const row = document.createElement('div');
      row.className = 'expiry-row';
      const date = document.createElement('span');
      date.textContent = `期限 ${formatDate(expiry.expiresOn)}`;
      const count = document.createElement('span');
      count.textContent = `${expiry.remainingCount}枚`;
      row.append(date, count);
      expiryList.appendChild(row);
    }
    if (coupon.availableCount < coupon.remainingCount) {
      const availability = document.createElement('div');
      availability.className = 'availability';
      availability.textContent = `現在利用可能 ${coupon.availableCount}枚`;
      expiryList.appendChild(availability);
    }
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'use-btn';
    use.textContent = coupon.availableCount ? '利用する' : '予約中';
    use.disabled = !coupon.availableCount || Boolean(activeReservation);
    use.addEventListener('click', () => openReservationChoice(coupon));
    info.append(title, meta, expiryList, use);
    article.append(image, info);
    return article;
  }

  function formatDate(value) {
    const [year, month, day] = value.split('-');
    return `${year}/${month}/${day}`;
  }

  function openAddScreen() {
    if (activeReservation) {
      setPageStatus('予約中のクーポンを完了またはキャンセルしてください。', true);
      return;
    }
    addScreen.classList.add('is-open');
    addScreen.setAttribute('aria-hidden', 'false');
    history.pushState({ screen: 'add' }, '');
  }

  function closeAddScreen(fromHistory = false) {
    addScreen.classList.remove('is-open');
    addScreen.setAttribute('aria-hidden', 'true');
    if (!fromHistory && history.state?.screen === 'add') history.back();
  }

  function updateTypeFields() {
    const image = couponType.value === 'image';
    urlFields.hidden = image;
    imageFields.hidden = !image;
    urlFields.querySelector('textarea').required = !image;
    imageFields.querySelector('input').required = image;
  }

  couponForm.addEventListener('submit', async event => {
    event.preventDefault();
    registrationResult.textContent = '重複を確認して登録中...';
    registrationResult.classList.remove('is-error');
    registerBtn.disabled = true;
    try {
      const result = await api('/api/coupons/register', { method: 'POST', body: new FormData(couponForm) });
      registrationResult.textContent = `新規 ${result.newCount}件 / 重複 ${result.duplicateCount}件`;
      if (result.newCount > 0) {
        couponForm.reset();
        updateTypeFields();
        await loadCoupons();
      }
    } catch (error) {
      registrationResult.textContent = error.message;
      registrationResult.classList.add('is-error');
    } finally {
      registerBtn.disabled = false;
    }
  });

  function openReservationChoice(coupon) {
    selectedCoupon = coupon;
    reservationLayer.classList.add('is-open');
    reservationTitle.textContent = coupon.name;
    reservationSummary.innerHTML = coupon.type === 'image'
      ? `<div>クーポン使用 <span id="quantityLabel">1枚</span></div><div>利用可能 ${coupon.availableCount}枚</div>`
      : '<div>URLを1件予約します</div>';
    quantitySection.hidden = coupon.type !== 'image';
    quantityInput.value = '1';
    quantityInput.max = String(coupon.availableCount);
    reserveBtn.hidden = false;
    downloadBtn.hidden = true;
    useActions.hidden = true;
    confirmActions.hidden = true;
    closeReservationBtn.hidden = false;
    setReservationMessage('');
  }

  function closeReservationDialog() {
    if (activeReservation) return;
    selectedCoupon = null;
    reservationLayer.classList.remove('is-open');
    stopCountdown();
  }

  async function reserveSelected() {
    if (!selectedCoupon) return;
    const quantity = selectedCoupon.type === 'url' ? 1 : clampQuantity();
    reserveBtn.disabled = true;
    setReservationMessage('10分間の予約を確保しています...');
    const targetWindow = selectedCoupon.type === 'url' ? window.open('about:blank', '_blank') : null;
    try {
      const reservation = await api(`/api/coupons/${encodeURIComponent(selectedCoupon.id)}/reserve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity })
      });
      activeReservation = reservation;
      saveReservation(reservation);
      showActiveReservation();
      if (targetWindow && reservation.targetUrl) {
        targetWindow.opener = null;
        targetWindow.location.replace(reservation.targetUrl);
      } else if (reservation.type === 'url' && reservation.targetUrl) {
        window.open(reservation.targetUrl, '_blank', 'noopener,noreferrer');
      }
      await loadCoupons();
    } catch (error) {
      if (targetWindow) targetWindow.close();
      setReservationMessage(error.message, true);
    } finally {
      reserveBtn.disabled = false;
    }
  }

  function showActiveReservation() {
    if (!activeReservation) return;
    reservationLayer.classList.add('is-open');
    reservationTitle.textContent = activeReservation.couponName || '予約中のクーポン';
    reservationSummary.innerHTML = `<div>${activeReservation.type === 'url' ? 'URL 1件' : `クーポン使用 ${activeReservation.quantity}枚`}</div><div class="countdown" id="countdown"></div>`;
    quantitySection.hidden = true;
    reserveBtn.hidden = true;
    downloadBtn.hidden = activeReservation.type !== 'image';
    useActions.hidden = activeReservation.status !== 'reserved';
    confirmActions.hidden = activeReservation.status !== 'pending_confirmation';
    closeReservationBtn.hidden = true;
    setReservationMessage(activeReservation.type === 'image' ? '画像を保存してから「利用した」を押してください。' : '利用後、この画面に戻って「利用した」を押してください。');
    startCountdown();
  }

  async function restoreReservation() {
    if (!activeReservation) return;
    try {
      const status = await api(`/api/reservations/${encodeURIComponent(activeReservation.reservationId)}`, { headers: reservationHeaders() });
      if (!['reserved', 'pending_confirmation'].includes(status.status)) throw new Error('予約は終了しました。');
      activeReservation = { ...activeReservation, ...status };
      saveReservation(activeReservation);
      showActiveReservation();
    } catch {
      clearReservation();
      reservationLayer.classList.remove('is-open');
      setPageStatus('予約は終了しました。一覧を更新しました。');
    }
  }

  async function markUsed() {
    await reservationAction('used', result => {
      activeReservation.status = result.status;
      saveReservation(activeReservation);
      showActiveReservation();
      setReservationMessage('本当に使用済みにする場合は「確認」を押してください。');
    });
  }

  async function confirmUse() {
    await reservationAction('confirm', async result => {
      clearReservation();
      reservationLayer.classList.remove('is-open');
      setPageStatus(`${result.deletedCount}件を使用済みにしました。`);
      await loadCoupons();
    });
  }

  async function cancelReservation() {
    await reservationAction('cancel', async () => {
      clearReservation();
      reservationLayer.classList.remove('is-open');
      setPageStatus('予約をキャンセルしました。');
      await loadCoupons();
    });
  }

  async function reservationAction(action, onSuccess) {
    if (!activeReservation) return;
    setReservationMessage('処理中...');
    setReservationButtonsDisabled(true);
    try {
      const result = await api(`/api/reservations/${encodeURIComponent(activeReservation.reservationId)}/${action}`, {
        method: 'POST', headers: reservationHeaders()
      });
      await onSuccess(result);
    } catch (error) {
      setReservationMessage(error.message, true);
      if (error.message.includes('予約時間')) {
        clearReservation();
        setTimeout(() => { reservationLayer.classList.remove('is-open'); loadCoupons(); }, 900);
      }
    } finally {
      setReservationButtonsDisabled(false);
    }
  }

  async function downloadImages() {
    if (!activeReservation) return;
    downloadBtn.disabled = true;
    setReservationMessage('画像ZIPを作成しています...');
    try {
      const response = await api(`/api/reservations/${encodeURIComponent(activeReservation.reservationId)}/download`, { headers: reservationHeaders() });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `coupon-images-${activeReservation.reservationId.slice(0, 8)}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setReservationMessage('画像ZIPを保存しました。「利用した」を押してください。');
    } catch (error) {
      setReservationMessage(error.message, true);
    } finally {
      downloadBtn.disabled = false;
    }
  }

  function reservationHeaders() {
    return { 'X-Reservation-Token': activeReservation?.token || '' };
  }

  function startCountdown() {
    stopCountdown();
    const tick = () => {
      if (!activeReservation) return;
      const remaining = Math.max(0, Number(activeReservation.expiresAt) - Math.floor(Date.now() / 1000));
      const target = document.getElementById('countdown');
      if (target) target.textContent = `予約残り ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
      if (!remaining) {
        clearReservation();
        reservationLayer.classList.remove('is-open');
        setPageStatus('10分が経過したため予約を解除しました。');
        loadCoupons();
      }
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function stopCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function saveReservation(value) {
    localStorage.setItem(RESERVATION_KEY, JSON.stringify(value));
  }

  function loadReservation() {
    try { return JSON.parse(localStorage.getItem(RESERVATION_KEY) || 'null'); } catch { return null; }
  }

  function clearReservation() {
    activeReservation = null;
    localStorage.removeItem(RESERVATION_KEY);
    stopCountdown();
  }

  function clampQuantity() {
    const max = Number(quantityInput.max) || 1;
    const value = Math.min(max, Math.max(1, Math.floor(Number(quantityInput.value) || 1)));
    quantityInput.value = String(value);
    const label = document.getElementById('quantityLabel');
    if (label) label.textContent = `${value}枚`;
    return value;
  }

  function setReservationButtonsDisabled(value) {
    document.querySelectorAll('#reservationLayer button').forEach(button => { button.disabled = value; });
  }

  document.getElementById('homeBtn').addEventListener('click', () => location.href = './');
  document.getElementById('openAddBtn').addEventListener('click', openAddScreen);
  document.getElementById('closeAddBtn').addEventListener('click', () => closeAddScreen());
  document.getElementById('cancelAddBtn').addEventListener('click', () => closeAddScreen());
  couponType.addEventListener('change', updateTypeFields);
  document.getElementById('quantityMinus').addEventListener('click', () => { quantityInput.value = String(clampQuantity() - 1); clampQuantity(); });
  document.getElementById('quantityPlus').addEventListener('click', () => { quantityInput.value = String(clampQuantity() + 1); clampQuantity(); });
  quantityInput.addEventListener('change', clampQuantity);
  reserveBtn.addEventListener('click', reserveSelected);
  downloadBtn.addEventListener('click', downloadImages);
  document.getElementById('usedBtn').addEventListener('click', markUsed);
  document.getElementById('confirmBtn').addEventListener('click', confirmUse);
  document.getElementById('cancelReservationBtn').addEventListener('click', cancelReservation);
  document.getElementById('cancelAfterUsedBtn').addEventListener('click', cancelReservation);
  closeReservationBtn.addEventListener('click', closeReservationDialog);
  reservationLayer.addEventListener('click', event => { if (event.target === reservationLayer) closeReservationDialog(); });
  window.addEventListener('popstate', () => { if (addScreen.classList.contains('is-open')) closeAddScreen(true); });
  window.addEventListener('focus', () => { if (activeReservation) restoreReservation(); });

  updateTypeFields();
  restoreReservation().finally(loadCoupons);
})();
