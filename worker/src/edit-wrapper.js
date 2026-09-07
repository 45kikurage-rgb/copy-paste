import baseWorker, { isOriginAllowed, todayInTokyo } from './index.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ITEMS_PER_EDIT = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const match = path.match(/^\/api\/coupons\/([^/]+)\/edit$/);
    if (request.method === 'POST' && match) {
      try {
        if (!env.COUPON_DB || !env.COUPON_IMAGES) return json(request, env, { error: 'D1/R2 Bindingが未設定です。' }, 500);
        if (!isOriginAllowed(request, env)) return json(request, env, { error: 'このサイトからは利用できません。' }, 403);
        return await editCoupon(request, env, decodeURIComponent(match[1]));
      } catch (error) {
        console.error(error);
        return json(request, env, { error: error?.message || '編集に失敗しました。' }, Number(error?.status) || 500);
      }
    }
    return baseWorker.fetch(request, env);
  }
};

class EditError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function editCoupon(request, env, couponId) {
  const now = Math.floor(Date.now() / 1000);
  const coupon = await env.COUPON_DB.prepare('SELECT id, name, name_key, coupon_type, cover_object_key FROM coupons WHERE id = ?').bind(couponId).first();
  if (!coupon) throw new EditError(404, 'クーポンが見つかりません。');

  const active = await env.COUPON_DB.prepare(`
    SELECT COUNT(*) AS count FROM reservations
    WHERE coupon_id = ? AND status IN ('reserved','pending_confirmation') AND expires_at > ?
  `).bind(couponId, now).first();
  if (Number(active?.count || 0) > 0) throw new EditError(409, 'このクーポンは現在予約中のため編集できません。');

  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const currentExpiresOn = String(form.get('currentExpiresOn') || '');
  const expiresOn = String(form.get('expiresOn') || '');
  const cover = form.get('coverImage');
  if (!name || name.length > 100) throw new EditError(400, 'クーポン名を入力してください。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(currentExpiresOn) || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new EditError(400, '利用期限を確認してください。');
  if (expiresOn < todayInTokyo()) throw new EditError(400, '過去の利用期限には変更できません。');

  const expiry = await env.COUPON_DB.prepare('SELECT id FROM coupon_expiries WHERE coupon_id = ? AND expires_on = ?').bind(couponId, currentExpiresOn).first();
  if (!expiry) throw new EditError(404, '編集対象の期限が見つかりません。');

  const nameKey = normalizeName(name);
  const duplicateName = await env.COUPON_DB.prepare('SELECT id FROM coupons WHERE name_key = ? AND coupon_type = ? AND id <> ?').bind(nameKey, coupon.coupon_type, couponId).first();
  if (duplicateName) throw new EditError(409, '同じ種類・同じ名前のクーポンがすでにあります。');

  let targetExpiryId = expiry.id;
  if (expiresOn !== currentExpiresOn) {
    const existingExpiry = await env.COUPON_DB.prepare('SELECT id FROM coupon_expiries WHERE coupon_id = ? AND expires_on = ?').bind(couponId, expiresOn).first();
    if (existingExpiry) {
      await env.COUPON_DB.batch([
        env.COUPON_DB.prepare('UPDATE coupon_items SET expiry_id = ? WHERE expiry_id = ?').bind(existingExpiry.id, expiry.id),
        env.COUPON_DB.prepare('DELETE FROM coupon_expiries WHERE id = ?').bind(expiry.id)
      ]);
      targetExpiryId = existingExpiry.id;
    } else {
      await env.COUPON_DB.prepare('UPDATE coupon_expiries SET expires_on = ? WHERE id = ?').bind(expiresOn, expiry.id).run();
    }
  }

  let newCoverKey = null;
  if (cover instanceof File && cover.size) {
    validateImage(cover, '代表画像');
    const bytes = await cover.arrayBuffer();
    const hash = await sha256Buffer(bytes);
    newCoverKey = `covers/${couponId}/${hash}.${extensionFor(cover.type)}`;
    await env.COUPON_IMAGES.put(newCoverKey, bytes, { httpMetadata: { contentType: cover.type } });
  }

  await env.COUPON_DB.prepare('UPDATE coupons SET name = ?, name_key = ?, cover_object_key = COALESCE(?, cover_object_key), updated_at = ? WHERE id = ?')
    .bind(name, nameKey, newCoverKey, now, couponId).run();
  if (newCoverKey && coupon.cover_object_key && coupon.cover_object_key !== newCoverKey) await env.COUPON_IMAGES.delete(coupon.cover_object_key);

  const rawItems = coupon.coupon_type === 'url'
    ? parseUrls(String(form.get('urls') || '')).map(value => ({ value }))
    : form.getAll('couponImages').filter(value => value instanceof File && value.size).map(value => ({ value, originalName: value.name, mimeType: value.type }));
  if (rawItems.length > MAX_ITEMS_PER_EDIT) throw new EditError(400, `1回に追加できるのは${MAX_ITEMS_PER_EDIT}件までです。`);
  if (coupon.coupon_type === 'image') rawItems.forEach(item => validateImage(item.value, '利用用画像'));

  const prepared = [];
  const seen = new Set();
  for (const item of rawItems) {
    const fingerprint = coupon.coupon_type === 'url'
      ? await sha256Text(normalizeUrl(item.value))
      : await sha256Buffer(await item.value.arrayBuffer());
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    prepared.push({ ...item, fingerprint });
  }
  const internalDuplicates = rawItems.length - prepared.length;
  const existing = await existingFingerprints(env, prepared.map(item => item.fingerprint));
  const candidates = prepared.filter(item => !existing.has(item.fingerprint));

  let addedCount = 0;
  for (const item of candidates) {
    let urlValue = null;
    let objectKey = null;
    if (coupon.coupon_type === 'url') {
      urlValue = normalizeUrl(item.value);
    } else {
      const bytes = await item.value.arrayBuffer();
      objectKey = `coupon-items/${item.fingerprint}.${extensionFor(item.value.type)}`;
      await env.COUPON_IMAGES.put(objectKey, bytes, { httpMetadata: { contentType: item.value.type } });
    }
    const result = await env.COUPON_DB.prepare(`
      INSERT OR IGNORE INTO coupon_items
        (id, expiry_id, item_type, url_value, object_key, fingerprint, original_name, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), targetExpiryId, coupon.coupon_type, urlValue, objectKey, item.fingerprint, item.originalName || null, item.mimeType || null, now).run();
    addedCount += Number(result.meta?.changes || 0);
  }

  const duplicateCount = internalDuplicates + existing.size + Math.max(0, candidates.length - addedCount);
  return json(request, env, { ok: true, addedCount, duplicateCount, expiresOn });
}

function normalizeName(value) {
  return String(value).normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
}

function validateImage(file, label) {
  if (!String(file.type).startsWith('image/')) throw new EditError(400, `${label}は画像ファイルを選択してください。`);
  if (file.size > MAX_IMAGE_BYTES) throw new EditError(400, `${label}は1枚10MB以下にしてください。`);
}

function parseUrls(text) {
  const urls = String(text).replace(/\r\n?/g, '\n').split(/\n+/).map(value => value.trim()).filter(Boolean);
  for (const value of urls) normalizeUrl(value);
  return urls;
}

function normalizeUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new EditError(400, `URLの形式が正しくありません: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new EditError(400, 'http/httpsのURLだけ登録できます。');
  return url.href;
}

async function existingFingerprints(env, fingerprints) {
  const found = new Set();
  for (let index = 0; index < fingerprints.length; index += 80) {
    const chunk = fingerprints.slice(index, index + 80);
    if (!chunk.length) continue;
    const marks = chunk.map(() => '?').join(',');
    const result = await env.COUPON_DB.prepare(`SELECT fingerprint FROM coupon_items WHERE fingerprint IN (${marks})`).bind(...chunk).all();
    (result.results || []).forEach(row => found.add(row.fingerprint));
  }
  return found;
}

async function sha256Text(text) {
  return sha256Buffer(new TextEncoder().encode(text));
}

async function sha256Buffer(buffer) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function extensionFor(mimeType) {
  const map = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
  return map[mimeType] || 'jpg';
}

function json(request, env, data, status = 200) {
  const origin = request.headers.get('Origin');
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (origin && isOriginAllowed(request, env)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify(data), { status, headers });
}
